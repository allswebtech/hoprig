// A terminal session of Codex or OpenCode, started by the launcher (`hoprig codex|opencode <provider> [args]`, the
// command the dashboard types for these tools: src/server/deck.mjs launchArgv). Claude Code's launch stays in
// src/launch.mjs, unchanged.
//
// The launcher's own words, the same for both tools (and the same as Claude Code's where they mean the same):
//   --resume <id>              continue that conversation of the folder
//   -c                         continue the folder's newest conversation (a new one when there is none)
//   --permission-mode <m>      the tool's permission modes (options.permissionModes of its descriptor)
//   --effort <e>, --model <m>  how it should think, and which model
//   -- <prompt>                a first message (last; may start with "-")
// Anything else goes to the tool as it is. These flags are what moves along when the session moves to another
// provider (the run record's carryArgs).
//
// The session attaches to the tool's server (./servers.mjs), and this launcher follows the server's events to keep
// the run record's status true, as Claude Code's hooks do for Claude: working, needs your OK, waiting. When the
// server cannot be used, the tool runs on its own and the record says statusSource "basic": the card then reads the
// screen's activity only, and says so.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from '../paths.mjs';
import { listProfiles, readProfile, servesTools, validName } from '../profiles.mjs';
import { createRun, removeRun, updateRun } from '../runs.mjs';
import { codexClient, opencodeClient } from './clients.mjs';
import { findTool } from './index.mjs';
import { codexArgs, providerModels, startSettings, tomlString } from './providers.mjs';
import { cleanEnv, codexBlockArgs, ensureServer, serverProviders, stopIfUnused } from './servers.mjs';
import { codexSessions, isToolSessionId, opencodeSessions } from './stores.mjs';

const VALUE_FLAGS = new Set(['--permission-mode', '--effort', '--model', '--resume']);

/** The launcher's arguments for Codex or OpenCode, read into { resume, cont, permissionMode, effort, model, prompt, extra }. */
export function parseToolArgs(args) {
  const o = { resume: null, cont: false, permissionMode: null, effort: null, model: null, prompt: null, extra: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      o.prompt = args.slice(i + 1).join(' ') || null;
      break;
    }
    const [name, eq] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (name === '-c' || name === '--continue') o.cont = true;
    else if (VALUE_FLAGS.has(name)) {
      const v = eq !== null ? eq : args[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      if (name === '--resume') o.resume = v;
      else if (name === '--permission-mode') o.permissionMode = v;
      else if (name === '--effort') o.effort = v;
      else o.model = v;
    } else o.extra.push(a);
  }
  return o;
}

/** The flags that move with the session to another provider. */
export const carryOf = (o) => [
  ...(o.permissionMode ? ['--permission-mode', o.permissionMode] : []),
  ...(o.effort ? ['--effort', o.effort] : []),
  ...(o.model ? ['--model', o.model] : []),
];

const promptTail = (tool, prompt) => (!prompt ? [] : tool === 'opencode' ? ['--prompt', prompt] : prompt.startsWith('-') ? ['--', prompt] : [prompt]);

/** Codex's command line for a terminal attached to Hoprig's app server. */
export function codexTuiArgs({ port, prov, model, cwd, resume = null, o }) {
  const t = findTool('codex');
  return [
    '--remote', `ws://127.0.0.1:${port}`, '--remote-auth-token-env', 'HOPRIG_CODEX_WS',
    ...t.noSelfUpdate.args,
    ...codexBlockArgs(prov), ...(prov.signin ? [] : ['-c', `model_provider=${tomlString(prov.id)}`]),
    ...(model ? ['-m', model] : []),
    ...t.flagsFor(o), ...o.extra,
    '-C', cwd,
    ...(resume ? ['resume', resume] : []),
    ...promptTail('codex', o.prompt),
  ];
}

/** OpenCode's command line for a terminal attached to Hoprig's server, on conversation `id`. */
export function opencodeTuiArgs({ url, id, cwd, o }) {
  const t = findTool('opencode');
  return ['--server', url, '-s', id, ...t.flagsFor(o), ...o.extra, ...promptTail('opencode', o.prompt), cwd];
}

