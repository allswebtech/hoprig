// The built-in session backend (see ./index.mjs for the interface): the dashboard server holds the terminals
// itself, through node-pty (ConPTY on Windows). It needs nothing installed, so it is what macOS without tmux and
// Windows use.
//
// The limitation, plainly: these terminals live inside the server process. When the server stops (or restarts,
// or crashes) every session in it ends, Claude included. Claude writes its conversation as it goes, so a session
// can be resumed afterwards, but the running program is gone. tmux does not have this limit: use it where it exists.
//
// Each terminal keeps its screen and scrollback in a headless xterm.js (the same emulator the browser runs), so a
// browser that attaches later, or a second one, first gets the exact current screen, then live output.
//
// How a command starts, per OS:
//   macOS, Linux  the user's login shell ($SHELL -l) in the folder, and the command line typed into it, as the tmux
//                 backend does (only the launcher's own command and its launch file: ./shell.mjs). The login shell gives the user's normal PATH (nvm, ~/.local/bin); when Claude exits, the
//                 shell is still there, so the terminal stays and shows what happened.
//   Windows       never a shell string: the command's argv goes to ConPTY as it is (node-pty quotes it into the
//                 one command line Windows has). PATH needs no login shell there: every program of the user's
//                 logon inherits it. When the command exits, the terminal does not close: it says so and starts
//                 PowerShell in the same folder, so the user can read the output and type.
// respawn() stops everything that runs in the terminal and starts the new command in the same terminal: the name,
// the id (and so HOPRIG_TERM_ID) and the attached browsers stay; the old screen and history are cleared.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import { ptySpawn } from './nodepty.mjs';
import { system } from '../../procid.mjs';
import { ensureSpawnHelper } from './pty-helper.mjs';
import { descendants, endAll, STOP_WAIT_MS } from './proctree.mjs';
import { assertTypable, shellLine } from './shell.mjs';
import { FRONT_GONE, assertFront, assertScreen, notInFront } from './front.mjs';

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/;
const RIS = '\x1bc'; // full reset: clears screen, history and modes
const CLIENT_BUFFER_MAX = 2 << 20; // a paused (slow) browser past this gets a fresh screen instead of the backlog
// unref: a pending wait must not keep a stopping server alive
const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref());

/** Key name → bytes. Arrows depend on the application cursor keys mode the program may switch on. */
export function keySequence(key, appCursor = false) {
  const arrows = { Up: 'A', Down: 'B', Right: 'C', Left: 'D' };
  if (arrows[key]) return `\x1b${appCursor ? 'O' : '['}${arrows[key]}`;
  const map = { Enter: '\r', Escape: '\x1b', Tab: '\t', BTab: '\x1b[Z', 'C-c': '\x03' };
  if (map[key]) return map[key];
  throw new Error(`unknown key ${key}`);
}

/**
 * Bytes for sendText. Several lines go as ONE bracketed paste when the program switched bracketed paste on (Claude
 * Code does), so the newlines stay inside the message; otherwise as typed text. Newlines become CR, the Enter key,
 * as tmux's paste does. An end-of-paste marker inside the text would end the paste early, so it is removed.
 */
export function pasteBytes(text, bracketed) {
  const body = String(text).replace(/\x1b\[20[01]~/g, '');
  if (!body.includes('\n')) return body;
  const typed = body.replace(/\r?\n/g, '\r');
  return bracketed ? `\x1b[200~${typed}\x1b[201~` : typed;
}

/** The shell a plain terminal runs, and that a Windows terminal falls back to after its command ends. */
export function defaultShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), args: ['-l'] };
}

/**
 * How to start a terminal: { file, args, cwd, type, then, env? }. `type` is a line typed into the shell once it runs
 * (POSIX), `env` what its words beyond ASCII are named by (shell.mjs); `then` is what starts in the same terminal when
 * the command ends (Windows). Pure, so it can be tested for every OS on any OS.
 */
