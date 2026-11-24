// A project's needs: other entries of the workspace map it READS, named in its own project.json
// (`"needs": ["kits/parts"]`), and for one session `hoprig --with <name>` and "Also open" in the new-session sheet.
//
// ONE function decides an extra folder (extraFolder): a name of the map → its entry → its folder here, by its real
// path. Every caller uses it (a session's start in a terminal and in the App, the server for every name from a
// browser, `hoprig get`, status, drop). What it refuses, in every spelling:
//   - anything that is not a name of the map (a path, "..", a trailing "/", a name the map does not hold);
//   - the AI brain, the credentials folder, a folder Hoprig never looks into, a group's own repository as a whole,
//     a repository that is not a project ("other"), the session's own folder (or a folder around or inside it);
//   - a folder that leads out of where the map puts it through a link, or whose real place is outside the workspace
//     and the projects folder, or is (or holds, or lies in) the credentials folder or the brain;
//   - a folder with a link (also in .git and node_modules, never looked for in a private folder), or one in a folder
//     outside it that one of its links leads to, to the credentials folder as a whole, into the brain, to a folder that
//     holds either, or out of the workspace unless the owner named it his own (needswalk.mjs): a shell command follows
//     links;
//   - a folder whose path has a character the coding tool's rules cannot name.
// A need is opened only after the owner accepted it ON THIS COMPUTER (needsyes.mjs): a project.json is someone else's
// words until he says so. `--with` and "Also open" are his own word for one session.
// Nothing here fetches or starts a program: it reads the map, project.json files and the disk, and only when a command
// is typed, a page asks or a session starts; it writes only his yes, in Hoprig's own settings.
//
// What a session gets for each extra folder (extraSettings), for Claude Code in the settings Hoprig already hands it
// (launch.mjs, chat/engines/claude.mjs): the folder as an additional directory; deny rules for its file-writing tools
// there; Read denied under its private folders and its credential links; and its own deny rules for files from its
// .claude/settings.json and settings.local.json, re-based onto it. Its allow rules never travel. A shell command can
// still write there: the deny rules hold the coding tool's own file tools only (docs/WORKSPACE.md says so).
import fs from 'node:fs';
import path from 'node:path';
import { FOLD, PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { NEED_RE, readManifest } from '../pcsetup/workspace.mjs';
import { credsDir } from './credlinks.mjs';
import { projectRoot } from './groups.mjs';
import { leaves, leavesWords, myLinkEntries, readIn, realOf } from './inside.mjs';
import { brainDir, isDir, projectsIn, workspaceDir } from './layout.mjs';
import { readMap } from './map.mjs';
import { neverLook, pickProject, placeOf, refOf } from './mapcheck.mjs';
import { RULE_SAFE, linkWalk, mineOf, shown } from './needswalk.mjs';
import { acceptCommand, acceptedNeeds, isAccepted, setAccepted } from './needsyes.mjs';

export const WITH_MAX = 10;
const fold = (p) => (FOLD ? String(p).toLowerCase() : String(p));
const within = (p, top) => {
  const a = fold(p);
  const b = fold(top);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};
const overlap = (a, b) => within(a, b) || within(b, a);

/** The map, or why it cannot be used. → { map } | { why } */
export function mapFor(dir = workspaceDir()) {
  const m = readMap(dir);
  if (m.errors) return { why: `the workspace map was refused (${m.errors[0]})` };
  if (!m.exists) return { why: 'there is no workspace map on this computer (hoprig workspace map makes it)' };
  return { map: m.map };
}

/**
 * THE decision for one name. `ctx`: { dir, projects }; `map`: the map read once by the caller; `self`: the real
 * folder of the session (or project) it would be added to. → { ok: true, ref, dir, here: true } |
 * { ok: false, ref?, here: false, why, fix } (in the map, not here: fix is the get) | { ok: false, why } (refused).
 * `walk: false` leaves out the walk of its links (a list or a check of a name: every start decides with it, once, and
 * hands what it found on to extraSettings as `walked`). `walkOpts`: for a test (needswalk.mjs linkWalk).
 */
export async function extraFolder(name, { map, ctx, self = null, walk = true, walkOpts = {} }) {
  const s = typeof name === 'string' ? name : '';
  if (!s || !NEED_RE.test(s)) return { ok: false, why: `"${shown(name)}" is not a name of the workspace map (name it <name> or <place>/<name>, never a path)` };
  const parts = s.split('/');
  const first = parts[0].toLowerCase();
  if (first === 'ai_brain') return { ok: false, why: `"${s}" is the AI brain, which is never shared with another project` };
  if (first === 'credentials' || parts.some((x) => x.toLowerCase() === 'credentials')) return { ok: false, why: `"${s}" is the credentials folder, which is never shared with another project` };
  if (parts.some(neverLook)) return { ok: false, why: `"${s}" is a folder Hoprig never looks into` };
  if (!map) return { ok: false, why: 'there is no workspace map to look the name up in' };
  const group = (map.groups || []).find((g) => g.dir.toLowerCase() === s.toLowerCase());
  if (group) {
    const members = map.projects.filter((p) => p.in && p.in.toLowerCase() === group.dir.toLowerCase()).map(refOf).sort();
    const such = members.length ? `, such as ${members.slice(0, 3).join(', ')}` : '';
    return { ok: false, why: `"${s}" is a group as a whole: name one project of it (${group.dir}/<name>${such})` };
  }
  if ((map.others || []).some((o) => o.dir.toLowerCase() === s.toLowerCase())) return { ok: false, why: `"${s}" is a repository of the map that is no project: only a project, or a project of a group, is an extra folder` };
  let entry;
  try {
    entry = pickProject(map.projects.map((p) => ({ name: p.name, place: placeOf(p), p })), s).p;
  } catch (e) {
    return { ok: false, why: e.status === 404 ? `the workspace map has no project "${s}" (hoprig get --list shows every name)` : e.message };
  }
  const ref = refOf(entry);
  const root = projectRoot(entry, ctx);
  if (!isDir(root)) return { ok: false, ref, here: false, why: `${ref} is not on this computer`, fix: `hoprig get ${ref}` };
  const b = leaves(root, root, ctx);
  if (b) return { ok: false, ref, why: `${ref}: ${leavesWords(b)}, so it is not opened` };
  const real = realOf(root);
  if (!real) return { ok: false, ref, why: `${ref}: its folder cannot be read` };
  const tops = [realOf(ctx.dir), realOf(ctx.projects)].filter(Boolean);
  if (!tops.some((t) => within(real, t))) return { ok: false, ref, why: `${ref}: its folder is outside the workspace` };
  for (const [what, d] of [['the credentials folder', credsDir(ctx.dir)], ['the AI brain', brainDir(ctx.dir)]]) {
    const r = realOf(d);
    if (r && overlap(real, r)) return { ok: false, ref, why: `${ref}: its folder leads to ${what}, which is never shared with another project` };
  }
  if (self && overlap(real, self)) return { ok: false, ref, own: real === self, why: `${ref} is the session's own folder, or around or inside it` };
  if (!RULE_SAFE.test(real)) return { ok: false, ref, why: `${ref}: its folder's path has a character the coding tool's rules cannot name, so it is not opened` };
  if (!walk) return { ok: true, ref, dir: real, here: true };
  const w = await linkWalk(real, { ...fenceOf(ctx), ...walkOpts });
  if (w.why) return { ok: false, ref, why: `${ref}: ${w.why}, so it is not opened${w.mylink ? ` (if that link is yours:  ${w.mylink})` : ''}` };
  return { ok: true, ref, dir: real, here: true, walked: w };
}

/** The project of the map whose folder here holds `folder` (by real path; the deepest). → { entry, ref, root } | null */
export function projectAt(folder, { map, ctx }) {
  const real = realOf(folder);
  if (!real || !map) return null;
  let best = null;
  for (const p of map.projects) {
    const root = projectRoot(p, ctx);
    const r = isDir(root) ? realOf(root) : null;
    if (r && within(real, r) && (!best || r.length > best.real.length)) best = { entry: p, ref: refOf(p), root, real: r };
  }
  return best;
}

/** The needs a project's own project.json names here. → { needs: [name], warnings: [text] } */
export async function needsOf(root) {
  const m = await readManifest(root).catch(() => ({ manifest: null }));
  if (!m.manifest) return { needs: [], warnings: [] };
  return { needs: m.manifest.needs || [], warnings: (m.warnings || []).filter((w) => w.startsWith('needs: ')) };
}

/**
 * Each need of a project, decided: { name, ...extraFolder, accepted } for every name, the refused ones with why. A need
 * of a need is not followed here (needsToGet names them). `walk`: false for a list (no link walk); with `gate`, a need
 * here that the owner has not accepted on this computer is not walked and comes back { ok: false, here: true,
 * notAccepted: true, allow: command }.
 */
export async function projectNeeds(root, ref, { map, ctx, walk = true, gate = false, walkOpts }) {
  const n = await needsOf(root);
  const self = realOf(root);
  const yes = acceptedNeeds();
  const out = [];
  for (const name of n.needs) {
    let r = await extraFolder(name, { map, ctx, self, walk: false });
    if (r.ref === ref) r = { ok: false, why: `${ref} names itself as a need` };
    const accepted = !!(r.ref && isAccepted(ref, r.ref, yes));
    if (r.ok && gate && !accepted) r = { ok: false, ref: r.ref, here: true, notAccepted: true, why: 'not accepted on this computer yet', allow: acceptCommand(ref, r.ref) };
    else if (r.ok && walk) r = await extraFolder(name, { map, ctx, self, walkOpts });
    out.push({ name, ...r, accepted });
  }
  return { list: out, warnings: n.warnings };
}

/**
 * The owner's yes (or its taking back) for need `need` of the project in `folder`, on this computer: only for a name
 * that project's project.json names and the map holds. → { project, need, accepted } | throws { status } with why
 */
export async function acceptNeed(project, need, { yes = true, dir = workspaceDir(), projects = projectsIn(), folder = null } = {}) {
  const ctx = { dir, projects };
  const m = mapFor(dir);
  if (m.why) throw Object.assign(new Error(m.why), { status: 400 });
  let at;
  if (folder) at = projectAt(folder, { map: m.map, ctx });
  else {
    const p = m.map.projects.find((x) => refOf(x) === project);
    at = p ? { entry: p, ref: refOf(p), root: projectRoot(p, ctx) } : null;
  }
  if (!at || !isDir(at.root)) throw Object.assign(new Error(`"${shown(project || folder)}" is not a project of the workspace map on this computer`), { status: 404 });
  const n = await projectNeeds(at.root, at.ref, { map: m.map, ctx, walk: false });
  const hit = n.list.find((x) => x.name === need || x.ref === need);
  if (!hit || !hit.ref || !(hit.ok || hit.here === false)) {
    throw Object.assign(new Error(hit ? `${at.ref} names "${shown(need)}", which cannot be read by it: ${hit.why}` : `${at.ref}'s project.json does not name "${shown(need)}" in "needs"`), { status: 400 });
  }
  return setAccepted(at.ref, hit.ref, yes);
}

// ---------------------------------------------------------------- a session

/**
 * The extra folders of one session in `folder`: each need of its project that is here, and each `withs` name
 * (`--with`, "Also open"). Decided at its start only. → { dirs: [real path], refs: [name], missing: [{ ref, fix, of }],
 * warnings: [text], refused: [text] (a `withs` name that cannot be opened: the start is refused), project }
 */
export async function sessionExtras(folder, { withs = [], dir = workspaceDir(), projects = projectsIn(), walk = true, walkOpts } = {}) {
  const out = { dirs: [], refs: [], missing: [], notAccepted: [], warnings: [], refused: [], project: null, walked: {} };
  const names = Array.isArray(withs) ? withs : [];
  if (names.length > WITH_MAX) out.refused.push(`at most ${WITH_MAX} extra folders for one session`);
  const ctx = { dir, projects };
  const m = mapFor(dir);
  if (m.why) {
    if (names.length) out.refused.push(`--with needs the workspace map: ${m.why}`);
    return out;
  }
  const self = realOf(folder);
  const at = projectAt(folder, { map: m.map, ctx });
  const add = (r) => {
    if (!out.dirs.includes(r.dir)) {
      out.dirs.push(r.dir);
      out.refs.push(r.ref);
      if (r.walked) out.walked[r.dir] = r.walked; // the one walk of this start, handed on to extraSettings
    }
  };
  // `--with` and "Also open" first: the owner's own word for this session (a need he names there needs no yes).
  const given = [];
  for (const name of names.slice(0, WITH_MAX)) {
    const r = await extraFolder(name, { map: m.map, ctx, self, walk, walkOpts });
    if (r.ok) given.push(r);
    else out.refused.push(r.fix ? `${r.why}: get it first with  ${r.fix}` : r.why);
  }
  const named = new Set(given.map((r) => r.ref));
  if (at) {
    out.project = at.ref;
    const p = await projectNeeds(at.root, at.ref, { map: m.map, ctx, walk, gate: true, walkOpts });
    for (const w of p.warnings) out.warnings.push(`${at.ref}'s project.json: ${w}`);
    for (const n of p.list) {
      if (n.ref && named.has(n.ref)) continue; // opened by --with / Also open below
      if (n.ok) add(n);
      else if (n.notAccepted) out.notAccepted.push({ ref: n.ref, of: at.ref, allow: n.allow });
      else if (n.here === false && n.fix) out.missing.push({ ref: n.ref, fix: n.fix, of: at.ref });
      else out.warnings.push(`${at.ref} needs "${shown(n.name)}", which is not opened: ${n.why}`);
    }
  }
  for (const r of given) add(r);
  return out;
}

/** The lines a session's start shows (terminal: before the tool starts; App: one line). */
export function startNote(ex) {
  const lines = [];
  if (ex.refs.length) lines.push(`extra folders to read (its file tools cannot write there; a shell command still could): ${ex.refs.join(', ')}`);
  for (const m of ex.missing) lines.push(`${m.of} needs ${m.ref}, which is not on this computer (nothing is fetched): ${m.fix}`);
  for (const m of ex.notAccepted || []) lines.push(`${m.of} needs ${m.ref}: not opened: not accepted on this computer yet:  ${m.allow}`);
  for (const w of ex.warnings) lines.push(w);
  return lines;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Glob', 'Grep']);
const RULES_MAX = 200;

/**
 * Re-base one deny rule of the extra folder's own settings onto it: [rule] (two for a pattern that matches at any
 * depth), or null when it is not a rule for files. Claude Code reads a path in a rule the way .gitignore does: a pattern
 * with no "/" but perhaps a last one (`secret.txt`, `*.pem`, `hidden/`) matches at any depth, so it becomes `//d/p` and
 * the same under `//d/**`; one with a "/" (also `./p` and `/p`, which name the project's top) stays anchored at the folder's top.
 */
export function rebase(rule, d) {
  if (typeof rule !== 'string' || rule.length > 300 || /[\u0000-\u001f]/.test(rule)) return null;
  const m = /^([A-Za-z]+)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m || !FILE_TOOLS.has(m[1])) return null;
  const spec = m[2];
  if (spec === undefined || spec === '' || spec === '**') return [`${m[1]}(/${d}/**)`];
  if (spec.startsWith('//') || spec.startsWith('~/')) return [`${m[1]}(${spec})`]; // already its own place
  const rel = spec.replace(/^\.\//, '').replace(/^\//, '');
  if (rel.split('/').includes('..')) return [`${m[1]}(/${d}/**)`]; // a rule that climbs out: the whole folder instead
  const anyDepth = rel === spec && !rel.replace(/\/$/, '').includes('/');
  return anyDepth ? [`${m[1]}(/${d}/${rel})`, `${m[1]}(/${d}/**/${rel})`] : [`${m[1]}(/${d}/${rel})`];
}

// The deny rules of the folder's own settings (never through a link). → [rule]
function ownDenies(d) {
  const out = [];
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      const b = readIn({ root: d }, path.join(d, '.claude', f), { below: true });
      const deny = b ? JSON.parse(b.toString('utf8'))?.permissions?.deny : null;
      if (Array.isArray(deny)) for (const r of deny.slice(0, RULES_MAX)) out.push(...(rebase(r, d) || []));
    } catch {
      /* none, or not valid JSON: nothing of it travels */
    }
  }
  return out;
}

