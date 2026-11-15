// The VS Code server behind the dashboard: `code serve-web`, started when a folder is first opened and stopped when
// no browser has had it open for a while (feature.mjs decides when).
//
// Why without a connection token: VS Code's page reads its token in JavaScript and sends it inside its own WebSocket
// messages, so a proxy cannot keep it from the browser. Instead it listens only on a Unix socket in a folder only this
// user can open (mkdtemp: 0700), and runs under umask 077, so the socket VS Code makes for its inner server is private
// too. Nobody but this user (who can run anything anyway) reaches it directly; from a browser the only way in is the
// dashboard with its login (proxy.mjs). Windows would need a TCP port that every local user can reach: not offered there.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { which } from '../setup/system.mjs';
import { resolveWindowsBin, windowsSpawnPlan } from '../winspawn.mjs';

/** Where VS Code is served on the dashboard. VS Code is told this, so its own links already start with it. */
export const BASE = '/vscode';

// Where installers put `code` when it is not on the dashboard's PATH (a background service on macOS has a short one).
const PLACES = {
  darwin: ['/usr/local/bin/code', '/opt/homebrew/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
  linux: ['/usr/bin/code', '/snap/bin/code'],
  win32: [],
};

/** The `code` program of this computer, or null. */
export function findCode(env = process.env, platform = process.platform) {
  if (platform === 'win32') return resolveWindowsBin('code', env);
  return which('code', env, platform) || (PLACES[platform] || []).find((p) => fs.existsSync(p)) || null;
}

// What VS Code and its terminals must not inherit from the dashboard: a provider's sign-in and the run file of one
// session (the terminal's own `claude` then uses the login stored on this computer), and the hooks of another VS Code
// that started the dashboard (with them, `code` would hand the folder to that window instead).
const STRIP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|HOPRIG_PROFILE$|HOPRIG_RUN_FILE$|VSCODE_|ELECTRON_RUN_AS_NODE$)/;
export function childEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP.test(k)) env[k] = v;
  return env;
}

/** True where VS Code in the browser can be served privately (see the header). */
export const browserSupported = (platform = process.platform) => platform !== 'win32';

