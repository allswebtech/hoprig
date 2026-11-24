// Going live (step 4 of docs/GO-LIVE.md, and a step cut off): ONE step, on the owner's tap (or by itself where he typed it: auto.mjs),
// for a put-together whose check passed. Its parts, each written to a journal and flushed to disk before it begins:
//
//   picture   a picture of the "keep" paths (picture.mjs: names, counts, bytes; the hashes only in the state folder)
//   update    the live "update" commands, in the project's folder, {commit} {branch} {tree} {before} replaced
//   verify    the "verify" commands and addresses
//   again     the picture again, compared with the first
//   → "live" (verified and nothing kept changed: a line "live since HH:MM" in Activity), or "not verified" / "kept
//     paths changed", which names what, and offers "take back" (or runs it by itself where he chose that)
//   back      the "back" commands, on his press
//
// The journal lies beside the lock (lock.mjs) in the repository's git folder: a step cut off by a kill is finished by the
// next look (finishCut: the dashboard's start, the page, `hoprig ship status`). Cut before the update began: closed as
// "did not start". Cut later: verify and the picture again, then "live" or the offer to take back. Cut while taking back:
// the offer again. "Live" is said only after a verify. Whoever finishes a step after its update (this process, the next
// dashboard, the helper of an update that restarts it) first makes the step's claim file exclusively: never two of them.
//
// The live block is read from the merged tree and must be the one the owner confirmed (allow.mjs), checked again before
// every part that runs a command, also from the journal. Hoprig's own code never pushes, merges into a default branch
// or tags: what runs is the project's confirmed commands, nothing else.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createActivityLog } from '../automation/store.mjs';
import { gitRead } from '../gitread.mjs';
import { stateDir } from '../paths.mjs';
import { filedProcess, system } from '../procid.mjs';
import { capture } from '../setup/system.mjs';
import { writeSynced } from '../work/journal.mjs';
import { isAllowed, switchesOf } from './allow.mjs';
import { maskLines, readChecks, treeIdOf, verdict } from './check.mjs';
import { gitFolder, lockHolder, takeLock } from './lock.mjs';
import { comparePictures, shownPicture, takePicture } from './picture.mjs';
import { blocksDir, readLive, resolveWords, showWords } from './project.mjs';
import { restartsDashboard } from './restart.mjs';
import { commandRecord, commandRuns, endCommand, endWords, pastLimit, runCommand } from './runcmd.mjs';

export const JOURNAL_NAME = 'hoprig-ship.json';
const fail = (status, message, code = 'live') => Object.assign(new Error(message), { status, details: { code } });
const keyOf = (real) => crypto.createHash('sha256').update(real).digest('hex').slice(0, 24);
const lastFile = (real) => path.join(stateDir(), 'ship', 'last', `${keyOf(real)}.json`);
// The open steps of this computer, one small file each ({ real, top }): what the dashboard's start and its ticks look at,
// and nothing else (with no open step and no switch on, nothing of going live reads a project or runs a program).
const openFile = (real) => path.join(stateDir(), 'ship', 'open', `${keyOf(real)}.json`);
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helper.mjs');
export function openSteps() {
  let names = [];
  try {
    names = fs.readdirSync(path.join(stateDir(), 'ship', 'open')).filter((n) => /^[0-9a-f]{24}\.json$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(stateDir(), 'ship', 'open', n), 'utf8'));
      if (typeof r.real === 'string' && `${keyOf(r.real)}.json` === n) out.push(r.real);
    } catch {
      /* half written: the step's own end removes it */
    }
  }
  return out;
}

/**
 * The repository of the project folder `real`: the folder itself when it is one, else its code/<its name> or the first
 * repository in code/ (a project that keeps its code under code/, as a parent of notes and code does). null: none.
 */