// What the walk needs to know of this workspace: the credentials folder, the brain, the workspace and the projects
// folder (by real path), and the links the owner named as his own (ctx.mylinks: a test's own list).
const fenceOf = (ctx) => ({
  creds: realOf(credsDir(ctx.dir)),
  brain: realOf(brainDir(ctx.dir)),
  bounds: [realOf(ctx.dir), realOf(ctx.projects || projectsIn())].filter(Boolean),
  mine: mineOf(ctx.mylinks || myLinkEntries()),
});

/**
 * What the coding tool gets for the extra folders `dirs` (real paths): Claude Code's permissions block, to be added to
 * the settings Hoprig hands the session. `walked`: { [dir]: linkWalk's result }, what the start's one walk found
 * (sessionExtras); a folder without it is walked here (a caller of its own). → { additionalDirectories, deny } | null
 */
export async function extraSettings(dirs, { dir = workspaceDir(), projects = projectsIn(), walked = {} } = {}) {
  if (!dirs || !dirs.length) return null;
  const deny = [];
  for (const d of dirs) {
    for (const t of ['Edit', 'Write', 'NotebookEdit']) deny.push(`${t}(/${d}/**)`);
    // Its private folders as a whole, and anything reached through them (also one that is a link): the walk never
    // enters them, so a link inside one is kept from the file tools by these rules alone.
    for (const p of PRIVATE_DIRS) deny.push(`Read(/${d}/${p})`, `Read(/${d}/${p}/**)`, `Read(/${d}/**/${p})`, `Read(/${d}/**/${p}/**)`);
    const m = await readManifest(d).catch(() => ({ manifest: null }));
    const places = Object.keys((m.manifest && m.manifest.credentials) || {});
    const w = walked[d] || (await linkWalk(d, fenceOf({ dir, projects })));
    if (w.why) deny.push(`Read(/${d}/**)`);
    for (const p of [...new Set([...places, ...(w.credLinks || [])])].filter((x) => RULE_SAFE.test(x))) deny.push(`Read(/${d}/${p})`, `Read(/${d}/${p}/**)`);
    for (const l of w.privLinks || []) deny.push(`Read(/${d}/${l.link})`, `Read(/${d}/${l.link}/**)`, `Read(/${l.to})`, `Read(/${l.to}/**)`);
    deny.push(...ownDenies(d));
  }
  return { additionalDirectories: [...dirs], deny: [...new Set(deny)] };
}

