// `hoprig project …`: project workspaces (see workspace.mjs for the shape).
//   project new <name> [--template <folder or git address>] [--github [--repo-name <n>] | --remote <git address>] [--owner <o>]
//   project add <project> <name> [--github | --remote <git address>]     a code repository: code/<project>-<name> (or code/<project>)
//   project clone <name | owner/name | git address>… [--yes] [--json] [--dry-run]   = hoprig get (getproject.mjs)
//   project status [name] [--json]                                       parent and children: branch, changes, ahead/behind
//   project sync [name] [--memory] [--dry-run]                           fetch, fast-forward, push; never merge/rebase/force/stash
//   project link <name> [--dry-run]                                      link Claude Code's memory folders again
//   project setup <name> [--dry-run] [--yes]                             what a fresh clone sets up (finish.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { capture, showCommand, stream } from '../setup/system.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { parseRepo, projectsDir, rememberDir } from './projects.mjs';
import { finishProject, groupPlan, report } from './finish.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { gitIn, mkdirIn, writeIn } from '../workspace/inside.mjs';
import {
  MANIFEST, NAME_RE, builtinFiles, createGithubRepo, githubOwners, initRepo, linkMemories, listWorkspaces,
  planMemories, readManifest, readTemplate, syncWorkspace, useHooks, workspaceState, writeManifest, writeTemplate,
} from './workspace.mjs';

export { finishProject };

const fail = (ui, msg) => {
  ui.line('fail', msg);
  return 1;
};

/** Flags: --x value / --x=value / --flag. */
export function flags(args, known) {
  const o = { _: [], errors: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (!(k in known)) o.errors.push(`unknown option --${k}`);
    else if (known[k] === 'bool') o[k] = true;
    else o[k] = v !== undefined ? v : args[++i];
  }
  return o;
}

