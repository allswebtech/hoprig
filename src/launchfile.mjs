// A launch file: how the dashboard starts the launcher in a terminal without typing anything that came from outside.
//
// A terminal's command is typed into an interactive shell, and the shell's line editor reads every typed byte before
// any quoting counts (Ctrl-U erases the opening quote, Tab completes and closes it, some shells read escapes inside
// single quotes). So the folder, the launcher's arguments and the first message are never typed: the dashboard writes
// them to a file of its own, readable by this user only, and types only `<launcher> --launch <file>`. The launcher
// takes the file (once: it removes it at once), goes to the folder and goes on exactly as if it had been started
// with those arguments there. A launcher started with plain arguments (typed by a person) works as before.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';

/** The dashboard's own flag: not in the help, nobody types it. */
export const LAUNCH_FLAG = '--launch';

/** The folder of the launch files, under the state folder. */
export const launchDir = () => path.join(stateDir(), 'launch');

const NAME_RE = /^[0-9a-f]{32}\.json$/;
// A file that was never taken (the line was typed, then Ctrl+C) is older than this when it is swept: it holds the
// first message, so it does not stay.
const LEFT_MS = 10 * 60_000;
const windows = process.platform === 'win32';

/**
 * Write the launch file for one start: { v: 1, cwd, argv, at }, and `hand` only when given (a move of the dashboard's
 * that carries Hands-off's stops: see HAND below). `hers`: the dashboard starts this session for Tia (her door asked
 * for it, or it carries on a session of hers): the launcher then marks the run hers and gives it her git sign-in
 * (launch.mjs). Only the dashboard writes this file, in its own state folder, readable by this user alone, and the
 * launcher takes it once; so nothing a session or a request can say decides it. Returns its path.
 */
