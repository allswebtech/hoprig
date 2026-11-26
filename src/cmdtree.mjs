// A command and everything it started, as one tree: a check's or go-live's (src/ship/runcmd.mjs) and a command Tia
// runs (src/assistant/ops.mjs). On Linux and macOS that is its process group (kill -<pid>). Windows has no such group:
// a process there names the process that started it (its parent pid), and keeps that name after its parent has ended.
// So the tree is read from a snapshot of every process with its parent and its start, and ended pid by pid, never by
// a name. A pid Windows has since given to a later process is told apart by the starts: a child is in the tree only
// when it started after its parent, and before the process that holds its parent's pid now (when that is a later one).
// The command itself is ended through its own handle (`killRoot`) when its caller holds one. Every other process of
// the tree, and a command found by its pid and start (no handle: after a restart of the dashboard), is ended in ONE
// call that opens each by its pid, holds it, compares its start with the snapshot's and only then ends it
// (src/winend.mjs, the end a run by itself uses too): a pid handed on between the snapshot and the end is not ended.

import { END_SAME_MS, endHeld } from './winend.mjs';

/** The end call through the system's PowerShell (Windows): → { ok, out }. Loaded only when it runs. */
async function runPs(cmd, args) {
  const { run } = await import('./server/platform/common.mjs');
  const r = await run(cmd, args, { timeout: 15_000, env: process.env }).catch(() => null);
  return r ? { ok: r.ok, out: r.stdout } : { ok: false, out: '' };
}

// Starts are compared with this much room: the system and Node read them at slightly different moments.
const SAME_MS = 1000;

/**
 * Every process with its parent and its start (epoch ms), as JSON [{ pid, ppid, start }], after win32.mjs's prelude
 * (no module is loaded).
 */
export const TREE_SCRIPT = `$rows = [System.Collections.ArrayList]::new()
foreach ($p in (Rows 'root\\cimv2' 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process')) { $s = 0; if ($p['CreationDate']) { $s = [double][DateTimeOffset]::new([System.Management.ManagementDateTimeConverter]::ToDateTime($p['CreationDate'])).ToUnixTimeMilliseconds() }; [void]$rows.Add(@{ pid = [int]$p['ProcessId']; ppid = [int]$p['ParentProcessId']; start = $s }) }
Emit $rows.ToArray()
`;

/** That JSON → Map(pid → { ppid, start }) (start null when not told), or null when it is not that. */
export function parseTable(json) {
  try {
    const rows = JSON.parse(json);
    if (!Array.isArray(rows)) return null;
    const map = new Map();
    for (const r of rows) if (Number.isInteger(r.pid)) map.set(r.pid, { ppid: Number(r.ppid), start: Number(r.start) > 0 ? Number(r.start) : null });
    return map;
  } catch {
    return null;
  }
}

/**
 * The processes of this computer now (Windows, one PowerShell call): Map pid → { ppid, start }, or null. This file
 * loads the Windows helpers only here, so it adds no load of them on Linux and macOS.
 */
export async function processTable() {
  const { POWERSHELL, NO_MODULE_PRELUDE, psArgs } = await import('./server/platform/win32.mjs');
  const { run } = await import('./server/platform/common.mjs');
  const r = await run(POWERSHELL, psArgs(`${NO_MODULE_PRELUDE}${TREE_SCRIPT}`), { timeout: 15_000, env: process.env }).catch(() => null);
  return r && r.ok ? parseTable(r.stdout) : null;
}

/**
 * What descends from `root` ({ pid, start: epoch ms, or null when not known; alive: true when the caller knows it runs
 * now }) in the snapshot `procs`, parents first. A child counts from a second before its parent's start (the system's
 * clock and Node's are read apart). With no start known, every process that names it as parent is taken.
 */
