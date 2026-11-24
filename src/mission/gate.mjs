// A check owns "done": the gate of a task's result, written as code, run on the task's branch after its session ended.
// No model decides it. By the role's check (roles/<name>/ROLE.md):
//   every kind  nothing left uncommitted in the worktree; the branch changed something; when the brief names its files
//               (a line "Files: a, b"), the branch changed only those (a folder named ends in "/")
//   tests       the project's test command (the owner's, in Tia's settings per project). A session may have changed
//               what that command runs, so the product never runs it here by itself: it runs ONLY in a box (a command
//               with no network and without the owner's real home; src/box, reached through the seam, seam.mjs).
//               With no box on this computer the tests are NOT run: the gate says "tests not run: yours to check", the
//               task waits in review, and the owner runs them himself if he wants ("Run the tests here"). "Accept by
//               itself" never applies to a task whose tests did not run. The words here never say an environment makes
//               an unrun command safe: with no box, the session's code is simply not run.
//   file        every file the brief named exists on the branch and was changed by it; a brief that names none (Plan
//               with AI writes no "Files:" line) passes only when the branch changed documentation or text alone (a
//               writer or researcher never changes code), and its review judges which
//   diff        the rule of every kind alone
// → { ok, words, testsNotRun?, notRunWhy?, noBox?, step?, boxed?, tests?, printed?, held? }: when it did not pass, only what
// failed; when it passed, what was checked; testsNotRun when no box ran the tests (notRunWhy: why; noBox: there is
// none here, step: what would give one); boxed and tests ({ result: passed | failed | timeout, limit }) when it did;
// held when another dashboard's run held the worktree past the wait and what the branch holds passed (ok is false:
// nothing was judged of the worktree or its tests). The words are this code's own, with file names from git and the test command
// by its program's name (no path of this computer).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { stateDir } from '../paths.mjs';
import { capture } from '../setup/system.mjs';
import { cleanText, pathsOf } from '../work/runs.mjs';
import { clearLink, runInBox, waitIdle } from './boxed.mjs';

export const GATE_MS = 10 * 60_000;
// The longest the gate waits for the box's own check (its self-test bounds each trial; a check that never answers
// would hold the task's finish and its slot for ever).
export const CHECK_MS = 2 * 60_000;
// What the tests printed, as data for him and the reviewer: its last lines, at most this many, at most this long.
export const PRINTED_LINES = 40;
export const PRINTED_CHARS = 4000;
const SAFE = /^[A-Za-z0-9._/-]{1,200}$/;

/** The files a brief names on its lines "Files: a, b" (only plain relative paths). */
export function filesNamed(brief) {
  const out = [];
  for (const m of String(brief || '').matchAll(/^Files:\s*(.+)$/gm)) {
    for (const f of m[1].split(',').map((x) => x.trim()).filter(Boolean)) if (SAFE.test(f) && !f.split('/').includes('..') && !f.startsWith('/')) out.push(f);
  }
  return [...new Set(out)].slice(0, 40);
}
const within = (file, named) => named.some((n) => (n.endsWith('/') ? file.startsWith(n) : file === n));
/** The test command as the gate's words name it: its program by its name alone, no path of this computer. */
export const commandWords = (argv) => cleanText([path.basename(argv[0]), ...argv.slice(1)].join(' '), 120, pathsOf({ home: os.homedir() })).replace(/\s+/g, ' ');

// Documentation or plain text by its ending alone, wherever the file lies: so code placed under a docs/ folder is NOT
// documentation. A file gate that names no file passes only when every changed file ends this way.
const DOCS_EXT = /\.(md|markdown|txt|rst|adoc)$/i;
const isDocs = (f) => DOCS_EXT.test(f);

const list = (s, n = 5) => `${s.slice(0, n).join(', ')}${s.length > n ? ` and ${s.length - n} more` : ''}`;

const clean = (s) => cleanText(String(s || ''), 200, pathsOf({ home: os.homedir() })).replace(/\s+/g, ' ').trim();

/**
 * The paths of this computer that printed text may hold, with what stands for each, longest first: the worktree (".",
 * the tests ran there), the project's main checkout, the product's state folder, the home ("~"); each also by its
 * real path.
 */
function ownPaths({ tree, top }) {
  const list = [];
  const add = (p, short) => {
    if (typeof p !== 'string' || p.length < 2) return;
    const one = (x) => {
      x = x.replace(/[\\/]+$/, '');
      if (x.length < 2) return;
      list.push([`${x}/`, short === '.' ? '' : `${short}/`]);
      list.push([x, short]);
    };
    one(p);
    try {
      const r = fs.realpathSync(p);
      if (r !== p) one(r);
    } catch {
      /* not there */
    }
  };
  add(tree, '.');
  add(top, '<project>');
  add(stateDir(), '<state>');
  add(os.homedir(), '~');
  return list.sort((a, b) => b[0].length - a[0].length);
}

