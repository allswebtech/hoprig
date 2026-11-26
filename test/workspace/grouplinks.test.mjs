// Where Hoprig acts it stays really inside (inside.mjs). A group's repository that commits
// `builds -> <a folder outside the workspace>` or `packs/blog/code -> …`, or a project's parent that commits
// `code -> …`, must not make restore clone outside the workspace, nor the scan list what is there as members or
// code repositories, nor memory links point into it. No question to git: a link made by hand is the same, until the
// owner names it as his own on this computer (hoprig workspace mylink add); status names every link it met.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-links');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
const M = await import('../../src/workspace/map.mjs');
const { LEAVES, addMyLink, leaves, removeMyLink } = await import('../../src/workspace/inside.mjs');
const { projectSlug } = await import('../../src/sessions.mjs');
// The command for a path as Hoprig prints it: a path with a \ in it (every Windows path) is written in quotes.
const asTyped = (p) => (process.platform === 'win32' ? `'${p}'` : p);

const outside = path.join(w.root, 'OUTSIDE');
fs.mkdirSync(outside);
const brain = w.bare('brain');
const bdir = w.clone(brain, path.join(A.ws, 'ai_brain'));
// The hostile group repository.
const k = w.clone(w.bare('kits'), path.join(w.root, 'seed-kits'));
fs.symlinkSync(outside, path.join(k, 'builds'));
fs.mkdirSync(path.join(k, 'packs', 'blog'), { recursive: true });
fs.symlinkSync(outside, path.join(k, 'packs', 'blog', 'code'));
fs.mkdirSync(path.join(k, 'ai_brain', 'claude-memory'), { recursive: true });
fs.writeFileSync(path.join(k, 'ai_brain', 'claude-memory', 'MEMORY.md'), 'x');
w.sh(k, 'add', '-A');
w.sh(k, 'commit', '-q', '-m', 'kits');
w.sh(k, 'push', '-q', 'origin', 'main');
// A project's parent in the projects folder that commits code -> outside.
const s = w.clone(w.bare('shop'), path.join(w.root, 'seed-shop'));
fs.symlinkSync(outside, path.join(s, 'code'));
fs.writeFileSync(path.join(s, 'project.json'), JSON.stringify({ name: 'shop', repos: [{ dir: 'code/shop-web', url: w.url('shop-web') }], memories: {} }));
w.sh(s, 'add', '-A');
w.sh(s, 'commit', '-q', '-m', 'shop');
w.sh(s, 'push', '-q', 'origin', 'main');
['tool1', 'blog-web', 'shop-web'].forEach((n) => w.bare(n));
const map = {
  version: 2, brain: { url: brain },
  groups: [{ dir: 'kits', url: w.url('kits'), memories: { '.': 'ai_brain/claude-memory' }, holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds' }] }],
  projects: [
    { name: 'tool1', in: 'kits/builds', url: w.url('tool1'), repos: [] },
    { name: 'blog', in: 'kits/packs', url: null, repos: [{ dir: 'code/blog-web', url: w.url('blog-web') }] },
    { name: 'shop', url: w.url('shop'), repos: [{ dir: 'code/shop-web', url: w.url('shop-web') }] },
  ],
  others: [],
};
w.commit(bdir, 'workspace.json', JSON.stringify(map, null, 2) + '\n', 'map');
w.sh(bdir, 'push', '-q', 'origin', 'main');

const B = w.computer('b');
B.use();
process.env.HOPRIG_WORKSPACE_DIR = B.ws;
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
let res;

test('restore never clones through a link a repository tracks: nothing lands outside the workspace', async () => {
  const q = await quietUi();
  res = await restoreWorkspace(brain, { withProjects: true, ui: q.ui, dir: B.ws, projects: B.projects });
  assert.deepEqual(fs.readdirSync(outside), [], 'the folder outside stays empty');
  const by = Object.fromEntries(res.plan.map((e) => [e.label, e.result]));
  assert.equal(by.kits, 'cloned');
  assert.equal(by.shop, 'cloned');
  for (const l of ['kits/builds/tool1', 'kits/packs/blog/code/blog-web', 'shop/code/shop-web']) assert.match(by[l], new RegExp(`skipped: .* ${LEAVES}`), l);
});

test('the scan lists nothing behind such a link, no memory link points into it, and status names each with the command', async () => {
  // Something appears in the outside folder (a repository): it is never a member or a code repository.
  w.clone(w.url('tool1'), path.join(outside, 'tool1'));
  w.clone(w.url('blog-web'), path.join(outside, 'blog-web'));
  const r = await M.updateMap({ dir: B.ws, projects: B.projects, manifests: false });
  const st = await M.mapStatus({ dir: B.ws, projects: B.projects });
  assert.equal(st.entries.find((e) => e.label === 'kits/builds/tool1').state, 'notFollowed', 'not followed: its place leads out');
  assert.equal(st.entries.find((e) => e.label === 'kits/packs/blog/code/blog-web').state, 'notFollowed');
  assert.equal(st.entries.find((e) => e.label === 'shop/code/shop-web').state, 'notFollowed');
  assert.ok(!r.map.others.length, 'nothing behind the links became another repository');
  const met = st.links.map((l) => path.relative(B.ws, l.path).split(path.sep).join('/')).sort();
  assert.deepEqual(met, ['kits/builds', 'kits/packs/blog/code', 'projects/shop/code']);
  for (const l of st.links) {
    assert.equal(l.what, LEAVES);
    assert.equal(l.fix, `hoprig workspace mylink add ${asTyped(l.path)}`);
  }
  const slugs = fs.readdirSync(path.join(B.claude, 'projects'));
  assert.ok(!slugs.some((x) => x.endsWith(projectSlug('/tool1')) || /builds-tool1|code-blog-web|code-tool1/.test(x)), slugs.join(' '));
});

test('a link made by hand is the same as one that came with a repository, until the owner names it as his own', async () => {
  const mine = path.join(w.root, 'MINE');
  fs.mkdirSync(mine);
  w.clone(w.url('tool1'), path.join(mine, 'tool1'));
  const kits = path.join(B.ws, 'kits');
  fs.rmSync(path.join(kits, 'builds'));
  w.sh(kits, 'rm', '-q', '--cached', 'builds');
  w.sh(kits, 'commit', '-q', '-m', 'builds is no longer tracked');
  fs.symlinkSync(mine, path.join(kits, 'builds')); // made by hand, tracked by nothing
  let st = await M.mapStatus({ dir: B.ws, projects: B.projects });
  assert.equal(st.entries.find((e) => e.label === 'kits/builds/tool1').state, 'notFollowed', 'not followed: no difference to a tracked link');
  const { main } = await import('../../src/workspace/cli.mjs');
  let q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.ok(q.text().includes(`${path.join(kits, 'builds')}: leaves its folder through a link: not followed  →  if it is yours:  hoprig workspace mylink add ${asTyped(path.join(kits, 'builds'))}`), q.text());
  // The owner names it: followed from now on (and only it: the tracked code/ link of blog stays out).
  q = await quietUi();
  assert.equal(await main(['mylink', 'add', path.join(kits, 'builds')], { ui: q.ui, write: () => {} }), 0, q.text());
  st = await M.mapStatus({ dir: B.ws, projects: B.projects });
  assert.equal(st.entries.find((e) => e.label === 'kits/builds/tool1').state, 'here');
  assert.equal(st.entries.find((e) => e.label === 'kits/packs/blog/code/blog-web').state, 'notFollowed');
  q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.match(q.text(), /kits[\\/]builds: your own link \(hoprig workspace mylink\): followed/);
  let out = '';
  await main(['mylink', 'list', '--json'], { ui: q.ui, write: (x) => (out += x) });
  assert.deepEqual(JSON.parse(out).links.map((l) => l.path), [path.join(kits, 'builds')]);
  // Kept on this computer only: in Hoprig's settings, never in the map.
  assert.ok(!fs.readFileSync(path.join(B.ws, 'ai_brain', 'workspace.json'), 'utf8').includes('MINE'));
});

test('hoprig get of a member never clones through a link that leads out of its group', async () => {
  const { getProject } = await import('../../src/pcsetup/getproject.mjs');
  const q = await quietUi();
  const r = await getProject('kits/packs/blog', { ui: q.ui, dir: B.projects });
  assert.ok(!(r.repos || []).some((x) => x.result === 'cloned'), q.text());
  const code = path.join(B.ws, 'kits', 'packs', 'blog', 'code', 'blog-web');
  assert.ok(!fs.existsSync(path.join(B.claude, 'projects', projectSlug(code))), 'no memory link for a folder behind the link');
});

test('no question to git: a damaged index changes nothing, and a link that stays inside its folder is followed', async () => {
  const kits = path.join(B.ws, 'kits');
  const index = path.join(kits, '.git', 'index');
  const keep = fs.readFileSync(index);
  fs.writeFileSync(index, 'not an index');
  try {
    assert.equal(leaves(kits, path.join(kits, 'builds', 'tool1')), null, 'the owner\'s own link: followed, git not asked');
    assert.equal(leaves(kits, path.join(kits, 'packs', 'blog', 'code', 'x')).what, LEAVES);
  } finally {
    fs.writeFileSync(index, keep);
  }
  fs.mkdirSync(path.join(kits, 'docs'), { recursive: true });
  fs.symlinkSync('docs', path.join(kits, 'notes'));
  assert.equal(leaves(kits, path.join(kits, 'notes', 'a.md')), null, 'a link inside the folder to inside the folder');
  fs.symlinkSync('..', path.join(kits, 'up'));
  assert.equal(leaves(kits, path.join(kits, 'up', 'x')).path, path.join(kits, 'up'), 'one to its parent leaves');
  assert.equal(removeMyLink(path.join(kits, 'builds')).removed, true);
  assert.equal(leaves(kits, path.join(kits, 'builds', 'tool1')).what, LEAVES, 'off the list: not followed again');
  assert.throws(() => addMyLink(path.join(w.root, 'MINE')), /not in the workspace/);
  assert.throws(() => addMyLink(path.join(kits, 'docs')), /is not a link/);
});

test('a memory link is checked again right before it is made: a link that leads out since the plan is never written through', async () => {
  const { planMemoryPairs, linkMemory } = await import('../../src/pcsetup/workspace.mjs');
  const g = path.join(B.ws, 'late-group');
  fs.mkdirSync(path.join(g, 'mem'), { recursive: true });
  const memory = path.join(g, 'mem', 'claude-memory');
  const [p] = planMemoryPairs([{ launch: g, memory, root: g }]);
  assert.equal(p.action, 'link');
  // Between the plan and the link, the folder becomes mem -> OUTSIDE.
  fs.rmSync(path.join(g, 'mem'), { recursive: true });
  fs.symlinkSync(outside, path.join(g, 'mem'));
  const r = linkMemory(p);
  assert.equal(r.done, 'conflict');
  assert.match(r.detail, /mem leaves its folder through a link/);
  assert.ok(!fs.existsSync(path.join(outside, 'claude-memory')), 'nothing made outside');
  assert.ok(!fs.existsSync(p.link), 'no link made');
});
