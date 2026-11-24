// Where Hoprig acts it stays really inside (inside.mjs): the review's cases, each one an act that used to reach a
// folder outside the workspace through a link. A group's repository that brings a link INTO a member that is a
// repository of its own; a group's memory and a project's memory behind a link; a parent's code/ that leads out
// (set-up, install route, project list); a .env.example that is a link; a project.json that is a link. Temporary
// homes and local bare repositories only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-inside');
test.after(() => w.cleanup());
const C = w.computer('c');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { mapTargets } = await import('../../src/workspace/groups.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { LEAVES, cloneInto, gitIn, mkdirIn, readIn, rmdirIn, startIn, writeIn } = await import('../../src/workspace/inside.mjs');

const outside = path.join(w.root, 'OUTSIDE');
fs.mkdirSync(outside);
w.bare('brain');
w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
fs.mkdirSync(C.projects, { recursive: true });
const ctx = { dir: C.ws, projects: C.projects };
const heads = (d) => w.sh(d, 'rev-list', '--all', '--count');

// A group kits whose member acme is a repository of its own; the group's repository then brings
// builds/acme/code -> OUTSIDE into the member's working tree. A repository of the owner's lives in OUTSIDE with a
// commit only it has.
w.bare('kits');
w.bare('acme');
w.bare('x');
w.bare('victim');
const kits = w.clone(w.url('kits'), path.join(C.ws, 'kits'));
const acme = w.clone(w.url('acme'), path.join(kits, 'builds', 'acme'));
const victim = w.clone(w.url('victim'), path.join(outside, 'victim'));
w.commit(victim, 'LOCAL.md', 'not pushed yet\n');
M.writeMap({
  version: 2, brain: { url: w.url('brain') },
  groups: [{ dir: 'kits', url: w.url('kits'), holds: [{ dir: 'builds' }] }],
  projects: [{ name: 'acme', in: 'kits/builds', url: w.url('acme'), repos: [{ dir: 'code/x', url: w.url('x') }] }], others: [],
}, C.ws);
const seed = w.clone(w.url('kits'), path.join(w.root, 'seed-kits'));
fs.mkdirSync(path.join(seed, 'builds', 'acme'), { recursive: true });
fs.symlinkSync(outside, path.join(seed, 'builds', 'acme', 'code'));
w.sh(seed, 'add', '-A');
w.sh(seed, 'commit', '-q', '-m', 'a link into the member');
w.sh(seed, 'push', '-q', 'origin', 'main');

test('a link the group\'s repository brings into a member of its own: sync, the upkeep, sync --push and restore never act outside', async () => {
  const s1 = await syncAll(ctx);
  assert.deepEqual(s1.repos.find((r) => r.label === 'kits').did, ['pulled 1']);
  assert.ok(fs.lstatSync(path.join(acme, 'code')).isSymbolicLink(), 'git put the link into the member');
  const t = await mapTargets(M.readMap(C.ws).map, ctx);
  assert.equal(t.find((x) => x.label === 'kits/builds/acme/code/x').blocked.what, LEAVES);
  const u = await upkeepMap(ctx);
  assert.ok(!u.lines.some((l) => /victim/.test(l)), JSON.stringify(u.lines));
  assert.ok(!JSON.stringify(M.readMap(C.ws).map).includes('victim'), 'the map never gains a repository outside');
  const victimServer = path.join(w.server, 'team', 'victim.git');
  const before = heads(victimServer);
  await syncAll({ ...ctx, push: true });
  assert.equal(heads(victimServer), before, 'nothing pushed from the repository outside');
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const q = await quietUi();
  q.ui.yes = true;
  const r = await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: C.ws, projects: C.projects });
  assert.match(r.plan.find((e) => e.label === 'kits/builds/acme/code/x').result, /leaves its folder through a link/);
  assert.ok(!fs.existsSync(path.join(outside, 'x')), 'nothing cloned outside');
});