/**
 * The last lines `out` holds (PRINTED_LINES, PRINTED_CHARS), cleaned of this computer's paths, keys and name. Cut
 * before it is cleaned (the box keeps up to a megabyte); a line cut at its start goes whole, so no part of a path is
 * left that the cleaning would not know. → text ('' when nothing was printed).
 */
export function printedTail(out, where = {}) {
  let t = String(out || '').replace(/\s+$/, '');
  if (!t) return '';
  const lines = t.split('\n');
  if (lines.length > PRINTED_LINES) t = lines.slice(-PRINTED_LINES).join('\n');
  if (t.length > PRINTED_CHARS) {
    t = t.slice(-PRINTED_CHARS);
    const nl = t.indexOf('\n');
    t = nl >= 0 ? t.slice(nl + 1) : '';
  }
  return cleanText(t, PRINTED_CHARS, ownPaths(where));
}

/**
 * The box's own reason why nothing ran, in the gate's words: the test program by its name alone (as commandWords), and
 * the worktree, the main checkout, the state folder and the home taken out, as in what the tests printed.
 */
export function boxWhy(why, o) {
  let w = String(why || '');
  const prog = Array.isArray(o.test) && typeof o.test[0] === 'string' ? o.test[0] : '';
  if (prog.length > 1 && path.isAbsolute(prog)) w = w.split(prog).join(path.basename(prog));
  return cleanText(w, 200, ownPaths({ tree: o.tree, top: o.top })).replace(/\s+/g, ' ').trim();
}

/**
 * Whether a box can run a session's own test code now: it exists and its own check (boxCheck, asynchronous) says yes.
 * Waited for: read without waiting, a promise always looks like "no". → { ok, why } (why: the box's own words, cleaned).
 */
