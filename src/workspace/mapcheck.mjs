// The strict check of the workspace map (map.mjs has the file and its shape). The map comes from a repository, so
// it is data that is never trusted: every key is known, every folder is inside the workspace, every address passes
// the project code's parser. A map that fails is not used and nothing is changed.
//
// Version 1 is the map as it was first made. Version 2 adds groups (an owner's own folders of projects beside the
// projects folder, docs/WORKSPACE.md), "in" on a project (the place it is in), "find" on a place (its naming rule,
// findrule.mjs), "tool" on a group (its own command, grouptool.mjs), and leaves room for keys a later Hoprig fills in:
// "credentials" and "storage" on the map, "needs" on a project. Those are only checked for their shape and kept here.
import { looksSecret } from '../assistant/secrets.mjs';
import { PRIVATE_DIRS, cleanRemote, parseRepo } from '../pcsetup/projects.mjs';
import { NAME_RE, relOk } from '../pcsetup/workspace.mjs';
import { compileFind } from './findrule.mjs';

const NEVER = new Set([...PRIVATE_DIRS, 'credentials', 'node_modules']);
// Reserved names are compared without letter case, on every system: on a file system that ignores case,
// "Credentials" or "No-AI" is the real folder.
export const neverLook = (name) => name.startsWith('.') || NEVER.has(name.toLowerCase());
const low = (d) => String(d).toLowerCase();
export const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;
export const MAP_VERSIONS = [1, 2];
// The folders of the default tree (layout.mjs TREE): a group is never one of them or inside one.
const TREE_FOLDERS = ['ai_brain', 'projects', 'credentials', 'development', 'git', 'database', 'backups'];
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const inside = (a, b) => a === b || a.startsWith(`${b}/`);

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

// The usual hosting sites take an owner's and a repository's name in any case (Alex/Shop is alex/shop there).
const CASELESS_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

// The port a scheme uses when none is written: written out, it is the same address.
const DEFAULT_PORT = { ssh: 22, https: 443, http: 80 };

/**
 * One spelling of an address, for comparing: `git@host:o/r`, `ssh://git@host/o/r` and `https://host/o/r` are the
 * same; ".git", a trailing "/", a user name or password, the host's case and the scheme's own port (22, 443, 80) do
 * not count, `git@host:/abs/repo` is `ssh://git@host/abs/repo`, and on the usual hosting sites neither does the case
 * of the owner and the repository. Anything else is compared as it is.
 */
export function urlKey(u) {
  const s = cleanRemote(String(u || '').trim()).replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  let m = /^(https?|ssh|git):\/\/(?:[^/@]*@)?([^/:]+)(?::(\d+))?\/+(.+)$/i.exec(s);
  if (!m) m = /^()(?:[^/@:]+@)?([^/:]+):(?!\/\/)()\/?(.+)$/.exec(s); // scp-like: git@host:owner/repo, git@host:/abs/repo
  if (!m) return s;
  const host = m[2].toLowerCase();
  const port = m[3] && Number(m[3]) !== DEFAULT_PORT[m[1].toLowerCase()] ? `:${Number(m[3])}` : '';
  return `${host}${port}/${CASELESS_HOSTS.has(host) ? m[4].toLowerCase() : m[4]}`;
}

/** Two addresses of the same repository? (the one rule for the map, its checks, restore and `hoprig get`: urlKey) */
export function sameUrl(a, b) {
  return Boolean(a && b) && urlKey(a) === urlKey(b);
}

/**
 * A folder of the workspace the map may name: relative, no "..", none of the folders the map never looks into, and
 * written one way only (no trailing or doubled "/", no "." part), so one folder is never two entries.
 */
export const canonical = (d) => typeof d === 'string' && !d.endsWith('/') && !d.includes('//') && !d.split('/').includes('.');
// No part starts with "-": such a folder would read as an option to a program it is handed to.
export const wsFolderOk = (d) => relOk(d) && canonical(d) && !d.split('/').some((x) => neverLook(x) || x.startsWith('-'));
/** What a person typed as a folder, written the map's one way: "a//b/" → "a/b", "./a" → "a". */
export const tidyFolder = (d) => (String(d).startsWith('/') ? String(d) : String(d).split('/').filter((x) => x && x !== '.').join('/')); // a full path stays one: the check refuses it

