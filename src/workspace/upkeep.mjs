// The map keeps building itself (the automation's "map" part, src/automation/workspacesync.mjs): look at the
// workspace the way `hoprig workspace map` does and write workspace.json only when something would change (the
// union rule of map.mjs). It never makes the first map: that stays a person's `hoprig workspace map`. It leaves
// project.json files alone (they belong to their projects' repositories).
//
// With `commit` (the "commitMap" switch, off by default) the change is saved in the brain's history: only
// workspace.json is added and committed, with the brain's own git name and e-mail, and never while the brain has
// other staged changes (then it says so and leaves everything as it is). With `push` (the existing "push" switch)
// it is uploaded only when the brain's branch is purely ahead of its upstream, the same rule as sync.
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { repoInfo } from '../pcsetup/workspace.mjs';
import { LEAVES, gitIn, myLinkCommand } from './inside.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { toolsState, waitingLine } from './grouptool.mjs';
import { COMMIT_MESSAGE, MAP_FILE, readMap, updateMap } from './map.mjs';

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
 * Save workspace.json, and only it, in the brain's history (the "commitMap" switch, and the page's "Save it now").
 * Never while the brain has other staged changes: they would ride along. → { done, why?, staged?, failed? }
 */
export async function commitMap({ dir = workspaceDir(), run = capture } = {}) {
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) return { done: false, why: 'the brain is not a git repository' };
  const staged = await gitRead(brain, ['diff', '--cached', '--quiet'], { run });
  if (!staged.ok) return { done: false, staged: true, why: 'the brain has other staged changes: the map was written but not committed' };
  const at = { root: brain, dir };
  await gitIn(at, brain, ['add', '--', MAP_FILE], run);
  const c = await gitIn(at, brain, ['commit', '--quiet', '-m', COMMIT_MESSAGE, '--', MAP_FILE], run);
  if (!c.ok) return { done: false, failed: true, why: (c.stderr || c.stdout || '').trim().split('\n').pop() || 'git failed' };
  return { done: true };
}

/**
 * One round. → { skipped?: why, changed, lines: [activity lines], needs: [what needs the owner], commit?: { done,
 * why? }, pushed?: { done, why? } }
 */
export async function upkeepMap({ dir = workspaceDir(), projects = projectsIn(), commit = false, push = false, run = capture } = {}) {
  const cur = readMap(dir);
  if (!cur.exists) return { skipped: 'no map yet (hoprig workspace map makes the first one)', changed: false, lines: [], needs: [] };
  if (cur.errors) return { skipped: 'the map was refused', changed: false, lines: [], needs: [`the workspace map was refused: ${cur.errors[0]}`] };
  // The upkeep never throws: a map that cannot be written is skipped, with its reason (status shows it too).
  try {
    return await upkeepRound({ dir, projects, commit, push, run });
  } catch (e) {
    // A brain (or a map file's folder) behind a link that leads out: the command that names the link is the fix.
    const fix = e.code === 'ELEAVES' && e.leaves && e.leaves.what === LEAVES ? `; if the link is yours:  ${myLinkCommand(e.leaves.path)}` : '';
    return { skipped: e.message, changed: false, lines: [], needs: [`the workspace map: ${e.message}${fix}`] };
  }
}

async function upkeepRound({ dir, projects, commit, push, run }) {
  const look = await updateMap({ dir, projects, dryRun: true, run, manifests: false });
  // Repositories with no address: something only the owner can fix (give them a remote, or forget them).
  const needs = look.notes.filter((n) => /not on a git server yet/.test(n));
  // A folder left out of the map (one repository, one place): the rest is written, this one is said every round.
  for (const l of look.left) needs.push(`${l.ref} is not put into the map: ${l.why}; rename or move one of the folders`);
  // A group's own command waiting for the owner's yes on this computer: only said, never made by the upkeep.
  try {
    const waiting = waitingLine(await toolsState({ dir, projects }));
    if (waiting) needs.push(waiting);
  } catch {
    /* the settings cannot be read: status says why */
  }
  const changed = !look.diff.same || look.otherChanges;
  if (!changed) return { changed: false, lines: [], needs };
  const r = await updateMap({ dir, projects, run, manifests: false });
  const out = { changed: true, lines: changeLines(r), needs };
  if (!commit) return out;
  const brain = path.join(dir, 'ai_brain');
  const c = await commitMap({ dir, run });
  out.commit = c.done ? { done: true } : { done: false, why: c.why };
  if (!c.done) {
    if (c.staged) out.needs.push(`the brain has staged changes, so the updated map was not committed: ${showCommand(['git', '-C', brain, 'status'])}`);
    else if (c.failed) out.needs.push(`the updated map could not be committed in the brain: ${c.why}`);
    return out;
  }
  if (!push) return out;
  const s = await repoInfo(brain, run);
  if (!s.ok || !s.upstream || s.behind || !s.ahead) {
    out.pushed = { done: false, why: !s.ok ? s.error : !s.upstream ? 'the brain has no upstream' : s.behind ? `the brain is ${s.behind} behind its upstream: sync first` : 'nothing to upload' };
    if (s.ok && s.upstream && s.behind) out.needs.push(`the brain and its git server have both moved: ${showCommand(['git', '-C', brain, 'pull', '--rebase'])}`);
    return out;
  }
  const p = await gitIn({ root: brain, dir }, brain, ['push', '--quiet'], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  out.pushed = p.ok ? { done: true } : { done: false, why: (p.stderr || '').trim().split('\n').pop() || 'push failed' };
  if (!p.ok) out.needs.push(`the updated map could not be uploaded: ${out.pushed.why}`);
  return out;
}
