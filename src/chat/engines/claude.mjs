// The Claude Code engine of the coding chat (the contract is in index.mjs): one headless process per open chat,
// spoken to in stream-json (claude-lines.mjs), heard through claude-parse.mjs, read back by claude-transcript.mjs.
// Everything the chat changes while it runs (permission mode, model, effort, ultracode, stopping a task, undoing a
// turn's edits, taking back a queued message) is a control request to the running process: no restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claudeCommand } from '../../assistant/engine.mjs';
import { claudeVersionQuick } from '../../claudecode.mjs';
import { chatHooks, leadHook, modelArgs } from '../../launch.mjs';
import { loadConfig } from '../../config.mjs';
import { handsOffOffered } from '../../handsoff.mjs';
import { leadArgs } from '../../models/lead.mjs';
import { hookSettingsDir } from '../../paths.mjs';
import { readProfile } from '../../profiles.mjs';
import { mapEnv, mapSettings, sessionMap } from '../../providers/sessionmap.mjs';
import { withExtras } from '../../workspace/needs.mjs';
import { projectDir, sessionsIn } from '../../sessions.mjs';
import { CHAT_ENV, allowLine, chatArgs, controlLine, denyLine, elicitLine, grantSettings, interruptLine, sdkMode, userLine } from './claude-lines.mjs';
import { ClaudeParser } from './claude-parse.mjs';
import { endPoint, forkPoint, readTranscript } from './claude-transcript.mjs';
import { WHOLE_MAX, readEarlier, readTail, todosBefore } from './claude-pieces.mjs';
import { folderHistory } from '../history.mjs';

const TERM_MS = 3000; // after its input ends, how long a process gets to exit before SIGTERM
const KILL_MS = 8000; // … and before SIGKILL
const DRAIN_MS = 2000; // after it exits, how long its output may take to arrive (a child that holds the pipe open)
const CONTROL_MS = 15_000; // how long an answer to a control request may take

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// What each control request does, in the owner's words: an older Claude Code that does not know one says so in its
// protocol's words ("Unsupported control request subtype: rewind_files"), which the page must not show.
const CAN = {
  rewind_files: 'undo its changes to files', set_permission_mode: 'change the mode while it runs',
  set_model: 'change the model while it runs', apply_flag_settings: 'change the effort while it runs',
  stop_task: 'stop one task', rename_session: 'rename the conversation', cancel_async_message: 'take back a queued message',
  get_context_usage: 'say how full the context is', get_usage: 'say how much of the plan is used',
  generate_session_title: 'name the conversation',
};
/** A refusal of control request `subtype` in plain words. */
export function refusalWords(subtype, error, code) {
  if (code === 'unsupported_request' || /^unsupported control request/i.test(error || '')) {
    return `This version of Claude Code cannot ${CAN[subtype] || 'do that'} from the App. Updating Claude Code may help.`;
  }
  return error || 'Claude Code refused';
}

