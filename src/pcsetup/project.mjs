// `hoprig project …`: project workspaces (see workspace.mjs for the shape).
//   project new <name> [--template <folder or git address>] [--github | --remote <git address>] [--owner <o>]
//   project add <project> <name> [--github | --remote <git address>]     a code repository: code/<project>-<name>
//   project clone <name | owner/name | git address> [--yes]              the parent, every child, the memory links
//   project status [name] [--json]                                       parent and children: branch, changes, ahead/behind
//   project sync [name] [--memory]                                       fetch, fast-forward, push; never merge/rebase/force/stash
//   project link <name>                                                  link Claude Code's memory folders again
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { capture, stream } from '../setup/system.mjs';
import { bold, dim } from '../setup/ui.mjs';
import { cloneRepo, parseRepo, prepareEnv, projectsDir, rememberDir } from './projects.mjs';
import { offerInstall } from './setup.mjs';
import { sysFacts } from './detect.mjs';
import {
  MANIFEST, NAME_RE, builtinFiles, childCandidates, createGithubRepo, git, githubOwners, initRepo, linkMemories, listWorkspaces,
  parseProjectSpec, readManifest, readTemplate, syncWorkspace, useHooks, workspaceState, writeManifest, writeTemplate,
} from './workspace.mjs';

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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-template-'));
    const r = await stream(['git', 'clone', '--depth', '1', '--quiet', '--', repo.url, path.join(tmp, 't')], { onLine: (l) => ui.note(l) });
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
async function chooseOwner(ui, owners, given) {
  if (given) return owners.includes(given) || !owners.length ? given : null;
  if (owners.length <= 1 || ui.yes || !ui.interactive) return owners[0] || null;
  const k = await ui.choose('Which GitHub account?', owners.map((o, i) => ({ key: String(i + 1), label: o })), '1');
  return k ? owners[Number(k) - 1] : null;
}

/** Push a new local repository: to GitHub (private) or to a given address. */
async function publish(ui, dir, name, o, run) {
  if (o.remote) {
    const repo = parseRepo(o.remote);
    if (!repo) return ui.line('fail', `"${o.remote}" is not a Git address`) || null;
    await git(dir, ['remote', 'add', 'origin', repo.url]);
    const p = await run(['git', '-C', dir, 'push', '-u', 'origin', 'HEAD'], { onLine: (l) => ui.note(l) });
    ui.line(p.ok ? 'ok' : 'fail', p.ok ? `pushed to ${repo.url}` : `push failed — retry: git -C "${dir}" push -u origin HEAD`);
    return repo.url;
  }
  if (!o.github) return null;
  const owners = await githubOwners();
  if (!owners.length) return ui.line('warn', 'not signed in to GitHub (gh auth login): kept local only') || null;
  const owner = await chooseOwner(ui, owners, o.owner);
  if (!owner) return null;
  const r = await createGithubRepo(dir, owner, name, { onLine: (l) => ui.note(l), run });
  ui.line(r.ok ? 'ok' : 'fail', r.ok ? `private repository ${owner}/${name} created and pushed` : `gh repo create failed — retry: gh repo create ${owner}/${name} --private --source "${dir}" --remote origin --push`);
  return r.ok ? `https://github.com/${owner}/${name}.git` : null;
}

function report(ui, links) {
  for (const l of links) ui.line(l.done === 'conflict' ? 'warn' : 'ok', `memory for ${l.launch === '.' ? 'the project' : l.launch}: ${l.done}${l.detail ? ` (${l.detail}; ${l.fix})` : ''}`);
}

export async function projectNew(args, { ui, run = stream }) {
  const o = flags(args, { template: 'v', github: 'bool', remote: 'v', owner: 'v', 'no-github': 'bool' });
  const name = o._[0];
  if (o.errors.length || !name) return fail(ui, `${o.errors.join('; ') || 'a name is needed'} — usage: hoprig project new <name> [--template <folder|git address>] [--github | --remote <address>]`);
  if (!NAME_RE.test(name)) return fail(ui, 'a project name is letters, digits, ".", "_" and "-"');
  const root = path.join(projectsDir(), name);
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
    ui.note(`(dry run) would create ${root} from the ${t.from} template (${t.files.length} files)`);
    return 0;
  }
  // The first commit needs a name and an e-mail. Find out BEFORE anything is written, so a failure does not leave
  // a half-made project folder behind.
  const who = await Promise.all(['user.name', 'user.email'].map((k) => capture(['git', 'config', '--get', k], { timeout: 10_000 }).then((r) => (r.stdout || '').trim(), () => '')));
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
  report(ui, linkMemories(root, (await readManifest(root)).manifest.memories));
  rememberDir(projectsDir());
  const wantGithub = o.github || (!o.remote && !o['no-github'] && ui.interactive && !ui.yes && (await githubOwners()).length && (await ui.confirm('Create a private GitHub repository for it and push?', true)));
  await publish(ui, root, name, { ...o, github: wantGithub }, run);
  if (o.template && o.template !== cfg.projectTemplate && fs.existsSync(o.template) === false && parseRepo(o.template)) saveConfig({ projectTemplate: parseRepo(o.template).url });
  ui.out(`\nNext: ${bold(`hoprig project add ${name} <stack>`)}  ${dim('(a code repository in code/)')}`);
  return 0;
}

