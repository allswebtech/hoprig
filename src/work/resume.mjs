// A save of the Work file that was interrupted (the process killed between two of its steps: a crash, a power cut, a
// dashboard stopped) is finished or shown the next time anything looks at the Work list, never passed over. Its
// journal (journal.mjs) says what it was doing. When the repository is where one of the save's steps left it and
// nothing else changed in between, the save is brought to a state the owner knows: the list it was writing is in the
// Work file as a change not committed yet (a commit made and not sent is taken back), or it was sent and is done.
// In any other state nothing is touched, and the owner is told where that list is kept and how the repository stands;
// the journal stays until he drops it. A merge also keeps his list in the repository (kept.mjs): a look that finds
// that kept list without a journal (the state folder is gone, or another one has it) says so and shows how to put it
// back; it is never applied by itself, and a save waits until he drops it.
//
// The steps of a save and what each leaves (H: the commit the branch was on, B: the commit the save commits on, which
// is the server's commit when its commits came in first, else H; C: the save's commit on B):
//   journal written      branch H, the file as it was ("mine")
//   list kept            branch H, the file as it was, the ref of kept.mjs   (only a merge)
//   file put back        branch H, the file as H has it                      (only a merge)
//   fast-forward         branch B, the file as B has it (a merge) or mine    (a merge, or the server's commits first)
//   merged list written  branch B, the file holds the merged list            (only a merge)
//   commit               branch C, the file as C has it
//   send                 branch C, C on the server
//   taken back           branch B, the file as C has it                      (the send failed)
import fs from 'node:fs';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import path from 'node:path';
import { blobOnDisk as idOnDisk, gitWrite, indexEntry, isAncestor, repoInfo, setIndexEntry } from './git.mjs';
import { dropJournal, keptAt, readJournal } from './journal.mjs';
import { dropKept, keptId, keptOf, keptShow } from './kept.mjs';
import { tryRepoLock, withLock } from './lock.mjs';
import { dropAccept, finishAccept } from './planstore.mjs';
import { writeText } from './store.mjs';

const DROP = 'press "Drop the record" on the Work page, or run hoprig tasks save --drop-interrupted';

/**
 * Finish or show an interrupted save of `place`'s Work file. → {} (none), { sentence } (finished: one sentence for the
 * owner), or { problem, code, kept? } (shown: nothing touched; a save waits until the owner drops the journal).
 * `repoHeld`: the caller holds the repository's lock. `dryRun`: say it, change nothing.
 */
export async function finishInterrupted(place, opts = {}) {
  // An Accept of a plan that was interrupted (planstore.mjs) is finished first: a save never commits half of one.
  const acc = await finishAccept(place, { dryRun: !!opts.dryRun });
  if (acc.problem) return acc;
  const r = await finishSave(place, opts);
  if (!acc.sentence || r.problem) return r;
  return { ...r, sentence: r.sentence ? `${acc.sentence} ${r.sentence}` : acc.sentence };
}

async function finishSave(place, { run = capture, repoHeld = false, dryRun = false } = {}) {
  const j = readJournal(place.file);
  if (!j) {
    // No record here, but his list kept in the repository: a save was interrupted whose record is elsewhere or gone.
    const k = await keptOf(place, run);
    if (!k) return {};
    return { problem: `a save of the Work list was interrupted, and its record is not in this Hoprig's state folder (another state folder has it, or it is gone), but your list as it was before that save is kept in ${k.name}: ${keptShow(k.rel)} prints it. Nothing was changed. To put it back into the Work file, in a terminal in ${k.name}: ${keptShow(k.rel)} > ${k.rel}; then drop the kept list (${DROP})`, code: 'interrupted', kept: k.ref };
  }
  const kept = keptAt(place.file);
  if (j.unreadable) {
    const k = await keptOf(place, run);
    const where = k ? `your list as it was before that save is kept in ${k.name}: ${keptShow(k.rel)} prints it` : 'that save never took your list out of the Work file: it is there, or in that save\'s commit (git log -1 in the repository shows it)';
    return { problem: `a save of the Work list was interrupted, and its record in Hoprig's state folder (${kept}) cannot be read: nothing was changed, and ${where}. Then drop the record (${DROP})`, code: 'interrupted', kept };
  }
  if (dryRun) return { problem: 'a save of the Work list was interrupted: a save that is not a dry run finishes it first (a dry run changes nothing)', code: 'interrupted' };
  const release = repoHeld ? null : await tryRepoLock(j.top, { who: 'save' });
  if (!repoHeld && !release) return { problem: 'the repository of the Work list is busy (a save, or the workspace being synced): look again in a moment', code: 'busy' };
  try {
    return await withLock(place.file, () => finish(place, j, run, kept));
  } finally {
    if (release) release();
  }
}