/** Start `argv` the right way for this system (a .cmd on Windows goes through cmd.exe, escaped). */
export function spawnPlan(argv, platform = process.platform, env = process.env) {
  const [cmd, ...args] = argv;
  if (platform !== 'win32') return { command: cmd, args, options: {} };
  return windowsSpawnPlan(resolveWindowsBin(cmd, env) || cmd, args, env);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True once something accepts a connection on the Unix socket `socketPath`. */
function reachable(socketPath) {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/** Signal every process of the server: it runs in a process group of its own (POSIX), or as a tree (Windows). */
function killTree(pid, signal, platform) {
  if (platform === 'win32') {
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

export class VscodeServer {
  /**
   * command   the program as an argv prefix (tests: a stand-in); default: `code` of this computer
   * dataDir   VS Code's own folders (its download, settings, extensions); default <stateDir>/vscode
   */
  constructor({ command = null, platform = process.platform, env = process.env, dataDir = null, readyMs = 30_000, stopMs = 5000 } = {}) {
    Object.assign(this, { command, platform, env, readyMs, stopMs, fixedDataDir: dataDir });
    this.child = null;
    this.readyP = null;
    this.ready = false;
    this.target = null; // { socketPath }
    this.lines = []; // the newest lines it printed
    this.error = null; // why the last start failed, in its own words
  }

  dataDir() {
    return this.fixedDataDir || path.join(stateDir(), 'vscode');
  }

  program() {
    if (this.command) return this.command;
    const found = findCode(this.env, this.platform);
    return found ? [found] : null;
  }

  get running() {
    return Boolean(this.child) && this.ready;
  }

  get starting() {
    return Boolean(this.child) && !this.ready;
  }

  /** Start it (once; callers share the same start). Resolves when it answers; rejects with the reason. */
  start() {
    if (this.readyP) return this.readyP;
    const prog = this.program();
    if (!prog) return Promise.reject(new Error('VS Code is not installed on this computer.'));
    if (!browserSupported(this.platform)) return Promise.reject(new Error('VS Code in the browser is not offered on Windows yet.'));
    // A private folder (mkdtemp makes it 0700) for the socket: no other user can reach it.
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-vscode-'));
    const data = this.dataDir();
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    const socketPath = path.join(run, 'vs.sock');
    const args = [
      'serve-web',
      '--socket-path', socketPath,
      '--without-connection-token', // see the header: the private socket and the dashboard's login stand for it
      // Only ever started after the owner accepted the license in the page (feature.mjs checks it first).
      '--accept-server-license-terms',
      '--server-base-path', BASE,
      '--disable-telemetry',
      '--cli-data-dir', path.join(data, 'cli'),
      '--server-data-dir', path.join(data, 'server'),
    ];
    // umask 077 through sh, so every socket and file it makes (its inner server's socket in the temporary folder too)
    // is this user's only. The program and its arguments reach sh as "$@" (an array), never as a line sh would parse.
    let child;
    try {
      child = spawn('/bin/sh', ['-c', 'umask 077 && exec "$@"', 'hoprig-vscode', ...prog, ...args], {
        env: childEnv(this.env), cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
    } catch (e) {
      fs.rmSync(run, { recursive: true, force: true });
      return Promise.reject(e);
    }
    Object.assign(this, { child, ready: false, target: { socketPath }, lines: [], error: null });
    const keep = (stream) => {
      let rest = '';
      stream.on('data', (c) => {
        const all = rest + c.toString('utf8');
        const parts = all.split(/\r?\n/);
        rest = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          this.lines.push(line.slice(0, 500));
          if (this.lines.length > 40) this.lines.shift();
        }
      });
    };
    keep(child.stdout);
    keep(child.stderr);
    this.writePid(child.pid, run);

    let exited = false;
    const lastWords = () => [...this.lines].reverse().find((l) => !/^\s*\*/.test(l)) || 'no output';
    const readyP = new Promise((resolve, reject) => {
      child.once('error', (e) => {
        exited = true;
        reject(new Error(`VS Code could not be started: ${e.message}`));
      });
      child.once('exit', (code, signal) => {
        exited = true;
        reject(new Error(`VS Code stopped while starting (${signal || `exit ${code}`}): ${lastWords()}`));
      });
      (async () => {
        const until = Date.now() + this.readyMs;
        while (!exited && Date.now() < until) {
          if (await reachable(socketPath)) return resolve();
          await sleep(200);
        }
        if (!exited) reject(new Error(`VS Code did not answer within ${Math.round(this.readyMs / 1000)} s: ${lastWords()}`));
      })();
    });
    // Gone, or never started (a program that cannot be run fires 'error' and no 'exit'): a later start begins afresh.
    let cleaned = false;
    const cleanup = (started) => {
      if (cleaned) return;
      cleaned = true;
      if (this.child === child) Object.assign(this, { child: null, readyP: null, ready: false, target: null });
      fs.rmSync(run, { recursive: true, force: true });
      this.removePid(child.pid);
      // A part that ignored the first signal is not left behind (the group is ours: its leader just ended).
      if (started) setTimeout(() => killTree(child.pid, 'SIGKILL', this.platform), 3000).unref();
    };
    child.once('exit', () => cleanup(true));
    child.once('error', () => cleanup(false));
    this.readyP = readyP.then(
      () => {
        if (this.child === child) this.ready = true;
      },
      (e) => {
        this.error = e.message;
        if (this.child === child) this.stop();
        throw e;
      },
    );
    return this.readyP;
  }

  /** Stop it and everything it started. Resolves when it has gone (or after a hard stop). */
  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      let hard = null;
      child.once('exit', () => {
        clearTimeout(hard);
        resolve();
      });
      killTree(child.pid, 'SIGTERM', this.platform);
      hard = setTimeout(() => {
        killTree(child.pid, 'SIGKILL', this.platform);
        setTimeout(resolve, 1000).unref();
      }, this.stopMs);
    });
  }

  pidFile() {
    return path.join(this.dataDir(), 'server.pid');
  }

  writePid(pid, run) {
    try {
      fs.writeFileSync(this.pidFile(), JSON.stringify({ pid, run, marker: path.join(this.dataDir(), 'cli') }) + '\n', { mode: 0o600 });
    } catch {
      /* only needed to clean up after a crash */
    }
  }

  removePid(pid) {
    try {
      if (JSON.parse(fs.readFileSync(this.pidFile(), 'utf8')).pid === pid) fs.rmSync(this.pidFile());
    } catch {
      /* none */
    }
  }

  /**
   * A server left running by a dashboard that crashed: stopped when its process group still runs our own command
   * (its --cli-data-dir is ours), never on the process number alone, which the system may have given to another program.
   */
  cleanLeftover() {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(this.pidFile(), 'utf8'));
      fs.rmSync(this.pidFile());
    } catch {
      return false;
    }
    const tmps = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
    if (typeof rec.run === 'string' && tmps.includes(path.dirname(rec.run)) && path.basename(rec.run).startsWith('hoprig-vscode-')) {
      fs.rmSync(rec.run, { recursive: true, force: true });
    }
    const pgid = Number(rec.pid);
    if (this.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 1 || typeof rec.marker !== 'string') return false;
    let list = '';
    try {
      list = execFileSync('ps', ['-A', '-o', 'pgid=', '-o', 'args='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return false;
    }
    const ours = list.split('\n').some((l) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      return m && Number(m[1]) === pgid && m[2].includes(rec.marker);
    });
    if (ours) killTree(pgid, 'SIGTERM', this.platform);
    return ours;
  }
}
