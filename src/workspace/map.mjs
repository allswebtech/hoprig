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
import { looksSecret } from '../assistant/secrets.mjs';
import { PRIVATE_DIRS, cleanRemote, parseRepo } from '../pcsetup/projects.mjs';
import { MANIFEST, NAME_RE, discoverChildren, readManifest, relOk, writeManifest } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { isDir, isGitRepo, isLinkedWorktree, listProjects, projectsIn, workspaceDir } from './layout.mjs';

export const MAP_FILE = 'workspace.json';
export const COMMIT_MESSAGE = 'Update the workspace map';
export const mapFile = (dir = workspaceDir()) => path.join(dir, 'ai_brain', MAP_FILE);
const NEVER = new Set([...PRIVATE_DIRS, 'credentials', 'node_modules']);
export const neverLook = (name) => name.startsWith('.') || NEVER.has(name);
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;

/**
 * An address as the map keeps it: user name and password taken out, then it must pass the project code's parser
 * and must not look like a secret. → the address, or null when there is none. Throws when it cannot be kept.
 */
export function mapUrl(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const url = cleanRemote(String(raw).trim());
  const ok = parseRepo(url);
  if (!ok) throw new Error(`"${url.slice(0, 80)}" is not a git address the map can keep (https or SSH, nothing secret in it)`);
  if (looksSecret(url)) throw new Error('an address with something secret in it is never written to the map');
  return ok.url;
}

/** Two addresses of the same repository? (".git", a trailing "/", the host's case and a user:password do not count) */
export function sameUrl(a, b) {
  const n = (u) => {
    const s = cleanRemote(String(u || '').trim()).replace(/\/+$/, '').replace(/\.git$/, '');
    return s.replace(/^([a-z+]+:\/\/)?([^/:]+)/i, (m) => m.toLowerCase());
  };
  return Boolean(a && b) && n(a) === n(b);
}

