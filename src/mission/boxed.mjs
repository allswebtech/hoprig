// A task's tests in the box (src/box, docs/BOX.md): the folders the box is given, and how the project's dependencies
// reach the tests inside. Both are the product's own, never text: no folder comes from the brief, the Work file, a file
// in the worktree or anything else a session could have written.
//
//   write  the task's worktree, by the real path the product made it at (alonegit.mjs keptTree)
//   read   the project's own dependencies: the real path of the node_modules of its main checkout, when that is a real
//          folder outside the worktree; and the folders the project's needs name, as a session gets them (needs.mjs),
//          but only a folder in which nothing the session's tools are denied to read can be read: the box gets whole
//          folders and has no deny rules, so a need folder with a private folder, a denied file or a rule it cannot
//          judge is left out, and the gate's words say so
//
// Nothing is installed, anywhere: the box has no network, and an install outside it would run a session's package
// scripts with the owner's rights. The dependencies reach the tests through a link the product makes for the run,
// <worktree>/node_modules → <the main checkout's node_modules>, made only when NOTHING is at that name, and taken away
// after the run, also when it threw. Whatever the session left under that name (a folder, a file, a link of its own)
// is never followed, replaced or named for the box: the tests run with what is there, and the gate's words say so.
// The product records the link it made in its own state folder (never in the worktree), so a run the dashboard did
// not finish (it died in between) is cleaned up first by the next gate of that worktree, before its "nothing left
// uncommitted" check. Only a link whose target equals the record is removed; anything else at that name is left.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { alive, sameProcess, system as procIdent } from '../procid.mjs';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { extraSettings, sessionExtras } from '../workspace/needs.mjs';
import { isPrivate, ruleForm } from '../workspace/needswalk.mjs';
import { replaceFile } from '../replacefile.mjs';

export const DEPS = 'node_modules';
const linksFile = () => path.join(stateDir(), 'mission-links.json');
const busy = new Set(); // worktrees whose tests run in the box now, in this process
const inside = (d, top) => d === top || d.startsWith(top.endsWith(path.sep) ? top : top + path.sep);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