// A group whose own memory is behind a link it tracks, and a project whose ai_brain/ and code/ lead out.
const OUTG = path.join(w.root, 'OUT-group');
const OUTS = path.join(w.root, 'OUT-shop');
const OUTC = path.join(w.root, 'OUT-code');
for (const d of [OUTG, OUTS, path.join(OUTC, 'web', '.githooks')]) fs.mkdirSync(d, { recursive: true });
w.sh(path.join(OUTC, 'web'), 'init', '-q');
fs.writeFileSync(path.join(OUTC, 'web', '.env.example'), 'X=1\n');
fs.writeFileSync(path.join(OUTC, 'web', 'package.json'), '{"name":"web","version":"1.0.0"}\n');
fs.writeFileSync(path.join(OUTC, 'web', 'package-lock.json'), '{}\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOKEN=s3cr3t\n');
const ms = w.clone(w.bare('mems'), path.join(w.root, 'seed-mems'));
fs.symlinkSync(OUTG, path.join(ms, 'mem'));
w.sh(ms, 'add', '-A');
w.sh(ms, 'commit', '-q', '-m', 'mem');
w.sh(ms, 'push', '-q', 'origin', 'main');
w.clone(w.url('mems'), path.join(C.ws, 'mems'));
const ss = w.clone(w.bare('shop'), path.join(w.root, 'seed-shop'));
fs.symlinkSync(OUTS, path.join(ss, 'ai_brain'));
fs.symlinkSync(OUTC, path.join(ss, 'code'));
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ss, '.env.example'));
fs.writeFileSync(path.join(ss, 'project.json'), JSON.stringify({ name: 'shop', repos: [{ dir: 'code/web', url: w.url('web') }], memories: { '.': 'ai_brain/claude-memory' } }));
w.sh(ss, 'add', '-A');
w.sh(ss, 'commit', '-q', '-m', 'shop');
w.sh(ss, 'push', '-q', 'origin', 'main');
const shop = w.clone(w.url('shop'), path.join(C.projects, 'shop'));

test('project link and project setup: no memory folder, hooks setting, .env or install outside', async () => {
  const map = M.readMap(C.ws).map;
  // (The upkeep of the test above may have added both as it found them: the map says it here as a person would.)
  M.writeMap({ ...map, others: map.others.filter((o) => o.dir !== 'mems'), groups: [...map.groups.filter((g) => g.dir !== 'mems'), { dir: 'mems', url: w.url('mems'), memories: { '.': 'mem/claude' } }], projects: [...map.projects.filter((x) => x.name !== 'shop'), { name: 'shop', url: w.url('shop'), repos: [{ dir: 'code/web', url: w.url('web') }], memories: { '.': 'ai_brain/claude-memory' } }] }, C.ws);
  const P = await import('../../src/pcsetup/project.mjs');
  for (const args of [['mems', '--dry-run'], ['mems'], ['shop', '--dry-run'], ['shop']]) {
    const q = await quietUi();
    assert.equal(await P.projectLink(args, { ui: q.ui }), 0);
    assert.match(q.text(), /leaves its folder through a link/, args.join(' '));
    assert.doesNotMatch(q.text(), /would link|: linked/, args.join(' '));
  }
  assert.deepEqual(fs.readdirSync(OUTG), []);
  assert.deepEqual(fs.readdirSync(OUTS), []);
  const ran = [];
  const q = await quietUi();
  q.ui.yes = true;
  await P.projectSetup(['shop', '--yes'], { ui: q.ui, runner: async (argv, o) => (ran.push(o.cwd), { ok: true }) });
  assert.match(q.text(), /shop\/code\/web: not followed: .*code leaves its folder through a link/);
  assert.deepEqual(fs.readdirSync(path.join(OUTC, 'web')).sort(), ['.env.example', '.git', '.githooks', 'package-lock.json', 'package.json']);
  assert.throws(() => w.sh(path.join(OUTC, 'web'), 'config', '--get', 'core.hooksPath'), 'no hooks path set outside');
  assert.deepEqual(ran, [], 'no install started anywhere outside');
  assert.ok(!fs.existsSync(path.join(shop, '.env')), 'the parent\'s .env.example is a link: never copied');
});