export function writeLaunch({ cwd, argv, hand = null, hers = false, all = false }, now = Date.now()) {
  const dir = launchDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!windows) fs.chmodSync(dir, 0o700); // made earlier, or by an older version: owner only all the same
  sweepLaunches(now);
  const file = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.json`);
  const body = { v: 1, cwd: String(cwd), argv: argv.map(String), at: now };
  if (hand) {
    if (!handOk(hand)) throw new Error('a move\'s hand-over is not of its shape');
    body.hand = hand;
  }
  if (hers) body.hers = true;
  if (all) body.all = true; // "Allow everything" (bypassgate.mjs): the launcher sets the hook's mode from this alone, and marks the run (allmark.mjs)
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
  return file;
}

/**
 * A move of the dashboard's (server/deck.mjs move) restarts the terminal with a NEW launcher, which writes a new run
 * record; the old launcher removes its own when it ends, before the new one starts. So what Hands-off keeps in the old
 * record goes along in the launch file, from that one record:
 *   hand = { from, runId, conversation, carry: { stop?, row?, done? } }
 *   from          the old run's id
 *   runId         the new run's id, chosen by the dashboard, which keeps the owner's switch for the session under it
 *   conversation  the conversation the move carries on; the carry counts only for a start on that conversation
 *   carry         handsOffStop ('loop' | 'hour'), handsOffRow (a count above 0) and handsOffDone (the hour's answers),
 *                 in exactly the shapes runs.mjs createRun copies on the launcher's own move
 * Anything else in it refuses the start, as a bad file does.
 */
export const RUN_ID_RE = /^[0-9a-z]{1,12}-\d{1,10}(?:-[0-9a-f]{8})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_LINES = 10; // handsoff.mjs HOUR_MAX: the hour's answers kept (only node: imports here, so not imported)
const plainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const doneLine = (d) => plainObject(d) && Number.isFinite(d.at) && Object.values(d).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
export function handOk(h) {
  if (!plainObject(h)) return false;
  // A reset hand carries nothing: it tells the new run to start with its answers stopped ('reset'), for a resumed
  // run whose Hands-off state the dashboard could not carry (a restore after a reboot, a chat/terminal hand-off).
  if (h.reset === true && Object.keys(h).length === 1) return true;
  if (Object.keys(h).some((k) => !['from', 'runId', 'conversation', 'carry'].includes(k))) return false;
  if (typeof h.from !== 'string' || !RUN_ID_RE.test(h.from) || typeof h.runId !== 'string' || !RUN_ID_RE.test(h.runId) || h.from === h.runId) return false;
  if (typeof h.conversation !== 'string' || !UUID_RE.test(h.conversation)) return false;
  const c = h.carry;
  if (!plainObject(c) || Object.keys(c).some((k) => !['stop', 'row', 'done'].includes(k))) return false;
  if (c.stop !== undefined && c.stop !== 'loop' && c.stop !== 'hour') return false;
  if (c.row !== undefined && !(Number.isInteger(c.row) && c.row > 0 && c.row <= 1000)) return false;
  if (c.done !== undefined && !(Array.isArray(c.done) && c.done.length > 0 && c.done.length <= HOUR_LINES && c.done.every(doneLine))) return false;
  return true;
}

/**
 * The carry of run record `run` as handOk takes it: its loop or hour stop, its count above 0 and the hour's answers
 * (the last ten that are lines of that shape). A record the session wrote itself in another shape gives what of it is
 * of the shape, so a move is never refused for it. null when there is nothing to carry.
 */
export function carryOf(run) {
  if (!plainObject(run)) return null;
  const c = {};
  if (run.handsOffStop === 'loop' || run.handsOffStop === 'hour') c.stop = run.handsOffStop;
  if (Number.isInteger(run.handsOffRow) && run.handsOffRow > 0) c.row = Math.min(run.handsOffRow, 1000);
  const done = Array.isArray(run.handsOffDone) ? run.handsOffDone.filter(doneLine).slice(-HOUR_LINES) : [];
  if (done.length) c.done = done;
  return Object.keys(c).length ? c : null;
}

// The hand-over of the launch file this launcher was started with (applyLaunch), held in its memory only: never in an
// environment variable, which the coding tool and every command of the session would see. Taken once.
let taken = null;
/** The hand-over this launcher was started with, once (launch.mjs reads it for its first record), else null. */
export function takeHand() {
  const h = taken;
  taken = null;
  return h;
}

// Whether the launch file said the session is Tia's, held in memory only like the hand-over: an environment variable
// would let a command of the session, or a person's own `hoprig`, say it. Taken once.
let hersTaken = false;
/** True once when this launcher was started by the dashboard for a session of Tia's (writeLaunch `hers`). */
export function takeHers() {
  const h = hersTaken;
  hersTaken = false;
  return h;
}

let allTaken = false;
/** True once when this launcher was started by the dashboard for a session in Allow everything (writeLaunch `all`). */
export function takeAll() {
  const h = allTaken;
  allTaken = false;
  return h;
}

/** Remove a launch file that will not be used (the terminal could not be made). */
export const dropLaunch = (file) => file && fs.rmSync(file, { force: true });

/** Remove the launch files older than ten minutes: started lines nobody ran. */
export function sweepLaunches(now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(launchDir());
  } catch {
    return;
  }
  for (const f of names) {
    const file = path.join(launchDir(), f);
    try {
      if (now - fs.lstatSync(file).mtimeMs > LEFT_MS) fs.rmSync(file, { force: true });
    } catch {
      /* gone meanwhile */
    }
  }
}

export class LaunchError extends Error {}

const USED = 'This start line was used already, or it is not a start line of this computer\'s dashboard. Start the session again from the dashboard, or type "hoprig" yourself.';

/**
 * Take launch file `file`: only one that lies directly in the launch folder of this state folder, is a regular file
 * (not a link) of this user with no access for anyone else (on Windows: the first two). It is removed before it is
 * read further, so a start line works once. Returns { cwd, argv } (and `hand` and `hers` when the file has them); throws
 * LaunchError with one plain sentence.
 */
export function takeLaunch(file) {
  const want = path.resolve(launchDir());
  const at = path.resolve(String(file || ''));
  if (path.dirname(at) !== want || !NAME_RE.test(path.basename(at))) throw new LaunchError(USED);
  let fd;
  try {
    // O_NOFOLLOW: a link put in its place is refused by the open itself, not judged by an earlier look.
    fd = fs.openSync(at, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    throw new LaunchError(USED);
  }
  let text;
  try {
    const st = fs.fstatSync(fd);
    const lst = fs.lstatSync(at);
    if (!st.isFile() || !lst.isFile() || lst.ino !== st.ino) throw new LaunchError(USED);
    if (!windows) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
      if (st.uid !== uid || (st.mode & 0o077) !== 0) throw new LaunchError(USED);
    }
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  fs.rmSync(at, { force: true });
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw new LaunchError(USED);
  }
  const ok = o && o.v === 1 && typeof o.cwd === 'string' && o.cwd && path.isAbsolute(o.cwd)
    && Array.isArray(o.argv) && o.argv.every((a) => typeof a === 'string')
    && (o.hand === undefined || handOk(o.hand))
    && (o.hers === undefined || o.hers === true)
    && (o.all === undefined || o.all === true);
  if (!ok) throw new LaunchError(USED);
  return { cwd: o.cwd, argv: o.argv, ...(o.hand === undefined ? {} : { hand: o.hand }), ...(o.hers === true ? { hers: true } : {}), ...(o.all === true ? { all: true } : {}) };
}

/**
 * For the launcher (and stand-ins for it in tests): when it was started as `<launcher> --launch <file>`, take the
 * file, go to its folder and put its arguments in place of the flag in process.argv, so everything after reads
 * them as typed. Anything else is left as it is. On a problem: one sentence and exit code 2.
 */
export function applyLaunch(argv = process.argv) {
  if (argv[2] !== LAUNCH_FLAG) return;
  let l;
  try {
    if (argv.length !== 4) throw new LaunchError(USED);
    l = takeLaunch(argv[3]);
  } catch (e) {
    if (!(e instanceof LaunchError)) throw e;
    process.stderr.write(`hoprig: ${e.message}\n`);
    process.exit(2);
  }
  try {
    process.chdir(l.cwd);
  } catch {
    // JSON: a folder's name may hold anything, also bytes a terminal would act on.
    process.stderr.write(`hoprig: the folder this session was to start in is not there any more: ${JSON.stringify(l.cwd)}. Start it again from the dashboard in a folder that exists.\n`);
    process.exit(2);
  }
  process.env.PWD = l.cwd; // as `cd` would have set it: what the coding tool and its shells read as the folder
  // The words of the start line that were named, not typed (server/backends/shell.mjs WORD): not the coding tool's.
  for (const k of Object.keys(process.env)) if (/^HOPRIG_WORD_\d+$/.test(k)) delete process.env[k];
  taken = l.hand || null;
  hersTaken = l.hers === true;
  allTaken = l.all === true;
  argv.splice(2, argv.length - 2, ...l.argv);
}
