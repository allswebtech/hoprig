// The tmux session backend (see ./index.mjs for the interface). Every tmux call is an argument array run with
// execFile, never a shell string. By default it uses the user's normal tmux server, so `tmux attach` over SSH
// shows the same sessions; a socket name (tmux -L) keeps it separate, which the tests rely on.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { ptySpawn } from './nodepty.mjs';
import { ensureSpawnHelper } from './pty-helper.mjs';
import { shellLine } from './shell.mjs';
import { assertFront, notInFront, FRONT_GONE } from './front.mjs';
import { stateDir } from '../../paths.mjs';

const FIELDS = [
  'session_name', 'session_created', 'session_attached', 'session_activity', 'window_activity',
  'window_active', 'pane_active', 'pane_id', 'pane_pid', 'pane_dead', 'pane_current_command', 'pane_current_path',
];
export const PANE_FORMAT = FIELDS.map((f) => `#{${f}}`).join('\t');

/** Parse `list-panes -a -F PANE_FORMAT`. The path is last so a tab inside it cannot shift the other fields. */
export function parsePanes(out) {
  const panes = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < FIELDS.length) continue;
    const r = Object.fromEntries(FIELDS.slice(0, -1).map((f, i) => [f, parts[i]]));
    r.pane_current_path = parts.slice(FIELDS.length - 1).join('\t');
    panes.push({
      session: r.session_name,
      id: r.pane_id,
      pid: Number(r.pane_pid),
      cwd: r.pane_current_path,
      command: r.pane_current_command,
      created: Number(r.session_created) * 1000,
      attached: Number(r.session_attached) || 0,
      // The last input (session_activity) or output (window_activity: tmux moves only this one when the program
      // prints), like the built-in terminals' own clock. A screen-only status ("Live status: basic") reads it.
      activity: Math.max(Number(r.session_activity) || 0, Number(r.window_activity) || 0) * 1000,
      active: r.window_active === '1' && r.pane_active === '1',
      dead: r.pane_dead === '1',
    });
  }
  return panes;
}

const NO_SERVER = /no server running|error connecting to|server exited unexpectedly/i;
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'C-c', 'Up', 'Down', 'Left', 'Right']);
// tmux turns "." and ":" in session names into "_", so names it accepts as-is avoid them. No leading "-": a
// name must never look like an option.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/;
// Programs started in our sessions may use 24-bit colour: tmux passes it on to clients that support it. A pane takes
// its environment from the tmux server, which may have been started long ago with another state folder: the launcher
// in it must find its launch file and write its run record in the dashboard's own (src/launchfile.mjs).
const paneEnv = () => ['-e', 'COLORTERM=truecolor', '-e', `HOPRIG_STATE_DIR=${stateDir()}`];

/**
 * A folder as tmux's -c takes it. tmux reads that argument as a format, and "#(…)" in a format runs a command through
 * /bin/sh: a folder named "x#(touch y)" would run it. "##" is a plain "#" in a format, so a run of "#" is doubled and
 * the name stays a name. A run of "#" right before "[" is a style, which tmux copies through as it is: doubled, it would
 * stay doubled and name another folder (tmux then starts in the home folder without a word), so that run is left as
 * it is. Checked on tmux 3.6 with 300 random names of "#", "[", "]", "(", ")", "{", "}" and "touch": each pane started
 * in its own folder and nothing ran. The -e values are not formats.
 */
