// "Save": the Work file committed by name and sent to the branch's server branch, as one unit that either reaches the
// server or stays as a change in the file that is not committed. There are no saves "not sent yet":
//   look (fetch) → merge by item when the server changed the list → fast-forward → write → commit → send.
// When the send fails (no connection, the server moved again, it refused), the commit just made is taken back: the
// branch goes back to where it was before that commit, the file keeps its content, nothing else is touched, and the
// answer says "Not saved to git: <why>". A repository with no server branch: the save is the commit alone.
//
// What it will do is worked out first (saveplan.mjs) and shown; everything it decides is read after the fetch.
//   - the repository's lock (lock.mjs takeRepoLock) is held from the fetch to the send: one save at a time, and never
//     while the workspace's upkeep commits, fetches, fast-forwards or sends in the same repository;
//   - before the first change to the repository a journal is written and flushed to disk (journal.mjs): a save killed
//     between two steps is finished, or shown, the next time anything looks at the Work list (resume.mjs);
//   - a merge: his list is kept in the repository too (kept.mjs: a blob under a ref of Hoprig's own), the working file
//     is put back to its last commit, the server's commits come in by fast-forward, the merged list is written and
//     committed. Nothing is ever forced, rebased or moved over the owner's own commits;
//   - the owner may work in the same repository at the same moment (a commit, a switch of branch, an edit): the branch
//     must still be on the commit the plan judged when the file's lock is taken (else "moved", nothing done), and on
//     the commit the save stands on right before its commit; the save's own commit is known for certain (made on that
//     commit, of the Work file alone, with the save's subject), never read from HEAD; when anything of his came in
//     after it, the save touches nothing more and says how things stand;
//   - the commit names its file (`git commit -- <file>`), so nothing else that is changed or staged goes in;
//   - the send is one commit, named by its id, to one branch (git.mjs sendArgs): never his tags, never another
//     branch, never a commit of his that came in meanwhile; right before it, what lies between the server's commit
//     and that id is checked once more against the rule of git.mjs sortUnsent. A failed send takes the commit back
//     only while HEAD is on that branch, the branch is exactly on the save's commit and the file is as committed;
//   - a branch that git sends to another place than the one it follows (saveplan.mjs `elsewhere`): the commit alone;
//   - every answer that fails says what was done and how the repository stands; none says "nothing was changed"
//     unless nothing was.
// The lock of the file (lock.mjs withLock) is held from the last look at the file to the commit, never across the
// fetch or the send. git's own words go to `detail` (the server's log, the command line), never to the page.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { blobId, blobOnDisk, branchesWith, gitWrite, indexEntry, isAncestor, lastLine, nameCommits, repoInfo, sendArgs, sendFailure, setIndexEntry, sortUnsent, standing, unsentCommits } from './git.mjs';
import { dropJournal, keptAt, writeJournal } from './journal.mjs';
import { dropKept, keepList, keptShow } from './kept.mjs';
import { takeRepoLock, withLock } from './lock.mjs';
import { NOT_SAVED, cap, fileHash, isMissionFile, publicPlan, s, savePlan } from './saveplan.mjs';
import { isRunFile } from './runs.mjs';
import { checkPlanCommits, planFileKind } from './plans.mjs';

/** A file Work commits beside the list: a run record of its name, or a plan's file or note of Work's. */
const isExtra = (file) => isRunFile(file) || ['plan', 'note'].includes(planFileKind(file)) || isMissionFile(file);
import { writeText } from './store.mjs';

export { fileHash, publicPlan, savePlan };
export { dropInterrupted } from './resume.mjs';

// A test's way to end the process right after one step of a save (the proof that an interrupted save loses nothing):
// the name of the step. Never set otherwise.
export const STOP_ENV = 'HOPRIG_TEST_WORK_STOP_AFTER';
const stopAfter = (step) => {
  if (process.env[STOP_ENV] === step) process.kill(process.pid, 'SIGKILL');
};

