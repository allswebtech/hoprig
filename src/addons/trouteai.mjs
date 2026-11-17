// TRouteAI (https://github.com/allswebtech/trouteai, MIT): a self-hosted AI gateway. You add providers in its
// own dashboard (OpenAI, Gemini, OpenRouter, local models and more); it offers them through one
// Anthropic-compatible API, which is what Claude Code speaks. As a hoprig profile it is an "api" account that
// Auto mode can fall back to.
//
// Its command line (from `trouteai --help`, version 1.0.8): `trouteai` starts it (dashboard and API on one
// port, default 20017), `trouteai update` updates it. It is an npm package: `npm install -g trouteai`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { binFile, stateDir } from '../paths.mjs';
import { filedProcess, system } from '../procid.mjs';
import { capture, npmArgv, stream, which } from '../setup/system.mjs';
import { forInstalls } from '../secretenv.mjs';

export const DEFAULT_PORT = 20017;

const port = () => Number(loadConfig().addons?.trouteai?.port) || DEFAULT_PORT;
const url = () => `http://localhost:${port()}`;
// The gateway this add-on started (only start() writes it): { pid, proc } (proc: its identity, procid.mjs), or the bare
// pid an older version wrote.
const pidFile = () => path.join(stateDir(), 'addons', 'trouteai.pid');
const logFile = () => path.join(stateDir(), 'addons', 'trouteai.log');

/** Does something answer on the port? */
export function listening(p = port(), host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ port: p, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const quote = (s) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(s) ? s : `"${s}"`);

async function status() {
  const bin = which('trouteai');
  let version = null;
  if (bin) {
    try {
      const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec((await capture([bin, '--version'], { timeout: 10_000 })).stdout || '');
      version = m ? m[1] : null;
    } catch {
      /* installed, version unknown */
    }
  }
  return { installed: Boolean(bin), version, running: await listening(), url: url() };
}

async function install({ onLine = () => {} } = {}) {
  const r = await stream(npmArgv(['install', '-g', 'trouteai']), { env: forInstalls(process.env), onLine });
  return { ok: r.ok && Boolean(which('trouteai')) };
}

async function update({ onLine = () => {} } = {}) {
  const was = await listening();
  if (was) await stop();
  const r = await stream(npmArgv(['install', '-g', 'trouteai@latest']), { env: forInstalls(process.env), onLine });
  if (was) await start();
  return { ok: r.ok };
}

/** Start it in the background unless it already answers. It keeps running after this process ends. */
async function start() {
  if (await listening()) return { ok: true, url: url(), already: true };
  const bin = which('trouteai');
  if (!bin) return { ok: false, url: url(), error: 'TRouteAI is not installed (hoprig addons install trouteai)' };
  fs.mkdirSync(path.dirname(logFile()), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logFile(), 'a', 0o600);
  // A .cmd shim (npm on Windows) only starts through a shell.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(viaShell ? `"${bin}"` : bin, ['--port', String(port())], { detached: true, stdio: ['ignore', log, log], windowsHide: true, shell: viaShell });
  child.unref();
  fs.closeSync(log);
  if (child.pid) {
    const after = await system.refresh([child.pid]);
    fs.writeFileSync(pidFile(), JSON.stringify({ pid: child.pid, proc: system.of([child.pid], { after }).get(child.pid) || null }), { mode: 0o600 });
  }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await listening()) return { ok: true, url: url(), already: false };
  }
  return { ok: false, url: url(), error: `TRouteAI did not answer on port ${port()} within 30 seconds (see ${logFile()})` };
}

// The process that listens on the port, when we did not start it ourselves.
async function pidOnPort() {
  try {
    if (process.platform === 'win32') {
      const r = await capture(['netstat', '-ano', '-p', 'TCP'], { timeout: 10_000 });
      const line = (r.stdout || '').split('\n').find((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port()}\\s`).test(l));
      return line ? Number(line.trim().split(/\s+/).pop()) || null : null;
    }
    if (which('lsof')) {
      const r = await capture(['lsof', '-ti', `TCP:${port()}`, '-sTCP:LISTEN'], { timeout: 10_000 });
      return Number((r.stdout || '').trim().split('\n')[0]) || null;
    }
    const r = await capture(['ss', '-ltnpH', `sport = :${port()}`], { timeout: 10_000 });
    const m = /pid=(\d+)/.exec(r.stdout || '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function readPidFile() {
  try {
    const text = fs.readFileSync(pidFile(), 'utf8').trim();
    const rec = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
    return Number.isInteger(rec?.pid) && rec.pid > 0 ? rec : null;
  } catch {
    return null; // not started by us
  }
}

/** The parent of `pid` where it can be read (Linux, macOS), else null. */
async function parentOf(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null; // field 4, after the name and state
    }
    if (process.platform === 'darwin') return Number((await capture(['ps', '-o', 'ppid=', '-p', String(pid)], { timeout: 5000 })).stdout.trim()) || null;
  } catch {
    /* gone */
  }
  return null;
}

/**
 * The file's pid, when it is shown to be the gateway this add-on started (procid.mjs filedProcess): its identity, or for
 * a file without one, being what listens on the port (`onPort`), its parent (a .cmd shim, a shell) or its child. Else
 * null: after a restart of the computer that pid may be another program's.
 */
async function startedByUs(rec, onPort) {
  if (!rec) return null;
  const [up, down] = onPort ? await Promise.all([parentOf(onPort), parentOf(rec.pid)]) : [null, null];
  // Without the process on the port nothing is related to it (null === null is no relation).
  const related = !onPort ? null : rec.pid === onPort || up === rec.pid || down === onPort ? true : up && down ? false : null;
  const after = (await system.refresh([rec.pid])) || 0;
  return filedProcess(pidFile(), rec, { fact: () => related, after }) === true ? rec.pid : null;
}

/** Stop it: what listens on its port is the gateway; the file's pid only when it is shown to be ours (startedByUs). */
async function stop() {
  if (!(await listening())) return { ok: true, already: true };
  const rec = readPidFile();
  const signal = async (sig) => {
    const onPort = await pidOnPort();
    for (const p of new Set([onPort, await startedByUs(rec, onPort)])) {
      if (p) try { process.kill(p, sig); } catch { /* gone */ }
    }
  };
  await signal('SIGTERM');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await listening())) {
      fs.rmSync(pidFile(), { force: true });
      return { ok: true };
    }
  }
  await signal('SIGKILL');
  fs.rmSync(pidFile(), { force: true });
  return { ok: !(await listening()) };
}

export const trouteai = {
  id: 'trouteai',
  title: 'TRouteAI',
  summary: 'A self-hosted AI gateway. Add any provider in its dashboard (OpenAI, Gemini, OpenRouter, local models…) and Claude Code can use them all as one more provider.',
  homepage: 'https://github.com/allswebtech/trouteai',
  // An AI gateway with Claude's API on this port: src/gateway finds it on every computer and can share it.
  gateway: { port },
  status,
  install,
  update,
  start,
  stop,
  /** The profile `addons setup` writes. The key comes from TRouteAI's own dashboard and is typed by the owner. */
  profile: () => ({
    name: 'api',
    label: 'API via TRouteAI',
    env: { ANTHROPIC_BASE_URL: url() },
    // Started on demand: the first session (or the router) that needs it brings it up.
    prerun: `${quote(process.execPath)} ${quote(binFile())} addons start trouteai`,
    tokenVar: 'ANTHROPIC_AUTH_TOKEN',
    tokenHint: `Open ${url()} , sign in, create an API key and paste it here`,
  }),
};