export async function projectAdd(args, { ui, run = stream }) {
  const o = flags(args, { github: 'bool', remote: 'v', owner: 'v' });
  const [project, sub] = o._;
  if (o.errors.length || !project || !sub) return fail(ui, 'usage: hoprig project add <project> <name> [--github | --remote <address>]');
  const root = path.join(projectsDir(), project);
  const repoName = sub.startsWith(`${project}-`) ? sub : `${project}-${sub}`;
  if (!NAME_RE.test(project) || !NAME_RE.test(repoName) || !fs.existsSync(path.join(root, '.git'))) return fail(ui, `no project "${project}" in ${projectsDir()}`);
  const dir = path.join(root, 'code', repoName);
  if (fs.existsSync(dir)) return fail(ui, `${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${repoName}\n\nPart of the ${project} project.\n`);
  const init = await initRepo(dir, `Start ${repoName}`);
  if (!init.ok) return fail(ui, `git could not make the first commit: ${init.error}`);
  ui.line('ok', `created ${dir}`);
  const url = await publish(ui, dir, repoName, o, run);
  const { manifest } = await readManifest(root);
  manifest.repos = manifest.repos.filter((r) => r.dir !== `code/${repoName}`);
  if (url) manifest.repos.push({ dir: `code/${repoName}`, url });
  else ui.line('warn', 'no remote yet: it is listed in project.json once it has one (run project add again with --github or --remote)');
  writeManifest(root, { ...manifest, repos: manifest.repos });
  if (url) {
    await git(root, ['add', '--', MANIFEST, 'ai_brain/claude-memory.json']);
    const c = await git(root, ['commit', '-q', '-m', `Add ${repoName}`, '--', MANIFEST]);
    if (c.ok) ui.line('ok', 'recorded in project.json and committed');
  }
  return 0;
}

/** Resolve "name" to an owner: the signed-in user and their organisations that have such a repository. */
async function resolveSpec(spec, ui) {
  const p = parseProjectSpec(spec);
  if (!p) return null;
  if (p.url) return p;
  const owners = await githubOwners();
  const have = [];
  for (const o of owners) if ((await capture(['gh', 'repo', 'view', `${o}/${p.name}`, '--json', 'name'], { timeout: 20_000 })).ok) have.push(o);
  if (!have.length) {
    ui.line('fail', owners.length ? `no repository "${p.name}" in ${owners.join(', ')}` : 'a bare name needs the GitHub sign-in (gh auth login); or give owner/name or a Git address');
    return null;
  }
  const owner = await chooseOwner(ui, have);
  return owner ? { url: `https://github.com/${owner}/${p.name}.git`, owner, name: p.name } : null;
}

/** Clone a project: the parent, every child, memory links, hooks, installs. Exported for recipes. */
export async function cloneProject(spec, { ui, dir = projectsDir(), runner = stream } = {}) {
  const p = await resolveSpec(spec, ui);
  if (!p) return 1;
  const root = path.join(dir, p.name);
  ui.out(`\n${bold(p.name)}  ${dim(p.url)}`);
  if (ui.dryRun) {
    ui.note(`(dry run) would clone ${p.url} into ${root}, then its code repositories, and link its memory`);
    return 0;
  }
  const c = await cloneRepo({ url: p.url, name: p.name }, dir, { onLine: (l) => ui.note(l), run: runner });
  if (!c.ok) return fail(ui, `clone failed — retry: git clone ${p.url} "${root}"`);
  const m = await readManifest(root);
  if (!m.manifest) return fail(ui, `project.json was refused: ${m.errors.join('; ')}`);
  let { manifest } = m;
  if (m.source !== MANIFEST && p.owner && !manifest.repos.length) {
    const cands = await childCandidates(p.owner, p.name);
    if (cands.length) {
      ui.out(`  Found ${cands.length} code repositor${cands.length > 1 ? 'ies' : 'y'} named ${p.name}-…:`);
      for (const k of cands) ui.out(`    ${k.name}`);
      const keep = ui.yes || !ui.interactive ? cands : (await ui.confirm('Clone all of them into code/?', true)) ? cands : [];
      manifest = { ...manifest, repos: keep.map((k) => ({ dir: `code/${k.name}`, url: k.url })) };
      writeManifest(root, manifest);
      ui.line('ok', 'wrote project.json');
      if (await ui.confirm('Commit project.json?', true)) await git(root, ['commit', '-q', '-m', 'Add project.json', '--', MANIFEST], capture);
    }
  }
  let failed = 0;
  for (const r of manifest.repos) {
    const dest = path.join(root, r.dir);
    if (!path.resolve(dest).startsWith(root + path.sep)) continue;
    const cr = await cloneRepo({ url: r.url, name: path.basename(dest) }, path.dirname(dest), { onLine: (l) => ui.note(l), run: runner });
    if (!cr.ok) {
      failed++;
      ui.line('fail', `${r.dir}: clone failed — retry: git clone ${r.url} "${dest}"`);
      continue;
    }
    if (r.branch && !cr.skipped) await git(dest, ['checkout', '-q', r.branch]);
    ui.line('ok', `${r.dir}${cr.skipped ? ' (was already there)' : ''}`);
  }
  report(ui, linkMemories(root, manifest.memories));
  for (const d of [root, ...manifest.repos.map((r) => path.join(root, r.dir))]) if (await useHooks(d)) ui.line('ok', `${path.relative(dir, d)}: git hooks from .githooks`);
  rememberDir(dir);
  const sys = await sysFacts();
  for (const d of [root, ...manifest.repos.map((r) => path.join(root, r.dir))]) {
    if (!fs.existsSync(d)) continue;
    prepareEnv(d, (l) => ui.line('info', l));
    await offerInstall(ui, d, runner, sys);
  }
  return failed ? 1 : 0;
}