/** A value the owner saw matches the one now: the same, or (from the command) a start of at least 12 characters. */
const matches = (now, seen) => seen === undefined || seen === now || (typeof seen === 'string' && seen.length >= 12 && typeof now === 'string' && now.startsWith(seen));

/**
 * Save: → { ok, saved, sent, message, plan, code?, detail? }. `subject`: the commit subject (the setting). `dryRun`:
 * the plan only. `expect`: { hash, upstream } of the plan the owner saw (the page sends them, the command its --seen);
 * when the file or the server moved since, nothing is committed and the new plan comes back (code "moved").
 * `decisions`: key or name → "mine" | "theirs" for the conflicts of a merge. `repoWait`: how long to wait for the
 * repository's lock.
 */
export async function saveWork(place, { subject, run = capture, dryRun = false, expect = null, decisions = {}, repoWait } = {}) {
  const g = fs.existsSync(place.folder) ? await repoInfo(place.folder, run) : null;
  if (!g || dryRun) return saveLocked(place, { subject, run, dryRun, expect, decisions });
  let release;
  try {
    release = await takeRepoLock(g.top, { ...(repoWait === undefined ? {} : { wait: repoWait }), who: 'save' });
  } catch (e) {
    if (e.status !== 409) throw e;
    const plan = await savePlan(place, { run, finish: false });
    return { ok: false, saved: false, sent: false, message: `${cap(e.message)}. Your changes are kept in the file.`, plan: publicPlan(plan), code: e.code };
  }
  try {
    return await saveLocked(place, { subject, run, dryRun, expect, decisions });
  } finally {
    release();
  }
}

