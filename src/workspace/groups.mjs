// Groups: an owner's own folders of projects beside the projects folder (docs/WORKSPACE.md). The map (version 2)
// names them; this module turns that into "the places a project can be" for everything that used to take one
// projects folder: the scan, status, sync, restore, the lists on the dashboard, the memory links.
//
//   a plain group                 <workspace>/client-work/<project>        each project a repository of its own
//   a group that is a repository  <workspace>/kits/                        its own files, memory and tools, and
//     a held folder                 kits/builds/<project>                  each member a repository of its own, or
//     a held folder, parent group   kits/packs/<project>                   members tracked by the group's repository,
//                                                                          only their code/<repo> are repositories
//
// A project is named <name> in the projects folder and <place>/<name> anywhere else (mapcheck.mjs refOf).
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { linkMemory, planMemoryPairs, readManifest } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { isDir, isGitRepo, listProjects } from './layout.mjs';
import { LEAVES, leaves, myLinkCommand, writeIn } from './inside.mjs';
import { neverLook, pickProject, placeOf, refOf } from './mapcheck.mjs';

export { placeOf, refOf };

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const folderOf = (dir, rel) => path.join(dir, ...rel.split('/'));

/**
 * Every place a project can be, the projects folder first: [{ id ('' for the projects folder), dir, members: 'own' |
 * 'group', group? (the group's folder) }]. A group that is a repository is not a place itself: its held folders are.
 */
export function placesOf(map, { dir, projects }) {
  const out = [{ id: '', dir: projects, members: 'own' }];
  for (const g of (map && map.groups) || []) {
    if (g.holds) for (const h of g.holds) out.push({ id: `${g.dir}/${h.dir}`, dir: folderOf(dir, `${g.dir}/${h.dir}`), members: h.parent === 'group' ? 'group' : 'own', group: g.dir });
    else if (!g.url) out.push({ id: g.dir, dir: folderOf(dir, g.dir), members: 'own', group: g.dir });
  }
  return out;
}

/** The folder of a place on this computer ('' = the projects folder). */
export const placeDir = (id, { dir, projects }) => (id ? folderOf(dir, id) : projects);
/** A project's folder on this computer. */
export const projectRoot = (p, ctx) => path.join(placeDir(placeOf(p), ctx), p.name);
/** The group a place belongs to (null for the projects folder). */
export const groupOf = (map, id) => (id ? ((map && map.groups) || []).find((g) => id === g.dir || id.startsWith(`${g.dir}/`)) || null : null);

/**
 * The project a command names: <name>, or <place>/<name>. A bare name that is in two places is refused with both
 * choices, so one command never acts on its namesake. → the map's entry. Throws { status, choices? }.
 */
export function findProject(map, ref) {
  const list = (map && map.projects) || [];
  return pickProject(list.map((p) => ({ name: p.name, place: placeOf(p), p })), ref).p;
}

/**
 * The project folders on this computer in every place: [{ name, ref, place, dir, git, parent, members, group? }], as
 * listProjects gives them for one folder (the caller decides whether a folder that is not a repository counts; in a
 * held folder whose members come with the group none is). Private and hidden folders never count.
 */
export function projectFolders(map, ctx) {
  const out = [];
  for (const pl of placesOf(map, ctx)) {
    for (const p of listProjects(pl.dir)) {
      if (neverLook(p.name)) continue;
      out.push({ ...p, ref: pl.id ? `${pl.id}/${p.name}` : p.name, place: pl.id, members: pl.members, ...(pl.group ? { group: pl.group } : {}) });
    }
  }
  return out;
}

/** A link met that leads out: { path, what, fix } (fix: the command that names it as the owner's own). */
const met = (b) => ({ path: b.path, what: b.now ? `${b.what}: your own link, but it points to ${b.now} now` : b.what, ...(b.what === LEAVES ? { fix: myLinkCommand(b.path) } : {}) });

/**
 * The places and project folders here that may be followed, with the links met on the way (inside.mjs): a place, a
 * project folder or a code/ folder that leads out of where the map puts it is left out, unless the owner named the
 * link as his own on this computer. → { places: [place + blocked?], folders: [as projectFolders + codeBlocked?],
 * links: [{ path, what, fix? }] }
 */
export async function safeFolders(map, ctx, run = capture) {
  const links = [];
  const seen = new Set();
  const note = (b) => {
    if (b && !seen.has(b.path)) {
      seen.add(b.path);
      links.push(met(b));
    }
    return b;
  };
  const places = [];
  for (const pl of placesOf(map, ctx)) {
    const b = pl.id ? note(leaves(pl.dir, pl.dir, ctx)) : null;
    places.push(b ? { ...pl, blocked: b } : pl);
  }
  const folders = [];
  for (const f of projectFolders(map, ctx)) {
    const pl = places.find((x) => x.id === f.place);
    if (pl && pl.blocked) continue;
    if (note(leaves(f.dir, f.dir, ctx))) continue;
    const code = note(leaves(f.dir, path.join(f.dir, 'code'), ctx));
    folders.push(code ? { ...f, codeBlocked: code } : f);
  }
  return { places, folders, links };
}

