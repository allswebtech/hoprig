// `hoprig get` / `project clone`: the folder is the project's name, whatever its parent repository is called (map
// name, else project.json's name, else the repository's name without "-workspace"), a bare name found as
// "<name>-workspace" or "<name>", and nothing that is there is ever moved or overwritten. Real git against bare
// repositories in a temporary folder, reached as https://github.com/<owner>/<repo>.git through git's insteadOf, and a
// stand-in for gh (fake-gh.mjs) first on PATH. No network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempHome, writeTree } from '../workspace/helpers.mjs';

const t = tempHome('get');
const remotes = path.join(t.root, 'remotes');
const bin = path.join(t.root, 'bin');
fs.mkdirSync(remotes);
fs.mkdirSync(bin);
fs.appendFileSync(process.env.GIT_CONFIG_GLOBAL, `[url "${remotes}/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n[protocol "file"]\n\tallow = always\n`);
const fakeGh = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${fakeGh}" "$@"\n`, { mode: 0o755 });
Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_ROOT: remotes, FAKE_GH_USER: 'alex', FAKE_GH_ORGS: 'team', HOPRIG_WORKSPACE_DIR: t.ws });

const { getProject, getMain, folderFromRepo } = await import('../../src/pcsetup/getproject.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { showCommand } = await import('../../src/setup/system.mjs');
const { projectNew, projectStatus } = await import('../../src/pcsetup/project.mjs');

const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
/** A repository on the stand-in GitHub with these files, one commit. */
function remote(full, files = { 'README.md': `# ${full}\n` }) {
  const work = path.join(t.root, 'work', full);
  writeTree(work, files);
  sh(work, 'init', '-q', '-b', 'main');
  sh(work, 'add', '-A');
  sh(work, 'commit', '-q', '-m', 'start');
  const b = path.join(remotes, `${full}.git`);
  execFileSync('git', ['clone', '-q', '--bare', work, b]);
  return `https://github.com/${full}.git`;
}
const parent = (name, extra = {}) => ({ 'AGENTS.md': '# rules\n', 'code/.gitignore': '*\n!.gitignore\n', 'project.json': JSON.stringify({ name, repos: [], memories: {}, ...extra }) });
let n = 0;
const fresh = () => {
  const d = path.join(t.root, `projects${++n}`);
  fs.mkdirSync(d);
  return d;
};
const quietUi = (o = {}) => {
  const lines = [];
  const ui = makeUi({ interactive: false, write: (s) => lines.push(s), ...o });
  ui.lines = lines;
  return ui;
};
const noMap = { projects: [] };
const run = (spec, dir, o = {}) => getProject(spec, { ui: quietUi(), dir, map: noMap, ...o });

// The stand-in GitHub: a project "shop" whose parent is shop-workspace and whose product is shop.
remote('alex/shop'); // the product: no project.json
remote('alex/shop-workspace', parent('shop', { repos: [{ dir: 'code/shop', url: 'https://github.com/alex/shop.git' }] }));
remote('alex/tools-workspace', { 'AGENTS.md': '# tools\n', 'code/.gitignore': '*\n' }); // a parent without project.json
remote('alex/tools-cli');
remote('alex/site-workspace', parent('website'));
remote('alex/blog'); // two candidates, neither a project parent
remote('alex/blog-workspace');
remote('alex/later-workspace', parent('later', { soonKey: ['some/thing'], futureKey: { a: 1 } }));

test.after(() => t.cleanup());

test('the folder name rule: "-workspace" is taken off, nothing else', () => {
  assert.equal(folderFromRepo('shop-workspace'), 'shop');
  assert.equal(folderFromRepo('shop-workspace.git'), 'shop');
  assert.equal(folderFromRepo('shop'), 'shop');
  assert.equal(folderFromRepo('workspace'), 'workspace');
  assert.equal(folderFromRepo('my-workspace-tools'), 'my-workspace-tools');
  // never a name that is not a plain folder name, or one of the folders the workspace never looks into
  for (const bad of ['.x', '...', '-rf', '', '.git', 'no-ai', 'credentials', 'node_modules', '-workspace']) assert.equal(folderFromRepo(bad), null, bad);
});

test('clone shop-workspace by address, by owner/name and by bare name: the folder is shop each time', async () => {
  for (const spec of ['https://github.com/alex/shop-workspace.git', 'alex/shop-workspace', 'shop']) {
    const dir = fresh();
    const r = await run(spec, dir);
    assert.equal(r.ok, true, `${spec}: ${r.message}`);
    assert.equal(r.result, 'cloned');
    assert.equal(r.folder, 'shop');
    assert.equal(r.url, 'https://github.com/alex/shop-workspace.git', spec); // the bare name took the parent, not the product
    assert.ok(fs.existsSync(path.join(dir, 'shop', 'project.json')), spec);
    assert.ok(fs.existsSync(path.join(dir, 'shop', 'code', 'shop', 'README.md')), spec); // its code repository
    assert.deepEqual(fs.readdirSync(dir), ['shop'], spec); // no temporary folder left
  }
});

test('rule 3 alone: a parent without project.json lands without "-workspace", and is not offered as its own code repository', async () => {
  const dir = fresh();
  const r = await run('alex/tools-workspace', dir);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.folder, 'tools');
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'tools', 'project.json'), 'utf8'));
  assert.deepEqual(pj.repos.map((x) => x.dir), ['code/tools-cli']); // never code/tools-workspace
  assert.equal(pj.name, 'tools'); // the folder's name, never the temporary one the clone was made under
  const { readManifest } = await import('../../src/pcsetup/workspace.mjs');
  const back = await readManifest(path.join(dir, 'tools'));
  assert.equal(back.errors, undefined);
  assert.equal(back.manifest.name, 'tools');
  assert.ok(fs.existsSync(path.join(dir, 'tools', 'code', 'tools-cli', 'README.md')));
});

test('rule 2: the name in project.json wins over the repository\'s name; rule 1: the map\'s name wins over both', async () => {
  const dir = fresh();
  const r = await run('alex/site-workspace', dir);
  assert.equal(r.folder, 'website');
  assert.ok(fs.existsSync(path.join(dir, 'website', '.git')));
  const dir2 = fresh();
  const map = { projects: [{ name: 'store', url: 'https://github.com/alex/shop-workspace.git', repos: [] }] };
  const byAddress = await run('alex/shop-workspace', dir2, { map });
  assert.equal(byAddress.folder, 'store');
  const dir3 = fresh();
  const byName = await run('store', dir3, { map }); // a bare name the map knows is never looked up on GitHub
  assert.equal(byName.folder, 'store');
  assert.equal(byName.url, 'https://github.com/alex/shop-workspace.git');
  assert.ok(fs.existsSync(path.join(dir3, 'store', 'code', 'shop', '.git')));
});