export function treeOf(root, procs) {
  const out = [];
  const seen = new Set([root.pid]);
  // `root.endedAt`: when the command ended (epoch ms): nothing it started can have started after that.
  const rootEnd = Number.isFinite(root.endedAt) ? root.endedAt : Infinity;
  const walk = (pid, start, itself = false, ended = Infinity) => {
    const holder = procs.get(pid);
    // Its pid is held now by a process that started later: what that one started is not of this tree. Not for a command
    // its caller knows to be running (`root.alive`): its start handed in may be read before it began (Node takes a
    // second or more to start on Windows), and the command itself would then read as a later holder of its pid.
    const until = !itself && holder && start !== null && holder.start !== null && holder.start > start + SAME_MS ? holder.start : Infinity;
    for (const [c, p] of procs) {
      if (p.ppid !== pid || seen.has(c)) continue;
      if (start !== null && p.start !== null && (p.start < start - SAME_MS || p.start >= until)) continue;
      if (p.start !== null && p.start > ended) continue; // started after the command had ended: another's
      seen.add(c);
      out.push(c);
      walk(c, p.start);
    }
  };
  walk(root.pid, Number.isFinite(root.start) ? root.start : null, root.alive === true, rootEnd);
  return out;
}

// When the processes cannot be read at an end (PowerShell failed, or ran into its 15 s on a busy computer): how long
// before the one more try.
export const RETRY_MS = 1000;
// The words a person reads when the end may have left something the command started.
export const TREE_UNSURE = 'Hoprig could not read the processes of this computer, so what the command started may still run';
// The words when the processes were read, but a process of the tree could not be ended, or shown to be the one the
// snapshot saw (Windows hands a pid on at once): it was left running, never ended by its number.
export const TREE_NOT_ENDED = 'Hoprig could not end every process the command started, so one of them may still run';

/**
 * End the command `root` and everything it started. `root`: { pid, start, alive, killRoot?, endedAt? }.
 *   alive     whether it runs: a boolean, or a function read at the moment of each step (a caller that holds the child:
 *             `() => child.exitCode === null && child.signalCode === null`)
 *   killRoot  (signal) => ends it through the child's own handle, which cannot reach another process; when given, the
 *             command is never ended by its number
 *   endedAt   when it ended (epoch ms, or a function giving it, null while it runs): what started after is not its own
 * Linux and macOS: its process group gets `signal`. Windows: a snapshot first, while every link of the tree still lives
 * (a child Node started without detaching ends with its parent, and what IT started would then name a parent that is
 * gone and be lost to the walk); then the command (only while it runs), then each member of its tree, parents first,
 * through `endMembers` (by number today); then a second snapshot for what started meanwhile. When the processes cannot
 * be read, the command itself is ended, the tree is tried once more after RETRY_MS, and the answer says it may not be
 * whole. It never throws, also not from the work after it returned.
 * → { ok (Linux, macOS: the group took it; Windows: the command was there), rest: Promise of the pids ended below it,
 *     whole: Promise of { whole: false, why } when the tree may not all be ended, else { whole: true } }
 */
