// The upkeep never moves a project by itself: in the places that hold projects it neither fetches nor pushes. One
// switch per place (the automation setting workspace.pushBranches: { "<place>": true }, "projects" for the projects
// folder; off by default) lets it push work that is committed on a branch that is NOT the repository's default
// branch, so a computer that is lost costs nothing of it. A default branch is never pushed by itself: for some
// repositories a push there is a release.
//
// Nothing is ever forced. Every push is a plain push, with no option or refspec that lets it overwrite anything: git
// itself refuses one that is not a fast-forward, and a push the server refuses is said. Nothing is fetched or merged.
//
// For each project of such a place that is here (its parent and each code repository, tools left alone), every local
// branch other than the default one (origin/HEAD):
// - with an upstream: pushed to it when it is ahead of it and not behind, unless the upstream is the default branch;
//   ahead and behind (rewritten here, or moved on both sides) it is said;
// - whose upstream is another branch of this repository (git branch --track <local branch>): left alone, as it is not
//   the upkeep's to push (a push there would move the owner's own branch);
// - without an upstream, with a copy on the server known here (refs/remotes/origin/<name>: a push without -u, or a
//   fetch of somebody else's branch of that name): pushed there with --set-upstream only when that commit is an
//   ancestor of the branch here; otherwise (behind, rewritten here, or another branch of the same name) it is said;
// - that never had a copy on the server: pushed under its own name to origin with --set-upstream.
// A push of a branch without an upstream sets it (the first push, or one already on the server from a push without
// -u), so that the repository itself remembers it was pushed: when its branch on the server is removed later and a
// fetch here prunes it, it shows as gone and is never pushed back.
// A branch whose branch on the server was removed is said, never pushed back. A fetch that pruned it shows it here (its
// upstream is gone). When the last fetch did not prune, the server is asked once, before the first push of a
// repository in a round, which branches it has (git ls-remote --heads): a branch whose server copy known here is no
// longer there, or stands at another commit than the one last seen here (moved from elsewhere), is said and not
// pushed. When the server cannot be asked, nothing of that repository is pushed in that round, said once. A repository
// whose default branch is not known here is left alone, with the command that sets it. The same ask also reads which
// branch the server itself calls its default (ls-remote --symref): when that is not the one known here (the default
// was changed on the server after the clone, and a fetch never moves origin/HEAD), nothing of that repository is
// pushed, so the server's real default branch can never be taken for "another branch". Only branches that follow a
// branch of origin are pushed: one that follows another remote is said, never pushed (that remote's default branch is
// not known here).
import { gitRead } from '../gitread.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { gitIn } from './inside.mjs';
import { isGitRepo, isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { mapTargets } from './groups.mjs';
import { readMap } from './map.mjs';
import { PROJECTS_PLACE } from './mapcheck.mjs';

const last = (r) => (r.stderr || r.stdout || '').trim().split('\n').pop() || 'git failed';
/** A place's key in the setting: "projects" for the projects folder, else the place's folder. */
export const placeKey = (place) => place || PROJECTS_PLACE;

/** The branches of one repository: [{ name, upstream: 'origin/x' | '', tracking: 'refs/remotes/origin/x' | '', remote, merge, ahead, behind, gone }]. */
async function branchesOf(dir, run) {
  const r = await gitRead(dir, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream)', 'refs/heads'], { run });
  if (!r.ok) return null;
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [name, upstream, track, remote, merge, tracking] = l.split('\t');
    const n = (w) => Number((new RegExp(`${w} (\\d+)`).exec(track || '') || [])[1] || 0);
    return { name, upstream, tracking, remote, merge: (merge || '').replace(/^refs\/heads\//, ''), ahead: n('ahead'), behind: n('behind'), gone: /gone/.test(track || '') };
  });
}

/** What `git ls-remote --symref` printed: Map('refs/heads/<name>' → commit). */
const headsOf = (text) => new Map(text.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2 && p[1].startsWith('refs/heads/')).map(([c, ref]) => [ref, c]));
/** The branch the server calls its default ("ref: refs/heads/main	HEAD"), or ''. */
const serverDefaultOf = (text) => (/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(text) || [])[1] || '';

/**
 * One round. `on`: the place keys whose switch is on. → { repos: [{ label, pushed: [branch], todo: [{ why, command }] }] }
 */