test('a bare name that fits two repositories, neither a project parent: one question on a terminal, an error without one', async () => {
  const dir = fresh();
  const r = await run('blog', dir);
  assert.equal(r.ok, false);
  assert.match(r.message, /alex\/blog-workspace, alex\/blog/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const writes = [];
  assert.equal(await getMain(['blog', '--json'], { dir, write: (s) => writes.push(s) }), 1);
  assert.match(JSON.parse(writes.join('')).projects[0].message, /cannot be told/);
  // on a terminal: asked once, the answer is used
  const ui = quietUi({ interactive: true });
  const asked = [];
  ui.choose = async (q, options) => (asked.push([q, options.map((o) => o.label)]), '1');
  ui.confirm = async () => true; // "clone its code repositories?": yes
  const a = await getProject('blog', { ui, dir, map: noMap });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0][1], ['alex/blog-workspace', 'alex/blog']);
  assert.equal(a.folder, 'blog');
  assert.equal(a.url, 'https://github.com/alex/blog-workspace.git');
  assert.ok(fs.existsSync(path.join(dir, 'blog', 'code', 'blog', '.git'))); // the product, offered as its code repository
});

test('the final name taken by another folder: the clone stays under its temporary name, it is said, nothing overwritten', async () => {
  const dir = fresh();
  writeTree(dir, { 'website/notes.txt': 'mine' });
  const r = await run('alex/site-workspace', dir);
  assert.equal(r.ok, false);
  assert.equal(r.result, 'taken');
  assert.equal(fs.readFileSync(path.join(dir, 'website', 'notes.txt'), 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'website')), ['notes.txt']);
  assert.ok(r.temp && fs.existsSync(path.join(r.temp, 'project.json')));
  assert.equal(path.dirname(r.temp), dir);
  assert.match(r.message, /is taken by another folder, so the clone was left in .*\.hoprig-clone-site-workspace-/);
  assert.match(r.message, /mv \S*\.hoprig-clone-site-workspace-[0-9a-f]+ \S*website/);
  assert.equal(r.fix, showCommand(['mv', r.temp, path.join(dir, 'website')])); // what the dashboard shows as needing you
});

test('a project here under the wrong name is reported with the mv, never moved', async () => {
  const dir = fresh();
  execFileSync('git', ['clone', '-q', 'https://github.com/alex/shop-workspace.git', path.join(dir, 'shop-workspace')]);
  const r = await run('shop', dir);
  assert.equal(r.result, 'misnamed');
  assert.equal(r.mv, showCommand(['mv', path.join(dir, 'shop-workspace'), path.join(dir, 'shop')]));
  assert.equal(r.ok, false); // not done: it needs you
  assert.equal(r.fix, r.mv);
  const out = [];
  assert.equal(await getMain(['shop', '--json'], { dir, write: (s) => out.push(s) }), 1);
  const j = JSON.parse(out.join(''));
  assert.deepEqual([j.ok, j.projects[0].ok, j.projects[0].result, j.projects[0].fix], [false, false, 'misnamed', r.mv]);
  assert.deepEqual(fs.readdirSync(dir), ['shop-workspace']); // not moved, nothing cloned
  // the same through the map
  const m = await run('store', dir, { map: { projects: [{ name: 'store', url: 'https://github.com/alex/shop-workspace.git', repos: [] }] } });
  assert.equal(m.result, 'misnamed');
  assert.match(m.mv, /\/store$/);
  // under its right name it is "here", and its missing code repository is cloned
  fs.renameSync(path.join(dir, 'shop-workspace'), path.join(dir, 'shop'));
  const h = await run('shop', dir);
  assert.equal(h.result, 'here');
  assert.ok(fs.existsSync(path.join(dir, 'shop', 'code', 'shop', '.git')));
});

test('a project.json with a key this Hoprig does not know: the clone works, the key stays, a warning is shown', async () => {
  const dir = fresh();
  const ui = quietUi();
  const r = await getProject('alex/later-workspace', { ui, dir, map: noMap });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.folder, 'later');
  assert.equal(r.warnings.length, 2);
  assert.match(ui.lines.join(''), /project\.json: unknown key "soonKey" \(kept/);
  const writes = [];
  await projectStatus(['later', '--dir', dir, '--json'], { ui, write: (s) => writes.push(s) });
  assert.equal(JSON.parse(writes.join('')).projects[0].warnings.length, 2);
});

