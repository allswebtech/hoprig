// `hoprig get <word> --in <place>` (and `hoprig get <place>/<folder>`) where the place has a naming rule
// (workspace/findrule.mjs) and the map does not know the project yet: the hosting site is looked up for a parent that
// fits the rule with that word as one of its words; what was found is shown (the parent, its code repositories, the
// folder it gets); after ONE yes (the choice, where several fit) its entry is written into the map and the usual get fetches it (getproject.mjs: the
// lock, the temporary clone, "here under another name"). Without a question (--json, no terminal, --dry-run, --yes)
// one fit goes on and several are an error that names them all.
//
// A parent without project.json in such a place is another tool's: Hoprig writes NOTHING into it (no project.json,
// no ignore line, no renamed file, no hooks setting, no .env). What it has to know is in the map's entry. finishByRule
// fetches its code repositories, makes the folders the rule names, and links its memory (outside the project).
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture, showCommand, stream } from '../setup/system.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { gitIn, leaves, leavesWords, mkdirIn } from '../workspace/inside.mjs';
import { pickProject, refOf, sameUrl } from '../workspace/mapcheck.mjs';
import { folderOf, folderWords, parentWords, ruleOf, wordFits } from '../workspace/findrule.mjs';
import { NAME_RE, parseProjectSpec } from './workspace.mjs';
import { cloneRepo } from './projects.mjs';

/**
 * Is this get one for the naming rule? → { place, rule, word?, folder?, repo? } | { place, refuse } | null. Only when
 * the map (version 2) does not know the project in that place: a project of the map is fetched as every other. In a
 * place with a rule, an owner/name, a git address or a bare repository name is followed by the rule when its name
 * fits the rule's parent (`repo`: that repository), else refused plainly (`refuse`): a project there gets the rule's
 * folder and code repositories, never a folder named after its repository.
 */
export function ruleTarget(spec, into, map) {
  if (!map || map.version !== 2 || typeof spec !== 'string') return null;
  const known = (ref) => {
    try {
      pickProject(map.projects.map((x) => ({ name: x.name, place: x.in || '' })), ref);
      return true;
    } catch {
      return false;
    }
  };
  if (into) {
    const rule = ruleOf(map, into);
    if (!rule) return null;
    const p = NAME_RE.test(spec) && !spec.includes('/') ? null : parseProjectSpec(spec);
    if (p) {
      // owner/name or a git address: the repository itself, when it is a parent of this rule.
      if (map.projects.some((x) => x.url && p.url && sameUrl(x.url, p.url))) return null; // the map's: fetched as every other
      // The look-up is GitHub's: an address on another host is never matched to a GitHub repository of the same name.
      if (p.url && hostOf(p.url) !== 'github.com') return { place: into, refuse: `${spec} is not on GitHub, and a place with a naming rule looks its projects up on GitHub: nothing was fetched (hoprig get ${spec} fetches it into the projects folder)` };
      const words = parentWords(rule, p.name);
      const folder = words ? folderOf(rule, words) : null;
      if (!folder) return { place: into, refuse: `${spec} does not fit the naming rule of ${into} (${rule.raw.parent}): name a word of it (hoprig get <word> --in ${into}), or record the repository with  hoprig workspace find --in ${into} --place-it ${p.owner ? `${p.owner}/${p.name}` : p.name} <folder>` };
      return { place: into, rule, folder, repo: { owner: p.owner, name: p.name } };
    }
    if (!NAME_RE.test(spec) || known(`${into}/${spec}`)) return null;
    // A bare repository name that fits the parent's pattern is that repository; else a word (or a folder).
    const words = parentWords(rule, spec);
    if (words && folderOf(rule, words)) return { place: into, rule, folder: folderOf(rule, words), repo: { owner: null, name: spec } };
    return { place: into, rule, word: spec, ...(folderWords(rule, spec) ? { folder: spec } : {}) };
  }
  const slash = spec.lastIndexOf('/');
  if (slash <= 0 || known(spec)) return null;
  const place = spec.slice(0, slash);
  const name = spec.slice(slash + 1);
  const rule = ruleOf(map, place);
  if (!rule || !NAME_RE.test(name)) return null;
  return { place, rule, folder: name };
}