/** Add the extra folders' permissions to a settings object (the one Hoprig hands the coding tool). */
export function withExtras(settings, extra) {
  if (!extra) return settings;
  const p = (settings && settings.permissions) || {};
  return {
    ...settings,
    permissions: {
      ...p,
      additionalDirectories: [...new Set([...(p.additionalDirectories || []), ...extra.additionalDirectories])],
      deny: [...new Set([...(p.deny || []), ...extra.deny])],
    },
  };
}

// ---------------------------------------------------------------- get and drop

/**
 * What `hoprig get` of project `ref` (now in `root`) offers with it: each need not here, and each need of a need
 * (from its project.json here, else what the map says of it) not here, with whose it is. A loop ends: a name is
 * named once, never the project itself. → { needs, here: [ref], missing: [{ name, of }], refused: [{ name, why }] }
 */
export async function needsToGet(root, ref, { map, ctx }) {
  const out = { needs: [], here: [], missing: [], refused: [], notAccepted: [] };
  const p = await projectNeeds(root, ref, { map, ctx, walk: false }); // get walks nothing: a session's start does
  const named = new Set([ref]);
  const look = async (list, of) => {
    const next = [];
    for (const n of list) {
      const key = n.ref || n.name;
      if (of === ref) out.needs.push(key);
      if (of === ref && n.ok) out.here.push(n.ref);
      if (named.has(key)) continue;
      named.add(key);
      if ((n.ok || (n.here === false && n.fix)) && n.ref && !n.accepted) out.notAccepted.push({ name: n.ref, of, here: !!n.ok });
      if (n.here === false && n.fix) out.missing.push({ name: n.ref, of });
      else if (!n.ok) out.refused.push({ name: shown(n.name), why: n.why, of });
      if (n.ref && of === ref) next.push(n);
    }
    return next;
  };
  const first = await look(p.list, ref);
  // One level more, named in the same question; never followed further by itself.
  for (const n of first) {
    let more = [];
    if (n.ok) more = (await projectNeeds(n.dir, n.ref, { map, ctx, walk: false })).list;
    else {
      const entry = map.projects.find((x) => refOf(x) === n.ref);
      more = [];
      for (const name of entry && Array.isArray(entry.needs) ? entry.needs : []) more.push({ name, ...(await extraFolder(name, { map, ctx, walk: false })) });
    }
    await look(more.filter((x) => (x.ref || x.name) !== n.ref), n.ref);
  }
  return out;
}

