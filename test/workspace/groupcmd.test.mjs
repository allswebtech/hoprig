// `hoprig workspace group add|remove` and `project new --in`: a group is written to the map (version 2 only), a group
// that is a repository gets the ignore lines it lacks (shown first, written only on a yes), status warns while a
// member is not ignored, and nothing on a disk is ever deleted. A stranger's first set-up has nothing of groups.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-groupcmd');
test.after(() => w.cleanup());
const C = w.computer('gc');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { projectNew } = await import('../../src/pcsetup/project.mjs');
const { saveConfig } = await import('../../src/config.mjs');

['brain', 'kits', 'acme-shop', 'blog-build', 'blog-theme'].forEach((n) => w.bare(n));
w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
fs.mkdirSync(C.projects, { recursive: true });
const kits = w.clone(w.url('kits'), path.join(C.ws, 'kits'));
fs.mkdirSync(path.join(kits, 'ai_brain', 'claude-memory'), { recursive: true });
w.clone(w.url('blog-build'), path.join(kits, 'builds', 'blog'));
w.clone(w.url('blog-theme'), path.join(kits, 'packs', 'blog', 'code', 'blog-theme'));
w.clone(w.url('acme-shop'), path.join(C.ws, 'client-work', 'shop'));
const file = M.mapFile(C.ws);
const run = async (args) => {
  const q = await quietUi();
  let json = '';
  const code = await main(['group', ...args], { ui: q.ui, write: (s) => (json += s) });
  return { code, text: q.text(), json: json ? JSON.parse(json) : null };
};