const shortRepo = (r) => `${r.owner}/${r.name}`;

/** The host of a git address (https://host/…, ssh://user@host/…, user@host:…), lower case, or ''. */
export function hostOf(url) {
  const u = String(url || '');
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(u);
  return scp ? scp[1].toLowerCase() : '';
}

/**
 * Find the project on the hosting site, show it, ask once, write its entry, then get it. → a getProject result, with
 * `found`: { parent, code, skipped } when the look-up found it.
 */
export async function getByRule(spec, t, { ui, dir, gh = capture, run = capture, runner = stream, map, ask, getProject }) {
  const refused = (message, extra = {}) => (ui.line('fail', message), { spec, ok: false, result: 'refused', message, ...extra });
  if (t.refuse) return refused(t.refuse);
  const { findInPlace, entryOf } = await import('../workspace/findcmd.mjs');
  const { readMap, writeMap } = await import('../workspace/map.mjs');
  let f;
  try {
    f = await findInPlace(t.place, { map, gh });
  } catch (e) {
    return refused(e.message);
  }
  // The account named in owner/name is one GitHub did not list: said as it is, never "no such repository".
  const named = t.repo && t.repo.owner && (f.unlisted || []).find((u) => u.owner.toLowerCase() === t.repo.owner.toLowerCase());
  if (named) return refused(named.why);
  for (const u of f.unlisted || []) ui.line('warn', `${u.why}: its repositories were not looked at`);
  const sameRepo = (p) => p.parent.name.toLowerCase() === t.repo.name.toLowerCase() && (!t.repo.owner || p.parent.owner.toLowerCase() === t.repo.owner.toLowerCase());
  const fits = f.projects.filter((p) => (t.repo ? sameRepo(p) : t.folder ? p.folder.toLowerCase() === t.folder.toLowerCase() : p.folder.toLowerCase() === t.word.toLowerCase() || wordFits(p.words, t.word)));
  const said = t.repo ? (t.repo.owner ? `${t.repo.owner}/${t.repo.name}` : `the repository ${t.repo.name}`) : t.folder ? `the folder ${t.place}/${t.folder}` : `"${t.word}"`;
  if (!fits.length) {
    const near = f.misfits.filter((m) => m.repo.toLowerCase().includes(String(t.word || t.folder).toLowerCase())).map((m) => `${m.repo} (${m.why})`);
    return refused(`no repository in ${f.owners.join(', ')}${f.unlisted ? ` (not looked at: ${f.unlisted.map((u) => u.owner).join(', ')})` : ''} fits ${f.rule.parent} for ${said}${near.length ? `. These do not fit the rule: ${near.join('; ')}; record one with  hoprig workspace find --in ${t.place} --place-it <repository> <folder>` : ''}`);
  }
  let pick = fits[0];
  if (fits.length > 1) {
    const names = fits.map((p) => `${shortRepo(p.parent)} → ${t.place}/${p.folder}`);
    const why = `${said} fits ${fits.length} projects (${names.join(', ')})`;
    // Each fit by its folder, unless two give one folder (two accounts with one parent's name): then by owner/name,
    // which the next get takes with the same --in.
    const oneFolder = new Set(fits.map((p) => p.folder.toLowerCase())).size < fits.length;
    const choices = fits.map((p) => (oneFolder ? shortRepo(p.parent) : `${t.place}/${p.folder}`));
    const example = oneFolder ? `name the repository, for example  hoprig get ${choices[0]} --in ${t.place}` : `name the folder, for example  hoprig get ${choices[0]}`;
    if (!ask) return refused(`${why}: ${example}`, { choices });
    const k = await ui.choose(`${why}. Which one?`, names.map((n, i) => ({ key: String(i + 1), label: n })), null);
    if (!k) return refused(`${why}: nothing chosen`, { choices });
    pick = fits[Number(k) - 1];
  }
  const found = { parent: shortRepo(pick.parent), code: pick.code.map((c) => c.name), skipped: pick.skipped.map((c) => c.name) };
  ui.out(`\n${bold(`${t.place}/${pick.folder}`)}  ${dim(`found on the hosting site by the rule ${f.rule.parent}`)}`);
  ui.out(`  parent      ${pick.parent.url}`);
  ui.out(`  code        ${pick.code.length ? pick.code.map((c) => `code/${c.name}`).join(', ') : 'none'}`);
  if (pick.skipped.length) ui.out(`  left out    ${pick.skipped.map((c) => `${c.name} (the word "${c.word}")`).join(', ')}`);
  ui.out(`  folders     ${t.rule.make.join(', ')}`);
  // The one yes: the choice among several is it; one fit is asked about.
  if (ask && fits.length === 1 && !(await ui.confirm('Get it?', true))) return refused('nothing was fetched', { found });
  // In the map already under its address (a misfit placed under another folder, a get that went on elsewhere): that entry.
  const known = map.projects.find((x) => x.url && sameUrl(x.url, pick.parent.url));
  // A folder of this place that differs from the map's only in letter case is that folder on a file system that
  // ignores it: never a second project there.
  const twin = !known && map.projects.find((x) => (x.in || '') === t.place && x.name.toLowerCase() === pick.folder.toLowerCase());
  if (twin) return refused(`${t.place}/${twin.name} is in the map already for another repository (${twin.url || 'not on a git server yet'}): ${pick.folder} would be the same folder; nothing was fetched`, { found });
  const entry = known || entryOf(pick, t.place, map);
  const next = known ? map : { ...map, projects: [...map.projects, entry] };
  // The entry is written into the map only AFTER the parent's clone: a get whose parent failed leaves the map as it was.
  const r = await getProject(refOf(entry), { ui, dir, gh, run, runner, map: next, ask: false, retry: `hoprig get ${refOf(entry)}` });
  // Once the parent is placed (cloned, or here), the entry is written with every code repository of the rule, also when
  // one of them failed: the map says what the project has, and the retry (or another computer) clones what is missing.
  if (!known && !ui.dryRun && ['cloned', 'here'].includes(r.result)) {
    try {
      const cur = readMap().map || map;
      const have = cur.projects.find((x) => x.url && sameUrl(x.url, entry.url));
      // The scan after the get may have added it from the disk: what the rule knows (its code repositories) is kept too.
      const merged = have ? { ...have, repos: [...have.repos, ...entry.repos.filter((x) => !have.repos.some((y) => y.dir === x.dir))] } : entry;
      if (!have || merged.repos.length !== have.repos.length) writeMap({ ...cur, projects: [...cur.projects.filter((x) => x !== have), merged] });
    } catch (e) {
      ui.line('warn', `the workspace map was not written: ${e.message}`);
    }
  }
  return { ...r, found };
}