/**
 * Codex: a thread's state (thread/status/changed) as a run status. `idle` waits for the next message; `active`
 * with an approval or a question pending needs the owner; `systemError` ended in an error.
 */
export function codexStatus(status) {
  const type = status && status.type;
  if (type === 'idle') return { status: 'waiting' };
  if (type === 'systemError') return { status: 'waiting', failed: true };
  if (type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (flags.includes('waitingOnApproval')) return { status: 'attention', note: 'Codex asks for your OK to go on.' };
    if (flags.includes('waitingOnUserInput')) return { status: 'attention', note: 'Codex asks you a question.' };
    return { status: 'working' };
  }
  return null;
}

/** OpenCode: one event of a session as a run status, or null when it changes nothing. */
export function opencodeStatus(type, data = {}) {
  switch (type) {
    case 'session.execution.started':
    case 'permission.replied':
    case 'form.replied':
      return { status: 'working' };
    case 'permission.asked':
      return { status: 'attention', note: `OpenCode asks for your OK: ${String(data.action || 'a step')} ${Array.isArray(data.resources) ? data.resources.join(' ') : ''}`.trim().slice(0, 300) };
    case 'form.created':
      return { status: 'attention', note: 'OpenCode asks you a question.' };
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      return { status: 'waiting' };
    case 'session.execution.failed':
      return { status: 'waiting', failed: true, error: data.error };
    default:
      return null;
  }
}

/** The run patch for a new status (stopAt when a reply ended, failure when it ended in an error). */
export function statusPatch(prev, next, now = Date.now()) {
  const patch = { status: next.status, note: next.note || '' };
  if (next.status === 'waiting' && prev !== 'waiting') patch.stopAt = now;
  patch.failure = next.failed ? { at: now, error: 'error', text: String((next.error && (next.error.message || next.error.type)) || 'the reply ended in an error').slice(0, 300) } : null;
  return patch;
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const threadCwd = (t) => (t && (t.cwd || (Array.isArray(t.environments) && t.environments[0] && t.environments[0].cwd))) || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hold `name` (a folder lock in the runs folder) while `fn` runs: two new Codex sessions of one folder start one at a time. */
async function folderLock(cwd, ms = 20_000) {
  const lock = path.join(runsDir(), `.new-codex-${crypto.createHash('sha256').update(real(cwd)).digest('hex').slice(0, 16)}.lock`);
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  const until = Date.now() + ms;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > ms) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* gone meanwhile */
      }
      if (Date.now() > until) return () => {};
      await sleep(200);
    }
  }
}

/** The model to start with: chosen, else the provider's pinned one, else the first the provider lists. */
async function modelFor(o, profile) {
  if (o.model) return o.model;
  const prov = serverProviders('codex', [profile])[0] || serverProviders('opencode', [profile])[0];
  if (prov && prov.model) return prov.model;
  return (await providerModels(profile).catch(() => []))[0] || null;
}

/**
 * Start Codex or OpenCode under `profileName` in this terminal and follow its status. Resolves to the exit code.
 */