/** Where a project is: its "in", or '' for the projects folder. */
export const placeOf = (p) => (p && typeof p.in === 'string' ? p.in : '');
/** How the map, its skip list and every command name a project: <name>, or <place>/<name> outside the projects folder. */
export const refOf = (p) => (placeOf(p) ? `${p.in}/${p.name}` : p.name);
/** The projects folder's own <place>/<name> form, for when a bare name is in two places: projects/<name>. */
export const PROJECTS_PLACE = 'projects';
export const fullRef = (place, name) => `${place || PROJECTS_PLACE}/${name}`;

/**
 * The one rule for a project a command, a route or Tia names (`items`: [{ name, place }]): <place>/<name> or
 * projects/<name> is that one; a bare <name> is the one project of that name, and when two places have it, it is
 * refused with both <place>/<name> forms. → the item. Throws { status, choices? }.
 */
export function pickProject(items, ref, what = 'the map') {
  if (typeof ref !== 'string' || !ref) throw Object.assign(new Error('name a project'), { status: 400 });
  const slash = ref.lastIndexOf('/');
  if (slash > 0) {
    const [place, name] = [ref.slice(0, slash), ref.slice(slash + 1)];
    const hit = items.find((x) => x.name === name && (x.place || '') === (place === PROJECTS_PLACE ? '' : place));
    if (hit) return hit;
  } else {
    const named = items.filter((x) => x.name === ref);
    if (named.length > 1) {
      const choices = [...named].sort((a, b) => (a.place ? 1 : 0) - (b.place ? 1 : 0)).map((x) => fullRef(x.place, x.name)); // the projects folder first
      throw Object.assign(new Error(`"${ref}" is in ${named.length} places: say which one (${choices.join(', ')})`), { status: 409, choices });
    }
    if (named.length === 1) return named[0];
  }
  throw Object.assign(new Error(`no project "${ref.slice(0, 100)}" in ${what}`), { status: 404 });
}

/**
 * Strict check of a map read from a file. `write`: the map is about to be written, so the rules that guard what is
 * written apply too (one repository address in one place only). → { ok, map } | { ok: false, errors }
 */
