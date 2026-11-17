// Session backends: where the terminals that run Claude live. Everything the dashboard does with a terminal
// goes through this interface, so the rest of the server does not care which one runs.
//
//   tmux  (./tmux.mjs)  Linux, macOS, where tmux 3.2 or newer is installed. Sessions outlive the dashboard, and
//                       `tmux attach` over SSH shows the same ones.
//   pty   (./pty.mjs)   built in, any OS (Windows through ConPTY). Sessions live inside the server and end with it.
//
// The interface (all methods async unless noted):
//   list()                         every terminal: [{ session, id, pid, cwd, command, created, attached, activity,
//                                  active, dead }]. `session` is the user-visible name; `id` names one terminal
//                                  (a tmux pane "%3", a pty "pty-…"); `pid` is the process that runs in it.
//   create({ name, dir, argv, mark }) new session in `dir`, running argv (or a plain shell). Returns { name, id }.
//                                  `mark`: a file the terminal removes once it is back at its own shell, argv ended
//                                  or never started (src/server/deck.mjs noteLaunch)
//   attach(name, { cols, rows })   (sync) a live byte stream of the session's screen:
//                                  { onData(fn), onExit(fn), write(str), resize(c, r), pause(), resume(), close() }
//   sendText(id, text, { front })  type text (several lines arrive as one paste, not as several submits)
//   sendKey(id, key, { front })    one key: Enter | Escape | Tab | BTab | C-c | Up | Down | Left | Right
//                                  `front` ({ group, pid }, src/server/typing.mjs): type only while that program is the
//                                  terminal's foreground program, checked right before the bytes go (./front.mjs);
//                                  else nothing is typed and a 409 error says so. Without it: as the owner types
//   capture(id, lines)             the last `lines` lines of history and screen, as plain text
//   scroll(id, action, n)          history view: action "up" | "down" (n lines) | "exit" (back to live)
//   respawn(id, dir, argv, { mark }) stop what runs in the terminal and start argv there, same name and id
//   rename(name, next), kill(name)
//   close()                        the server is stopping (tmux: nothing; pty: ends every session)
//   validName(name)                (sync) whether a session name is acceptable to this backend
//   kind                           "tmux" | "pty" | "none" (./none.mjs: a hub, or no terminal available here)
//   capabilities                   { nativeScrollback, persistent }: nativeScrollback = the browser terminal should
//                                  keep its own scrollback (scroll() does nothing); persistent = sessions survive
//                                  a restart of the server
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../config.mjs';
import { NoBackend } from './none.mjs';
import { tmuxNewEnough } from './tmuxversion.mjs';

// A hub (config "hubOnly": true, or HOPRIG_HUB=1) only shows and relays other computers: it never has a terminal,
// so it never loads the terminal module either (about 15 MB less on a small server).
export function hubMode(env = process.env) {
  if (env.HOPRIG_HUB === '1') return true;
  try {
    return loadConfig().hubOnly === true;
  } catch {
    return false;
  }
}
const HUB = hubMode();

// node-pty is an optional dependency (it needs build tools on Linux): without it the dashboard still starts.
// ./nodepty.mjs loads it once for everyone and says why when it cannot.
let ptyModule = null;
let ptyError = '';
if (!HUB) {
  const { nodePty, nodePtyError } = await import('./nodepty.mjs');
  if (nodePty) ptyModule = await import('./pty.mjs');
  else ptyError = nodePtyError;
}
const PtyBackend = ptyModule ? ptyModule.PtyBackend : null;
// The tmux backend attaches through node-pty too; a hub never needs it either.
const TmuxBackend = HUB ? null : (await import('./tmux.mjs')).TmuxBackend;

/**
 * Whether tmux can be run here and is new enough (./tmuxversion.mjs); with an older one "auto" takes the built-in
 * terminals. Called once at start-up, so a synchronous probe is fine.
 */
export function tmuxUsable(bin = 'tmux', platform = process.platform) {
  if (platform === 'win32') return false;
  try {
    return tmuxNewEnough(execFileSync(bin, ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
  } catch {
    return false;
  }
}

/**
 * kind: "auto" (tmux when it is installed and usable, else pty) | "tmux" | "pty". Options go to the backend:
 * tmux takes { socket, configFile, bin }, pty { shell, scrollback }.
 */
export function createBackend({ kind = 'auto', ...opts } = {}) {
  const auto = kind === 'auto' || kind === undefined || kind === null || kind === '';
  if (kind === 'none' || (auto && HUB)) return new NoBackend({ reason: 'hub' });
  if (auto) kind = tmuxUsable(opts.bin) ? 'tmux' : PtyBackend ? 'pty' : 'missing';
  if (kind === 'missing') return new NoBackend({ reason: 'missing', detail: ptyError });
  if (kind === 'tmux') {
    if (process.platform === 'win32') throw new Error('the tmux session backend does not run on Windows; use "pty" or "auto"');
    if (!TmuxBackend) throw new Error('this dashboard runs as a hub: it has no terminals of its own');
    return new TmuxBackend(opts);
  }
  if (kind === 'pty') {
    if (!PtyBackend) throw new Error(`the built-in terminal is not available here: ${ptyError || 'this dashboard runs as a hub'}`);
    return new PtyBackend(opts);
  }
  throw new Error(`unknown session backend "${kind}" (use "auto", "tmux", "pty" or "none")`);
}

export { shellLine, shellQuote } from './shell.mjs';
