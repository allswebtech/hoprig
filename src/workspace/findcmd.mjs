// `hoprig workspace find --in <place>`: what the hosting site has that fits a place's naming rule (findrule.mjs) and
// the map has not. The map is the union of what the owner's computers have seen; a project that is only on the
// hosting site gets into it here, without being cloned:
//
//   workspace find --in <place> [--json]                          list: the projects that fit, and what does not fit
//   workspace find --in <place> --add [--dry-run] [--json]        write the projects that fit into the map (no clone)
//   workspace find --in <place> --place-it <repository> <folder>  record one repository that does not fit, under
//                                                                 the folder the owner names (no clone)
//
// The look-up asks `gh` for the repositories of the signed-in account and its organisations. Nothing is guessed: a
// name that does not fit exactly is listed with why, and only the owner says where it goes.
import { NAME_RE, githubOwners } from '../pcsetup/workspace.mjs';
import { flags } from '../pcsetup/project.mjs';
import { capture } from '../setup/system.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { placesOf } from './groups.mjs';
import { projectsIn, workspaceDir } from './layout.mjs';
import { readMap, refOf, sameUrl, urlKey, writeMap } from './map.mjs';
import { neverLook, tidyFolder } from './mapcheck.mjs';
import { codeFit, folderWords, ruleOf, sortRepos } from './findrule.mjs';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const full = (r) => `${r.owner}/${r.name}`;

/** The map (version 2) and the rule of a place in it. Throws { status } with what to do. */
export function placeRule(placeTyped, { dir = workspaceDir(), projects = projectsIn(), map = null } = {}) {
  let m = map;
  if (!m) {
    const cur = readMap(dir);
    if (cur.errors) throw fail(409, `the workspace map was refused: ${cur.errors.join('; ')}`);
    if (!cur.exists) throw fail(404, 'there is no workspace map yet: hoprig workspace map makes one');
    m = cur.map;
  }
  const place = typeof placeTyped === 'string' ? tidyFolder(placeTyped) : '';
  if (!place) throw fail(400, 'say the place: --in <group> or --in <group>/<held folder>');
  const pl = m.version === 2 ? placesOf(m, { dir, projects }).find((x) => x.id === place) : null;
  if (!pl) throw fail(404, `"${place.slice(0, 100)}" is not a group or a held folder of the workspace map`);
  const rule = ruleOf(m, place);
  if (!rule) throw fail(400, `${place} has no naming rule ("find" in the map): its projects are fetched by their address or owner/name`);
  return { map: m, place, rule, placeDir: pl.dir };
}

/**
 * Every repository the sign-in reaches: { owners: [listed], repos: [{ owner, name, url }], unlisted: [{ owner, why }] }.
 * Each account is listed on its own: one GitHub does not list (an organisation with single sign-on the gh sign-in is
 * not allowed for) is named in `unlisted` and the rest is used. Throws when there is no sign-in or no account lists.
 */
export async function siteRepos(gh = capture) {
  const all = await githubOwners(gh);
  if (!all.length) throw fail(401, 'the look-up needs the GitHub sign-in (gh auth login)');
  const out = [];
  const owners = [];
  const unlisted = [];
  for (const owner of all) {
    const r = await gh(['gh', 'repo', 'list', owner, '--json', 'name,id', '--limit', '5000'], { timeout: 120_000 });
    if (!r.ok) {
      unlisted.push({ owner, why: `GitHub did not list the repositories of ${owner}: ${String(r.stderr || r.stdout || '').trim().split('\n').pop() || 'gh failed'}` });
      continue;
    }
    let list = [];
    try {
      list = JSON.parse(r.stdout);
    } catch {
      unlisted.push({ owner, why: `GitHub's list of ${owner} could not be read` });
      continue;
    }
    owners.push(owner);
    for (const x of Array.isArray(list) ? list : []) {
      if (x && typeof x.name === 'string' && NAME_RE.test(x.name)) out.push({ owner, name: x.name, url: `https://github.com/${owner}/${x.name}.git`, ...(typeof x.id === 'string' && x.id ? { id: x.id } : {}) });
    }
  }
  if (!owners.length) throw fail(502, unlisted.map((u) => u.why).join('; '));
  return { owners, repos: out, ...(unlisted.length ? { unlisted } : {}) };
}