const pick = (name) => {
  const dir = projectsDir();
  if (name) return NAME_RE.test(name) && fs.existsSync(path.join(dir, name, '.git')) ? [path.join(dir, name)] : [];
  return listWorkspaces(dir);
};

const stateText = (s) => (s.ok ? [s.branch, s.changes ? `${s.changes} changed` : '', s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} to pull` : '', s.upstream ? '' : 'no upstream'].filter(Boolean).join(' · ') : s.error);

export async function projectStatus(args, { ui, write }) {
  const o = flags(args, { json: 'bool', dir: 'v' });
  if (o.errors.length) return fail(ui, o.errors.join('; '));
  const base = o.dir ? path.resolve(o.dir) : projectsDir();
  const roots = o._[0] ? [path.join(base, o._[0])].filter((r) => NAME_RE.test(o._[0]) && fs.existsSync(path.join(r, '.git'))) : listWorkspaces(base);
  const all = await Promise.all(roots.map((r) => workspaceState(r)));
  if (o.json) {
    write(JSON.stringify({ projectsDir: base, projects: all }, null, 2) + '\n');
    return 0;
  }
  if (!all.length) ui.out(`No projects in ${base}${o._[0] ? ` named ${o._[0]}` : ''}.`);
  for (const w of all) {
    ui.out(`\n${bold(w.name)}  ${dim(`${w.root} · ${w.source === MANIFEST ? 'project.json' : 'no project.json (read from the folders)'}`)}`);
    const wd = Math.max(...w.repos.map((s) => s.rel.length));
    for (const s of w.repos) ui.line(s.ok ? (s.changes || s.ahead || s.behind ? 'warn' : 'ok') : 'fail', `${s.rel.padEnd(wd)}  ${stateText(s)}${s.localOnly ? dim('  (no remote)') : ''}`);
    const mem = Object.entries(w.memories);
    if (mem.length) ui.note(`memory: ${mem.map(([k, v]) => `${k} → ${v}`).join(', ')}`);
  }
  return 0;
}

export async function projectSync(args, { ui }) {
  const o = flags(args, { memory: 'bool' });
  const roots = pick(o._[0]);
  if (!roots.length) return fail(ui, o._[0] ? `no project "${o._[0]}"` : 'no projects yet');
  let todo = 0;
  for (const root of roots) {
    ui.out(`\n${bold(path.basename(root))}`);
    const r = await syncWorkspace(root, { memory: o.memory });
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
  const roots = pick(args[0]);
  if (!args[0] || !roots.length) return fail(ui, 'usage: hoprig project link <name>');
  const { manifest } = await readManifest(roots[0]);
  report(ui, linkMemories(roots[0], manifest.memories));
  return 0;
}

export async function projectMain(args, { ui, write }) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'new': return projectNew(rest, { ui });
    case 'add': return projectAdd(rest, { ui });
    case 'clone': {
      const o = flags(rest, { yes: 'bool' });
      if (o.yes) ui.yes = true;
      if (!o._[0]) return fail(ui, 'usage: hoprig project clone <name | owner/name | git address>');
      return cloneProject(o._[0], { ui });
    }
    case 'status': case undefined: return projectStatus(rest, { ui, write });
    case 'sync': return projectSync(rest, { ui });
    case 'link': return projectLink(rest, { ui });
    default:
      ui.out('usage: hoprig project new|add|clone|status|sync|link …   (see docs/PC-SETUP.md)');
      return 2;
  }
}
