// The workspace map: <workspace>/ai_brain/workspace.json, one file that says which git repositories make up the
// workspace and where each one goes, so a fresh computer can get all of it (restore.mjs). It lives in the AI brain
// because the brain is the one repository every computer has. It holds addresses, never content:
//
//   { "version": 1,
//     "config"?:  { "projectsDir": "<folder in the workspace>" }      only when it is not "projects"
//     "brain":    { "url": "<address of the brain>" | null },
//     "projects": [ { "name": "<project>", "url": "<its parent repository>" | null,
//                     "memories"?: { "<folder in the project>": "<its memory folder>" },   as in project.json
//                     "repos": [ { "dir": "code/<repo>", "url": "<address>" | null, "branch"?, "sync"? } ], "sync"? } ],
//     "others":   [ { "dir": "<folder in the workspace, e.g. git/<name>>", "url": "<address>" | null, "branch"?, "sync"? } ],
//     "skip"?:    [ "<project name>" | "<project>/<dir>" | "<others dir>" ] }   taken out with `workspace forget`: never added again
//
// Version 2 adds "groups" (an owner's own folders of projects, groups.mjs), "in" on a project (the group or held
// folder it is in; without it the projects folder) and names a project outside the projects folder <place>/<name>
// everywhere (skip, labels, commands). mapcheck.mjs has the strict check of both versions. A map of version 1 stays
// version 1 until the owner runs `hoprig workspace map --upgrade` (mapupgrade.mjs): the upkeep never upgrades one.
//
// "sync": false marks a tool (an SDK or tool checkout, by default everything under development/): restore gets it
// on its branch, sync never touches it. The config is what a fresh computer needs to become the same place; it is
// never a machine path, a host name or anything from credentials/.
//
// A project's own project.json stays the truth for its code repositories; the map repeats them so that one file is
// enough to rebuild everything. Addresses are stored without a user name or password (a token in an address would
// travel with the brain), and are checked with the same parser the project code uses. A repository without a
// remote has url null: it is reported ("not on a git server yet"), never guessed. Folders named no-ai, ignore,
// ai-ignore-dir, credentials, node_modules and dot-folders are never looked into.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { MANIFEST, readManifest, relOk, writeManifest } from '../pcsetup/workspace.mjs';
import { LEAVES, kindAt, leaves, leavesWords, myLinkCommand, myLinkEntries, readIn, realOf, writeIn } from './inside.mjs';
import { capture, showCommand, showCommands } from '../setup/system.mjs';
import { findProject, ignoreFileOf, mapTargets, missingIgnoreLines, safeFolders, unignoredMembers } from './groups.mjs';
import { isDir, isGitRepo, isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { onePlace, refOf, sameUrl, validateMap } from './mapcheck.mjs';
import { emptyMap, scanWorkspace } from './mapscan.mjs';

export { BRANCH_RE, mapUrl, neverLook, refOf, placeOf, sameUrl, urlKey, validateMap } from './mapcheck.mjs';
export { emptyMap, scanWorkspace } from './mapscan.mjs';
export const MAP_FILE = 'workspace.json';
export const COMMIT_MESSAGE = 'Update the workspace map';
/** The map's commit, printed for the owner to paste. */
const commitCommand = (brain) => showCommands([['git', '-C', brain, 'add', MAP_FILE], ['git', '-C', brain, 'commit', '-m', COMMIT_MESSAGE]]);
export const mapFile = (dir = workspaceDir()) => path.join(dir, 'ai_brain', MAP_FILE);

/**
 * The map on this computer: { exists, map, errors? }. A missing file is an empty map. The brain is a repository from a
 * git server: a workspace.json it tracks as a link (to a credentials file, another map) is never read, and the words
 * of a refusal never quote the file's content.
 */
export function readMap(dir = workspaceDir()) {
  const file = mapFile(dir);
  const kind = kindAt(file);
  if (kind === 'none') return { exists: false, map: emptyMap() };
  if (kind !== 'file') return { exists: true, map: null, errors: [`${MAP_FILE} is ${kind === 'link' ? 'a link' : 'not a regular file'}: not read`] };
  // Inside the brain, never through a link below it (the brain's own folder may be the owner's link: `below`).
  const buf = readIn({ root: path.dirname(file), dir }, file, { below: true });
  if (!buf) return { exists: true, map: null, errors: [`${MAP_FILE} could not be read`] };
  let raw;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    return { exists: true, map: null, errors: [`${MAP_FILE} is not valid JSON`] };
  }
  const v = validateMap(raw);
  return v.ok ? { exists: true, map: v.map } : { exists: true, map: null, errors: v.errors };
}

