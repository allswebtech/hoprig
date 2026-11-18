// What a save would do (save.mjs does it): worked out first, shown to the owner, and checked again before anything
// is committed. Reads only, through src/gitread.mjs; the one write here is the fetch, when the plan is asked for with
// the server's news (the Save sheet does; the page's bar does not), and the finishing of a save that was interrupted
// (resume.mjs), which every plan does first.
//
// The plan: { label, repo: { name, branch, upstream }, files: [{ path, state }], changes (this computer's, since the
// last commit), unsent: { saves, others }, hash (of the file), head, nothing, problem?, recovered?, remote? }. With the
// server's news, `remote` says what the server has: { upstream (its commit), ahead, behind, mode, … }. `head` is the
// commit of this computer's branch that the plan judged, read once after the fetch: every count and check names it by
// its id, never HEAD again, so a commit the owner makes meanwhile is not judged in passing (save.mjs answers "moved"
// when the branch is no longer on it). Everything a save decides is read AFTER the fetch:
//   send     the server has nothing new: commit, then send (with this computer's earlier commits of the Work file
//            that an older version or the owner's hand left unsent, by the rule of git.mjs sortUnsent)
//   ff       the server has new commits that do not change the Work file: they come in by fast-forward, then commit
//            and send
//   merge    the server changed the Work file: the lists are merged by item (merge.mjs); `mine`, `theirs`, `conflicts`
//   blocked  nothing is touched, and `message` says why and what to do (`code`): commits of the owner's own not on the
//            server ("held"), or the server moved while this computer has commits it lacks ("blocked"), files the
//            server's commits change are changed here ("clash"), the server's branch was rewritten ("rewritten")
// A branch that git sends to another place than the branch it follows (branch.<name>.pushRemote, remote.pushDefault,
// a push refspec of its own, push.default that names no place: @{push} is not @{upstream}) is a three-cornered set-up:
// Work does not guess where a save should go, and a save is the commit alone (`elsewhere`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { MAP_FILE } from '../workspace/map.mjs';
import { fileAt, gitWrite, isAncestor, isWorkFile, lastLine, nameCommits, repoInfo, sortUnsent, unsentCommits } from './git.mjs';
import { decodeBytes } from './jsontext.mjs';
import { itemChanges, mergeItems } from './merge.mjs';
import { todayIn } from './model.mjs';
import { finishInterrupted } from './resume.mjs';
import { formatOf, parseText, readDoc, serialize, untidy } from './store.mjs';
import { RUNS_FOLDER, RUN_FILE_RE, isRunFile } from './runs.mjs';

export const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
export const NOT_SAVED = 'Not saved to git';

/** A hash of the file's bytes (null when it is not there): what the owner saw, compared again before the commit. */
export function fileHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

/**
 * The plan. `fetch`: with the server's news. `repoHeld`: the caller holds the repository's lock (a save). `finish`:
 * an interrupted save may be finished (false for a dry run: it is only said).
 */
export async function savePlan(place, { run = capture, fetch = false, decisions = {}, repoHeld = false, finish = true } = {}) {
  const fin = await finishInterrupted(place, { run, repoHeld, dryRun: !finish });
  if (fin.problem) return { label: place.label, files: [], changes: [], unsent: { saves: 0, others: [] }, nothing: true, repo: null, problem: fin.problem, code: fin.code, ...(fin.kept ? { kept: fin.kept } : {}) };
  const plan = await planOf(place, { run, fetch, decisions });
  return fin.sentence ? { ...plan, recovered: fin.sentence } : plan;
}