export function endTree(root, signal = 'SIGKILL', { platform = process.platform, kill: given = null, table = processTable, wait = (ms) => new Promise((r) => setTimeout(r, ms)), endMembers = null, run: givenRun = null } = {}) {
  const kill = given || process.kill.bind(process);
  const run = givenRun || runPs;
  // The held end (src/winend.mjs) is the one end of a process on Windows. A caller that hands in its own `kill` (a test
  // with made-up processes) and no `run`, or its own `endMembers`, keeps the end it asks for: made-up pids never reach
  // the system's end call.
  const held = !endMembers && (givenRun !== null || given === null);
  const pid = root && root.pid;
  const done = (ended = [], whole = true, why = TREE_UNSURE) => ({ ended, whole, why });
  const answer = (ok, work) => ({ ok, rest: work.then((x) => x.ended.filter((p) => p !== pid)), whole: work.then((x) => (x.whole ? { whole: true } : { whole: false, why: x.why || TREE_UNSURE })) });
  if (!Number.isInteger(pid) || pid <= 1) return answer(false, Promise.resolve(done()));
  const end = (p, sig) => {
    try {
      kill(p, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (platform !== 'win32') return answer(end(-pid, signal), Promise.resolve(done()));
  const isAlive = () => {
    try {
      return typeof root.alive === 'function' ? !!root.alive() : root.alive === true;
    } catch {
      return false;
    }
  };
  const exitAt = () => {
    const e = typeof root.endedAt === 'function' ? root.endedAt() : root.endedAt;
    return Number.isFinite(e) ? e : null;
  };
  const byHandle = typeof root.killRoot === 'function';
  let unsure = false; // something of the tree could not be ended, or shown to be gone: the answer says so
  let rootLeft = false; // the command (no handle) could not be ended, or shown to be the process that holds its pid
  // A command its caller holds no handle of (endCommand: found by pid and start after a restart of the dashboard),
  // judged by a snapshot: 'same' when its pid shows the command's start (`startExact`: the start of its identity, the
  // system's own, so the table's may be that or 1 ms above; else within SAME_MS), 'other' when another start,
  // 'gone' when that pid is not there, 'unknown' when no snapshot or no start to compare.
  const rootSeen = (snap) => {
    if (!snap) return 'unknown';
    const seen = snap.get(pid);
    if (!seen) return 'gone';
    if (seen.start === null || !Number.isFinite(root.start)) return 'unknown';
    const d = seen.start - root.start;
    return (root.startExact === true ? d >= 0 && d <= END_SAME_MS : Math.abs(d) <= SAME_MS) ? 'same' : 'other';
  };
  // The command: through its handle when there is one, never by its number then; only while it runs, as seen now.
  // Without a handle only once a snapshot showed it is the command ('same'), and then in the held call, which checks
  // its start again on the process object it ends (never before a snapshot answered, never by its number).
  const endRoot = async (snap) => {
    if (!isAlive()) return false;
    if (byHandle) {
      try {
        root.killRoot(signal);
        return true;
      } catch {
        return false;
      }
    }
    const r = rootSeen(snap);
    if (r === 'gone') return false;
    if (r !== 'same') {
      rootLeft = true;
      return false;
    }
    rootLeft = false;
    if (!held) return end(pid, signal);
    const seen = snap.get(pid);
    const e = { pid, start: Math.round(root.startExact === true ? root.start : seen.start), ppid: Number.isInteger(seen.ppid) && seen.ppid >= 0 ? seen.ppid : 0 };
    const w = (await endHeld([e], run)).get(pid);
    rootLeft = w !== 'ended' && w !== 'gone';
    return w === 'ended';
  };
  // The members: `endMembers(list, signal)` gets [{ pid, start, ppid }] (parents first), each with the start and parent
  // the snapshot it was found in showed (start null when not told), and gives back the pids it ended. The default is
  // the held call, the lowest first, so one that cannot be ended keeps what is above it. "gone" is no loss; any other
  // word than "ended" (another start, failed, kept, no answer) or a member without a start to hold it by is unsure.
  const byNumber = (list, sig) => list.filter((e) => end(e.pid, sig)).map((e) => e.pid);
  const endList = endMembers || (!held ? byNumber : async (list) => {
    const entries = [...list].reverse().map((x) => ({ pid: x.pid, start: Number.isFinite(x.start) ? Math.round(x.start) : null, ppid: x.ppid }));
    const ok = entries.filter((e) => e.pid > 4 && Number.isInteger(e.start) && e.start >= 0 && Number.isInteger(e.ppid) && e.ppid >= 0);
    if (ok.length < entries.length) unsure = true;
    if (!ok.length) return [];
    const said = await endHeld(ok, run);
    const out = [];
    for (const e of ok) {
      const w = said.get(e.pid);
      if (w === 'ended') out.push(e.pid);
      else if (w !== 'gone') unsure = true;
    }
    return out;
  });
  const ok = byHandle ? isAlive() : end(pid, 0); // it is there (a signal 0 ends nothing)
  const read = () => Promise.resolve().then(table).catch(() => null);
  const view = () => ({ pid, start: root.start, alive: isAlive(), endedAt: exitAt() });
  const work = (async () => {
    const ended = [];
    const members = async (list, snap) => {
      const fresh = [...new Set(list)].filter((p) => p !== pid && !ended.includes(p));
      if (!fresh.length) return;
      // Each with the start and parent the snapshot it was found in showed: what an end can check it by.
      const items = fresh.map((p) => {
        const x = snap ? snap.get(p) : null;
        return { pid: p, start: x && x.start !== null ? x.start : null, ppid: x ? x.ppid : null };
      });
      for (const p of (await endList(items, signal)) || []) if (!ended.includes(p)) ended.push(p);
    };
    const rootEnded = async (snap) => {
      if (ended.includes(pid)) return;
      if (await endRoot(snap)) ended.push(pid);
    };
    // Whole only when nothing was left unsure, and the command is ended or no longer runs.
    const whole = () => !unsure && !(rootLeft && isAlive());
    // Without a handle, a snapshot that shows its pid with another start, or none to compare, is not the command:
    // nothing of what that pid runs is ended, and the answer says the tree may be left.
    const notTheCommand = (snap) => !byHandle && isAlive() && !['same', 'gone'].includes(rootSeen(snap));
    let first = await read();
    if (!first) {
      // Not read: the command itself (held by the start its caller was given, when it was given one); then the tree
      // once more, from a parent now gone, and the command by the snapshot's start when it still runs.
      await rootEnded(null);
      await wait(RETRY_MS);
      first = await read();
      if (!first) return done(ended, false);
      if (notTheCommand(first)) return done(ended, false, TREE_NOT_ENDED);
      if (!byHandle) await rootEnded(first);
      await members(treeOf({ ...view(), alive: false, endedAt: exitAt() ?? Date.now() }, first), first);
      return done(ended, whole(), TREE_NOT_ENDED);
    }
    // As the command is NOW (it may have ended by itself while the processes were read): a command that has ended may
    // have its pid on another process (Windows hands a pid on at once), and only what descends from it is its own then.
    // Without a handle it counts as running only when the snapshot shows its own start on that pid; another start is
    // another program, whose children are then not taken. With a handle, a holder of its pid that began no later than
    // the end its caller saw is the command itself (it ended after the snapshot), and its children are its own.
    if (notTheCommand(first)) return done(ended, false, TREE_NOT_ENDED);
    const v = view();
    const seen = first.get(pid);
    const itself = byHandle
      ? v.alive || (!!seen && seen.start !== null && v.endedAt !== null && seen.start <= v.endedAt)
      : v.alive && rootSeen(first) === 'same';
    const now = { ...v, alive: itself };
    const tree = treeOf(now, first);
    await rootEnded(first);
    const rootGone = exitAt() ?? Date.now(); // from here on nothing new is the command's own child
    await members(tree, first); // a process on Windows ends at once
    const membersGone = Date.now(); // from here on nothing new is an ended member's own child
    // What a process of the tree started between the snapshot and its end: its parent is one that was just ended.
    const again = tree.length || ended.length ? await read() : null;
    if (again) {
      // The command's own start as the system gave it, when it was running at the first look: it may still show now.
      const rootStart = (now.alive && first.get(pid)?.start) || root.start;
      const later = treeOf({ pid, start: Number.isFinite(rootStart) ? rootStart : null, endedAt: rootGone }, again);
      // An ended member's pid may be another process's by now: what began after its end is not of the tree.
      const starts = tree.map((p) => [p, first.get(p)?.start]);
      for (const [p, start] of starts) later.push(...treeOf({ pid: p, start: Number.isFinite(start) ? start : null, endedAt: ended.includes(p) ? membersGone : null }, again));
      await members(later.filter((q) => !tree.includes(q)), again);
    }
    return done(ended, whole(), TREE_NOT_ENDED);
  })().catch(() => done([], false));
  return answer(ok, work);
}

// How often the keeper of a command's output looks at every process, once the command itself has ended (Windows).
export const LOOK_EVERY_MS = 30_000;

/**
 * The keeper's question on Windows (outkeeper.mjs): is nothing of the command `root` ({ pid, start }) left? It is
 * started after the command's end, so a process that has its pid now is another one (Windows hands a pid on at once):
 * a snapshot at most every `every` ms says, by parent and start (treeOf), whether anything descends from the command.
 * A snapshot that fails answers "something is left" (the file stays bounded). → async () => boolean
 */
export function keeperGone(root, { table = processTable, every = LOOK_EVERY_MS, now = Date.now } = {}) {
  let lookedAt = -Infinity;
  return async () => {
    if (now() - lookedAt < every) return false;
    lookedAt = now();
    const procs = await table();
    return !!procs && treeOf(root, procs).length === 0;
  };
}
