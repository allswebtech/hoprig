// Who Hoprig runs as here, in facts: root or not, inside a container (by facts that are named), the owner's choice to
// stay root, and whether a user of this computer is the work user Hoprig made. Nothing is changed: files are looked
// at, and only `getent` is started (to read one user). The doctor's and Health's line on root is built from these.
import fs from 'node:fs';
import { stateDir } from '../paths.mjs';
import { isLive, readMark } from './movemark.mjs';
import { capture } from './system.mjs';

/** The files that say "inside a container", each looked at as a file only (no program is asked). */
export const CONTAINER_FILES = ['/.dockerenv', '/run/.containerenv', '/run/systemd/container'];

/** The comment field of the user Hoprig makes for the work (install.sh): said, not trusted (see madeByHoprig). */
export const WORK_USER_MARK = 'Hoprig work user';

/** The settings key of the owner's choice to keep Hoprig on root (the typed sentence, or --stay-root). */
export const STAY_ROOT_KEY = 'stayRoot';

/** Claude Code's own words when it refuses the mode that asks nothing as root (seen on 2.1.329). */
export const CLAUDE_ROOT_REFUSAL = '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons';

/**
 * The container facts found, each named as it was found: a file's path, or `container=<value>` for the variable that
 * systemd and podman set. [] when none. `exists` and `env` are handed in by tests.
 */
export function containerFacts({ exists = fs.existsSync, env = process.env } = {}) {
  const found = CONTAINER_FILES.filter((f) => {
    try {
      return exists(f);
    } catch {
      return false;
    }
  });
  const v = typeof env.container === 'string' ? env.container.trim() : '';
  if (v) found.push(`container=${v.replace(/[^\w.-]/g, '').slice(0, 40)}`);
  return found;
}

/**
 * { root, container: [facts], stay }: `root` is user id 0 on Linux or macOS (never on Windows); `stay` is the owner's
 * choice in the settings to keep Hoprig on root.
 */
export function rootFacts({ uid = typeof process.getuid === 'function' ? process.getuid() : null, platform = process.platform, exists, env, cfg = {}, mark = () => readMark(stateDir()) } = {}) {
  const root = platform !== 'win32' && uid === 0;
  // A move that switched (and was not stepped back from): Hoprig runs as that user now, root's is the kept copy.
  let moved = null;
  if (root) {
    const m = mark();
    if (isLive(m)) moved = { user: m.user, since: String(m.switchedAt || m.switchingAt || m.at || '').slice(0, 16) };
  }
  return { root, container: containerFacts({ exists, env }), stay: !!cfg && cfg[STAY_ROOT_KEY] === true, moved };
}

/** One line of `getent passwd` → { name, uid, gid, comment, home, shell }, or null when it is not one. */
export function passwdEntry(line) {
  const f = String(line || '').replace(/\r?\n$/, '').split(':');
  if (f.length !== 7 || !f[0] || !/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) return null;
  return { name: f[0], uid: Number(f[2]), gid: Number(f[3]), comment: f[4], home: f[5], shell: f[6] };
}

/**
 * The mark of a user Hoprig made: a file of this name in the user's home, owned by ROOT, with one name, holding the one
 * line markText(name). install.sh writes it with `install -o root` right after useradd. The user owns his home, so he
 * can write a file of this name (his own: refused) or rename a file of root's that lies there into it (another text:
 * refused); only Hoprig writes a file of root's with this text. A user without the mark is never taken over.
 */
export const MOVE_MARK_FILE = '.hoprig-made-by-move';

/** The mark's one line for the user `name` (install.sh writes the same). */
export const markText = (name) => `${WORK_USER_MARK} ${name}\n`;

/**
 * True when `entry` (passwdEntry) is a user Hoprig made: the mark in its home (see MOVE_MARK_FILE). The comment field
 * (WORK_USER_MARK) is written too, but never trusted: where chfn lets users change their full name, anyone could write
 * it. `lstat` and `readFile` are handed in by tests.
 */
export function madeByHoprig(entry, { lstat = fs.lstatSync, readFile = fs.readFileSync } = {}) {
  if (!entry || !entry.home || !entry.home.startsWith('/')) return false;
  const file = `${entry.home.replace(/\/+$/, '')}/${MOVE_MARK_FILE}`;
  try {
    const st = lstat(file);
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || st.size > 200) return false;
    return String(readFile(file, 'utf8')) === markText(entry.name);
  } catch {
    return false;
  }
}

/** The names a user may have here (the rule of useradd's default NAME_REGEX). */
export const USER_NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** The user `name` of this computer (`getent passwd <name>`) → passwdEntry, or null when there is none. */
export async function lookUser(name, { run = capture } = {}) {
  if (!USER_NAME_RE.test(String(name || ''))) throw new Error(`"${name}" is not a user name (small letters, digits, - and _, at most 32)`);
  const r = await run(['getent', 'passwd', name], { timeout: 10_000 });
  if (!r.ok) return null; // exit 2: no such user
  const entry = passwdEntry(r.stdout.split('\n')[0]);
  return entry && entry.name === name ? entry : null;
}

