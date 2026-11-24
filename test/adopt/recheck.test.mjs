// A repository that only looks like Hoprig's layout (another tool's project.json; an AGENTS.md beside a submodule in
// code/) is planned as the repository it is and copied whole; and retire compares every original with its copy again
// itself, right before anything goes: a copy that lost a branch, a stash entry or a file stops it, and nothing of the
// original is removed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { tempHome, writeTree } from '../workspace/helpers.mjs';
import { REAL_GIT, allOf, git, repo, traps } from './fixture.mjs';
import { makePlan, writePlan } from '../../src/adopt/plan.mjs';
import { applyPlan } from '../../src/adopt/apply.mjs';
import { retireProject } from '../../src/adopt/retire.mjs';
import { hasLayout, scanPlaces } from '../../src/adopt/scan.mjs';

let t, place, projects, ws, trap;
const who = { name: 'Alex', email: 'alex@example.invalid' };
const TOKEN = 'ghp_0123456789abcdefghij0123';
before(() => {
  t = tempHome('adopt-recheck');
  ws = path.join(t.home, 'Workspace');
  projects = path.join(ws, 'projects');
  process.env.HOPRIG_WORKSPACE_DIR = ws;
  fs.mkdirSync(projects, { recursive: true });
  place = path.join(t.root, 'code');
  trap = traps(t.root);
});
after(() => t.cleanup());

const arrange = async (dir) => {
  const p = await makePlan(dir, { projects, home: t.home, claude: t.claude });
  writePlan(p);
  const r = await applyPlan(p.name, { projects, workspace: ws, identity: who });
  return { p, r };
};

/** Every working file of `dir` (outside .git) with its content, to show that none is ever lost. */
const files = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
};

/** An ordinary repository with a project.json of another tool, a branch with its own commit, a stash and a token. */
function nxApp() {
  const shop = repo(path.join(place, 'shop'), null, { 'package.json': '{ "name": "shop" }\n', 'project.json': '{ "name": "shop", "sourceRoot": "src", "targets": {} }\n', 'src/main.ts': 'main\n' });
  git(shop, 'checkout', '-q', '-b', 'feature');
  writeTree(shop, { 'src/feature.ts': 'feature\n' });
  git(shop, 'add', '-A');
  git(shop, 'commit', '-qm', 'feature');
  git(shop, 'checkout', '-q', 'main');
  writeTree(shop, { 'src/main.ts': 'half done\n' });
  git(shop, 'stash', 'push', '-q', '-m', 'wip');
  writeTree(shop, { 'config.json': `{ "token": "${TOKEN}" }\n` });
  return shop;
}

test('a repository with another tool\'s project.json is planned as the repository it is, copied whole, and retire loses none of it', async () => {
  const shop = nxApp();
  assert.equal(hasLayout(shop), false, 'not Hoprig\'s layout');
  const s = await scanPlaces([place]);
  const found = s.projects.find((x) => x.name === 'shop');
  assert.equal(found.layout, false);
  assert.equal(found.repos.length, 1);
  const { p, r } = await arrange(shop);
  assert.deepEqual(p.repos.map((x) => [x.rel, x.to]), [['.', 'code/shop']]);
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  for (const what of ['HEAD', 'refs', 'stash', 'fsck']) assert.ok(r.lines.some((l) => l.what === what && l.ok), `a ${what} proof line`);
  const copy = path.join(projects, 'shop', 'code', 'shop');
  assert.ok(git(copy, 'branch', '--list', 'feature'), 'the branch is in the copy');
  assert.equal(git(copy, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is in the copy');
  const sec = r.lines.find((l) => l.what === 'secrets');
  assert.match(sec.words, /^1 secret-shaped value/, sec.words);
  assert.ok(!sec.words.includes(TOKEN), 'never a value');
  const kept = files(shop);
  const res = await retireProject('shop', { projects, ask: async () => 'shop' });
  assert.ok(res.ok, res.words);
  const now = files(copy);
  for (const [rel, text] of Object.entries(kept)) assert.equal(now[rel], text, `${rel} is in the copy as it was`);
  assert.ok(git(copy, 'branch', '--list', 'feature'));
  assert.deepEqual(trap.trapped(), []);
});

test('an AGENTS.md beside a submodule in code/ is not the layout: the repository is copied whole with its submodule', async () => {
  const lib = repo(path.join(t.root, 'libsrc'), null, { 'lib.js': 'lib\n' });
  const app = repo(path.join(place, 'app'), null, { 'AGENTS.md': '# app rules\n', 'index.js': 'app\n' });
  execFileSync(REAL_GIT, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'code/lib'], { cwd: app, stdio: 'ignore' });
  git(app, 'commit', '-qm', 'the submodule');
  writeTree(app, { 'keys.json': `{ "key": "${TOKEN}" }\n` });
  assert.equal(hasLayout(app), false);
  const { p, r } = await arrange(app);
  assert.deepEqual(p.repos.map((x) => [x.rel, x.to]), [['.', 'code/app']]);
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  const copy = path.join(projects, 'app', 'code', 'app');
  assert.equal(fs.readFileSync(path.join(copy, 'code', 'lib', 'lib.js'), 'utf8'), 'lib\n', 'the submodule came along');
  assert.match(r.lines.find((l) => l.what === 'secrets').words, /^1 secret-shaped value/);
  const kept = files(app);
  const res = await retireProject('app', { projects, ask: async () => 'app' });
  assert.ok(res.ok, res.words);
  const now = files(copy);
  for (const [rel, text] of Object.entries(kept)) assert.equal(now[rel], text, `${rel} is in the copy as it was`);
});

test('retire compares again itself: a copy that lost a branch, a stash entry and a file stops it, and nothing is removed', async () => {
  const den = repo(path.join(place, 'den'), null, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  git(den, 'branch', 'side');
  writeTree(den, { 'a.txt': 'stashed\n' });
  git(den, 'stash', 'push', '-q');
  const { r } = await arrange(den);
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  // The copy loses things after apply said done; the original stays as it was, so the fingerprint still matches.
  const copy = path.join(projects, 'den', 'code', 'den');
  git(copy, 'branch', '-q', '-D', 'side');
  git(copy, 'stash', 'drop', '-q');
  fs.rmSync(path.join(copy, 'b.txt'));
  const before = allOf(den);
  const said = [];
  const res = await retireProject('den', { projects, ask: async () => 'den', say: (s) => said.push(s) });
  assert.equal(res.ok, false);
  assert.match(res.words, /1 branch/);
  assert.match(res.words, /1 stash entry/);
  assert.match(res.words, /1 working file/);
  assert.match(res.words, /Nothing is removed/);
  assert.deepEqual(allOf(den), before, 'the original is as it was');
});

test('retire goes on when the copy only has more: a new commit on a branch of the copy loses nothing of the original', async () => {
  const fox = repo(path.join(place, 'fox'), null, { 'a.txt': 'a\n' });
  const { r } = await arrange(fox);
  assert.ok(r.ok);
  const copy = path.join(projects, 'fox', 'code', 'fox');
  writeTree(copy, { 'new.txt': 'new work\n' });
  git(copy, 'add', 'new.txt');
  git(copy, '-c', 'user.name=Alex', '-c', 'user.email=alex@example.invalid', 'commit', '-qm', 'new work in the copy');
  const res = await retireProject('fox', { projects, ask: async () => 'fox' });
  assert.ok(res.ok, res.words);
  assert.ok(!fs.existsSync(fox));
});
