// Credential links made from project.json (credlinks.mjs, inside.mjs credLinkIn): only in a place git ignores, never
// over anything, only to a target really inside the credentials folder, relative, and "waiting" while the folder is
// not here. Each case on a temporary home.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome, writeTree } from './helpers.mjs';

const h = tempHome('credlinks');
test.after(() => h.cleanup());
const { makeCredLinks, planCredLinks, shownLinks, linkLine } = await import('../../src/workspace/credlinks.mjs');
const { validateManifest } = await import('../../src/pcsetup/workspace.mjs');

let n = 0;
/** A workspace with a credentials folder and the project shop (a git repository that ignores .env.local and cred/). */
function world({ creds = true } = {}) {
  const ws = path.join(h.root, `ws${++n}`);
  const projects = path.join(ws, 'projects');
  const root = path.join(projects, 'shop');
  writeTree(root, { '.gitignore': '.env.local\n/cred\n/code/*\n', 'README.md': '# shop\n', 'tracked.env': 'x\n' });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start']);
  const cdir = path.join(ws, 'credentials');
  if (creds) {
    writeTree(cdir, { 'shop/shop.env.local': 'KEY=marker\n', 'shop/keys/a.key': 'k\n' });
    fs.chmodSync(cdir, 0o700);
  }
  return { ws, projects, root, cdir, at: { dir: ws, projects } };
}
const plan = async (w, credentials) => planCredLinks(w.root, validateManifest({ name: 'shop', repos: [], credentials }).manifest, { at: w.at });