/** The work user's default name, and the names offered after it when a user of that name is someone else's. */
export const WORK_USER_NAMES = ['hoprig', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `hoprig${n}`)];

/**
 * The work user Hoprig made on this computer (passwdEntry), or null: the first of WORK_USER_NAMES that carries a mark.
 * A name that is free ends the look (a later name is only ever made after the ones before it were taken).
 */
export async function findWorkUser({ run = capture, lstat, readFile } = {}) {
  for (const name of WORK_USER_NAMES) {
    const e = await lookUser(name, { run });
    if (!e) return null;
    if (madeByHoprig(e, { ...(lstat ? { lstat } : {}), ...(readFile ? { readFile } : {}) })) return e;
  }
  return null;
}

/** The facts as words: "inside a container (/.dockerenv)", "kept on root by your choice", or ''. */
function onPurpose(f) {
  if (f.container.length) return `inside a container (${f.container.join(', ')})`;
  return f.stay ? 'kept on root by your choice' : '';
}

/**
 * The doctor's and Health's one line about root, or null when Hoprig does not run as root. On purpose (a container,
 * or his choice): information, saying what does not work as root. Otherwise a suggestion with the one step: move
 * Hoprig to an ordinary user.
 */
/** What does not work as root, as seen with the real Claude Code: the one line doctor, Health and the page say. */
export const ROOT_LIMITS = `Claude Code refuses bypass permissions mode for root ("${CLAUDE_ROOT_REFUSAL}"); the modes that ask still start`;

export function rootCheck(f) {
  if (!f || !f.root) return null;
  const refused = ROOT_LIMITS;
  if (f.moved) return { id: 'root', label: 'Runs as root', status: 'info', detail: `moved to ${f.moved.user}${f.moved.since ? ` since ${f.moved.since}Z` : ''}: Hoprig works as ${f.moved.user} now, and this is root's kept copy. Back to root's: hoprig move-to-user --back`, fix: '' };
  const why = onPurpose(f);
  if (why) return { id: 'root', label: 'Runs as root', status: 'info', detail: `on purpose, ${why}. ${refused}`, fix: '' };
  return {
    id: 'root',
    label: 'Runs as root',
    status: 'warn',
    detail: `Hoprig works as root here. ${refused}, and the daily work belongs in an ordinary user's account. The move to an ordinary user shows each step and asks first`,
    fix: 'hoprig move-to-user',
  };
}

/** True when Hoprig may be set up to work here: not root, or root on purpose (inside a container, or his choice). */
export const workAsRootAllowed = (f) => !!f && (!f.root || f.container.length > 0 || f.stay === true);

/**
 * The one line said when a FRESH background service would be set up for root (none is installed yet) and root is not on
 * purpose: nothing is made. An installation that already runs as root keeps working; the doctor offers its move.
 */
export const FRESH_ROOT_LINE = 'This is root, and Hoprig is not set up to work as root, so no background service was made for root. Set Hoprig up as an ordinary user, or keep it on root on purpose: hoprig setup --stay-root';

/** FRESH_ROOT_LINE when a background service would be made new for root not on purpose (`installed`: one exists), else null. */
export const freshRootRefusal = (f, installed) => (f && f.root && !workAsRootAllowed(f) && !installed ? FRESH_ROOT_LINE : null);

/** The sentence typed on the page to keep Hoprig on root by the owner's choice (stayRootChoice checks it); `--stay-root` on the command line. */
export const STAY_ROOT_SENTENCE = 'keep Hoprig on root';

/**
 * The choice to stay root as sent by the page (POST /api/settings `stayRoot`) → true or false to keep in the settings.
 * `{ sentence }` must be STAY_ROOT_SENTENCE typed as it is (case and spaces at the ends aside); `false` takes the choice
 * back. Only where Hoprig runs as root. Throws with the reason otherwise.
 */
export function stayRootChoice(value, asRoot) {
  if (!asRoot) throw new Error('Hoprig does not run as root here, so there is nothing to keep on root');
  if (value === false) return false;
  const typed = value && typeof value === 'object' && typeof value.sentence === 'string' ? value.sentence.trim().toLowerCase() : null;
  if (typed !== STAY_ROOT_SENTENCE.toLowerCase()) throw new Error(`type the sentence "${STAY_ROOT_SENTENCE}" as it is written`);
  return true;
}

/** What the page shows about root (GET /api/settings `root`): the facts that make root on purpose, null when not root. */
export const rootView = (f) => (f && f.root ? { container: f.container, stay: f.stay, onPurpose: workAsRootAllowed(f), sentence: STAY_ROOT_SENTENCE, limits: ROOT_LIMITS } : null);

/** Why a root login gets no install by itself, and what to do (the hub's "Install Hoprig on <server>"). */
export const ROOT_LOGIN_WHY = 'Claude Code refuses bypass permissions mode for root, so every session there would ask about each command, and the daily work belongs in an ordinary user\'s account. This page can make an ordinary user there for the work (hoprig, with sudo and the key you use for root) and set Hoprig up as that user. Or add it with an ordinary login that has sudo (such as ubuntu@ on many cloud servers), or keep Hoprig on root there on purpose with the sentence below.';