test('the dashboard\'s project list leaves code/ behind a link out, and its install route (Tia\'s too) refuses it', async () => {
  const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
  const ran = [];
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [], create: async () => {} }, deck: { launcher: () => ['node', 'x'] } };
  const f = pcsetupFeature(sctx, { projectsDir: () => C.projects, stream: async (argv, o) => (ran.push({ argv, cwd: o.cwd }), { ok: true }) });
  const call = async (method, p, body) => {
    const u = new URL(`http://x${p}`);
    const [, , fn] = f.routes.find(([m, re]) => m === method && re.test(u.pathname));
    return fn({ body }, u.pathname.match(/./), u.searchParams);
  };
  const d = await call('GET', '/api/pcsetup/projects');
  const s = d.workspaces.find((x) => x.id === 'shop');
  assert.deepEqual(s.repos.map((r) => r.rel), ['.'], 'code/web behind the link is not listed as a repository');
  assert.deepEqual(s.notFollowed.map((x) => [x.rel, x.link]), [['code/web', path.join(shop, 'code')]], 'but said, with the link to name if it is the owner\'s');
  await assert.rejects(call('POST', '/api/pcsetup/install', { dir: 'shop/code/web' }), (e) => e.status === 409 && /leaves its folder through a link/.test(e.message));
  assert.deepEqual(ran, []);
});

test('the acts themselves refuse at the moment they run: git, a program, a clone, a write, a read for acting', async () => {
  const at = { root: shop, ...ctx };
  const web = path.join(shop, 'code', 'web');
  const calls = [];
  const rec = async (argv, o) => (calls.push([argv, o && o.cwd]), { ok: true });
  assert.equal((await gitIn(at, web, ['config', 'core.hooksPath', 'x'], rec)).ok, false);
  assert.equal((await startIn(at, web, ['npm', 'ci'], rec)).ok, false);
  assert.equal((await cloneInto(at, path.join(shop, 'code', 'api'), w.url('x'), { run: rec })).ok, false);
  assert.deepEqual(calls, []);
  assert.throws(() => writeIn(at, path.join(web, '.env'), 'X=2\n'), /leaves its folder through a link/);
  assert.equal(readIn(at, path.join(shop, '.env.example')), null, 'a link is never read for acting');
  assert.equal(readIn(at, path.join(web, '.env.example')), null);
  // A file is never written THROUGH a link, even one that points inside.
  fs.writeFileSync(path.join(shop, 'real.txt'), 'mine\n');
  fs.symlinkSync('real.txt', path.join(shop, 'alias.txt'));
  assert.throws(() => writeIn(at, path.join(shop, 'alias.txt'), 'over\n'), /is a link: Hoprig never writes through one/);
  assert.equal(fs.readFileSync(path.join(shop, 'real.txt'), 'utf8'), 'mine\n');
  fs.symlinkSync(path.join(outside, 'nothing-yet'), path.join(shop, 'dangling.txt'));
  assert.throws(() => writeIn(at, path.join(shop, 'dangling.txt'), 'x'), /is a link/);
  assert.ok(!fs.existsSync(path.join(outside, 'nothing-yet')), 'a dangling link is never written through');
  // A folder's mode is set on a real folder only, and an empty folder is removed only when it is no link.
  fs.mkdirSync(path.join(shop, 'inner'));
  fs.chmodSync(path.join(shop, 'inner'), 0o755);
  fs.symlinkSync('inner', path.join(shop, 'inner-link'));
  assert.throws(() => mkdirIn(at, path.join(shop, 'inner-link'), { mode: 0o700 }), /is not a folder: its mode was not set/);
  assert.equal(fs.statSync(path.join(shop, 'inner')).mode & 0o777, 0o755);
  assert.equal(rmdirIn(at, path.join(shop, 'inner-link')), false);
  assert.ok(fs.existsSync(path.join(shop, 'inner')), 'what the link points to stays');
  assert.equal(rmdirIn(at, path.join(shop, 'inner')), true, 'a real empty folder goes');
  assert.ok(!fs.existsSync(path.join(shop, 'inner')));
});

