// The check of a put-together (step 3 of docs/GO-LIVE.md): the project's "check" commands, run in the merged worktree,
// each a list of words without a shell, each with its time limit. One check at a time on this computer, at low priority,
// never while the computer is overloaded (the Operator's own limits: load above 1.5 per CPU, less than 10 % of the memory
// free), and through the owner's limiter when he set and confirmed one. Only after he confirmed THOSE commands for the
// project (allow.mjs): the block is read from the merged tree, so a task branch that changed it asks again.
//
// Kept as a file per tree id (git's id of the merged tree's content) in the state folder: the commands, their exit codes,
// the last 40 lines (masked as a run's text is, the home folder as ~), the times. The last RUNS_KEPT runs are kept in
// detail, and the counts of every run beside them: a tree that passed and also failed is "passed and failed",
// never "ready", however many passes came after.
//
// The check is kept for a tree, so it runs on that tree's files and nothing else: in a folder of its own, a detached
// worktree of the put-together's commit made for this run (state folder ship/checkruns) and removed after it. What a
// session left in the put-together's folder (a change, an untracked or an ignored file: a build, an .env, a cache)
// is not there, no session writes into it while it runs, and what the check writes (a log, coverage) goes with it.
// Nothing that is not committed is there either (node_modules): a check that needs it installs it (["npm", "ci"]).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { LOAD_PER_CPU, MEM_FREE_PCT } from '../operator/detect/machine.mjs';
import { stateDir } from '../paths.mjs';
import { capture } from '../setup/system.mjs';
import { gitWrite, lastLine } from '../work/git.mjs';
import { cleanText, pathsOf } from '../work/runs.mjs';
import { isAllowed, limiterOf } from './allow.mjs';
import { lockHolder, takeLock } from './lock.mjs';
import { blocksDir, readCheck, showWords } from './project.mjs';
import { alive, sameProcess, system } from '../procid.mjs';
import { commandRecord, commandRuns, endCommand, endWords, runCommand } from './runcmd.mjs';

export const RUNS_KEPT = 10;
const LAST_MAX = 6000;
const fail = (status, message, code = 'check') => Object.assign(new Error(message), { status, details: { code } });
const folder = () => path.join(stateDir(), 'ship', 'checks');
const runsDir = () => path.join(stateDir(), 'ship', 'checkruns');
const NO_HOOKS = ['-c', `core.hooksPath=${os.devNull}`];
const fileOf = (tree) => path.join(folder(), `${tree}.json`);

/** Whether this computer is too busy for a check now: { over, why }. */
export function overloaded({ load = os.loadavg()[0], cpus = os.cpus().length, mem = memory() } = {}) {
  if (cpus && load / cpus > LOAD_PER_CPU) return { over: true, why: `the computer is busy (load ${load.toFixed(1)} on ${cpus} CPUs)` };
  if (mem.total && (mem.available / mem.total) * 100 < MEM_FREE_PCT) return { over: true, why: `the computer has little free memory (${Math.round((mem.available / mem.total) * 100)} % free)` };
  return { over: false, why: null };
}
function memory() {
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t) || [])[1]) * 1024;
    const available = kb('MemAvailable');
    if (available) return { total: kb('MemTotal'), available };
  } catch {
    /* not Linux */
  }
  return { total: os.totalmem(), available: os.freemem() };
}

/** git's id of the content of HEAD in `dir` (the same merged tree gets the same id, whoever made it). */
export async function treeIdOf(dir, run = capture) {
  const r = await gitRead(dir, ['rev-parse', '--verify', 'HEAD^{tree}'], { run });
  const c = await gitRead(dir, ['rev-parse', '--verify', 'HEAD'], { run });
  if (!r.ok || !c.ok) throw fail(409, 'git cannot say what the merged tree is');
  return { tree: r.stdout.trim(), commit: c.stdout.trim() };
}

export function readChecks(tree) {
  if (!/^[0-9a-f]{40,64}$/.test(String(tree))) return null;
  let r;
  try {
    r = JSON.parse(fs.readFileSync(fileOf(tree), 'utf8'));
  } catch {
    return null;
  }
  if (!r || r.tree !== tree || !Array.isArray(r.runs)) return null;
  return closeCut(r);
}

// The check that runs now on this computer ({ tree }), beside check.lock: a check whose Hoprig was killed is found by it.
const runnerFile = () => path.join(stateDir(), 'ship', 'check-run.json');

/** Whether the process that ran `run` is shown to be gone (a run of a process that cannot be told stays as it is). */
function runnerGone(run) {
  const r = run.runner;
  if (!r || !Number.isInteger(r.pid)) return false;
  if (!alive(r.pid)) return true;
  return !!r.proc && sameProcess(r.proc, system.of([r.pid]).get(r.pid)) === false;
}