export async function boxReady(box, { limitMs = CHECK_MS } = {}) {
  if (!box || typeof box.run !== 'function' || typeof box.check !== 'function') return { ok: false, why: 'no box on this computer' };
  let timer = null;
  try {
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ late: true }), limitMs);
      timer.unref?.();
    });
    const c = await Promise.race([Promise.resolve().then(() => box.check()), late]);
    if (c && c.late === true) return { ok: false, why: 'the box\'s check did not answer in time' };
    if (c && c.ok === true) return { ok: true, why: '' };
    // The box's own step (what would give this computer one), for his card: words, never run.
    const step = c && typeof c.step === 'string' && c.step ? clean(c.step) : '';
    return { ok: false, noBox: true, why: clean(`no box on this computer: ${(c && c.why) || 'its check said no'}`), ...(step ? { step } : {}) };
  } catch (e) {
    return { ok: false, why: clean(`the box's check could not run: ${e && e.message}`) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * o: { check (tests|file|diff), top (the repository), tree (the task's worktree), base (the commit the branch was made
 * from), branch, brief, test (argv or null), box (seam.box(): the real box; null or a test's own stands for none), run
 * (git), timeoutMs, checkMs (how long the box's check may take), waitMs (how long a run of the worktree under way is
 * waited for; one run's time and a margin) }.
 */
export async function gate(o) {
  const run = o.run || capture;
  const words = [];
  const failed = [];
  let ok = true;
  let printed = '';
  let boxed = false;
  let result = null; // the tests' own result in the box: { result: passed | failed | timeout, limit? }
  const no = (w) => {
    ok = false;
    failed.push(w);
  };
  // A run of this worktree under way (his press, another dashboard's, the session's own tool): the gate waits for its
  // end, bounded by one run's time, so the link it made is never read as the session's file. Then what a run the
  // dashboard did not finish left: the link it made to the project's dependencies (boxed.mjs), only that link, by its
  // record; then the worktree is read as the session left it.
  const idle = await waitIdle(o.tree, o.waitMs || (o.timeoutMs || GATE_MS) + 30_000);
  // Still under way after one run's time: another dashboard on this state folder holds a run of this worktree (the
  // session's own run is waited for by the engine before the gate). Its worktree is not read now (the link that run
  // made would read as the session's file), but what the branch holds is read from the repository's refs, so a branch
  // that breaks its brief still fails here. A branch that passes those checks is not judged "Checked": the result is
  // `held` and the engine gives the task to him, so no reviewer reads a worktree another run still holds.
  if (idle) {
    try {
      clearLink(o.tree);
    } catch {
      /* no record could be read: nothing of ours to take away */
    }
    const st = await gitRead(o.tree, ['status', '--porcelain', '--untracked-files=all'], { run });
    if (!st.ok) no('the worktree could not be read');
    else if (st.stdout.trim()) no(`files were left uncommitted: ${list(st.stdout.trim().split('\n').map((l) => l.slice(3)))}`);
  }
  const d = await gitRead(o.top, ['diff', '--name-only', `${o.base}...refs/heads/${o.branch}`, '--'], { run });
  const changed = d.ok ? d.stdout.split('\n').filter(Boolean) : null;
  if (!changed) no('the branch could not be compared with where it began');
  else if (!changed.length) no('the branch changed nothing');
  const named = filesNamed(o.brief);
  if (changed && named.length) {
    const out = changed.filter((f) => !within(f, named));
    if (out.length) no(`it changed files the brief did not name: ${list(out)}`);
    else if (changed.length) words.push('it changed only the files the brief named');
  }
  if (o.check === 'file') {
    for (const f of named.filter((x) => !x.endsWith('/'))) {
      const has = await gitRead(o.top, ['cat-file', '-e', `refs/heads/${o.branch}:${f}`], { run });
      if (!has.ok) no(`${f} is not on the branch`);
      else if (changed && !changed.includes(f)) no(`${f} was not changed`);
    }
    // No file named: a writer's or researcher's branch may change only documentation or text, never code.
    if (ok && !named.length && changed) {
      const other = changed.filter((f) => !isDocs(f));
      if (other.length) no(`the brief names no file, so only documentation may change, but it changed: ${list(other)}`);
    }
    if (ok) words.push(named.length ? 'the named files are written' : `it wrote ${list(changed)} (the brief names no file)`);
  }
  if (!idle) {
    if (!ok) return { ok, words: failed.map((w) => w.slice(0, 300)) };
    return { ok: false, held: true, words: ['the check could not finish: another dashboard was still running the tests of this worktree in the box after the time one run may take, so its worktree was not read and its tests were not run'] };
  }
  if (o.check === 'tests') {
    if (!Array.isArray(o.test) || !o.test.length) no('no test command is set for this project (Work → Team), so the tests could not be run');
    else if (ok) {
      // Nothing on this computer runs a session's own test code by itself outside a box: without a yes it is not run.
      // The task waits in review, and the owner runs the tests himself if he wants them ("Run the tests here"). Not a
      // failure of the work.
      // notRunWhy (and noBox, step): why, for his card; noBox: this computer has no box that answered yes.
      const notRun = (why, { noBox = false, step = '' } = {}) => ({ ok, testsNotRun: true, notRunWhy: String(why).slice(0, 300), ...(noBox ? { noBox: true } : {}), ...(step ? { step } : {}), words: [...words, `tests not run: yours to check (${why})`].map((w) => w.slice(0, 300)) });
      const ready = await boxReady(o.box, o.checkMs ? { limitMs: o.checkMs } : {});
      if (!ready.ok) return notRun(ready.why, { noBox: !!ready.noBox || !o.box, step: ready.step || '' });
      let b;
      try {
        b = await runInBox(o.box, { top: o.top, tree: o.tree, test: o.test, timeoutMs: o.timeoutMs || GATE_MS });
      } catch (e) {
        return notRun(clean(`the box could not run them: ${e && e.message}`));
      }
      if (b.busy) return notRun('its tests run in the box now');
      const r = b.r;
      if (b.own) words.push('the worktree had its own node_modules: the tests ran with it, not with the project\'s');
      if (b.left && b.left.length) words.push(`left out of the box, as its session may not read all of it: ${list(b.left, 3)}`);
      // code null and not timed out: nothing ran (the box did not start, a folder was refused). Not the work's fault.
      if (!r || (r.code == null && !r.timedOut)) return notRun(boxWhy((r && r.why) || 'the box could not run them', o));
      const cmd = commandWords(o.test);
      const ms = o.timeoutMs || GATE_MS;
      const limit = ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`;
      boxed = true; // the tests ran in the box: Accept by itself may count them (engine.mjs)
      result = r.timedOut ? { result: 'timeout', limit } : r.ok && r.code === 0 ? { result: 'passed' } : { result: 'failed' };
      if (r.timedOut) no(`the tests did not end in time (${cmd}, in the box, stopped after ${limit})`);
      else if (r.ok && r.code === 0) words.push(`the tests passed (${cmd}, in the box, no network)`);
      else no(`the tests did not pass (${cmd}: exit code ${r.code}; they ran in the box, with no network, so a test that needs one fails there)`);
      // The worktree was clean before the run (the check above), and the product's link is gone again (runInBox): what
      // is there now the tests wrote. It stays for the next session and the reviewer, who would read a CLAUDE.md the
      // tests wrote as instructions: so the gate does not pass. (Ignored files may stay: a review starts only when
      // none of them tells a coding tool what to do, engine.mjs.)
      const after = await gitRead(o.tree, ['status', '--porcelain', '--untracked-files=all'], { run });
      if (!after.ok) no('the worktree could not be read after the tests ran');
      else if (after.stdout.trim()) no(`the tests left files in the worktree: ${list(after.stdout.trim().split('\n').map((l) => l.slice(3)))}`);
      printed = printedTail(r.out, { tree: o.tree, top: o.top });
      if (printed && r.dropped) printed = `(The tests printed more than the box keeps: these are the last lines it kept.)\n${printed}`;
    }
  }
  return { ok, words: (ok ? words : failed).map((w) => w.slice(0, 300)), ...(boxed ? { boxed: true, tests: result } : {}), ...(printed ? { printed } : {}) };
}