test('hoprig get a b --json: both cloned, one JSON object; --dry-run changes nothing', async () => {
  const dir = fresh();
  const dry = [];
  assert.equal(await getMain(['shop', 'alex/site-workspace', '--json', '--dry-run'], { dir, write: (s) => dry.push(s) }), 0);
  const d = JSON.parse(dry.join(''));
  assert.equal(d.dryRun, true);
  // the dry run reads project.json's name without a clone (gh api) and says where each name came from
  assert.deepEqual(d.projects.map((p) => [p.result, p.url, path.basename(p.dir), p.nameFrom]), [
    ['would clone', 'https://github.com/alex/shop-workspace.git', 'shop', 'project.json'],
    ['would clone', 'https://github.com/alex/site-workspace.git', 'website', 'project.json'],
  ]);
  assert.match(d.projects[1].message, /into .*website \(the name its project\.json gives\)/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const out = [];
  assert.equal(await getMain(['shop', 'alex/site-workspace', '--json'], { dir, write: (s) => out.push(s) }), 0);
  const j = JSON.parse(out.join('')); // exactly one JSON object on the output
  assert.equal(j.ok, true);
  assert.deepEqual(j.projects.map((p) => [p.result, p.folder]), [['cloned', 'shop'], ['cloned', 'website']]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['shop', 'website']);
});

test('project new x --github: the parent is x-workspace when the account has a repository x already; --repo-name overrides', async () => {
  const { projectsDir } = await import('../../src/pcsetup/projects.mjs');
  remote('alex/cart'); // the product is there first
  assert.equal(await projectNew(['cart', '--github'], { ui: quietUi() }), 0);
  const root = path.join(projectsDir(), 'cart');
  assert.equal(sh(root, 'config', '--get', 'remote.origin.url'), 'https://github.com/alex/cart-workspace.git');
  assert.ok(fs.existsSync(path.join(remotes, 'alex', 'cart-workspace.git')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).name, 'cart');
  // --repo-name without --github: said to be ignored
  const said = quietUi();
  assert.equal(await projectNew(['quiet', '--repo-name', 'quiet-parent'], { ui: said }), 0);
  assert.match(said.lines.join(''), /--repo-name names the GitHub repository, so without --github it is ignored/);
  // nothing named like it yet: the parent takes the project's name
  assert.equal(await projectNew(['fresh', '--github'], { ui: quietUi() }), 0);
  assert.equal(sh(path.join(projectsDir(), 'fresh'), 'config', '--get', 'remote.origin.url'), 'https://github.com/alex/fresh.git');
  assert.equal(await projectNew(['own', '--github', '--repo-name', 'own-parent'], { ui: quietUi() }), 0);
  assert.equal(sh(path.join(projectsDir(), 'own'), 'config', '--get', 'remote.origin.url'), 'https://github.com/alex/own-parent.git');
  // and it comes back into the folder "cart" on another computer
  const dir = fresh();
  const r = await run('cart', dir);
  assert.equal(r.url, 'https://github.com/alex/cart-workspace.git');
  assert.equal(r.folder, 'cart');
});

test('restore uses the map\'s name; a project here under another name is reported with the mv, not cloned again', async () => {
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const { mapStatus } = await import('../../src/workspace/map.mjs');
  const shop = 'https://github.com/alex/shop-workspace.git';
  const brain = remote('alex/brain', { 'workspace.json': JSON.stringify({ version: 1, brain: { url: 'https://github.com/alex/brain.git' }, projects: [{ name: 'store', url: shop, repos: [{ dir: 'code/shop', url: 'https://github.com/alex/shop.git' }] }], others: [] }) });
  const ws1 = path.join(t.root, 'ws-restore1');
  const r1 = await restoreWorkspace(brain, { withProjects: true, ui: quietUi(), dir: ws1, projects: path.join(ws1, 'projects') });
  assert.equal(r1.ok, true);
  assert.ok(fs.existsSync(path.join(ws1, 'projects', 'store', 'code', 'shop', '.git'))); // the map's name, not project.json's "shop"

  const ws2 = path.join(t.root, 'ws-restore2');
  const projects = path.join(ws2, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  execFileSync('git', ['clone', '-q', shop, path.join(projects, 'shop-workspace')]);
  const r2 = await restoreWorkspace(brain, { withProjects: true, ui: quietUi(), dir: ws2, projects });
  const e = r2.plan.find((x) => x.kind === 'project');
  assert.equal(e.action, 'misnamed');
  assert.equal(e.mv, showCommand(['mv', path.join(projects, 'shop-workspace'), path.join(projects, 'store')]));
  assert.match(e.result, /^left alone: it is here as shop-workspace/);
  assert.deepEqual(fs.readdirSync(projects), ['shop-workspace']); // nothing moved, nothing cloned twice
  const ms = await mapStatus({ dir: ws2, projects });
  const missing = ms.entries.find((x) => x.label === 'store');
  assert.equal(missing.state, 'missing');
  assert.equal(missing.fix, `it is here as shop-workspace: ${showCommand(['mv', path.join(projects, 'shop-workspace'), path.join(projects, 'store')])}`);
});

test('one rule for "the same address": ssh or https, owner and repository in any case, with or without .git', async () => {
  const { sameUrl } = await import('../../src/workspace/map.mjs');
  const same = ['https://github.com/alex/shop-workspace.git', 'https://github.com/alex/shop-workspace', 'https://github.com/alex/shop-workspace/', 'git@github.com:alex/shop-workspace.git', 'ssh://git@github.com/alex/shop-workspace', 'https://GitHub.com/Alex/Shop-Workspace.git'];
  for (const u of same) assert.ok(sameUrl(u, same[0]), u);
  assert.equal(sameUrl('https://git.example.com/team/app', 'https://git.example.com/Team/App'), false); // another server may tell case apart
  assert.ok(sameUrl('git@git.example.com:team/app.git', 'https://git.example.com/team/app'));
  assert.equal(sameUrl('https://github.com/alex/shop', 'https://github.com/alex/shop-workspace'), false);

  // A project here under its right name, cloned over ssh: "already there", finished, never a second clone.
  const dir = fresh();
  execFileSync('git', ['clone', '-q', 'git@github.com:alex/shop-workspace.git', path.join(dir, 'shop')]);
  const r = await run('alex/shop-workspace', dir);
  assert.equal(r.result, 'here', r.message);
  assert.ok(fs.existsSync(path.join(dir, 'shop', 'code', 'shop', '.git'))); // its code repository
  assert.deepEqual(fs.readdirSync(dir), ['shop']); // no hidden second clone
  const c = await run('https://github.com/Alex/Shop-Workspace/', dir);
  assert.equal(c.result, 'here', c.message);
  assert.deepEqual(fs.readdirSync(dir), ['shop']);
});

test('two map entries with one address: the one here is in its place, never offered as the other\'s misnamed copy', async () => {
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const app = remote('alex/app', { 'AGENTS.md': 'x\n', 'code/.gitignore': '*\n' });
  const map = { version: 1, brain: { url: 'https://github.com/alex/brain2.git' }, projects: [{ name: 'app', url: app, repos: [] }, { name: 'app-second', url: app, repos: [] }], others: [] };
  const brain = remote('alex/brain2', { 'workspace.json': JSON.stringify(map) });
  const ws = path.join(t.root, 'ws-two');
  const projects = path.join(ws, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  execFileSync('git', ['clone', '-q', app, path.join(projects, 'app')]);
  const r = await restoreWorkspace(brain, { withProjects: true, ui: quietUi(), dir: ws, projects });
  const plan = Object.fromEntries(r.plan.filter((x) => x.kind === 'project').map((x) => [x.label, x]));
  assert.equal(plan.app.action, 'here');
  assert.equal(plan['app-second'].action, 'clone'); // its own clone, as the map says; no mv of app
  assert.equal(plan['app-second'].mv, undefined);
  assert.deepEqual(fs.readdirSync(projects).sort(), ['app', 'app-second']);
  // hoprig get the second one: cloned into its own folder, app is left as it is
  const dir = fresh();
  execFileSync('git', ['clone', '-q', app, path.join(dir, 'app')]);
  const g = await run('app-second', dir, { map });
  assert.equal(g.result, 'cloned', g.message);
  assert.equal(g.mv, undefined);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['app', 'app-second']);
});

test('"Commit project.json?" answered yes: the written file is added and committed, nothing else', async () => {
  const dir = fresh();
  const r = await getProject('alex/tools-workspace', { ui: quietUi({ yes: true }), dir, map: noMap });
  assert.equal(r.ok, true, r.message);
  const root = path.join(dir, 'tools');
  assert.equal(sh(root, 'log', '-1', '--format=%s'), 'Add project.json');
  assert.deepEqual(sh(root, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['project.json']);
  assert.equal(sh(root, 'status', '--porcelain', '--', 'project.json'), '');
});

test('an address whose repository name makes no plain folder name is refused before anything is cloned', async () => {
  const dir = fresh();
  for (const spec of ['alex/.x', 'alex/-rf', 'alex/.git', 'https://github.com/alex/no-ai.git']) {
    const r = await run(spec, dir);
    assert.equal(r.result, 'refused', spec);
    assert.match(r.message, /does not make a folder name/, spec);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('project.json\'s name is used only when it is a folder the workspace looks into and the map does not hold it for another repository', async () => {
  remote('alex/squat', parent('shop'));
  remote('alex/evil', parent('no-ai'));
  remote('bob/shop-workspace', parent('shop'));
  const shopUrl = 'https://github.com/alex/shop-workspace.git';
  // A workspace with a brain whose map has shop = alex/shop-workspace, not on this computer.
  const ws = path.join(t.root, 'ws-names');
  const projects = path.join(ws, 'projects');
  writeTree(path.join(ws, 'ai_brain'), { 'workspace.json': JSON.stringify({ version: 1, brain: { url: null }, projects: [{ name: 'shop', url: shopUrl, repos: [] }], others: [] }) });
  fs.mkdirSync(projects);
  const was = process.env.HOPRIG_WORKSPACE_DIR;
  process.env.HOPRIG_WORKSPACE_DIR = ws;
  try {
    const ui = quietUi();
    const r = await getProject('alex/squat', { ui, dir: projects }); // the map read from the brain
    assert.equal(r.result, 'cloned', r.message);
    assert.equal(r.folder, 'squat');
    assert.equal(r.nameFrom, 'repository');
    assert.equal(r.note, 'its project.json names it shop, which your map uses for another repository');
    assert.match(ui.lines.join(''), /names it shop, which your map uses for another repository/);
    const map = JSON.parse(fs.readFileSync(path.join(ws, 'ai_brain', 'workspace.json'), 'utf8'));
    assert.equal(map.projects.find((p) => p.name === 'shop').url, shopUrl); // the other entry never changed
    assert.ok(!fs.existsSync(path.join(projects, 'shop')));
    // the same in a dry run, from project.json read without a clone
    const dry = await getProject('alex/squat', { ui: quietUi({ dryRun: true }), dir: fresh(), map: { projects: [{ name: 'shop', url: shopUrl, repos: [] }] } });
    assert.deepEqual([dry.folder, dry.nameFrom, dry.note], ['squat', 'repository', r.note]);
    // a repository whose own name is the map's too: not cloned into that folder; left aside with the mv
    const b = await getProject('https://github.com/bob/shop-workspace.git', { ui: quietUi(), dir: projects });
    assert.equal(b.result, 'taken');
    assert.match(b.message, /your workspace map uses shop for another repository \(https:\/\/github.com\/alex\/shop-workspace.git\)/);
    assert.ok(b.temp && fs.existsSync(b.temp));
    assert.ok(!fs.existsSync(path.join(projects, 'shop')));
  } finally {
    process.env.HOPRIG_WORKSPACE_DIR = was;
  }
  // a private folder name in project.json: the repository's name instead
  const dir = fresh();
  const e = await run('alex/evil', dir);
  assert.deepEqual([e.result, e.folder, e.nameFrom], ['cloned', 'evil', 'repository']);
  assert.match(e.note, /names it no-ai, a folder name the workspace never looks into/);
  assert.deepEqual(fs.readdirSync(dir), ['evil']);
  // every result says where its folder's name came from
  assert.equal((await run('alex/site-workspace', fresh())).nameFrom, 'project.json');
  assert.equal((await run('alex/tools-workspace', fresh())).nameFrom, 'repository');
  assert.equal((await run('alex/shop-workspace', fresh(), { map: { projects: [{ name: 'store', url: shopUrl, repos: [] }] } })).nameFrom, 'map');
});

test('a project here under its repository\'s name whose project.json names another is reported with the mv', async () => {
  const dir = fresh();
  execFileSync('git', ['clone', '-q', 'https://github.com/alex/site-workspace.git', path.join(dir, 'site')]);
  const r = await run('alex/site-workspace', dir);
  assert.equal(r.result, 'misnamed');
  assert.equal(r.nameFrom, 'project.json');
  assert.equal(r.mv, showCommand(['mv', path.join(dir, 'site'), path.join(dir, 'website')]));
  assert.deepEqual(fs.readdirSync(dir), ['site']); // never moved
  // unless that name is one the map holds for another repository: then site is its right name
  const m = await run('alex/site-workspace', dir, { map: { projects: [{ name: 'website', url: 'https://github.com/alex/other.git', repos: [] }] } });
  assert.equal(m.result, 'here', m.message);
  assert.equal(m.folder, 'site');
  assert.match(m.note, /names it website, which your map uses for another repository/);
});

test('the rename step: a link at the final name (to an empty folder, to nothing) or a folder that comes in between is "taken", never overwritten', async () => {
  const { cloneProject } = await import('../../src/pcsetup/project.mjs');
  const check = (r, dir) => {
    assert.equal(r.result, 'taken', r.message);
    assert.match(r.message, /is taken by another folder, so the clone was left in/);
    assert.equal(r.fix, showCommand(['mv', r.temp, path.join(dir, 'website')]));
    assert.ok(fs.existsSync(path.join(r.temp, 'project.json')));
  };
  // a link to an empty folder: the link and its folder stay; the callback gets the result
  let dir = fresh();
  const empty = path.join(t.root, `empty-target-${n}`);
  fs.mkdirSync(empty);
  fs.symlinkSync(empty, path.join(dir, 'website'));
  let got = null;
  // Never asked to remove the link: where rmdir removes a link to a folder (Windows), following it would lose it.
  const rmdir = fs.rmdirSync;
  const removed = [];
  fs.rmdirSync = (p, ...rest) => (removed.push(p), rmdir(p, ...rest));
  try {
    assert.equal(await cloneProject('alex/site-workspace', { ui: quietUi(), dir, map: noMap, onDone: (r) => (got = r) }), 1);
  } finally {
    fs.rmdirSync = rmdir;
  }
  assert.ok(!removed.includes(path.join(dir, 'website')), 'rmdir was called on the link');
  check(got, dir);
  assert.ok(fs.lstatSync(path.join(dir, 'website')).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(empty), []);
  // a link to nothing
  dir = fresh();
  fs.symlinkSync(path.join(t.root, 'nothing-here'), path.join(dir, 'website'));
  check(await run('alex/site-workspace', dir), dir);
  assert.ok(fs.lstatSync(path.join(dir, 'website')).isSymbolicLink());
  // a folder with something in it comes there between the look and the rename
  dir = fresh();
  const rename = fs.renameSync;
  fs.renameSync = (a, b) => {
    fs.renameSync = rename;
    writeTree(dir, { 'website/mine.txt': 'mine' });
    return rename(a, b);
  };
  try {
    check(await run('alex/site-workspace', dir), dir);
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'website')), ['mine.txt']);
});

test('a bare name that fits a project parent in two accounts: without a terminal, --json or --yes an error names both', async (tc) => {
  remote('team/site-workspace', parent('website'));
  const dir = fresh();
  const was = process.env.HOPRIG_WORKSPACE_DIR;
  process.env.HOPRIG_WORKSPACE_DIR = path.join(t.root, 'ws-no-map'); // a bare name the map knows is never looked up
  tc.after(() => (process.env.HOPRIG_WORKSPACE_DIR = was));
  for (const args of [['site', '--json'], ['site', '--json', '--dry-run'], ['site', '--yes', '--json']]) {
    const out = [];
    const code = await getMain(args, { dir, write: (s) => out.push(s) });
    assert.equal(code, 1, `${args.join(' ')}: ${out.join('')}`);
    const p = JSON.parse(out.join('')).projects[0];
    assert.equal(p.result, 'refused');
    assert.match(p.message, /"site" fits 2 repositories \(alex\/site-workspace, team\/site-workspace\)/);
    assert.deepEqual(p.choices, ['alex/site-workspace', 'team/site-workspace']);
  }
  assert.equal((await run('site', dir)).result, 'refused'); // no terminal
  assert.deepEqual(fs.readdirSync(dir), []);
  // on a terminal: which account is asked, and the answer is used
  const ui = quietUi({ interactive: true });
  ui.choose = async (q, options) => (assert.match(q, /Which GitHub account/), assert.deepEqual(options.map((o) => o.label), ['alex', 'team']), '2');
  const r = await getProject('site', { ui, dir, map: noMap });
  assert.equal(r.url, 'https://github.com/team/site-workspace.git');
  assert.equal(r.folder, 'website');
});

test('a bare name in another letter case, or a repository renamed on GitHub (it answers under both names), is one repository', async () => {
  // Shop: GitHub answers with the real names, shop-workspace and shop; the parent wins as before
  let dir = fresh();
  const r = await run('Shop', dir);
  assert.equal(r.result, 'cloned', r.message);
  assert.equal(r.url, 'https://github.com/alex/shop-workspace.git');
  assert.equal(r.folder, 'shop');
  // blog2 was renamed to blog2-workspace: "blog2" and "blog2-workspace" are the same repository, not two to choose from
  remote('alex/blog2-workspace', parent('blog2'));
  fs.writeFileSync(path.join(remotes, 'alex', 'renamed.json'), JSON.stringify({ blog2: 'blog2-workspace' }));
  fs.symlinkSync('blog2-workspace.git', path.join(remotes, 'alex', 'blog2.git'));
  dir = fresh();
  const b = await run('blog2', dir);
  assert.equal(b.result, 'cloned', b.message);
  assert.equal(b.url, 'https://github.com/alex/blog2-workspace.git');
  assert.deepEqual(fs.readdirSync(dir), ['blog2']);
});

test('leftovers: a complete clone an earlier run left is finished, not cloned again; an unfinished one is moved aside, never deleted', async () => {
  const site = 'https://github.com/alex/site-workspace.git';
  const { tempNameFor } = await import('../../src/pcsetup/leftovers.mjs');
  const tempName = tempNameFor({ url: site, repo: 'site-workspace' });
  // a run killed after its clone: used and finished
  let dir = fresh();
  const left = path.join(dir, tempName);
  execFileSync('git', ['clone', '-q', site, left]);
  fs.writeFileSync(path.join(left, '.git', 'from-the-earlier-run'), '');
  let ui = quietUi();
  let r = await getProject('alex/site-workspace', { ui, dir, map: noMap });
  assert.equal(r.result, 'cloned', r.message);
  assert.ok(fs.existsSync(path.join(dir, 'website', '.git', 'from-the-earlier-run'))); // the same clone, not a new one
  assert.deepEqual(fs.readdirSync(dir), ['website']);
  assert.match(ui.lines.join(''), /a complete clone an earlier run left here is used/);

  // an unfinished one (no commit checked out; a file missing): moved aside under a dated name, then a fresh clone
  for (const unfinished of [(p) => fs.mkdirSync(path.join(p, '.git'), { recursive: true }), (p) => (execFileSync('git', ['clone', '-q', site, p]), fs.rmSync(path.join(p, 'AGENTS.md')))]) {
    dir = fresh();
    unfinished(path.join(dir, tempName));
    ui = quietUi();
    r = await getProject('alex/site-workspace', { ui, dir, map: noMap });
    assert.equal(r.result, 'cloned', r.message);
    const names = fs.readdirSync(dir).sort();
    assert.equal(names.length, 2, names.join(' '));
    assert.ok(names.includes('website'));
    assert.ok(names.some((x) => x.startsWith(`${tempName}.aside-`) && /\.aside-\d{8}-\d{6}$/.test(x)), names.join(' '));
    assert.match(ui.lines.join(''), /moved aside \(nothing deleted\)/);
  }

  // a clone left because its folder name was taken: once the way is clear, a re-run finishes that clone
  dir = fresh();
  writeTree(dir, { 'website/notes.txt': 'mine' });
  const taken = await run('alex/site-workspace', dir);
  assert.equal(taken.result, 'taken');
  fs.writeFileSync(path.join(taken.temp, '.git', 'first'), '');
  fs.renameSync(path.join(dir, 'website'), path.join(dir, 'notes'));
  r = await run('alex/site-workspace', dir);
  assert.equal(r.result, 'cloned', r.message);
  assert.ok(fs.existsSync(path.join(dir, 'website', '.git', 'first')));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes', 'website']);

  // workspace status lists what is left, with what to do
  dir = fresh();
  execFileSync('git', ['clone', '-q', site, path.join(dir, tempName)]);
  fs.mkdirSync(path.join(dir, '.hoprig-clone-x-dddddd.aside-20261117-101010'));
  const { rememberDir } = await import('../../src/pcsetup/projects.mjs');
  rememberDir(dir);
  const { main } = await import('../../src/workspace/cli.mjs');
  const out = [];
  assert.equal(await main(['status', '--json'], { ui: quietUi(), write: (s) => out.push(s) }), 0);
  const lo = JSON.parse(out.join('')).leftovers;
  assert.deepEqual(lo.map((l) => [path.basename(l.path), l.complete, l.aside]), [[tempName, true, false], ['.hoprig-clone-x-dddddd.aside-20261117-101010', false, true]]);
  assert.equal(lo[0].fix, `hoprig get ${site}`);
  assert.match(lo[1].fix, /^look at it, then remove it: {2}rm -rf \S*aside-20261117-101010$/);
  const text = quietUi();
  await main(['status'], { ui: text, write: () => {} });
  assert.match(text.lines.join(''), /Left by hoprig get/);
  assert.match(text.lines.join(''), /a complete clone: finish it with {2}hoprig get https:\/\/github.com\/alex\/site-workspace.git/);
});

test('two runs at once for one address: the second says the project is being fetched by another run', async () => {
  const dir = fresh();
  const [a, b] = await Promise.all([run('alex/site-workspace', dir), run('alex/site-workspace', dir)]);
  assert.equal(a.result, 'cloned', a.message);
  assert.equal(b.result, 'busy');
  assert.equal(b.ok, false);
  assert.match(b.message, /^site is being fetched by another run of Hoprig right now \(process \d+\)/);
  assert.deepEqual(fs.readdirSync(dir), ['website']); // no second clone, no lock left
  // a lock whose run is gone is taken over
  const gone = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const dir2 = fresh();
  const { createHash } = await import('node:crypto');
  const { urlKey } = await import('../../src/workspace/map.mjs');
  fs.writeFileSync(path.join(dir2, `.hoprig-clone-${createHash('sha256').update(urlKey('https://github.com/alex/site-workspace.git')).digest('hex').slice(0, 8)}.lock`), `${gone}\n`);
  const c = await run('alex/site-workspace', dir2);
  assert.equal(c.result, 'cloned', c.message);
  assert.deepEqual(fs.readdirSync(dir2), ['website']);
});

test('the same address: the scheme\'s own port and the scp-like form with an absolute path; different repositories never share a key', async () => {
  const { sameUrl } = await import('../../src/workspace/map.mjs');
  const same = [
    ['ssh://git@github.com:22/alex/shop', 'git@github.com:alex/shop'],
    ['https://github.com:443/alex/shop', 'https://github.com/alex/shop'],
    ['http://git.example.org:80/team/app', 'https://git.example.org/team/app'],
    ['git@git.example.org:/srv/repo.git', 'ssh://git@git.example.org/srv/repo'],
    ['ssh://git@git.example.org:022/team/app', 'git@git.example.org:team/app'],
  ];
  for (const [a, b] of same) assert.ok(sameUrl(a, b), `${a} = ${b}`);
  const differ = [
    ['ssh://git@git.example.org:2222/team/app', 'git@git.example.org:team/app'], // another port
    ['https://git.example.org:8443/team/app', 'https://git.example.org/team/app'],
    ['https://github.com:22/alex/shop', 'https://github.com/alex/shop'], // 22 is not the port of https
    ['http://git.example.org:443/team/app', 'http://git.example.org/team/app'], // nor 443 that of http
    ['git@git.example.org:team/app', 'git@git.example.net:team/app'], // another host
    ['https://github.com/alex/shop', 'https://github.com/bob/shop'], // another owner
    ['https://git.example.org/Team/App', 'https://git.example.org/team/app'], // a site where case matters
    ['git@git.example.org:/srv/a', 'ssh://git@git.example.org/srv/b'], // another path
    ['file:///srv/repo', 'git@file:srv/repo'], // a local address is not an ssh host called "file"
  ];
  for (const [a, b] of differ) assert.equal(sameUrl(a, b), false, `${a} ≠ ${b}`);
});

test('a command printed for the owner to paste runs as it reads: a quote, a dollar sign, a space and a backtick in the path', async () => {
  const mark = path.join(t.root, 'ran-it');
  const dir = path.join(t.root, `my "pro$(touch ${mark})jects \`touch ${mark}\` it's`);
  writeTree(dir, { 'website/notes.txt': 'mine' });
  const r = await run('alex/site-workspace', dir);
  assert.equal(r.result, 'taken', r.message);
  fs.renameSync(path.join(dir, 'website'), path.join(dir, 'notes')); // the owner looked at both and moved one aside
  execFileSync('sh', ['-c', r.fix]);
  assert.ok(fs.existsSync(path.join(dir, 'website', 'project.json')), 'the clone is in its place');
  // the leftovers' "remove it" line
  fs.mkdirSync(path.join(dir, '.hoprig-clone-x-dddddd.aside-20261117-101010'));
  const { findLeftovers } = await import('../../src/pcsetup/leftovers.mjs');
  const [l] = await findLeftovers(dir);
  execFileSync('sh', ['-c', l.fix.split('remove it:  ')[1]]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes', 'website']);
  assert.equal(fs.existsSync(mark), false, 'nothing in the folder name ran');
});

test('the map\'s folder holds a clone of another repository: "taken", needing the owner, with the folder in the way and its address', async () => {
  const dir = fresh();
  execFileSync('git', ['clone', '-q', 'https://github.com/alex/blog.git', path.join(dir, 'shop')]);
  const r = await run('https://github.com/alex/shop-workspace.git', dir, { map: { projects: [{ name: 'shop', url: 'https://github.com/alex/shop-workspace.git', repos: [] }] } });
  assert.equal(r.result, 'taken');
  assert.equal(r.ok, false);
  assert.ok(r.fix && r.fix.startsWith(`mv ${path.join(dir, 'shop')} ${path.join(dir, 'shop.aside-')}`), r.fix);
  assert.match(r.message, /shop is in the way: it is a clone of https:\/\/github\.com\/alex\/blog\.git, not of https:\/\/github\.com\/alex\/shop-workspace\.git/);
  assert.deepEqual(fs.readdirSync(dir), ['shop']); // nothing cloned, nothing moved
});

test('a lock names the process of its run: a pid another process has now, or a bare number, does not block; status lists the lock', async () => {
  const { lockPathFor, findLocks, LOCK_MAX_AGE } = await import('../../src/pcsetup/leftovers.mjs');
  const { system } = await import('../../src/procid.mjs');
  const { spawn } = await import('node:child_process');
  const r = { url: 'https://github.com/alex/site-workspace.git', repo: 'site-workspace' };
  // a lock holding 1 (an old bare pid, or anything not written by this Hoprig) and a lock whose pid is a live process
  // that is not its writer (another identity): taken over, cloned
  const writeLock = (dir, text, age = 0) => {
    const f = lockPathFor(dir, r);
    fs.mkdirSync(path.dirname(f), { recursive: true }); // in the state folder, one folder per place
    fs.writeFileSync(f, text);
    if (age) fs.utimesSync(f, new Date(Date.now() - age), new Date(Date.now() - age));
    return f;
  };
  // The live process is one of this test's own (a sleeper), so that every system can tell its start (on macOS the
  // suite's ps answers only for the test's processes); the lock names the process that had its pid before it, in this
  // system's own form (src/procid.mjs compares no identities of two forms).
  const { earlierIdentity } = await import('../server/helpers.mjs');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise((res) => other.once('spawn', res));
    const now = system.of([other.pid]).get(other.pid);
    assert.ok(now, 'this system tells the start of a process of this test\'s');
    for (const text of ['1\n', JSON.stringify({ pid: other.pid, proc: earlierIdentity(now) })]) {
      const dir = fresh();
      writeLock(dir, text);
      const c = await run('alex/site-workspace', dir);
      assert.equal(c.result, 'cloned', `${text}: ${c.message}`);
      assert.deepEqual(fs.readdirSync(dir), ['website']);
    }
  } finally {
    other.kill('SIGKILL');
  }
  // the run that wrote it goes on: busy, and the message names the lock and how to remove it
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise((res) => child.once('spawn', res));
    let dir = fresh();
    const f = writeLock(dir, JSON.stringify({ pid: child.pid, proc: system.of([child.pid]).get(child.pid) }));
    const b = await run('alex/site-workspace', dir);
    assert.equal(b.result, 'busy', b.message);
    assert.ok(b.message.includes(`(process ${child.pid})`), b.message);
    assert.ok(b.message.endsWith(`If no hoprig get is running, removing its lock is safe:  rm ${f}`), b.message);
    assert.deepEqual(findLocks(dir).map((l) => [l.path, l.pid, l.running]), [[f, child.pid, true]]);
    // its identity cannot be told (none in the lock): trusted while young, taken over once older than LOCK_MAX_AGE
    dir = fresh();
    writeLock(dir, JSON.stringify({ pid: child.pid, proc: null }));
    assert.equal((await run('alex/site-workspace', dir)).result, 'busy');
    writeLock(dir, JSON.stringify({ pid: child.pid, proc: null }), LOCK_MAX_AGE + 60_000);
    assert.equal(findLocks(dir)[0].running, false);
    assert.equal((await run('alex/site-workspace', dir)).result, 'cloned');
    // workspace status lists a lock with whether its run goes on
    dir = fresh();
    writeLock(dir, '1\n');
    const { rememberDir } = await import('../../src/pcsetup/projects.mjs');
    rememberDir(dir);
    const { main } = await import('../../src/workspace/cli.mjs');
    const out = [];
    assert.equal(await main(['status', '--json'], { ui: quietUi(), write: (s) => out.push(s) }), 0);
    assert.deepEqual(JSON.parse(out.join('')).locks, [{ path: lockPathFor(dir, r), pid: null, running: false }]);
    const text = quietUi();
    await main(['status'], { ui: text, write: () => {} });
    assert.match(text.lines.join(''), /a lock of hoprig get: its run has ended; the next hoprig get takes it over, and removing it is safe/);
  } finally {
    child.kill();
  }
});

test('a stale lock taken over by two runs at once: one of them holds it, never both', async () => {
  const { lockPathFor, takeLock } = await import('../../src/pcsetup/leftovers.mjs');
  const r = { url: 'https://github.com/alex/site-workspace.git', repo: 'site-workspace' };
  const gone = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  // Run B takes the lock over in the moment between run A reading the stale lock and A acting on what it read.
  let dir = fresh();
  const file = lockPathFor(dir, r);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: Number(gone), proc: null }));
  const { openSync: open, readFileSync: read } = fs; // A has the stale lock open, or has read it, when B acts
  let b = null;
  const bActs = (p) => {
    if (p === file && b === null) {
      b = false; // once: B's own reads are plain
      b = takeLock(dir, r);
    }
  };
  fs.openSync = function (p, ...rest) {
    const fd = open.call(this, p, ...rest);
    bActs(p);
    return fd;
  };
  fs.readFileSync = function (p, ...rest) {
    const text = read.call(this, p, ...rest);
    bActs(p);
    return text;
  };
  let a;
  try {
    a = takeLock(dir, r);
  } finally {
    Object.assign(fs, { openSync: open, readFileSync: read });
  }
  assert.ok(b && b.release, 'B holds it');
  assert.ok(a.busy, 'A is the second one');
  assert.equal(a.busy.file, file);
  b.release();
  assert.deepEqual(fs.readdirSync(dir), []); // nothing in the projects folder
  assert.ok(!fs.existsSync(path.dirname(file)), 'no claim or new file left beside the lock: its folder went with it');
  // two real processes on a stale lock, many rounds: never two clones
  const child = path.join(t.root, 'get-child.mjs');
  fs.writeFileSync(child, `const { getMain } = await import(${JSON.stringify(new URL('../../src/pcsetup/getproject.mjs', import.meta.url).href)});\nconst out = [];\nawait getMain([process.argv[3], '--json', '--yes'], { dir: process.argv[2], write: (s) => out.push(s) });\nprocess.stdout.write(JSON.stringify(JSON.parse(out.join('')).projects[0].result));\n`);
  const { execFile } = await import('node:child_process');
  const go = (d) => new Promise((res) => execFile(process.execPath, [child, d, r.url], { encoding: 'utf8', env: { ...process.env, HOPRIG_WORKSPACE_DIR: path.join(t.root, 'ws-no-map') } }, (e, out) => res(out)));
  for (let i = 0; i < 20; i++) {
    dir = fresh();
    fs.mkdirSync(path.dirname(lockPathFor(dir, r)), { recursive: true });
    fs.writeFileSync(lockPathFor(dir, r), JSON.stringify({ pid: Number(gone), proc: null }));
    const results = (await Promise.all([go(dir), go(dir)])).map((o) => JSON.parse(o));
    assert.ok(results.filter((x) => x === 'cloned').length === 1 && results.every((x) => ['cloned', 'busy', 'here'].includes(x)), `round ${i}: ${results}`);
    assert.deepEqual(fs.readdirSync(dir), ['website'], `round ${i}`);
  }
});