/**
 * A run of `rec` whose Hoprig was killed while it ran (its runner is gone) is closed as cut off, never as a pass or a
 * fail, and the check command it left running (its own process group) is ended. → `rec`, written when it changed.
 */
function closeCut(rec) {
  let changed = false;
  for (const run of rec.runs) {
    if (run.ok !== null || run.notCounted || !runnerGone(run)) continue;
    if (run.running) endCommand(run.running);
    Object.assign(run, { notCounted: 'it was cut off: the Hoprig that ran it ended before it did', ended: new Date().toISOString() });
    changed = true;
  }
  if (changed) writeChecks(rec);
  return rec;
}

/**
 * Before a check takes over check.lock from a Hoprig that is gone: its run is closed and its command ended. Refused
 * while that command still runs (one check at a time on this computer).
 */
async function closeLeftCheck() {
  let left;
  try {
    left = JSON.parse(fs.readFileSync(runnerFile(), 'utf8'));
  } catch {
    return;
  }
  const h = lockHolder(path.join(stateDir(), 'ship'), { name: 'check.lock' });
  if (h && !h.gone) return; // a living check: takeLock says so
  const rec = readChecks(left && left.tree);
  const run = rec && rec.runs.find((r) => r.running && r.runner && r.runner.pid === left.pid);
  if (run && run.running) {
    for (let i = 0; i < 40 && commandRuns(run.running) !== false; i++) await new Promise((res) => setTimeout(res, 50));
    if (commandRuns(run.running) !== false) throw fail(409, `a check that a Hoprig which ended had started still runs (process ${run.running.pid}): it runs one at a time`, 'busy');
  }
  fs.rmSync(runnerFile(), { force: true });
}

/**
 * What the runs of `tree` say: 'none' | 'running' | 'ready' (every run passed) | 'failed' (every run failed) |
 * 'mixed' (it passed and it failed: shown as both, never as passed), with the counts.
 */
export function verdict(rec) {
  const runs = rec ? rec.runs : [];
  const ended = runs.filter((r) => r.ok === true || r.ok === false);
  // The counts of every run the tree ever had (only the detailed runs are trimmed): a tree that failed once stays so.
  const all = totalsOf(rec);
  const passed = all.passed;
  const failed = all.failed;
  const state = runs.some((r) => r.ok === null && !r.notCounted) ? 'running' : !(passed + failed) ? 'none' : !failed ? 'ready' : !passed ? 'failed' : 'mixed';
  return { state, passed, failed, last: ended.at(-1) || null, notCounted: runs.at(-1)?.notCounted || null };
}

/** The tree's counts of every ended run: kept beside the runs, else (a record from before them) counted from the runs. */
function totalsOf(rec) {
  const t = rec && rec.totals;
  if (t && Number.isInteger(t.passed) && Number.isInteger(t.failed) && t.passed >= 0 && t.failed >= 0) return { passed: t.passed, failed: t.failed };
  const ended = (rec ? rec.runs : []).filter((r) => r.ok === true || r.ok === false);
  const passed = ended.filter((r) => r.ok).length;
  return { passed, failed: ended.length - passed };
}