export function validateMap(m, { write = false, known = [] } = {}) {
  const errors = [];
  if (!isObj(m)) return { ok: false, errors: ['the map is not an object'] };
  const v2 = m.version === 2;
  const topKeys = ['version', 'config', 'brain', 'projects', 'others', 'skip', ...(v2 ? ['groups', 'credentials', 'storage'] : [])];
  for (const k of Object.keys(m)) if (!topKeys.includes(k)) errors.push(`unknown key "${String(k).slice(0, 30)}"${['groups', 'credentials', 'storage'].includes(k) ? ' (it needs a map of version 2: hoprig workspace map --upgrade)' : ''}`);
  if (!MAP_VERSIONS.includes(m.version)) errors.push('"version" must be 1 or 2');
  const url = (val, what) => {
    try {
      return mapUrl(val);
    } catch (e) {
      errors.push(`${what}: ${e.message}`);
      return undefined;
    }
  };
  const branch = (val, what) => {
    if (val === undefined) return undefined;
    if (typeof val !== 'string' || !BRANCH_RE.test(val)) errors.push(`${what}: bad branch`);
    return val;
  };
  // sync: false = a tool (an SDK checkout): restored on a fresh computer, never synced. Only a boolean is kept.
  const syncOf = (e, val, what) => {
    if (val === undefined) return e;
    if (typeof val !== 'boolean') errors.push(`${what}: "sync" is true or false`);
    else e.sync = val;
    return e;
  };
  const memoriesOf = (val, what, where) => {
    const ok = isObj(val) && Object.entries(val).every(([k, x]) => relOk(k, { dot: true }) && relOk(x) && ![...k.split('/'), ...x.split('/')].some((s) => s !== '.' && neverLook(s)));
    if (!ok) errors.push(`${what}: "memories" maps folders inside the ${where} to memory folders inside it`);
    return ok && Object.keys(val).length ? { ...val } : undefined;
  };
  const out = { version: v2 ? 2 : 1, brain: { url: null }, projects: [], others: [] };
  let projectsDir = 'projects';
  if (m.config !== undefined) {
    // The workspace's own settings a fresh computer needs; never a machine path, a host or anything secret.
    if (!isObj(m.config) || Object.keys(m.config).some((k) => k !== 'projectsDir')) errors.push('"config" is { projectsDir? }');
    else if (m.config.projectsDir !== undefined) {
      const d = m.config.projectsDir;
      if (!wsFolderOk(d) || low(d.split('/')[0]) === 'ai_brain') errors.push('"config.projectsDir" must be a folder inside the workspace');
      else out.config = { projectsDir: (projectsDir = d) };
    }
  }
  if (m.brain !== undefined) {
    if (!isObj(m.brain) || Object.keys(m.brain).some((k) => k !== 'url')) errors.push('"brain" is { url }');
    else out.brain.url = url(m.brain.url, 'brain') ?? null;
  }
  if (v2) Object.assign(out, laterKeys(m, { url, errors }));

  // ---- groups (version 2) ----
  const places = new Map(); // place id → { members: 'own' | 'group' }
  if (v2) {
    out.groups = [];
    for (const g of Array.isArray(m.groups) ? m.groups : m.groups === undefined ? [] : (errors.push('"groups" must be a list'), [])) {
      const label = isObj(g) && typeof g.dir === 'string' ? g.dir.slice(0, 60) : '?';
      if (!isObj(g) || Object.keys(g).some((k) => !['dir', 'url', 'memories', 'holds', 'tool', 'find'].includes(k))) {
        errors.push(`group "${label}": a group is { dir, url?, memories?, holds?, tool?, find? }`);
        continue;
      }
      if (!wsFolderOk(g.dir)) {
        errors.push(`group "${label}": its folder must be a folder inside the workspace (no "..", no full path, no private or hidden folder)`);
        continue;
      }
      if (TREE_FOLDERS.includes(low(g.dir.split('/')[0])) || inside(low(g.dir), low(projectsDir)) || inside(low(projectsDir), low(g.dir))) {
        errors.push(`group "${label}": its folder is one of the workspace's own folders or inside one`);
        continue;
      }
      if (out.groups.some((x) => inside(low(x.dir), low(g.dir)) || inside(low(g.dir), low(x.dir)))) {
        errors.push(`group "${label}": two groups in one folder, or one group inside another`);
        continue;
      }
      const e = { dir: g.dir };
      if (g.url !== undefined && g.url !== null) e.url = url(g.url, `group "${label}"`) ?? null;
      const repo = Boolean(e.url);
      if (g.memories !== undefined) {
        if (!repo) errors.push(`group "${label}": only a group that is a repository keeps memory ("memories" needs "url")`);
        else {
          const mem = memoriesOf(g.memories, `group "${label}"`, 'group');
          if (mem) e.memories = mem;
        }
      }
      if (g.holds !== undefined) {
        if (!repo) errors.push(`group "${label}": only a group that is a repository holds named folders ("holds" needs "url")`);
        else if (!Array.isArray(g.holds)) errors.push(`group "${label}": "holds" must be a list`);
        else {
          e.holds = [];
          for (const h of g.holds) {
            const hl = isObj(h) && typeof h.dir === 'string' ? h.dir.slice(0, 40) : '?';
            if (!isObj(h) || Object.keys(h).some((k) => !['dir', 'parent', 'find'].includes(k))) errors.push(`group "${label}": a held folder is { dir, parent?, find? }`);
            else if (typeof h.dir !== 'string' || !NAME_RE.test(h.dir) || neverLook(h.dir) || ['ai_brain', 'code'].includes(low(h.dir))) errors.push(`group "${label}": held folder "${hl}" must be one plain folder name`);
            else if (e.holds.some((x) => low(x.dir) === low(h.dir))) errors.push(`group "${label}": held folder "${hl}" is named twice`);
            else if (h.parent !== undefined && h.parent !== 'group') errors.push(`group "${label}": held folder "${hl}": "parent" is "group" (its members come with the group's repository) or left out (each member is a repository of its own)`);
            else {
              const he = { dir: h.dir, ...(h.parent ? { parent: 'group' } : {}) };
              const f = findOf(h.find, `${g.dir}/${h.dir}`, errors);
              if (f && h.parent === 'group') errors.push(`${g.dir}/${h.dir}: its members come with the group's repository, so it has no naming rule ("find")`);
              else if (f) he.find = f;
              e.holds.push(he);
            }
          }
          if (!e.holds.length) delete e.holds;
        }
      }
      if (g.tool !== undefined) {
        const t = toolOf(g.tool, label, errors);
        if (t && !repo) errors.push(`group "${label}": only a group that is a repository has a tool`);
        else if (t) e.tool = t;
      }
      if (g.find !== undefined) {
        if (e.holds) errors.push(`group "${label}": a group that holds named folders keeps "find" on each of them`);
        const f = findOf(g.find, label, errors);
        if (f && !e.holds) e.find = f;
      }
      out.groups.push(e);
      // A plain group holds its projects itself; a group that is a repository keeps them in its held folders only, so
      // its own files and its members never mix.
      if (e.holds) for (const h of e.holds) places.set(`${e.dir}/${h.dir}`, { members: h.parent === 'group' ? 'group' : 'own' });
      else if (!repo) places.set(e.dir, { members: 'own' });
    }
  }

  // ---- projects ----
  const names = new Set();
  const projectKeys = ['name', 'url', 'repos', 'memories', 'sync', ...(v2 ? ['in', 'needs'] : [])];
  for (const p of Array.isArray(m.projects) ? m.projects : m.projects === undefined ? [] : (errors.push('"projects" must be a list'), [])) {
    if (!isObj(p) || Object.keys(p).some((k) => !projectKeys.includes(k))) {
      errors.push(`each project is { name, url, repos, memories?, sync?${v2 ? ', in?, needs?' : ''} }`);
      continue;
    }
    let where = '';
    if (p.in !== undefined) {
      if (typeof p.in !== 'string' || !wsFolderOk(p.in)) {
        errors.push(`"${String(p.name).slice(0, 40)}": "in" must be a folder inside the workspace (no "..", no full path, no private or hidden folder)`);
        continue;
      }
      if (!places.has(p.in)) {
        errors.push(`"${String(p.name).slice(0, 40)}": "in" names "${p.in.slice(0, 60)}", which is not a group or a held folder of the map`);
        continue;
      }
      where = p.in;
    }
    const ref = where ? `${where}/${p.name}` : p.name;
    if (typeof p.name !== 'string' || !NAME_RE.test(p.name) || neverLook(p.name)) {
      errors.push(`"${String(p.name).slice(0, 40)}" is not a project name the map accepts`);
      continue;
    }
    if (names.has(ref)) {
      errors.push(`"${ref.slice(0, 100)}" is in the map twice (a name is unique in its place)`);
      continue;
    }
    names.add(ref);
    const repos = [];
    for (const r of Array.isArray(p.repos) ? p.repos : []) {
      if (!isObj(r) || Object.keys(r).some((k) => !['dir', 'url', 'branch', 'sync'].includes(k)) || !relOk(r.dir) || r.dir.split('/').some(neverLook)) {
        errors.push(`${ref}: each repository is { dir (a folder inside the project), url, branch?, sync? }`);
        continue;
      }
      // One way of writing a folder (no "code//x" beside "code/x"), and never the code folder or ai_brain itself.
      if (!canonical(r.dir) || ['code', 'ai_brain'].includes(low(r.dir))) {
        errors.push(`${ref}/${String(r.dir).slice(0, 60)}: a repository's folder is written one way (no trailing or doubled "/") and is a folder inside code/ or elsewhere in the project, never code or ai_brain itself`);
        continue;
      }
      if (repos.some((x) => low(x.dir) === low(r.dir))) {
        errors.push(`${ref}/${r.dir.slice(0, 60)}: the same folder is named twice`);
        continue;
      }
      const e = { dir: r.dir, url: url(r.url, `${ref}/${r.dir}`) ?? null };
      const b = branch(r.branch, `${ref}/${r.dir}`);
      if (b) e.branch = b;
      repos.push(syncOf(e, r.sync, `${ref}/${r.dir}`));
    }
    const proj = { name: p.name, ...(where ? { in: where } : {}), url: url(p.url, ref) ?? null, repos };
    if (where && places.get(where).members === 'group' && proj.url) errors.push(`${ref}: its members come with the group's repository, so it has no address of its own`);
    if (p.memories !== undefined) {
      // Which folder's Claude Code memory lives where in the project (as in its project.json): linked after restore.
      const mem = memoriesOf(p.memories, ref, 'project');
      if (mem) proj.memories = mem;
    }
    if (p.needs !== undefined) {
      if (!Array.isArray(p.needs) || p.needs.some((x) => typeof x !== 'string' || !wsFolderOk(x))) errors.push(`${ref}: "needs" is a list of entries of the map`);
      else if (p.needs.length) proj.needs = [...new Set(p.needs)].sort();
    }
    out.projects.push(syncOf(proj, p.sync, ref));
  }
  for (const o of Array.isArray(m.others) ? m.others : []) {
    if (!isObj(o) || Object.keys(o).some((k) => !['dir', 'url', 'branch', 'sync'].includes(k)) || !wsFolderOk(o.dir) || ['ai_brain', 'projects'].includes(low(o.dir.split('/')[0]))) {
      errors.push(`"${String(o && o.dir).slice(0, 60)}" is not a folder of the workspace the map accepts`);
      continue;
    }
    const spot = memberSpot(o.dir, out.groups || []);
    if (spot) {
      errors.push(`"${o.dir.slice(0, 60)}": another repository is never ${spot} (that is an entry of its own)`);
      continue;
    }
    const e = { dir: o.dir, url: url(o.url, o.dir) ?? null };
    const b = branch(o.branch, o.dir);
    if (b) e.branch = b;
    out.others.push(syncOf(e, o.sync, o.dir));
  }
  if (m.skip !== undefined) {
    if (!Array.isArray(m.skip) || m.skip.some((s) => typeof s !== 'string' || !relOk(s) || !canonical(s))) errors.push('"skip" is a list of project names (<place>/<name> outside the projects folder), code repositories (<project>/<dir>) and folders');
    else if (m.skip.length) out.skip = [...new Set(m.skip)].sort();
  }
  // `known`: pairs the map has already (they came through a merge on the git server): they never block a write;
  // status names them with the forget to run.
  if (write && !errors.length) errors.push(...onePlace(out).filter((d) => !known.some((k) => k.key === d.key)).map((d) => d.message));
  return errors.length ? { ok: false, errors } : { ok: true, map: out };
}