export function repoOf(real) {
  if (fs.existsSync(path.join(real, '.git'))) return real;
  const code = path.join(real, 'code');
  const named = path.join(code, path.basename(real));
  if (fs.existsSync(path.join(named, '.git'))) return fs.realpathSync(named);
  try {
    for (const n of fs.readdirSync(code).sort()) if (fs.existsSync(path.join(code, n, '.git'))) return fs.realpathSync(path.join(code, n));
  } catch {
    /* no code folder */
  }
  return null;
}
const pictureFile = (id, n) => path.join(stateDir(), 'ship', 'pictures', `${id}-${n}.json`);
export const activity = () => createActivityLog(path.join(stateDir(), 'automation.log'));
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const running = new Set(); // step ids this process runs now

export const journalPath = (gitDir) => path.join(gitDir, JOURNAL_NAME);
export function readJournal(gitDir) {
  try {
    const r = JSON.parse(fs.readFileSync(journalPath(gitDir), 'utf8'));
    return r && r.v === 1 && typeof r.id === 'string' && /^[0-9a-f]{16}$/.test(r.id) ? r : { unreadable: true };
  } catch (e) {
    return e.code === 'ENOENT' ? null : { unreadable: true };
  }
}
const writeJournal = (gitDir, j) => writeSynced(journalPath(gitDir), `${JSON.stringify({ ...j, written: new Date().toISOString() }, null, 2)}\n`);
export function readLast(real) {
  try {
    return JSON.parse(fs.readFileSync(lastFile(real), 'utf8'));
  } catch {
    return null;
  }
}

const claimFile = (gitDir, id) => path.join(gitDir, `hoprig-ship-${id}.claim`);

/** Whether the claim `c` in `file` belongs to a process that is gone (a half-written one: after a minute). */
function claimGone(file, c, ident) {
  if (c && Number.isInteger(c.pid)) return filedProcess(file, c, { ident }) === false;
  try {
    return Date.now() - fs.statSync(file).mtimeMs > 60_000;
  } catch {
    return true;
  }
}

/**
 * The claim of finishing step `id` (after its update): made exclusively, with the pid and start of its process.
 * → true for the one who holds it. A claim of a process that is gone (the dashboard the update restarted, killed after it
 * claimed) holds nothing: it is moved away by a rename, which only one taker wins, and claimed again exclusively.
 */
export function claimStep(gitDir, id, who, { ident = system } = {}) {
  const file = claimFile(gitDir, id);
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ who, pid: process.pid, proc: ident.self(), at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const c = claimOf(gitDir, id);
    if (c && c.pid === process.pid && (!c.proc || c.proc === ident.self())) return true;
    if (!claimGone(file, c, ident)) return false;
    const away = `${file}.${process.pid}.gone`;
    try {
      fs.renameSync(file, away);
      fs.rmSync(away, { force: true });
    } catch {
      /* another taker moved it first: the exclusive write above decides */
    }
  }
  return false;
}

/** Whether a living process holds the claim of step `id` (the helper then leaves the step to it). */
export function claimHeld(gitDir, id, { ident = system } = {}) {
  const c = claimOf(gitDir, id);
  return !!c && !claimGone(claimFile(gitDir, id), c, ident);
}
export function claimOf(gitDir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), 'utf8'));
  } catch {
    return null;
  }
}

/** The picture of `keep` (paths in the project, or "~/..." in the home folder). */
export function pictureOf(top, keep) {
  const home = os.homedir();
  const a = takePicture(top, keep.filter((k) => !k.startsWith('~/')));
  const b = takePicture(home, keep.filter((k) => k.startsWith('~/')).map((k) => k.slice(2)));
  const files = { ...a.files };
  for (const [k, v] of Object.entries(b.files)) files[`~/${k}`] = v;
  const paths = keep.map((k) => (k.startsWith('~/') ? { ...b.paths.find((p) => p.path === k.slice(2)), path: k } : a.paths.find((p) => p.path === k)));
  return { paths, files };
}