/** Strict check of a map read from a file (it comes from a repository: data, never trusted). → { ok, map } | { ok: false, errors } */
export function validateMap(m) {
  const errors = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(m)) return { ok: false, errors: ['the map is not an object'] };
  for (const k of Object.keys(m)) if (!['version', 'config', 'brain', 'projects', 'others', 'skip'].includes(k)) errors.push(`unknown key "${String(k).slice(0, 30)}"`);
  if (m.version !== 1) errors.push('"version" must be 1');
  const url = (v, what) => {
    try {
      return mapUrl(v);
    } catch (e) {
      errors.push(`${what}: ${e.message}`);
      return undefined;
    }
  };
  const branch = (v, what) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !BRANCH_RE.test(v)) errors.push(`${what}: bad branch`);
    return v;
  };
  // sync: false = a tool (an SDK checkout): restored on a fresh computer, never synced. Only a boolean is kept.
  const syncOf = (e, v, what) => {
    if (v === undefined) return e;
    if (typeof v !== 'boolean') errors.push(`${what}: "sync" is true or false`);
    else e.sync = v;
    return e;
  };
  const out = { version: 1, brain: { url: null }, projects: [], others: [] };
  if (m.config !== undefined) {
    // The workspace's own settings a fresh computer needs; never a machine path, a host or anything secret.
    if (!isObj(m.config) || Object.keys(m.config).some((k) => k !== 'projectsDir')) errors.push('"config" is { projectsDir? }');
    else if (m.config.projectsDir !== undefined) {
      const d = m.config.projectsDir;
      if (!relOk(d) || d.split('/').some(neverLook) || d.split('/')[0] === 'ai_brain') errors.push('"config.projectsDir" must be a folder inside the workspace');
      else out.config = { projectsDir: d };
    }
  }
  if (m.brain !== undefined) {
    if (!isObj(m.brain) || Object.keys(m.brain).some((k) => k !== 'url')) errors.push('"brain" is { url }');
    else out.brain.url = url(m.brain.url, 'brain') ?? null;
  }
  const names = new Set();
  for (const p of Array.isArray(m.projects) ? m.projects : m.projects === undefined ? [] : (errors.push('"projects" must be a list'), [])) {
    if (!isObj(p) || Object.keys(p).some((k) => !['name', 'url', 'repos', 'memories', 'sync'].includes(k))) {
      errors.push('each project is { name, url, repos, memories?, sync? }');
      continue;
    }
    if (typeof p.name !== 'string' || !NAME_RE.test(p.name) || neverLook(p.name) || names.has(p.name)) {
      errors.push(`"${String(p.name).slice(0, 40)}" is not a project name the map accepts`);
      continue;
    }
    names.add(p.name);
    const repos = [];
    for (const r of Array.isArray(p.repos) ? p.repos : []) {
      if (!isObj(r) || Object.keys(r).some((k) => !['dir', 'url', 'branch', 'sync'].includes(k)) || !relOk(r.dir) || r.dir.split('/').some(neverLook)) {
        errors.push(`${p.name}: each repository is { dir (a folder inside the project), url, branch?, sync? }`);
        continue;
      }
      const e = { dir: r.dir, url: url(r.url, `${p.name}/${r.dir}`) ?? null };
      const b = branch(r.branch, `${p.name}/${r.dir}`);
      if (b) e.branch = b;
      repos.push(syncOf(e, r.sync, `${p.name}/${r.dir}`));
    }
    const proj = { name: p.name, url: url(p.url, p.name) ?? null, repos };
    if (p.memories !== undefined) {
      // Which folder's Claude Code memory lives where in the project (as in its project.json): linked after restore.
      const ok = isObj(p.memories) && Object.entries(p.memories).every(([k, v]) => relOk(k, { dot: true }) && relOk(v) && ![...k.split('/'), ...v.split('/')].some((x) => x !== '.' && neverLook(x)));
      if (!ok) errors.push(`${p.name}: "memories" maps folders inside the project to memory folders inside it`);
      else if (Object.keys(p.memories).length) proj.memories = { ...p.memories };
    }
    out.projects.push(syncOf(proj, p.sync, p.name));
  }
  for (const o of Array.isArray(m.others) ? m.others : []) {
    if (!isObj(o) || Object.keys(o).some((k) => !['dir', 'url', 'branch', 'sync'].includes(k)) || !relOk(o.dir) || o.dir.split('/').some(neverLook) || ['ai_brain', 'projects'].includes(o.dir.split('/')[0])) {
      errors.push(`"${String(o && o.dir).slice(0, 60)}" is not a folder of the workspace the map accepts`);
      continue;
    }
    const e = { dir: o.dir, url: url(o.url, o.dir) ?? null };
    const b = branch(o.branch, o.dir);
    if (b) e.branch = b;
    out.others.push(syncOf(e, o.sync, o.dir));
  }
  if (m.skip !== undefined) {
    if (!Array.isArray(m.skip) || m.skip.some((s) => typeof s !== 'string' || !relOk(s))) errors.push('"skip" is a list of project names, code repositories (<project>/<dir>) and folders');
    else if (m.skip.length) out.skip = [...new Set(m.skip)].sort();
  }
  return errors.length ? { ok: false, errors } : { ok: true, map: out };
}

/** The map on this computer: { exists, map, errors? }. A missing file is an empty map. */
export function readMap(dir = workspaceDir()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(mapFile(dir), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, map: emptyMap() };
    return { exists: true, map: null, errors: [`${MAP_FILE} is not valid JSON: ${e.message}`] };
  }
  const v = validateMap(raw);
  return v.ok ? { exists: true, map: v.map } : { exists: true, map: null, errors: v.errors };
}

export const emptyMap = () => ({ version: 1, brain: { url: null }, projects: [], others: [] });

