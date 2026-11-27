// The engine: Tia is a headless Claude Code run under one of the owner's profiles (or "auto"), with hoprig's
// MCP server as her ONLY tools. One conversation = one Claude session: a long-lived process reading user turns as
// stream-json on stdin; when it exits, the next turn starts it again with --resume <session id>.
//
// It does NOT go through the launcher (launch.mjs): the owner's claudeArgs (his own sessions may run with
// bypass-permissions or a high effort) and the launcher's hooks never reach her. The environment is built here:
// profileEnv(readProfile(name)) and the profile's PRERUN, or autoProfile() for "auto" (it starts the router).
//
// Keeping the owner's and projects' instructions out (verified on Claude Code 2.1.325 with marker files, see the
// phase-2 notes in test/assistant/engine.test.mjs):
//   CLAUDE_CODE_DISABLE_CLAUDE_MDS=1   no CLAUDE.md from ~/.claude, the folder or its parents (hooks still ran)
//   --setting-sources ""               no user, project or local settings.json: no hooks, no permissions, no plugins
//                                      enabled there (CLAUDE.md was also gone with this flag alone)
//   --strict-mcp-config                no MCP servers but ours (~/.claude.json, .mcp.json and plugins skipped)
//   an empty working folder of her own under the state dir
//   CLAUDE_CODE_DISABLE_AUTO_MEMORY=1  no auto-memory written or read
// Not --bare: it would also refuse OAuth logins (subscriptions), and Tia must run on any of the owner's accounts.
//
// Flags (checked against `claude --help` of 2.1.325 and https://code.claude.com/docs/en/headless, /cli-reference,
// /permissions, /mcp):
//   -p --input-format stream-json --output-format stream-json --verbose   headless, JSON events in and out
//   --system-prompt <text>             replaces the default (coding) prompt entirely
//   --tools ""                         no built-in tools at all: no Bash, no files, no web ("doesn't affect MCP tools")
//   --allowedTools mcp__hoprig__*   our tools run without a permission prompt ("Allow rules accept tool-name
//                                      globs only after a literal mcp__<server>__ prefix", permissions page)
//   --permission-mode dontAsk          anything else that would prompt is denied, never asked
//   --disable-slash-commands           "Disable all skills and commands": Claude Code's own skills stay out; ours
//                                      come through manage_procedures
//   --session-id <uuid> | --resume <id>   one conversation, resumed turn by turn
//   --model, --max-budget-usd          optional ("print mode only"; spend can pass the cap a little)
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { binFile, stateDir } from '../paths.mjs';
import { profileEnv, readProfile } from '../profiles.mjs';
import { resolveWindowsBin, windowsSpawnPlan } from '../winspawn.mjs';

/** What Tia's engine adds to the profile's environment, so no instructions or memory of the owner reach her. */
export const ISOLATION_ENV = Object.freeze({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });

/**
 * The environment Claude Code gets on profile `name` ("auto" or a profile file), as the launcher would build it but
 * without a run file or terminal of its own. Runs the profile's PRERUN (a gateway that starts on demand) first.
 * Throws with a plain message when the account cannot be used. The coding chat (src/chat) uses it as it is.
 */
export async function providerEnv(name, base = process.env) {
  let p;
  if (name === 'auto') {
    const { autoProfile } = await import('../launch.mjs');
    p = await autoProfile();
    // No provider it may use: an order whose every provider is left out (gone, not serving Claude Code, billed by use)
    // says why in the router's own words; only an empty order has no order yet.
    if (!p) {
      const [{ leftOutOfOrder }, { nothingUsableWhy }] = await Promise.all([import('../autoswitch.mjs'), import('../router.mjs')]);
      throw new Error(nothingUsableWhy(leftOutOfOrder()) || 'Auto mode has no order of providers yet');
    }
  } else {
    p = readProfile(name);
    if (!p) throw new Error(`there is no provider "${name}"`);
  }
  const env = profileEnv(p, base);
  for (const k of ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID', 'TMUX', 'TMUX_PANE']) delete env[k];
  if (p.prerun) {
    const r = spawnSync(p.prerun, { shell: true, stdio: ['ignore', 'ignore', 'pipe'], env, timeout: 60_000 });
    if (r.status !== 0) throw new Error(`the provider's start command failed (${r.status ?? r.signal})`);
  }
  return env;
}

/** The environment for Tia's engine: the provider's, with the switches that keep the owner's instructions out. */
export async function engineEnv(name, base = process.env) {
  return { ...(await providerEnv(name, base)), ...ISOLATION_ENV };
}

/** How to start Claude Code: claudeBin from the config; on Windows through windowsSpawnPlan (a .cmd shim). */
export function claudeCommand(args, env, { bin = loadConfig().claudeBin || 'claude', platform = process.platform } = {}) {
  if (platform === 'win32') {
    const found = resolveWindowsBin(bin, env);
    if (found) return windowsSpawnPlan(found, args, env);
  }
  return { command: bin, args, options: {} };
}

/** How long her process is kept after the last turn. */
export const IDLE_MS = 10 * 60_000;
export const SERVER_NAME = 'hoprig';
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

/** Claude Code's arguments for Tia's engine. */
export function engineArgs({ systemPrompt, mcpConfigFile, sessionId = null, resume = false, model = null, maxBudgetUsd = null }) {
  if (!systemPrompt || !mcpConfigFile) throw new Error('engineArgs needs systemPrompt and mcpConfigFile');
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--system-prompt', systemPrompt,
    '--tools', '',
    '--mcp-config', mcpConfigFile, '--strict-mcp-config',
    '--allowedTools', `${TOOL_PREFIX}*`,
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--setting-sources', '',
  ];
  if (model) args.push('--model', model);
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);
  return args;
}