export function startPlan({ platform = process.platform, dir, argv = null, shell = defaultShell(platform), mark = null }) {
  if (platform === 'win32') {
    if (!argv) return { file: shell.file, args: shell.args, cwd: dir, type: null, then: null };
    // `mark` (marks.mjs) goes when the command exits: the terminal is back at its own shell then. Nothing is typed
    // here, yet the same rule holds: only the launcher's own command and its launch file, never outside text.
    assertTypable(argv, 'win32');
    return { file: argv[0], args: argv.slice(1), cwd: dir, type: null, then: shell, ...(mark ? { mark } : {}) };
  }
  const start = argv ? shellLine(argv, { mark }) : { line: null, env: {} };
  return { file: shell.file, args: shell.args, cwd: dir, type: start.line, then: null, ...(Object.keys(start.env).length ? { env: start.env } : {}) };
}

/** The environment of a terminal's process. `name`: the session's name, for a launcher that has to say where it runs. */
export function termEnv(id, platform = process.platform, base = process.env, name = null) {
  const env = { ...base, TERM: 'xterm-256color', COLORTERM: 'truecolor', HOPRIG_TERM_ID: id };
  if (name) env.HOPRIG_TERM_NAME = name;
  else delete env.HOPRIG_TERM_NAME;
  // The dashboard may itself run inside tmux; a run must not record the dashboard's own pane as its terminal.
  delete env.TMUX;
  delete env.TMUX_PANE;
  // A service starts without a locale; programs would then treat the terminal as ASCII-only.
  if (platform !== 'win32' && !env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LC_CTYPE = platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';
  return env;
}

/** Plain text of the last `lines` lines of a headless terminal's active buffer; wrapped rows are joined (tmux -J). */
export function bufferText(term, lines) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.slice(-lines).join('\n') + '\n';
}

export class PtyBackend {
  /**
   * @param {object} o
   * @param {{file: string, args: string[]}} [o.shell]  the shell (default: login shell; PowerShell on Windows)
   * @param {number} [o.scrollback]   lines of history kept per terminal
   * @param {string} [o.platform]     for tests
   * @param {Function} [o.spawn]      node-pty's spawn, replaceable in tests
   * @param {Function} [o.descendants] pid → its descendants' pids; with a test spawn, none (its pids are not real)
   * @param {object} [o.ident]        who a process is beyond its pid (procid.mjs), replaceable in tests
   */
  constructor({ shell, scrollback = 5000, platform = process.platform, spawn = ptySpawn, descendants: below, ident = system } = {}) {
    this.platform = platform;
    this.shell = shell || defaultShell(platform);
    this.scrollback = scrollback;
    this.spawn = spawn;
    this.descendants = below || (spawn === ptySpawn ? descendants : async () => []);
    this.ident = ident;
    if (spawn === ptySpawn) ensureSpawnHelper();
    this.terms = new Map(); // session name → terminal
    this.kind = 'pty';
    // The browser keeps its own scrollback with this backend (the screen it gets is a plain terminal stream), so
    // the page needs no server-side history view; `scroll` is a no-op here.
    this.capabilities = { nativeScrollback: true, persistent: false };
    this.onProcessExit = () => this.#killAllNow();
    process.on('exit', this.onProcessExit);
  }

  validName(name) {
    return typeof name === 'string' && NAME_RE.test(name);
  }