/** The projects here whose project.json names `ref` as a need (direct needs only). → [ref] */
export async function neededBy(ref, { ctx }) {
  const m = mapFor(ctx.dir);
  if (m.why) return [];
  const out = [];
  for (const p of m.map.projects) {
    const pref = refOf(p);
    if (pref === ref) continue;
    const root = projectRoot(p, ctx);
    if (!isDir(root) || leaves(root, root, ctx)) continue;
    const n = await needsOf(root);
    for (const name of n.needs) {
      let hit;
      try {
        hit = refOf(pickProject(m.map.projects.map((x) => ({ name: x.name, place: placeOf(x), p: x })), name).p);
      } catch {
        hit = null;
      }
      if (hit === ref && !out.includes(pref)) out.push(pref);
    }
  }
  return out.sort();
}

/** Each project here that names needs, with those not on this computer (workspace status). */
export async function needsHere({ dir = workspaceDir(), projects = projectsIn() } = {}) {
  const m = mapFor(dir);
  if (m.why) return [];
  const ctx = { dir, projects };
  const out = [];
  for (const p of m.map.projects) {
    const root = projectRoot(p, ctx);
    if (!isDir(root) || leaves(root, root, ctx)) continue;
    const ref = refOf(p);
    // gate: a need nobody here said yes to is not walked; walked are only the ones a session would open.
    const n = await projectNeeds(root, ref, { map: m.map, ctx, gate: true });
    if (!n.list.length && !n.warnings.length) continue;
    out.push({
      project: ref,
      needs: n.list.map((x) => x.ref || x.name),
      accepted: n.list.filter((x) => x.accepted).map((x) => x.ref),
      notAccepted: n.list.filter((x) => x.notAccepted || (x.here === false && x.fix && !x.accepted)).map((x) => ({ name: x.ref, allow: acceptCommand(ref, x.ref) })),
      missingNeeds: n.list.filter((x) => x.here === false && x.fix).map((x) => ({ name: x.ref, fix: x.fix })),
      refused: [...n.list.filter((x) => !x.ok && !x.notAccepted && !(x.here === false && x.fix)).map((x) => ({ name: shown(x.name), why: x.why })), ...n.warnings.map((w) => ({ name: '', why: w }))],
    });
  }
  return out;
}