/** Write the map (sorted, so its git history shows real changes only). Every address is checked again. */
export function writeMap(map, dir = workspaceDir()) {
  // A duplicate address the map on disk has already (a merge on the git server brought it) never blocks a write.
  const cur = readMap(dir);
  const v = validateMap(map, { write: true, known: cur.map ? onePlace(cur.map) : [] });
  if (!v.ok) throw Object.assign(new Error(`the map was not written: ${v.errors.join('; ')}`), { status: 409 });
  const m = normalizeMap(v.map);
  const file = mapFile(dir);
  if (!isDir(path.dirname(file))) throw new Error('there is no AI brain to keep the map in (hoprig workspace setup, or restore)');
  // Inside the brain, never through a link (inside.mjs): written beside it and renamed over it.
  writeIn({ root: path.dirname(file), dir }, file, JSON.stringify(m, null, 2) + '\n', { atomic: true });
  return m;
}

/** Entries that are tools (sync false): labels, as `status` and `sync` show them. */
export function toolsOf(map) {
  const out = [];
  for (const p of map.projects || []) {
    if (p.sync === false) out.push(refOf(p));
    for (const r of p.repos || []) if (r.sync === false) out.push(`${refOf(p)}/${r.dir}`);
  }
  for (const o of map.others || []) if (o.sync === false) out.push(o.dir);
  return out;
}

/** The map in its written order (sorted), for writing and for "did anything change?". */
export function normalizeMap(m) {
  const n = JSON.parse(JSON.stringify(m));
  n.projects.sort((a, b) => refOf(a).localeCompare(refOf(b)));
  for (const p of n.projects) p.repos.sort((a, b) => a.dir.localeCompare(b.dir));
  n.others.sort((a, b) => a.dir.localeCompare(b.dir));
  if (n.groups) n.groups.sort((a, b) => a.dir.localeCompare(b.dir));
  return n;
}

const key = (kind, id) => `${kind}:${id}`;
const flat = (m) => {
  const out = new Map();
  if (!m) return out;
  out.set(key('brain', 'ai_brain'), m.brain.url);
  for (const g of m.groups || []) if (g.url) out.set(key('group', g.dir), g.url); // a group that is a repository
  for (const p of m.projects) {
    out.set(key('project', refOf(p)), p.url);
    for (const r of p.repos) out.set(key('repo', `${refOf(p)}/${r.dir}`), r.url);
  }
  for (const o of m.others) out.set(key('other', o.dir), o.url);
  return out;
};

/** What changed between two maps: { added: [label], removed: [label], changed: [{ label, from, to }] }. */
export function diffMap(before, after) {
  const a = flat(before);
  const b = flat(after);
  const label = (k) => k.slice(k.indexOf(':') + 1);
  const added = [...b.keys()].filter((k) => !a.has(k)).map(label);
  const removed = [...a.keys()].filter((k) => !b.has(k)).map(label);
  const changed = [...b.keys()].filter((k) => a.has(k) && (a.get(k) || null) !== (b.get(k) || null) && !sameUrl(a.get(k), b.get(k))).map((k) => ({ label: label(k), from: a.get(k) || null, to: b.get(k) || null }));
  return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
}