/** Drop the journal of an interrupted save and the list it kept in the repository (the owner's word). → whether there was one. */
export async function dropInterrupted(place, { run = capture } = {}) {
  const k = await keptOf(place, run);
  if (k) await dropKept(k.top, k.rel, run, k.id);
  const accept = dropAccept(place);
  return dropJournal(place.file) || !!k || accept;
}

async function finish(place, j, run, kept) {
  const git = (args) => gitWrite(j.top, args, { run });
  const read = (args) => gitRead(j.top, args, { run });
  const g = await repoInfo(place.folder, run);
  let real = null;
  try {
    real = g ? fs.realpathSync(g.top) : null;
  } catch {
    /* gone */
  }
  const headNow = g ? await read(['rev-parse', '--verify', '--quiet', 'HEAD']) : null;
  const H = headNow && headNow.ok ? headNow.stdout.trim() : null;
  const ids = j.ids || {};
  // The list this save kept in the repository (a merge, from journal version 2): only a ref that holds its "mine", in
  // the repository the record names or, when that one is gone, the one that holds the Work file now.
  let keptIn = fs.existsSync(j.top) ? { top: j.top, rel: j.rel, id: await keptId(j.top, j.rel, run) } : null;
  if (!keptIn || !keptIn.id) keptIn = await keptOf(place, run);
  const ours = j.kind === 'merge' && !!keptIn && keptIn.id === ids.mine;
  const shown = (why) => ({
    problem: `a save of the Work list was interrupted, and the repository is not where that save left it (${why}): nothing was changed. The list that save was writing is kept in Hoprig's state folder, ${kept} (its "${j.kind === 'merge' ? 'merged' : 'mine'}" value)${ours ? `, and your own list as it was before it in ${path.basename(keptIn.top)} (${keptShow(keptIn.rel)} prints it)` : ''}${g && H ? `; ${g.name} is on ${g.branch || 'no branch'} at ${H.slice(0, 12)}` : ''}. Put the repository right, then drop the record: ${DROP}`,
    code: 'interrupted',
    kept,
  });
  if (!g || real !== j.top) return shown('the Work file is not in that repository any more');
  if (g.branch !== j.branch) return shown(`it is on ${g.branch || 'no branch'}, the save was on ${j.branch}`);
  if (!H) return shown('git could not say which commit it is on');
  const onDisk = idOnDisk(place.file, H.length);
  // A merge's plans' files changed on both computers (save.mjs `both`): { path, mine, target, ids }.
  const files = Array.isArray(j.files) ? j.files.filter((f) => f && typeof f.path === 'string' && !f.path.split('/').includes('..') && f.ids && typeof f.ids === 'object') : [];
  const absOf = (f) => path.join(j.top, ...f.path.split('/'));
  const done = async (sentence) => {
    if (ours) await dropKept(keptIn.top, keptIn.rel, run, keptIn.id);
    for (const f of files) await dropKept(j.top, f.path, run, f.ids.mine);
    dropJournal(place.file);
    return { sentence };
  };
  /**
   * Each of those files where `from` left it gets `to` (before the fast-forward: back to his own; after it: what he
   * chose). → null, or the path of one that holds anything else (then nothing more is touched).
   */
  const settleFiles = (fromKey, toKey, toText) => {
    for (const f of files) {
      const now = idOnDisk(absOf(f), H.length);
      if (now === f.ids[toKey]) continue;
      if (now !== f.ids[fromKey]) return f.path;
    }
    for (const f of files) {
      if (idOnDisk(absOf(f), H.length) === f.ids[toKey]) continue;
      const text = toText(f);
      if (text === null) fs.rmSync(absOf(f), { force: true });
      else writeText(absOf(f), text);
    }
    return null;
  };
  const untouched = 'A save of the Work list was interrupted before it changed anything in git: your list is as it was.';
  // The run files the save committed with the list (runs.mjs), and their index entries before it added them.
  const runs = Array.isArray(j.runs) ? j.runs.filter((f) => typeof f === 'string') : [];
  const runsIndex = j.runsIndex && typeof j.runsIndex === 'object' ? j.runsIndex : {};
  /** Before its commit: a run file's index entry the save added (it holds the file as it is) goes back as it was. */
  const unstageRuns = async () => {
    for (const f of runs) {
      const ix = await indexEntry(j.top, f, run).catch(() => null);
      if (ix && ix.sha === idOnDisk(path.join(j.top, ...f.split('/')), H.length)) await setIndexEntry(j.top, f, runsIndex[f] || null, run);
    }
  };

  // Before the commit.
  if (j.kind === 'merge' && H === j.head) {
    // Its list is kept before the file is put back: without it, the save changed nothing, whatever the file holds now
    // (he may have changed or discarded it since; nothing is written over it).
    if (j.v >= 2 && !ours) return done(untouched);
    // His plans' files are put back after the list: each that is as its last commit has it gets his own again.
    const off = settleFiles('head', 'mine', (f) => f.mine);
    if (off) return shown(`${off} holds a version that save did not write`);
    if (onDisk === ids.mine) return done(untouched);
    if (onDisk !== ids.head) return shown('the Work file holds a version that save did not write');
    writeText(place.file, j.mine);
    const ix = await setIndexEntry(j.top, j.rel, j.index, run);
    if (!ix.ok) return shown('git could not put the index of the Work file back');
    return done('A save of the Work list was interrupted before it brought in the server\'s commits: your list is back in the Work file as it was.');
  }
  if (j.kind === 'merge' && H === j.base) {
    if (onDisk !== ids.theirs && onDisk !== ids.target) return shown('the Work file holds a version that save did not write');
    const off = files.find((f) => ![f.ids.theirs, f.ids.target].includes(idOnDisk(absOf(f), H.length)));
    if (off) return shown(`${off.path} holds a version that save did not write`);
    if (onDisk !== ids.target) writeText(place.file, j.merged);
    settleFiles('theirs', 'target', (f) => f.target);
    await git(['reset', '--quiet', j.base, '--', j.rel]); // the file's index entry as the fast-forward left it
    for (const f of files) await git(['reset', '--quiet', j.base, '--', f.path]);
    await unstageRuns();
    return done('A save of the Work list was interrupted after it brought in the server\'s commits: your changes, merged with the other computer\'s, are in the Work file now; Save sends them.');
  }
  if (j.kind !== 'merge' && (H === j.head || H === j.base)) {
    // Before its commit such a save never writes the Work file: what it holds now is his. The one thing the save may
    // have left is its own `git add` of a new file: that index entry goes back as it was, never one he staged since.
    const ix = await indexEntry(j.top, j.rel, run).catch(() => undefined);
    const same = (a, b) => (a ? `${a.mode} ${a.sha}` : null) === (b ? `${b.mode} ${b.sha}` : null);
    if (!ids.head && ix && ix.sha === ids.mine && !same(ix, j.index)) await setIndexEntry(j.top, j.rel, j.index, run);
    await unstageRuns();
    return done(H !== j.head
      ? 'A save of the Work list was interrupted before its commit: the server\'s commits are here now, and your changes are kept in the Work file.'
      : 'A save of the Work list was interrupted before its commit: your changes are kept in the Work file.');
  }

  // After the commit: the branch is on the save's own commit, with nothing else in it, and the file as it has it.
  const parent = await read(['rev-parse', '--verify', '--quiet', `${H}^`]);
  if (!parent.ok || parent.stdout.trim() !== j.base) return shown('its branch has commits that save did not make');
  const changed = await read(['diff-tree', '-r', '--name-only', '--no-renames', '-z', j.base, H]);
  const at = await read(['rev-parse', '--verify', '--quiet', `${H}:${j.rel}`]);
  const inCommit = changed.ok ? changed.stdout.split('\0').filter(Boolean) : [];
  if (!changed.ok || !inCommit.length || inCommit.some((f) => f !== j.rel && !runs.includes(f) && !files.some((x) => x.path === f)) || !at.ok || at.stdout.trim() !== ids.target) return shown('its last commit is not the one that save made');
  if (onDisk !== ids.target) return shown('the Work file changed after that save\'s commit');
  if (!j.remote) return done('A save of the Work list was interrupted after its commit: that save was the commit alone, with nothing to send, so it is done.');
  if ((await isAncestor(j.top, H, '@{u}', run)) === true) return done('A save of the Work list was interrupted after it was sent: it is on the server, nothing more to do.');
  // Committed and not sent: taken back, so the change is in the file and the next Save sends it with the server's news.
  const back = await git(['update-ref', '-m', 'Work save: taken back, it was not sent', `refs/heads/${j.branch}`, j.base, H]);
  if (!back.ok) return shown('git could not take its commit back');
  if (j.kind === 'merge') {
    await git(['reset', '--quiet', j.base, '--', j.rel]);
    for (const f of files) await git(['reset', '--quiet', j.base, '--', f.path]);
  } else await setIndexEntry(j.top, j.rel, j.index, run);
  for (const f of runs) await setIndexEntry(j.top, f, runsIndex[f] || null, run);
  return done('A save of the Work list was interrupted after its commit and before it was sent: the commit is taken back, and your changes are kept in the Work file; Save sends them.');
}