export async function pushBranches({ dir = workspaceDir(), projects = projectsIn(), on = [], run = capture } = {}) {
  const want = new Set(on);
  const out = { repos: [] };
  if (!want.size) return out;
  const m = readMap(dir);
  if (!m.exists || m.errors) return out;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const t of await mapTargets(m.map, { dir, projects }, run)) {
    if (!['project', 'repo'].includes(t.kind) || !want.has(placeKey(t.place)) || t.blocked) continue;
    if (t.entry.sync === false || !isGitRepo(t.dir) || isLinkedWorktree(t.dir)) continue;
    const at = { root: t.root, dir, projects };
    const e = { label: t.label, pushed: [], todo: [] };
    const git = (...args) => showCommand(['git', '-C', t.dir, ...args]);
    const head = await gitRead(t.dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { run });
    const def = head.ok ? head.stdout.trim().replace(/^origin\//, '') : '';
    const bs = def ? await branchesOf(t.dir, run) : null;
    if (!def || !bs) {
      e.todo.push({ why: 'its default branch is not known on this computer, so no branch of it is pushed by itself', command: git('remote', 'set-head', 'origin', '--auto') });
      out.repos.push(e);
      continue;
    }
    const commit = async (ref) => {
      const r = await gitRead(t.dir, ['rev-parse', '--verify', '-q', ref], { run });
      return r.ok ? r.stdout.trim() : '';
    };
    // What would go up: [{ name, remote, to: [remote, refspec], server: the server's branch as known here | '', seen: its commit as last seen here, track: set the upstream }]
    const plan = [];
    for (const b of bs) {
      if (b.name === def) continue;
      // Its upstream is another branch here (its remote "."): not the upkeep's, a push would move the owner's branch.
      if (b.upstream && (b.remote === '.' || !b.remote)) continue;
      // Its branch on the server was removed (merged, deleted on purpose) and a fetch here pruned it: never put back.
      if (b.gone || (!b.upstream && b.merge)) {
        e.todo.push({ why: `${b.name}: its branch on the git server was removed, so it is not pushed by itself (if it is done: ${git('branch', '-d', b.name)})`, command: git('push', '-u', 'origin', b.name) });
        continue;
      }
      if (b.upstream) {
        if (b.merge === def || !b.ahead) continue; // never into the default branch; nothing new
        if (b.remote !== 'origin') {
          e.todo.push({ why: `${b.name} follows a branch of another git server (${b.remote}), so it is not pushed by itself`, command: git('push', b.remote, `${b.name}:${b.merge}`) });
          continue;
        }
        if (b.behind) {
          e.todo.push({ why: `${b.name} and its upstream have both moved: not pushed`, command: git('status') });
          continue;
        }
        const seen = await commit(b.tracking);
        if (!seen) continue;
        plan.push({ name: b.name, remote: b.remote, to: [b.remote, `refs/heads/${b.name}:refs/heads/${b.merge}`], server: `refs/heads/${b.merge}`, seen });
        continue;
      }
      const [mine, there] = await Promise.all([commit(`refs/heads/${b.name}`), commit(`refs/remotes/origin/${b.name}`)]);
      if (!there) {
        // Never on the server: the first push sets its upstream.
        plan.push({ name: b.name, remote: 'origin', to: ['origin', `refs/heads/${b.name}:refs/heads/${b.name}`], server: '', seen: '', track: true });
        continue;
      }
      if (mine === there) continue; // pushed before, nothing new
      const anc = await gitRead(t.dir, ['merge-base', '--is-ancestor', `refs/remotes/origin/${b.name}`, `refs/heads/${b.name}`], { run });
      if (!anc.ok) {
        e.todo.push({ why: `${b.name} and its branch on the git server have both moved, or it was rewritten here: not pushed`, command: git('status') });
        continue;
      }
      plan.push({ name: b.name, remote: 'origin', to: ['origin', `refs/heads/${b.name}:refs/heads/${b.name}`], server: `refs/heads/${b.name}`, seen: there, track: true });
    }
    if (plan.length) {
      // The server is asked once which branches it has and which one it calls its default (every plan goes to origin).
      const heads = new Map();
      let cannot = null;
      const r = await gitIn(at, t.dir, ['ls-remote', '--symref', '--', 'origin'], run, { env });
      if (!r.ok) {
        cannot = true;
        e.todo.push({ why: `its git server could not be asked which branches it has (${last(r)}), so no branch of it is pushed in this round`, command: git('ls-remote', '--heads', 'origin') });
      } else {
        const theirs = serverDefaultOf(r.stdout || '');
        heads.set('origin', headsOf(r.stdout || ''));
        if (theirs !== def) {
          cannot = true;
          e.todo.push({ why: `its git server calls ${theirs || 'no branch'} its default branch, and this computer knows ${def}, so no branch of it is pushed by itself until this computer knows the server's default`, command: git('remote', 'set-head', 'origin', '--auto') });
        }
      }
      for (const p of cannot ? [] : plan) {
        const now = p.server ? heads.get(p.remote).get(p.server) : '';
        if (p.server && !now) {
          e.todo.push({ why: `${p.name}: its branch on the git server was removed, so it is not pushed by itself (to see it here: ${git('fetch', '--prune')})`, command: git('fetch', '--prune') });
          continue;
        }
        if (p.server && now !== p.seen) {
          e.todo.push({ why: `${p.name}: its branch moved on the git server from elsewhere, so it is not pushed by itself (to see it here: ${git('fetch')})`, command: git('fetch') });
          continue;
        }
        const r = await gitIn(at, t.dir, ['push', '--quiet', ...(p.track ? ['--set-upstream'] : []), '--', ...p.to], run, { env });
        if (r.ok) e.pushed.push(p.name);
        else e.todo.push({ why: `${p.name} could not be pushed: ${last(r)}`, command: git('push', ...(p.track ? ['-u'] : []), ...p.to) });
      }
    }
    if (e.pushed.length || e.todo.length) out.repos.push(e);
  }
  return out;
}