/** Where the map has this address already (an entry, a code repository of one, a group): its label, or null. */
export function heldAt(map, url) {
  for (const e of (map && map.projects) || []) {
    if (e.url && sameUrl(e.url, url)) return refOf(e);
    const r = (e.repos || []).find((x) => x.url && sameUrl(x.url, url));
    if (r) return `${refOf(e)}/${r.dir}`;
  }
  const g = ((map && map.groups) || []).find((x) => x.url && sameUrl(x.url, url));
  return g ? g.dir : null;
}

/**
 * A found project as the map keeps it (no clone made): its folder, the parent's address, its code repositories. One
 * address is in the map once: a code repository the map has already (under another project) is left out, and named
 * in `left` when the caller gives one.
 */
export const entryOf = (p, place, map = null, left = null) => ({
  name: p.folder,
  in: place,
  url: p.parent.url,
  repos: p.code.filter((c) => {
    const at = map && heldAt(map, c.url);
    if (at && left) left.push({ repo: full(c), why: `its address is in the map already, as ${at}: one repository is in the map once` });
    return !at;
  }).map((c) => ({ dir: `code/${c.name}`, url: c.url })),
});

/** One found project for a person or a program to read. */
const shown = (p, place, inMap) => ({
  folder: p.folder,
  ref: `${place}/${p.folder}`,
  parent: full(p.parent),
  url: p.parent.url,
  code: p.code.map((c) => ({ name: c.name, url: c.url })),
  skipped: p.skipped.map((c) => ({ name: c.name, word: c.word })),
  ...(inMap ? { inMap } : {}),
});

/**
 * What the hosting site has for a place: { place, rule, owners, found (not in the map), inMap (refs), misfits }.
 * `site`: the repositories when the caller has them (a test, or `hoprig get`).
 */
export async function findInPlace(placeTyped, { dir = workspaceDir(), projects = projectsIn(), map = null, gh = capture, site = null } = {}) {
  const { map: m, place, rule } = placeRule(placeTyped, { dir, projects, map });
  const { owners, repos, unlisted } = site || (await siteRepos(gh));
  const s = sortRepos(rule, repos);
  const renamed = await renamedEntries(m, place, repos, gh);
  // In the map already: by its address, by the address it had before a rename on the hosting site, or by its folder
  // in this place whatever the letter case.
  const holder = (p) => m.projects.find((x) => (x.url && sameUrl(x.url, p.parent.url)) || ((x.in || '') === place && x.name.toLowerCase() === p.folder.toLowerCase())) || renamed.get(urlKey(p.parent.url)) || null;
  const found = [];
  const inMap = [];
  for (const p of s.projects) {
    const h = holder(p);
    if (h) inMap.push(refOf(h));
    else found.push(shown(p, place, null));
  }
  // A repository the owner placed once (--place-it) is in the map: it is not asked about again.
  const misfits = s.misfits.filter((x) => !m.projects.some((e) => e.url && sameUrl(e.url, x.repo.url)) && !renamed.has(urlKey(x.repo.url))).map((x) => ({ repo: full(x.repo), url: x.repo.url, why: x.why, ...(x.project ? { project: `${place}/${x.project}` } : {}) }));
  return { place, rule: rule.raw, owners, found, inMap, misfits, projects: s.projects, map: m, ...(unlisted ? { unlisted } : {}) };
}

/**
 * The map's entries of this place whose repository the hosting site lists under another name now (renamed there):
 * Map key of the listed address → the entry. GitHub answers to the old name with the new one (and its own id, which
 * is compared too when the list gives it). Only an entry whose address is not in the list is asked about.
 */
