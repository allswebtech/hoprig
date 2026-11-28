// Look at the disk and build the map it describes (map.mjs keeps the file, mergeMap the union with what the map had).
// Every place a project can be is looked at (groups.mjs): the projects folder, and in a map of version 2 each group.
// The disk never declares a group: groups, and the keys a later Hoprig fills in, come from the map as they were.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { MANIFEST, NAME_RE, discoverChildren, readManifest, relOk } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { groupFolders, safeFolders } from './groups.mjs';
import { isDir, isGitRepo, isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { BRANCH_RE, mapUrl, memberSpot, neverLook, placeOf, refOf, sameUrl, validateMap } from './mapcheck.mjs';

export const emptyMap = () => ({ version: 1, brain: { url: null }, projects: [], others: [] });

export const originOf = async (dir, run) => {
  const r = await gitRead(dir, ['config', '--get', 'remote.origin.url'], { run, timeout: 10_000 });
  if (!r.ok) return { url: null, why: 'not on a git server yet (no remote)' };
  try {
    return { url: mapUrl(r.stdout.trim()) };
  } catch (e) {
    return { url: null, why: e.message };
  }
};

/**
 * Git repositories in the workspace outside ai_brain/, the projects folder and every group's folder, up to 3 folders
 * deep. A group's folder is never entered: its repository and its members are entries of their own.
 */
function otherRepos(dir, projects, skipDirs = [], from = '') {
  const found = [];
  // `from`: a group's folder, walked below itself (its own repository is no "other"): every repository under it is
  // found, also under another one, and memberSpot decides what of it is a member.
  if (from) {
    const below = (rel, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (!d.isDirectory() || neverLook(d.name)) continue;
        const r = `${rel}/${d.name}`;
        if (isGitRepo(path.join(dir, r))) {
          if (!isLinkedWorktree(path.join(dir, r))) found.push(r);
        } else if (depth < 4) below(r, depth + 1);
      }
    };
    below(from, 1);
    return found.filter((r) => relOk(r)).sort();
  }
  const walk = (rel, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!d.isDirectory() || neverLook(d.name)) continue; // a link is not followed
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, r);
      if (!rel && (d.name === 'ai_brain' || d.name.startsWith('ai_brain.'))) continue; // the brain, and a brain kept aside
      if (path.resolve(abs) === path.resolve(projects) || skipDirs.includes(r)) continue;
      if (isGitRepo(abs)) {
        if (!isLinkedWorktree(abs)) found.push(r); // a linked worktree is another repository's second checkout
      } else if (depth < 3) walk(r, depth + 1);
    }
  };
  walk('', 1);
  return found.filter((r) => relOk(r)).sort();
}

/**
 * Look at the disk and build the map it describes. `previous` keeps the "skip" list, the groups and anything the disk
 * cannot say (the branch named in a project.json). → { map, notes: [what the person should know], manifests: [projects
 * whose project.json lacks a code repository found on disk], sources, roots } (sources and roots by <place>/<name>)
 */