async function saveLocked(place, { subject, run, dryRun, expect, decisions }) {
  const plan = await savePlan(place, { run, fetch: true, decisions, repoHeld: !dryRun, finish: !dryRun });
  const before = plan.recovered ? `${plan.recovered} ` : '';
  const out = (ok, message, extra = {}) => ({ ok, saved: false, sent: false, message: `${before}${message}`, plan: publicPlan(plan), ...extra });
  if (plan.problem) return out(false, `${cap(plan.problem)}.`, { code: plan.code || 'problem', ...(plan.detail ? { detail: plan.detail } : {}) });
  const movedMessage = 'The Work file or the server changed since you looked at what a save would do: nothing was committed. Look at the new plan and save again.';
  const r = plan.remote;
  if (expect && (!matches(plan.hash, expect.hash) || (expect.upstream && r && !matches(r.upstream, expect.upstream)))) return out(false, movedMessage, { code: 'moved' });
  if (plan.nothing) return out(true, 'Nothing to keep: the copy in the history has every change of your list already.');
  if (r && r.mode === 'blocked') return out(false, r.message, { code: r.code || 'blocked' });
  if (r && r.mode === 'merge' && r.undecided) {
    return out(false, `${s(r.undecided, 'task')} changed differently here and on another computer: choose which version to keep for each, then save.`, { code: 'decide' });
  }
  const earlier = plan.unsent.saves;
  if (dryRun) {
    if (r && r.mode === 'merge') return out(true, `Would merge ${s(r.mine.length, 'change')} of yours with ${s(r.theirs.length, 'change')} from another computer, then commit and send.`);
    return out(true, plan.files.length ? `Would commit ${plan.files.map((f) => f.path).join(', ')} (${s(plan.changes.length, 'change')}).` : `Would send ${s(earlier, 'earlier commit')} of the Work file not on the server yet.`);
  }

  const { git: g, rel } = plan;
  const git = (args) => gitWrite(g.top, args, { run });
  const read = (args) => gitRead(g.top, args, { run });
  const kind = r && r.mode === 'merge' ? 'merge' : r && r.mode === 'ff' ? 'ff' : plan.files.length ? 'commit' : 'send';
  // A merge's plans' files changed here and on the server (saveplan.mjs planConflict): kept, put back, brought in by the
  // fast-forward, then written as the owner chose.
  const both = kind === 'merge' ? plan.merge.files || [] : [];
  // Work's files beside the list that the plan named, committed with it by name: the run files (runs.mjs) and the plans'
  // files (plans.mjs) the fast-forward does not touch; a plan's file of `both` that he kept as this computer's joins
  // them after the fast-forward. Their index entries as they were, for a commit that fails or is taken back.
  const runs = [...(plan.runs || []), ...(plan.plans || []).filter((f) => !both.some((b) => b.path === f)), ...(plan.missions || []).filter((f) => !both.some((b) => b.path === f))];
  const nRuns = (plan.runs || []).length;
  const behind = r ? r.behind : 0;
  const theirsHere = `the server's ${s(behind, 'new commit')} ${behind === 1 ? 'is' : 'are'} here now`;
  const notes = [];
  // Files of a run's name that are no run record (a link, other content): never committed, said once.
  const notRuns = plan.notRuns || [];
  if (notRuns.length) notes.push(`${notRuns.length === 1 ? `${notRuns[0]} is` : `${s(notRuns.length, 'file')} in ${plan.runsRel} are`} not a run Work wrote (a link, or something else): Work left ${notRuns.length === 1 ? 'it' : 'them'} alone`);
  const notPlans = plan.notPlans || [];
  if (notPlans.length) notes.push(`${notPlans.length === 1 ? `${notPlans[0]} is` : `${s(notPlans.length, 'file')} in ${plan.plansRel} are`} not a plan Work can read now (changed by hand?): Work left ${notPlans.length === 1 ? 'it' : 'them'} alone`);
  const short = (sha) => (sha ? sha.slice(0, 12) : 'no commit');
  const at = async (rev) => {
    const x = await read(['rev-parse', '--verify', '--quiet', `${rev}:${rel}`]);
    return x.ok ? x.stdout.trim() : null;
  };
  // A merge keeps his list in the repository too (kept.mjs): said in every failure that leaves it, deleted at the end.
  const keptNote = ` Your own list as it was before the save is also kept in ${g.name}: ${keptShow(rel)} prints it.`;
  const end = async ({ keep = false } = {}) => {
    if (kind === 'merge' && !keep) {
      await dropKept(g.top, rel, run);
      for (const b of both) await dropKept(g.top, b.path, run);
    }
    dropJournal(place.file);
  };
  /**
   * What sends the save's commit `sha` that waits on the branch: a Save, when nothing of his own (other files) lies on
   * it (git.mjs sortUnsent); else his own send. '' when it is not on the branch.
   */
  const sendsIt = async (sha) => {
    const tipR = await read(['rev-parse', '--verify', '--quiet', `refs/heads/${g.branch}`]);
    const tip = tipR.ok ? tipR.stdout.trim() : null;
    if (!tip || (tip !== sha && (await isAncestor(g.top, sha, tip, run)) !== true)) return '';
    const above = tip === sha ? [] : await unsentCommits(g.top, run, `${sha}..${tip}`);
    if (above) await checkPlanCommits(g.top, above, plan.plansRel, run);
    if (above && !sortUnsent(above, { rel, mapRel: plan.mapRel, runsRel: plan.runsRel, plansRel: plan.plansRel, missionsRel: plan.missionsRel }).theirs.length) return 'Save again sends it';
    return `it goes to the server with yours when you send them (git push in ${g.name})`;
  };
  /** Why the branch is not where the save found it or left it (`from`), in the true words. */
  const movedWhy = async (now, from) => {
    if (now.branch !== g.branch) return `${g.name} was switched to ${now.branch || 'a detached HEAD'} while the save ran`;
    if (!now.head) return `git could not say where ${g.branch} is now`;
    if (r && now.head === r.upstream && from !== r.upstream) return `another command brought the server's commits into ${g.name} while the save ran`;
    const came = (await isAncestor(g.top, from, now.head, run)) === true ? await unsentCommits(g.top, run, `${from}..${now.head}`) : null;
    if (came && came.length) return `${came.length === 1 ? 'your commit' : 'your commits'} ${nameCommits(came)} came in while the save ran`;
    return `${g.branch} moved to ${short(now.head)} while the save ran`;
  };

  // Everything that changes the file or the branch, as the only writer of the file.
  const local = await withLock(place.file, async () => {
    if (fileHash(place.file) !== plan.hash) return { moved: true };
    const now0 = await standing(g.top, run);
    if (!now0.head) return { result: out(false, `${NOT_SAVED}: git could not read ${g.name}. Nothing was changed; your changes are kept in the file.`, { code: 'failed' }) };
    // The branch is still on the commit the plan judged: a commit made meanwhile is never judged in passing, nor sent.
    if (now0.branch !== g.branch || now0.head !== plan.head) return { moved: true, why: await movedWhy(now0, plan.head) };
    if (kind === 'send') return { committed: false };
    const head = now0.head;
    const base = kind === 'merge' || kind === 'ff' ? r.upstream : head;
    const len = head.length;
    const mineBytes = fs.readFileSync(place.file);
    let index;
    try {
      index = await indexEntry(g.top, rel, run);
    } catch (e) {
      return { result: out(false, `${NOT_SAVED}: ${e.message}. Nothing was changed; your changes are kept in the file.`, { code: 'failed', detail: e.detail }) };
    }
    const merged = kind === 'merge' ? plan.merge.mergedText : null;
    const runsIndex = {};
    try {
      for (const f of runs) runsIndex[f] = await indexEntry(g.top, f, run);
    } catch (e) {
      return { result: out(false, `${NOT_SAVED}: ${e.message}. Nothing was changed; your changes are kept in the file.`, { code: 'failed', detail: e.detail }) };
    }
    const ids = { mine: blobId(mineBytes, len), head: await at(head), theirs: kind === 'merge' ? await at(base) : null, target: merged === null ? blobId(mineBytes, len) : blobId(merged, len) };
    const idOf = (text) => (text === null ? null : blobId(text, len));
    const atPath = async (rev, p) => {
      const x = await read(['rev-parse', '--verify', '--quiet', `${rev}:${p}`]);
      return x.ok ? x.stdout.trim() : null;
    };
    const files = [];
    for (const b of both) files.push({ path: b.path, mine: b.mineText, target: b.target, ids: { mine: idOf(b.mineText), head: await atPath(head, b.path), theirs: idOf(b.theirsText), target: idOf(b.target) } });
    try {
      writeJournal(place.file, {
        kind, top: fs.realpathSync(g.top), rel, branch: g.branch, remote: g.remote ? { name: g.remote, ref: g.merge } : null,
        head, base, index, ids, subject, decisions, runs, runsIndex, files,
        mine: kind === 'merge' ? plan.merge.mineText : mineBytes.toString('utf8'), merged,
      });
    } catch (e) {
      return { result: out(false, `${NOT_SAVED}: Hoprig could not keep a record of the save in its state folder (${e.code || 'a system error'}), so nothing was changed. Your changes are kept in the file.`, { code: 'failed', detail: e.message }) };
    }
    stopAfter('journal');
    const kept = keptAt(place.file);
    // Why git refused a fast-forward: the branch moved meanwhile (said as it is), or a file the server's commits change.
    const ffRefused = async () => {
      const now = await standing(g.top, run);
      if (now.branch === g.branch && now.head === head) return { why: `the server's ${s(behind, 'new commit')} could not be brought in (git refused: a file ${behind === 1 ? 'it changes' : 'they change'} is changed here)`, code: 'clash' };
      return { why: `${await movedWhy(now, head)}, so the server's commits were not brought in`, code: 'moved-here' };
    };

    if (kind === 'merge') {
      // His list, in the repository as well, before the file is put back: never only in the state folder.
      const k = await keepList(g.top, rel, place.file, ids.mine, run);
      if (!k.ok) {
        dropJournal(place.file);
        return { result: out(false, `${NOT_SAVED}: Hoprig could not keep a copy of your list in ${g.name} before the merge (${/changed/.test(k.detail) ? 'the Work file changed meanwhile' : 'git refused it'}), so nothing was changed. Your changes are kept in the file.`, { code: 'failed', detail: k.detail }) };
      }
      // His plans' files of `both` too, each under its own ref (kept.mjs keys a ref by the file's path).
      for (const f of files) {
        const kf = await keepList(g.top, f.path, path.join(g.top, ...f.path.split('/')), f.ids.mine, run);
        if (!kf.ok) {
          for (const x of files) await dropKept(g.top, x.path, run);
          await dropKept(g.top, rel, run);
          dropJournal(place.file);
          return { result: out(false, `${NOT_SAVED}: Hoprig could not keep a copy of ${f.path} in ${g.name} before the merge, so nothing was changed. Your changes are kept in the files.`, { code: 'failed', detail: kf.detail }) };
        }
      }
      stopAfter('kept');
      // A step before the branch moved failed: his file and its index entry as they were, or where they are kept.
      const undo = async (why, code, step) => {
        let back = true;
        try {
          if (fileHash(place.file) !== plan.hash) writeText(place.file, plan.merge.mineText);
          for (const f of files) if (blobOnDisk(path.join(g.top, ...f.path.split('/')), len) !== f.ids.mine) writeText(path.join(g.top, ...f.path.split('/')), f.mine);
        } catch {
          back = false;
        }
        if (!(await setIndexEntry(g.top, rel, index, run)).ok) back = false;
        if (!back) return { result: out(false, `${NOT_SAVED}: ${why}, and the Work file could not be put back as it was. Your list is kept in ${g.name} (${keptShow(rel)} prints it) and in Hoprig's state folder, ${kept} (its "mine" value); the next look at the Work list puts it back.`, { code: 'failed', detail: lastLine(step) }) };
        await end();
        return { result: out(false, `${NOT_SAVED}: ${why}. Nothing was changed; your changes are kept in the file.${code === 'clash' ? ' Commit or put aside the files those commits change, then Save again.' : ''}`, { code, detail: lastLine(step) }) };
      };
      // Put the working file back to its last commit, so the server's commits can come in.
      if (plan.state === 'new') fs.rmSync(place.file, { force: true });
      else {
        const back = await git(['checkout', '--quiet', 'HEAD', '--', rel]);
        if (!back.ok) return undo('the Work file could not be put back to its last commit', 'failed', back);
      }
      for (const f of files) {
        if (!f.ids.head) fs.rmSync(path.join(g.top, ...f.path.split('/')), { force: true });
        else {
          const back = await git(['checkout', '--quiet', 'HEAD', '--', f.path]);
          if (!back.ok) return undo(`${f.path} could not be put back to its last commit`, 'failed', back);
        }
      }
      stopAfter('putback');
      const ff = await git(['merge', '--ff-only', '--quiet', base]);
      if (!ff.ok) {
        const no = await ffRefused();
        return undo(no.why, no.code, ff);
      }
      stopAfter('ff');
      try {
        writeText(place.file, merged);
      } catch (e) {
        return { result: out(false, `${NOT_SAVED}: ${theirsHere} (the branch is on the server's commit), but the merged list could not be written to the Work file (${e.message.replace(/^the Work file could not be written \((.*)\)$/, '$1')}). It is kept in Hoprig's state folder, ${kept} (its "merged" value): the next look at the Work list writes it, once the file can be written.${keptNote}`, { code: 'failed', detail: e.detail }) };
      }
      // The plans' files as he chose: his own where he kept this computer's (then committed with the rest).
      try {
        for (const f of files) {
          if (f.ids.target === f.ids.theirs) continue;
          const abs = path.join(g.top, ...f.path.split('/'));
          if (f.target === null) fs.rmSync(abs, { force: true });
          else writeText(abs, f.target);
          runsIndex[f.path] = await indexEntry(g.top, f.path, run);
          runs.push(f.path);
        }
      } catch (e) {
        return { result: out(false, `${NOT_SAVED}: ${theirsHere} (the branch is on the server's commit), but a plan's file could not be written (${e.message}). What it is to hold is kept in Hoprig's state folder, ${kept}: the next look at the Work list writes it.${keptNote}`, { code: 'failed', detail: e.detail }) };
      }
      stopAfter('write');
      if (merged === plan.merge.theirsText && !runs.length) {
        await end();
        return { committed: false, same: true };
      }
    }
    if (kind === 'ff') {
      const ff = await git(['merge', '--ff-only', '--quiet', base]);
      if (!ff.ok) {
        const no = await ffRefused();
        dropJournal(place.file);
        return { result: out(false, `${NOT_SAVED}: ${no.why}. Nothing was changed; your changes are kept in the file.${no.code === 'clash' ? ' Commit or put aside those files, then Save again.' : ' Save again.'}`, { code: no.code, detail: lastLine(ff) }) };
      }
      notes.push(`brought in ${s(behind, 'new commit')} from the server first`);
      stopAfter('ff');
    }
    // Right before the commit, the branch is still where the save put it: a commit made in a terminal during the
    // steps above is never committed on, nor sent.
    const now1 = await standing(g.top, run);
    if (now1.branch !== g.branch || now1.head !== base) return { result: await notCommitted(await movedWhy(now1, base), null, 'moved-here') };
    // The commit, of Work's files only: the list (when it changed) and the run files the plan named.
    const pre = await indexEntry(g.top, rel, run).catch(() => index);
    const isNew = !(await at('HEAD'));
    const unstageRuns = async () => {
      for (const f of runs) await setIndexEntry(g.top, f, runsIndex[f], run);
    };
    // Once more right before they are added: each is still a run record of its name (not a link, nothing else).
    if (runs.some((f) => !isExtra(path.join(g.top, ...f.split('/'))))) return { result: await notCommitted('a run file or a plan\'s file changed while the save ran and is not one of Work\'s now', null, 'moved-here') };
    if (isNew) {
      const a = await git(['add', '--', rel]);
      if (!a.ok) return { result: await notCommitted(`git could not add ${rel}`, a) };
    }
    if (runs.length) {
      const a = await git(['add', '--', ...runs]);
      if (!a.ok) {
        if (isNew) await setIndexEntry(g.top, rel, pre, run);
        await unstageRuns();
        return { result: await notCommitted('git could not add the run files', a) };
      }
    }
    const paths = [...(plan.state || kind === 'merge' ? [rel] : []), ...runs];
    const c = await git(['commit', '--quiet', '-m', subject, '--', ...paths]);
    if (!c.ok) {
      if (isNew) await setIndexEntry(g.top, rel, pre, run);
      await unstageRuns();
      return { result: await notCommitted('the commit did not go through (git refused it: a hook of the repository, or another git program working in it)', c) };
    }
    stopAfter('commit');
    const diskAfter = blobOnDisk(place.file, len);
    // The save's own commit, known for certain: the first commit on the branch after `base`, made on `base`, of the
    // Work file alone, with the save's subject in its message (a hook may add to it). HEAD is never taken for it.
    const tipR = await read(['rev-parse', '--verify', '--quiet', `refs/heads/${g.branch}`]);
    const tip = tipR.ok ? tipR.stdout.trim() : null;
    const rows = tip ? await unsentCommits(g.top, run, `${base}..${tip}`) : null;
    const first = rows && rows.length ? rows[rows.length - 1] : null;
    let made = first && first.parents.length === 1 && first.parents[0] === base && Array.isArray(first.files) && first.files.length > 0 && first.files.every((f) => paths.includes(f)) ? first.sha : null;
    if (made) {
      const msg = await read(['log', '-1', '--format=%B', made]);
      if (!msg.ok || !msg.stdout.includes(subject.trim())) made = null;
    }
    if (!made) {
      const now = await standing(g.top, run);
      await end({ keep: true });
      return { result: out(false, `${NOT_SAVED}: ${g.name} changed while the save made its commit (${now.branch !== g.branch ? `it is on ${now.branch || 'a detached HEAD'} now` : 'another commit came in'}), so the save's own commit cannot be told apart for certain: the save did nothing more and sent nothing. ${g.name} is on ${now.branch || 'a detached HEAD'} at ${short(now.head)}; git log there shows what is in it.${kind === 'merge' ? keptNote : ''}`, { code: 'moved-here' }) };
    }
    // His commit on top of the save's: nothing more is touched, and the save's commit waits under it.
    if (tip !== made) {
      const above = rows.slice(0, -1);
      await end();
      const then = await sendsIt(made);
      return { result: out(false, `${NOT_SAVED}: ${above.length === 1 ? 'your commit' : 'your commits'} ${nameCommits(above)} came in while the save ran; the save's commit ${short(made)} is under ${above.length === 1 ? 'it' : 'them'}, not sent${then ? `: ${then}` : ''}.`, { code: 'moved-here' }) };
    }
    // The owner's hooks run (they are his); one that changed the file leaves the commit and the disk apart: say so.
    const committedId = await at(made);
    if (committedId && diskAfter !== committedId) notes.push('a hook of the repository changed the file while committing: the commit and the file on disk now differ, see git diff');
    // What a take-back puts in the index: as it was before the commit (a merge: his staged version, when he had one).
    const restore = kind === 'merge' && index && index.sha !== ids.head ? index : pre;
    return { committed: true, made, base, restore, committedId, runsIndex };

    async function notCommitted(why, step, code = 'failed') {
      await end();
      const state = kind === 'merge' ? `${cap(theirsHere)}, and your changes, merged with the other computer's, are in the Work file, not committed` : kind === 'ff' ? `${cap(theirsHere)}; your changes are kept in the file` : 'Your changes are kept in the file';
      return out(false, `${NOT_SAVED}: ${why}${code === 'moved-here' ? ', so nothing was committed' : ''}. ${state}. ${code === 'moved-here' ? 'Save again.' : 'Save again when it can be committed.'}`, { code, ...(step ? { detail: lastLine(step) } : {}) });
    }
  });
  if (local.moved) {
    const fresh = publicPlan(await savePlan(place, { run, repoHeld: true }));
    return { ...out(false, local.why ? `${NOT_SAVED}: ${local.why}. Nothing was changed; your changes are kept in the file. Look at the new plan and save again.` : movedMessage, { code: 'moved' }), plan: fresh };
  }
  if (local.result) return local.result;

  // What else happened, said after the main sentence.
  const said = (ok, text, extra = {}) => {
    const also = notes.length ? ` ${notes.map((n) => `${cap(n)}.`).join(' ')}` : '';
    return out(ok, `${text}${also}`, extra);
  };
  const decided = r && r.mode === 'merge' && r.conflicts.length ? `, ${s(r.conflicts.length, 'task')} decided by you` : '';
  const nPlans = runs.length - nRuns;
  const copies = (n) => `${n} earlier ${n === 1 ? 'copy' : 'copies'}`;
  const withRuns = [nRuns ? s(nRuns, 'run') : null, nPlans ? s(nPlans, 'plan file') : null].filter(Boolean).map((x) => ` and ${x}`).join('');
  const what = kind === 'merge' ? `Merged ${s(r.mine.length, 'change')} of yours with ${s(r.theirs.length, 'change')} from another computer${decided}${withRuns}`
    // His words, not git's: a copy of his list kept in the history, and uploaded to his git server.
    : kind === 'send' ? null : plan.state ? `Kept a copy of your list (${s(plan.changes.length, 'change')})${withRuns}${earlier ? ` with ${copies(earlier)} of it` : ''}`
      : `Kept ${withRuns.slice(5)}${earlier ? ` with ${copies(earlier)} of your list` : ''}`;
  if (local.same) return said(true, `${what}: the server's version is the result, so there is nothing to send.`);
  if (!g.remote) {
    await end();
    return said(true, plan.elsewhere ? `${what}; this branch is sent to another place than it follows, so Work did not send it.` : `${what}. This branch has no server branch, so nothing was sent.`, { saved: true });
  }
  // The send names its commit by id: the save's own, or (only sending) the commit the plan judged. Once more, on that
  // exact id: what goes is the save's commit and earlier commits of the Work file alone (git.mjs sortUnsent).
  const sha = local.committed ? local.made : plan.head;
  const goes = await unsentCommits(g.top, run, `${r.upstream}..${sha}`);
  if (goes) await checkPlanCommits(g.top, goes, plan.plansRel, run);
  const sorted = goes ? sortUnsent(goes, { rel, mapRel: plan.mapRel, runsRel: plan.runsRel, plansRel: plan.plansRel, missionsRel: plan.missionsRel }) : null;
  const p = sorted && goes.length && !sorted.theirs.length ? await git(sendArgs(g.remote, sha, g.merge)) : null;
  stopAfter('push');
  if (p && p.ok) {
    await end();
    return said(true, local.committed ? `${what} and uploaded it to your git server.` : `Uploaded ${copies(earlier)} of your list to your git server.`, { saved: local.committed, sent: true });
  }
  const why = p ? sendFailure(p) : 'it would have carried commits that are not saves of the Work file';
  const detail = p ? { detail: lastLine(p) } : {};
  if (!local.committed) return said(false, `Not sent: ${why}. ${s(earlier, 'earlier commit')} of the Work file ${earlier === 1 ? 'stays' : 'stay'} here; Save again.`, { code: 'not-sent', ...detail });
  // Not sent: the commit is taken back only while nothing else moved: HEAD still on the branch, the branch exactly on
  // the save's commit, the file as that commit has it. Otherwise nothing is taken back, and the message says where it is.
  const now = await standing(g.top, run);
  let held = now.branch !== g.branch ? `${g.name} was switched to ${now.branch || 'a detached HEAD'} meanwhile`
    : now.head !== local.made ? `${g.branch} moved meanwhile`
      : blobOnDisk(place.file, sha.length) !== local.committedId ? 'the Work file was changed meanwhile' : null;
  if (!held) {
    const back = await git(['update-ref', '-m', 'Work save: taken back, it was not sent', `refs/heads/${g.branch}`, local.base, local.made]);
    if (back.ok) {
      // The index entry as it was, only while it is still the one the commit left (never one he staged since).
      const ix = await indexEntry(g.top, rel, run).catch(() => null);
      if (ix && ix.sha === local.committedId) await setIndexEntry(g.top, rel, local.restore, run);
      // The run files' index entries as they were before the save added them (their files keep what was committed).
      for (const f of runs) {
        const fx = await indexEntry(g.top, f, run).catch(() => null);
        if (fx && fx.sha === blobOnDisk(path.join(g.top, ...f.split('/')), sha.length)) await setIndexEntry(g.top, f, local.runsIndex[f], run);
      }
      stopAfter('takeback');
      await end();
      const state = kind === 'merge' ? `${cap(theirsHere)}, and your changes, merged with the other computer's, are kept in the file` : kind === 'ff' ? `${cap(theirsHere)}; your changes are kept in the file` : 'Your changes are kept in the file';
      return said(false, `${NOT_SAVED}: ${why}. ${state}; Save again.`, { code: 'not-sent', ...detail });
    }
    held = `${g.branch} moved meanwhile`;
  }
  const on = await branchesWith(g.top, local.made, run);
  const then = await sendsIt(local.made);
  await end();
  return said(false, `${NOT_SAVED}: ${why}, and the save's commit ${short(local.made)} was not taken back because ${held}: it is ${on.length ? `on ${on.join(', ')}` : `on no branch now (git show ${short(local.made)} shows it)`}, not on the server.${then ? ` ${cap(then)}.` : ''}`, { code: 'not-sent', ...detail });
}