async function renamedEntries(map, place, repos, gh) {
  const out = new Map();
  const listed = new Map(repos.map((r) => [urlKey(r.url), r]));
  for (const e of map.projects.filter((x) => (x.in || '') === place && x.url && !listed.has(urlKey(x.url)))) {
    const m = /github\.com[/:]([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(e.url);
    if (!m) continue;
    const v = await gh(['gh', 'repo', 'view', `${m[1]}/${m[2]}`, '--json', 'name,id'], { timeout: 20_000 });
    if (!v.ok) continue;
    let now;
    try {
      now = JSON.parse(v.stdout);
    } catch {
      continue;
    }
    if (!now || typeof now.name !== 'string') continue;
    const hit = repos.find((r) => r.owner.toLowerCase() === m[1].toLowerCase() && (now.id && r.id ? r.id === now.id : r.name.toLowerCase() === now.name.toLowerCase()));
    if (hit) out.set(urlKey(hit.url), e);
  }
  return out;
}

/** Write found projects into the map, nothing cloned. → { added: [ref], dryRun } */
export async function addFound(placeTyped, { dir = workspaceDir(), projects = projectsIn(), gh = capture, dryRun = false, site = null } = {}) {
  const f = await findInPlace(placeTyped, { dir, projects, gh, site });
  const fresh = f.projects.filter((p) => f.found.some((x) => x.folder === p.folder && x.url === p.parent.url));
  // Two parents that would make one folder: neither is guessed into it.
  const twice = fresh.filter((p) => fresh.filter((q) => q.folder.toLowerCase() === p.folder.toLowerCase()).length > 1);
  const add = fresh.filter((p) => !twice.includes(p));
  const notAdded = twice.map((p) => ({ repo: full(p.parent), why: `another parent makes the same folder ${p.folder}` }));
  const entries = add.map((p) => entryOf(p, f.place, f.map, notAdded));
  if (!dryRun && add.length) writeMap({ ...f.map, projects: [...f.map.projects, ...entries] }, dir);
  return { place: f.place, added: add.map((p) => `${f.place}/${p.folder}`), ...(notAdded.length ? { notAdded } : {}), misfits: f.misfits, dryRun, ...(f.unlisted ? { unlisted: f.unlisted } : {}) };
}

/**
 * Record one repository under the folder the owner names (no clone). Its code repositories are the ones the rule
 * gives for that folder's words, in the repository's account, when the folder fits the rule's folder pattern.
 * → { place, entry, dryRun }
 */
export async function placeIt(placeTyped, repoSpec, folder, { dir = workspaceDir(), projects = projectsIn(), gh = capture, dryRun = false, site = null } = {}) {
  const { map, place, rule } = placeRule(placeTyped, { dir, projects });
  if (typeof folder !== 'string' || !NAME_RE.test(folder) || neverLook(folder)) throw fail(400, 'name the folder: one plain folder name (letters, digits, ".", "_" and "-")');
  if (map.projects.some((x) => (x.in || '') === place && x.name.toLowerCase() === folder.toLowerCase())) throw fail(409, `${place}/${folder} is in the map already`);
  const { repos, unlisted } = site || (await siteRepos(gh));
  const spec = String(repoSpec || '');
  const hits = repos.filter((r) => (spec.includes('/') ? full(r).toLowerCase() === spec.toLowerCase() : r.name.toLowerCase() === spec.toLowerCase()));
  const named = spec.includes('/') && (unlisted || []).find((u) => u.owner.toLowerCase() === spec.split('/')[0].toLowerCase());
  if (!hits.length && named) throw fail(502, named.why);
  if (!hits.length) throw fail(404, `no repository "${spec.slice(0, 100)}" in the accounts the sign-in reaches${unlisted ? ` (not looked at: ${unlisted.map((u) => u.owner).join(', ')})` : ''}`);
  if (hits.length > 1) throw fail(409, `"${spec}" is in ${hits.length} accounts: say which one (${hits.map(full).join(', ')})`, { choices: hits.map(full) });
  const repo = hits[0];
  // One address is in the map once: a repository the map has already (in this place or another) is never placed again.
  const had = map.projects.find((e) => e.url && sameUrl(e.url, repo.url)) || (map.groups || []).find((g) => g.url && sameUrl(g.url, repo.url));
  if (had) throw fail(409, `${full(repo)} is in the map already, as ${had.name ? refOf(had) : had.dir}: one repository is in the map once`);
  const words = folderWords(rule, folder);
  const code = words ? repos.filter((r) => r.owner === repo.owner && r !== repo && codeFit(rule, words, r.name).fits && !codeFit(rule, words, r.name).skipped && !heldAt(map, r.url)) : [];
  const entry = { name: folder, in: place, url: repo.url, repos: code.map((c) => ({ dir: `code/${c.name}`, url: c.url })) };
  if (!dryRun) writeMap({ ...map, projects: [...map.projects, entry] }, dir);
  return { place, entry, dryRun };
}

export const FIND_USAGE = `  hoprig workspace find --in <place> [--json]  what the hosting site has that fits the place's naming rule and
                                               the map has not, and what does not fit
  hoprig workspace find --in <place> --add [--dry-run] [--json]
                                               write those projects into the map (nothing is cloned)
  hoprig workspace find --in <place> --place-it <repository> <folder> [--dry-run] [--json]
                                               record one repository that does not fit under the folder you name`;

/** `hoprig workspace find …`. → exit code */
export async function findMain(args, { ui, write, usage, gh = capture }) {
  const o = flags(args, { in: 'v', add: 'bool', 'place-it': 'v', 'dry-run': 'bool', json: 'bool' });
  if (o.errors.length || !o.in || (o['place-it'] ? o._.length !== 1 || o.add : o._.length)) return usage();
  const json = (v) => (write(JSON.stringify(v, null, 2) + '\n'), 0);
  try {
    if (o['place-it']) {
      const r = await placeIt(o.in, o['place-it'], o._[0], { gh, dryRun: o['dry-run'] });
      if (o.json) return json(r);
      ui.line('ok', `${r.dryRun ? 'would record' : 'recorded'} ${r.entry.url} as ${r.place}/${r.entry.name}${r.entry.repos.length ? `, with ${r.entry.repos.map((x) => x.dir.slice(5)).join(', ')}` : ''}${r.dryRun ? '' : ': commit the brain to share it; hoprig get fetches it'}`);
      return 0;
    }
    if (o.add) {
      const r = await addFound(o.in, { gh, dryRun: o['dry-run'] });
      if (o.json) return json(r);
      for (const u of r.unlisted || []) ui.line('warn', `${u.why}: its repositories were not looked at`);
      for (const a of r.added) ui.line('ok', `${r.dryRun ? 'would add' : 'added'} to the map: ${a}`);
      for (const n of r.notAdded || []) ui.line('warn', `${n.repo}: not added: ${n.why}`);
      if (!r.added.length) ui.line('ok', 'nothing to add: the map has every project that fits');
      else if (!r.dryRun) ui.note('nothing was cloned: commit the brain to share the map; hoprig get <name> fetches one');
      if (r.misfits.length) ui.note(`${r.misfits.length} repositor${r.misfits.length === 1 ? 'y does' : 'ies do'} not fit: hoprig workspace find --in ${r.place} lists them`);
      return 0;
    }
    const f = await findInPlace(o.in, { gh });
    if (o.json) return json({ place: f.place, rule: f.rule, owners: f.owners, found: f.found, inMap: f.inMap, misfits: f.misfits, ...(f.unlisted ? { unlisted: f.unlisted } : {}) });
    ui.out(`\n${bold(f.place)}  ${dim(`${f.rule.parent} in ${f.owners.join(', ')}`)}`);
    for (const u of f.unlisted || []) ui.line('warn', `${u.why}: its repositories were not looked at`);
    for (const p of f.found) ui.line('info', `${p.folder}  ${dim(p.parent)}${p.code.length ? `  code: ${p.code.map((c) => c.name).join(', ')}` : ''}${p.skipped.length ? dim(`  left out: ${p.skipped.map((c) => `${c.name} (${c.word})`).join(', ')}`) : ''}`);
    if (!f.found.length) ui.line('ok', 'the map has every project that fits');
    else ui.note(`not in the map yet: hoprig workspace find --in ${f.place} --add writes ${f.found.length === 1 ? 'it' : 'them'} (nothing is cloned); hoprig get <word> --in ${f.place} fetches one`);
    if (f.inMap.length) ui.note(`in the map already: ${f.inMap.join(', ')}`);
    if (f.misfits.length) ui.out(`\n${bold('Does not fit')}  ${dim(`never guessed: hoprig workspace find --in ${f.place} --place-it <repository> <folder> records one`)}`);
    for (const x of f.misfits) ui.line('warn', `${x.repo}  ${x.why}`);
    return 0;
  } catch (e) {
    if (o.json) {
      write(JSON.stringify({ ok: false, error: e.message, ...(e.choices ? { choices: e.choices } : {}) }, null, 2) + '\n');
      return 1;
    }
    ui.line('fail', e.message);
    return 1;
  }
}