test('a folder or a link at the lock\'s name is moved aside under a dated name, never deleted or followed, and the get goes on', async () => {
  const { lockPathFor } = await import('../../src/pcsetup/leftovers.mjs');
  const r = { url: 'https://github.com/alex/site-workspace.git', repo: 'site-workspace' };
  const target = path.join(t.root, `lock-target-${n}`);
  fs.writeFileSync(target, JSON.stringify({ pid: process.pid, proc: null })); // a lock of a live run, through a link
  const kinds = {
    folder: (f) => writeTree(f, { 'mine.txt': 'mine' }),
    'link to a file': (f) => fs.symlinkSync(target, f),
    'link to nothing': (f) => fs.symlinkSync(path.join(t.root, 'nothing-here'), f),
  };
  for (const [kind, make] of Object.entries(kinds)) {
    const dir = fresh();
    const file = lockPathFor(dir, r);
    const locks = path.dirname(file); // the place's folder of locks in the state folder
    fs.mkdirSync(locks, { recursive: true });
    make(file);
    const ui = quietUi();
    const c = await getProject('alex/site-workspace', { ui, dir, map: noMap });
    assert.equal(c.result, 'cloned', `${kind}: ${c.message}`);
    const aside = fs.readdirSync(locks).filter((x) => x.startsWith(`${path.basename(file)}.aside-`));
    assert.equal(aside.length, 1, `${kind}: ${fs.readdirSync(locks)}`);
    assert.deepEqual(fs.readdirSync(locks), [aside[0]]);
    assert.deepEqual(fs.readdirSync(dir), ['website']);
    const moved = fs.lstatSync(path.join(locks, aside[0]));
    assert.equal(moved.isSymbolicLink(), kind.startsWith('link'), kind);
    if (kind === 'folder') assert.equal(fs.readFileSync(path.join(locks, aside[0], 'mine.txt'), 'utf8'), 'mine');
    assert.match(ui.lines.join(''), /was not a lock file \(a folder or a link\): it was moved aside, nothing deleted/);
  }
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).pid, process.pid); // what a link pointed to is untouched
});

