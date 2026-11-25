// `hoprig pc leave --check`: before a computer is formatted, one look at the WHOLE computer that names everything that
// exists only there (docs/WORKSPACE.md). It READS only: it never fetches, uploads, pushes, moves or deletes, and every
// command it names is shown, never run. The parts:
//
//   1. every repository of the workspace (each project in every place, the brain, each group's own repository, each
//      other repository, the credentials folder when it is one) through drop's own check (drop.mjs lookAt,
//      dropcheck.mjs checkRepo), so "only here" means what it means for a drop: every branch counts;
//   2. every folder of the workspace in no map and in no git, with its size;
//   3. the four described folders (computer.mjs DESCRIBED): what in backups/ and database/ is in no git; a toolchain
//      (development/) is never counted, it can be installed again; git/ only through its repositories;
//   4. each --also folder (an older layout outside the workspace): every repository in it is checked with its local
//      refs only, every folder in no git is listed with its size;
//   5. the home outside the workspace (leavehome.mjs homeLook) and the owner's marks (leavemarks.mjs): a folder he
//      marked "outside" is named once and not counted.
//
// The daily look (`cheap`) asks no git server at all: what is said of a server is as of the last fetch. The whole
// check asks each server once with `git ls-remote` (drop's askServer), which writes nothing here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { isDir, isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { readMap, refOf } from './map.mjs';
import { safeFolders } from './groups.mjs';
import { lookAt, privateState } from './drop.mjs';
import { askServer, checkRepo } from './dropcheck.mjs';
import { memoriesOf, sizeWords } from './dropfind.mjs';
import { leavesWords } from './inside.mjs';
import { DESCRIBED } from './computer.mjs';
import { checkItems, ignoredItem, item, lastFetch, refusalItems, whereOf } from './leaveitems.mjs';
import { DEFAULT_BUDGET, isPrivateName, lookThrough, makeBudget, reposInside, sizeOf } from './leavewalk.mjs';
import { homeLook } from './leavehome.mjs';
import { outsideWhy, readMarks } from './leavemarks.mjs';

export const BY_YOUR_WORD = 'not checked, by your word';
export const AS_OF_FETCH = 'what is said of git servers is as of the last fetch: no server was asked';
const within = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A mark's place ("~/old", or a full path) as a full path of this computer. */
const absOf = (where, home) => (where === '~' ? home : where.startsWith('~/') ? path.join(home, ...where.slice(2).split('/')) : path.resolve(where));
const hasOrigin = async (dir, run) => (await gitRead(dir, ['config', '--get', 'remote.origin.url'], { run })).ok;
const outsideCommand = (where) => `hoprig pc leave --outside ${/^[A-Za-z0-9_@%+=:,./~-]+$/.test(where) ? where : `'${where.replace(/'/g, `'\\''`)}'`}`;

/**
 * The whole look. `opts` as SHAPE.md: { dir, projects, home, also, cheap, run, facts, budget, now }; a test may also hand
 * in `marks` (readMarks' answer; else read from the computer's own file) and `homeLook` (the home part's stand-in).
 * A repository found by a walk (in no map, or in an --also folder) is never pushable: the one press pushes the map's.
 * → { at, cheap, items, asks, outside, notChecked, notes, nothingOnlyHere }
 */