/**
 * The map is the union of the workspace across your computers, not a picture of this disk. So: what is here is
 * added or updated; what the map has and this computer does not STAYS as it is ("in the map, not on this
 * computer"); only `forget` takes something out. One exception, because a project's own project.json is the truth
 * for that project: when the project IS here and its project.json no longer names a code repository the map has
 * (and its folder is not here either), that repository is taken out of the project. A folder here that is a linked
 * worktree does not count as "not here" for this: the same folder name may be a full clone on another computer, so
 * taking it out here would only flip the map between the two on every upkeep. A brain without a remote here
 * and a projects folder this map cannot describe never blank what the map says.
 *
 * Nothing else ever leaves the map by itself: not because of its address (two entries with one address may be two
 * clones someone keeps), and not because its folder here is a linked worktree (the same folder name may be a full
 * clone on another computer). Such an entry is "in the map, not on this computer" like any other. Groups, and the
 * keys a later Hoprig fills in, are the map's (the disk never declares them) and are kept as they are.
 * → { map, notHere: [label], takenOut: [{ project, dir }] } (a project as <name> or <place>/<name>)
 */
export function mergeMap(cur, scan) {
  const disk = scan.map;
  const out = JSON.parse(JSON.stringify(disk));
  if (!cur) return { map: out, notHere: [], takenOut: [] };
  const notHere = [];
  const takenOut = [];
  const skip = new Set(cur.skip || []);
  if (!out.brain.url && cur.brain.url) out.brain.url = cur.brain.url;
  if (!out.config && cur.config) out.config = { ...cur.config };
  out.version = cur.version;
  for (const k of ['groups', 'credentials', 'storage']) if (cur[k] !== undefined) out[k] = JSON.parse(JSON.stringify(cur[k]));
  for (const old of cur.projects) {
    const ref = refOf(old);
    if (skip.has(ref)) continue;
    const here = out.projects.find((p) => refOf(p) === ref);
    if (!here) {
      out.projects.push(JSON.parse(JSON.stringify(old)));
      notHere.push(ref, ...old.repos.map((r) => `${ref}/${r.dir}`));
      continue;
    }
    if (!here.url && old.url) here.url = old.url;
    if (!here.memories && old.memories) here.memories = { ...old.memories };
    for (const r of old.repos) {
      if (here.repos.some((x) => x.dir === r.dir) || skip.has(`${ref}/${r.dir}`)) continue;
      const root = scan.roots && scan.roots[ref];
      const worktreeHere = root && isLinkedWorktree(path.join(root, r.dir));
      if (scan.sources && scan.sources[ref] === MANIFEST && !worktreeHere) takenOut.push({ project: ref, dir: r.dir });
      else {
        here.repos.push(JSON.parse(JSON.stringify(r)));
        notHere.push(`${ref}/${r.dir}`);
      }
    }
  }
  for (const old of cur.others) {
    if (skip.has(old.dir)) continue;
    const here = out.others.find((o) => o.dir === old.dir);
    if (!here) {
      out.others.push(JSON.parse(JSON.stringify(old)));
      notHere.push(old.dir);
    } else if (!here.url && old.url) here.url = old.url;
  }
  if (cur.skip && cur.skip.length) out.skip = [...cur.skip];
  return { map: out, notHere, takenOut };
}

/**
 * What a scan found that would break "one repository, one place" against what the map has (onePlace: a folder whose
 * name differs from another's in that place only in letter case, an address the map has in another place): the NEW
 * entry is left out and said, and everything else is written. Without this one such folder stopped every write of
 * the map. A pair the map has already stays (status names it). → { map, left: [{ ref, why }] }
 */
export function leaveOutNew(cur, map) {
  const known = cur ? onePlace(cur) : [];
  const had = new Set(((cur && cur.projects) || []).map(refOf));
  const left = [];
  let out = map;
  for (let i = 0; i < 50; i++) {
    const d = onePlace(out).find((x) => !known.some((k) => k.key === x.key) && (!had.has(x.a) || !had.has(x.b)));
    if (!d) break;
    const ref = had.has(d.b) ? d.a : d.b;
    left.push({ ref, why: d.message });
    out = { ...out, projects: out.projects.filter((p) => refOf(p) !== ref) };
  }
  return { map: out, left };
}