test('no map, or a map of version 1: a group is refused and nothing is written', async () => {
  assert.match((await run(['add', 'client-work'])).text, /no workspace map yet/);
  await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.equal(M.readMap(C.ws).map.version, 1);
  const before = fs.readFileSync(file, 'utf8');
  const r = await run(['add', 'client-work']);
  assert.equal(r.code, 1);
  assert.match(r.text, /hoprig workspace map --upgrade/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal((await main(['map', '--upgrade', '--yes'], { ui: (await quietUi()).ui, write: () => {} })), 0);
});

test('a folder outside the workspace or one of its own folders is refused, the map unchanged', async () => {
  const before = fs.readFileSync(file, 'utf8');
  for (const bad of ['../x', '/srv/x', 'projects', 'no-ai', '.x']) {
    const r = await run(['add', bad]);
    assert.equal(r.code, 1, bad);
  }
  assert.match((await run(['add', 'x', '--holds', 'packs'])).text, /give --repo/);
  assert.match((await run(['add', 'x', '--repo', w.url('x'), '--holds', 'a/b'])).text, /--holds takes folder names/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a plain group: written to the map, and what is in its folder enters the map', async () => {
  const r = await run(['add', 'client-work', '--json']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.json.group, { dir: 'client-work' });
  assert.deepEqual(r.json.moved, [{ dir: 'client-work/shop', becomes: 'the project client-work/shop', changed: true }], 'the older map\'s other repository becomes the project');
  const m = M.readMap(C.ws).map;
  assert.deepEqual(m.groups, [{ dir: 'client-work' }]);
  assert.equal(m.projects.find((p) => M.refOf(p) === 'client-work/shop').in, 'client-work');
  assert.ok(!m.others.some((o) => o.dir.startsWith('client-work')));
});

test('a group that is a repository: the ignore lines it lacks are shown first, and written only on a yes', async () => {
  const dry = await run(['add', 'kits', '--repo', w.url('kits'), '--holds', 'packs:group,builds', '--dry-run']);
  assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, /\/packs\/\*\/code\/\n\s+\/builds\/\*\//);
  assert.equal(M.readMap(C.ws).map.groups.length, 1, 'a dry run writes nothing');
  // No yes (no terminal): the map gets the group, the ignore file stays as it is, and that is said.
  const r = await run(['add', 'kits', '--repo', w.url('kits'), '--holds', 'packs:group,builds']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /ignore lines were not added \(add --yes/);
  assert.equal(fs.existsSync(path.join(kits, '.gitignore')), false);
  const g = M.readMap(C.ws).map.groups.find((x) => x.dir === 'kits');
  assert.deepEqual(g, { dir: 'kits', url: w.url('kits'), memories: { '.': 'ai_brain/claude-memory' }, holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds' }] });
  // Status says it, and it is true: a `git add -A` would take the members now.
  const st = await M.mapStatus({ dir: C.ws, projects: C.projects });
  assert.deepEqual(st.groups[0].unignored, ['packs/blog/code', 'builds/blog']);
  const q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.match(q.text(), /kits: a `git add` in the group would take packs\/blog\/code, builds\/blog/);
  w.sh(kits, 'add', '-A');
  assert.ok(w.sh(kits, 'diff', '--cached', '--name-only').split('\n').some((l) => l.startsWith('builds/')), 'without the lines a member is taken');
  w.sh(kits, 'reset', '-q');
  // With --yes: written, and then a `git add -A` takes no member.
  const yes = await run(['add', 'kits', '--repo', w.url('kits'), '--holds', 'packs:group,builds', '--yes']);
  assert.equal(yes.code, 0, yes.text);
  assert.match(yes.text, /added 2 lines/);
  fs.writeFileSync(path.join(kits, 'packs', 'blog', 'project.json'), '{"name":"blog","repos":[],"memories":{}}\n');
  w.sh(kits, 'add', '-A');
  assert.deepEqual(w.sh(kits, 'diff', '--cached', '--name-only').split('\n').sort(), ['.gitignore', 'packs/blog/project.json'], 'the group\'s own files only, no member');
  w.sh(kits, 'commit', '-q', '-m', 'Keep members out');
  assert.deepEqual((await M.mapStatus({ dir: C.ws, projects: C.projects })).groups, []);
});

test('the same folder as a group of another shape is refused', async () => {
  const r = await run(['add', 'kits']);
  assert.equal(r.code, 1);
  assert.match(r.text, /of another shape: remove it first/);
});

test('project new --in: into a group\'s folder; never into a held folder whose members come with the group', async () => {
  const q = await quietUi();
  assert.equal(await projectNew(['blog', '--in', 'client-work', '--no-github'], { ui: q.ui }), 0, q.text());
  assert.ok(fs.existsSync(path.join(C.ws, 'client-work', 'blog', '.git')));
  assert.ok(!fs.existsSync(path.join(C.projects, 'blog')));
  assert.ok(M.readMap(C.ws).map.projects.some((p) => M.refOf(p) === 'client-work/blog' && p.url === null));
  const q2 = await quietUi();
  assert.equal(await projectNew(['x', '--in', 'kits/packs', '--no-github'], { ui: q2.ui }), 1);
  assert.match(q2.text(), /come with the group's repository/);
  const q3 = await quietUi();
  assert.equal(await projectNew(['x', '--in', 'nowhere', '--no-github'], { ui: q3.ui }), 1);
  assert.match(q3.text(), /not a group or a held folder/);
  const q4 = await quietUi();
  assert.equal(await projectNew(['plain', '--no-github'], { ui: q4.ui }), 0, q4.text());
  assert.ok(fs.existsSync(path.join(C.projects, 'plain', '.git')), 'without --in: the projects folder, as before');
});

test('group remove: refused while a project of the map is in it; then out of the map, nothing deleted', async () => {
  const r = await run(['remove', 'client-work']);
  assert.equal(r.code, 1);
  assert.match(r.text, /still has 2 projects .*client-work\/blog, client-work\/shop/);
  M.forget('client-work/shop', C.ws);
  M.forget('client-work/blog', C.ws);
  const ok = await run(['remove', 'client-work', '--json']);
  assert.equal(ok.code, 0, ok.text);
  assert.ok(!M.readMap(C.ws).map.groups.some((g) => g.dir === 'client-work'));
  assert.ok(fs.existsSync(path.join(C.ws, 'client-work', 'shop', '.git')), 'nothing on the disk was deleted');
  assert.match((await run(['remove', 'client-work'])).text, /not a group of the map/);
});

test('a stranger\'s first set-up: the seven default folders and nothing that hints at groups', async () => {
  const S = w.computer('stranger');
  S.use();
  process.env.HOPRIG_WORKSPACE_DIR = S.ws;
  const { workspaceSetup } = await import('../../src/workspace/setup.mjs');
  await workspaceSetup({ cfg: { workspaceDir: S.ws, projectsDir: path.join(S.ws, 'projects') } });
  assert.deepEqual(fs.readdirSync(S.ws).sort(), ['ai_brain', 'backups', 'credentials', 'database', 'development', 'git', 'projects']);
  const words = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else words.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(S.ws);
  assert.ok(!words.some((t) => /\bgroups?\b/i.test(t)), 'no file of a fresh workspace speaks of groups');
  assert.equal(fs.existsSync(M.mapFile(S.ws)), false, 'no map until the owner makes one');
  C.use();
  process.env.HOPRIG_WORKSPACE_DIR = C.ws;
});

test('what a stranger is SHOWN at first set-up and after it: no word about groups', async () => {
  const S = w.computer('stranger2');
  S.use();
  process.env.HOPRIG_WORKSPACE_DIR = S.ws;
  const { makeUi } = await import('../../src/setup/ui.mjs');
  let shown = '';
  const ui = makeUi({ interactive: false, write: (t) => (shown += t) });
  ui.yes = true;
  const { runWorkspaceStep } = await import('../../src/workspace/step.mjs');
  await runWorkspaceStep({ ui }); // the step of hoprig setup and hoprig pc setup
  await main(['status'], { ui, write: (t) => (shown += t) });
  await main(['status', '--json'], { ui, write: (t) => (shown += t) });
  await main(['map', '--dry-run'], { ui, write: (t) => (shown += t) });
  const { workspaceLine, workspaceStatus } = await import('../../src/workspace/layout.mjs');
  shown += JSON.stringify(workspaceLine(workspaceStatus()));
  assert.match(shown, /Workspace/);
  C.use();
  process.env.HOPRIG_WORKSPACE_DIR = C.ws;
  assert.doesNotMatch(shown, /\bgroups?\b|held folder/i, shown.slice(0, 2000));
  C.use();
  process.env.HOPRIG_WORKSPACE_DIR = C.ws;
});

test('a folder a person types is written the map\'s one way: group add a//b/ is the group a/b, counted once', async () => {
  const r = await run(['add', 'notes//inbox/', '--json']);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.json.group.dir, 'notes/inbox');
  assert.ok(M.readMap(C.ws).map.groups.some((g) => g.dir === 'notes/inbox'));
  assert.equal((await run(['remove', 'notes/inbox/'])).code, 0);
});

test('workspace status lists only projects in a group: never a plain folder or a linked worktree', async () => {
  fs.mkdirSync(path.join(C.ws, 'client-work', 'misc'), { recursive: true });
  if (!M.readMap(C.ws).map.groups.some((g) => g.dir === 'client-work')) assert.equal((await run(['add', 'client-work'])).code, 0);
  let out = '';
  await main(['status', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s) });
  const cw = JSON.parse(out).groups.find((g) => g.id === 'client-work');
  assert.ok(!cw.projects.includes('misc'), JSON.stringify(cw.projects));
  assert.ok(cw.projects.includes('shop'));
});

test('the fix status gives for missing ignore lines works for any group, also one with a tool or a find', async () => {
  const m = M.readMap(C.ws).map;
  const g = m.groups.find((x) => x.dir === 'kits');
  g.tool = { name: 'kit', run: 'kit.sh' };
  g.holds[1].find = { parent: '{project}-{product}-project', folder: '{product}-{project}' };
  M.writeMap(m, C.ws);
  fs.writeFileSync(path.join(kits, '.gitignore'), '');
  const st = await M.mapStatus({ dir: C.ws, projects: C.projects });
  const fix = st.groups.find((x) => x.dir === 'kits').fix;
  assert.equal(fix, 'hoprig workspace group ignore kits');
  const r = await run(fix.split(' ').slice(3).concat('--yes'));
  assert.equal(r.code, 0, r.text);
  assert.equal(fs.readFileSync(path.join(kits, '.gitignore'), 'utf8'), '/packs/*/code/\n/builds/*/\n');
  assert.deepEqual((await M.mapStatus({ dir: C.ws, projects: C.projects })).groups, []);
  assert.deepEqual(M.readMap(C.ws).map.groups.find((x) => x.dir === 'kits').tool, { name: 'kit', run: 'kit.sh' }, 'the map is left as it was');
});

test('an ignore file that is a link the group\'s repository tracks is never read or written through', async () => {
  const outsideFile = path.join(w.root, 'outside-ignore');
  fs.writeFileSync(outsideFile, 'theirs\n');
  const ign = path.join(kits, '.gitignore');
  fs.rmSync(ign);
  fs.symlinkSync(outsideFile, ign);
  w.sh(kits, 'add', '.gitignore');
  w.sh(kits, 'commit', '-q', '-m', 'the ignore file is a link');
  const r = await run(['ignore', 'kits', '--yes']);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /\.gitignore is a link: Hoprig never reads or writes an ignore file through one/);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'theirs\n', 'the file outside is as it was');
  const st = await M.mapStatus({ dir: C.ws, projects: C.projects });
  assert.match(st.groups.find((x) => x.dir === 'kits').refused, /is a link/);
  // group add of a group that is a repository with such an ignore file: the map is written, the file is not.
  const g = M.readMap(C.ws).map;
  M.writeMap({ ...g, groups: g.groups.filter((x) => x.dir !== 'kits'), projects: g.projects.filter((p) => !(p.in || '').startsWith('kits/')) }, C.ws);
  const add = await run(['add', 'kits', '--repo', w.url('kits'), '--holds', 'packs:group,builds', '--yes']);
  assert.equal(add.code, 0, add.text);
  assert.match(add.text, /the ignore lines were not added: .*is a link/);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'theirs\n');
});