export async function leaveCheck(opts = {}) {
  const { dir = workspaceDir(), projects = projectsIn(), home = os.homedir(), also = [], cheap = false, run = capture, budget: limits = DEFAULT_BUDGET, now = () => Date.now() } = opts;
  const ctx = { dir, projects };
  const budget = makeBudget(limits);
  const items = [];
  const notChecked = [];
  const outside = [];
  const notes = new Set();
  const checked = new Set(); // every repository once, whatever way it was found
  const credentials = path.join(dir, 'credentials');
  const brain = path.join(dir, 'ai_brain');
  const read = opts.marks || readMarks({ dir, home });
  // A mark the check may not honour (a file written by an older Hoprig, or by hand): looked at all the same, and said.
  const marks = { ...read, outside: (read.outside || []).filter((w) => {
    const why = outsideWhy(absOf(w, home), { dir, projects, home });
    if (why) notes.add(`${w} is marked as yours to keep, but ${why}`);
    return !why;
  }) };
  const marked = marks.outside.map((w) => absOf(w, home));
  const fromServer = cheap ? lastFetch : askServer;
  const where = (p) => whereOf(p, home);

  // A folder the owner left out by his word: named once, never entered, never counted.
  const left = (p) => {
    const m = marked.find((o) => within(p, o));
    if (!m) return false;
    if (!outside.some((o) => o.where === where(m))) outside.push({ where: where(m), why: BY_YOUR_WORD });
    return true;
  };
  const add = (r) => {
    items.push(...r.items);
    notChecked.push(...r.notChecked);
  };
  const sizer = (repos) => (d) => sizeOf(d, budget, { skip: repos.filter((r) => r !== d) });

  // A private folder (no-ai, ignore) found by a walk: never looked into; all committed in its repository is safe.
  const privateItem = async (p, repos = []) => {
    if (left(p)) return;
    const holder = repos.filter((r) => within(p, r + path.sep)).sort((a, b) => b.length - a.length)[0];
    if (holder && (await privateState(holder, path.relative(holder, p).split(path.sep).join('/'), run)).state === 'clean') return;
    items.push(item({ kind: 'folder', where: where(p), what: 'a private folder that is not all on a git server (Hoprig never looks into it)', todo: 'commit and push it yourself, or keep a copy of it somewhere else', command: '' }));
  };

  // A repository found outside a project folder (the brain, a group, another, the credentials, one a walk found): it
  // and every repository inside its working tree, the tree walked once. `skip(r)`: one checked another way (a member
  // of a group, which is a project of its own). `local`: its local refs only (outside the workspace).
  const checkTree = async (wt, { pushable = false, names = true, local = false, skip = () => false } = {}) => {
    const inner = await reposInside(wt, budget);
    if (inner.cut) notChecked.push({ where: where(wt), why: 'too large to look through for repositories inside it within the budget: those were not checked' });
    const all = [wt, ...inner.repos];
    for (const r of all) {
      if (checked.has(r) || skip(r) || left(r)) continue;
      checked.add(r);
      const server = (await hasOrigin(r, run)) ? await (local ? lastFetch : fromServer)({ ...ctx, root: r }, r, run) : null;
      const c = await checkRepo(r, { label: where(r), repos: all, server, credentials, run });
      for (const n of c.notes) notes.add(`${where(r)}: ${n}`);
      items.push(...checkItems(c, { home, pushable }));
      add(await refusalItems(c.refusals.map((x) => ({ dir: r, ...x })), { home, names, sizeOf: sizer(all) }));
      const ig = ignoredItem(r, c.ignored, { home, names });
      if (ig) items.push(ig);
    }
    for (const p of inner.privates) if (!skip(p)) await privateItem(p, all);
  };

  // A folder walked for what is in no git (a stray folder of the workspace, a described one, an --also folder).
  const walkFolder = async (top, { kind, local = false, stop = () => false, plain = true }) => {
    const r = await lookThrough(top, budget, { stop: (p) => left(p) || within(p, credentials) || stop(p) });
    if (r.cut) notChecked.push({ where: where(top), why: `at least ${sizeWords(r.cut.size)}, not measured further` });
    for (const u of r.unreadable) notChecked.push({ where: where(u), why: 'it could not be read' });
    for (const wt of r.repos) await checkTree(wt, { local });
    for (const p of r.privates) await privateItem(p);
    if (!plain) return;
    for (const f of r.plain) {
      const w = where(f.dir);
      items.push(item({
        kind, where: w, key: f.loose ? 'files' : '', size: f.size,
        what: `${f.loose ? 'files directly in this folder are' : 'a folder'} in no git: ${plural(f.files, 'file')}`,
        todo: kind === 'described' ? 'copy it to a place you keep (another disk, your storage), or mark it as backed up by you' : 'make it a repository with a git server and push it, or mark it as yours to keep',
        command: outsideCommand(w),
      }));
    }
  };

  // 1. The map, its places and every project folder in them (the ones that lead out through a link are named).
  const m = readMap(dir);
  if (m.errors) notChecked.push({ where: where(path.join(brain, 'workspace.json')), why: `the workspace map was refused (${m.errors[0]}): its groups and other repositories were not looked at` });
  const map = m.exists && !m.errors ? m.map : null;
  const safe = await safeFolders(map, ctx, run);
  for (const pl of safe.places.filter((x) => x.blocked)) notChecked.push({ where: where(pl.dir), why: `${leavesWords(pl.blocked)}: not followed` });
  for (const l of safe.links) if (!notChecked.some((n) => n.where === where(l.path))) notChecked.push({ where: where(l.path), why: `${l.what}: not followed` });
  const projectDirs = safe.folders.map((f) => f.dir);
  const inProject = (p) => projectDirs.some((d) => within(p, d));

  for (const f of safe.folders) {
    if (left(f.dir)) continue;
    const entry = ((map && map.projects) || []).find((p) => refOf(p) === f.ref) || null;
    const t = { folder: f.dir, member: f.members === 'group', group: f.group, entry, ref: f.ref };
    const look = await lookAt(t, ctx, { fetch: false, run, ask: fromServer });
    look.repos.forEach((r) => checked.add(r));
    const dirOf = (label) => (path.isAbsolute(label) ? label : path.join(dir, label));
    for (const c of look.checks) {
      for (const n of c.notes) notes.add(`${where(c.dir)}: ${n}`);
      items.push(...checkItems(c, { home, pushable: true }));
    }
    // look.refusals holds checkRepo's refusals of each repository and the project's own ones.
    add(await refusalItems(look.refusals.map((r) => ({ dir: dirOf(r.repo), what: r.what, command: r.command })), { home, sizeOf: sizer(look.repos) }));
    const byRepo = new Map();
    for (const x of look.confirm) byRepo.set(x.repo, [...(byRepo.get(x.repo) || []), x]);
    for (const [label, list] of byRepo) {
      const ig = ignoredItem(dirOf(label), list, { home });
      if (ig) items.push(ig);
    }
    // Claude Code's memory for a folder of the project that is a real folder, not a link into a repository.
    const launches = [...(t.member ? [] : [f.dir]), ...look.repos.filter((r) => r !== f.dir)];
    for (const mem of memoriesOf(launches, f.dir).filter((x) => x.state === 'real')) {
      const s = await sizeOf(mem.link, budget);
      const own = t.entry && !t.member;
      items.push(item({ kind: 'memory', where: where(mem.link), size: s.size, what: `Claude Code's memory for ${where(mem.launch)} is a real folder in no git (${plural(mem.files, 'file')})`, todo: own ? 'move it into the project\'s memory folder and link it there' : 'copy what you need of it into the project, commit and push it', command: own ? `hoprig project link ${t.ref}` : '' }));
    }
  }

  // The brain, each group's own repository, each other repository: entries of the map, pushed by their own upkeep
  // (never by the one press, which pushes the projects' repositories only, so they are not called pushable). The credentials folder when it is a repository: never by a press (its own push
  // asks the server whether it is private first, credrepo.mjs), and no name of a file in it is shown. A member of a
  // group is a project folder of its own, checked above.
  if (isGitRepo(brain)) {
    if (!left(brain)) await checkTree(brain);
  } else if (isDir(brain) && !left(brain)) {
    items.push(item({ kind: 'folder', where: where(brain), size: (await sizeOf(brain, budget)).size, what: 'the AI brain is in no git, so all of it exists only here', todo: 'give it a git server and push it', command: 'hoprig workspace brain' }));
  }
  for (const g of (map && map.groups) || []) {
    const gdir = path.join(dir, ...g.dir.split('/'));
    if (g.url && isGitRepo(gdir) && !left(gdir)) await checkTree(gdir, { skip: inProject });
  }
  for (const o of (map && map.others) || []) {
    const odir = path.join(dir, ...o.dir.split('/'));
    if (isGitRepo(odir) && !left(odir)) await checkTree(odir);
  }
  if (isGitRepo(credentials) && !left(credentials)) await checkTree(credentials, { names: false });

  // 2. What else is in the workspace: folders in no map and in no git, repositories no map names, and what lies loose
  // in a place of its own (a file or a dot-folder beside the projects).
  const known = new Set([brain, credentials, projects, ...DESCRIBED.map((d) => path.join(dir, d)), ...safe.places.map((p) => p.dir), ...((map && map.groups) || []).map((g) => path.join(dir, ...g.dir.split('/'))), ...((map && map.others) || []).map((o) => path.join(dir, ...o.dir.split('/')))]);
  if (isDir(dir)) await walkFolder(dir, { kind: 'folder', stop: (p) => p !== dir && known.has(p) });
  const grouped = new Set(((map && map.groups) || []).filter((g) => g.url).map((g) => g.dir));
  for (const pl of safe.places) {
    if (pl.blocked || (pl.group && grouped.has(pl.group)) || !isDir(pl.dir) || left(pl.dir)) continue;
    await walkFolder(pl.dir, { kind: 'folder', stop: (p) => p !== pl.dir && (projectDirs.includes(p) || known.has(p)) });
  }

  // 3. The described folders: backups/ and database/ counted, git/ through its repositories, development/ never.
  for (const d of ['backups', 'database', 'git']) {
    const top = path.join(dir, d);
    if (isDir(top) && !left(top)) await walkFolder(top, { kind: 'described', plain: d !== 'git' });
  }

  // 4. The --also folders: local refs only (no server is asked about a folder outside the workspace).
  for (const a of also) {
    const top = path.resolve(a);
    if (left(top)) continue;
    // A private folder (no-ai, ignore), named itself or holding the folder named, is never looked into.
    let realTop = top;
    try {
      realTop = fs.realpathSync(top);
    } catch {
      /* not there: said below */
    }
    if ([top, realTop].some((p) => p.split(path.sep).some(isPrivateName))) notChecked.push({ where: where(top), why: 'a private folder: never looked into' });
    else if (!isDir(top)) notChecked.push({ where: where(top), why: 'it is not a folder here' });
    else await walkFolder(top, { kind: 'folder', local: true });
  }

  // 5. The home outside the workspace.
  const h = await (opts.homeLook || homeLook)({ ...opts, dir, projects, home, also, cheap, run, budget: limits, now, marks });
  items.push(...h.items);
  notChecked.push(...h.notChecked);
  for (const o of h.outside) if (!outside.some((x) => x.where === o.where)) outside.push(o);
  if (cheap) notes.add(AS_OF_FETCH);

  const byId = new Map();
  for (const i of items) if (!byId.has(i.id)) byId.set(i.id, i);
  const seen = new Set();
  const notList = notChecked.filter((n) => !seen.has(`${n.where}\0${n.why}`) && seen.add(`${n.where}\0${n.why}`));
  const list = [...byId.values()];
  return { at: new Date(now()).toISOString(), cheap, items: list, asks: h.asks, outside, notChecked: notList, notes: [...notes], nothingOnlyHere: !list.length && !h.asks.length && !notList.length };
}