export const tmuxDir = (dir) => String(dir).replace(/(#+)(\[?)/g, (run, hashes, style) => (style ? run : hashes + hashes));

export class TmuxBackend {
  /**
   * @param {object} o
   * @param {string} [o.socket]      tmux -L name; empty = the user's default server
   * @param {string} [o.configFile]  tmux -f file (tests use an empty file so the user's tmux.conf does not apply)
   * @param {string} [o.bin]         tmux executable
   */
  constructor({ socket = '', configFile = '', bin = 'tmux' } = {}) {
    this.bin = bin;
    // -u on every call: this client speaks UTF-8 even when the dashboard runs without a UTF-8 locale (a service, a
    // container, a CI step). Without it tmux turns every tab and non-ASCII character it prints into "_": list()
    // then finds no session at all (its fields are split on tabs), and a folder named "café" reads "caf_".
    this.base = ['-u', ...(socket ? ['-L', socket] : []), ...(configFile ? ['-f', configFile] : [])];
    this.kind = 'tmux';
    // tmux owns the screen and its history (the page scrolls it through scroll()), and its sessions outlive us.
    this.capabilities = { nativeScrollback: false, persistent: true };
  }

  /** The server is stopping: tmux sessions keep running on their own, by design. */
  async close() {}

  /**
   * The pid of the tmux server that holds the sessions (null when none runs). It is not a parent of this dashboard,
   * yet ending it ends every session: the desktop's Task manager guards it (src/desktop/procs.mjs).
   */
  async serverPid() {
    try {
      const n = Number(String(await this.run(['display-message', '-p', '#{pid}'])).trim());
      return Number.isInteger(n) && n > 1 ? n : null;
    } catch {
      return null;
    }
  }

  validName(name) {
    return typeof name === 'string' && NAME_RE.test(name);
  }

  /** Full argv of one tmux call. */
  argv(...args) {
    return [...this.base, ...args];
  }

  #env() {
    const env = { ...process.env };
    delete env.TMUX; // the dashboard may itself run inside tmux; tmux refuses a nested attach otherwise
    return env;
  }

  run(args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, this.argv(...args), { env: this.#env(), timeout: 10_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr || err.message).trim());
          e.noServer = NO_SERVER.test(stderr || '');
          return reject(e);
        }
        resolve(stdout);
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  async list() {
    try {
      return parsePanes(await this.run(['list-panes', '-a', '-F', PANE_FORMAT]));
    } catch (e) {
      if (e.noServer) return [];
      throw e;
    }
  }

  async create({ name, dir, argv = null, mark = null }) {
    const line = argv ? shellLine(argv, { mark }) : null; // refused (plainly) before anything is made
    const id = (await this.run(['new-session', '-d', '-s', name, '-c', tmuxDir(dir), ...paneEnv(), '-P', '-F', '#{pane_id}'])).trim();
    if (line) await this.#type(id, line);
    // In the browser tmux's own status line is noise (the page shows the session's name and state), and Claude
    // Code asks for focus events to know when its window is looked at. Neither may stop a session from starting.
    // The target is the pane id: set-option does not take the "=name" exact-match form other commands do.
    await this.run(['set-option', '-t', id, 'status', 'off']).catch(() => {});
    await this.run(['set-option', '-s', 'focus-events', 'on']).catch(() => {});
    return { name, id };
  }

  async #type(id, line) {
    await this.run(['send-keys', '-t', id, '-l', '--', line]);
    await this.run(['send-keys', '-t', id, 'Enter']);
  }

  /** Leave copy mode (the history view) if the pane is in it, so typed text reaches the program, not tmux. */
  #live(id) {
    return this.run(['copy-mode', '-q', '-t', id]).catch(() => {});
  }

  /**
   * `front` (src/server/typing.mjs): type only while that process group holds the pane in front. tmux is asked for the
   * pane's first process at this moment, and the system for the group its terminal hands typed bytes to (what tmux
   * itself reads for #{pane_current_command}); the keys follow at once. A pane that is dead, or another program in
   * front, gets nothing.
   */
  async #inFront(id, front) {
    if (!front) return;
    const out = await this.run(['display-message', '-p', '-t', id, '#{pane_dead} #{pane_pid}']).catch(() => '');
    const [dead, pid] = String(out).trim().split(' ');
    if (dead !== '0') throw notInFront(FRONT_GONE);
    assertFront(Number(pid), front);
  }

  /**
   * One line goes in as typed keys (-l: literally, so "Enter" stays a word). Several lines go in as a bracketed
   * paste (-p) when the program asked for it, which Claude Code does, so the newlines stay inside the message.
   * The paste buffer is loaded through stdin: no argument size limit, and the text never shows up in `ps`.
   */
  async sendText(id, text, { front = null } = {}) {
    await this.#live(id);
    if (!text.includes('\n')) {
      await this.#inFront(id, front);
      return void (await this.run(['send-keys', '-t', id, '-l', '--', text]));
    }
    const buf = `paste-${crypto.randomBytes(6).toString('hex')}`;
    await this.run(['load-buffer', '-b', buf, '-'], { input: text });
    try {
      await this.#inFront(id, front);
    } catch (e) {
      await this.run(['delete-buffer', '-b', buf]).catch(() => {});
      throw e;
    }
    await this.run(['paste-buffer', '-p', '-d', '-b', buf, '-t', id]);
  }

  async sendKey(id, key, { front = null } = {}) {
    if (!KEYS.has(key)) throw new Error(`unknown key ${key}`);
    if (key !== 'Escape') await this.#live(id);
    await this.#inFront(id, front);
    await this.run(['send-keys', '-t', id, key]);
  }

  capture(id, lines = 40) {
    return this.run(['capture-pane', '-p', '-J', '-t', id, '-S', `-${lines}`]);
  }

  /**
   * The history view. tmux owns the screen, so the browser terminal has no scrollback of its own; scrolling puts
   * the pane in copy mode and moves it there. -e leaves copy mode once scrolled back to the bottom. Done through
   * commands rather than tmux mouse mode so the user's own `tmux attach` behaves exactly as before.
   */
  async scroll(id, action, n = 3) {
    if (action === 'exit') return this.#live(id);
    const count = String(Math.max(1, Math.min(500, n | 0)));
    if (action === 'up') {
      await this.run(['copy-mode', '-e', '-t', id]);
      return this.run(['send-keys', '-t', id, '-X', '-N', count, 'scroll-up']);
    }
    if (action === 'down') {
      return this.run(['send-keys', '-t', id, '-X', '-N', count, 'scroll-down']).catch(() => {}); // not in copy mode: nothing to do
    }
    throw new Error(`unknown scroll action ${action}`);
  }

  async respawn(id, dir, argv, { mark = null } = {}) {
    const line = shellLine(argv, { mark }); // refused (plainly) before what runs there is stopped
    await this.run(['respawn-pane', '-k', '-t', id, '-c', tmuxDir(dir), ...paneEnv()]);
    // The old program's lines (a usage-limit message among them) would otherwise stay in the history and keep
    // the card in "limit hit". The conversation itself is in Claude's transcript, which --resume shows again.
    await this.run(['clear-history', '-t', id]);
    await this.#type(id, line);
  }

  /** "=" makes tmux match the session name exactly instead of by prefix. */
  rename(name, next) {
    return this.run(['rename-session', '-t', `=${name}`, next]);
  }

  kill(name) {
    return this.run(['kill-session', '-t', `=${name}`]);
  }

  /**
   * argv of the attach client. -T RGB: the browser terminal shows 24-bit colour, so tmux must not reduce colours
   * to 256. tmux 3.3a and 3.4 (Debian 12, Ubuntu 24.04) do not take that from COLORTERM, as 3.6 does; every
   * tmux since 3.2 takes it from -T.
   */
  attachArgv(name) {
    return this.argv('-T', 'RGB', 'attach-session', '-t', `=${name}`);
  }

  /** The session as a byte stream: `tmux attach` inside a pseudo-terminal of the requested size. */
  attach(name, { cols = 80, rows = 24 } = {}) {
    const env = { ...this.#env(), TERM: 'xterm-256color' };
    ensureSpawnHelper();
    const term = ptySpawn(this.bin, this.attachArgv(name), { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env });
    return {
      onData: (fn) => term.onData(fn),
      onExit: (fn) => term.onExit(fn),
      write: (s) => term.write(s),
      resize: (c, r) => term.resize(c, r),
      pause: () => term.pause(),
      resume: () => term.resume(),
      close: () => {
        try {
          term.kill(); // ends only this attach client; the session keeps running
        } catch {
          /* already gone */
        }
      },
    };
  }

  killServer() {
    return this.run(['kill-server']).catch(() => {});
  }
}