/** The template's files: --template, else the remembered "projectTemplate", else the built-in one. */
async function templateFiles(src, ui) {
  if (!src) return { files: builtinFiles(), from: 'built-in' };
  let dir = src;
  let tmp = null;
  if (!fs.existsSync(src)) {
    const repo = parseRepo(src);
    if (!repo) throw new Error(`the template "${src}" is neither a folder nor a Git address`);
    if (ui.dryRun) return { files: null, from: src, remote: repo.url }; // a dry run clones nothing, not even to look
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-template-'));
    const r = await stream(['git', 'clone', '--depth', '1', '--quiet', '--', repo.url, path.join(tmp, 't')], { env: withoutSecrets(process.env), onLine: (l) => ui.note(l) });
    if (!r.ok) throw new Error(`could not clone the template ${repo.url}`);
    dir = path.join(tmp, 't');
  }
  try {
    return { files: readTemplate(dir), from: src };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Ask which GitHub account (when there are several). --yes takes the user's own. */
export async function chooseOwner(ui, owners, given) {
  if (given) return owners.includes(given) || !owners.length ? given : null;
  if (owners.length <= 1 || ui.yes || !ui.interactive) return owners[0] || null;
  const k = await ui.choose('Which GitHub account?', owners.map((o, i) => ({ key: String(i + 1), label: o })), '1');
  return k ? owners[Number(k) - 1] : null;
}

/**
 * The GitHub name of a new project's parent: --repo-name, else the project's name, or "<name>-workspace" when the
 * account already has a repository "<name>" (often the project's own product, which then lives in code/<name>).
 */
export async function parentRepoName(owner, name, given, gh = capture) {
  if (given) return given;
  const taken = (await gh(['gh', 'repo', 'view', `${owner}/${name}`, '--json', 'name'], { timeout: 20_000 })).ok;
  return taken ? `${name}-workspace` : name;
}

/** Push a new local repository: to GitHub (private) or to a given address. `parent`: the name is parentRepoName's. */
async function publish(ui, dir, projectName, o, run, { parent = false } = {}) {
  if (o.remote) {
    const repo = parseRepo(o.remote);
    if (!repo) return ui.line('fail', `"${o.remote}" is not a Git address`) || null;
    await gitIn(dir, dir, ['remote', 'add', 'origin', repo.url]);
    const p = await gitIn(dir, dir, ['push', '-u', 'origin', 'HEAD'], run, { onLine: (l) => ui.note(l) });
    ui.line(p.ok ? 'ok' : 'fail', p.ok ? `pushed to ${repo.url}` : `push failed — retry: ${showCommand(['git', '-C', dir, 'push', '-u', 'origin', 'HEAD'])}`);
    return repo.url;
  }
  if (!o.github) return null;
  const owners = await githubOwners();
  if (!owners.length) return ui.line('warn', 'not signed in to GitHub (gh auth login): kept local only') || null;
  const owner = await chooseOwner(ui, owners, o.owner);
  if (!owner) return null;
  const name = parent ? await parentRepoName(owner, projectName, o['repo-name']) : projectName;
  if (name !== projectName) ui.note(`${o['repo-name'] ? 'as asked' : `${owner}/${projectName} exists already`}: the parent repository is ${owner}/${name}; the folder stays ${projectName}`);
  const r = await createGithubRepo(dir, owner, name, { onLine: (l) => ui.note(l), run });
  ui.line(r.ok ? 'ok' : 'fail', r.ok ? `private repository ${owner}/${name} created and pushed` : `gh repo create failed — retry: ${showCommand(['gh', 'repo', 'create', `${owner}/${name}`, '--private', '--source', dir, '--remote', 'origin', '--push'])}`);
  return r.ok ? `https://github.com/${owner}/${name}.git` : null;
}

export async function projectNew(args, { ui, run = stream }) {
  const o = flags(args, { template: 'v', github: 'bool', remote: 'v', owner: 'v', 'no-github': 'bool', 'repo-name': 'v', in: 'v', 'dry-run': 'bool' });
  const name = o._[0];
  if (o.errors.length || !name) return fail(ui, `${o.errors.join('; ') || 'a name is needed'} — usage: hoprig project new <name> [--in <group>] [--template <folder|git address>] [--github [--repo-name <name>] | --remote <address>] [--dry-run]`);
  if (o['dry-run']) ui.dryRun = true;
  if (!NAME_RE.test(name)) return fail(ui, 'a project name is letters, digits, ".", "_" and "-"');
  if (o['repo-name'] !== undefined && !NAME_RE.test(String(o['repo-name']))) return fail(ui, 'a repository name is letters, digits, ".", "_" and "-"');
  if (o['repo-name'] !== undefined && !o.github) ui.line('warn', '--repo-name names the GitHub repository, so without --github it is ignored');
  // The projects folder, unless --in names a group (or a held folder) of the workspace map.
  let place;
  try {
    place = (await import('../workspace/where.mjs')).targetPlace(o.in, { projects: projectsDir() });
  } catch (e) {
    return fail(ui, e.message);
  }
  const root = path.join(place.dir, name);
  const ref = place.place ? `${place.place}/${name}` : name;
  if (fs.existsSync(root)) return fail(ui, `${root} already exists`);
  let cfg = {};
  try {
    cfg = loadConfig();
  } catch {
    /* defaults */
  }
  const t = await templateFiles(o.template || cfg.projectTemplate || null, ui).catch((e) => ({ error: e.message }));
  if (t.error) return fail(ui, t.error);
  if (ui.dryRun) {
    const files = t.files ? `${t.files.length} files` : `cloned from ${t.remote} first`;
    const online = o.remote ? `, and push it to ${o.remote}` : o.github ? ', and create a private GitHub repository for it and push' : '';
    ui.note(`(dry run) would create ${root} from the ${t.from} template (${files}), make its first commit and link its memory${online}`);
    return 0;
  }
  // The first commit needs a name and an e-mail. Find out BEFORE anything is written, so a failure does not leave
  // a half-made project folder behind.
  // Asked outside any repository: the folder hoprig runs in may be one, and its own name would not apply to the new one.
  const who = await Promise.all(['user.name', 'user.email'].map((k) => capture(['git', 'config', '--get', k], { timeout: 10_000, cwd: os.tmpdir() }).then((r) => (r.stdout || '').trim(), () => '')));
  if (!who[0] || !who[1]) {
    return fail(ui, 'git does not know your name and e-mail yet, and a commit needs them. Set them once, then run this again:\n'
      + '    git config --global user.name "Your Name"\n    git config --global user.email "you@example.com"');
  }
  writeTemplate(root, t.files, name);
  if (!fs.existsSync(path.join(root, MANIFEST))) writeManifest(root, { name, repos: [], memories: (await readManifest(root)).manifest.memories });
  const init = await initRepo(root, `Start ${name}`);
  if (!init.ok) return fail(ui, `git could not make the first commit: ${init.error} (set your name: git config --global user.name "Your Name")`);
  ui.line('ok', `created ${root} (${t.from} template), first commit made`);
  await useHooks(root);
  report(ui, linkMemories(root, (await readManifest(root)).manifest.memories, { ref }));
  rememberDir(projectsDir());
  const wantGithub = o.github || (!o.remote && !o['no-github'] && ui.interactive && !ui.yes && (await githubOwners()).length && (await ui.confirm('Create a private GitHub repository for it and push?', true)));
  await publish(ui, root, name, { ...o, github: wantGithub }, run, { parent: true });
  if (o.template && o.template !== cfg.projectTemplate && fs.existsSync(o.template) === false && parseRepo(o.template)) saveConfig({ projectTemplate: parseRepo(o.template).url });
  await mapNote(ui, `new project ${ref}`);
  ui.out(`\nNext: ${bold(`hoprig project add ${ref} <stack>`)}  ${dim('(a code repository in code/)')}`);
  return 0;
}

export async function projectAdd(args, { ui, run = stream }) {
  const o = flags(args, { github: 'bool', remote: 'v', owner: 'v', 'dry-run': 'bool' });
  const [ref, sub] = o._;
  if (o.errors.length || !ref || !sub) return fail(ui, 'usage: hoprig project add <project> <name> [--github | --remote <address>] [--dry-run]');
  if (o['dry-run']) ui.dryRun = true;
  let at;
  try {
    at = await (await import('../workspace/where.mjs')).projectDirFor(ref, { projects: projectsDir() });
  } catch (e) {
    return fail(ui, e.status === 409 ? e.message : `no project "${ref}" in ${projectsDir()} or a group of the workspace map`);
  }
  const root = at.root;
  const project = path.basename(root);
  // code/<project>-<name>; `project add shop shop` makes code/shop (the product named like the project).
  const repoName = sub === project || sub.startsWith(`${project}-`) ? sub : `${project}-${sub}`;
  if (!NAME_RE.test(repoName)) return fail(ui, 'a repository name is letters, digits, ".", "_" and "-"');
  const dir = path.join(root, 'code', repoName);
  if (fs.existsSync(dir)) return fail(ui, `${dir} already exists`);
  if (ui.dryRun) {
    const online = o.remote ? `push it to ${o.remote}` : o.github ? 'create a private GitHub repository for it and push' : 'keep it local (no address yet)';
    ui.note(`(dry run) would create ${dir} with a README and a first commit, ${online}${o.remote || o.github ? `, and record it in ${ref}/project.json with a commit` : ''}`);
    return 0;
  }
  // Only inside the project (inside.mjs): a project whose code/ leads elsewhere gets nothing made there.
  try {
    mkdirIn(root, dir);
    writeIn(root, path.join(dir, 'README.md'), `# ${repoName}\n\nPart of the ${project} project.\n`, { excl: true });
  } catch (e) {
    return fail(ui, e.message);
  }
  const init = await initRepo(dir, `Start ${repoName}`, undefined, { root });
  if (!init.ok) return fail(ui, `git could not make the first commit: ${init.error}`);
  ui.line('ok', `created ${dir}`);
  const url = await publish(ui, dir, repoName, o, run);
  const { manifest } = await readManifest(root);
  manifest.repos = manifest.repos.filter((r) => r.dir !== `code/${repoName}`);
  if (url) manifest.repos.push({ dir: `code/${repoName}`, url });
  else ui.line('warn', 'no remote yet: it is listed in project.json once it has one (run project add again with --github or --remote)');
  try {
    writeManifest(root, { ...manifest, repos: manifest.repos });
  } catch (e) {
    return fail(ui, `project.json was not written: ${e.message}`);
  }
  // A member that comes with its group's repository: its project.json is the group's to commit.
  if (url && at.members === 'group') ui.note(`project.json is tracked by the group's repository: commit it there`);
  else if (url) {
    await gitIn(root, root, ['add', '--', MANIFEST, 'ai_brain/claude-memory.json']);
    const c = await gitIn(root, root, ['commit', '-q', '-m', `Add ${repoName}`, '--', MANIFEST]);
    if (c.ok) ui.line('ok', 'recorded in project.json and committed');
  }
  await mapNote(ui, `added ${repoName} to ${project}`);
  return 0;
}

/**
 * Clone a project: the parent, every child, memory links, hooks, installs (getproject.mjs: the folder-name rule).
 * Exported for recipes, the dashboard and Tia. A <place>/<folder> of a place with a naming rule that the map does not
 * have yet is looked up on the hosting site as the command line does (getbyrule.mjs), never asked (the request is the
 * owner's). Resolves the exit code; `onDone` gets the full result (its folder).
 */
export async function cloneProject(spec, { onDone = () => {}, ...opts } = {}) {
  const { getProject, readMapQuietly } = await import('./getproject.mjs');
  const byRule = await import('./getbyrule.mjs');
  const map = readMapQuietly();
  const t = byRule.ruleTarget(spec, null, map);
  const r = t ? await byRule.getByRule(spec, t, { ...opts, map, ask: false, getProject }) : await getProject(spec, opts);
  onDone(r);
  return r.ok ? 0 : 1;
}

/** Keep the workspace map in step after a project changed (only when there is an AI brain to keep it in). */
export async function mapNote(ui, what) {
  const note = await (await import('../workspace/map.mjs')).refreshMapAfter(what, { dryRun: Boolean(ui.dryRun) });
  if (note) ui.note(note);
}

/** The project folders a command acts on: the one it names (<name> or <place>/<name>), else every project in every place. */
const pick = async (name) => {
  const where = await import('../workspace/where.mjs');
  const dir = projectsDir();
  if (name) {
    try {
      return [await where.projectDirFor(name, { projects: dir })];
    } catch (e) {
      if (e.status === 409) throw e; // a bare name in two places: said with both forms
      return [];
    }
  }
  const safe = await where.foldersHere({ projects: dir });
  const allowed = new Set(safe.folders.map((f) => f.dir)); // in a group: never through a link a repository tracks
  return safe.places.filter((pl) => !pl.blocked).flatMap((pl) => listWorkspaces(pl.dir, { withGroup: pl.members === 'group' }).filter((root) => !pl.id || allowed.has(root)).map((root) => ({ root, members: pl.members, ref: pl.id ? `${pl.id}/${path.basename(root)}` : path.basename(root), place: pl.id })));
};

const stateText = (s) => (s.ok ? [s.branch, s.changes ? `${s.changes} changed` : '', s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} to pull` : '', s.upstream ? '' : 'no upstream'].filter(Boolean).join(' · ') : s.error);

export async function projectStatus(args, { ui, write }) {
  const o = flags(args, { json: 'bool', dir: 'v' });
  if (o.errors.length) return fail(ui, o.errors.join('; '));
  const base = o.dir ? path.resolve(o.dir) : projectsDir();
  // --dir: that one folder as it is; else every place a project can be.
  let roots;
  try {
    roots = o.dir ? (o._[0] ? [path.join(base, o._[0])].filter((r) => NAME_RE.test(o._[0]) && fs.existsSync(path.join(r, '.git'))) : listWorkspaces(base)) : (await pick(o._[0])).map((x) => x.root);
  } catch (e) {
    // A bare name in two places, or a folder that is there but not followed (behind a link): said as it is.
    // Also with --json: the refusal is a line of its own, as every refusal of project status (nothing on stdout).
    if (e.status !== 409) throw e;
    return fail(ui, e.message);
  }
  const all = await Promise.all(roots.map((r) => workspaceState(r)));
  if (o.json) {
    write(JSON.stringify({ projectsDir: base, projects: all }, null, 2) + '\n');
    return 0;
  }
  if (!all.length) ui.out(`No projects in ${base}${o._[0] ? ` named ${o._[0]}` : ''}.`);
  for (const w of all) {
    ui.out(`\n${bold(w.name)}  ${dim(`${w.root} · ${w.source === MANIFEST ? 'project.json' : 'no project.json (read from the folders)'}`)}`);
    for (const msg of w.warnings || []) ui.line('warn', `project.json: ${msg}`);
    const wd = Math.max(...w.repos.map((s) => s.rel.length));
    for (const s of w.repos) ui.line(s.ok ? (s.changes || s.ahead || s.behind ? 'warn' : 'ok') : 'fail', `${s.rel.padEnd(wd)}  ${stateText(s)}${s.localOnly ? dim('  (no remote)') : ''}`);
    const mem = Object.entries(w.memories);
    if (mem.length) ui.note(`memory: ${mem.map(([k, v]) => `${k} → ${v}`).join(', ')}`);
  }
  return 0;
}

export async function projectSync(args, { ui }) {
  const o = flags(args, { memory: 'bool', 'dry-run': 'bool' });
  if (o.errors.length || o._.length > 1) return fail(ui, `${o.errors.join('; ') || 'one project at a time'} — usage: hoprig project sync [name] [--memory] [--dry-run]`);
  const dryRun = Boolean(o['dry-run'] || ui.dryRun);
  const roots = await pick(o._[0]);
  if (!roots.length) return fail(ui, o._[0] ? `no project "${o._[0]}"` : 'no projects yet');
  let todo = 0;
  for (const { root, ref, members } of roots) {
    ui.out(`\n${bold(ref)}`);
    const r = await syncWorkspace(root, { memory: o.memory, parent: members !== 'group', dryRun });
    if (r.memory) ui.line(r.memory.committed ? 'ok' : 'info', r.memory.committed ? 'memory committed' : `memory: ${r.memory.why}`);
    for (const x of r.repos) {
      ui.line(x.todo.length ? 'warn' : 'ok', `${x.rel.padEnd(28)} ${x.did.join(', ') || (x.state && x.state.ok ? stateText(x.state) : 'nothing to do')}`);
      for (const t of x.todo) ui.out(`      ${dim(t.why)}${t.command ? `\n      ${dim('→')} ${t.command}` : ''}`);
      todo += x.todo.length;
    }
  }
  return todo ? 1 : 0;
}

export async function projectLink(args, { ui }) {
  const o = flags(args, { 'dry-run': 'bool' });
  const roots = o._.length === 1 ? await pick(o._[0]) : [];
  const dryRun = Boolean(o['dry-run'] || ui.dryRun);
  const WOULD = { already: 'already linked', link: 'would link', merge: 'would move its files in, keep the old folder as a backup, then link', conflict: 'left alone' };
  const say = (plan) => {
    for (const p of plan) ui.line(p.action === 'conflict' ? 'warn' : 'info', `(dry run) memory for ${p.launch === '.' ? 'the project' : p.launch}: ${WOULD[p.action]}${p.detail ? ` (${p.detail}; ${p.fix})` : ''}`);
  };
  const groupLinks = async (only, keep = () => true) => {
    // In a group: the member's own memory, else the group's; the group's own folder its own (groups.mjs).
    const { groupsMap } = await import('../workspace/where.mjs');
    const { planGroupMemories } = await import('../workspace/groups.mjs');
    const { linkMemory } = await import('./workspace.mjs');
    const { workspaceDir } = await import('../workspace/layout.mjs');
    const plan = (await planGroupMemories(groupsMap(), { dir: workspaceDir(), projects: projectsDir() }, { only })).filter(keep);
    if (dryRun) say(plan);
    else report(ui, plan.map((p) => linkMemory(p)));
    return plan.length;
  };
  if (!o.errors.length && o._.length === 1 && !roots.length) {
    // A group that is a repository: its own folder's memory (what restore names for a group that was here).
    const { groupsMap } = await import('../workspace/where.mjs');
    const g = ((groupsMap() || {}).groups || []).find((x) => x.dir === o._[0] && x.url);
    if (g) {
      if (!(await groupLinks(g.dir, (p) => p.group === g.dir && !p.project))) ui.note(`no memory to link: ${g.dir} keeps none, or it is not on this computer`);
      return 0;
    }
  }
  if (o.errors.length || !roots.length) return fail(ui, 'usage: hoprig project link <name> [--dry-run]   (<place>/<name> for a project in a group, <group> for a group\'s own memory)');
  const at = roots[0];
  if (at.place) {
    if (!(await groupLinks(at.ref))) ui.note('no memory to link: neither the project nor its group keeps one');
    return 0;
  }
  const { manifest } = await readManifest(at.root);
  if (dryRun) say(planMemories(at.root, manifest.memories, { ref: at.ref }));
  else report(ui, linkMemories(at.root, manifest.memories, { ref: at.ref }));
  return 0;
}

/**
 * `project setup <name>`: what a fresh clone sets up, for a project that is here (finish.mjs): its memory link, git
 * hooks, a .env from .env.example, and each dependency install, asked. What `hoprig get` names for a project that was
 * already on the computer, where it changes nothing by itself.
 */
export async function projectSetup(args, { ui, runner = stream }) {
  const o = flags(args, { 'dry-run': 'bool', yes: 'bool' });
  const roots = o._.length === 1 ? await pick(o._[0]) : [];
  if (o.errors.length || !roots.length) return fail(ui, `${o.errors.length ? `${o.errors.join('; ')} — ` : o._.length === 1 ? `no project "${o._[0]}" — ` : ''}usage: hoprig project setup <name> [--dry-run] [--yes]`);
  if (o['dry-run']) ui.dryRun = true;
  if (o.yes) ui.yes = true;
  const at = roots[0];
  const m = await readManifest(at.root);
  if (!m.manifest) return fail(ui, `project.json was refused: ${m.errors.join('; ')}`);
  for (const r of m.manifest.repos) if (!fs.existsSync(path.join(at.root, r.dir))) ui.line('warn', `${r.dir} is not here yet: hoprig get ${at.ref} clones it`);
  const r = await finishProject(at.root, m.manifest, { ui, dir: projectsDir(), runner, ref: at.ref, memories: at.place ? await groupPlan(at.ref) : null }); // in a group: its own memory, else the group's, as get and restore
  if (!r.items) ui.line('ok', `${at.ref}: nothing to set up, it has all a fresh clone gets`);
  return 0;
}

export async function projectMain(args, { ui, write }) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'new': return projectNew(rest, { ui });
    case 'add': return projectAdd(rest, { ui });
    case 'clone': return (await import('./getproject.mjs')).getMain(rest, { ui, write });
    // A bare name in two places is refused with both <place>/<name> forms (where.mjs: the one rule).
    case 'status': case undefined: return projectStatus(rest, { ui, write }).catch((e) => fail(ui, e.message));
    case 'sync': return projectSync(rest, { ui }).catch((e) => fail(ui, e.message));
    case 'link': return projectLink(rest, { ui }).catch((e) => fail(ui, e.message));
    case 'setup': return projectSetup(rest, { ui }).catch((e) => fail(ui, e.message));
    default:
      ui.out('usage: hoprig project new|add|clone|status|sync|link|setup …   (see docs/PC-SETUP.md)');
      return 2;
  }
}