test('leftovers: only the folder with exactly this run\'s temporary name is this run\'s, and only when it is a clone of this address', async () => {
  const { tempNameFor } = await import('../../src/pcsetup/leftovers.mjs');
  const site = 'https://github.com/alex/site-workspace.git';
  const tempName = tempNameFor({ url: site, repo: 'site-workspace' });
  // another address's clone under way, whose repository has the same name (no .git yet, so no address to read), and
  // a complete clone of this address under another temporary name: neither is touched; a fresh clone is made
  remote('bob/site-workspace', parent('website'));
  let dir = fresh();
  const bobs = path.join(dir, tempNameFor({ url: 'https://github.com/bob/site-workspace.git', repo: 'site-workspace' }));
  writeTree(bobs, { 'half.txt': 'still cloning' });
  const other = path.join(dir, '.hoprig-clone-site-workspace-0a1b2c3d');
  execFileSync('git', ['clone', '-q', site, other]);
  let r = await run('alex/site-workspace', dir);
  assert.equal(r.result, 'cloned', r.message);
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(other), path.basename(bobs), 'website'].sort());
  assert.deepEqual(fs.readdirSync(bobs), ['half.txt']);
  // a complete clone at this run's name whose remote address was changed by hand to another project's: moved aside,
  // never finished as that project
  dir = fresh();
  const left = path.join(dir, tempName);
  execFileSync('git', ['clone', '-q', 'https://github.com/alex/blog.git', left]);
  sh(left, 'remote', 'set-url', 'origin', 'https://github.com/alex/blog.git');
  fs.writeFileSync(path.join(left, '.git', 'from-the-earlier-run'), '');
  r = await run('alex/site-workspace', dir);
  assert.equal(r.result, 'cloned', r.message);
  assert.equal(fs.existsSync(path.join(dir, 'website', '.git', 'from-the-earlier-run')), false);
  assert.equal(sh(path.join(dir, 'website'), 'config', '--get', 'remote.origin.url'), site);
  const aside = fs.readdirSync(dir).filter((x) => x.startsWith(`${tempName}.aside-`));
  assert.equal(aside.length, 1, fs.readdirSync(dir).join(' '));
  assert.equal(sh(path.join(dir, aside[0]), 'config', '--get', 'remote.origin.url'), 'https://github.com/alex/blog.git');
  // the same changed clone left at site-workspace's name, when blog is got: blog is cloned new, from blog
  dir = fresh();
  const site2 = path.join(dir, tempName);
  execFileSync('git', ['clone', '-q', site, site2]);
  sh(site2, 'remote', 'set-url', 'origin', 'https://github.com/alex/blog.git');
  r = await run('https://github.com/alex/blog.git', dir);
  assert.equal(r.result, 'cloned', r.message);
  assert.equal(fs.readFileSync(path.join(dir, 'blog', 'README.md'), 'utf8'), '# alex/blog\n');
  assert.ok(fs.existsSync(path.join(site2, 'project.json'))); // not touched
});

