// The map keeps building itself (the automation's "map" part, src/automation/workspacesync.mjs): look at the
// workspace the way `hoprig workspace map` does and write workspace.json only when something would change (the
// union rule of map.mjs). It never makes the first map: that stays a person's `hoprig workspace map`. It leaves
// project.json files alone (they belong to their projects' repositories). A computer with a label also writes its
// own file in the brain, computers/<label>.json (computer.mjs), when something in it changed; one without a label
// writes none and is never asked.
//
// With `commit` (the "commitMap" switch) the map and this computer's own file are saved in the brain's history, in
// one commit of those two files only, with the brain's own git name and e-mail, and never while the brain has other
// staged changes (then it says so and leaves everything as it is). With `memory` (the "memory" switch) the brain's
// memory folder and each group's own memory folders are committed too, and only them. With `push` the brain is
// fetched and uploaded when it is purely ahead; when the brain here and on the git server have both moved and the only
// difference on this side is the map or this computer's file, mapkeep.mjs brings it in step by its own rule (never
// git's text merge).
import path from 'node:path';
import { repoInfo } from '../pcsetup/workspace.mjs';
import { LEAVES, myLinkCommand } from './inside.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { toolsState, waitingLine } from './grouptool.mjs';
import { COMMIT_MESSAGE, normalizeMap, readMap, updateMap, writeMap } from './map.mjs';
import { writeOwnFile } from './computer.mjs';
import { mapTargets } from './groups.mjs';
import { addressWords, brainBusy, commitOwnFiles, finishPending, keepAddresses, keepMapInStep, leftWords } from './mapkeep.mjs';
import { commitMemory } from '../pcsetup/workspace.mjs';

/** Activity lines for what changed: "The map gained shop/code/shop-admin", … */
export function changeLines(r) {
  return [
    ...r.diff.added.map((l) => `The map gained ${l}`),
    ...r.diff.changed.map((c) => `${c.label} has a new address in the map`),
    ...r.takenOut.map((t) => `${t.dir} was taken out of ${t.project} by its project.json`),
    ...(r.otherChanges ? ['The map\'s projects folder, memory links or tools changed'] : []),
  ];
}

/**
 * Save the map and this computer's own file, and only them, in the brain's history (the "commitMap" switch, and the
 * page's "Save it now"). Never while the brain has other staged changes: they would ride along. → { done, why?,
 * staged?, failed?, nothing? }
 */
export async function commitMap({ dir = workspaceDir(), run = capture } = {}) {
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) return { done: false, why: 'the brain is not a git repository' };
  return commitOwnFiles({ dir, run, message: COMMIT_MESSAGE });
}

/**
 * One round. → { skipped?: why, changed, lines: [activity lines], needs: [what needs the owner], commit?: { done,
 * why? }, pushed?: { done, why? } }
 */
export async function upkeepMap({ dir = workspaceDir(), projects = projectsIn(), commit = false, push = false, memory = false, run = capture, holdOwn = false } = {}) {
  const cur = readMap(dir);
  if (!cur.exists) return { skipped: 'no map yet (hoprig workspace map makes the first one)', changed: false, lines: [], needs: [] };
  if (cur.errors) return { skipped: 'the map was refused', changed: false, lines: [], needs: [`the workspace map was refused: ${cur.errors[0]}`] };
  // The upkeep never throws: a map that cannot be written is skipped, with its reason (status shows it too).
  try {
    return await upkeepRound({ dir, projects, commit, push, memory, run, holdOwn });
  } catch (e) {
    // A brain (or a map file's folder) behind a link that leads out: the command that names the link is the fix.
    const fix = e.code === 'ELEAVES' && e.leaves && e.leaves.what === LEAVES ? `; if the link is yours:  ${myLinkCommand(e.leaves.path)}` : '';
    return { skipped: e.message, changed: false, lines: [], needs: [`the workspace map: ${e.message}${fix}`] };
  }
}