/** Write the map (sorted, so its git history shows real changes only). Every address is checked again. */
export function writeMap(map, dir = workspaceDir()) {
  const v = validateMap(map);
  if (!v.ok) throw new Error(`the map was not written: ${v.errors.join('; ')}`);
  const m = normalizeMap(v.map);
  const file = mapFile(dir);
  if (!isDir(path.dirname(file))) throw new Error('there is no AI brain to keep the map in (hoprig workspace setup, or restore)');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return m;
}

const originOf = async (dir, run) => {
  const r = await run(['git', '-C', dir, 'config', '--get', 'remote.origin.url'], { timeout: 10_000 });
  if (!r.ok) return { url: null, why: 'not on a git server yet (no remote)' };
  try {
    return { url: mapUrl(r.stdout.trim()) };
  } catch (e) {
    return { url: null, why: e.message };
  }
};

/** Git repositories in the workspace outside ai_brain/ and the projects folder, up to 3 folders deep. */
function otherRepos(dir, projects) {
  const found = [];
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
      if (path.resolve(abs) === path.resolve(projects)) continue;
      if (isGitRepo(abs)) {
        if (!isLinkedWorktree(abs)) found.push(r); // a linked worktree is another repository's second checkout
      } else if (depth < 3) walk(r, depth + 1);
    }
  };
  walk('', 1);
  return found.filter((r) => relOk(r)).sort();
}

/**
 * Look at the disk and build the map it describes. `previous` keeps the "skip" list and anything the disk cannot
 * say (the branch named in a project.json). → { map, notes: [what the person should know], manifests: [projects
 * whose project.json lacks a code repository found on disk] }
 */
export async function scanWorkspace({ dir = workspaceDir(), projects = projectsIn(), run = capture, previous = emptyMap() } = {}) {
  const skip = new Set(previous.skip || []);
  const notes = [];
  const manifests = [];
  const sources = {}; // project name → 'project.json' | 'found': whether its own project.json speaks for it
  const roots = {}; // project name → its folder here (mergeMap asks what is in a code repository's folder)
  // What a person set in the map stays: "sync" on an entry (a tool made syncable again, or the other way round).
  const kept = new Map();
  for (const p of previous.projects || []) {
    if (typeof p.sync === 'boolean') kept.set(`project:${p.name}`, p.sync);
    for (const r of p.repos || []) if (typeof r.sync === 'boolean') kept.set(`repo:${p.name}/${r.dir}`, r.sync);
  }
  for (const o of previous.others || []) if (typeof o.sync === 'boolean') kept.set(`other:${o.dir}`, o.sync);
  const withSync = (e, k, dflt) => {
    const v = kept.has(k) ? kept.get(k) : dflt;
    return typeof v === 'boolean' ? { ...e, sync: v } : e;
  };
  const map = { version: 1, brain: { url: null }, projects: [], others: [], ...(skip.size ? { skip: [...skip] } : {}) };
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
  // A folder here that is a linked worktree (a second checkout of another repository, often a session's temporary
  // one) is never added: not as a project, a code repository or another repository.
  for (const p of listProjects(projects)) {
    if (!p.git || isLinkedWorktree(p.dir) || skip.has(p.name) || neverLook(p.name) || !NAME_RE.test(p.name)) continue;
    const o = await originOf(p.dir, run);
    if (!o.url) notes.push(`${p.name}: ${o.why}`);
    const { manifest, source } = await readManifest(p.dir, run);
    sources[p.name] = source;
    roots[p.name] = p.dir;
    const forgotten = (d) => skip.has(`${p.name}/${d}`); // a code repository taken out with `workspace forget`
    const byDir = new Map();
    // What project.json names stays, whatever its folder here is: a linked worktree here may be a full clone with
    // its own branch on another computer, so this disk cannot tell a leftover (`workspace forget` takes one out).
    for (const r of (manifest && manifest.repos) || []) if (!forgotten(r.dir)) byDir.set(r.dir, { dir: r.dir, url: r.url, ...(r.branch ? { branch: r.branch } : {}) });
    const missingFromManifest = [];
    for (const c of await discoverChildren(p.dir, run)) {
      if (c.dir.split('/').some(neverLook) || forgotten(c.dir)) continue;
      if (!byDir.has(c.dir)) {
        byDir.set(c.dir, { dir: c.dir, url: c.url });
        if (c.url && source === MANIFEST) missingFromManifest.push({ dir: c.dir, url: c.url });
      }
      if (!c.url) notes.push(`${p.name}/${c.dir}: not on a git server yet (no remote)`);
    }
    if (missingFromManifest.length) manifests.push({ name: p.name, root: p.dir, add: missingFromManifest });
    const entry = { name: p.name, url: o.url, repos: [...byDir.values()].map((r) => withSync(r, `repo:${p.name}/${r.dir}`)) };
    if (manifest && Object.keys(manifest.memories || {}).length) entry.memories = { ...manifest.memories };
    map.projects.push(withSync(entry, `project:${p.name}`));
  }
  for (const r of otherRepos(dir, projects)) {
    if (skip.has(r)) continue;
    const o = await originOf(path.join(dir, r), run);
    if (!o.url) notes.push(`${r}: ${o.why}`);
    // The branch it is on (a toolchain is restored on its channel, e.g. "stable"), and tools are never synced.
    const b = await run(['git', '-C', path.join(dir, r), 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: 10_000 });
    const branch = b.ok && BRANCH_RE.test(b.stdout.trim()) ? b.stdout.trim() : null;
    map.others.push(withSync({ dir: r, url: o.url, ...(branch ? { branch } : {}) }, `other:${r}`, r.split('/')[0] === 'development' ? false : undefined));
  }
  const v = validateMap(map);
  return { map: v.ok ? v.map : map, notes, manifests, sources, roots };
}