test('project.json is never written through a link, and one that is a link is not read', async () => {
  const { readManifest, writeManifest } = await import('../../src/pcsetup/workspace.mjs');
  const p = path.join(C.projects, 'linked-manifest');
  fs.mkdirSync(p);
  const target = path.join(outside, 'notes.txt');
  fs.writeFileSync(target, 'not json\n');
  fs.symlinkSync(target, path.join(p, 'project.json'));
  const m = await readManifest(p);
  assert.equal(m.manifest, null);
  assert.match(m.errors[0], /project\.json is a link/);
  assert.throws(() => writeManifest(p, { name: 'linked-manifest', repos: [], memories: {} }), /is a link/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'not json\n');
  fs.rmSync(path.join(p, 'project.json'));
  fs.symlinkSync(path.join(outside, 'new.json'), path.join(p, 'project.json')); // dangling: would be created
  assert.throws(() => writeManifest(p, { name: 'linked-manifest', repos: [], memories: {} }), /is a link/);
  assert.ok(!fs.existsSync(path.join(outside, 'new.json')));
});

test('a project folder the owner keeps elsewhere through a link: not followed and said once, until he names the link', async () => {
  const away = w.clone(w.bare('handbook'), path.join(w.root, 'elsewhere', 'handbook'));
  const link = path.join(C.projects, 'handbook');
  fs.symlinkSync(away, link);
  const map = M.readMap(C.ws).map;
  M.writeMap({ ...map, projects: [...map.projects.filter((p) => p.name !== 'handbook'), { name: 'handbook', url: w.url('handbook'), repos: [] }] }, C.ws);
  w.sh(path.join(C.ws, 'ai_brain'), 'add', '-A');
  w.sh(path.join(C.ws, 'ai_brain'), 'commit', '-q', '-m', 'handbook');
  w.sh(path.join(C.ws, 'ai_brain'), 'push', '-q', 'origin', 'HEAD');
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  let q = await quietUi();
  q.ui.yes = true;
  let r = await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: C.ws, projects: C.projects });
  assert.match(r.plan.find((e) => e.label === 'handbook').result, /skipped: .*handbook leaves its folder through a link/);
  // The command: the plan says it with the line that names the link, the summary once more, the run not a third time.
  const { main } = await import('../../src/workspace/cli.mjs');
  q = await quietUi();
  assert.equal(await main(['restore', w.url('brain'), '--with-projects', '--yes'], { ui: q.ui, write: () => {} }), 0);
  const said = q.text().split('\n').filter((l) => /handbook.*leaves its folder/.test(l));
  assert.equal(said.length, 2, `the plan and the summary:\n${q.text()}`);
  assert.match(said[0], /not followed.*if that link is yours: {2}hoprig workspace mylink add .*handbook\)/);
  assert.doesNotMatch(said[0], /not followed.*not followed/, 'said in plain words once');
  const s = await syncAll(ctx);
  assert.match(s.repos.find((x) => x.label === 'handbook').todo[0].command, /^hoprig workspace mylink add .*handbook$/);
  const { addMyLink } = await import('../../src/workspace/inside.mjs');
  addMyLink(link);
  q = await quietUi();
  q.ui.yes = true;
  r = await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: C.ws, projects: C.projects });
  assert.equal(r.plan.find((e) => e.label === 'handbook').result, 'here');
  assert.ok(!(await syncAll(ctx)).repos.find((x) => x.label === 'handbook').todo.some((t) => t.kind === 'link'));
});