/**
 * The --mcp-config JSON: hoprig's own MCP server, with the dashboard address, the FILE that holds the token
 * (read on every call, so a rotated token is picked up; the token itself is never in this config) and the
 * conversation.
 */
// accepted: the dashboard's own Tia, whose tool list takes the descriptions the owner accepted (src/assistant/accepted.mjs).
export function mcpConfig({ url, tokenFile, conversation, accepted = false, command = process.execPath, args = [binFile(), 'mcp'] }) {
  // Without its own address `hoprig mcp` would fall back to the default port, where another dashboard may listen.
  if (typeof url !== 'string' || !/^https?:\/\/[^/]+/.test(url)) throw new Error('the dashboard\'s own address is not known');
  return {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'stdio', command, args,
        env: { HOPRIG_DASHBOARD_URL: url, HOPRIG_ASSISTANT_TOKEN_FILE: tokenFile, HOPRIG_ASSISTANT_CONVERSATION: conversation, ...(accepted ? { HOPRIG_ASSISTANT_ACCEPTED: '1' } : {}) },
      },
    },
  };
}

/** One user turn as a stream-json input line. */
export const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text) }] } }) + '\n';

const toolName = (n) => (typeof n === 'string' && n.startsWith(TOOL_PREFIX) ? n.slice(TOOL_PREFIX.length) : String(n));
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '');

/**
 * One stream-json output line → the events the dashboard cares about:
 *   { kind: "init", sessionId, tools, mcpServers }
 *   { kind: "text", text }                          the assistant speaking
 *   { kind: "tool_call", id, name, input }          name without the mcp__hoprig__ prefix
 *   { kind: "tool_result", id, isError, text }
 *   { kind: "done", ok, text, sessionId, costUsd, usage, turns, subtype }   (usage: Claude Code's token counts)
 * Unknown lines give []. Never throws.
 */
export function parseEvents(line) {
  let m;
  try {
    m = typeof line === 'string' ? JSON.parse(line) : line;
  } catch {
    return [];
  }
  if (!m || typeof m !== 'object') return [];
  if (m.type === 'system' && m.subtype === 'init') {
    return [{ kind: 'init', sessionId: m.session_id || null, tools: Array.isArray(m.tools) ? m.tools : [], mcpServers: Array.isArray(m.mcp_servers) ? m.mcp_servers : [], model: m.model || null }];
  }
  if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
    const out = [];
    for (const c of m.message.content) {
      if (c.type === 'text' && c.text) out.push({ kind: 'text', text: c.text });
      else if (c.type === 'tool_use') out.push({ kind: 'tool_call', id: c.id, name: toolName(c.name), rawName: c.name, input: c.input || {} });
    }
    return out;
  }
  if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
    return m.message.content.filter((c) => c.type === 'tool_result').map((c) => ({ kind: 'tool_result', id: c.tool_use_id, isError: c.is_error === true, text: textOf(c.content) }));
  }
  if (m.type === 'result') {
    return [{ kind: 'done', ok: m.is_error !== true && m.subtype === 'success', subtype: m.subtype || null, text: typeof m.result === 'string' ? m.result : '', sessionId: m.session_id || null, costUsd: Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : null, usage: m.usage && typeof m.usage === 'object' ? m.usage : null, turns: m.num_turns ?? null }];
  }
  return [];
}