  #byId(id) {
    for (const t of this.terms.values()) if (t.id === id) return t;
    throw new Error(`no terminal ${id}`);
  }

  #byName(name) {
    const t = this.terms.get(name);
    if (!t) throw new Error(`no session ${name}`);
    return t;
  }

  async list() {
    return [...this.terms.values()].map((t) => ({
      session: t.name,
      id: t.id,
      sid: t.id, // the terminal's own id: a rename keeps it
      pid: t.proc ? t.proc.pid : 0,
      cwd: t.dir,
      command: t.proc ? this.#processName(t) : '',
      created: t.created,
      attached: t.clients.size,
      activity: t.activity,
      active: true,
      dead: !t.proc,
      cols: t.cols,
      rows: t.rows,
    }));
  }

  #processName(t) {
    try {
      return path.basename(String(t.proc.process || '')).replace(/\.exe$/i, '');
    } catch {
      return '';
    }
  }

  async create({ name, dir, argv = null, cols = 80, rows = 24, mark = null }) {
    if (!this.validName(name)) throw new Error('bad session name');
    if (this.terms.has(name)) throw new Error(`duplicate session: ${name}`);
    const id = `pty-${crypto.randomBytes(6).toString('hex')}`;
    const vt = new headless.Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    vt.loadAddon(ser);
    vt.loadAddon(new unicode11.Unicode11Addon());
    vt.unicode.activeVersion = '11'; // measure emoji and wide characters as the browser does
    const t = { name, id, dir, cols, rows, vt, ser, sgrMouse: false, proc: null, clients: new Set(), waiters: new Set(), disposed: false, created: Date.now(), activity: Date.now(), closing: false };
    // The snapshot a browser gets on attach has the mouse modes but not their encoding: a program that asked for SGR
    // reports (Claude Code's full-screen view) would get the old encoding after a reload and misread every wheel turn.
    const sgr = (on) => (params) => {
      if (params.includes(1006)) t.sgrMouse = on;
      return false; // the terminal's own handler runs too
    };
    vt.parser.registerCsiHandler({ prefix: '?', final: 'h' }, sgr(true));
    vt.parser.registerCsiHandler({ prefix: '?', final: 'l' }, sgr(false));
    vt.parser.registerEscHandler({ final: 'c' }, () => {
      t.sgrMouse = false;
      return false;
    });
    // Programs ask the terminal questions (cursor position, device attributes) and may wait for the answer. With a
    // browser attached the browser's terminal answers; with none, the headless one does, as tmux would.
    vt.onData((reply) => {
      if (!t.clients.size && t.proc) t.proc.write(reply);
    });
    this.terms.set(name, t);
    try {
      this.#start(t, startPlan({ platform: this.platform, dir, argv, shell: this.shell, mark }));
    } catch (e) {
      this.terms.delete(name);
      vt.dispose();
      throw e;
    }
    return { name, id };
  }

  #start(t, plan) {
    let proc;
    try {
      proc = this.spawn(plan.file, plan.args, {
        name: 'xterm-256color', cols: t.cols, rows: t.rows, cwd: plan.cwd, env: { ...termEnv(t.id, this.platform, process.env, t.name), ...plan.env },
      });
    } catch (e) {
      if (plan.mark) fs.rmSync(plan.mark, { force: true }); // nothing started
      throw e;
    }
    t.proc = proc;
    t.dir = plan.cwd;
    proc.onData((data) => {
      if (t.proc === proc) this.#output(t, data);
    });
    proc.onExit(({ exitCode }) => {
      if (plan.mark) fs.rmSync(plan.mark, { force: true });
      if (t.proc !== proc) return; // replaced by respawn or being killed: that code path handles it
      t.proc = null;
      if (plan.then && !t.closing) {
        const what = path.basename(plan.file);
        this.#output(t, `\r\n\x1b[2m[${what} exited with code ${exitCode}. This terminal is now ${plan.then.file}; close it with "exit".]\x1b[0m\r\n`);
        try {
          return this.#start(t, { file: plan.then.file, args: plan.then.args, cwd: plan.cwd, type: null, then: null });
        } catch {
          /* fall through: the terminal ends */
        }
      }
      this.#remove(t);
    });
    if (plan.type) proc.write(`${plan.type}\r`);
  }

  #output(t, data) {
    if (t.disposed) return;
    t.activity = Date.now();
    t.vt.write(data);
    for (const c of t.clients) c.push(data);
  }

  /**
   * Resolves once the headless terminal has taken in everything written so far, or at once when the terminal is
   * gone (a disposed terminal never calls back; a request waiting on it must not hang).
   */
  #settled(t) {
    if (t.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      t.waiters.add(resolve);
      t.vt.write('', () => {
        t.waiters.delete(resolve);
        resolve();
      });
    });
  }

  #remove(t) {
    if (this.terms.get(t.name) === t) this.terms.delete(t.name);
    for (const c of [...t.clients]) c.end();
    t.clients.clear();
    if (t.disposed) return;
    t.disposed = true;
    for (const w of t.waiters) w();
    t.waiters.clear();
    t.vt.dispose();
  }

  /**
   * Stop the terminal's process and everything it started; resolves when it is gone. `hold`: the pid that holds the
   * conversation (proctree.mjs endAll), waited for longer.
   */
  async #stop(t, hold = null) {
    const proc = t.proc;
    if (!proc) return;
    t.proc = null; // from here on its output and exit belong to nobody
    const exited = new Promise((resolve) => proc.onExit(resolve));
    if (this.platform === 'win32') {
      // node-pty ends every process attached to the ConPTY console.
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      await Promise.race([exited, wait(STOP_WAIT_MS)]);
      return;
    }
    // What runs under the shell ends first, while its terminal is still open: SIGHUP, as when a terminal window closes
    // (Claude saves and exits), and a wait until it has ended. With the shell ended first, the terminal closed under
    // the programs: they ended only after the new command of a respawn had started (a launcher still ending held its
    // conversation, and the new one refused it), and a Node 20 program aborts on a terminal that is gone.
    const rest = await endAll(await this.descendants(proc.pid), { ident: this.ident, platform: this.platform, hold });
    try {
      proc.kill('SIGHUP');
    } catch {
      /* already gone */
    }
    const done = await Promise.race([exited.then(() => true), wait(STOP_WAIT_MS).then(() => false)]);
    if (!done) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rest(done ? 'SIGTERM' : 'SIGKILL'); // what ignores SIGHUP (nohup) does not outlive its terminal
  }

  attach(name, { cols = 80, rows = 24 } = {}) {
    const t = this.#byName(name);
    let dataFn = null;
    let exitFn = null;
    let ended = false;
    let ready = false; // false until the client has its snapshot; output meanwhile waits in `pending`
    let pending = [];
    let paused = false;
    let held = []; // output kept while the browser is paused
    let heldBytes = 0;
    let stale = false; // the browser fell too far behind: it gets a fresh screen on resume
    let early = []; // output produced before the caller registered onData

    const emit = (d) => (dataFn ? dataFn(d) : early.push(d));
    const deliver = (d) => {
      if (!paused) return emit(d);
      if (stale) return;
      held.push(d);
      heldBytes += d.length;
      if (heldBytes > CLIENT_BUFFER_MAX) {
        stale = true;
        held = [];
        heldBytes = 0;
      }
    };
    const sync = () => {
      ready = false;
      pending = [];
      this.#settled(t).then(() => {
        if (ended) return;
        deliver(t.ser.serialize({ scrollback: this.scrollback }) + (t.sgrMouse ? '\x1b[?1006h' : '')); // also before tracking is on
        for (const d of pending) deliver(d);
        pending = [];
        ready = true;
      });
    };
    const client = {
      push: (d) => (ready ? deliver(d) : pending.push(d)),
      end: () => {
        if (ended) return;
        ended = true;
        if (exitFn) exitFn({ exitCode: 0 });
      },
    };
    t.clients.add(client);
    this.#resize(t, cols, rows); // the newest browser decides the size, as tmux's "latest" window size does
    sync();

    return {
      onData: (fn) => {
        dataFn = fn;
        for (const d of early) fn(d);
        early = [];
      },
      onExit: (fn) => {
        exitFn = fn;
        if (ended) fn({ exitCode: 0 });
      },
      write: (s) => {
        if (t.proc && !ended) t.proc.write(s);
      },
      resize: (c, r) => this.#resize(t, c, r),
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
        if (stale) {
          stale = false;
          emit(RIS);
          sync();
          return;
        }
        const out = held;
        held = [];
        heldBytes = 0;
        for (const d of out) emit(d);
      },
      close: () => {
        ended = true;
        t.clients.delete(client);
      },
    };
  }

  #resize(t, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
    if (t.cols === cols && t.rows === rows) return;
    t.cols = cols;
    t.rows = rows;
    t.vt.resize(cols, rows);
    try {
      if (t.proc) t.proc.resize(cols, rows);
    } catch {
      /* exited meanwhile */
    }
  }

  /**
   * `front` (src/server/typing.mjs): type only while that program holds the terminal in front, checked in the same step
   * as the write (nothing runs in between). POSIX: the process group the terminal's device hands typed bytes to, read
   * from the system for this terminal's own child (its shell). Windows has no such group: there the terminal knows
   * its own child only, which is the launcher until it ends (then PowerShell), so `front.pid` must still be that child.
   */
  #assertFront(t, front) {
    if (!front) return;
    if (!t.proc) throw notInFront(FRONT_GONE);
    if (this.platform === 'win32') {
      if (Number.isInteger(front.pid) && t.proc.pid !== front.pid) throw notInFront(FRONT_GONE);
      return;
    }
    assertFront(t.proc.pid, front, { platform: this.platform });
  }

  async sendText(id, text, { front = null, when = null } = {}) {
    const t = this.#byId(id);
    await this.#settled(t); // the bracketed paste mode is known only once all output so far is parsed
    this.#assertFront(t, front);
    this.#screenIs(t, when);
    if (t.proc) t.proc.write(pasteBytes(text, t.vt.modes.bracketedPasteMode));
  }

  async sendKey(id, key, { front = null, when = null } = {}) {
    const t = this.#byId(id);
    await this.#settled(t);
    const seq = keySequence(key, t.vt.modes.applicationCursorKeysMode);
    this.#assertFront(t, front);
    this.#screenIs(t, when);
    if (t.proc) t.proc.write(seq);
  }

  // The screen check (index.mjs: `when`) on all output parsed so far, in the same step as the write that follows it:
  // only bytes the program has sent and the terminal not yet read can be missed.
  #screenIs(t, when) {
    if (when) assertScreen(when, bufferText(t.vt, Math.max(1, when.lines | 0 || 40)));
  }

  async capture(id, lines = 40) {
    const t = this.#byId(id);
    await this.#settled(t);
    if (t.disposed) throw new Error(`no terminal ${id}`);
    return bufferText(t.vt, Math.max(1, lines | 0));
  }

  /** The browser scrolls its own history with this backend (capabilities.nativeScrollback), so nothing to do. */
  async scroll(id, action) {
    this.#byId(id);
    if (!['up', 'down', 'exit'].includes(action)) throw new Error(`unknown scroll action ${action}`);
  }

  async respawn(id, dir, argv, { mark = null, hold = null } = {}) {
    const t = this.#byId(id);
    const plan = startPlan({ platform: this.platform, dir, argv, shell: this.shell, mark }); // refused before the stop
    await this.#stop(t, hold); // the old programs end first (and `hold` is given longer), then the new line starts
    // The old program's lines (a usage-limit message among them) would otherwise stay in the history and keep the
    // card in "limit hit". The conversation itself is in Claude's transcript, which --resume shows again. The
    // reset goes to the browsers too, so their screens match.
    this.#output(t, RIS);
    this.#start(t, plan);
  }

  async rename(name, next) {
    const t = this.#byName(name);
    if (!this.validName(next)) throw new Error('bad session name');
    if (next === name) return;
    if (this.terms.has(next)) throw new Error(`duplicate session: ${next}`);
    this.terms.delete(name);
    t.name = next;
    this.terms.set(next, t);
  }

  async kill(name, { hold = null } = {}) {
    const t = this.#byName(name);
    t.closing = true;
    await this.#stop(t, hold); // `hold`, the pid that holds the conversation, is given longer, as in a respawn
    this.#remove(t);
  }

  /** End every session (the server is stopping). */
  async close() {
    process.off('exit', this.onProcessExit);
    await Promise.all([...this.terms.values()].map((t) => {
      t.closing = true;
      return this.#stop(t).finally(() => this.#remove(t));
    }));
  }

  /** Last resort when the process exits without close(): signals only, nothing to wait for. */
  #killAllNow() {
    for (const t of this.terms.values()) {
      try {
        if (t.proc) t.proc.kill(this.platform === 'win32' ? undefined : 'SIGHUP');
      } catch {
        /* already gone */
      }
    }
  }
}
