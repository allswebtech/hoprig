// Getting a project onto this computer: `hoprig get <name>…` and `hoprig project clone` (one code path), the
// dashboard's "Get an existing project" and Tia's manage_project get.
//
// The folder is the project's name, whatever its parent repository is called (a parent is often "<name>-workspace"
// because the product repository is "<name>"). One rule, in this order:
//   1. the workspace map knows the address: the map's name;
//   2. else, after the clone, the "name" in the parent's project.json;
//   3. else the repository's name with a trailing "-workspace" taken off.
// For rule 2 the clone is made under a temporary name in the same folder and renamed once project.json is read; when
// the final name is taken by something else, the clone stays under the temporary name and that is said plainly
// (leftovers.mjs: what a run that did not finish leaves, and how the next one finishes it).
// Nothing that is there is ever moved or overwritten: a project that is here under another name is reported with
// the `mv` to run.
//
// A bare name is looked up in the map first, then on GitHub as "<name>-workspace" and "<name>" among the signed-in
// account and its organisations (gh repo view; project.json found with gh api repos/<o>/<r>/contents/project.json).
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture, showCommand, stream } from '../setup/system.mjs';
import { bold, dim, makeUi } from '../setup/ui.mjs';
import { neverLook, readMap, sameUrl } from '../workspace/map.mjs';
import { PROJECTS_PLACE, pickProject } from '../workspace/mapcheck.mjs';
import { isLinkedWorktree, workspaceDir } from '../workspace/layout.mjs';
import { chooseOwner, finishProject, flags, mapNote } from './project.mjs';
import { groupPlan } from './finish.mjs';
import { cleanRemote, cloneRepo, listRepos, parseRepo, projectsDir, rememberDir, wouldRemember } from './projects.mjs';
import { sayLeftover, sayLock, takeLock, tempNameFor, useLeftover } from './leftovers.mjs';
import { gitIn, leaves, leavesWords, mkdirIn, removeIn, renameIn, rmdirIn } from '../workspace/inside.mjs';
import { MANIFEST, NAME_RE, childCandidates, githubOwners, parseProjectSpec, readManifest, stamp, writeManifest } from './workspace.mjs';

const SUFFIX = '-workspace';

/**
 * Rule 3: "shop-workspace" → "shop"; a name that would not stay a plain name is kept as it is. null when neither is a
 * plain folder name (".x", "-rf", empty) or it is a folder the workspace never looks into (no-ai, credentials, ...).
 */
export function folderFromRepo(repoName) {
  const n = String(repoName || '').replace(/\.git$/, '');
  const cut = n.endsWith(SUFFIX) ? n.slice(0, -SUFFIX.length) : n;
  const plain = (x) => NAME_RE.test(x) && !neverLook(x);
  return plain(cut) ? cut : plain(n) ? n : null;
}

/** The repository's own name in an address ("https://host/o/shop-workspace.git" → "shop-workspace"). */
export const repoNameOf = (url) => {
  const r = parseRepo(url);
  return r ? r.name.replace(/\.git$/, '') : null;
};

/** The map's project for an address, or for a bare name (its name, else its repository's name). null when none. */
export function mapProjectFor(map, { url, name }) {
  const list = (map && map.projects) || [];
  if (url) return list.find((p) => p.url && sameUrl(p.url, url)) || null;
  return list.find((p) => p.name === name) || list.find((p) => p.url && [name, `${name}${SUFFIX}`].includes(repoNameOf(p.url))) || null;
}

/** The folders in `dir` whose git repository has the address `url` (linked worktrees and dot-folders left out). */
export async function findByAddress(dir, url, run = capture) {
  const out = [];
  for (const d of listRepos(dir)) {
    if (isLinkedWorktree(d)) continue;
    const r = await gitRead(d, ['config', '--get', 'remote.origin.url'], { run, timeout: 10_000 });
    if (r.ok && sameUrl(r.stdout.trim(), url)) out.push(path.basename(d));
  }
  return out;
}

// Printed for the owner to paste: each path quoted for a POSIX shell (showCommand), so nothing in a folder's name runs.
export const mvCommand = (dir, from, to) => showCommand(['mv', path.join(dir, from), path.join(dir, to)]);

/**
 * Before a get runs (the dashboard's job): the folder it will most likely get, and its place. A project of the map in
 * a group is <place>/<name> from the first moment (by <place>/<name>, its bare name or its address); else the
 * repository's name without "-workspace" in the projects folder. The job's result says the real one.
 * → { name, place?, dir } | null (no folder name can be made)
 */