/**
 * `workspace map`: add or update what is on this computer, keep everything else (mergeMap), show the difference,
 * write it (unless dryRun), and add code repositories found on disk to a project.json that lacks them (that file
 * stays the truth for its project). Never commits.
 * → { file, dryRun, diff, map, notHere, notFollowed, takenOut, left, notes, tools, otherChanges, manifests, commit }
 * (`left`: leaveOutNew's; `notFollowed`: entries kept that are here behind a link that leads out)
 */
export async function updateMap({ dir = workspaceDir(), projects = projectsIn(), dryRun = false, run = capture, manifests: touchManifests = true, as = null } = {}) {
  // `as` (a dry run only): the map as a change not written yet would leave it (a group add's confirmation).
  const cur = as && dryRun ? { exists: true, map: as } : readMap(dir);
  if (cur.errors) throw Object.assign(new Error(`${MAP_FILE} was not changed: ${cur.errors.join('; ')}`), { status: 409 });
  const scan = await scanWorkspace({ dir, projects, run, previous: cur.map });
  const merged = mergeMap(cur.exists ? cur.map : null, scan);
  const kept = leaveOutNew(cur.exists ? cur.map : null, merged.map);
  // An entry the scan did not find because its folder is behind a link that leads out is here, only not followed.
  const blocked = cur.exists ? (await mapTargets(cur.map, { dir, projects }, run)).filter((t) => t.blocked).map((t) => t.label) : [];
  const behind = (l) => blocked.some((b) => l === b || l.startsWith(`${b}/`));
  const next = validateMap(kept.map).ok ? validateMap(kept.map).map : kept.map;
  const diff = diffMap(cur.exists ? cur.map : null, next);
  const changed = !cur.exists || JSON.stringify(normalizeMap(cur.map)) !== JSON.stringify(normalizeMap(next));
  if (!dryRun) {
    if (changed) writeMap(next, dir);
    // (The automatic upkeep leaves project.json files alone: they belong to their projects' own repositories.)
    for (const m of touchManifests ? scan.manifests : []) {
      const { manifest } = await readManifest(m.root, run);
      if (manifest) writeManifest(m.root, { ...manifest, repos: [...manifest.repos, ...m.add] }, { dir, projects });
    }
  }
  const brain = path.join(dir, 'ai_brain');
  return {
    file: mapFile(dir),
    dryRun,
    diff: cur.exists ? diff : { ...diff, created: true },
    map: next,
    notHere: merged.notHere.filter((l) => !behind(l)),
    notFollowed: merged.notHere.filter(behind),
    takenOut: merged.takenOut,
    left: kept.left,
    notes: scan.notes,
    tools: toolsOf(next),
    // Besides addresses: the projects folder, memory links, which entries are tools (shown as one line).
    otherChanges: cur.exists && diff.same && changed,
    manifests: scan.manifests.map((m) => ({ project: m.name, added: m.add.map((r) => r.dir) })),
    commit: commitCommand(brain),
  };
}

/**
 * After `project new|clone|add`: bring the map up to date when there is a brain (with dryRun: say whether it would
 * be). Only the map is written: a project's own project.json is that project's, so code repositories it does not list
 * yet are named (`workspace map` adds them). Never throws (says why instead).
 */
export async function refreshMapAfter(what, { dir = workspaceDir(), projects = projectsIn(), dryRun = false } = {}) {
  if (!isDir(path.join(dir, 'ai_brain'))) return null;
  try {
    const r = await updateMap({ dir, projects, dryRun, manifests: false });
    const unlisted = r.manifests.filter((m) => m.added.length).map((m) => `${m.project}/project.json does not list ${m.added.join(', ')}`);
    const also = unlisted.length ? ` (${unlisted.join('; ')}: hoprig workspace map adds them)` : '';
    if (r.diff.same && !r.otherChanges) return also ? `the workspace map is up to date${also}` : null;
    return dryRun ? `(dry run) the workspace map would be updated (${what})${also}` : `the workspace map was updated (${what}): commit it with  ${r.commit}${also}`;
  } catch (e) {
    return `the workspace map was not updated: ${e.message}`;
  }
}

