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

/** Write the launch file for one start: { v: 1, cwd, argv, at }. Returns its path. */
export function writeLaunch({ cwd, argv }, now = Date.now()) {
  const dir = launchDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!windows) fs.chmodSync(dir, 0o700); // made earlier, or by an older version: owner only all the same
  sweepLaunches(now);
  const file = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ v: 1, cwd: String(cwd), argv: argv.map(String), at: now }), { mode: 0o600, flag: 'wx' });
  return file;
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
 * read further, so a start line works once. Returns { cwd, argv }; throws LaunchError with one plain sentence.
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
    && Array.isArray(o.argv) && o.argv.every((a) => typeof a === 'string');
  if (!ok) throw new LaunchError(USED);
  return { cwd: o.cwd, argv: o.argv };
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
  argv.splice(2, argv.length - 2, ...l.argv);
}