/**
 * Where in a group a repository is an entry of its own, never an "other" one: the group's folder or around it (its
 * own repository), a place (a plain group, a held folder) or a member right in it, a member's code/<repo> where the
 * members come with the group. Anything else inside a group's folder may be an "other" repository (a tool folder of
 * the group, a folder of folders in a plain group). → why, or null
 */
export function memberSpot(dir, groups) {
  // Compared without letter case: on a file system that ignores it, Kits/builds is kits/builds.
  const d = low(dir);
  for (const grp of groups) {
    const g = { dir: low(grp.dir), url: grp.url, holds: grp.holds };
    if (inside(g.dir, d)) return 'where a group\'s folder is';
    if (!inside(d, g.dir)) continue;
    const places = g.holds ? g.holds.map((h) => ({ dir: `${g.dir}/${low(h.dir)}`, group: h.parent === 'group' })) : g.url ? [] : [{ dir: g.dir, group: false }];
    for (const pl of places) {
      if (d === pl.dir) return 'a group\'s held folder';
      if (!d.startsWith(`${pl.dir}/`)) continue;
      const rest = d.slice(pl.dir.length + 1).split('/');
      if (rest.length === 1) return 'where a project of a group is';
      if (pl.group) return 'inside a project that comes with its group';
    }
  }
  return null;
}