test('a link in an ignored place is made, relative, to a file and to a folder; git status stays clean', async () => {
  const w = world();
  const p = await plan(w, { '.env.local': 'shop/shop.env.local', cred: 'shop/keys' });
  assert.deepEqual(p.map((e) => e.state), ['make', 'make']);
  makeCredLinks(w.root, p, { at: w.at });
  assert.deepEqual(p.map((e) => e.state), ['made', 'made']);
  const l = fs.readlinkSync(path.join(w.root, '.env.local'));
  assert.equal(path.isAbsolute(l), false, 'relative');
  assert.equal(fs.readFileSync(path.join(w.root, '.env.local'), 'utf8'), 'KEY=marker\n');
  assert.ok(fs.existsSync(path.join(w.root, 'cred', 'a.key')));
  assert.equal(execFileSync('git', ['-C', w.root, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  // A second run: left as it is.
  assert.deepEqual((await plan(w, { '.env.local': 'shop/shop.env.local' })).map((e) => e.state), ['ok']);
  // The workspace moved: the relative link still works.
  const moved = path.join(h.root, `moved${n}`);
  fs.renameSync(w.ws, moved);
  assert.equal(fs.readFileSync(path.join(moved, 'projects', 'shop', '.env.local'), 'utf8'), 'KEY=marker\n');
});

test('a tracked place and a place git does not ignore are refused, with the fix', async () => {
  const w = world();
  fs.rmSync(path.join(w.root, 'tracked.env'));
  const p = await plan(w, { 'tracked.env': 'shop/shop.env.local', 'open.env': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'refused');
  assert.match(p[0].why, /tracks tracked\.env/);
  assert.match(p[0].fix, /rm --cached -- tracked\.env.*\/tracked\.env to its \.gitignore/);
  assert.equal(p[1].state, 'refused');
  assert.match(p[1].why, /does not ignore open\.env/);
  assert.match(p[1].fix, /add the line \/open\.env to .*\.gitignore/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.existsSync(path.join(w.root, 'open.env')), false);
});

test('never over anything: a real file named, a link elsewhere reported, a right link left', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.root, '.env.local'), 'mine\n');
  fs.mkdirSync(path.join(w.root, 'cred'));
  const p = await plan(w, { '.env.local': 'shop/shop.env.local', cred: 'shop/keys' });
  assert.deepEqual(p.map((e) => e.state), ['in-the-way', 'in-the-way']);
  assert.match(p[0].why, /\.env\.local is a real file/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.readFileSync(path.join(w.root, '.env.local'), 'utf8'), 'mine\n', 'never replaced');
  fs.rmSync(path.join(w.root, '.env.local'));
  fs.symlinkSync('README.md', path.join(w.root, '.env.local'));
  const q = await plan(w, { '.env.local': 'shop/shop.env.local' });
  assert.equal(q[0].state, 'wrong');
  assert.match(linkLine(q[0], 'shop'), /points elsewhere/);
  makeCredLinks(w.root, q, { at: w.at });
  assert.equal(fs.readlinkSync(path.join(w.root, '.env.local')), 'README.md', 'never replaced');
});

test('a missing target is named and nothing is made; nothing is written into the credentials folder', async () => {
  const w = world();
  const before = fs.readdirSync(w.cdir, { recursive: true }).sort();
  const p = await plan(w, { '.env.local': 'shop/missing.env' });
  assert.equal(p[0].state, 'no-target');
  assert.match(linkLine(p[0], 'shop'), /shop\/\.env\.local → credentials\/shop\/missing\.env: not made: its target is not in the credentials folder/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.existsSync(path.join(w.root, '.env.local')), false, 'no link to nothing, no empty file');
  assert.equal(fs.lstatSync(path.join(w.root, '.env.local'), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(fs.readdirSync(w.cdir, { recursive: true }).sort(), before);
});

test('no credentials folder: each link waits, and is made once the folder is there', async () => {
  const w = world({ creds: false });
  const p = await plan(w, { '.env.local': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'waiting');
  assert.match(linkLine(p[0], 'shop'), /waiting for the credentials/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.existsSync(path.join(w.root, '.env.local')), false);
  writeTree(w.cdir, { 'shop/shop.env.local': 'K=1\n' });
  const q = await plan(w, { '.env.local': 'shop/shop.env.local' });
  makeCredLinks(w.root, q, { at: w.at });
  assert.equal(q[0].state, 'made');
});

test('a target that leaves the folder through a link inside it, a credentials folder that is a link, a place that leads out: refused', async () => {
  const w = world();
  const outside = path.join(h.root, `outside${n}`);
  writeTree(outside, { 'secret.txt': 'x\n' });
  fs.symlinkSync(outside, path.join(w.cdir, 'shop', 'out'));
  const p = await plan(w, { '.env.local': 'shop/out/secret.txt' });
  assert.equal(p[0].state, 'refused');
  assert.match(p[0].why, /leaves the credentials folder/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.existsSync(path.join(w.root, '.env.local')), false);
  // The place: code/ is a link out of the project.
  fs.symlinkSync(outside, path.join(w.root, 'code'));
  const q = await plan(w, { 'code/.env.local': 'shop/shop.env.local' });
  assert.equal(q[0].state, 'refused');
  assert.match(q[0].why, /^its place: /);
  assert.equal(fs.existsSync(path.join(outside, '.env.local')), false);
  // The credentials folder itself is a link to elsewhere.
  const w2 = world({ creds: false });
  fs.symlinkSync(path.join(w.cdir), w2.cdir);
  const r = await plan(w2, { '.env.local': 'shop/shop.env.local' });
  assert.equal(r[0].state, 'refused');
  assert.match(r[0].why, /^the credentials folder: /);
});

test('a refused project.json entry is in the plan with why, and the shown plan has no absolute path', async () => {
  const w = world();
  const p = await plan(w, { '../x': 'shop/shop.env.local', '.env.local': '/etc/passwd' });
  assert.deepEqual(p.map((e) => e.state), ['refused', 'refused']);
  const shown = JSON.stringify(shownLinks(p));
  assert.equal(shown.includes(w.ws), false);
});

test('why and fix name no absolute path: a place not ignored, a tracked one, in a code repository, one that leads out', async () => {
  const w = world();
  const api = path.join(w.root, 'code', 'shop-api');
  writeTree(api, { '.gitignore': '/.env\n', 'keep.env': 'x\n' });
  execFileSync('git', ['-C', api, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', api, 'add', '-A']);
  execFileSync('git', ['-C', api, 'commit', '-q', '-m', 'start']);
  const outside = path.join(h.root, `outside-abs${n}`);
  writeTree(outside, { 'secret.txt': 'x\n' });
  fs.symlinkSync(outside, path.join(w.root, 'away'));
  fs.symlinkSync(outside, path.join(w.cdir, 'shop', 'out'));
  // Tracked, but gone from the disk (else a real file is in the way): git still tracks them.
  fs.rmSync(path.join(w.root, 'tracked.env'));
  fs.rmSync(path.join(api, 'keep.env'));
  const p = await plan(w, { 'open.env': 'shop/shop.env.local', 'tracked.env': 'shop/shop.env.local', 'code/shop-api/x.env': 'shop/shop.env.local', 'code/shop-api/keep.env': 'shop/shop.env.local', 'away/a.env': 'shop/shop.env.local', 'cred': 'shop/out/secret.txt' });
  assert.deepEqual(p.map((e) => e.state), ['refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
  assert.match(p[0].fix, /^add the line \/open\.env to the project's \.gitignore$/);
  assert.match(p[2].why, /^the repository code\/shop-api does not ignore x\.env/);
  assert.equal(p[2].fix, 'add the line /x.env to code/shop-api/.gitignore');
  assert.match(p[3].fix, /^run git rm --cached -- keep\.env in code\/shop-api, then add the line \/keep\.env to its \.gitignore$/);
  assert.match(p[4].why, /^its place: away leaves its folder through a link/);
  assert.match(p[5].why, /credentials\/shop\/out leaves its folder through a link/);
  const shown = JSON.stringify(shownLinks(p));
  for (const abs of [h.root, fs.realpathSync(h.root), outside]) assert.equal(shown.includes(abs), false, `an absolute path in ${shown}`);
  for (const e of p) assert.equal(linkLine(e, 'shop').includes(h.root), false, linkLine(e, 'shop'));
});

test('a cut-off credentials clone and set-up\'s starting folder: each link waits, nothing is made', async () => {
  const { CREDENTIALS_README } = await import('../../src/workspace/setup.mjs');
  // A clone killed while it fetched: only .git, no commit checked out, no index.
  const w = world({ creds: false });
  const server = path.join(h.root, `creds-server${n}`);
  const seed = path.join(h.root, `creds-seed${n}`);
  writeTree(seed, { 'shop/shop.env.local': 'K=1\n' });
  execFileSync('git', ['-C', seed, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', seed, 'add', '-A']);
  execFileSync('git', ['-C', seed, 'commit', '-q', '-m', 'c']);
  execFileSync('git', ['clone', '-q', '--bare', seed, server]);
  execFileSync('git', ['clone', '-q', '--no-checkout', server, w.cdir]);
  fs.rmSync(path.join(w.cdir, '.git', 'index'), { force: true });
  let p = await plan(w, { '.env.local': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'waiting', 'killed after the commit was fetched');
  // Killed while it fetched: no commit at all.
  fs.rmSync(w.cdir, { recursive: true, force: true });
  fs.mkdirSync(w.cdir, { mode: 0o700 });
  execFileSync('git', ['-C', w.cdir, 'init', '-q', '-b', 'main']);
  fs.rmSync(path.join(w.cdir, '.git', 'index'), { force: true });
  p = await plan(w, { '.env.local': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'waiting', 'only .git');
  // The starting folder of workspace setup.
  fs.rmSync(w.cdir, { recursive: true, force: true });
  writeTree(w.cdir, { 'README.md': CREDENTIALS_README });
  p = await plan(w, { '.env.local': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'waiting', 'set-up\'s README only');
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.lstatSync(path.join(w.root, '.env.local'), { throwIfNoEntry: false }), undefined);
  // A README the owner changed, or a repository checked out: the credentials are here, and a missing target is said.
  fs.appendFileSync(path.join(w.cdir, 'README.md'), 'mine\n');
  p = await plan(w, { '.env.local': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'no-target');
});

test('a repository git cannot read is never taken for no repository: a broken setting, a .git that points nowhere', async () => {
  const w = world();
  fs.appendFileSync(path.join(w.root, '.git', 'config'), '[broken\n');
  const p = await plan(w, { 'open.env': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'refused');
  assert.match(p[0].why, /git could not read the repository that holds it/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.lstatSync(path.join(w.root, 'open.env'), { throwIfNoEntry: false }), undefined);
  // A worktree whose main repository moved: its .git file points to a folder that is gone.
  const v = world();
  writeTree(path.join(v.root, 'code', 'wt'), { 'README.md': 'x\n' });
  fs.writeFileSync(path.join(v.root, 'code', 'wt', '.git'), `gitdir: ${path.join(h.root, 'gone', 'worktrees', 'wt')}\n`);
  fs.rmSync(path.join(v.root, '.git'), { recursive: true, force: true }); // the project itself is no repository here
  const q = await plan(v, { 'code/wt/open.env': 'shop/shop.env.local' });
  assert.equal(q[0].state, 'refused', JSON.stringify(q[0]));
  // Truly in no repository: made.
  const u = world();
  fs.rmSync(path.join(u.root, '.git'), { recursive: true, force: true });
  const r = await plan(u, { 'open.env': 'shop/shop.env.local' });
  assert.equal(r[0].state, 'make');
});

test('a place that reaches a .git folder through a link in the project is refused, in the plan and when it is made', async () => {
  const { credLinkIn } = await import('../../src/workspace/inside.mjs');
  for (const [ignore, name] of [['*\n!.gitignore\n', 'cfg'], ['*.env\npre-commit\n', 'CFG']]) {
    const w = world();
    fs.writeFileSync(path.join(w.root, '.gitignore'), ignore);
    fs.symlinkSync(name === 'CFG' ? '.git/hooks' : '.git', path.join(w.root, name));
    const place = name === 'CFG' ? 'CFG/pre-commit' : 'cfg/hooks/pre-commit';
    const p = await plan(w, { [place]: 'shop/shop.env.local' });
    assert.equal(p[0].state, 'refused', JSON.stringify(p[0]));
    assert.match(p[0].why, /inside a git folder/);
    makeCredLinks(w.root, p, { at: w.at });
    assert.equal(fs.lstatSync(path.join(w.root, '.git', 'hooks', 'pre-commit'), { throwIfNoEntry: false }), undefined);
    // The act checks it again by itself (a plan a moment old).
    assert.throws(() => credLinkIn({ ...w.at, root: w.root }, path.join(w.root, ...place.split('/')), path.join(w.cdir, 'shop', 'shop.env.local'), w.cdir), { code: 'EGITDIR' });
    assert.equal(fs.lstatSync(path.join(w.root, '.git', 'hooks', 'pre-commit'), { throwIfNoEntry: false }), undefined);
  }
});

test('a code repository not cloned yet: a place that is its folder or holds it is refused, one inside it waits', async () => {
  const w = world();
  const repos = [{ dir: 'code/shop-web', url: 'https://github.com/example/shop-web.git' }, { dir: 'code/shop-api', url: 'https://github.com/example/shop-api.git' }];
  const m = validateManifest({ name: 'shop', repos, credentials: { 'code/shop-web': 'shop/keys', code: 'shop/keys', 'code/shop-api/.env': 'shop/shop.env.local' } }).manifest;
  assert.deepEqual(m.credentialsRefused.map((r) => r.place), ['code/shop-web', 'code'], 'its folder, and a folder above it');
  // An empty folder where shop-api is cloned later (one that failed to clone): the parent's rules are not asked.
  fs.mkdirSync(path.join(w.root, 'code', 'shop-api'), { recursive: true });
  const p = await planCredLinks(w.root, m, { at: w.at });
  assert.deepEqual(p.map((e) => [e.place, e.state]), [['code/shop-web', 'refused'], ['code', 'refused'], ['code/shop-api/.env', 'nofolder']]);
  assert.match(linkLine(p[2], 'shop'), /waiting: the folder it goes in is not here yet .*\(code\/shop-api is not cloned yet\)/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.deepEqual(fs.readdirSync(path.join(w.root, 'code', 'shop-api')), [], 'nothing in the clone\'s way');
  assert.equal(fs.lstatSync(path.join(w.root, 'code', 'shop-web'), { throwIfNoEntry: false }), undefined);
  // Cloned (its own .gitignore ignores .env): made.
  writeTree(path.join(w.root, 'code', 'shop-api'), { '.gitignore': '/.env\n' });
  execFileSync('git', ['-C', path.join(w.root, 'code', 'shop-api'), 'init', '-q', '-b', 'main']);
  const q = await planCredLinks(w.root, m, { at: w.at });
  assert.equal(q[2].state, 'make');
});

test('a project kept elsewhere as the owner\'s own link: the planned link is made and leads to the target', async () => {
  for (const which of ['project', 'projects folder']) {
    const w = world();
    const disk = path.join(h.root, `disk${n}`);
    fs.mkdirSync(disk);
    const moved = which === 'project' ? w.root : w.projects;
    const away = path.join(disk, path.basename(moved));
    fs.renameSync(moved, away);
    fs.symlinkSync(away, moved);
    const at = { ...w.at, mylinks: [moved] };
    const p = await planCredLinks(w.root, validateManifest({ name: 'shop', repos: [], credentials: { '.env.local': 'shop/shop.env.local' } }).manifest, { at });
    assert.equal(p[0].state, 'make', `${which}: ${JSON.stringify(p[0])}`);
    makeCredLinks(w.root, p, { at });
    assert.equal(p[0].state, 'made', `${which}: ${JSON.stringify(p[0])}`);
    const l = path.join(w.root, '.env.local');
    assert.equal(path.isAbsolute(fs.readlinkSync(l)), false, 'relative');
    assert.equal(fs.readFileSync(l, 'utf8'), 'KEY=marker\n');
    assert.equal((await planCredLinks(w.root, validateManifest({ name: 'shop', repos: [], credentials: { '.env.local': 'shop/shop.env.local' } }).manifest, { at }))[0].state, 'ok');
  }
});

test('a right link already there in a place git does not ignore is said with the fix, and left as it is', async () => {
  const w = world();
  fs.symlinkSync('../../credentials/shop/shop.env.local', path.join(w.root, 'open.env'));
  const p = await plan(w, { 'open.env': 'shop/shop.env.local' });
  assert.equal(p[0].state, 'open');
  assert.equal(shownLinks(p)[0].kind, 'refused');
  assert.match(linkLine(p[0], 'shop'), /shop\/open\.env → credentials\/shop\/shop\.env\.local: linked, but in a place git does not ignore.*;  add the line \/open\.env to the project's \.gitignore/);
  makeCredLinks(w.root, p, { at: w.at });
  assert.equal(fs.readlinkSync(path.join(w.root, 'open.env')), '../../credentials/shop/shop.env.local', 'left as it is');
  // Ignored: linked.
  fs.appendFileSync(path.join(w.root, '.gitignore'), '/open.env\n');
  assert.equal((await plan(w, { 'open.env': 'shop/shop.env.local' }))[0].state, 'ok');
});