/**
 * THE folders of the map that may be acted on: every entry of the map with its folder on this computer, its `root`
 * (the entry's own folder: the group's, the project's, the other repository's; a code repository's is its project's)
 * and `blocked` where it leads out (inside.mjs). Every caller that acts on the map's entries (sync, sync with another
 * computer, restore, status, the upkeep) takes its folders from here and never joins a path from a map entry by
 * itself; the act itself (inside.mjs gitIn, cloneInto) checks once more at the moment it runs.
 * → [{ kind: 'group' | 'project' | 'repo' | 'other', label, dir, root, entry, project?, place?, blocked? }]
 */
export async function mapTargets(map, ctx, run = capture) {
  const out = [];
  const add = (e) => {
    const b = leaves(e.root, e.dir, ctx);
    out.push(b ? { ...e, blocked: b } : e);
  };
  for (const g of (map && map.groups) || []) {
    const dir = folderOf(ctx.dir, g.dir);
    add({ kind: 'group', label: g.dir, dir, root: dir, entry: g });
  }
  for (const p of (map && map.projects) || []) {
    const place = placeOf(p);
    const root = projectRoot(p, ctx);
    const ref = refOf(p);
    add({ kind: 'project', label: ref, dir: root, root, entry: p, project: ref, place });
    for (const r of p.repos) add({ kind: 'repo', label: `${ref}/${r.dir}`, dir: path.join(root, ...r.dir.split('/')), root, entry: r, project: ref, place });
  }
  for (const o of (map && map.others) || []) {
    const dir = folderOf(ctx.dir, o.dir);
    add({ kind: 'other', label: o.dir, dir, root: dir, entry: o });
  }
  return out;
}

/** Folders the walk for "other" repositories never enters: every group's folder (its repository and members are entries of their own). */
export const groupFolders = (map) => ((map && map.groups) || []).map((g) => g.dir);

// ---- a group that is a repository ignores what it holds ----

/**
 * The lines a group's own ignore file needs so that one `git add` in it never takes a member: each held folder's
 * members (each a repository of its own), or their code/ folders (members that come with the group).
 */
export const ignoreLinesFor = (g) => (g.holds || []).map((h) => (h.parent === 'group' ? `/${h.dir}/*/code/` : `/${h.dir}/*/`));

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

/**
 * The group's ignore file: { file, ok, exists }, or ok false with why when something other than a regular file is
 * there. A link (one the group's repository tracks may point anywhere) is never read or written through.
 */
export function ignoreFileOf(groupDir) {
  const file = path.join(groupDir, '.gitignore');
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { file, ok: true, exists: false };
  }
  if (st.isFile()) return { file, ok: true, exists: true };
  return { file, ok: false, exists: true, why: `${file} is ${st.isSymbolicLink() ? 'a link' : 'not a regular file'}: Hoprig never reads or writes an ignore file through one (make it a regular file in the group's repository)` };
}

/** The ignore file's text, never through a link (O_NOFOLLOW where the system has it). */
const readIgnore = (file) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Add lines to the group's ignore file, a regular file or a new one, never through a link, and only in a group's
 * folder that is really where the map puts it (inside.mjs writeIn). Throws with why.
 */
