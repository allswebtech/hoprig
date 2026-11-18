// `hoprig workspace group add|remove|list`: an owner's own folders of projects, written to the map so every computer
// of his gets the same places (groups.mjs, docs/WORKSPACE.md). Nothing on a disk is ever deleted or moved; the one
// file written outside the map is the ignore file of a group that is a repository, and only the lines it lacks,
// shown first.
//
//   group add <dir> [--repo <address>] [--holds name:group,name]   a plain group, or a group that is a repository
//                                                                  holding named folders ("name:group": its members
//                                                                  come with the group's repository)
//   group remove <dir>                                             only while no project of the map is in it
import path from 'node:path';
import { flags } from '../pcsetup/project.mjs';
import { NAME_RE } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { appendIgnore, ignoreFileOf, linkGroupMemories, missingIgnoreLines } from './groups.mjs';
import { isDir, isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { mapUrl, readMap, refOf, sameUrl, updateMap, validateMap, writeMap } from './map.mjs';
import { tidyFolder } from './mapcheck.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The map a group command may change: one that exists, passes the check and is version 2. */
function mapToChange(dir) {
  const cur = readMap(dir);
  if (cur.errors) throw fail(409, `the workspace map was refused, so nothing was changed: ${cur.errors.join('; ')}`);
  if (!cur.exists) throw fail(404, 'there is no workspace map yet: hoprig workspace map makes one');
  if (cur.map.version !== 2) throw fail(409, 'groups need a map of version 2: hoprig workspace map --upgrade (it says first which computers need a newer Hoprig)');
  return cur.map;
}

/** "--holds packs:group,builds" → [{ dir, parent? }]. Throws on anything else. */
export function parseHolds(text) {
  if (text === undefined || text === null || text === '') return undefined;
  return String(text).split(',').map((part) => {
    const [d, kind, ...more] = part.trim().split(':');
    if (more.length || !NAME_RE.test(d || '') || (kind !== undefined && kind !== 'group')) throw fail(400, `"${part.slice(0, 60)}": --holds takes folder names, each "name" or "name:group", separated by commas`);
    return { dir: d, ...(kind ? { parent: 'group' } : {}) };
  });
}

const sameGroup = (a, b) => JSON.stringify({ ...a, memories: undefined }) === JSON.stringify({ ...b, memories: undefined });

/**
 * Add a group. → { group, added: bool (false: it was there already, the same), ignore: { file, lines, written } | null,
 * notes, mapAdded: [what the scan then put into the map] }. `writeIgnore`: write the missing ignore lines.
 */
export async function groupAdd(gdir, { repo, holds, dryRun = false, writeIgnore = false, dir = workspaceDir(), projects = projectsIn(), run = capture } = {}) {
  const map = mapToChange(dir);
  const group = { dir: typeof gdir === 'string' ? tidyFolder(gdir) : gdir };
  if (repo !== undefined) group.url = mapUrl(repo);
  const h = parseHolds(holds);
  if (h && !group.url) throw fail(400, 'only a group that is a repository holds named folders: give --repo <address> too');
  if (h) group.holds = h;
  const old = (map.groups || []).find((g) => g.dir === group.dir);
  if (old && !sameGroup({ ...old, memories: undefined }, group)) throw fail(409, `${group.dir} is a group of the map already, of another shape: remove it first (hoprig workspace group remove ${group.dir})`);
  // Nothing leaves the map by group add: an "other" repository in the group's folder that fits as a project (or as
  // the group's own repository) becomes one; every other stays an "other" repository. `moved` says which is which.
  const conv = typeof group.dir === 'string' ? fromOthers(map, group) : { others: map.others, projects: map.projects, moved: [] };
  const { others, moved } = conv;
  // The folder is checked before anything looks at it (it may come from anyone typing it).
  const first = validateMap({ ...map, others, projects: conv.projects, groups: [...(map.groups || []).filter((g) => g.dir !== group.dir), group] }, { write: true });
  if (!first.ok) throw fail(400, `the group was not added: ${first.errors.join('; ')}`);
  const abs = path.join(dir, ...group.dir.split('/'));
  // A group that is a repository keeps its memory in ai_brain/claude-memory, as a project does, when it has that folder.
  if (group.url && isDir(path.join(abs, 'ai_brain', 'claude-memory'))) group.memories = { '.': 'ai_brain/claude-memory' };
  const next = { ...map, others, projects: conv.projects, groups: old ? map.groups : [...(map.groups || []), group] };
  const v = validateMap(next, { write: true });
  if (!v.ok) throw fail(400, `the group was not added: ${v.errors.join('; ')}`);
  const notes = moved.map((x) => `${x.dir}: ${x.becomes}`);
  if (!isDir(abs)) notes.push(group.url ? `${group.dir} is not on this computer: hoprig workspace restore gets the group's repository` : `${group.dir} is not on this computer yet: it is made when a project is put there`);
  else if (group.url && !isGitRepo(abs)) notes.push(`${group.dir} is here but is not a git repository: the map says it is ${group.url}`);
  // The ignore lines a group that is a repository needs, so one `git add` in it never takes a member.
  let ignore = null;
  if (group.url && group.holds && isGitRepo(abs)) {
    const lines = missingIgnoreLines(group, abs);
    const f = ignoreFileOf(abs);
    if (lines.length) ignore = { file: f.file, lines, written: false, ...(f.ok ? {} : { refused: f.why }) };
  }
  if (dryRun) return { group, added: !old, ignore, notes, moved, mapAdded: [], dryRun };
  if (!old || moved.some((x) => x.changed)) {
    writeMap(next, dir);
  }
  if (ignore && writeIgnore && !ignore.refused) {
    appendIgnore(abs, ignore.lines, { dir, projects });
    ignore.written = true;
  }
  let mapAdded = [];
  if (!old && isDir(abs)) {
    // What is in the group's folder already enters the map now (project.json files are left alone).
    const r = await updateMap({ dir, projects, run, manifests: false });
    mapAdded = r.diff.added;
    const links = await linkGroupMemories(r.map, { dir, projects }, { run, only: group.dir });
    for (const l of links.filter((x) => x.done === 'conflict')) notes.push(`memory for ${l.launch}: ${l.detail}; ${l.fix}`);
  }
  return { group, added: !old, ignore, notes, moved, mapAdded };
}

/**
 * What the map's "other" repositories in a new group's folder become (mapcheck.mjs memberSpot has the rule): the
 * group's own repository (same address), a project of a place, a code repository of a member that comes with the
 * group, or still an "other" one. A repository where the group's folder is, with another address or without --repo,
 * is refused: that group has to be named as the repository it is. → { others, projects, moved: [{ dir, becomes, changed }] }
 */
function fromOthers(map, group) {
  const places = group.holds ? group.holds.map((h) => ({ id: `${group.dir}/${h.dir}`, withGroup: h.parent === 'group' })) : group.url ? [] : [{ id: group.dir, withGroup: false }];
  const others = [];
  const projects = JSON.parse(JSON.stringify(map.projects));
  const moved = [];
  for (const o of map.others) {
    if (o.dir !== group.dir && !o.dir.startsWith(`${group.dir}/`)) {
      others.push(o);
      continue;
    }
    if (o.dir === group.dir) {
      if (!group.url) throw fail(409, `${group.dir} is a repository (${o.url || 'no address yet'}): add it as one, with --repo <its address> and --holds`);
      if (!sameUrl(o.url, group.url)) throw fail(409, `${group.dir} is the repository ${o.url || 'without an address'} in the map, not ${group.url}`);
      moved.push({ dir: o.dir, becomes: 'the group\'s own repository', changed: true });
      continue;
    }
    const pl = places.find((x) => o.dir.startsWith(`${x.id}/`));
    const pl0 = places.find((x) => o.dir === x.id);
    if (pl0) throw fail(409, `${o.dir} is a repository where a held folder would be: move it, or forget it first`);
    const rest = pl ? o.dir.slice(pl.id.length + 1).split('/') : [];
    if (pl && !pl.withGroup && rest.length === 1) {
      if (!projects.some((x) => x.in === pl.id && x.name === rest[0])) projects.push({ name: rest[0], in: pl.id, url: o.url, repos: [], ...(typeof o.sync === 'boolean' ? { sync: o.sync } : {}) });
      moved.push({ dir: o.dir, becomes: `the project ${pl.id}/${rest[0]}`, changed: true });
    } else if (pl && pl.withGroup && rest.length >= 2) {
      const [name, ...sub] = rest;
      let p = projects.find((x) => x.in === pl.id && x.name === name);
      if (!p) projects.push((p = { name, in: pl.id, url: null, repos: [] }));
      p.repos.push({ dir: sub.join('/'), url: o.url, ...(o.branch ? { branch: o.branch } : {}) });
      moved.push({ dir: o.dir, becomes: `a code repository of the project ${pl.id}/${name}`, changed: true });
    } else if (pl && (o.dir === pl.id || pl.withGroup)) {
      throw fail(409, `${o.dir} is a repository where ${pl.withGroup ? 'a project that comes with the group' : 'a held folder'} would be: move it, or forget it first`);
    } else {
      others.push(o);
      moved.push({ dir: o.dir, becomes: 'stays another repository (it is in the group\'s folder, but no project of it)', changed: false });
    }
  }
  return { others, projects, moved };
}

/**
 * The ignore lines a group that is a repository lacks for what it holds, written only with `write`. Works for any
 * group of the map, whatever else it carries. → { group, file, lines, written }
 */
export function groupIgnore(gdir, { write = false, dir = workspaceDir() } = {}) {
  const map = mapToChange(dir);
  const g = (map.groups || []).find((x) => x.dir === tidyFolder(gdir));
  if (!g) throw fail(404, `"${String(gdir).slice(0, 100)}" is not a group of the map`);
  if (!g.url || !g.holds) return { group: g.dir, file: null, lines: [], written: false, note: 'a group that is no repository holding folders needs no ignore lines' };
  const abs = path.join(dir, ...g.dir.split('/'));
  if (!isGitRepo(abs)) throw fail(404, `${g.dir} is not on this computer as a repository: hoprig workspace restore gets it`);
  const f = ignoreFileOf(abs);
  if (!f.ok) throw fail(409, f.why);
  const lines = missingIgnoreLines(g, abs);
  if (write && lines.length) appendIgnore(abs, lines, { dir });
  return { group: g.dir, file: f.file, lines, written: write && lines.length > 0 };
}

/** Take a group out of the map, only while no project of the map is in it. Nothing on a disk is deleted. */
export function groupRemove(gdir, { dryRun = false, dir = workspaceDir() } = {}) {
  const map = mapToChange(dir);
  const g = (map.groups || []).find((x) => x.dir === tidyFolder(gdir));
  if (!g) throw fail(404, `"${String(gdir).slice(0, 100)}" is not a group of the map`);
  const inside = map.projects.filter((p) => p.in && (p.in === g.dir || p.in.startsWith(`${g.dir}/`))).map(refOf);
  if (inside.length) throw fail(409, `${g.dir} still has ${inside.length === 1 ? 'a project' : `${inside.length} projects`} of the map in it (${inside.slice(0, 10).join(', ')}${inside.length > 10 ? ', …' : ''}): forget ${inside.length === 1 ? 'it' : 'them'} first (hoprig workspace forget <place>/<name>)`);
  const next = { ...map, groups: map.groups.filter((x) => x !== g) };
  if (!dryRun) {
    writeMap(next, dir);
  }
  return { removed: g, dryRun, note: `nothing on this computer was deleted; ${g.dir} stays where it is` };
}

export const GROUP_USAGE = `  hoprig workspace group add <dir> [--repo <address>] [--holds name:group,name] [--yes] [--dry-run] [--json]
                                               a folder of projects beside the projects folder; --repo: the
                                               group is a repository holding named folders (name:group: its
                                               members come with the group's repository)
  hoprig workspace group remove <dir> [--dry-run] [--json]
                                               out of the map, when no project of the map is in it (nothing
                                               on a disk is deleted)
  hoprig workspace group ignore <dir> [--yes] [--dry-run] [--json]
                                               a group that is a repository: the ignore lines it lacks for
                                               what it holds (shown first, written on a yes)
  hoprig workspace group list [--json]         the groups of the map`;

const describe = (g) => `${g.dir}${g.url ? dim(`  ${g.url}`) : dim('  a folder of projects')}${g.holds ? `  holds ${g.holds.map((h) => `${h.dir}${h.parent ? ' (members come with the group)' : ''}`).join(', ')}` : ''}`;

/** `hoprig workspace group …`. → exit code */
export async function groupMain(args, { ui, write, usage }) {
  const [sub, ...rest] = args;
  const json = (v) => (write(JSON.stringify(v, null, 2) + '\n'), 0);
  const failed = (e) => {
    ui.line('fail', e.message);
    return 1;
  };
  if (sub === 'list' || sub === undefined) {
    const o = flags(rest, { json: 'bool' });
    if (o.errors.length || o._.length) return usage();
    const m = readMap(workspaceDir());
    if (m.errors) return failed(new Error(`the workspace map was refused: ${m.errors.join('; ')}`));
    const groups = (m.map && m.map.groups) || [];
    if (o.json) return json({ version: m.map ? m.map.version : null, groups });
    if (!groups.length) ui.note(m.map && m.map.version === 2 ? 'no groups yet: hoprig workspace group add <dir>' : 'no groups (they need a map of version 2: hoprig workspace map --upgrade)');
    for (const g of groups) ui.line('ok', describe(g));
    return 0;
  }
  if (sub === 'add') {
    const o = flags(rest, { repo: 'v', holds: 'v', yes: 'bool', 'dry-run': 'bool', json: 'bool' });
    if (o.errors.length || o._.length !== 1) return usage();
    let plan;
    try {
      plan = await groupAdd(o._[0], { repo: o.repo, holds: o.holds, dryRun: true });
    } catch (e) {
      return failed(e);
    }
    if (!o.json) {
      ui.out(`\n${bold('Group')}  ${describe(plan.group)}${plan.added ? '' : dim('  (in the map already)')}`);
      if (plan.ignore) {
        ui.out(`  ${plan.ignore.file} lacks these lines, so one \`git add\` there would take a member:`);
        for (const l of plan.ignore.lines) ui.out(`    ${l}`);
      }
    }
    if (o['dry-run']) {
      if (o.json) return json(plan);
      for (const n of plan.notes) ui.note(n);
      return 0;
    }
    const writeIgnore = Boolean(plan.ignore) && !plan.ignore.refused && (o.yes || ui.yes || (!o.json && ui.interactive && (await ui.confirm('Add these lines to its ignore file?', true))));
    let r;
    try {
      r = await groupAdd(o._[0], { repo: o.repo, holds: o.holds, writeIgnore });
    } catch (e) {
      return failed(e);
    }
    if (o.json) return json(r);
    ui.line('ok', r.added ? `${r.group.dir} is a group of the map now: commit the brain to share it` : `${r.group.dir} was in the map already`);
    if (r.ignore && r.ignore.refused) ui.line('warn', `the ignore lines were not added: ${r.ignore.refused}`);
    else if (r.ignore) ui.line(r.ignore.written ? 'ok' : 'warn', r.ignore.written ? `added ${r.ignore.lines.length} line${r.ignore.lines.length === 1 ? '' : 's'} to ${r.ignore.file}: commit them in the group` : `the ignore lines were not added (add --yes to write them)`);
    for (const a of r.mapAdded) ui.line('ok', `added to the map: ${a}`);
    for (const n of r.notes) ui.note(n);
    return 0;
  }
  if (sub === 'ignore') {
    const o = flags(rest, { yes: 'bool', 'dry-run': 'bool', json: 'bool' });
    if (o.errors.length || o._.length !== 1) return usage();
    let plan;
    try {
      plan = groupIgnore(o._[0]);
    } catch (e) {
      return failed(e);
    }
    if (!plan.lines.length) {
      if (o.json) return json(plan);
      ui.line('ok', plan.note || `${plan.file} has every line it needs`);
      return 0;
    }
    if (!o.json) {
      ui.out(`  ${plan.file} lacks these lines, so one \`git add\` there would take a member:`);
      for (const l of plan.lines) ui.out(`    ${l}`);
    }
    if (o['dry-run']) return o.json ? json(plan) : 0;
    const yes = o.yes || ui.yes || (!o.json && ui.interactive && (await ui.confirm('Add these lines to its ignore file?', true)));
    if (!yes) return failed(new Error('the ignore file was not changed (add --yes to write the lines)'));
    const r = groupIgnore(o._[0], { write: true });
    if (o.json) return json(r);
    ui.line('ok', `added ${r.lines.length} line${r.lines.length === 1 ? '' : 's'} to ${r.file}: commit them in the group`);
    return 0;
  }
  if (sub === 'remove') {
    const o = flags(rest, { 'dry-run': 'bool', json: 'bool' });
    if (o.errors.length || o._.length !== 1) return usage();
    let r;
    try {
      r = groupRemove(o._[0], { dryRun: o['dry-run'] });
    } catch (e) {
      return failed(e);
    }
    if (o.json) return json(r);
    ui.line('ok', `${r.removed.dir} ${r.dryRun ? 'would be' : 'is'} out of the map${r.dryRun ? '' : ': commit the brain to share it'}`);
    ui.note(r.note);
    return 0;
  }
  return usage();
}