/** Whether the url answers `status` within `seconds` (asked once a second). */
async function answers({ url, status, seconds }) {
  const until = Date.now() + seconds * 1000;
  let seen = 'no answer';
  for (;;) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1000, Math.min(5000, until - Date.now()))) });
      await r.arrayBuffer().catch(() => {});
      if (r.status === status) return { ok: true, ended: `answered ${status}` };
      seen = `answered ${r.status}`;
    } catch {
      seen = 'no answer';
    }
    if (Date.now() >= until) return { ok: false, ended: `${seen} (it should answer ${status} within ${seconds} s)` };
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/**
 * Run one list of commands (and, for verify, addresses) of the live block. → { ok, results }. With `gitDir` and `part`
 * ('update', 'back'), the journal says which command runs (its pid and start) before it runs, and how many are done
 * after each: a look after a cut knows how far it got and whether that command still runs.
 */
async function runList(list, j, { env, gitDir = null, part = null }) {
  const results = [];
  for (const [i, c] of list.entries()) {
    if (c.url) {
      const a = await answers(c);
      results.push({ shown: c.url, ok: a.ok, ended: a.ended, last: '' });
      if (!a.ok) return { ok: false, results };
      continue;
    }
    const words = resolveWords(c.run, j.values);
    const started = gitDir ? (child) => {
      j.running = { part, index: i, ...commandRecord(child, c.minutes) };
      writeJournal(gitDir, j);
    } : () => {};
    // GitHub's token only when the confirmed block names that it needs it; a provider's key never (runcmd.mjs).
    const r = await runCommand(words, { cwd: j.real, minutes: c.minutes, env, branches: !(j.live && j.live.github === true), started });
    results.push({ shown: showWords(words), ok: r.ok, ended: endWords(r, c.minutes), last: maskLines(r.last) });
    if (gitDir) {
      Object.assign(j, { running: null, [`${part}Done`]: i + 1 });
      writeJournal(gitDir, j);
    }
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

/** What a cut update left undone, in words: the command that ran when it was cut, and those that never ran. */
function cutUpdateWords(update, j, at) {
  const shown = (c) => showWords(resolveWords(c.run, j.values));
  const rest = update.slice(at + 1).map(shown);
  return `the update was cut off while ${shown(update[at])} ran${rest.length ? `, and ${rest.join('; ')} did not run` : ''}`;
}

/** Whether the journal's block is confirmed for its project on this computer now. */
const stillConfirmed = (j) => !!j.live && isAllowed(j.real, 'live', j.live);

/** The values put into the confirmed words come from git, never from a person (an option, a path runs nothing). */
function valuesOk(j) {
  const v = j.values || {};
  const hex = (x) => typeof x === 'string' && /^[0-9a-f]{40,64}$/.test(x);
  return hex(v.commit) && hex(v.tree) && hex(v.before) && typeof v.branch === 'string' && /^work\/[a-z0-9][a-z0-9-]{0,40}-all$/.test(v.branch);
}

/** The confirmed block of the journal, checked again against the settings (a changed journal runs nothing). */
function confirmedLive(j) {
  if (!stillConfirmed(j)) throw fail(409, 'the go-live commands of this step are not the ones confirmed for this project on this computer: nothing runs', 'not-confirmed');
  if (!valuesOk(j)) throw fail(409, 'the journal of this step holds values git did not give: nothing runs', 'not-confirmed');
  return j.live;
}

/**
 * Whether the journal `j` found in the git folder `gitDir` is of that repository: its project's repository keeps its
 * files there, and the commits it would put into the words are in it. A journal moved there or changed by hand (another
 * project's confirmed block, any commit id) runs nothing.
 */
async function ownJournal(gitDir, j, run = capture) {
  const top = typeof j.real === 'string' && path.isAbsolute(j.real) ? repoOf(j.real) : null;
  let mine = false;
  try {
    mine = !!top && (await gitFolder(top, run)) === fs.realpathSync(gitDir);
  } catch {
    mine = false;
  }
  for (const c of mine ? [j.values.before, j.values.commit] : []) {
    if (!(await gitRead(top, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], { run })).ok) mine = false;
  }
  if (!mine) throw fail(409, 'the journal of this step names another project, or commits that are not in its repository: nothing runs', 'not-confirmed');
}

const dropPictures = (id) => {
  for (const n of [1, 2]) fs.rmSync(pictureFile(id, n), { force: true });
};

function end(gitDir, j, outcome, extra = {}) {
  Object.assign(j, { part: 'end', outcome, endedAt: new Date().toISOString(), running: null, ...extra });
  writeSynced(lastFile(j.real), `${JSON.stringify(j, null, 2)}\n`);
  fs.rmSync(journalPath(gitDir), { force: true });
  fs.rmSync(openFile(j.real), { force: true });
  fs.rmSync(path.join(gitDir, `hoprig-ship-${j.id}.claim`), { force: true });
  // The first picture stays (mode 600, in the state folder) while the step can still be taken back: a take-back compares
  // the kept files with it, also after "live". It goes once the step is taken back or did not start, or at the
  // project's next go-live (dropPictures).
  const pic = j.first || j.id;
  if (outcome === 'taken-back' || outcome === 'did-not-start') dropPictures(pic);
  else if (outcome !== 'not-verified' && outcome !== 'changed') fs.rmSync(pictureFile(pic, 2), { force: true });
  return j;
}

/** After the update: verify, the picture again, then "live" or the offer to take back (or back by itself). */
async function finishAfterUpdate(gitDir, j, { env, cut = false, updateCut = null }) {
  const live = confirmedLive(j);
  Object.assign(j, { part: 'verify' });
  writeJournal(gitDir, j);
  const v = await runList(live.verify, j, { env });
  j.parts.push({ part: 'verify', ok: v.ok, results: v.results, at: new Date().toISOString() });
  j.part = 'again';
  writeJournal(gitDir, j);
  const first = JSON.parse(fs.readFileSync(pictureFile(j.id, 1), 'utf8'));
  const second = pictureOf(j.real, live.keep);
  writeSynced(pictureFile(j.id, 2), JSON.stringify(second));
  const cmp = comparePictures(first, second);
  j.pictures.after = shownPicture(second);
  const note = cut ? ' (finished after it was cut off)' : '';
  const keptWords = () => `kept files changed: ${cmp.changed.map((c) => `${c.path} (${c.what})`).join(', ')}${cmp.more ? ` and ${cmp.more} more` : ''}`;
  // An update that did not run to its end is never "live", whatever the verify says: what it did and did not do is said.
  if (updateCut) {
    const why = `${updateCut}. ${v.ok ? 'It answers as it should' : `It does not answer as it should: ${v.results.at(-1).shown} ${v.results.at(-1).ended}`}${cmp.same ? '' : `; ${keptWords()}`}`;
    activity().add({ automation: 'go-live', did: `${j.name}: not live: ${why}`, outcome: 'failed' });
    return backByItself(end(gitDir, j, 'update-cut', { why, changed: cmp.changed, more: cmp.more }), { env });
  }
  if (v.ok && cmp.same) {
    const at = new Date();
    activity().add({ automation: 'go-live', did: `${j.name}: live since ${hhmm(at)} (tree ${j.values.tree.slice(0, 12)})${note}` });
    return end(gitDir, j, 'live', { liveSince: at.toISOString() });
  }
  const why = !v.ok ? `after the update it did not answer as it should: ${v.results.at(-1).shown} ${v.results.at(-1).ended}` : `kept files changed: ${cmp.changed.map((c) => `${c.path} (${c.what})`).join(', ')}${cmp.more ? ` and ${cmp.more} more` : ''}`;
  activity().add({ automation: 'go-live', did: `${j.name}: not live${note}: ${why}`, outcome: 'failed' });
  const r = end(gitDir, j, v.ok ? 'changed' : 'not-verified', { why, changed: cmp.changed, more: cmp.more });
  return backByItself(r, { env });
}

/**
 * "Take it back by itself" after a step that ended not live (`r`, its record): under the lock its caller holds. A
 * take-back that cannot run is said in Activity and in the record, which still offers the press.
 */
async function backByItself(r, { env }) {
  if (!switchesOf(r.real).autoBack) return r;
  try {
    // A back that restarts the dashboard would end the turns that started since it came back, and nothing by itself
    // cuts a running turn: only the page, on the owner's press, takes such a step back.
    if (restartsDashboard(r.real, r.live)) throw new Error('its back restarts the dashboard, and nothing by itself ends a running turn');
    return await takeBack(r.real, { env, by: 'auto', locked: true });
  } catch (e) {
    const why = String(e.message).slice(0, 200);
    activity().add({ automation: 'go-live', did: `${r.name}: it was not taken back by itself: ${why}`, outcome: 'failed' });
    Object.assign(r, { autoBackFailed: why });
    writeSynced(lastFile(r.real), `${JSON.stringify(r, null, 2)}\n`);
    return r;
  }
}

/**
 * What a go-live of the put-together `t` (together.mjs record, finished) would run: { live, values, shown } or a refusal
 * (409) that says why. The check must have passed, and never failed, on this exact tree.
 */
export async function planLive(real, t, { run = capture, by = 'owner' } = {}) {
  if (!t || !t.finished || !t.dir || !fs.existsSync(t.dir)) throw fail(409, 'put the tasks together first');
  const { live, errors } = readLive(blocksDir(real, t.dir));
  if (!live) throw fail(409, errors.length ? `the go-live block cannot be used: ${errors[0]}` : 'this project has no "live" in its project.json');
  const { tree, commit } = await treeIdOf(t.dir, run);
  const v = verdict(readChecks(tree));
  // A tree that passed and also failed goes live only on the owner's own tap, after the page said exactly that, and
  // only when its last run passed; by itself never.
  const tapMixed = v.state === 'mixed' && by !== 'auto' && v.last && v.last.ok;
  if (v.state !== 'ready' && !tapMixed) throw fail(409, v.state === 'mixed' ? (by === 'auto' ? 'the check of this tree passed and also failed: it does not go live by itself' : 'the last check of this tree failed: it does not go live') : 'the check of this tree has not passed', 'not-checked');
  const head = await gitRead(t.top, ['rev-parse', '--verify', 'HEAD'], { run });
  const values = { commit, branch: t.branch, tree, before: head.ok ? head.stdout.trim() : '' };
  const show = (list) => list.map((c) => (c.url ? `${c.url} answers ${c.status} within ${c.seconds} s` : showWords(resolveWords(c.run, values))));
  return { live, values, checked: v.state, confirmed: isAllowed(real, 'live', live), shown: { update: show(live.update), verify: show(live.verify), back: show(live.back), keep: [...live.keep] } };
}

/**
 * The go-live of put-together `t` in the project at real path `real`. Resolves when the step is under way (its journal
 * written): { id, done } (done: the promise of its end). `beforeUpdate(j)`: what a restart needs first (the wait for the turns it would cut);
 * without it a step whose update restarts the dashboard is refused.
 */
export async function goLive(real, t, { run = capture, env = process.env, by = 'owner', beforeUpdate = null, dash = null } = {}) {
  const plan = await planLive(real, t, { run, by });
  // A restart cuts what runs in the dashboard: only a caller that waits for it (the dashboard's beforeUpdate) may start one.
  if (restartsDashboard(real, plan.live) && !beforeUpdate) throw fail(409, 'its update restarts the dashboard: it goes live from the dashboard only, which waits for the turns a restart would cut', 'page-only');
  if (!plan.confirmed) throw fail(409, 'these go-live commands are not confirmed for this project on this computer: look at them and confirm them first', 'not-confirmed');
  const gitDir = await gitFolder(t.top, run);
  const release = takeLock(gitDir, 'go live');
  // A new go-live of the project: the last one can no longer be taken back, its picture goes.
  const prev = readLast(real);
  if (prev && typeof (prev.first || prev.id) === 'string' && /^[0-9a-f]{16}$/.test(prev.first || prev.id)) dropPictures(prev.first || prev.id);
  const id = crypto.randomBytes(8).toString('hex');
  const j = {
    v: 1, id, first: id, real, top: t.top, name: t.name, dash, owner: process.pid, together: t.id, by, live: plan.live, values: plan.values,
    restarts: restartsDashboard(real, plan.live), at: new Date().toISOString(), part: 'picture', parts: [], pictures: {}, outcome: null, helper: null,
  };
  if (!j.values.before) {
    release();
    throw fail(409, 'git cannot say which commit the project is on now: nothing to take it back to');
  }
  writeJournal(gitDir, j);
  writeSynced(openFile(real), `${JSON.stringify({ real, top: t.top })}\n`);
  running.add(j.id);
  const done = (async () => {
    try {
      const first = pictureOf(j.real, plan.live.keep);
      writeSynced(pictureFile(j.id, 1), JSON.stringify(first));
      j.pictures.before = shownPicture(first);
      if (beforeUpdate) {
        // While running turns are waited for nothing has run yet: the page says that, not "updating".
        if (j.restarts) {
          j.waiting = true;
          writeJournal(gitDir, j);
        }
        await beforeUpdate(j, gitDir);
        delete j.waiting;
      }
      confirmedLive(j);
      j.part = 'update';
      j.updateAt = new Date().toISOString();
      writeJournal(gitDir, j);
      // An update that restarts the dashboard running this step: a small helper of its own, started before the
      // update, takes it back when no dashboard answers within the time limit.
      if (j.restarts) {
        const h = spawn(process.execPath, [HELPER, gitDir], { detached: true, stdio: 'ignore', env, windowsHide: true });
        h.unref();
        j.helper = h.pid;
        writeJournal(gitDir, j);
      }
      j.updateDone = 0;
      const u = await runList(plan.live.update, j, { env, gitDir, part: 'update' });
      j.parts.push({ part: 'update', ok: u.ok, results: u.results, at: new Date().toISOString() });
      if (!claimStep(gitDir, j.id, 'dashboard')) return readLast(real);
      if (!u.ok) {
        activity().add({ automation: 'go-live', did: `${j.name}: not live: the update failed`, outcome: 'failed' });
        const why = `the update did not pass: ${u.results.at(-1).shown} ${u.results.at(-1).ended}`;
        const r = end(gitDir, j, 'not-verified', { why, changed: [], more: 0, updateFailed: true });
        return await backByItself(r, { env });
      }
      return await finishAfterUpdate(gitDir, j, { env });
    } catch (e) {
      // A step that cannot go on before its update did not start; after it, it is left for the next look.
      if (j.part === 'picture') {
        activity().add({ automation: 'go-live', did: `${j.name}: did not start: ${e.message.slice(0, 200)}`, outcome: 'failed' });
        return end(gitDir, j, 'did-not-start', { why: e.message.slice(0, 300) });
      }
      throw e;
    } finally {
      running.delete(j.id);
      release();
    }
  })();
  done.catch(() => {});
  return { id: j.id, done };
}

/** Take back the last go-live of the project at `real`: its confirmed "back" commands, in the project's folder. */
export async function takeBack(real, { run = capture, env = process.env, by = 'owner', locked = false } = {}) {
  const last = readLast(real);
  if (!last || !['not-verified', 'changed', 'update-cut', 'live', 'back-failed', 'back-cut'].includes(last.outcome)) throw fail(409, 'there is no go-live of this project to take back');
  const gitDir = await gitFolder(last.top || real, run);
  const release = locked ? () => {} : takeLock(gitDir, 'take back');
  try {
    const j = { ...last, id: crypto.randomBytes(8).toString('hex'), of: last.id, first: last.first || last.id, part: 'back', by, at: new Date().toISOString(), outcome: null };
    const live = confirmedLive(j);
    if (j.real !== real) throw fail(409, 'the record of the last go-live names another project: nothing runs', 'not-confirmed');
    await ownJournal(gitDir, j, run);
    writeJournal(gitDir, j);
    writeSynced(openFile(real), `${JSON.stringify({ real, top: j.top })}\n`);
    j.backDone = 0;
    const b = await runList(live.back, j, { env, gitDir, part: 'back' });
    j.parts = [...(j.parts || []), { part: 'back', ok: b.ok, results: b.results, at: new Date().toISOString() }];
    return closeBack(gitDir, j, b.ok, { why: b.ok ? null : `${b.results.at(-1).shown} ${b.results.at(-1).ended}` });
  } finally {
    release();
  }
}

/** The end of a take-back: the kept files compared with the picture from before the go-live, Activity, the record. */
function closeBack(gitDir, j, ok, { why = null, note = '' } = {}) {
  let same = null;
  try {
    same = comparePictures(JSON.parse(fs.readFileSync(pictureFile(j.first || j.of || j.id, 1), 'utf8')), pictureOf(j.real, j.live.keep));
  } catch {
    /* no first picture kept */
  }
  activity().add({ automation: 'go-live', did: `${j.name}: ${ok ? 'taken back' : 'taking back failed'}${j.by === 'auto' ? ' by itself' : ''}${note}`, outcome: ok ? 'ok' : 'failed' });
  return end(gitDir, j, ok ? 'taken-back' : 'back-failed', { why, keptSame: same ? same.same : null, changed: same ? same.changed : [] });
}

/**
 * The next look (the dashboard's start, the page, `hoprig ship status`): a step whose process is gone is finished here.
 * → the journal as it stands (running elsewhere or here), the finished record, or null when there was none.
 */
export async function finishCut(real, { run = capture, env = process.env, who = 'dashboard' } = {}) {
  let gitDir;
  try {
    const top = repoOf(real);
    if (!top) return null;
    gitDir = await gitFolder(top, run);
  } catch {
    return null;
  }
  const j = readJournal(gitDir);
  if (!j) {
    fs.rmSync(openFile(real), { force: true });
    return null;
  }
  if (j.unreadable) return { unreadable: true, outcome: null, why: 'the journal of a go-live cannot be read: look at it before anything goes live again' };
  if (running.has(j.id)) return { ...j, runningHere: true };
  if (j.real !== real) return { ...j, unreadable: true, outcome: null, why: 'the journal of a go-live in this repository names another project: look at it before anything goes live again' };
  const h = lockHolder(gitDir);
  if (h && !h.gone && !h.mine) return { ...j, runningElsewhere: true };
  if (claimHeld(gitDir, j.id)) return { ...j, claimedBy: (claimOf(gitDir, j.id) || {}).who || 'another' };
  let release;
  try {
    release = takeLock(gitDir, 'finish a go-live');
  } catch {
    return { ...j, runningElsewhere: true };
  }
  try {
    if (j.part === 'picture') {
      activity().add({ automation: 'go-live', did: `${j.name}: did not start (it was cut off before the update)`, outcome: 'failed' });
      return end(gitDir, j, 'did-not-start', { why: 'it was cut off before the update began; nothing was run' });
    }
    // Two questions, decided apart. GENUINE: the journal is this repository's own (its project, commits that are in it,
    // values git gave): one that is not ends nothing and runs nothing, and is said. STILL CONFIRMED: its block is the
    // one confirmed here now. A genuine journal whose block was changed and confirmed again, or forgotten, since the
    // step began is closed: the command it left running is ended, nothing more of it runs, and Activity says so.
    const cmd = j.running;
    let genuine = valuesOk(j);
    if (genuine) genuine = await ownJournal(gitDir, j, run).then(() => true, () => false);
    if (!genuine) {
      confirmedLive(j);
      await ownJournal(gitDir, j, run);
      throw fail(409, 'the journal of this step holds values git did not give: nothing runs', 'not-confirmed');
    }
    if (!stillConfirmed(j)) {
      if (cmd) endCommand(cmd);
      const why = `its go-live commands are no longer the ones confirmed on this computer (they were changed or the yes was taken back after it began): nothing more ran${j.part === 'picture' ? '' : '. The project may be part-way updated: look at it, then go live again'}`;
      activity().add({ automation: 'go-live', did: `${j.name}: not confirmed: nothing more ran (it was cut off, and its commands changed since)`, outcome: 'failed' });
      return end(gitDir, j, 'not-confirmed', { why });
    }
    // A command that ran when the step was cut off runs on in its own process group: each look waits for it, and at its
    // time limit it is ended with everything it started. Only then is the step finished.
    if (cmd && commandRuns(cmd) !== false && !pastLimit(cmd)) return { ...j, commandRunning: true };
    if (cmd) endCommand(cmd);
    if (j.part === 'back') {
      // A project whose back restarts the dashboard (Hoprig's own back checks out {before} and restarts): a cut while
      // its last back command ran, after all before it were done, is that restart. The dashboard that came back
      // finishes it; any other cut is said as such and offers the take-back again.
      const backs = j.live && Array.isArray(j.live.back) ? j.live.back.length : 0;
      const restarted = j.restarts && backs > 0 && j.backDone === backs - 1 && (!cmd || (cmd.part === 'back' && cmd.index === backs - 1));
      if (restarted) return closeBack(gitDir, j, true, { why: 'its last command restarted the dashboard, and the dashboard that came back finished it', note: ' (the dashboard restarted)' });
      return end(gitDir, j, 'back-cut', { why: 'taking back was cut off: take it back again' });
    }
    if (!claimStep(gitDir, j.id, who)) return { ...j, claimedBy: (claimOf(gitDir, j.id) || {}).who || 'another' };
    const live = confirmedLive(j);
    await ownJournal(gitDir, j, run);
    const done = Number.isInteger(j.updateDone) ? j.updateDone : 0;
    let updateCut = null;
    if (j.part === 'update' && done < live.update.length) {
      const at = cmd && cmd.part === 'update' && Number.isInteger(cmd.index) ? cmd.index : done;
      // A project whose update restarts the dashboard: the restart, its last update command, cuts the step.
      if (!(j.restarts && at === live.update.length - 1)) updateCut = cutUpdateWords(live.update, j, at);
    }
    return await finishAfterUpdate(gitDir, j, { env, cut: true, updateCut });
  } finally {
    release();
  }
}

/**
 * The helper's part (helper.mjs): no dashboard answered after an update that restarts it. The step is claimed
 * exclusively (never both the helper and a dashboard), the confirmed "back" checked again against the settings, run,
 * and the outcome written. → the record, or null when there was nothing for the helper to do.
 */
export async function helperBack(gitDir, { env = process.env } = {}) {
  const j = readJournal(gitDir);
  if (!j || j.unreadable || j.part === 'end' || !j.restarts) return null;
  if (!claimStep(gitDir, j.id, 'helper')) return null;
  const live = confirmedLive(j);
  await ownJournal(gitDir, j);
  const release = takeLock(gitDir, 'take back (helper)');
  try {
    j.part = 'back';
    writeJournal(gitDir, j);
    const b = await runList(live.back, j, { env });
    j.parts.push({ part: 'back', ok: b.ok, results: b.results, at: new Date().toISOString(), by: 'helper' });
    activity().add({ automation: 'go-live', did: `${j.name}: no dashboard answered after the update: ${b.ok ? 'taken back by the helper' : 'the helper could not take it back'}`, outcome: 'failed' });
    return end(gitDir, j, b.ok ? 'taken-back' : 'back-failed', { why: b.ok ? 'no dashboard answered after the update, so the helper took it back' : `${b.results.at(-1).shown} ${b.results.at(-1).ended}`, changed: [], more: 0 });
  } finally {
    release();
  }
}