/** A folder of its own for one check: a detached worktree of `commit` from the repository of `dir`, without its hooks. */
async function freshFolder(dir, commit, run) {
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  const at = path.join(runsDir(), `${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const w = await gitWrite(dir, [...NO_HOOKS, 'worktree', 'add', '--quiet', '--detach', at, commit], { run });
  if (!w.ok) {
    fs.rmSync(at, { recursive: true, force: true });
    throw fail(409, `a folder for the check could not be made (${lastLine(w).replace(/\/[^\s'"]+/g, '…')})`);
  }
  return at;
}

/** Every folder below `at` (and `at`) writable by its owner again: a check may leave one read-only (a module cache). */
function writableAll(at) {
  try {
    fs.chmodSync(at, 0o700);
    for (const e of fs.readdirSync(at, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) writableAll(path.join(at, e.name));
  } catch {
    /* gone, or not ours: the second try says it */
  }
}

/**
 * The check's folder goes, and git's note of it in the repository of `dir` (a folder git does not know is removed all
 * the same). It never throws: the lock and the next check must not depend on it. A folder that cannot be removed is
 * made writable and tried once more; when that fails too it is said in the log and left (the next check tries again).
 * → whether it went.
 */
async function dropFolder(dir, at, run) {
  await Promise.resolve(gitWrite(dir, [...NO_HOOKS, 'worktree', 'remove', '--force', at], { run })).catch(() => null);
  for (let i = 0; i < 2; i++) {
    try {
      fs.rmSync(at, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      if (i) await Promise.resolve(gitWrite(dir, [...NO_HOOKS, 'worktree', 'prune'], { run })).catch(() => null);
      return true;
    } catch (e) {
      if (i) {
        console.error(`ship: the folder of a check could not be removed (${e.code || e.message}); it is left and tried again at the next check: ${at}`);
        return false;
      }
      writableAll(at);
    }
  }
  return false;
}

/** The folders of checks whose Hoprig ended before it could remove them. Never throws. */
async function dropLeftFolders(dir, run) {
  let names = [];
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    return;
  }
  for (const n of names) {
    const pid = Number(/^(\d+)-[0-9a-f]{12}$/.exec(n)?.[1]);
    if (pid && pid !== process.pid && !alive(pid)) await dropFolder(dir, path.join(runsDir(), n), run);
  }
}

function writeChecks(rec) {
  fs.mkdirSync(folder(), { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(rec.tree)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, fileOf(rec.tree));
}

/** A command's last lines as they may be kept and shown: masked, this computer's paths short, the home folder as ~. */
export const maskLines = (text) => cleanText(text, LAST_MAX, pathsOf({ home: os.homedir() }));

/**
 * Run the check of the merged worktree `dir` of the project at real path `real`. `o`: { run (git), busy (overloaded()
 * stand-in), env, by ('owner' | 'auto') }. → the kept record of its tree, with this run last.
 */
export async function runCheck(real, dir, { run = capture, busy = overloaded, env = process.env, by = 'owner', together = null, started = () => {} } = {}) {
  const { check, errors } = readCheck(blocksDir(real, dir));
  if (!check) throw fail(409, errors.length ? `the check cannot be used: ${errors[0]}` : 'this project has no "check" in its project.json');
  if (!isAllowed(real, 'check', check)) throw fail(409, 'these check commands are not confirmed for this project on this computer: look at them and confirm them first', 'not-confirmed');
  const lim = limiterOf();
  if (lim.run && !lim.allowed) throw fail(409, 'the words before each check command in Settings → Go live changed after you confirmed them: confirm them again there first', 'limiter-changed');
  const b = busy();
  if (b.over) throw fail(409, `the check waits: ${b.why}`, 'overloaded');
  await closeLeftCheck();
  const release = takeLock(path.join(stateDir(), 'ship'), 'check', { name: 'check.lock' });
  let own = null;
  try {
    const { tree, commit } = await treeIdOf(dir, run);
    await dropLeftFolders(dir, run);
    own = await freshFolder(dir, commit, run);
    // The commands as the commit has them (the put-together's folder may hold a project.json changed by hand).
    const { check: commands } = readCheck(blocksDir(real, own));
    if (!commands || !isAllowed(real, 'check', commands)) throw fail(409, 'the check commands of the committed project.json are not confirmed for this project on this computer: look at them and confirm them first', 'not-confirmed');
    const rec = readChecks(tree) || { v: 1, tree, runs: [] };
    rec.totals = totalsOf(rec);
    const one = { at: new Date().toISOString(), commit, by, real, together, ok: null, commands: [], ended: null, runner: { pid: process.pid, proc: system.self() }, running: null };
    rec.runs = [...rec.runs.filter((r) => r.ok !== null || r.notCounted), one].slice(-RUNS_KEPT);
    writeChecks(rec);
    fs.writeFileSync(runnerFile(), `${JSON.stringify({ tree, pid: process.pid })}\n`, { mode: 0o600 });
    started(rec);
    let ok = true;
    for (const c of commands) {
      // endGroup: a check has no server that must outlive it; what it left running would hold its folder (and write into it).
      const r = await runCommand(c.run, { cwd: own, minutes: c.minutes, env, low: true, prefix: lim.run, branches: true, endGroup: true, started: (child) => {
        one.running = commandRecord(child, c.minutes);
        writeChecks(rec);
      } });
      one.running = null;
      one.commands.push({ shown: showWords(c.run), code: r.code, ok: r.ok, timedOut: r.timedOut, ended: endWords(r, c.minutes), ms: r.ms, last: maskLines(r.last) });
      writeChecks(rec);
      if (!r.ok) {
        ok = false;
        break;
      }
    }
    one.ok = ok;
    rec.totals[ok ? 'passed' : 'failed'] += 1;
    one.ended = new Date().toISOString();
    writeChecks(rec);
    return rec;
  } finally {
    // The lock is released in a step of its own, whatever the clean-up does (it never throws, and if it did, still).
    try {
      if (own) await dropFolder(dir, own, run);
    } finally {
      try {
        fs.rmSync(runnerFile(), { force: true });
      } finally {
        release();
      }
    }
  }
}