export function appendIgnore(groupDir, lines, at = {}) {
  const f = ignoreFileOf(groupDir);
  if (!f.ok) throw Object.assign(new Error(f.why), { status: 409 });
  const cur = f.exists ? readIgnore(f.file) : '';
  writeIn({ ...at, root: groupDir }, f.file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
  return f.file;
}

/**
 * The lines of ignoreLinesFor missing from the group's .gitignore (a line is matched as written, spaces trimmed). An
 * ignore file that is no regular file is not read: every line counts as missing (status says why with ignoreFileOf).
 */
export function missingIgnoreLines(g, groupDir) {
  const f = ignoreFileOf(groupDir);
  if (!f.ok) return ignoreLinesFor(g);
  let have = [];
  try {
    have = readIgnore(f.file).split(/\r?\n/).map((l) => l.trim());
  } catch {
    /* no ignore file yet */
  }
  return ignoreLinesFor(g).filter((l) => !have.includes(l));
}

/**
 * Members of a group repository that git would take into it: the folders (or code/ folders) on this computer that are
 * not ignored. Asked of git itself (the untracked files it would add, ignored ones left out), so an ignore line
 * written another way counts too. → [rel to the group]
 */
export async function unignoredMembers(g, groupDir, run = capture, others = []) {
  if (!isGitRepo(groupDir)) return [];
  // Besides the members: the "other" repositories of the map inside the group's repository (a tool folder of it).
  const paths = others.filter((o) => o.startsWith(`${g.dir}/`)).map((o) => o.slice(g.dir.length + 1)).filter((rel) => fs.existsSync(path.join(groupDir, rel)));
  for (const h of g.holds || []) {
    for (const m of listProjects(path.join(groupDir, h.dir))) {
      if (neverLook(m.name)) continue;
      const rel = h.parent === 'group' ? `${h.dir}/${m.name}/code` : `${h.dir}/${m.name}`;
      if (fs.existsSync(path.join(groupDir, rel))) paths.push(rel);
    }
  }
  if (!paths.length) return [];
  const r = await gitRead(groupDir, ['ls-files', '--others', '--directory', '--exclude-standard', '--', ...paths.map((p) => `${p}/`)], { run, timeout: 30_000 });
  if (!r.ok) return [];
  const listed = r.stdout.split('\n').filter(Boolean);
  return paths.filter((p) => listed.some((l) => l === `${p}/` || l.startsWith(`${p}/`)));
}

// ---- memory inside a group ----

/**
 * Which memory a session started in each folder of a group uses: [{ launch, memory }] (absolute paths).
 *   the group's own folder                → the group's memory ("memories" of the group)
 *   a member with memory of its own       → its own (its project.json, else what the map says)
 *   a member without                      → the group's, for the member's folder and each of its code folders
 * Only folders that are on this computer are listed.
 */
export async function groupMemoryPairs(map, ctx, run = capture) {
  const pairs = [];
  for (const g of (map && map.groups) || []) {
    const gdir = folderOf(ctx.dir, g.dir);
    if (!isDir(gdir)) continue;
    if (leaves(gdir, gdir, ctx)) continue; // a group's folder that leads out: nothing of it is linked
    const own = g.memories || {};
    // `root`: the folder each memory must stay inside (inside.mjs; checked when planned and when made).
    for (const [launch, mem] of Object.entries(own)) pairs.push({ launch: launch === '.' ? gdir : path.join(gdir, launch), memory: path.join(gdir, mem), group: g.dir, root: gdir });
    const groupMem = own['.'] ? path.join(gdir, own['.']) : null;
    for (const m of (await safeFolders(map, ctx, run)).folders.filter((x) => x.group === g.dir)) pairs.push(...(await memberPairs(map, m, groupMem, gdir, run)));
  }
  return pairs;
}

// A member's pairs: its own memory stays inside the member (root), the group's inside the group. A launch folder
// (a code repository) that leads out of the member is left out: no session's memory is linked for a folder elsewhere.
async function memberPairs(map, m, groupMem, gdir, run) {
  const { manifest } = await readManifest(m.dir, run);
  const entry = ((map && map.projects) || []).find((p) => refOf(p) === m.ref);
  const mem = manifest && Object.keys(manifest.memories || {}).length ? manifest.memories : (entry && entry.memories) || {};
  if (Object.keys(mem).length) {
    return Object.entries(mem).map(([launch, d]) => ({ launch: launch === '.' ? m.dir : path.join(m.dir, launch), memory: path.join(m.dir, d), project: m.ref, root: m.dir }));
  }
  if (!groupMem) return [];
  const repos = new Set([...((manifest && manifest.repos) || []).map((r) => r.dir), ...((entry && entry.repos) || []).map((r) => r.dir)]);
  const launches = [m.dir];
  for (const d of repos) {
    const p = path.join(m.dir, d);
    if (isDir(p) && !leaves(m.dir, p)) launches.push(p);
  }
  return launches.map((launch) => ({ launch, memory: groupMem, project: m.ref, root: gdir }));
}

/**
 * What linkGroupMemories would do, read only (pcsetup/workspace.mjs planMemoryPairs): each entry also says the group
 * or the project (<place>/<name>) it is for. `only`: a group, a place or one project.
 */
export async function planGroupMemories(map, ctx, opts = {}) {
  const pairs = await groupMemoryPairs(map, ctx, opts.run);
  const only = opts.only ? pairs.filter((p) => p.group === opts.only || p.project === opts.only || (p.project || '').startsWith(`${opts.only}/`)) : pairs;
  return only.map((p) => ({ ...planMemoryPairs([p], { ...opts, at: ctx, fix: `hoprig project link ${p.project || p.group}` })[0], ...(p.group ? { group: p.group } : {}), ...(p.project ? { project: p.project } : {}) }));
}

/**
 * Make those links (a real folder is merged in, a link elsewhere left alone). linkMemory checks each again right
 * before it is made (inside.mjs): the plan may be a moment old.
 */
export async function linkGroupMemories(map, ctx, opts = {}) {
  return (await planGroupMemories(map, ctx, opts)).map((p) => linkMemory(p, { ...opts, at: ctx }));
}
