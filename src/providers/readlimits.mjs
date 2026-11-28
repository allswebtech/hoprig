// Read the limits of the providers now (Refresh on the Providers page). Limits are otherwise learnt only from answers
// that pass the router, so a provider nobody used lately showed nothing. A subscription sign-in is used by Claude Code
// itself and by nothing else, so this asks nothing of its own: it starts Claude Code, the way a session of that provider
// is started, with ONE smallest question, and its request passes a pass-through pinned to that one provider. The
// pass-through is served by this process alone, for the length of the read (router.mjs serveProbe: the router's own
// handler, a free port, a secret made for this read), never by the long-lived router that sessions use. It keeps the
// figures of the answer as the router does for every session (files every process reads), and the refusal of a sign-in.
// This module sends no request of its own and holds no key in a header.
//   subscription with a key, or the stored sign-in   one run of Claude Code, at most 25 seconds, at most three at once
//   keys, gateways, hub rows                          not read here
// All at the same time (three at once); one read in flight; a call within 30 seconds of the last one gets that answer.
//
// The command (every option is in `claude --help` of 2.1.332):
//   -p .                                  non-interactive, a prompt of one character
//   --model haiku                         the smallest model by its alias, never a dated name
//   --tools ""                            no tool (so the one question is one turn: this version has no --max-turns)
//   --strict-mcp-config                   with no --mcp-config: no MCP server
//   --system-prompt .                     the smallest system prompt the command allows
//   --disable-slash-commands              no skill, no command
//   --no-session-persistence              no session file: nothing to resume or to see
//   --settings {"disableAllHooks":true}   no hook of the person's own settings answers
//   --output-format json                  one result, no stream
// Its environment is the provider own (profileEnv) with this read pass-through as base address, no instruction files of the person,
// no optional traffic. It runs in an empty folder of Hoprig's own state, in a process group of its own that is ended as a whole.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claudeLoginStatus } from '../claudecode.mjs';
import { loadConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { listProfiles, ownFolder, profileEnv } from '../profiles.mjs';
import { serveProbe } from '../router.mjs';
import { billedLogin, paidMethod, profileUsage, refusedOf } from '../routerstate.mjs';
import { resolveWindowsBin, windowsSpawnPlan } from '../winspawn.mjs';

export const READ_LIMIT_MS = 25_000;
export const SHARE_MS = 30_000;
export const AT_ONCE = 3;
export const SMALLEST_MODEL = 'haiku'; // an alias: the newest smallest model, named by Claude Code itself
export const READ_ARGS = ['-p', '.', '--model', SMALLEST_MODEL, '--tools', '', '--strict-mcp-config', '--system-prompt', '.', '--disable-slash-commands', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--output-format', 'json'];

// The variables of a session's own run that a read must not carry: its record, its terminal, the permission switch.
const SESSION_VARS = ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID', 'HOPRIG_ALLOW_EVERYTHING', 'CLAUDECODE'];

const emptyFolder = () => {
  const dir = path.join(stateDir(), 'read-limits');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** One run of Claude Code: resolves { code, timedOut } (never rejects). Its whole process group ends at `ms`. */
function runClaude({ command, args, env, cwd, ms, spawnImpl = spawn, platform = process.platform, live = null }) {
  return new Promise((resolve) => {
    let plan = { command, args, options: {} };
    if (platform === 'win32') {
      const found = resolveWindowsBin(command, env);
      if (found) plan = windowsSpawnPlan(found, args, env);
    }
    let child;
    try {
      child = spawnImpl(plan.command, plan.args, { stdio: ['ignore', 'ignore', 'ignore'], env, cwd, detached: platform !== 'win32', windowsHide: true, ...plan.options });
    } catch (e) {
      return resolve({ code: null, error: e });
    }
    if (live) {
      live.add(child);
      child.on('exit', () => live.delete(child));
    }
    let done = false;
    const end = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const kill = (sig) => {
      try {
        if (platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* gone */ }
      }
    };
    const timer = setTimeout(() => {
      if (platform !== 'win32') {
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 2000).unref();
        return end({ code: null, timedOut: true });
      }
      // The npm shim runs as cmd.exe: ending it alone leaves the program under it. End the tree now, while cmd.exe is
      // there, and give the slot back only when that is done (or after five seconds).
      const over = () => end({ code: null, timedOut: true });
      let killer = null;
      try { killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* the plain kill below */ }
      kill('SIGTERM');
      if (killer && killer.on) {
        killer.on('exit', over);
        killer.on('error', over);
        setTimeout(over, 5000).unref();
      } else over();
    }, ms);
    child.on('error', (error) => end({ code: null, error }));
    child.on('exit', (code) => end({ code }));
  });
}

export function createLimitReader({ now = Date.now, loginStatus = claudeLoginStatus, profiles = listProfiles, probe = serveProbe, command = null, limitMs = READ_LIMIT_MS, atOnce = AT_ONCE, spawnImpl = spawn, platform = process.platform, askOne = null } = {}) {
  // `askOne(profile)`: the demo's stand-in for the run (made-up figures, no program). The router marks a limit by itself.
  let last = null; // { key, at, answer }
  let flight = null; // { key, promise }
  let running = 0;
  const live = new Set(); // the runs that are alive: the dashboard stopping must not leave one behind
  let servedNow = null;
  const waiting = [];
  const slot = () => (running < atOnce ? (running++, Promise.resolve()) : new Promise((r) => waiting.push(r)).then(() => { running++; }));
  const release = () => {
    running--;
    const next = waiting.shift();
    if (next) next();
  };

  async function ask(p, routerUrl) {
    const name = p.name;
    if (askOne) return askOne(p);
    const started = Date.now(); // the router writes what it learnt with the real clock
    const cfg = command || { command: loadConfig().claudeBin || 'claude', args: [] };
    const env = profileEnv(p);
    for (const k of SESSION_VARS) delete env[k];
    env.ANTHROPIC_BASE_URL = `${routerUrl}/probe/${name}`; // the router passes Claude Code's own request on to this provider only
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'; // the person's own instruction files do not ride along: measured, 4.7 KB became 2.0 KB
    await slot();
    let r;
    try {
      r = await runClaude({ command: cfg.command, args: [...cfg.args, ...READ_ARGS], env, cwd: emptyFolder(), ms: limitMs, spawnImpl, platform, live });
    } finally {
      release();
    }
    // What the router learnt from the answer is the answer: the figures, or a refused sign-in.
    const refused = refusedOf(name);
    if (refused && refused.at >= started) return { name, ok: false, read: 'signin', error: 'Claude refused the sign-in' };
    const seen = profileUsage(Date.now())[name];
    if (seen && seen.at >= started) return { name, ok: true, read: 'figures' };
    if (r.timedOut) return { name, ok: false, read: 'none', error: `did not answer in ${Math.round(limitMs / 1000)} seconds` };
    if (r.error) return { name, ok: false, read: 'none', error: 'Claude Code could not be started' };
    return r.code === 0 ? { name, ok: true, read: 'none' } : { name, ok: false, read: 'none', error: 'Claude Code gave no answer' };
  }

  async function readOne(p, routerUrl) {
    const name = p.name;
    if (p.hub || p.kind === 'api' || p.kind === 'openai' || p.kind === 'chatgpt') return { name, ok: true, read: 'none', error: p.hub ? 'read on the other computer' : 'billed by use: no limits to read' };
    if (p.kind === 'login') {
      try {
        if (!askOne && !ownFolder(p)) { // a folder of its own: the run itself shows whether its sign-in works
          const s = (await loginStatus()) || {};
          if (s.loggedIn !== true) return { name, ok: true, read: 'signin' }; // signed out: nothing to ask
          if (paidMethod(s.method) || billedLogin(p)) return { name, ok: true, read: 'none', error: 'billed by use: no limits to read' };
        }
      } catch (e) {
        return { name, ok: false, read: 'none', error: String(e && e.message ? e.message : e).slice(0, 120) };
      }
    } else if (!(p.env && p.env.CLAUDE_CODE_OAUTH_TOKEN)) return { name, ok: true, read: 'signin' }; // signed out here: nothing to ask
    return ask(p, routerUrl);
  }

  /** Read every provider (or `name` only); the answer: { at, results: [{ name, ok, read, error? }] }. */
  function read({ name = null } = {}) {
    const key = name || '*';
    const t = now();
    if (last && last.key === key && t - last.at < SHARE_MS) return Promise.resolve(last.answer);
    if (flight) return flight.promise;
    const list = profiles().filter((p) => !p.virtual && (!name || p.name === name));
    const fail = (p, e) => ({ name: p.name, ok: false, read: 'none', error: String(e && e.message ? e.message : e).slice(0, 120) });
    const promise = (async () => {
      const needsRun = !askOne && list.some((p) => !p.hub && (p.kind === 'login' || p.kind === 'subscription'));
      let served = null;
      let probeError = null;
      let results;
      try {
        if (needsRun) {
          try { served = await probe(); servedNow = served; } catch (e) { probeError = e; }
        }
        results = await Promise.all(list.map((p) => (needsRun && !served && (p.kind === 'login' || p.kind === 'subscription') && !p.hub
          ? Promise.resolve(fail(p, probeError || 'the read could not start'))
          : readOne(p, served && served.url).catch((e) => fail(p, e)))));
      } finally {
        if (served) await served.close().catch(() => {}); // closed when the read ends, whatever came of it
        if (servedNow === served) servedNow = null;
      }
      const answer = { at: now(), results };
      last = { key, at: answer.at, answer };
      return answer;
    })().finally(() => { flight = null; });
    flight = { key, promise };
    return promise;
  }
  /** The dashboard stops: end every live run as a whole group (a tree on Windows) and close the pass-through. */
  function close() {
    for (const child of live) {
      try {
        if (platform === 'win32') {
          try { spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* the plain kill below */ }
          child.kill('SIGKILL');
        } else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    }
    live.clear();
    const s = servedNow;
    servedNow = null;
    if (s) Promise.resolve(s.close()).catch(() => {});
  }
  return { read, close, lastAt: () => (last ? last.at : null) };
}
