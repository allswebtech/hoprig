// The workspace map: <workspace>/ai_brain/workspace.json, one file that says which git repositories make up the
// workspace and where each one goes, so a fresh computer can get all of it (restore.mjs). It lives in the AI brain
// because the brain is the one repository every computer has. It holds addresses, never content:
//
//   { "version": 1,
//     "brain":    { "url": "<address of the brain>" | null },
//     "projects": [ { "name": "<project>", "url": "<its parent repository>" | null,
//                     "repos": [ { "dir": "code/<repo>", "url": "<address>" | null, "branch"?: "<branch>" } ] } ],
//     "others":   [ { "dir": "<folder in the workspace, e.g. git/<name>>", "url": "<address>" | null, "branch"? } ],
//     "skip"?:    [ "<project name>" | "<others dir>" ] }      taken out with `workspace forget`: never added again
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
import { isDir, isGitRepo, listProjects, projectsIn, workspaceDir } from './layout.mjs';

export const MAP_FILE = 'workspace.json';
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
  for (const k of Object.keys(m)) if (!['version', 'brain', 'projects', 'others', 'skip'].includes(k)) errors.push(`unknown key "${String(k).slice(0, 30)}"`);
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
  const out = { version: 1, brain: { url: null }, projects: [], others: [] };
  if (m.brain !== undefined) {
    if (!isObj(m.brain) || Object.keys(m.brain).some((k) => k !== 'url')) errors.push('"brain" is { url }');
    else out.brain.url = url(m.brain.url, 'brain') ?? null;
  }
  const names = new Set();
  for (const p of Array.isArray(m.projects) ? m.projects : m.projects === undefined ? [] : (errors.push('"projects" must be a list'), [])) {
    if (!isObj(p) || Object.keys(p).some((k) => !['name', 'url', 'repos'].includes(k))) {
      errors.push('each project is { name, url, repos }');
      continue;
    }
    if (typeof p.name !== 'string' || !NAME_RE.test(p.name) || neverLook(p.name) || names.has(p.name)) {
      errors.push(`"${String(p.name).slice(0, 40)}" is not a project name the map accepts`);
      continue;
    }
    names.add(p.name);
    const repos = [];
    for (const r of Array.isArray(p.repos) ? p.repos : []) {
      if (!isObj(r) || Object.keys(r).some((k) => !['dir', 'url', 'branch'].includes(k)) || !relOk(r.dir) || r.dir.split('/').some(neverLook)) {
        errors.push(`${p.name}: each repository is { dir (a folder inside the project), url, branch? }`);
        continue;
      }
      const e = { dir: r.dir, url: url(r.url, `${p.name}/${r.dir}`) ?? null };
      const b = branch(r.branch, `${p.name}/${r.dir}`);
      if (b) e.branch = b;
      repos.push(e);
    }
    out.projects.push({ name: p.name, url: url(p.url, p.name) ?? null, repos });
  }
  for (const o of Array.isArray(m.others) ? m.others : []) {
    if (!isObj(o) || Object.keys(o).some((k) => !['dir', 'url', 'branch'].includes(k)) || !relOk(o.dir) || o.dir.split('/').some(neverLook) || ['ai_brain', 'projects'].includes(o.dir.split('/')[0])) {
      errors.push(`"${String(o && o.dir).slice(0, 60)}" is not a folder of the workspace the map accepts`);
      continue;
    }
    const e = { dir: o.dir, url: url(o.url, o.dir) ?? null };
    const b = branch(o.branch, o.dir);
    if (b) e.branch = b;
    out.others.push(e);
  }
  if (m.skip !== undefined) {
    if (!Array.isArray(m.skip) || m.skip.some((s) => typeof s !== 'string' || !relOk(s))) errors.push('"skip" is a list of project names and folders');
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
  const m = v.map;
  m.projects.sort((a, b) => a.name.localeCompare(b.name));
  for (const p of m.projects) p.repos.sort((a, b) => a.dir.localeCompare(b.dir));
  m.others.sort((a, b) => a.dir.localeCompare(b.dir));
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
      if (isGitRepo(abs)) found.push(r);
      else if (depth < 3) walk(r, depth + 1);
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
  const map = { version: 1, brain: { url: null }, projects: [], others: [], ...(skip.size ? { skip: [...skip] } : {}) };
  const brain = path.join(dir, 'ai_brain');
  if (isGitRepo(brain)) {
    const o = await originOf(brain, run);
    map.brain.url = o.url;
    if (!o.url) notes.push(`the AI brain: ${o.why}`);
  } else if (isDir(brain)) notes.push('the AI brain is not a git repository yet');
  for (const p of listProjects(projects)) {
    if (!p.git || skip.has(p.name) || neverLook(p.name) || !NAME_RE.test(p.name)) continue;
    const o = await originOf(p.dir, run);
    if (!o.url) notes.push(`${p.name}: ${o.why}`);
    const { manifest, source } = await readManifest(p.dir, run);
    const byDir = new Map();
    for (const r of (manifest && manifest.repos) || []) byDir.set(r.dir, { dir: r.dir, url: r.url, ...(r.branch ? { branch: r.branch } : {}) });
    const missingFromManifest = [];
    for (const c of await discoverChildren(p.dir, run)) {
      if (c.dir.split('/').some(neverLook)) continue;
      if (!byDir.has(c.dir)) {
        byDir.set(c.dir, { dir: c.dir, url: c.url });
        if (c.url && source === MANIFEST) missingFromManifest.push({ dir: c.dir, url: c.url });
      }
      if (!c.url) notes.push(`${p.name}/${c.dir}: not on a git server yet (no remote)`);
    }
    if (missingFromManifest.length) manifests.push({ name: p.name, root: p.dir, add: missingFromManifest });
    map.projects.push({ name: p.name, url: o.url, repos: [...byDir.values()] });
  }
  for (const rel of otherRepos(dir, projects)) {
    if (skip.has(rel)) continue;
    const o = await originOf(path.join(dir, rel), run);
    if (!o.url) notes.push(`${rel}: ${o.why}`);
    map.others.push({ dir: rel, url: o.url });
  }
  return { map: validateMap(map).ok ? validateMap(map).map : map, notes, manifests };
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
export async function updateMap({ dir = workspaceDir(), projects = projectsIn(), dryRun = false, run = capture } = {}) {
  const cur = readMap(dir);
  if (cur.errors) throw Object.assign(new Error(`${MAP_FILE} was not changed: ${cur.errors.join('; ')}`), { status: 409 });
  const scan = await scanWorkspace({ dir, projects, run, previous: cur.map });
  const diff = diffMap(cur.exists ? cur.map : null, scan.map);
  if (!dryRun) {
    if (!cur.exists || !diff.same || JSON.stringify(cur.map.skip || []) !== JSON.stringify(scan.map.skip || [])) writeMap(scan.map, dir);
    for (const m of scan.manifests) {
      const { manifest } = await readManifest(m.root, run);
      if (manifest) writeManifest(m.root, { ...manifest, repos: [...manifest.repos, ...m.add] });
    }
  }
  const brain = path.join(dir, 'ai_brain');
  return {
    file: mapFile(dir),
    dryRun,
    diff: cur.exists ? diff : { ...diff, created: true },
    map: scan.map,
    notes: scan.notes,
    manifests: scan.manifests.map((m) => ({ project: m.name, added: m.add.map((r) => r.dir) })),
    commit: `git -C "${brain}" add ${MAP_FILE} && git -C "${brain}" commit -m "Update the workspace map"`,
  };
}

/** After `project new|clone|add`: bring the map up to date when there is a brain. Never throws (says why instead). */
export async function refreshMapAfter(what, { dir = workspaceDir(), projects = projectsIn() } = {}) {
  if (!isDir(path.join(dir, 'ai_brain'))) return null;
  try {
    const r = await updateMap({ dir, projects });
    return r.diff.same ? null : `the workspace map was updated (${what}): commit it with  ${r.commit}`;
  } catch (e) {
    return `the workspace map was not updated: ${e.message}`;
  }
}

/** Take a project or another repository out of the map; it is never added back by `map`. No file is deleted. */
export function forget(name, dir = workspaceDir()) {
  if (typeof name !== 'string' || !relOk(name)) throw Object.assign(new Error('name a project or a folder of the map'), { status: 400 });
  const cur = readMap(dir);
  if (cur.errors) throw Object.assign(new Error(cur.errors.join('; ')), { status: 409 });
  if (!cur.exists) throw Object.assign(new Error('there is no workspace map yet (hoprig workspace map)'), { status: 404 });
  const m = cur.map;
  const before = m.projects.length + m.others.length;
  m.projects = m.projects.filter((p) => p.name !== name);
  m.others = m.others.filter((o) => o.dir !== name);
  const found = m.projects.length + m.others.length < before;
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
  if (cur.exists) {
    for (const [k, url] of flat(cur.map)) {
      const [kind, label] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const p = where(kind, label);
      let state = 'missing';
      if (diskFlat.has(k)) state = !url || !diskFlat.get(k) || sameUrl(url, diskFlat.get(k)) ? 'here' : 'different';
      else if (fs.existsSync(p)) state = 'different';
      entries.push({ kind, label, url: url || null, path: p, state });
    }
  }
  for (const [k, url] of diskFlat) {
    if (cur.exists && flat(cur.map).has(k)) continue;
    if (k === 'brain:ai_brain' && !isGitRepo(path.join(dir, 'ai_brain'))) continue;
    const [kind, label] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    entries.push({ kind, label, url: url || null, path: where(kind, label), state: 'unmapped' });
  }
  const counts = {};
  for (const e of entries) counts[e.state] = (counts[e.state] || 0) + 1;
  return { ...base, entries, counts };
}