async function planOf(place, { run, fetch, decisions }) {
  const base = { label: place.label, files: [], changes: [], unsent: { saves: 0, others: [] }, nothing: true };
  if (!fs.existsSync(place.file)) return { ...base, repo: null, problem: null };
  const found = await repoInfo(place.folder, run);
  const elsewhere = found && found.remote ? await sentElsewhere(found.top, run) : false;
  // Three-cornered: the save is the commit alone, as on a branch without a server branch.
  const g = elsewhere ? { ...found, remote: null, merge: null } : found;
  if (!g) return { ...base, repo: null, problem: `the folder ${place.label} is not in a git repository: your changes are kept in the file, and there is nothing to commit them to` };
  const repo = { name: g.name, branch: g.branch, upstream: g.remote ? `${g.remote}/${g.merge.replace(/^refs\/heads\//, '')}` : null };
  if (!g.branch) return { ...base, repo, problem: `the repository ${g.name} is not on a branch (a detached HEAD): nothing can be saved until it is` };
  // A merge, rebase or cherry-pick the owner has begun is his to finish: a save would commit in the middle of it.
  const gd = await gitRead(g.top, ['rev-parse', '--absolute-git-dir'], { run });
  const midway = gd.ok ? ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].find((n) => fs.existsSync(path.join(gd.stdout.trim(), n))) : null;
  if (midway) return { ...base, repo, problem: `the repository ${g.name} is in the middle of a ${/^MERGE/.test(midway) ? 'merge' : /^rebase/.test(midway) ? 'rebase' : midway.startsWith('CHERRY') ? 'cherry-pick' : 'revert'}: finish it first (in a terminal), then save; your changes are kept in the file` };
  const rel = path.relative(fs.realpathSync(g.top), place.file).split(path.sep).join('/');
  const st = await gitRead(g.top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel], { run });
  if (!st.ok) return { ...base, repo, problem: `git could not read the repository ${g.name}`, detail: lastLine(st) };
  const code = st.stdout.slice(0, 2);
  let state = null;
  if (code === '??') state = 'new';
  else if (code.trim()) state = 'changed';
  else {
    const tracked = await gitRead(g.top, ['ls-files', '-z', '--', rel], { run });
    if (tracked.ok && !tracked.stdout) return { ...base, repo, problem: `the file ${place.fileName} is ignored by git in ${g.name}: there is nothing to commit` };
  }
  // The run files (runs.mjs) beside the list: new or changed ones are committed with it, by name. A file is one only
  // when it is a run record of its name (a plain file that reads as a run, not a link): a session works in this
  // repository too, and anything else of a run's name is not Work's to send. Those are named and left alone.
  const runsRel = path.posix.join(path.posix.dirname(rel), RUNS_FOLDER);
  const rs = await gitRead(g.top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', `${runsRel}/`], { run });
  const named = (rs.ok ? rs.stdout.split('\0').filter(Boolean) : [])
    .map((e) => ({ code: e.slice(0, 2), path: e.slice(3) }))
    .filter((e) => !e.code.includes('D') && e.path.startsWith(`${runsRel}/`) && RUN_FILE_RE.test(e.path.slice(runsRel.length + 1)));
  const isRun = (e) => isRunFile(path.join(g.top, ...e.path.split('/')));
  const runFiles = named.filter(isRun).map((e) => ({ path: e.path, state: e.code === '??' ? 'new' : 'changed' })).sort((a, b) => a.path.localeCompare(b.path));
  const notRuns = named.filter((e) => !isRun(e)).map((e) => e.path).sort();
  const files = [...(state ? [{ path: rel, state }] : []), ...runFiles];
  let changes = [];
  if (state) {
    let before = { items: [] };
    try {
      if (state !== 'new') before = parseText((await fileAt(g.top, 'HEAD', rel, run)).text, 'the committed Work file');
    } catch {
      /* the committed version was no JSON: every item counts as added */
    }
    try {
      changes = itemChanges(before, readDoc(place.file).doc, place.settings.ownerId);
    } catch {
      /* the file is no JSON now: the save still names the file */
    }
  }
  // What this computer has that the server lacks. Before the fetch only to tell whether a save has anything to do:
  // every decision is taken on what git says after it.
  const mapRel = place.kind === 'brain' ? path.relative(fs.realpathSync(g.top), path.join(place.base, MAP_FILE)).split(path.sep).join('/') : null;
  const headNow = async () => {
    const h = await gitRead(g.top, ['rev-parse', '--verify', '--quiet', 'HEAD'], { run });
    return h.ok ? h.stdout.trim() : null;
  };
  let head = await headNow();
  const unsentNow = async () => {
    const list = head ? await unsentCommits(g.top, run, `@{u}..${head}`) : null;
    const sorted = list ? sortUnsent(list, { rel, mapRel, runsRel }) : null;
    return { list, sorted, unsent: sorted ? { saves: sorted.ours.length, others: sorted.theirs } : { saves: 0, others: null } };
  };
  const sendable = (u) => u.saves > 0 && Array.isArray(u.others) && !u.others.length;
  let now = g.remote ? await unsentNow() : { list: [], sorted: { ours: [], theirs: [] }, unsent: { saves: 0, others: [] } };
  let plan = { label: place.label, repo, files, changes, unsent: now.unsent, nothing: !files.length && !sendable(now.unsent), hash: fileHash(place.file), head, rel, mapRel, runsRel, runs: runFiles.map((f) => f.path), notRuns, git: g, state, ...(elsewhere ? { elsewhere } : {}) };
  if (!fetch || !g.remote || plan.nothing) return plan;

  // The server's news; what the server's branch was before, to see whether it was rewritten.
  const was = await gitRead(g.top, ['rev-parse', '--verify', '--quiet', '@{u}'], { run });
  const f = await gitWrite(g.top, ['fetch', '--quiet', g.remote, g.merge], { run });
  if (!f.ok) return { ...plan, problem: `${NOT_SAVED}: the server of ${g.name} did not answer. Your changes are kept in the file; Save again when it answers`, code: 'offline', detail: lastLine(f) };
  // The commit judged from here on, by its id: HEAD is read this once.
  head = await headNow();
  const up = await gitRead(g.top, ['rev-parse', '--verify', '--quiet', '@{u}'], { run });
  if (!head || !up.ok) return { ...plan, head, problem: `git could not compare ${g.name} with its server branch`, detail: lastLine(up) };
  const upstream = up.stdout.trim();
  now = await unsentNow();
  plan = { ...plan, head, unsent: now.unsent, nothing: !files.length && !sendable(now.unsent) };
  const counts = await gitRead(g.top, ['rev-list', '--left-right', '--count', `${head}...${upstream}`], { run });
  if (!counts.ok) return { ...plan, problem: `git could not compare ${g.name} with its server branch`, detail: lastLine(counts) };
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  const remote = { upstream, ahead, behind, mode: 'send' };
  const blocked = (code, message) => ({ ...plan, remote: { ...remote, mode: 'blocked', code, message } });
  // A server branch that lost commits it had (another computer forced it): nothing is decided on it.
  const before = was.ok ? was.stdout.trim() : null;
  if (before && before !== upstream && (await isAncestor(g.top, before, upstream, run)) !== true) {
    return blocked('rewritten', `${NOT_SAVED}: the server's branch of ${g.name} was rewritten (commits it had are gone from it), so a save changes nothing. Your changes are kept in the file. Look at both in a terminal in ${g.name} (git log --oneline --graph HEAD @{u}), bring them together, then Save again.`);
  }
  if (plan.nothing) return plan; // the earlier commits are on the server now
  const own = now.sorted ? now.sorted.theirs : null;
  const which = own && own.length ? `${s(own.length, 'commit')} of yours that change${own.length === 1 ? 's' : ''} other files (${nameCommits(own)})` : 'more commits not on the server than a save looks at';
  if (!behind) {
    if (!own || own.length) return blocked('held', `${NOT_SAVED}: ${g.name} has ${which} not yet on the server, and a save sends only commits of the Work file. Your changes are kept in the file. Send those first (git push in ${g.name}), then Save again.`);
    return { ...plan, remote };
  }
  if (ahead) {
    // This computer has commits the server lacks, and the server moved: nothing is touched.
    const workOnly = own && !own.length && now.list.every((c) => c.files.every((x) => isWorkFile(x, { rel, runsRel })));
    if (workOnly) {
      const mb = await gitRead(g.top, ['merge-base', head, upstream], { run });
      const at = mb.ok ? mb.stdout.trim().slice(0, 12) : '@{u}';
      return blocked('blocked', `${NOT_SAVED}: ${g.name} has ${s(behind, 'new commit')} on the server, and this computer has ${s(now.list.length, 'earlier commit')} of the Work file that ${now.list.length === 1 ? 'is' : 'are'} not on the server (${nameCommits(now.list)}). Nothing was changed. In a terminal in ${g.name}: git reset --soft ${at} (it makes ${now.list.length === 1 ? 'that commit' : 'those commits'} a change in the file again and changes nothing else), then Save again: the two lists are merged task by task.`);
    }
    const steps = files.length ? `git stash push -- ${rel}, then git pull --no-rebase, then git stash pop` : 'git pull --no-rebase';
    return blocked('blocked', `${NOT_SAVED}: ${g.name} has ${s(behind, 'new commit')} on the server, and this computer has ${which}. Nothing was changed. Those are yours to bring together: in a terminal in ${g.name}, ${steps}; then Save again.`);
  }
  // The server's commits come in by fast-forward: never over a file that is changed here or is here outside git.
  const clash = await clashes(g.top, head, upstream, rel, run);
  if (clash && clash.length) {
    return blocked('clash', `${NOT_SAVED}: the server's ${s(behind, 'new commit')} change${behind === 1 ? 's' : ''} files that are changed here too, or are here as files git does not keep (${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ` and ${clash.length - 3} more` : ''}). Nothing was changed; your changes are kept in the file. Commit those files or put them aside, then Save again.`);
  }
  let theirs;
  let baseF;
  try {
    theirs = await fileAt(g.top, upstream, rel, run);
    baseF = await fileAt(g.top, head, rel, run);
  } catch (e) {
    return { ...plan, problem: e.message, detail: e.detail };
  }
  // The server's list comes in by fast-forward when it is the one this computer had, or when only run files changed
  // here (the list here is its last commit: nothing of it to merge).
  if ((theirs ? theirs.id : null) === (baseF ? baseF.id : null) || !state) return { ...plan, remote: { ...remote, mode: 'ff' } };
  if (theirs && !theirs.exact) return { ...plan, problem: 'the server\'s Work file has bytes that are not UTF-8 (it was written by hand somewhere): tidy it once on a computer that has it, then save again; nothing was changed' };

  // The server changed the list too: merged by item.
  const mine = decodeBytes(fs.readFileSync(place.file));
  const theirsText = theirs ? theirs.text : null;
  const baseText = baseF ? baseF.text : null;
  let docs;
  try {
    docs = { mine: parseText(mine.text, 'this computer\'s Work file'), theirs: theirsText === null ? { items: [] } : parseText(theirsText, 'the server\'s Work file'), base: baseText === null ? { items: [] } : parseText(baseText, 'the last common Work file') };
  } catch (e) {
    if (e.code === 'limits') return { ...plan, problem: `${e.message}; nothing was changed` };
    return { ...plan, problem: 'one version of the Work file (this computer\'s, the server\'s or the last common one) is not valid JSON, so the two cannot be merged by item: nothing was changed' };
  }
  // A merge writes the whole list: both versions must come back as they are when written unchanged (store.mjs untidy).
  if (untidy(mine.text, mine.bad).length) return { ...plan, problem: 'this computer\'s Work file has things a write would change: tidy it once (Tidy the file once, or hoprig tasks tidy), then save again; nothing was changed' };
  if (theirsText !== null && untidy(theirsText).length) return { ...plan, problem: 'the server\'s Work file has things a write would change (it was written by hand somewhere): tidy it once on a computer that has it, then save again; nothing was changed' };
  let m;
  try {
    m = mergeItems(docs.base, docs.mine, docs.theirs, { decisions, ownerId: place.settings.ownerId, today: todayIn(place.settings.timeZone) });
  } catch (e) {
    return { ...plan, problem: e.message };
  }
  return {
    ...plan,
    remote: { ...remote, mode: 'merge', mine: m.mine, theirs: m.theirs, conflicts: m.conflicts, undecided: m.undecided, renamed: m.renamed },
    merge: { mineText: mine.text, theirsText, baseText, mergedText: serialize(m.doc, formatOf(mine.text)) },
  };
}