export async function launchTool(toolId, profileName, args, { cwd = process.cwd(), base = process.env } = {}) {
  const tool = findTool(toolId);
  const profile = readProfile(profileName);
  if (!profile) {
    console.error(`hoprig: no provider "${profileName}". Add one on the Providers page, or with: hoprig add`);
    return 2;
  }
  if (!servesTools(profile).includes(toolId)) {
    console.error(`hoprig: the provider "${profile.name}" does not serve ${tool.name} (it works with: ${servesTools(profile).join(', ') || 'no coding tool'}).`);
    return 2;
  }
  if (!fs.existsSync(tool.binPath())) {
    console.error(`hoprig: ${tool.name} is not installed in Hoprig's tools folder. Install it: hoprig tools install ${toolId}`);
    return 127;
  }
  let o;
  try {
    o = parseToolArgs(args);
    tool.flagsFor(o); // refuses an unknown permission mode or effort
  } catch (e) {
    console.error(`hoprig: ${e.message}`);
    return 2;
  }
  if (o.resume && !isToolSessionId(toolId, o.resume)) {
    console.error(`hoprig: "${o.resume}" is not a ${tool.name} conversation id.`);
    return 2;
  }
  const { file, run } = createRun({ profile: profile.name, cwd, carryArgs: carryOf(o), tool: toolId });
  updateRun(file, { server: true, statusSource: 'server' }); // counted as a user before the server is looked at
  const report = makeReporter(file);
  let follow = null;
  let plan;
  try {
    const r = await ensureServer(toolId, { need: profile.name, base });
    const model = await modelFor(o, profile);
    if (r.ok) {
      plan = toolId === 'codex' ? await codexPlan(r.server, { profile, model, cwd, o, base, report }) : await opencodePlan(r.server, { profile, model, cwd, o, base, report });
      follow = plan.follow;
    } else {
      console.error(`hoprig: ${r.why}. ${tool.name} runs on its own; its live status is basic.`);
      plan = await standalonePlan(toolId, { profile, model, cwd, o, base });
      updateRun(file, { server: false, statusSource: 'basic' });
    }
  } catch (e) {
    removeRun(file);
    await stopIfUnused(toolId, { except: run.runId }).catch(() => {});
    console.error(`hoprig: ${e.message}`);
    return 1;
  }
  if (plan.sessionId) updateRun(file, { sessionId: plan.sessionId });
  console.error(`hoprig: ${tool.name} · provider ${profile.name} · ${profile.label}`);
  const { code, signalled } = await runChild(tool.binPath(), plan.args, { ...plan.env, HOPRIG_RUN_FILE: file }, follow, { report });
  removeRun(file);
  if (plan.cleanup) plan.cleanup();
  // The last session of the tool stops its server. Not when the terminal itself is closing or being restarted
  // (a move to another provider): the next launcher may be on its way, and this process may not live long enough
  // to finish. The dashboard stops a server that nobody uses after a while (./feature.mjs).
  if (!signalled) await stopIfUnused(toolId, { except: run.runId }).catch(() => {});
  return code;
}

const clip = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

/** What the watchers tell, written into the run record (the dashboard reads it from there). */
function makeReporter(file) {
  let last = 'starting';
  const report = (next) => {
    if (!next) return;
    updateRun(file, statusPatch(last, next));
    last = next.status;
  };
  report.claim = (id) => updateRun(file, { sessionId: id });
  report.title = (t) => updateRun(file, { title: clip(t, 120) });
  report.message = (t) => updateRun(file, { lastMessage: clip(t, 300) });
  report.basic = (on) => updateRun(file, { statusSource: on ? 'basic' : 'server' });
  return report;
}