test('a link at the clone\'s temporary name is moved aside (the link itself, never what it points to) and the clone is made new', async () => {
  const { tempNameFor } = await import('../../src/pcsetup/leftovers.mjs');
  const site = 'https://github.com/alex/site-workspace.git';
  const tempName = tempNameFor({ url: site, repo: 'site-workspace' });
  const elsewhere = path.join(t.root, `elsewhere-${n}`); // a complete clone of the project somewhere else
  execFileSync('git', ['clone', '-q', site, elsewhere]);
  fs.writeFileSync(path.join(elsewhere, '.git', 'not-this-one'), '');
  const dir = fresh();
  fs.symlinkSync(elsewhere, path.join(dir, tempName));
  const ui = quietUi();
  const r = await getProject('alex/site-workspace', { ui, dir, map: noMap });
  assert.equal(r.result, 'cloned', r.message);
  assert.ok(fs.lstatSync(path.join(dir, 'website')).isDirectory() && !fs.lstatSync(path.join(dir, 'website')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(dir, 'website', '.git', 'not-this-one')), false);
  const aside = fs.readdirSync(dir).filter((x) => x.startsWith(`${tempName}.aside-`));
  assert.equal(aside.length, 1, fs.readdirSync(dir).join(' '));
  assert.equal(fs.readlinkSync(path.join(dir, aside[0])), elsewhere);
  assert.ok(fs.existsSync(path.join(elsewhere, '.git', 'not-this-one'))); // what it points to is untouched
  assert.match(ui.lines.join(''), /a link at the clone's temporary name was moved aside \(nothing deleted\)/);
});

test('computer set-up from a recipe: a project here under another name is retried with its own fix, not with a clone', async (tc) => {
  const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
  const { sysFacts } = await import('../../src/pcsetup/detect.mjs');
  const was = process.env.HOPRIG_WORKSPACE_DIR;
  process.env.HOPRIG_WORKSPACE_DIR = path.join(t.root, 'ws-no-map');
  tc.after(() => (process.env.HOPRIG_WORKSPACE_DIR = was));
  const dir = fresh();
  execFileSync('git', ['clone', '-q', 'https://github.com/alex/shop-workspace.git', path.join(dir, 'shop-workspace')]);
  const sys = await sysFacts({ platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: t.root, home: process.env.HOME, has: () => true, exists: () => false, run: async (argv) => ({ ok: true, code: 0, stdout: `${argv[0]} 99.9.9`, stderr: '' }) });
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], projectsDir: dir, workspaces: ['alex/shop-workspace'] }, sys, rules: false, codingTools: { findTool: () => null } });
  const retry = out.join('').split('\n').filter((l) => /retry:/.test(l));
  assert.equal(retry.length, 1, out.join(''));
  assert.ok(retry[0].endsWith(showCommand(['mv', path.join(dir, 'shop-workspace'), path.join(dir, 'shop')])), retry[0]);
  assert.deepEqual(fs.readdirSync(dir), ['shop-workspace']);
});