class ClaudeSession {
  /** o: see claude.open */
  constructor(o) {
    this.o = o;
    this.parser = new ClaudeParser();
    this.waiting = new Map(); // control request id → { resolve, reject, timer, subtype }
    this.rid = 0;
    this.alive = true;
    this.info = null; // the answer to initialize: { commands, models, … }
    // A provider that names its own model (ANTHROPIC_MODEL) says what its endpoint can serve: no --model then.
    // A resume otherwise starts on the model named in the transcript, which another provider may not know.
    const own = !!(o.env && o.env.ANTHROPIC_MODEL);
    let model = own ? null : o.model;
    if (!model && !own && (o.resume || o.fork)) model = modelArgs({ env: {} }, ['--resume', o.fork ? o.fork.from : o.sessionId])[1] || null;
    // The chat's provider's model map (providers/sessionmap.mjs), as a terminal session of it gets: its small model
    // in the environment, the rest in the settings below. Auto mode's router maps by itself.
    const map = typeof o.profile === 'string' && o.profile !== 'auto' ? sessionMap(readProfile(o.profile)) : null;
    const env = mapEnv({ ...o.env, ...CHAT_ENV }, map);
    let settings = grantSettings(o.grants || [], { ultracode: !!o.ultracode });
    // The PermissionRequest hook of a terminal session (launch.mjs permissionHook), for a Claude Code that knows the
    // event, on the chat's run record (`runFile`). Seen on 2.1.326 in this headless mode: Claude Code sends its
    // can_use_tool request and starts the hook at the same moment; when the hook answers "allow" (a plain delete in
    // bypass mode, hook.mjs) it takes its request back (control_cancel_request) and the tool runs; when the hook
    // answers nothing, the request stands and the chat's answer counts. So the hook's one rule, read with the shell's
    // real folder, answers for a chat as for a terminal, and the chat answers nothing by itself (asks.mjs).
    // The settings go in a file, as a terminal's: the hook's command needs other quoting on every platform, and the
    // hook reads the "ask" rules of this file (hook.mjs sessionFacts).
    const version = o.version !== undefined ? o.version : o.command ? null : claudeVersionQuick({ env });
    const chatOwnHooks = o.runFile ? chatHooks(version, handsOffOffered(loadConfig()), o.hers === true) : null;
    // The map rides on the chat's settings whichever way they reach Claude Code: in the file below (hooks or extra
    // folders), or as the settings argument when there is no file (a record but a Claude Code too old for the hook).
    const mapped = mapSettings(map, version);
    if (Object.keys(mapped).length) settings = JSON.stringify({ ...(settings ? JSON.parse(settings) : {}), ...mapped });
    this.hooked = !!(chatOwnHooks && chatOwnHooks.PermissionRequest); // the PermissionRequest hook answers (asks.mjs); the stop events only write the record
    // "Lead model": a helper call's model and effort are taken out before it runs (launch.mjs leadHook), so each helper
    // runs on its kind's own model; a session that does not lead gets nothing of it.
    const leads = !!(o.runFile && o.lead && o.lead.can);
    // Both may name the same event (the wall's hold and the lead's hook are both before a tool runs): the lists are
    // joined, never one put in the other's place.
    const joined = (x, y) => Object.fromEntries([...new Set([...Object.keys(x || {}), ...Object.keys(y || {})])].map((k) => [k, [...((x || {})[k] || []), ...((y || {})[k] || [])]]));
    const hooks = chatOwnHooks || leads ? joined(chatOwnHooks, leads ? leadHook() : null) : null;
    this.settingsFile = null;
    // The chat's extra folders (workspace/needs.mjs: its project's needs, "Also open"): additional directories with
    // their deny rules, in the same file, so the hook finds them too (hook.mjs extraDirs).
    const extra = o.extras && o.extras.settings ? o.extras.settings : null;
    if (hooks || (extra && o.runFile)) {
      this.settingsFile = path.join(hookSettingsDir(), path.basename(o.runFile));
      fs.mkdirSync(hookSettingsDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.settingsFile, `${JSON.stringify(withExtras({ ...(settings ? JSON.parse(settings) : {}), ...(hooks ? { hooks } : {}) }, extra))}\n`, { mode: 0o600 });
      settings = this.settingsFile;
      env.HOPRIG_RUN_FILE = o.runFile;
    }
    // A budget (a part Tia's Lead session started by itself inside her daily limit for paid use, partdoor.mjs): Claude
    // Code's own --max-budget-usd, so its turn stops near what was left of that limit. It checks between steps, so one
    // step may go a little past it. A function is asked at this start, so each new process gets what is left now.
    const usd = typeof o.maxBudgetUsd === 'function' ? o.maxBudgetUsd() : o.maxBudgetUsd;
    const budget = Number.isFinite(usd) && usd > 0 ? ['--max-budget-usd', String(usd)] : [];
    const args = [...chatArgs({ sessionId: o.sessionId, resume: o.resume, fork: o.fork || null, permissionMode: o.mode, effort: o.effort, model, settings, allowBypass: o.allowBypass !== false, lead: leadArgs(o.lead) }), ...budget];
    const plan = o.command ? { command: o.command.command, args: [...o.command.args, ...args], options: {} } : claudeCommand(args, env);
    const child = (o.spawnImpl || spawn)(plan.command, plan.args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...plan.options });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        for (const ev of this.parser.line(l)) this.#on(ev);
      }
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    // The end is handled once its output is read to the end ('close'), not at 'exit': a long reply right before
    // the process exits would otherwise be cut off, its result with it. A child that keeps the pipe open (a command
    // it left running) cannot hold that up for more than DRAIN_MS.
    let finished = false;
    let drain = null;
    let endedResolve;
    this.ended = new Promise((r) => (endedResolve = r));
    const gone = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(drain);
      if (buf.trim()) for (const ev of this.parser.line(buf)) this.#on(ev);
      buf = '';
      this.alive = false;
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(fail(409, 'Claude Code stopped'));
      }
      this.waiting.clear();
      const why = String(err).trim().split('\n').slice(-2).join(' ').slice(0, 300);
      o.emit({ kind: 'exit', code, why });
    };
    child.on('exit', (code, signal) => {
      if (this.settingsFile) fs.rmSync(this.settingsFile, { force: true }); // read at its start: no longer needed
      endedResolve();
      drain = setTimeout(() => gone(code ?? signal), o.drainMs ?? DRAIN_MS);
      drain.unref?.();
    });
    child.on('close', (code, signal) => {
      endedResolve();
      gone(code ?? signal);
    });
    child.on('error', (e) => {
      err = e.code === 'ENOENT' ? 'Claude Code was not found on this computer' : e.message;
      if (this.settingsFile) fs.rmSync(this.settingsFile, { force: true });
      endedResolve();
      gone(127);
    });
    child.stdin.on('error', () => {}); // a process that died early must not take the dashboard with it
    // First of all: with perTaskStopAffordance a Stop ends the turn and spares background agents; with
    // agentProgressSummaries a running subagent says what it does. The answer lists the commands and skills.
    this.ready = this.#control({ subtype: 'initialize', hooks: {}, agentProgressSummaries: true, perTaskStopAffordance: true, promptSuggestions: false })
      .then((r) => (this.info = r || {}))
      .catch(() => (this.info = {}));
  }

  #on(ev) {
    if (ev.kind === 'control-answer') {
      const w = this.waiting.get(ev.requestId);
      if (!w) return;
      this.waiting.delete(ev.requestId);
      clearTimeout(w.timer);
      if (ev.ok) w.resolve(ev.response);
      else w.reject(fail(409, refusalWords(w.subtype, ev.error, ev.code), ev.code || 'refused'));
      return;
    }
    this.o.emit(ev);
  }

  #write(line) {
    if (!this.alive) throw fail(409, 'Claude Code is not running in this chat');
    this.child.stdin.write(line);
  }

  #control(request, ms = CONTROL_MS) {
    const id = `hoprig-${++this.rid}`;
    return new Promise((resolve, reject) => {
      try {
        this.#write(controlLine(id, request));
      } catch (e) {
        return reject(e);
      }
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(fail(504, `Claude Code did not answer (${request.subtype})`, 'timeout'));
      }, ms);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer, subtype: request.subtype });
    });
  }

  send({ id, text, images }) {
    this.#write(userLine(text, { id, images }));
  }
  /** a: { allow, input, permissions (allow: session rule changes), message (deny) } */
  answer(request, a) {
    if (a.mcp) return this.#write(elicitLine(request, a.mcp.action, a.mcp.content));
    this.#write(a.allow ? allowLine(request, a.input, a.permissions) : denyLine(request, a.message));
  }
  interrupt() {
    this.#control({ subtype: 'interrupt' }).catch(() => {});
  }
  stopTask(taskId) {
    return this.#control({ subtype: 'stop_task', task_id: taskId });
  }
  setMode(mode) {
    return this.#control({ subtype: 'set_permission_mode', mode: sdkMode(mode) });
  }
  /** null: Claude Code's own default model. */
  setModel(model) {
    return this.#control({ subtype: 'set_model', ...(model ? { model } : {}) });
  }
  /** An effort change carries ultracode too: without it Claude Code turns ultracode off. */
  setEffort({ effort, ultracode }) {
    return this.#control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort || null, ultracode: !!ultracode } });
  }
  /** The conversation's name (kept in its transcript, so a terminal shows it too). */
  rename(title) {
    return this.#control({ subtype: 'rename_session', title, source: 'host' });
  }
  /**
   * Claude Code's small model names the conversation from `description` (its first prompt), as its terminal does by
   * itself; persist: the title goes into the transcript (an ai-title line). → { title }
   */
  generateTitle(description) {
    return this.#control({ subtype: 'generate_session_title', description, persist: true });
  }
  /** Undo the file changes made since message `messageId`; dryRun: only say what would change. */
  rewind(messageId, { dryRun = false } = {}) {
    return this.#control({ subtype: 'rewind_files', user_message_id: messageId, dry_run: dryRun });
  }
  /** Take back a message written while a turn ran, before Claude Code starts on it. → true when it was taken back. */
  async cancel(messageId) {
    const r = await this.#control({ subtype: 'cancel_async_message', message_uuid: messageId });
    return !!(r && r.cancelled);
  }
  contextUsage() {
    return this.#control({ subtype: 'get_context_usage', detail: 'summary' });
  }
  usage() {
    return this.#control({ subtype: 'get_usage', skip_behaviors: true });
  }
  /** The / menu: the session's commands and skills, from the answer to initialize. */
  async commands() {
    await this.ready;
    return Array.isArray(this.info.commands) ? this.info.commands : [];
  }

  /** The process's id (Delete leaves its own record of the conversation out, deletes.mjs). */
  get pid() {
    return this.child ? this.child.pid : null;
  }

  /** End the process: its input first (Claude Code cancels a waiting permission prompt then), SIGTERM, then SIGKILL. */
  close() {
    const child = this.child;
    const kill = (sig) => {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    };
    if (child.exitCode === null && child.signalCode === null) {
      const term = setTimeout(() => kill('SIGTERM'), this.o.termMs ?? TERM_MS);
      const hard = setTimeout(() => kill('SIGKILL'), this.o.killMs ?? KILL_MS);
      term.unref?.();
      hard.unref?.();
      this.ended.then(() => {
        clearTimeout(term);
        clearTimeout(hard);
      });
    }
    try {
      child.stdin.end();
    } catch {
      /* gone */
    }
    return this.ended;
  }
  kill() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  // What it changes in a running process (else the chat starts it again with --resume).
  capabilities: { liveMode: true, liveModel: true, liveEffort: true, ultracode: true, queue: true, stopTask: true, rewind: true, fork: true, commands: true, compact: true, usage: true, rename: true, titles: true, ownIds: false },
  /** Where conversation `id` of folder `cwd` is kept: it exists once a first message was sent. */
  file: (cwd, id) => path.join(projectDir(cwd), `${id}.jsonl`),
  exists: (cwd, id) => fs.existsSync(claude.file(cwd, id)),
  /**
   * Start the coding tool for one chat. o: { cwd, env, sessionId, resume, fork ({ from, at }: a copy of conversation
   * `from` up to its line `at`, as sessionId), model, effort, ultracode, mode, grants, runFile (the chat's run record:
   * the hook writes what it allowed there), emit(event), command { command, args }, spawnImpl and version (tests: the
   * Claude Code version the stand-in plays), termMs, killMs, drainMs }.
   */
  open: (o) => new ClaudeSession(o),
  /** The conversation from its files: { events, tasks, todos, title, size }. */
  transcript: ({ cwd, id }) => readTranscript(claude.file(cwd, id)),
  /**
   * A long conversation's last part, read in pieces (claude-pieces.mjs: the start's read), or null for one short enough
   * to read at once; earlier(): the part before byte `start`, when the page asks for it.
   */
  tail: ({ cwd, id }) => {
    const f = claude.file(cwd, id);
    let size = 0;
    try {
      size = fs.statSync(f).size;
    } catch {
      return null;
    }
    return size > WHOLE_MAX ? readTail(f) : null;
  },
  earlier: ({ cwd, id }, start) => readEarlier(claude.file(cwd, id), start),
  /** The to-do list of the whole conversation, after a read of its last part only (`tail`: that part's events). */
  todosBefore: ({ cwd, id }, start, tail) => todosBefore(claude.file(cwd, id), start, tail),
  /** Where conversation `id` goes on from when it is rewound to before the owner's message `messageId`. */
  forkPoint: (cwd, id, messageId) => forkPoint(claude.file(cwd, id), messageId),
  endPoint: (cwd, id) => endPoint(claude.file(cwd, id)),
  /** The conversations kept for a folder. */
  sessions: (cwd) => sessionsIn(cwd),
  /** The folder's conversations for the history list: [{ id, at, title }]. */
  history: (cwd) => folderHistory(cwd),
};