/** Start the program in this terminal; `follow(child)` watches the server meanwhile and returns a stop function. */
function runChild(bin, args, env, follow, { report }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    const onInt = () => {}; // Ctrl+C belongs to the program (it shares our terminal)
    let signalled = false;
    const forward = (sig) => () => { signalled = true; try { child.kill(sig); } catch { /* gone */ } };
    const onTerm = forward('SIGTERM');
    const onHup = forward('SIGHUP');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    const stop = follow ? follow() : (report({ status: 'waiting' }), null);
    const done = (code) => {
      if (stop) stop();
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      resolve({ code, signalled });
    };
    child.on('error', (e) => {
      console.error(`hoprig: could not start ${bin}: ${e.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

// ---- Codex ----

async function codexPlan(server, { profile, model, cwd, o, base, report }) {
  const prov = serverProviders('codex', [profile])[0];
  const client = await codexClient({ port: server.port, secret: server.secret });
  let resume = o.resume || (o.cont ? (codexSessions(cwd)[0] || {}).id || null : null);
  if (resume) {
    // Loaded with this provider and model before the terminal resumes it, and a check that Codex has the
    // conversation at all. Codex keeps a conversation on the provider it was started on ("Cannot change this
    // thread's model provider … on resume", 0.169): a move to another provider continues a copy of it there
    // (thread/fork: the whole conversation, a new id), and the original stays as it was.
    const on = { cwd, ...(prov.signin ? { modelProvider: 'openai' } : { modelProvider: prov.id }), ...(model ? { model } : {}) };
    try {
      await client.call('thread/resume', { threadId: resume, ...on, excludeTurns: true });
    } catch (e) {
      if (/model provider/i.test(e.message)) {
        try {
          const f = await client.call('thread/fork', { threadId: resume, ...on, excludeTurns: true });
          console.error(`hoprig: Codex keeps a conversation on one provider, so it continues here as a copy (${f.thread.id}).`);
          resume = f.thread.id;
        } catch (e2) {
          client.close();
          throw new Error(`Codex cannot continue that conversation on this provider: ${e2.message}`);
        }
      } else {
        if (o.resume) {
          client.close();
          throw new Error(`Codex cannot continue that conversation: ${e.message}`);
        }
        resume = null; // -c in a folder whose newest thread has nothing to resume: a new one
      }
    }
  }
  const env = { ...cleanEnv(base), ...findTool('codex').noSelfUpdate.env, HOPRIG_CODEX_WS: server.secret };
  const args = codexTuiArgs({ port: server.port, prov, model, cwd, resume, o });
  if (resume) report.title((codexSessions(cwd).find((x) => x.id === resume) || {}).title || '');
  let mine = resume;
  let unlock = resume ? null : await folderLock(cwd);
  // Codex makes the thread when its screen opens; after a first start in a folder it asks first whether to trust
  // the folder. The next new session of the folder waits at most this long for this one to find its thread.
  if (unlock) setTimeout(() => { if (unlock) unlock(); unlock = null; }, 30_000).unref();
  const onNote = (method, p) => {
    if (method === 'thread/started' && !mine) {
      const t = p.thread || {};
      if (t.ephemeral || t.parentThreadId || !t.id || real(threadCwd(t)) !== real(cwd)) return;
      mine = t.id;
      if (unlock) unlock();
      unlock = null;
      report.claim?.(mine);
      report({ status: 'waiting' }); // its own status events follow from here
      return;
    }
    if (!mine || p.threadId !== mine) return;
    if (method === 'thread/status/changed') report(codexStatus(p.status));
    else if (method === 'thread/name/updated' && typeof p.threadName === 'string') report.title?.(p.threadName);
  };
  return {
    args, env, sessionId: resume,
    cleanup: () => { if (unlock) unlock(); },
    follow: () => watchCodex(client, server, onNote, report, Boolean(resume)),
  };
}

// `known`: the thread is known from the start (a resume). A new one is "starting" until Codex has made it: on a
// first start in a folder Codex asks whether to trust the folder before that.
function watchCodex(first, server, onNote, report, known) {
  let client = first;
  let stopped = false;
  const attach = (c) => {
    c.on('notification', onNote);
    c.on('close', () => {
      if (stopped) return;
      report.basic?.(true);
      reconnect();
    });
  };
  const reconnect = async () => {
    while (!stopped) {
      await sleep(3000);
      try {
        client = await codexClient({ port: server.port, secret: server.secret });
        if (stopped) return client.close();
        report.basic?.(false);
        attach(client);
        return;
      } catch {
        /* the server is not back yet */
      }
    }
  };
  attach(client);
  if (known) report({ status: 'waiting' });
  return () => {
    stopped = true;
    client.close();
  };
}

// ---- OpenCode ----

async function opencodePlan(server, { profile, model, cwd, o, base, report }) {
  const prov = serverProviders('opencode', [profile])[0];
  const oc = opencodeClient(server);
  const t = findTool('opencode');
  const want = model ? { providerID: prov.id, id: model, ...(o.effort ? { variant: o.effort } : {}) } : null;
  let id = o.resume || (o.cont ? ((await opencodeSessions(cwd, { ensure: async () => ({ ok: true, server }) }))[0] || {}).id || null : null);
  if (id) {
    const j = await oc.req('GET', `/api/session/${encodeURIComponent(id)}`).catch((e) => {
      throw new Error(`OpenCode cannot continue that conversation: ${e.message}`);
    });
    if (j && j.data && typeof j.data.title === 'string') report.title(j.data.title);
    if (want) await oc.req('POST', `/api/session/${encodeURIComponent(id)}/model`, { model: want });
  } else {
    const body = { location: { directory: cwd }, ...(want ? { model: want } : {}), ...t.sessionPermissions(o) };
    const j = await oc.req('POST', '/api/session', body);
    id = j && j.data && j.data.id;
    if (!isToolSessionId('opencode', id)) throw new Error('OpenCode did not make a conversation');
  }
  const env = { ...cleanEnv(base), ...t.noSelfUpdate.env, OPENCODE_PASSWORD: server.secret };
  const args = opencodeTuiArgs({ url: oc.url, id, cwd, o });
  return { args, env, sessionId: id, follow: () => watchOpencode(oc, id, report) };
}

function watchOpencode(oc, id, report) {
  report({ status: 'waiting' });
  const ac = new AbortController();
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        report.basic?.(false);
        await oc.events((ev) => {
          const d = ev.data || {};
          if (d.sessionID !== id) return;
          if (ev.type === 'session.renamed' && typeof d.title === 'string') return report.title?.(d.title);
          if (ev.type === 'session.text.ended' && typeof d.text === 'string') return report.message?.(d.text);
          report(opencodeStatus(ev.type, d));
        }, { signal: ac.signal });
      } catch {
        /* the stream broke: try again below */
      }
      if (stopped) return;
      report.basic?.(true);
      await sleep(3000);
    }
  })();
  return () => {
    stopped = true;
    ac.abort();
  };
}

// ---- on its own (no server) ----

async function standalonePlan(toolId, { profile, model, cwd, o, base }) {
  const t = findTool(toolId);
  if (toolId === 'codex') {
    const { env } = await startSettings('codex', profile, { base: cleanEnv(base) });
    const resume = o.resume || (o.cont ? (codexSessions(cwd)[0] || {}).id || null : null);
    const args = [...codexArgs(profile), ...(model && !profile.env?.ANTHROPIC_MODEL ? ['-m', model] : []), ...t.flagsFor(o), ...o.extra, '-C', cwd, ...(resume ? ['resume', resume] : []), ...promptTail('codex', o.prompt)];
    return { args, env, sessionId: resume };
  }
  const { env } = await startSettings('opencode', profile, { base: cleanEnv(base) });
  const args = ['--standalone', ...(o.resume ? ['-s', o.resume] : o.cont ? ['-c'] : []), ...t.flagsFor(o), ...o.extra, ...promptTail('opencode', o.prompt), cwd];
  return { args, env, sessionId: o.resume || null };
}


/**
 * `hoprig codex|opencode [provider] [args]`: start the tool in this terminal. Without a provider: the only one that
 * serves the tool, else the names to choose from.
 */
export async function toolCommand(toolId, args) {
  const tool = findTool(toolId);
  const [first, ...rest] = args;
  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(`hoprig ${toolId} [provider] [-c | --resume <id>] [--permission-mode ${tool.options.permissionModes.join('|')}]
                 [--effort ${tool.options.efforts.join('|')}] [--model <id>] [-- <first message>]

  Starts ${tool.name} in this terminal on a provider that serves it. Hoprig keeps the session's status for the
  dashboard and stops its own ${tool.name} server when the last session ends.`);
    return 0;
  }
  if (first && !first.startsWith('-') && validName(first) && readProfile(first)) return launchTool(toolId, first, rest);
  const fit = listProfiles().filter((p) => servesTools(p).includes(toolId));
  if (first && !first.startsWith('-')) {
    console.error(`hoprig: no provider "${first}". Providers for ${tool.name}: ${fit.map((p) => p.name).join(', ') || 'none yet'}.`);
    return 2;
  }
  if (fit.length === 1) return launchTool(toolId, fit[0].name, args);
  console.error(fit.length
    ? `hoprig: name the provider for ${tool.name}: ${fit.map((p) => p.name).join(', ')} (hoprig ${toolId} <provider>)`
    : `hoprig: no provider serves ${tool.name} yet. Add an OpenAI key, a gateway, or (Codex) a Codex sign-in on the Providers page, then Test it.`);
  return 2;
}
