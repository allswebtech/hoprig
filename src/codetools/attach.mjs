// Attaching a terminal session of Codex or OpenCode to Hoprig's server of that tool (./servers.mjs), and following
// its status there; or, when the server cannot be used, starting the tool on its own. The launcher that calls these
// is ./terminal.mjs. What was checked against the real tools (Codex 0.169, OpenCode 2.3):
//   Codex     the server tells every client when a thread starts (thread/started, with its folder) and every
//             change of a thread's state (thread/status/changed: active, active + waitingOnApproval, idle), also of
//             threads other clients started. A terminal makes its thread when its screen opens; a thread nobody typed
//             into cannot be resumed (no rollout yet). A thread stays on the provider it started on: resuming it on
//             another is refused, forking it there works.
//   OpenCode  a conversation made through the server's API is opened in a terminal with -s <id>; the event stream
//             carries session.execution.started/succeeded/failed/interrupted, permission.asked/replied and
//             form.created for every conversation; POST /api/session/<id>/model moves it to another provider.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from '../paths.mjs';
import { codexClient, opencodeClient } from './clients.mjs';
import { findTool } from './index.mjs';
import { codexArgs, startSettings, tomlString } from './providers.mjs';
import { cleanEnv, codexBlockArgs, serverProviders } from './servers.mjs';
import { codexSessions, isToolSessionId, opencodeSessions } from './stores.mjs';

// A first message is one argument that can never be read as an option: OpenCode reads `--prompt <text>` with a text
// that starts with "-" as an option of its own (checked with 2.3: `--prompt --version` printed its version), so the
// text is joined to its flag; Codex takes it after `--`.
export const promptTail = (tool, prompt) => (!prompt ? [] : tool === 'opencode' ? [`--prompt=${prompt}`] : prompt.startsWith('-') ? ['--', prompt] : [prompt]);

/** Codex's command line for a terminal attached to Hoprig's app server. */
export function codexTuiArgs({ port, prov, model, cwd, resume = null, o }) {
  const t = findTool('codex');
  return [
    '--remote', `ws://127.0.0.1:${port}`, '--remote-auth-token-env', 'HOPRIG_CODEX_WS',
    ...t.noSelfUpdate.args,
    // Always named: a thread's provider is the one its terminal names, and without a name the server's default (a
    // key provider) would get a session the owner started on the Codex sign-in.
    ...codexBlockArgs(prov), '-c', `model_provider=${tomlString(prov.signin ? 'openai' : prov.id)}`,
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


// ---- Codex ----

/**
 * Is a thread that Codex's server announced (thread/started) a new conversation of the folder `cwd`? Not a
 * subagent's thread, not a passing one, and not a copy another launcher makes for a move (thread/fork announces its
 * copy with forkedFromId, checked with 0.169).
 */
export const isNewThreadOf = (t, cwd) => Boolean(t && t.id) && !t.ephemeral && !t.parentThreadId && !t.forkedFromId && real(threadCwd(t)) === real(cwd);

export async function codexPlan(server, { profile, model, cwd, o, base, report }) {
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
      if (!isNewThreadOf(t, cwd)) return;
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

export async function opencodePlan(server, { profile, model, cwd, o, base, report }) {
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

export async function standalonePlan(toolId, { profile, model, cwd, o, base }) {
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