/**
 * Take a project, a code repository of a project (<project>/<dir>, e.g. "shop/code/shop-web") or another repository
 * out of the map; it is never added back by `map`, nor cloned from a project.json by restore. No file is deleted.
 * A project outside the projects folder is <place>/<name>; a bare name that is in two places is refused with both
 * choices, so forgetting one never hides its namesake.
 */
export function forget(name, dir = workspaceDir()) {
  if (typeof name !== 'string' || !relOk(name)) throw Object.assign(new Error('name a project, a code repository (project/code/name) or a folder of the map'), { status: 400 });
  const cur = readMap(dir);
  if (cur.errors) throw Object.assign(new Error(cur.errors.join('; ')), { status: 409 });
  if (!cur.exists) throw Object.assign(new Error('there is no workspace map yet (hoprig workspace map)'), { status: 404 });
  const m = cur.map;
  // A project by the one rule (a bare name in two places is refused with both forms); else a code repository or a
  // folder as given.
  let one = null;
  try {
    one = findProject(m, name);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (one) name = refOf(one);
  const count = () => m.projects.length + m.others.length + m.projects.reduce((n, p) => n + p.repos.length, 0);
  const before = count();
  m.projects = m.projects.filter((p) => refOf(p) !== name);
  for (const p of m.projects) p.repos = p.repos.filter((r) => `${refOf(p)}/${r.dir}` !== name);
  m.others = m.others.filter((o) => o.dir !== name);
  const found = count() < before;
  m.skip = [...new Set([...(m.skip || []), name])].sort();
  writeMap(m, dir);
  return { forgotten: name, wasInMap: found, map: m };
}

/**
 * The map against this computer, one entry per repository:
 *   here      in the map and here
 *   notHere   a project or a code repository of one that is in the map, not on this computer: the normal state
 *             (a project lies on a computer only while its owner works on it there); `fix` is  hoprig get <project>
 *   missing   the brain, a group's own repository or another repository of the map that is not here (restore gets it)
 *   notFollowed  in the map and here, but behind a link that leads out (inside.mjs): never followed, `fix` names the
 *             link as the owner's own (hoprig workspace mylink add)
 *   different in the map, but the folder here is another repository or none
 *   unmapped  here, not in the map ("add it": workspace map)
 * → { exists, file, map, errors?, entries: [{ kind, label, url, path, state }], counts }
 */
export async function mapStatus({ dir = workspaceDir(), projects = projectsIn(), run = capture } = {}) {
  const cur = readMap(dir);
  const base = { exists: cur.exists, file: mapFile(dir), map: cur.map };
  if (cur.errors) return { ...base, errors: cur.errors, entries: [], counts: {} };
  const scanned = await scanWorkspace({ dir, projects, run, previous: cur.map });
  const disk = scanned.map;
  const entries = [];
  // Every folder from mapTargets (groups.mjs): the map's own entries carry `blocked` behind a link that is not followed.
  const curTargets = cur.exists ? await mapTargets(cur.map, { dir, projects }, run) : [];
  const paths = entryPaths([await mapTargets(disk, { dir, projects }, run), curTargets], { dir });
  const blockedAt = new Map(curTargets.filter((t) => t.blocked).map((t) => [`${t.kind}:${t.label}`, t.blocked]));
  const where = (kind, label) => paths.get(`${kind}:${label}`) || path.join(dir, label);
  const diskFlat = flat(disk);
  // Tools (sync false): the disk scan keeps what the map says, so both together cover entries missing here too.
  const tools = new Set([...toolsOf(disk), ...(cur.exists ? toolsOf(cur.map) : [])]);
  if (cur.exists) {
    for (const [k, url] of flat(cur.map)) {
      const [kind, label] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const p = where(kind, label);
      let state = 'missing';
      let fix = null;
      // A linked worktree in its folder is a second checkout of another repository, never this entry: not here. A
      // folder that leads out of where the map puts it (inside.mjs) is here but never followed: its own state, with
      // the command that names the link as the owner's own (restore would only say "not followed" again).
      if (kind !== 'brain' && isLinkedWorktree(p)) state = 'missing';
      else if (blockedAt.has(k)) {
        const b = blockedAt.get(k);
        state = 'notFollowed';
        fix = `${leavesWords(b)}: not followed; if it is yours:  ${myLinkCommand(b.path)}`;
      }
      else if (diskFlat.has(k)) state = !url || !diskFlat.get(k) || sameUrl(url, diskFlat.get(k)) ? 'here' : 'different';
      else if (fs.existsSync(p)) state = 'different';
      entries.push({ kind, label, url: url || null, path: p, state, ...(fix ? { fix } : {}), ...(tools.has(label) ? { tool: true } : {}) });
    }
  }
  for (const [k, url] of diskFlat) {
    if (cur.exists && flat(cur.map).has(k)) continue;
    if (k === 'brain:ai_brain' && !isGitRepo(path.join(dir, 'ai_brain'))) continue;
    const [kind, label] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    entries.push({ kind, label, url: url || null, path: where(kind, label), state: 'unmapped', ...(tools.has(label) ? { tool: true } : {}) });
  }
  // A project of the map that is here under another name (same address): the mv that gives it the map's name.
  for (const e of entries) {
    if (e.kind !== 'project' || e.state !== 'missing' || !e.url) continue;
    const twin = entries.find((x) => x.kind === 'project' && x.state === 'unmapped' && sameUrl(x.url, e.url));
    if (twin) e.fix = `it is here as ${twin.label}: ${showCommand(['mv', twin.path, e.path])}`;
  }
  // A project (or a code repository of one) that is only in the map is the normal state: a project lies on a computer
  // only while its owner works on it there. Its own state, with the one command that gets it; never a warning.
  const projectOf = new Map(cur.exists ? cur.map.projects.flatMap((p) => [[`project:${refOf(p)}`, refOf(p)], ...p.repos.map((r) => [`repo:${refOf(p)}/${r.dir}`, refOf(p)])]) : []);
  for (const e of entries) {
    const ref = projectOf.get(`${e.kind}:${e.label}`);
    if (e.state !== 'missing' || !ref || e.fix) continue;
    e.state = 'notHere';
    e.project = ref;
    e.fix = `hoprig get ${ref}`;
  }
  const counts = {};
  for (const e of entries) counts[e.state] = (counts[e.state] || 0) + 1;
  // The map on disk against the brain's last commit: "changed and not saved in the brain's history yet".
  // Links met in the groups and code/ folders: one that came with a repository is not followed, one made here is.
  // Links met on the way to the places, project folders and code/ folders, and to the map's own entries: each one that
  // leads out is named (inside.mjs), with the command that names it as the owner's own.
  const links = (await safeFolders(cur.exists && cur.map.version === 2 ? cur.map : null, { dir, projects }, run)).links;
  for (const t of curTargets.filter((x) => x.blocked && x.blocked.what === LEAVES)) {
    if (!links.some((l) => l.path === t.blocked.path)) links.push({ path: t.blocked.path, what: t.blocked.now ? `${LEAVES}: your own link, but it points to ${t.blocked.now} now` : LEAVES, fix: myLinkCommand(t.blocked.path) });
  }
  // The owner's own links: followed while they point where they did when he named them; one pointed elsewhere since
  // (a pull of a repository that tracks it) is named with the command that names it again.
  const mylinks = [];
  for (const e of myLinkEntries().filter((x) => fs.existsSync(x.path))) {
    const now = realOf(e.path);
    if (now === e.to) mylinks.push(e.path);
    else if (!links.some((l) => l.path === e.path)) links.push({ path: e.path, what: `${LEAVES}: your own link, but it points to ${now} now`, fix: myLinkCommand(e.path) });
  }
  // What would stop the map being written (the upkeep then skips with this reason), and one address in two places.
  const merged = cur.exists ? mergeMap(cur.map, scanned) : null;
  const kept = merged ? leaveOutNew(cur.map, merged.map) : { map: null, left: [] };
  const vw = merged ? validateMap(kept.map, { write: true, known: onePlace(cur.map) }) : { ok: true };
  let blocked = vw.ok ? null : vw.errors;
  if (cur.exists && !writable(path.dirname(mapFile(dir)))) (blocked || (blocked = [])).push('the brain\'s folder cannot be written on this computer');
  // The brain itself (or the map file's folder) behind a link that leads out: the map is never written there. Named
  // with the command, as every other link; and it is what stops the upkeep.
  const brainOut = leaves(path.join(dir, 'ai_brain'), path.dirname(mapFile(dir)), { dir, projects });
  if (brainOut) {
    if (!links.some((l) => l.path === brainOut.path)) links.push({ path: brainOut.path, what: brainOut.what, ...(brainOut.what === LEAVES ? { fix: myLinkCommand(brainOut.path) } : {}) });
    if (cur.exists) (blocked || (blocked = [])).push(`${leavesWords(brainOut)}: the map is not written through it`);
  }
  const duplicates = cur.exists ? onePlace(cur.map).map((d) => ({ entries: [d.a, d.b], fix: `hoprig workspace forget ${d.b}` })) : [];
  // A folder here left out of the map (leaveOutNew): named with what to do.
  const leftOut = kept.left.map((l) => ({ entry: l.ref, why: l.why, fix: 'rename or move one of the folders' }));
  return { ...base, entries, counts, links, mylinks, blocked, duplicates, ...(leftOut.length ? { leftOut } : {}), groups: cur.exists ? await groupChecks(cur.map, dir, run) : [], saved: await mapSaved({ dir, run }) };
}

const writable = (d) => {
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where each entry of the maps is on this computer (their mapTargets): Map("<kind>:<label>" → folder). */
function entryPaths(lists, ctx) {
  const out = new Map([['brain:ai_brain', path.join(ctx.dir, 'ai_brain')]]);
  for (const t of lists.flat()) out.set(`${t.kind}:${t.label}`, t.dir);
  return out;
}

/**
 * A group that is a repository and is on this computer: whether its ignore file keeps its members out of it.
 * → [{ dir, missingLines: [line], unignored: [member folder git would take] }] (only groups with something to say)
 */
async function groupChecks(map, dir, run) {
  const out = [];
  for (const g of map.groups || []) {
    const gdir = path.join(dir, ...g.dir.split('/'));
    if (!g.url || !isGitRepo(gdir)) continue;
    const unignored = await unignoredMembers(g, gdir, run, map.others.map((o) => o.dir));
    const missingLines = missingIgnoreLines(g, gdir);
    const f = ignoreFileOf(gdir);
    if (!f.ok) out.push({ dir: g.dir, missingLines, unignored, refused: f.why });
    else if (unignored.length || missingLines.length) out.push({ dir: g.dir, missingLines, unignored, fix: `hoprig workspace group ignore ${g.dir}` });
  }
  return out;
}

/** Whether workspace.json differs from the brain's last commit: { unsaved, command } (unsaved false when it does not). */
export async function mapSaved({ dir = workspaceDir(), run = capture } = {}) {
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) return { unsaved: false };
  const r = await gitRead(brain, ['status', '--porcelain', '--', MAP_FILE], { run, timeout: 10_000 });
  const unsaved = r.ok && r.stdout.trim() !== '';
  return { unsaved, ...(unsaved ? { command: commitCommand(brain) } : {}) };
}