async function upkeepRound({ dir, projects, commit, push, memory, run, holdOwn }) {
  const brain = path.join(dir, 'ai_brain');
  const lines = [];
  // A round of the rule that was cut off after it moved the branch: what this side's map held is united in first.
  const pend = await finishPending({ dir });
  if (pend.finished) lines.push('The map kept from a round that was cut off was put back into the map');
  const look = await updateMap({ dir, projects, dryRun: true, run, manifests: false });
  // Repositories with no address: something only the owner can fix (give them a remote, or forget them).
  const needs = look.notes.filter((n) => /not on a git server yet/.test(n));
  if (pend.why) needs.push(pend.why);
  for (const l of pend.left || []) needs.push(leftWords(l));
  // A folder left out of the map (one repository, one place): the rest is written, this one is said every round.
  for (const l of look.left) needs.push(leftWords(l));
  // A group's own command waiting for the owner's yes on this computer: only said, never made by the upkeep.
  try {
    const waiting = waitingLine(await toolsState({ dir, projects }));
    if (waiting) needs.push(waiting);
  } catch {
    /* the settings cannot be read: status says why */
  }
  // An entry whose folder here has another address than the map has: the map keeps its own, and the owner is told
  // (two computers with one name for two addresses would otherwise change it back and forth on the git server every
  // round). The upkeep never rewrites an address; `hoprig workspace map`, run by a person, does.
  const before = readMap(dir).map;
  const clash = before ? look.diff.changed.filter((c) => c.from && c.to) : [];
  for (const c of clash) needs.push(addressWords(c));
  const next = clash.length ? keepAddresses(look.map, before, clash) : look.map;
  const changed = clash.length ? JSON.stringify(normalizeMap(next)) !== JSON.stringify(normalizeMap(before)) : !look.diff.same || look.otherChanges;
  const out = { changed, lines, needs };
  if (changed) {
    const r = await updateMap({ dir, projects, run, manifests: false });
    if (clash.length) writeMap(keepAddresses(r.map, before, clash), dir);
    lines.push(...changeLines({ ...r, diff: { ...r.diff, changed: r.diff.changed.filter((c) => !clash.some((k) => k.label === c.label)) } }));
  }
  // This computer's own file: written when something in it changed; never without a label (status says so).
  const own = await writeOwnFile({ dir, projects });
  if (own.written) {
    out.changed = true;
    lines.push('This computer\'s file in the brain was brought up to date');
  } else if (own.why && own.file) needs.push(own.why); // a file of another computer under this label: the owner's to settle
  // A rebase, merge, cherry-pick or revert under way in the brain, or no branch: nothing is committed into it (it would
  // land inside the owner's work, or on a commit no branch holds), and he is told.
  if ((memory || commit) && isGitRepo(brain)) {
    const busy = await brainBusy(brain, run);
    if (busy) {
      needs.push(busy);
      if (commit) out.commit = { done: false, why: busy };
      return out;
    }
  }
  if (memory && isGitRepo(brain)) {
    const m = await commitMemory(brain, { '.': 'claude-memory' }, run, { root: brain, dir });
    if (m.committed) lines.push('The AI brain\'s memory was committed');
    out.memory = m;
    // Each group that is a repository and keeps memory of its own: its memory folders, and only them (sync's push
    // uploads them when pushing is on).
    const cur = readMap(dir);
    for (const t of cur.map ? (await mapTargets(cur.map, { dir, projects }, run)).filter((x) => x.kind === 'group' && x.entry.url && x.entry.memories && !x.blocked && isGitRepo(x.dir)) : []) {
      const g = await commitMemory(t.dir, t.entry.memories, run, { dir, projects });
      if (g.committed) lines.push(`The memory of ${t.label} was committed`);
    }
  }
  if (!commit) return out;
  const c = await commitMap({ dir, run });
  if (c.done) out.commit = { done: true };
  // The switch is on and nothing new had to be committed (an earlier round did, or the rule below does): the activity
  // line says saved, never that saving is off.
  else if (c.nothing) out.commit = { done: true, nothing: true };
  else {
    out.commit = { done: false, why: c.why };
    if (c.staged) out.needs.push(`the brain has staged changes, so the updated map was not committed: ${showCommand(['git', '-C', brain, 'status'])}`);
    else if (c.busy) out.needs.push(c.why);
    else if (c.failed) out.needs.push(`the updated map could not be committed in the brain: ${c.why}`);
    return out;
  }
  // Without the "push" switch only Hoprig's own map commits go up (mapkeep.mjs ownOnly): the brain is never left parted
  // from its git server by the default switches, and nothing of the owner's own is uploaded.
  const s = await repoInfo(brain, run);
  if (!push && (holdOwn || !s.ok || !s.upstream)) return out; // holdOwn: a caller that wants the commit kept here (tests of the rule's edges)
  if (!s.ok || !s.upstream) {
    if (out.commit) out.pushed = { done: false, why: !s.ok ? s.error : 'the brain has no upstream' };
    // Pushing is on and the brain's branch goes nowhere: said (once: the same list is not told again), never silent.
    if (s.ok) needs.push(`the brain's branch ${s.branch} has no upstream on a git server, so the map is not uploaded: ${showCommand(['git', '-C', brain, 'push', '-u', 'origin', s.branch])} (or hoprig workspace git, when the brain has no git server yet)`);
    return out;
  }
  // The map kept on the git server by itself: fetched every round, so a change another computer made arrives here too.
  // Purely ahead: uploaded. Behind, or both moved with only the map here: the rule of mapkeep.mjs.
  const k = await keepMapInStep({ dir, projects, run, ownOnly: !push });
  lines.push(...k.lines);
  needs.push(...k.needs);
  out.pushed = k.pushed ? { done: true } : { done: false, why: k.stopped || 'nothing to upload' };
  if (k.resolved) out.changed = true;
  return out;
}