/**
 * One repository, one place: the same address as a project in two places (or as a group); in a place with a naming
 * rule (where a folder comes from the address) the same address twice; and anywhere two names in one place that differ
 * only in letter case (one folder on a file system that ignores it). Elsewhere two names in one place may keep one
 * address (two clones someone keeps, as in version 1). Refused when a command writes it; a pair the map has already
 * is used and named by status. → [{ key, a, b, message }]
 */
export function onePlace(map) {
  const seen = [];
  const out = [];
  const pair = (a, b, message) => out.push({ key: [a, b].sort().join('\n'), a, b, message });
  const ruled = new Set();
  for (const g of map.groups || []) {
    if (g.find && !g.url) ruled.add(g.dir);
    for (const h of g.holds || []) if (h.find) ruled.add(`${g.dir}/${h.dir}`);
  }
  for (const g of map.groups || []) if (g.url) seen.push({ url: g.url, place: `group ${g.dir}`, label: g.dir });
  const names = new Map();
  for (const p of map.projects) {
    const k = `${placeOf(p)}\n${String(p.name).toLowerCase()}`;
    if (names.has(k) && names.get(k) !== refOf(p)) pair(names.get(k), refOf(p), `${names.get(k)} and ${refOf(p)} differ only in letter case: on a file system that ignores it they are one folder`);
    else names.set(k, refOf(p));
    if (!p.url) continue;
    const twin = seen.find((x) => sameUrl(x.url, p.url));
    if (twin && twin.place !== placeOf(p)) pair(twin.label, refOf(p), `${refOf(p)} and ${twin.label} have the same address: one project is in one place only`);
    else if (twin && ruled.has(placeOf(p))) pair(twin.label, refOf(p), `${refOf(p)} and ${twin.label} have the same address: in a place with a naming rule one repository is in the map once`);
    else if (!twin) seen.push({ url: p.url, place: placeOf(p), label: refOf(p) });
  }
  return out;
}