/**
 * A running conversation. o: { profile ("api", "auto", …), systemPrompt, url, tokenFile, conversation, model,
 * maxBudgetUsd, dir, sessionId (an existing conversation to resume), resolveEnv (tests), spawnImpl (tests),
 * command (tests: { command, args } instead of claude), mcpCommand, accepted (her tool list with the owner's accepted
 * descriptions) }.
 * Emits "event" for every parsed event and "exit". send(text) resolves with { events, done } for that turn.
 */
export class Engine extends EventEmitter {
  constructor(o) {
    super();
    this.o = o;
    this.sessionId = o.sessionId || crypto.randomUUID();
    this.started = !!o.sessionId; // a given id is an existing conversation: resume it
    this.child = null;
    this.queue = Promise.resolve();
    this.busy = 0; // turns running or waiting
    this.idleTimer = null;
    this.dir = o.dir || path.join(stateDir(), 'assistant', 'conversations', o.conversation);
  }

  async #spawn() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const cfgFile = path.join(this.dir, 'mcp.json');
    fs.writeFileSync(cfgFile, JSON.stringify(mcpConfig({ url: this.o.url, tokenFile: this.o.tokenFile, conversation: this.o.conversation, accepted: this.o.accepted === true, ...(this.o.mcpCommand || {}) })), { mode: 0o600 });
    const args = engineArgs({ systemPrompt: this.o.systemPrompt, mcpConfigFile: cfgFile, sessionId: this.sessionId, resume: this.started, model: this.o.model, maxBudgetUsd: this.o.maxBudgetUsd });
    const env = await (this.o.resolveEnv || engineEnv)(this.o.profile);
    // An empty working folder of her own: no project's CLAUDE.md, settings or .mcp.json is near it.
    const cwd = path.join(this.dir, 'work');
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const plan = this.o.command ? { command: this.o.command.command, args: [...this.o.command.args, ...args], options: {} } : claudeCommand(args, env);
    const child = (this.o.spawnImpl || spawn)(plan.command, plan.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...plan.options });
    this.started = true;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        for (const ev of parseEvents(line)) this.emit('event', ev);
      }
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.emit('exit', { code, stderr: err });
    });
    child.on('error', (e) => this.emit('exit', { code: 127, stderr: e.message }));
    child.stdin.on('error', () => {}); // a process that died early must not crash the dashboard on write
    this.child = child;
  }

  /**
   * The process of a conversation that nobody has spoken to for `idleMs` (10 minutes) ends: it starts again on the next
   * message with --resume, the conversation itself is kept. 33 idle processes were measured holding 6.4 GB. Nothing is
   * ended while a turn runs or waits.
   */
  #rest() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.busy > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy === 0) this.stop();
    }, this.o.idleMs ?? IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /** Send one user turn; resolves when its "done" event arrives (or the process exits, or it fails to start). */
  send(text, { timeoutMs = 10 * 60_000 } = {}) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.busy++;
    const run = async () => {
      if (!this.child) {
        try {
          await this.#spawn();
        } catch (e) {
          return { events: [], done: { kind: 'done', ok: false, subtype: 'start', text: e.message, sessionId: this.sessionId, costUsd: null } };
        }
      }
      return new Promise((resolve) => {
        const events = [];
        let timer;
        const finish = (done) => {
          clearTimeout(timer);
          this.off('event', onEvent);
          this.off('exit', onExit);
          resolve({ events, done });
        };
        const onEvent = (ev) => {
          events.push(ev);
          if (ev.kind === 'init' && ev.sessionId) this.sessionId = ev.sessionId;
          if (ev.kind === 'done') finish(ev);
        };
        const onExit = (x) => finish({ kind: 'done', ok: false, subtype: 'exit', text: `Tia's process stopped (${x.code}): ${String(x.stderr).trim().split('\n').slice(-3).join(' ')}`, sessionId: this.sessionId, costUsd: null });
        this.on('event', onEvent);
        this.on('exit', onExit);
        timer = setTimeout(() => {
          this.stop();
          finish({ kind: 'done', ok: false, subtype: 'timeout', text: 'the turn took too long', sessionId: this.sessionId, costUsd: null });
        }, timeoutMs);
        this.child.stdin.write(userLine(text));
      });
    };
    this.queue = this.queue.then(run, run).finally(() => {
      this.busy--;
      this.#rest();
    });
    return this.queue;
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill('SIGTERM');
    } catch {
      /* gone */
    }
    this.child = null;
  }

  /** Stop, and remove the conversation's MCP config. */
  cleanup() {
    this.stop();
    fs.rmSync(path.join(this.dir, 'mcp.json'), { force: true });
  }
}