export async function guessFor(spec, { dir = projectsDir(), map = readMapQuietly() } = {}) {
  const list = (map && map.projects) || [];
  let known = null;
  try {
    known = typeof spec === 'string' && /^[A-Za-z0-9._/-]+$/.test(spec) ? pickProject(list.map((x) => ({ name: x.name, place: x.in || '', x })), spec).x : null;
  } catch {
    /* not the map's, or a bare name in two places: the job says which */
  }
  const p = parseProjectSpec(spec);
  if (!known && p && p.url) known = mapProjectFor(map, { url: p.url });
  if (known && known.in && map && map.version === 2) {
    const { placeDir } = await import('../workspace/groups.mjs');
    return { name: known.name, place: known.in, dir: path.join(placeDir(known.in, { dir: workspaceDir(), projects: dir }), known.name) };
  }
  if (known && !known.in) return { name: known.name, dir: path.join(dir, known.name) };
  // <place>/<folder> of a place with a naming rule, not in the map yet: the folder the rule gives it.
  const t = !known && map && map.version === 2 ? (await import('./getbyrule.mjs')).ruleTarget(spec, null, map) : null;
  if (t && t.folder && !t.refuse) {
    const { placeDir } = await import('../workspace/groups.mjs');
    return { name: t.folder, place: t.place, dir: path.join(placeDir(t.place, { dir: workspaceDir(), projects: dir }), t.folder) };
  }
  const name = p ? folderFromRepo(p.name) : null;
  return name ? { name, dir: path.join(dir, name) } : null;
}

export function readMapQuietly() {
  try {
    const m = readMap(workspaceDir());
    return m.map || null; // a refused map is not used here: `workspace status` says why
  } catch {
    return null;
  }
}

const isParentOnGithub = async (full, gh) => (await gh(['gh', 'api', `repos/${full}/contents/${MANIFEST}`, '--jq', '.name'], { timeout: 20_000 })).ok;

/**
 * A bare name on GitHub: "<name>-workspace" and "<name>" in each account the sign-in reaches. Where both exist the
 * project parent (it has project.json) wins; where that cannot be told, one question (none without a terminal, in
 * --json or with --yes: an error naming both). → { url, owner, repo } | { error }
 */
async function findOnGithub(name, { ui, gh, ask }) {
  const owners = await githubOwners(gh);
  if (!owners.length) return { error: 'a bare name needs the GitHub sign-in (gh auth login); or give owner/name or a Git address' };
  const tries = name.endsWith(SUFFIX) ? [name] : [`${name}${SUFFIX}`, name];
  const found = [];
  for (const o of owners) {
    for (const t of tries) {
      const v = await gh(['gh', 'repo', 'view', `${o}/${t}`, '--json', 'name'], { timeout: 20_000 });
      if (!v.ok) continue;
      // The name GitHub answers with: a repository found in another letter case, or under its name before a rename
      // (GitHub answers to both), is one repository under its real name.
      let repo = t;
      try {
        const n = JSON.parse(v.stdout).name;
        if (typeof n === 'string' && NAME_RE.test(n)) repo = n;
      } catch {
        /* the name asked for */
      }
      if (!found.some((f) => f.owner.toLowerCase() === o.toLowerCase() && f.repo.toLowerCase() === repo.toLowerCase())) found.push({ owner: o, repo });
    }
  }
  if (!found.length) return { error: `no repository "${tries.join('" or "')}" in ${owners.join(', ')}` };
  if (found.length > 1) for (const f of found) f.parent = await isParentOnGithub(`${f.owner}/${f.repo}`, gh);
  const parents = found.filter((f) => f.parent);
  const pool = parents.length ? parents : found;
  let pick = pool[0];
  const names = pool.map((f) => `${f.owner}/${f.repo}`);
  const why = `"${name}" fits ${names.length} repositories (${names.join(', ')}) and it cannot be told which one is the project`;
  // Without a question (no terminal, --json, --yes) it stops with an error that names them all: never one taken silently.
  if (pool.length > 1 && !ask) return { error: `${why}: name it, for example  hoprig get ${names[0]}`, choices: names };
  if (new Set(pool.map((f) => f.repo)).size === 1) {
    // Only the account differs: which account is asked.
    const owner = await chooseOwner(ui, pool.map((f) => f.owner));
    if (!owner) return { error: 'no account chosen' };
    pick = pool.find((f) => f.owner === owner);
  } else {
    const k = await ui.choose(`${why}. Which one?`, names.map((n, i) => ({ key: String(i + 1), label: n })), null);
    if (!k) return { error: `${why}: nothing chosen`, choices: names };
    pick = pool[Number(k) - 1];
  }
  return { url: `https://github.com/${pick.owner}/${pick.repo}.git`, owner: pick.owner, repo: pick.repo };
}

/**
 * What to clone and the folder the map gives it (when it knows it). A project of the map in a group is named
 * <place>/<name> (that wins over owner/name), or by its bare name when no other place has that name.
 * → { url, owner, repo, mapName, mapIn? } | { error, choices? }
 */