/**
 * The folders the rule names, made where they are missing (a link or a file there is left alone and said); only
 * inside the project (inside.mjs mkdirIn).
 */
export function makeFolders(root, rule, { ui, dryRun = false, at = {} } = {}) {
  const made = [];
  for (const d of rule.make) {
    const p = path.join(root, d);
    let st = null;
    try {
      st = fs.lstatSync(p);
    } catch {
      /* not there */
    }
    if (st && st.isDirectory()) continue;
    if (st) {
      ui.line('warn', `${d}: something that is not a folder is there: left alone`);
      continue;
    }
    if (dryRun) ui.note(`(dry run) would make the folder ${d}/`);
    else {
      try {
        mkdirIn({ ...at, root }, p);
      } catch (e) {
        ui.line('warn', `${d}: not made: ${e.message}`);
        continue;
      }
    }
    made.push(d);
  }
  return made;
}

/**
 * Finish a project of a place with a naming rule whose parent has no project.json: its code repositories (the map's
 * entry, and what is in code/ already), the folders of the rule, its memory link. Nothing is written into the project
 * itself; a parent whose `git status` is not clean afterwards (it does not ignore code/) is said, not changed.
 */
export async function finishByRule(out, r, m, { ui, dir, runner = stream, run = capture, was = false, at = {} }) {
  const { finishProject } = await import('./finish.mjs');
  const { groupPlan } = await import('./finish.mjs');
  const { mapNote } = await import('./project.mjs');
  const root = out.dir;
  const ref = `${r.place}/${out.folder}`;
  const byDir = new Map();
  for (const x of [...((r.entry && r.entry.repos) || []), ...m.manifest.repos]) if (!byDir.has(x.dir)) byDir.set(x.dir, x);
  const repos = [];
  for (const x of byDir.values()) {
    const dest = path.join(root, x.dir);
    if (!path.resolve(dest).startsWith(root + path.sep)) continue;
    const link = leaves(root, dest, at); // and again by the clone itself (inside.mjs)
    if (link) {
      repos.push({ dir: x.dir, result: 'skipped' });
      ui.line('warn', `${x.dir}: not cloned: ${leavesWords(link)}`);
      continue;
    }
    const there = fs.existsSync(dest) && fs.readdirSync(dest).length > 0;
    if (ui.dryRun) {
      repos.push({ dir: x.dir, result: there ? 'here' : 'would clone' });
      ui.line(there ? 'ok' : 'info', there ? `${x.dir} (was already there)` : `(dry run) would clone ${x.url} into ${dest}`);
      continue;
    }
    if (!x.url) {
      repos.push({ dir: x.dir, result: there ? 'here' : 'skipped' });
      continue;
    }
    const c = await cloneRepo({ url: x.url, name: path.basename(dest) }, path.dirname(dest), { onLine: (l) => ui.note(l), run: runner, root, at });
    if (!c.ok) {
      repos.push({ dir: x.dir, result: 'failed' });
      ui.line('fail', `${x.dir}: clone failed — retry: ${showCommand(['git', 'clone', x.url, dest])}`);
      continue;
    }
    if (x.branch && !c.skipped) await gitIn({ ...at, root }, dest, ['checkout', '-q', '--no-overwrite-ignore', x.branch]);
    repos.push({ dir: x.dir, result: c.skipped ? 'here' : 'cloned' });
    ui.line('ok', `${x.dir}${c.skipped ? ' (was already there)' : ''}`);
  }
  const made = makeFolders(root, r.rule, { ui, dryRun: ui.dryRun, at });
  // Only the memory link (it lives in Claude Code's folder, not in the project): its own memory, else the group's.
  await finishProject(root, { name: out.folder, repos: [], memories: {} }, { ui, dir, runner, fresh: was ? new Set() : true, ref, memories: await groupPlan(ref), kinds: ['memory'], command: `hoprig project link ${ref}` });
  if (!ui.dryRun) {
    const st = await gitRead(root, ['status', '--porcelain', '--untracked-files=normal'], { run, timeout: 30_000 });
    const lines = st.ok ? st.stdout.split('\n').filter(Boolean) : [];
    if (lines.length) ui.line('warn', `${ref}: git status in its parent shows ${lines.slice(0, 5).map((l) => l.slice(3)).join(', ')}${lines.length > 5 ? ', …' : ''}. Hoprig writes nothing into a project of ${r.place} (it has no project.json): if it should ignore those, add the lines there yourself`);
    await mapNote(ui, `${was ? 'got' : 'cloned'} ${out.folder}`);
    if (!was) ui.line('ok', `${ref} is in ${root}`);
  }
  const failed = repos.filter((x) => x.result === 'failed').length;
  return { ...out, ok: !failed, result: was ? 'here' : 'cloned', repos, made, untouched: true };
}