/**
 * The files the server's commits change (besides the Work file) that are changed here, staged, or here as files git
 * does not keep (an untracked or ignored file a fast-forward would overwrite): [path], or null when git could not say
 * (then git's own check in the fast-forward decides).
 */
async function clashes(top, head, upstream, rel, run) {
  const d = await gitRead(top, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', head, upstream], { run });
  if (!d.ok) return null;
  const paths = d.stdout.split('\0').filter((p) => p && p !== rel);
  if (!paths.length) return [];
  if (paths.length > 500) return null;
  const st = await gitRead(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames', '--', ...paths.map((p) => `:(literal)${p}`)], { run });
  if (!st.ok) return null;
  return st.stdout.split('\0').filter(Boolean).map((e) => e.slice(3));
}

/**
 * Whether git sends this branch to another place than the branch it follows: @{push} is not @{upstream}, or git names
 * no place to push it to (push.default "nothing", or "simple" with another branch name). false when the branch it
 * follows cannot be read (the fetch may bring it; the plan then says what it can).
 */
async function sentElsewhere(top, run) {
  const follows = await gitRead(top, ['rev-parse', '--symbolic-full-name', '@{upstream}'], { run });
  if (!follows.ok || !follows.stdout.trim()) return false;
  const pushTo = await gitRead(top, ['rev-parse', '--symbolic-full-name', '@{push}'], { run });
  return !pushTo.ok || pushTo.stdout.trim() !== follows.stdout.trim();
}

/** One version of a conflicted item as the page shows it: a few plain words, null when it was removed; a group of
 * items that share an id: { items: [...] }. */
function versionOf(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return { items: v.map(versionOf) };
  if (v && typeof v === 'object') {
    const pickStr = (k) => (typeof v[k] === 'string' ? v[k].slice(0, 300) : null);
    return { title: pickStr('title'), status: pickStr('state') || pickStr('status'), date: pickStr('date'), note: pickStr('note'), project: pickStr('project'), priority: pickStr('priority') };
  }
  return { text: JSON.stringify(v).slice(0, 300) };
}

/** The plan as the page and the commands get it: no full paths, no file content, no git output. */
export function publicPlan(p) {
  const r = p.remote;
  return {
    label: p.label, repo: p.repo, files: p.files, changes: p.changes, nothing: p.nothing, hash: p.hash || null, runs: p.runs ? p.runs.length : 0, notRuns: p.notRuns || [],
    unsent: p.unsent ? { saves: p.unsent.saves, others: p.unsent.others ? p.unsent.others.map((c) => ({ short: c.short, subject: c.subject })) : null } : { saves: 0, others: [] },
    ...(r ? {
      remote: {
        upstream: r.upstream, ahead: r.ahead, behind: r.behind, mode: r.mode,
        ...(r.message ? { message: r.message, code: r.code } : {}),
        ...(r.mode === 'merge' ? {
          mine: r.mine, theirs: r.theirs, undecided: r.undecided, renamed: r.renamed,
          conflicts: r.conflicts.map((c) => ({ key: c.key, name: c.name, title: c.title, decided: c.decided, mine: versionOf(c.mine), theirs: versionOf(c.theirs) })),
        } : {}),
      },
    } : {}),
    ...(p.problem ? { problem: cap(p.problem).replace(/([^.!?])$/, '$1.') } : {}),
    ...(p.code ? { code: p.code } : {}),
    ...(p.recovered ? { recovered: p.recovered } : {}),
    ...(p.kept ? { kept: p.kept } : {}),
  };
}