/** Entries that are tools (sync false): labels, as `status` and `sync` show them. */
export function toolsOf(map) {
  const out = [];
  for (const p of map.projects || []) {
    if (p.sync === false) out.push(p.name);
    for (const r of p.repos || []) if (r.sync === false) out.push(`${p.name}/${r.dir}`);
  }
  for (const o of map.others || []) if (o.sync === false) out.push(o.dir);
  return out;
}

/** The map in its written order (sorted), for writing and for "did anything change?". */
export function normalizeMap(m) {
  const n = JSON.parse(JSON.stringify(m));
  n.projects.sort((a, b) => a.name.localeCompare(b.name));
  for (const p of n.projects) p.repos.sort((a, b) => a.dir.localeCompare(b.dir));
  n.others.sort((a, b) => a.dir.localeCompare(b.dir));
  return n;
}

const key = (kind, id) => `${kind}:${id}`;
const flat = (m) => {
  const out = new Map();
  if (!m) return out;
  out.set(key('brain', 'ai_brain'), m.brain.url);
  for (const p of m.projects) {
    out.set(key('project', p.name), p.url);
    for (const r of p.repos) out.set(key('repo', `${p.name}/${r.dir}`), r.url);
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
 * `workspace map`: build the map from the disk, show the difference, write it (unless dryRun), and add code
 * repositories found on disk to a project.json that lacks them (that file stays the truth for its project).
 * Never commits. → { file, dryRun, diff, map, notes, manifests, commit }
 */
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
 * clone on another computer). Such an entry is "in the map, not on this computer" like any other.
 * → { map, notHere: [label], takenOut: [{ project, dir }] }
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
  for (const old of cur.projects) {
    if (skip.has(old.name)) continue;
    const here = out.projects.find((p) => p.name === old.name);
    if (!here) {
      out.projects.push(JSON.parse(JSON.stringify(old)));
      notHere.push(old.name, ...old.repos.map((r) => `${old.name}/${r.dir}`));
      continue;
    }
    if (!here.url && old.url) here.url = old.url;
    if (!here.memories && old.memories) here.memories = { ...old.memories };
    for (const r of old.repos) {
      if (here.repos.some((x) => x.dir === r.dir) || skip.has(`${old.name}/${r.dir}`)) continue;
      const root = scan.roots && scan.roots[old.name];
      const worktreeHere = root && isLinkedWorktree(path.join(root, r.dir));
      if (scan.sources && scan.sources[old.name] === MANIFEST && !worktreeHere) takenOut.push({ project: old.name, dir: r.dir });
      else {
        here.repos.push(JSON.parse(JSON.stringify(r)));
        notHere.push(`${old.name}/${r.dir}`);
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
 * `workspace map`: add or update what is on this computer, keep everything else (mergeMap), show the difference,
 * write it (unless dryRun), and add code repositories found on disk to a project.json that lacks them (that file
 * stays the truth for its project). Never commits.
 * → { file, dryRun, diff, map, notHere, takenOut, notes, tools, otherChanges, manifests, commit }
 */
export async function updateMap({ dir = workspaceDir(), projects = projectsIn(), dryRun = false, run = capture, manifests: touchManifests = true } = {}) {
  const cur = readMap(dir);
  if (cur.errors) throw Object.assign(new Error(`${MAP_FILE} was not changed: ${cur.errors.join('; ')}`), { status: 409 });
  const scan = await scanWorkspace({ dir, projects, run, previous: cur.map });
  const merged = mergeMap(cur.exists ? cur.map : null, scan);
  const next = validateMap(merged.map).ok ? validateMap(merged.map).map : merged.map;
  const diff = diffMap(cur.exists ? cur.map : null, next);
  const changed = !cur.exists || JSON.stringify(normalizeMap(cur.map)) !== JSON.stringify(normalizeMap(next));
  if (!dryRun) {
    if (changed) writeMap(next, dir);
    // (The automatic upkeep leaves project.json files alone: they belong to their projects' own repositories.)
    for (const m of touchManifests ? scan.manifests : []) {
      const { manifest } = await readManifest(m.root, run);
      if (manifest) writeManifest(m.root, { ...manifest, repos: [...manifest.repos, ...m.add] });
    }
  }
  const brain = path.join(dir, 'ai_brain');
  return {
    file: mapFile(dir),
    dryRun,
    diff: cur.exists ? diff : { ...diff, created: true },
    map: next,
    notHere: merged.notHere,
    takenOut: merged.takenOut,
    notes: scan.notes,
    tools: toolsOf(next),
    // Besides addresses: the projects folder, memory links, which entries are tools (shown as one line).
    otherChanges: cur.exists && diff.same && changed,
    manifests: scan.manifests.map((m) => ({ project: m.name, added: m.add.map((r) => r.dir) })),
    commit: `git -C "${brain}" add ${MAP_FILE} && git -C "${brain}" commit -m "${COMMIT_MESSAGE}"`,
  };
}

/** After `project new|clone|add`: bring the map up to date when there is a brain. Never throws (says why instead). */
export async function refreshMapAfter(what, { dir = workspaceDir(), projects = projectsIn() } = {}) {
  if (!isDir(path.join(dir, 'ai_brain'))) return null;
  try {
    const r = await updateMap({ dir, projects });
    return r.diff.same && !r.otherChanges ? null : `the workspace map was updated (${what}): commit it with  ${r.commit}`;
  } catch (e) {
    return `the workspace map was not updated: ${e.message}`;
  }
}

/**
 * Take a project, a code repository of a project (<project>/<dir>, e.g. "shop/code/shop-web") or another repository
 * out of the map; it is never added back by `map`, nor cloned from a project.json by restore. No file is deleted.
 */
export function forget(name, dir = workspaceDir()) {
  if (typeof name !== 'string' || !relOk(name)) throw Object.assign(new Error('name a project, a code repository (project/code/name) or a folder of the map'), { status: 400 });
  const cur = readMap(dir);
  if (cur.errors) throw Object.assign(new Error(cur.errors.join('; ')), { status: 409 });
  if (!cur.exists) throw Object.assign(new Error('there is no workspace map yet (hoprig workspace map)'), { status: 404 });
  const m = cur.map;
  const count = () => m.projects.length + m.others.length + m.projects.reduce((n, p) => n + p.repos.length, 0);
  const before = count();
  m.projects = m.projects.filter((p) => p.name !== name);
  for (const p of m.projects) p.repos = p.repos.filter((r) => `${p.name}/${r.dir}` !== name);
  m.others = m.others.filter((o) => o.dir !== name);
  const found = count() < before;
  m.skip = [...new Set([...(m.skip || []), name])].sort();
  writeMap(m, dir);
  return { forgotten: name, wasInMap: found, map: m };
}

/**
 * The map against this computer, one entry per repository:
 *   here      in the map and here
 *   missing   in the map, not on this computer ("get it": workspace restore)
 *   different in the map, but the folder here is another repository or none
 *   unmapped  here, not in the map ("add it": workspace map)
 * → { exists, file, map, errors?, entries: [{ kind, label, url, path, state }], counts }
 */
export async function mapStatus({ dir = workspaceDir(), projects = projectsIn(), run = capture } = {}) {
  const cur = readMap(dir);
  const base = { exists: cur.exists, file: mapFile(dir), map: cur.map };
  if (cur.errors) return { ...base, errors: cur.errors, entries: [], counts: {} };
  const disk = (await scanWorkspace({ dir, projects, run, previous: cur.map })).map;
  const entries = [];
  const where = (kind, label) => (kind === 'brain' ? path.join(dir, 'ai_brain') : kind === 'other' ? path.join(dir, label) : path.join(projects, label));
  const diskFlat = flat(disk);
  // Tools (sync false): the disk scan keeps what the map says, so both together cover entries missing here too.
  const tools = new Set([...toolsOf(disk), ...(cur.exists ? toolsOf(cur.map) : [])]);
  if (cur.exists) {
    for (const [k, url] of flat(cur.map)) {
      const [kind, label] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const p = where(kind, label);
      let state = 'missing';
      // A linked worktree in its folder is a second checkout of another repository, never this entry: not here.
      if (kind !== 'brain' && isLinkedWorktree(p)) state = 'missing';
      else if (diskFlat.has(k)) state = !url || !diskFlat.get(k) || sameUrl(url, diskFlat.get(k)) ? 'here' : 'different';
      else if (fs.existsSync(p)) state = 'different';
      entries.push({ kind, label, url: url || null, path: p, state, ...(tools.has(label) ? { tool: true } : {}) });
    }
  }
  for (const [k, url] of diskFlat) {
    if (cur.exists && flat(cur.map).has(k)) continue;
    if (k === 'brain:ai_brain' && !isGitRepo(path.join(dir, 'ai_brain'))) continue;
    const [kind, label] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    entries.push({ kind, label, url: url || null, path: where(kind, label), state: 'unmapped', ...(tools.has(label) ? { tool: true } : {}) });
  }
  const counts = {};
  for (const e of entries) counts[e.state] = (counts[e.state] || 0) + 1;
  // The map on disk against the brain's last commit: "changed and not saved in the brain's history yet".
  return { ...base, entries, counts, saved: await mapSaved({ dir, run }) };
}

/** Whether workspace.json differs from the brain's last commit: { unsaved, command } (unsaved false when it does not). */
export async function mapSaved({ dir = workspaceDir(), run = capture } = {}) {
  const brain = path.join(dir, 'ai_brain');
  if (!isGitRepo(brain)) return { unsaved: false };
  const r = await run(['git', '-C', brain, 'status', '--porcelain', '--', MAP_FILE], { timeout: 10_000 });
  const unsaved = r.ok && r.stdout.trim() !== '';
  return { unsaved, ...(unsaved ? { command: `git -C "${brain}" add ${MAP_FILE} && git -C "${brain}" commit -m "${COMMIT_MESSAGE}"` } : {}) };
}