async function resolve(spec, { ui, gh, map, ask }) {
  const list = (map && map.projects) || [];
  // The one rule for a project's name (mapcheck.mjs pickProject); a spec it does not know is an address or owner/name.
  let byRule = null;
  try {
    byRule = typeof spec === 'string' && /^[A-Za-z0-9._/-]+$/.test(spec) ? pickProject(list.map((x) => ({ name: x.name, place: x.in || '', x })), spec).x : null;
  } catch (e) {
    if (e.status === 409) return { error: `${e.message.replace(/places:/, 'places of the workspace map:')}`, choices: e.choices };
  }
  if (byRule && (byRule.in || spec.startsWith(`${PROJECTS_PLACE}/`))) {
    const known = byRule;
    if (!known.url && !known.in) return { error: `${known.name} is in the workspace map but has no address yet: copy it from the computer that has it` };
    const owner = known.url ? (/github\.com[/:]([A-Za-z0-9-]+)\//.exec(known.url) || [])[1] || null : null;
    return { url: known.url, owner, repo: known.url ? repoNameOf(known.url) : known.name, mapName: known.name, mapIn: known.in };
  }
  const p = parseProjectSpec(spec);
  if (!p) return { error: `"${String(spec).slice(0, 80)}" is not a project name, owner/name or a Git address` };
  if (p.url) {
    const known = mapProjectFor(map, { url: p.url });
    return { url: p.url, owner: p.owner, repo: p.name, mapName: known ? known.name : null, ...(known && known.in ? { mapIn: known.in } : {}) };
  }
  const known = mapProjectFor(map, { name: p.name });
  if (known) {
    if (!known.url) return { error: `${known.name} is in the workspace map but has no address yet: copy it from the computer that has it` };
    const owner = (/github\.com[/:]([A-Za-z0-9-]+)\//.exec(known.url) || [])[1] || null;
    return { url: known.url, owner, repo: repoNameOf(known.url), mapName: known.name, ...(known.in ? { mapIn: known.in } : {}) };
  }
  return findOnGithub(p.name, { ui, gh, ask });
}

/**
 * The map's project called `name` in the place `place` ('' = the projects folder) under another address than `url`
 * (one without an address counts). A name is unique in its place: a namesake in another place holds nothing here.
 */
const mapHolder = (map, name, url, place = '') => ((map && map.projects) || []).find((p) => p.name === name && (p.in || '') === place && !(p.url && sameUrl(p.url, url))) || null;

/**
 * The folder of another place (a group, or the projects folder) that holds a repository with this address, as
 * { ref, dir }, or null. Only places other than the target's own; a member that comes with its group has no address.
 */
async function inOtherPlace(r, { given, map, run }) {
  const v2 = map && map.version === 2 ? map : null;
  if (!v2) return null;
  const where = await import('../workspace/where.mjs');
  for (const pl of where.placesHere({ projects: given, map: v2 })) {
    if (pl.members !== 'own' || pl.id === (r.place || '')) continue;
    const found = await findByAddress(pl.dir, r.url, run);
    if (found.length) return { ref: pl.id ? `${pl.id}/${found[0]}` : found[0], dir: path.join(pl.dir, found[0]) };
  }
  return null;
}

/**
 * The folder's name and where it came from (rules 1–3). A name in project.json is used only when it is a folder the
 * workspace looks into and the map does not use it for another repository; else the repository's name, and `note`
 * says why in one sentence. `m`: what readManifest gave for the parent (or null). → { name, from, note? }
 */
function folderFor(r, m, guess, map) {
  if (r.mapName) return { name: r.mapName, from: 'map' };
  const own = m && m.manifest && m.source === MANIFEST ? m.manifest.name : null;
  if (!own) return { name: guess, from: 'repository' };
  if (own === guess) return { name: own, from: 'project.json' };
  if (neverLook(own)) return { name: guess, from: 'repository', note: `its project.json names it ${own}, a folder name the workspace never looks into` };
  if (mapHolder(map, own, r.url, r.place)) return { name: guess, from: 'repository', note: `its project.json names it ${own}, which your map uses for another repository${r.place ? ` in ${r.place}` : ''}` };
  return { name: own, from: 'project.json' };
}

/** Dry run: the name in a GitHub repository's project.json, read without a clone (gh api). → like readManifest's, or null. */
async function peekManifest(r, gh) {
  if (!r.owner || !/github\.com[/:]/i.test(r.url)) return null;
  const c = await gh(['gh', 'api', `repos/${r.owner}/${r.repo}/contents/${MANIFEST}`, '--jq', '.content'], { timeout: 20_000 });
  if (!c.ok) return null;
  try {
    const name = JSON.parse(Buffer.from(String(c.stdout).replace(/\s+/g, ''), 'base64').toString('utf8')).name;
    return typeof name === 'string' && NAME_RE.test(name) ? { manifest: { name }, source: MANIFEST } : null;
  } catch {
    return null;
  }
}

const emptyDir = (d) => {
  try {
    return fs.readdirSync(d).length === 0;
  } catch {
    return false;
  }
};

/**
 * Get one project. `ask`: a question may be asked on the terminal. → { spec, ok, result, url?, folder?, dir?, nameFrom?,
 * note?, mv?, temp?, message?, warnings?, repos? }. result: cloned | here | misnamed | taken | failed | would clone |
 * refused | busy. nameFrom: where the folder's name came from (map | project.json | repository). `fix`: the command the
 * owner runs where it is not done and needs them (misnamed, taken). (`resolved`, `locked`: its own second call.)
 */
export async function getProject(spec, { ui, dir: given = projectsDir(), into = null, runner = stream, gh = capture, run = capture, map = readMapQuietly(), ask = ui.interactive && !ui.yes, resolved = null, locked = false, retry = null } = {}) {
  const r = resolved || (await resolve(spec, { ui, gh, map, ask }));
  if (r.error) {
    ui.line('fail', r.error);
    return { spec, ok: false, result: 'refused', message: r.error, ...(r.choices ? { choices: r.choices } : {}) };
  }
  // The folder it goes into: the place the map says, else the one asked for (--in), else the projects folder. Every
  // rule below (the name, "here under another name", leftovers and the lock) then holds inside that place.
  let dir = given;
  const placeId = r.mapIn || into;
  if (placeId && !locked) {
    const where = await import('../workspace/where.mjs');
    const pl = where.placesHere({ projects: given, map: map && map.version === 2 ? map : null }).find((x) => x.id === placeId);
    const fail = (message) => (ui.line('fail', message), { spec, ok: false, result: 'refused', message });
    if (!pl) return fail(notAPlace(placeId, map));
    if (pl.members === 'group') return getMember(spec, r, pl, { ui, runner, run, gh });
    if (!r.url) return fail(`${placeId}/${r.mapName} is in the workspace map but has no address yet: copy it from the computer that has it`);
    if (into && r.mapIn && into !== r.mapIn) return fail(`the workspace map has ${r.mapName} in ${r.mapIn}, not in ${into}`);
    dir = pl.dir;
    // Never into a place that leads out of the workspace (a group's repository that tracks builds -> …): inside.mjs.
    const link = leaves(dir, dir, { projects: given });
    if (link) return fail(`${placeId}: ${leavesWords(link)}: nothing was cloned`);
    if (!ui.dryRun) mkdirIn({ root: dir, projects: given }, dir); // a dry run makes no folder, also not the group's own
    r.placed = true; // a group's folder is never remembered as the projects folder
    // A place with a naming rule: a parent without project.json there is another tool's, and nothing is written into
    // it (getbyrule.mjs finishByRule); the map's entry says what it has.
    const { ruleOf } = await import('../workspace/findrule.mjs');
    r.rule = ruleOf(map, placeId);
    r.entry = ((map && map.projects) || []).find((x) => (x.in || '') === placeId && x.name === r.mapName) || null;
  }
  if (!locked) {
    r.place = r.placed ? placeId : '';
    r.projects = given; // the projects folder (the second, locked call gets the place's folder as its `dir`)
  }
  const inPlace = (x) => (x.in || '') === (r.place || '');
  const guess = r.mapName || folderFromRepo(r.repo);
  if (!guess) {
    const message = `the repository's name "${String(r.repo).slice(0, 80)}" does not make a folder name Hoprig can use (letters, digits, ".", "_" and "-", starting with a letter or a digit; not a private folder such as no-ai): nothing was cloned`;
    ui.line('fail', message);
    return { spec, ok: false, result: 'refused', url: r.url, message };
  }
  // `place`: the group or held folder it goes into (none for the projects folder); with it, the project's id is <place>/<name>.
  const out = { spec, url: r.url, folder: guess, dir: path.join(dir, guess), nameFrom: r.mapName ? 'map' : 'repository', ...(r.place ? { place: r.place } : {}) };
  if (ui.dryRun && !locked) {
    // A dry run takes no lock: what a real run would find there is said instead.
    const busy = sayLock(dir, r, { ui });
    if (busy) return { ...out, ok: false, result: 'busy', message: busy };
  }
  if (!ui.dryRun && !locked) {
    // One run at a time per address here (two at once would clone twice): the rest runs again inside the lock, with
    // the address already looked up.
    const lock = takeLock(dir, r, { ui, at: { projects: given } });
    if (lock.busy) return busyResult(out, guess, lock.busy, ui);
    try {
      return await getProject(spec, { ui, dir, runner, gh, run, map, ask, resolved: r, locked: true, retry });
    } finally {
      lock.release();
    }
  }
  ui.out(`\n${bold(guess)}  ${dim(r.url)}`);

  // Already here? Under its name it is finished like before (missing code repositories cloned); under another name it
  // is reported with the mv, never moved.
  // A folder that is another project of the map (in this place) under its own name is in its right place, never this
  // one's copy.
  const here = (await findByAddress(dir, r.url, run)).filter((f) => f === guess || !((map && map.projects) || []).some((x) => inPlace(x) && x.name === f));
  if (here.length) {
    // Under the repository's name too, its own project.json may name it otherwise (rule 2): then it is misnamed.
    const from = here.includes(guess) ? guess : here[0];
    const pick = folderFor(r, await readManifest(path.join(dir, from), run), guess, map);
    const own = pick.name;
    const named = { nameFrom: pick.from, ...(pick.note ? { note: pick.note } : {}) };
    if (pick.note) ui.line('warn', pick.note);
    if (here.includes(own)) return finishHere({ ...out, ...named, folder: own, dir: path.join(dir, own) }, r, { ui, dir, runner, run, gh });
    const mv = mvCommand(dir, from, own);
    const message = `it is here already, as ${from}; its folder should be ${own}. Hoprig moves nothing by itself: ${mv}`;
    ui.line('warn', message);
    // Not done: it needs the owner (ok false, the mv as `fix`), here and in the dashboard and first run alike.
    return { ...out, ...named, folder: own, dir: path.join(dir, own), ok: false, result: 'misnamed', here: path.join(dir, from), mv, fix: mv, message };
  }
  // One project, one place: here already in another place (a group, or the projects folder) is reported with the mv.
  const elsewhere = await inOtherPlace(r, { given: r.projects || given, map, run });
  if (elsewhere) {
    const mv = showCommand(['mv', elsewhere.dir, path.join(dir, guess)]); // quoted for a POSIX shell, as every printed line
    const message = `it is here already, as ${elsewhere.ref}; the map puts it in ${r.place || 'the projects folder'} as ${guess}. Hoprig moves nothing by itself: ${mv}`;
    ui.line('warn', message);
    return { ...out, ok: false, result: 'misnamed', here: elsewhere.dir, mv, fix: mv, message };
  }
  const target = path.join(dir, guess);
  if (r.mapName && fs.existsSync(target) && !emptyDir(target)) {
    // Someone else's folder: it needs the owner (a `fix`, never "done"), and what is in the way is named with its address.
    const o = fs.existsSync(path.join(target, '.git')) ? await gitRead(target, ['config', '--get', 'remote.origin.url'], { run, timeout: 10_000 }) : { ok: false };
    const theirs = o.ok && o.stdout.trim() ? cleanRemote(o.stdout.trim()) : null;
    const fix = mvCommand(dir, guess, `${guess}.aside-${stamp()}`);
    const message = `${target} is in the way: it is ${theirs ? `a clone of ${theirs}` : 'a folder that is not a clone of this project'}, not of ${r.url}. Nothing was cloned and nothing was moved: look at it, move it aside, then run this again; for example  ${fix}`;
    ui.line('fail', message);
    return { ...out, ok: false, result: 'taken', fix, message };
  }
  if (ui.dryRun) {
    await sayLeftover(dir, r, tempNameFor(r), { ui, run });
    const peek = r.mapName ? null : await peekManifest(r, gh);
    const pick = folderFor(r, peek, guess, map);
    const into = path.join(dir, pick.name);
    const why = { map: 'the name your workspace map gives it', 'project.json': 'the name its project.json gives', repository: peek ? 'the repository\'s name' : 'the repository\'s name, or the name its project.json gives' }[pick.from];
    if (pick.note) ui.line('warn', pick.note);
    const message = r.rule && !peek
      ? `(dry run) would clone ${r.url} into ${into} (${why}), then its code repositories${r.entry && r.entry.repos.length ? ` (${r.entry.repos.map((x) => x.dir).join(', ')})` : ''}, make ${r.rule.make.map((d) => `${d}/`).join(' and ')}, and link its memory; nothing is written into it (it has no project.json)`
      : `(dry run) would clone ${r.url} into ${into} (${why}), then its code repositories, and set it up: its memory link, git hooks, a .env from each .env.example, and the dependency installs, asked`;
    ui.note(message);
    return { ...out, folder: pick.name, dir: into, nameFrom: pick.from, ...(pick.note ? { note: pick.note } : {}), ok: true, result: 'would clone', message };
  }

  // The clone, under a temporary name in the same folder (a dot-folder: no project list or map picks it up), unless an
  // earlier run left a complete one.
  const tempName = tempNameFor(r);
  const temp = path.join(dir, tempName);
  // Asked again right before the clone writes (the look above may be a moment old), and by the clone itself.
  const at = { projects: r.projects || given };
  const link = leaves(dir, dir, at);
  if (link) {
    const message = `${r.place || dir}: ${leavesWords(link)}: nothing was cloned`;
    ui.line('fail', message);
    return { ...out, ok: false, result: 'refused', message };
  }
  const c = (await useLeftover(dir, r, tempName, { ui, run, at })) ? { ok: true } : await cloneRepo({ url: r.url, name: tempName }, dir, { onLine: (l) => ui.note(l), run: runner, root: temp, at });
  if (!c.ok) {
    if (!c.leaves) removeIn({ ...at, root: dir }, temp, { recursive: true });
    const message = `clone failed — retry: ${retry || showCommand(['git', 'clone', r.url, target])}`;
    ui.line('fail', message);
    return { ...out, ok: false, result: 'failed', message };
  }
  const m = await readManifest(temp, run);
  const pick = folderFor(r, m, guess, map);
  const final = pick.name;
  const named = { nameFrom: pick.from, ...(pick.note ? { note: pick.note } : {}) };
  if (pick.note) ui.line('warn', pick.note);
  const root = path.join(dir, final);
  const holder = r.mapName ? null : mapHolder(map, final, r.url, r.place);
  if (holder) {
    // Never into the folder of another project of the map: the map would then be rewritten to this address.
    const fix = mvCommand(dir, tempName, `${final}-${r.owner || 'other'}`);
    const message = `your workspace map uses ${final} for another repository (${holder.url || 'one not on a git server yet'}), so the clone was left in ${temp}. Nothing was changed: give it a folder of its own, for example  ${fix}`;
    ui.line('fail', message);
    return { ...out, ...named, folder: final, dir: root, ok: false, result: 'taken', temp, fix, message };
  }
  // What is at the final name itself, not where a link there points: a link (also one to an empty folder or to
  // nothing) is someone's and stays. Only a real empty folder makes way. Whatever comes there between this look and
  // the rename makes the rename fail: then it is taken too, and nothing was overwritten.
  let there = null;
  try {
    there = fs.lstatSync(root);
  } catch {
    /* nothing there */
  }
  if (there && there.isDirectory() && !there.isSymbolicLink() && emptyDir(root)) {
    try {
      if (rmdirIn({ ...at, root: dir }, root)) there = null;
    } catch {
      /* still there: taken */
    }
  }
  let placed = false;
  if (!there) {
    try {
      renameIn({ ...at, root: dir }, temp, root);
      placed = true;
    } catch {
      /* it came there in between: taken */
    }
  }
  if (!placed) {
    const fix = mvCommand(dir, tempName, final);
    const message = `${root} is taken by another folder, so the clone was left in ${temp}. Nothing was overwritten: look at both, move one aside, then  ${fix}`;
    ui.line('fail', message);
    return { ...out, ...named, folder: final, dir: root, ok: false, result: 'taken', temp, fix, message };
  }
  return finishClone({ ...out, ...named, folder: final, dir: root }, r, m, { ui, dir, runner, run, gh, at });
}

/** Another run holds the lock: said with how to remove a lock its run left. */
function busyResult(out, name, { pid, file }, ui) {
  const message = `${name} is being fetched by another run of Hoprig right now${pid ? ` (process ${pid})` : ''}: wait for it to finish, then run this again. If no hoprig get is running, removing its lock is safe:  ${showCommand(['rm', file])}`;
  ui.line('fail', message);
  return { ...out, ok: false, result: 'busy', message };
}

/**
 * A member that comes with its group's repository: its folder is the group's, so only its code repositories are
 * cloned (and its memory linked) once the group is here. One run at a time, as every get: two at once would clone
 * its code repositories into the same folders. It has no address, so its lock is keyed by <place>/<name>.
 */
async function getMember(spec, r, pl, { ui, runner, run, gh }) {
  const root = path.join(pl.dir, r.mapName);
  const out = { spec, url: null, folder: r.mapName, dir: root, place: pl.id };
  if (!fs.existsSync(root)) {
    const message = `${pl.id}/${r.mapName} comes with the group's repository ${pl.group}: get the group first (hoprig workspace restore gets it), then run this again`;
    ui.line('fail', message);
    return { ...out, ok: false, result: 'refused', message };
  }
  const key = { member: `${pl.id}/${r.mapName}` };
  if (ui.dryRun) {
    const busy = sayLock(pl.dir, key, { ui });
    return busy ? { ...out, ok: false, result: 'busy', message: busy } : memberHere(r, pl, out, { ui, runner, run, gh });
  }
  const lock = takeLock(pl.dir, key, { ui });
  if (lock.busy) return busyResult(out, `${pl.id}/${r.mapName}`, lock.busy, ui);
  try {
    return await memberHere(r, pl, out, { ui, runner, run, gh });
  } finally {
    lock.release();
  }
}

async function memberHere(r, pl, out, { ui, runner, run, gh }) {
  const root = out.dir;
  ui.out(`\n${bold(`${pl.id}/${r.mapName}`)}  ${dim(`in the group ${pl.group}`)}`);
  // The member's folder itself, or the held folder, that leads out of the workspace: never followed (inside.mjs).
  const link = leaves(root, root);
  if (link) {
    const message = `${pl.id}/${r.mapName}: ${leavesWords(link)}`;
    ui.line('fail', message);
    return { ...out, ok: false, result: 'refused', message };
  }
  return finishClone(out, { ...r, owner: null }, await readManifest(root, run), { ui, dir: pl.dir, runner, run, gh, was: true, member: `${pl.id}/${r.mapName}` });
}

async function finishHere(out, r, opts) {
  opts.ui.line('ok', `${out.folder}: was already here`);
  return finishClone(out, r, await readManifest(out.dir, opts.run), { ...opts, was: true });
}

/**
 * After the parent is in its folder: its code repositories, memory links, hooks, installs; the map kept in step.
 * `was`: the project was here before this run. Then only what is missing is added (a code repository not cloned yet,
 * set up like a fresh clone); nothing in what was there is changed: finish.mjs says what a fresh clone would have set
 * up there and the command that does it. With ui.dryRun (only `was` reaches here then) nothing at all is done.
 * `member`: <place>/<name> of a member that comes with its group's repository (its memory is its own, else the group's).
 */
async function finishClone(out, r, m, { ui, dir, runner, run, gh, was = false, member = null, at = {} }) {
  const root = out.dir;
  if (!m.manifest) {
    const message = `project.json was refused: ${m.errors.join('; ')}`;
    ui.line('fail', message);
    return { ...out, ok: false, result: 'failed', message };
  }
  for (const w of m.warnings || []) ui.line('warn', `project.json: ${w}`);
  // A parent without project.json in a place with a naming rule: another tool's project, nothing written into it.
  if (r.rule && m.source !== MANIFEST && !member) return (await import('./getbyrule.mjs')).finishByRule(out, r, m, { ui, dir, runner, run, was, at });
  let { manifest } = m;
  // Read from the folder without a project.json, the name was the folder's: during a clone, the temporary one.
  if (m.source !== MANIFEST) manifest = { ...manifest, name: out.folder };
  if (m.source !== MANIFEST && r.owner && !manifest.repos.length) {
    // The account's repositories named "<project>-…" (and "<project>" when the parent is not that one): never the
    // parent itself, which fits the pattern when it is "<project>-workspace".
    const cands = await childCandidates(r.owner, out.folder, gh, { parent: r.repo });
    if (cands.length && was) {
      // Its parent was here before: no project.json is written into it by a get.
      ui.line('info', `${out.folder} has no project.json; its account has ${cands.map((k) => k.name).join(', ')}, which fit its name. Nothing was written or cloned: list them in its project.json (dir and url each), then run hoprig get ${r.place ? `${r.place}/${out.folder}` : out.folder} again`);
    } else if (cands.length) {
      ui.out(`  Found ${cands.length} code repositor${cands.length > 1 ? 'ies' : 'y'} of ${out.folder}:`);
      for (const k of cands) ui.out(`    ${k.name}`);
      const keep = ui.yes || !ui.interactive ? cands : (await ui.confirm('Clone all of them into code/?', true)) ? cands : [];
      manifest = { ...manifest, repos: keep.map((k) => ({ dir: `code/${k.name}`, url: k.url })) };
      let wrote = false;
      try {
        writeManifest(root, manifest, at); // never through a link at project.json (inside.mjs writeIn)
        wrote = true;
        ui.line('ok', 'wrote project.json');
      } catch (e) {
        ui.line('warn', `project.json was not written: ${e.message}`);
      }
      if (wrote && (await ui.confirm('Commit project.json?', true))) {
        // A new file: added first (that one file only), else the commit has nothing to take.
        await gitIn({ ...at, root }, root, ['add', '--', MANIFEST], capture);
        const c = await gitIn({ ...at, root }, root, ['commit', '-q', '-m', 'Add project.json', '--', MANIFEST], capture);
        ui.line(c.ok ? 'ok' : 'warn', c.ok ? 'committed project.json' : `project.json was not committed: ${(c.stderr || c.stdout || '').trim().split('\n').pop()}`);
      }
    }
  }
  const repos = [];
  const made = new Set(); // the code repositories this run cloned: set up like a fresh clone
  for (const x of manifest.repos) {
    const dest = path.join(root, x.dir);
    if (!path.resolve(dest).startsWith(root + path.sep)) continue;
    // Never where it leads out of the project (inside.mjs), checked again by the clone itself.
    const link = leaves(root, dest, at);
    if (link) {
      repos.push({ dir: x.dir, result: 'skipped' });
      ui.line('warn', `${x.dir}: not cloned: ${leavesWords(link)}`);
      continue;
    }
    if (ui.dryRun) {
      const there = fs.existsSync(dest) && !emptyDir(dest);
      repos.push({ dir: x.dir, result: there ? 'here' : 'would clone' });
      ui.line(there ? 'ok' : 'info', there ? `${x.dir} (was already there)` : `(dry run) would clone ${x.url} into ${dest}, and set it up like a fresh clone`);
      continue;
    }
    const cr = await cloneRepo({ url: x.url, name: path.basename(dest) }, path.dirname(dest), { onLine: (l) => ui.note(l), run: runner, root, at });
    if (!cr.ok) {
      repos.push({ dir: x.dir, result: 'failed' });
      ui.line('fail', `${x.dir}: clone failed — retry: ${showCommand(['git', 'clone', x.url, dest])}`);
      continue;
    }
    if (x.branch && !cr.skipped) await gitIn({ ...at, root }, dest, ['checkout', '-q', '--no-overwrite-ignore', x.branch]);
    if (!cr.skipped) made.add(dest);
    repos.push({ dir: x.dir, result: cr.skipped ? 'here' : 'cloned' });
    ui.line('ok', `${x.dir}${cr.skipped ? ' (was already there)' : ''}`);
  }
  const ref = member || (r.place ? `${r.place}/${out.folder}` : out.folder);
  // In a group the memory is the project's own, else the group's (groups.mjs).
  await finishProject(root, manifest, { ui, dir, runner, fresh: was ? made : true, ref, ...(member || r.place ? { memories: await groupPlan(ref) } : {}) });
  if (!member && !r.placed) {
    if (!ui.dryRun) rememberDir(dir);
    else if (wouldRemember(dir)) ui.note(`(dry run) would remember ${dir} as the projects folder`);
  }
  await mapNote(ui, `${was ? 'got' : 'cloned'} ${out.folder}`);
  const failed = repos.filter((x) => x.result === 'failed').length;
  if (!was) ui.line('ok', `${out.folder} is in ${root}`);
  return { ...out, ok: !failed, result: was ? 'here' : 'cloned', repos, ...(m.warnings ? { warnings: m.warnings } : {}) };
}

/** The refusal for a place the map does not have, with the hint a map of version 1 needs. */
export const notAPlace = (id, map) => `"${String(id).slice(0, 100)}" is not a group or a held folder of the workspace map${map && map.version !== 2 ? ' (groups need a map of version 2:  hoprig workspace map --upgrade)' : ''}`;

export const GET_USAGE = 'usage: hoprig get <name | place/name | owner/name | git address>… [--in <group>] [--json] [--dry-run] [--yes]\n       (a place with a naming rule: hoprig get <word> --in <place> looks the hosting site up for it)';

/**
 * `hoprig get a b …` and `hoprig project clone …`: each project in turn. With --json the messages go to the error
 * output and one JSON object to the output: { ok, projectsDir, projects: [result] }. Exit 1 when one failed.
 */
export async function getMain(args, { ui, write = (s) => process.stdout.write(s), dir = projectsDir(), gh, run, runner } = {}) {
  const o = flags(args, { json: 'bool', 'dry-run': 'bool', yes: 'bool', in: 'v' });
  if (o.errors.length || !o._.length) {
    (o.json ? process.stderr.write.bind(process.stderr) : write)(`${o.errors.length ? `${o.errors.join('; ')}\n` : ''}${GET_USAGE}\n`);
    return 2;
  }
  const u = o.json ? makeUi({ interactive: false, write: (s) => process.stderr.write(s) }) : ui;
  if (o.yes) u.yes = true;
  if (o['dry-run']) u.dryRun = true;
  const results = [];
  const into = o.in ? (await import('../workspace/mapcheck.mjs')).tidyFolder(o.in) : null; // typed: the map's one way
  const byRule = await import('./getbyrule.mjs');
  const ask = !o.json && u.interactive && !u.yes && !u.dryRun;
  const opts = { ui: u, dir, into, ...(gh ? { gh } : {}), ...(run ? { run } : {}), ...(runner ? { runner } : {}) };
  // The place is checked before any look-up on the hosting site.
  if (into) {
    const map = readMapQuietly();
    const where = await import('../workspace/where.mjs');
    if (!where.placesHere({ projects: dir, map: map && map.version === 2 ? map : null }).some((x) => x.id === into)) {
      const message = notAPlace(into, map);
      u.line('fail', message);
      if (o.json) write(JSON.stringify({ ok: false, dryRun: !!o['dry-run'], projectsDir: dir, projects: o._.map((spec) => ({ spec, ok: false, result: 'refused', message })) }, null, 2) + '\n');
      return 1;
    }
  }
  for (const spec of o._) {
    // A word for a place's naming rule, a project the map does not know yet: looked up on the hosting site first.
    const map = readMapQuietly();
    const t = byRule.ruleTarget(spec, into, map);
    results.push(t ? await byRule.getByRule(spec, t, { ...opts, map, ask, getProject }) : await getProject(spec, { ...opts, ask: !o.json && u.interactive && !u.yes }));
  }
  const ok = results.every((r) => r.ok);
  if (o.json) write(JSON.stringify({ ok, dryRun: !!o['dry-run'], projectsDir: dir, projects: results }, null, 2) + '\n');
  return ok ? 0 : 1;
}