/** "find" on a place: the naming rule of its repositories (findrule.mjs has the rules and says what is wrong). */
function findOf(f, label, errors) {
  if (f === undefined) return undefined;
  const c = compileFind(f);
  if (!c.ok) {
    errors.push(...c.errors.map((e) => `${label}: ${e}`));
    return undefined;
  }
  return c.rule.raw;
}

/**
 * "tool" on a group that is a repository: one command of its own (grouptool.mjs makes its launcher after the owner's
 * yes on a computer, with the checks only a computer can make: the file, links, the commands on its PATH).
 */
function toolOf(t, label, errors) {
  const list = (x) => x === undefined || (Array.isArray(x) && x.every((s) => typeof s === 'string' && /^[A-Za-z0-9._+-]{1,60}$/.test(s)));
  const ok = isObj(t) && Object.keys(t).every((k) => ['name', 'run', 'needs', 'needsOn'].includes(k))
    && typeof t.name === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(t.name) && relOk(t.run) && !t.run.split('/').some(neverLook)
    && list(t.needs) && (t.needsOn === undefined || (isObj(t.needsOn) && Object.entries(t.needsOn).every(([k, x]) => ['mac', 'linux', 'windows'].includes(k) && list(x))));
  if (!ok) {
    errors.push(`group "${label}": "tool" is { name, run (a file inside the group), needs?, needsOn? }`);
    return undefined;
  }
  if (['hop', 'hoprig'].includes(t.name)) {
    errors.push(`group "${label}": the tool's name "${t.name}" is Hoprig's own command`);
    return undefined;
  }
  if (t.run.split('/').includes('.') || !canonical(t.run)) {
    errors.push(`group "${label}": the tool's "run" is a file inside the group, written one way`);
    return undefined;
  }
  return JSON.parse(JSON.stringify(t));
}

/** "credentials" and "storage" on a version-2 map (later steps use them): checked for their shape and kept. */
function laterKeys(m, { url, errors }) {
  const out = {};
  if (m.credentials !== undefined) {
    if (!isObj(m.credentials) || Object.keys(m.credentials).some((k) => k !== 'url')) errors.push('"credentials" is { url }');
    else out.credentials = { url: url(m.credentials.url, 'credentials') ?? null };
  }
  if (m.storage !== undefined) {
    const entryOk = (e) => isObj(e) && Object.entries(e).every(([k, x]) => /^[A-Za-z][A-Za-z0-9]{0,30}$/.test(k) && typeof x === 'string' && x.length <= 300 && !looksSecret(x))
      && (e.endpoint === undefined || /^https:\/\/[^/@:\s]+(:\d{1,5})?(\/[^\s@]*)?$/.test(e.endpoint));
    if (!isObj(m.storage) || Object.entries(m.storage).some(([k, e]) => !NAME_RE.test(k) || !entryOk(e))) errors.push('"storage" names places for files, each { kind, endpoint (an https address without a user name or password), bucket, … }');
    else out.storage = JSON.parse(JSON.stringify(m.storage));
  }
  return out;
}