/** "Also open" in the new-session sheet: what may be ticked for a session in `folder` (null: any), and its project's own needs. */
export async function extraChoices(folder, { dir = workspaceDir(), projects = projectsIn() } = {}) {
  const ctx = { dir, projects };
  const m = mapFor(dir);
  if (m.why) return { project: null, needs: [], choices: [], why: m.why };
  // No folder: the list before a project is chosen (the session's own project is skipped at its start: server.mjs).
  const self = folder ? realOf(folder) : null;
  const at = folder ? projectAt(folder, { map: m.map, ctx }) : null;
  // No walk of links here (a list): the start decides with it. `accepted`: the owner's yes on this computer.
  const needs = at ? (await projectNeeds(at.root, at.ref, { map: m.map, ctx, walk: false })).list.map((x) => ({ name: x.ref || shown(x.name), here: x.ok === true, accepted: x.accepted, ...(x.fix ? { fix: x.fix } : {}), ...(x.ok !== true && !x.fix ? { why: x.why } : {}) })) : [];
  const choices = [];
  for (const p of m.map.projects) {
    const r = await extraFolder(refOf(p), { map: m.map, ctx, self, walk: false });
    if (r.ok && !needs.some((n) => n.name === r.ref)) choices.push(r.ref);
  }
  choices.sort();
  return { project: at ? at.ref : null, needs, choices };
}