function readLinks() {
  try {
    const d = JSON.parse(fs.readFileSync(linksFile(), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}
function writeLinks(d) {
  fs.mkdirSync(path.dirname(linksFile()), { recursive: true, mode: 0o700 });
  const tmp = `${linksFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 });
  replaceFile(tmp, linksFile());
}

/** The links the product made and has not taken away yet: { [worktree]: { target, pid } }. */
export const recordedLinks = () => readLinks();

/**
 * The project's own dependencies for the box: the real path of `<top>/node_modules` (top: the project's main
 * checkout), when it is a folder and neither inside the worktree nor around it. → the real path, or null.
 */
export function depsOf(top, tree) {
  if (!top || !tree) return null;
  const r = real(path.join(top, DEPS));
  const t = real(tree);
  if (!r || !t) return null;
  try {
    if (!fs.statSync(r).isDirectory()) return null;
  } catch {
    return null;
  }
  return inside(r, t) || inside(t, r) ? null : r;
}

// How many entries of a need folder are looked at for a private folder (no-ai and the like) before it is left out.
const WALK_MAX = 50_000;

/** Whether `d` holds a private folder at any depth (links are not followed). → true also when it is too large to say. */
function holdsPrivate(d) {
  const stack = [d];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (++seen > WALK_MAX) return true;
      if (isPrivate(e.name)) return true;
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
  }
  return false;
}

/**
 * Whether nothing a session of the project would be denied to read in the need folder `d` can be read in the box,
 * which gets whole folders and cannot hide a part of one. `deny`: the session's rules (needs.mjs extraSettings);
 * `given`: every folder the box gets. A rule passes only when what it names is not there, or is a link that leads
 * out of every folder the box gets (it dangles inside). A pattern, or the whole folder, never passes. → '' or why.
 */
export function hidden(d, deny, given, platform = process.platform) {
  // The rules name `d` as needs.mjs wrote them: on Windows in its POSIX form (C:\a\b as /c/a/b, needswalk.mjs ruleForm).
  const rd = ruleForm(d, platform) ?? d;
  const quartet = new Set(PRIVATE_DIRS.flatMap((p) => [`Read(/${rd}/${p})`, `Read(/${rd}/${p}/**)`, `Read(/${rd}/**/${p})`, `Read(/${rd}/**/${p}/**)`]));
  const reads = deny.filter((r) => /^Read\(/.test(r) && !quartet.has(r));
  if (holdsPrivate(d)) return 'it holds a private folder';
  for (const r of reads) {
    const spec = r.slice(5, -1).replace(/\/\*\*$/, '');
    if (!spec.startsWith('/') || spec.includes('*')) return 'its session may not read some of its files';
    const at = diskPath(spec.slice(1), platform);
    if (at === null) return 'its session may not read some of its files';
    let st;
    try {
      st = fs.lstatSync(at);
    } catch {
      continue; // not there: nothing to read
    }
    const to = st.isSymbolicLink() ? real(at) : null;
    if (st.isSymbolicLink() && (!to || !given.some((g) => inside(to, g)))) continue;
    return 'its session may not read some of its files';
  }
  return '';
}

/** A rule's path as a path on this disk: itself, on Windows /c/a/b as C:\a\b. → the path, or null (none on Windows). */
function diskPath(at, platform) {
  if (platform !== 'win32') return at;
  const m = /^\/([A-Za-z])(?:\/|$)/.exec(at);
  return m ? path.win32.join(`${m[1].toUpperCase()}:\\`, ...at.slice(3).split('/').filter(Boolean)) : null;
}

/**
 * The folders the project's needs name, as a session of it gets them (by real path), none inside the worktree, and
 * only those in which the box shows nothing the session's own tools are denied (hidden). `others`: the box's other
 * folders. → { dirs, left: [the need's name: why it was left out] }
 */
export async function needDirs(top, tree, { extras = sessionExtras, settings = extraSettings, others = [] } = {}) {
  const t = real(tree);
  const out = { dirs: [], left: [] };
  if (!top || !t) return out;
  let ex;
  try {
    ex = await extras(top, { walk: true });
  } catch {
    return out;
  }
  const dirs = ex && Array.isArray(ex.dirs) ? ex.dirs : [];
  const given = [t, ...others, ...dirs.filter((d) => typeof d === 'string' && path.isAbsolute(d))];
  for (const [i, d] of dirs.entries()) {
    if (typeof d !== 'string' || !path.isAbsolute(d) || inside(d, t) || inside(t, d)) continue;
    const name = (ex.refs && ex.refs[i]) || path.basename(d);
    let why;
    try {
      const st = await settings([d], { walked: (ex.walked && ex.walked[d]) ? { [d]: ex.walked[d] } : {} });
      why = hidden(d, (st && st.deny) || [], given);
    } catch {
      why = 'its rules could not be read';
    }
    if (why) out.left.push(`${name}: ${why}`);
    else out.dirs.push(d);
  }
  return out;
}

// The process that made a link still runs: its pid lives and, when both identities are known, it is the same process
// (a pid the system gave to another program since does not hold a link for ever).
function stillRuns(rec) {
  if (!Number.isInteger(rec.pid) || rec.pid <= 0 || !alive(rec.pid)) return false;
  if (!rec.ident) return true;
  return sameProcess(rec.ident, procIdent.of([rec.pid]).get(rec.pid)) !== false;
}

/**
 * Takes away the link the product recorded for `tree`, when no run of it is going on (in this process, or in another
 * one that still lives): only when lstat shows a link whose target equals the record. Anything else at that name is
 * left as it is. The record goes either way. → true when a link was removed.
 */
export function clearLink(tree) {
  const all = readLinks();
  const rec = all[tree];
  if (!rec || typeof rec !== 'object') return false;
  if (rec.pid === process.pid ? busy.has(tree) : stillRuns(rec)) return false;
  let removed = false;
  const at = path.join(tree, DEPS);
  try {
    if (fs.lstatSync(at).isSymbolicLink() && fs.readlinkSync(at) === rec.target) {
      fs.unlinkSync(at);
      removed = true;
    }
  } catch {
    /* nothing there any more */
  }
  delete all[tree];
  writeLinks(all);
  return removed;
}

/**
 * Makes <tree>/node_modules → `target`, only when nothing is at that name. The record is written first, so a
 * dashboard that dies right after the link was made still finds it. → { made } or { own: true } (something is there).
 */
export function makeLink(tree, target) {
  const at = path.join(tree, DEPS);
  try {
    fs.lstatSync(at);
    return { made: false, own: true };
  } catch (e) {
    if (e.code !== 'ENOENT') return { made: false, own: true };
  }
  const all = readLinks();
  all[tree] = { target, pid: process.pid, ident: procIdent.self() || null };
  writeLinks(all);
  try {
    fs.symlinkSync(target, at, 'dir'); // fails when something appeared at that name meanwhile: it is never replaced
    return { made: true, own: false };
  } catch {
    const now = readLinks();
    delete now[tree];
    writeLinks(now);
    return { made: false, own: fs.existsSync(at) || isLink(at) };
  }
}
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// One run of a worktree at a time, also across dashboards on one state folder: a file of the product's own per
// worktree, made with "only when nothing is there" and holding its maker's process. A maker that is gone (a dashboard
// that died in the middle of a run) holds nothing: its file is taken away by the next run.
const runFile = (tree) => path.join(stateDir(), 'mission-runs', `${crypto.createHash('sha256').update(tree).digest('hex').slice(0, 24)}.lock`);
const STALE_EMPTY_MS = 10_000; // a file still empty this long after it was made: its maker died while writing it
// A process group is alive when signal 0 to the whole group is not refused with ESRCH (EPERM: alive, not ours to signal).
function groupAlive(group) {
  if (!Number.isInteger(group) || group <= 1) return false;
  try { process.kill(-group, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Record the box's process group on this run's own lock, so a dashboard that dies leaves the group id behind: the next
// run finds the box still alive and ends it by that id. Beside the id goes the identity of the group's leader (the box
// itself: its pid plus its start, procid.mjs), so that a group id the system has since given to another process is
// never signalled. Only this process's own lock is touched, written whole.
function setGroup(tree, group) {
  if (!Number.isInteger(group)) return;
  const f = runFile(tree);
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (rec.pid !== process.pid) return;
    rec.group = group;
    rec.groupIdent = procIdent.of([group]).get(group) || null;
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    replaceFile(tmp, f);
  } catch { /* the lock is gone: the run is ending anyway */ }
}
function holder(tree) {
  const f = runFile(tree);
  try {
    const st = fs.statSync(f);
    const text = fs.readFileSync(f, 'utf8');
    if (!text) return Date.now() - st.mtimeMs > STALE_EMPTY_MS ? { gone: true, text } : { held: true };
    const rec = JSON.parse(text);
    const ownerAlive = rec && (rec.pid === process.pid ? busy.has(tree) : stillRuns(rec));
    if (ownerAlive) return { held: true };
    // The owner (the dashboard that made the lock) is gone. If the box it started still lives (its group), it is an
    // orphan with no timer behind it: the next run ends it by that group id. Otherwise the lock is free to take.
    if (rec && Number.isInteger(rec.group) && groupAlive(rec.group)) {
      // Only when the group's leader is still the process the lock recorded: a group id the system gave to another
      // process since (the box ended, its id was handed out again) is not the box's, so the box is gone. When the
      // leader's identity cannot be read (none recorded, the leader has ended while others of its group live, /proc
      // cannot be read), nothing is signalled: the worktree waits.
      const same = sameProcess(rec.groupIdent, procIdent.of([rec.group]).get(rec.group));
      if (same === true) return { orphan: rec.group, text };
      if (same === false) return { gone: true, text };
      return { held: true };
    }
    return { gone: true, text };
  } catch (e) {
    return e.code === 'ENOENT' ? { free: true } : { held: true };
  }
}
function takeRun(tree) {
  if (busy.has(tree)) return false;
  const f = runFile(tree);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, ident: procIdent.self() || null }), { flag: 'wx', mode: 0o600 });
      busy.add(tree);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const h = holder(tree);
    if (h.held) return false;
    try {
      if (h.gone && fs.readFileSync(f, 'utf8') === h.text) fs.unlinkSync(f);
    } catch {
      /* gone meanwhile */
    }
  }
  return false;
}
function dropRun(tree) {
  busy.delete(tree);
  try {
    fs.unlinkSync(runFile(tree));
  } catch {
    /* not there */
  }
}

/** Whether a run of the worktree `tree` is under way now, in this dashboard or in another one that still lives. */
// End a box a dead dashboard left running (an orphan), by its own group id, then clear its lock. Bounded wait for it
// to die, so the next run never reads or writes the worktree while the orphan still does.
// It ends the box by its process group (the bwrap monitor, whose identity holder() checked), not by the box's own pid 1:
// pid 1 leads a new session (src/box/linux.mjs --new-session), so the group signal does not reach it, but bwrap's
// --die-with-parent kills it when the monitor dies. Each turn of the loop below sleeps a short interval (50 ms) after the signal before it
// reads the lock again, so that cascade has completed by the time the worktree is declared free. The box's inner pid is
// not signalled from here: for a run a dead dashboard left, that host pid could have been handed to another process
// since, and the group (identity-checked) is the one handle that can never hit a process the box did not start.
async function endOrphan(tree, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const h = holder(tree);
    if (!h.orphan) return;
    try { process.kill(-h.orphan, 'SIGKILL'); } catch { /* already gone */ }
    try { if (fs.readFileSync(runFile(tree), 'utf8') === h.text && !groupAlive(h.orphan)) fs.unlinkSync(runFile(tree)); } catch { /* gone */ }
    if (Date.now() >= end) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const runsNow = (tree) => busy.has(tree) || !!holder(tree).held;

/** Waits until no run of `tree` is under way, at most `ms`. → true when none is. */
export async function waitIdle(tree, ms, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const h = holder(tree);
    // A box orphaned by a dead dashboard is ended by its own group id (never by a name), then the lock frees.
    if (h.orphan) { try { process.kill(-h.orphan, 'SIGKILL'); } catch { /* already gone */ } }
    else if (!busy.has(tree) && !h.held) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * Runs `test` (argv) in the box `box` ({ check, run }; the caller has had its check say yes) in the worktree `tree`
 * of the project whose main checkout is `top`. → { r (the box's answer), own (the worktree had its own node_modules),
 * deps (the project's dependencies were given) } or { busy: true } (its tests run there now, here or in another
 * dashboard on this state folder).
 */
export async function runInBox(box, { top, tree, test, timeoutMs, maxOut }) {
  await endOrphan(tree); // a box a dead dashboard left running is ended by its group id before this run claims the tree
  if (!takeRun(tree)) return { busy: true };
  clearLink(tree); // what a run the dashboard did not finish left (the gate did this already; his press did not)
  let link = { made: false, own: false };
  try {
    const deps = depsOf(top, tree);
    const needs = await needDirs(top, tree, { others: deps ? [deps] : [] });
    if (deps) link = makeLink(tree, deps);
    else link = { made: false, own: fs.existsSync(path.join(tree, DEPS)) || isLink(path.join(tree, DEPS)) };
    const read = [...new Set([...(link.made ? [deps] : []), ...needs.dirs])];
    const r = await box.run([...test], { cwd: tree, write: [tree], read, timeoutMs, onStart: ({ group }) => setGroup(tree, group), ...(maxOut ? { maxOut } : {}) });
    return { r, own: link.own, deps: link.made, left: needs.left };
  } finally {
    busy.delete(tree);
    if (link.made) clearLink(tree);
    dropRun(tree);
  }
}