export async function scanWorkspace({ dir = workspaceDir(), projects = projectsIn(), run = capture, previous = emptyMap() } = {}) {
  const skip = new Set(previous.skip || []);
  const v2 = previous.version === 2;
  const notes = [];
  const manifests = [];
  const sources = {}; // project → 'project.json' | 'found': whether its own project.json speaks for it
  const roots = {}; // project → its folder here (mergeMap asks what is in a code repository's folder)
  // What a person set in the map stays: "sync" on an entry (a tool made syncable again, or the other way round).
  const kept = new Map();
  for (const p of previous.projects || []) {
    if (typeof p.sync === 'boolean') kept.set(`project:${refOf(p)}`, p.sync);
    for (const r of p.repos || []) if (typeof r.sync === 'boolean') kept.set(`repo:${refOf(p)}/${r.dir}`, r.sync);
  }
  for (const o of previous.others || []) if (typeof o.sync === 'boolean') kept.set(`other:${o.dir}`, o.sync);
  const withSync = (e, k, dflt) => {
    const v = kept.has(k) ? kept.get(k) : dflt;
    return typeof v === 'boolean' ? { ...e, sync: v } : e;
  };
  const map = { version: v2 ? 2 : 1, brain: { url: null }, projects: [], others: [], ...(skip.size ? { skip: [...skip] } : {}) };
  if (v2) {
    for (const k of ['groups', 'credentials', 'storage']) if (previous[k] !== undefined) map[k] = JSON.parse(JSON.stringify(previous[k]));
    map.groups = map.groups || [];
  }
  // The projects folder, when it is not <workspace>/projects: kept relative to the workspace, never as a machine path.
  const rel = path.relative(dir, projects).split(path.sep).join('/');
  if (rel && rel !== 'projects') {
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && relOk(rel)) map.config = { projectsDir: rel };
    else notes.push('your projects folder is outside the workspace: the map cannot say where it is (a fresh computer uses <workspace>/projects)');
  }
  const brain = path.join(dir, 'ai_brain');
  if (isGitRepo(brain)) {
    const o = await originOf(brain, run);
    map.brain.url = o.url;
    if (!o.url) notes.push(`the AI brain: ${o.why}`);
  } else if (isDir(brain)) notes.push('the AI brain is not a git repository yet');
  // A group that is a repository: its folder here is that repository, or it is reported.
  for (const g of (v2 && previous.groups) || []) {
    const gdir = path.join(dir, ...g.dir.split('/'));
    if (!g.url || !isGitRepo(gdir)) continue;
    const o = await originOf(gdir, run);
    if (o.url && !sameUrl(o.url, g.url)) notes.push(`${g.dir}: the group's folder here is another repository (${o.url}) than the map says`);
  }
  // A folder here that is a linked worktree (a second checkout of another repository, often a session's temporary
  // one) is never added: not as a project, a code repository or another repository.
  // A place, member or code/ that leads out of where the map puts it is never followed (inside.mjs).
  for (const f of (await safeFolders(v2 ? previous : null, { dir, projects }, run)).folders) {
    if (f.members === 'own' && (!f.git || isLinkedWorktree(f.dir))) continue;
    if (f.members === 'group' && f.git) {
      notes.push(`${f.ref}: a repository of its own, but the members of ${f.place} come with the group's repository: left out`);
      continue;
    }
    if (skip.has(f.ref) || !NAME_RE.test(f.name)) continue;
    const o = f.members === 'own' ? await originOf(f.dir, run) : { url: null };
    if (!o.url && o.why) notes.push(`${f.ref}: ${o.why}`);
    // One project, one place: a folder with the address of a project the map has in another place is not added.
    const twin = o.url && [...(previous.projects || []).filter((p) => placeOf(p) !== f.place), ...((v2 && previous.groups) || []).map((g) => ({ name: g.dir, url: g.url }))].find((p) => p.url && sameUrl(p.url, o.url));
    if (twin) {
      notes.push(`${f.ref} has the address of ${refOf(twin)}, which the map has in another place: left out (one project is in one place; move the folder, or forget one of them)`);
      continue;
    }
    const { manifest, source } = await readManifest(f.dir, run);
    sources[f.ref] = source;
    roots[f.ref] = f.dir;
    const forgotten = (d) => skip.has(`${f.ref}/${d}`); // a code repository taken out with `workspace forget`
    const byDir = new Map();
    // What project.json names stays, whatever its folder here is: a linked worktree here may be a full clone with
    // its own branch on another computer, so this disk cannot tell a leftover (`workspace forget` takes one out).
    for (const r of (manifest && manifest.repos) || []) if (!forgotten(r.dir)) byDir.set(r.dir, { dir: r.dir, url: r.url, ...(r.branch ? { branch: r.branch } : {}) });
    const missingFromManifest = [];
    for (const c of await discoverChildren(f.dir, run)) {
      if (c.dir.split('/').some(neverLook) || forgotten(c.dir)) continue;
      if (!byDir.has(c.dir)) {
        byDir.set(c.dir, { dir: c.dir, url: c.url });
        if (c.url && source === MANIFEST) missingFromManifest.push({ dir: c.dir, url: c.url });
      }
      if (!c.url) notes.push(`${f.ref}/${c.dir}: not on a git server yet (no remote)`);
    }
    if (missingFromManifest.length) manifests.push({ name: f.ref, root: f.dir, add: missingFromManifest });
    const entry = { name: f.name, ...(f.place ? { in: f.place } : {}), url: o.url, repos: [...byDir.values()].map((r) => withSync(r, `repo:${f.ref}/${r.dir}`)) };
    if (manifest && Object.keys(manifest.memories || {}).length) entry.memories = { ...manifest.memories };
    const old = (previous.projects || []).find((p) => refOf(p) === f.ref);
    if (old && old.needs) entry.needs = [...old.needs]; // a later Hoprig's key: kept as it was
    map.projects.push(withSync(entry, `project:${f.ref}`));
  }
  // In a group's folder: what is no member (a tool folder of the group, a folder of folders in a plain group) is an
  // "other" repository too; members, places and the group's own repository are not (mapcheck.mjs memberSpot).
  const inGroups = [];
  for (const g of (v2 && previous.groups) || []) for (const r of otherRepos(dir, projects, [], g.dir)) if (!memberSpot(r, previous.groups)) inGroups.push(r);
  for (const r of [...otherRepos(dir, projects, groupFolders(v2 ? previous : null)), ...inGroups]) {
    if (skip.has(r)) continue;
    const o = await originOf(path.join(dir, r), run);
    if (!o.url) notes.push(`${r}: ${o.why}`);
    // The branch it is on (a toolchain is restored on its channel, e.g. "stable"), and tools are never synced.
    const b = await gitRead(path.join(dir, r), ['symbolic-ref', '--short', '-q', 'HEAD'], { run, timeout: 10_000 });
    // A folder on no branch (at a tag: a detached HEAD) says nothing about it: the line the map has stays, or computers on
    // a branch and at a tag take it out and put it back in turn, a commit of the map at every go-live.
    const was = ((previous.others || []).find((x) => x.dir === r) || {}).branch;
    const branch = b.ok && BRANCH_RE.test(b.stdout.trim()) ? b.stdout.trim() : BRANCH_RE.test(was || '') ? was : null;
    map.others.push(withSync({ dir: r, url: o.url, ...(branch ? { branch } : {}) }, `other:${r}`, r.split('/')[0] === 'development' ? false : undefined));
  }
  const v = validateMap(map);
  return { map: v.ok ? v.map : map, notes, manifests, sources, roots };
}
