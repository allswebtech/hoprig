// `hoprig drop`: a project leaves this computer only when everything of it is on its git server. On temporary homes
// with local bare repositories: what drop pushes by itself (a branch only ahead, a branch without an upstream, the
// memory folder), the default branch never without the owner's yes (each of the three answers), the work offered on a
// wip/ branch, the ignored files confirmed by typing the name, the removal, the computer's file, and get afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropOn, dropWorld, getOn, onServer, owner, reset, serverHeads, treeOf } from './dropfix.mjs';

const w = await dropWorld('main', { labels: ['alpha', 'beta'] });
test.after(() => w.cleanup());
const [A, B] = w.computers;
const api = () => path.join(A.shop, 'code', 'shop-api');
const web = () => path.join(A.shop, 'code', 'shop-web');
const memLinks = (c) => {
  const d = path.join(c.claude, 'projects');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.lstatSync(path.join(d, n, 'memory'), { throwIfNoEntry: false })?.isSymbolicLink()) : [];
};
const fresh = async () => {
  if (!fs.existsSync(A.shop)) assert.equal((await getOn(A, ['shop'])).code, 0);
};

/** The tree without the local branch lists (get makes only the default branch local), and each repository's branches. */
const filesOf = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.endsWith(':refs')));
const branchesOf = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => k.endsWith(':refs')).map(([k, v]) => [k.replace(/\/?\.git:refs$/, ''), v.split('\n').filter((l) => l.startsWith('refs/heads/')).map((l) => l.slice(11).split(' '))]));

test('a clean project: dropped, its memory link taken away, this computer\'s file without it, the map keeps it; get brings it back equal', async () => {
  await fresh();
  w.sh(api(), 'switch', '-q', '-c', 'kept');
  w.commit(api(), 'kept.txt', 'k\n');
  w.sh(api(), 'push', '-q', '-u', 'origin', 'kept');
  w.sh(api(), 'switch', '-q', 'main');
  const before = treeOf(A.shop, w.sh);
  assert.ok(memLinks(A).length, 'get made the memory link');
  assert.ok(w.fileHere(A, 'alpha').here.includes('shop'));
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /dropped: it is in the workspace map, not on this computer \(hoprig get shop brings it back\)/);
  assert.equal(fs.existsSync(A.shop), false);
  assert.deepEqual(fs.readdirSync(A.projects).filter((n) => n.startsWith('.shop')), [], 'nothing half made left');
  assert.deepEqual(memLinks(A), []);
  const file = w.fileHere(A, 'alpha');
  assert.ok(!file.here.some((x) => x === 'shop' || x.startsWith('shop/')), JSON.stringify(file.here));
  const map = JSON.parse(fs.readFileSync(path.join(A.brain, 'workspace.json'), 'utf8'));
  assert.ok(map.projects.some((p) => p.name === 'shop'), 'the map keeps the entry');
  assert.equal((map.skip || []).length, 0, 'nothing is added to skip');
  assert.equal((await getOn(A, ['shop'])).code, 0);
  const after = treeOf(A.shop, w.sh);
  assert.deepEqual(filesOf(after), filesOf(before), 'get brings back the tree equal, file for file');
  // Every branch that was here is on the git server at the same commit: get makes the default one local, the others
  // are there as origin/<name> (git switch <name> makes one local again).
  for (const [repo, list] of Object.entries(branchesOf(before))) {
    for (const [b, sha] of list) assert.equal(w.sh(path.join(A.shop, repo), 'rev-parse', `refs/remotes/origin/${b}`), sha, `${repo} ${b}`);
  }
  assert.ok(branchesOf(before)['code/shop-api'].some(([b]) => b === 'kept'), 'the case has a second branch');
});

test('drop pushes by itself, never forcing: a branch only ahead, a branch without an upstream, the memory folder', async () => {
  await reset(A);
  w.sh(api(), 'switch', '-q', '-c', 'feature');
  w.commit(api(), 'f.txt', 'one\n');
  w.sh(api(), 'push', '-q', '-u', 'origin', 'feature');
  w.commit(api(), 'f.txt', 'two\n'); // only ahead of its upstream
  w.sh(api(), 'switch', '-q', 'main');
  w.sh(web(), 'branch', 'idea');
  w.sh(web(), 'switch', '-q', 'idea');
  w.commit(web(), 'idea.txt', 'mine\n'); // never on the server, no upstream
  w.sh(web(), 'switch', '-q', 'main');
  fs.writeFileSync(path.join(A.shop, 'ai_brain', 'claude-memory', 'note.md'), 'learned\n');
  w.sh(A.shop, 'switch', '-q', '-c', 'notes'); // the memory is committed on this branch, which is pushed
  const feature = w.sh(api(), 'rev-parse', 'feature');
  const idea = w.sh(web(), 'rev-parse', 'idea');
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  assert.equal(onServer(w, 'shop-api', 'refs/heads/feature'), feature);
  assert.equal(onServer(w, 'shop-web', 'refs/heads/idea'), idea);
  assert.match(w.sh(path.join(w.server, 'team', 'shop-workspace.git'), 'show', 'notes:ai_brain/claude-memory/note.md'), /learned/);
  assert.equal(fs.existsSync(A.shop), false);
});

test('commits only on the default branch: never pushed without the yes; "stop" stops, "wip" pushes a wip/ branch, "push" pushes main', async () => {
  await reset(A);
  const main0 = onServer(w, 'shop-api', 'refs/heads/main');
  w.commit(api(), 'release.txt', 'ship\n');
  const mine = w.sh(api(), 'rev-parse', 'HEAD');
  const none = await dropOn(A, ['shop']); // no terminal
  assert.equal(none.code, 1);
  assert.match(none.text, /no terminal to ask in: run {2}hoprig drop shop {2}in a terminal/);
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), main0);
  const stop = await dropOn(A, ['shop'], { answers: ['3'] });
  assert.equal(stop.code, 1);
  assert.match(stop.text, /This pushes main of projects\/shop\/code\/shop-api: 1 commit/);
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), main0, 'stop pushes nothing');
  assert.ok(fs.existsSync(A.shop));
  const empty = await dropOn(A, ['shop'], { answers: [''] });
  assert.equal(empty.code, 1, 'an empty answer stops');
  const wip = await dropOn(A, ['shop'], { answers: ['2'] });
  assert.equal(wip.code, 0, wip.text);
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), main0, 'main on the server does not move');
  const heads = serverHeads(w, 'shop-api');
  const name = Object.keys(heads).find((n) => /^wip\/alpha-\d{8}-\d{6}$/.test(n));
  assert.ok(name && heads[name] === mine, JSON.stringify(heads));
  await reset(A);
  w.commit(api(), 'release2.txt', 'ship\n');
  const yes = await dropOn(A, ['shop'], { answers: ['1'] });
  assert.equal(yes.code, 0, yes.text);
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), w.sh(path.join(w.server, 'team', 'shop-api.git'), 'rev-parse', 'main'));
  assert.notEqual(onServer(w, 'shop-api', 'refs/heads/main'), main0, 'push pushes main');
});

test('work not committed: shown, one question; yes commits it on a wip/ branch and pushes it, the default branch does not move; no keeps all', async () => {
  await reset(A);
  fs.writeFileSync(path.join(api(), 'README.md'), 'changed\n');
  fs.writeFileSync(path.join(api(), 'new.txt'), 'untracked\n');
  fs.writeFileSync(path.join(api(), 'staged.txt'), 'v1\n');
  w.sh(api(), 'add', 'staged.txt');
  fs.writeFileSync(path.join(api(), 'staged.txt'), 'v2\n');
  const main0 = w.sh(api(), 'rev-parse', 'main');
  const wipsBefore = Object.keys(serverHeads(w, 'shop-api')).filter((n) => n.startsWith('wip/'));
  const chk = await dropOn(A, ['shop', '--check']);
  assert.equal(chk.code, 1);
  assert.match(chk.text, /commit the work not committed in projects\/shop\/code\/shop-api \(3 files\) on a new wip\/ branch/);
  const no = await dropOn(A, ['shop'], { answers: ['n'] });
  assert.equal(no.code, 1);
  assert.equal(fs.readFileSync(path.join(api(), 'staged.txt'), 'utf8'), 'v2\n', 'nothing thrown away');
  const r = await dropOn(A, ['shop'], { answers: ['y'] });
  assert.equal(r.code, 0, r.text);
  const made = Object.keys(serverHeads(w, 'shop-api')).filter((n) => n.startsWith('wip/') && !wipsBefore.includes(n));
  assert.equal(made.length, 1, JSON.stringify(made));
  const name = made[0];
  const bare = path.join(w.server, 'team', 'shop-api.git');
  assert.equal(w.sh(bare, 'show', `${name}:new.txt`), 'untracked');
  assert.equal(w.sh(bare, 'show', `${name}:staged.txt`), 'v2');
  assert.equal(w.sh(bare, 'show', `${name}~1:staged.txt`), 'v1', 'the staged version is kept as its own commit');
  assert.equal(w.sh(bare, 'rev-parse', 'main'), onServer(w, 'shop-api', 'refs/heads/main'));
  assert.notEqual(w.sh(bare, 'rev-parse', name), main0);
});

test('ignored files that cannot be made again: listed with their size, removed only after the project\'s name is typed; build output and a tracked .env do not stop it; a credentials link is listed, and only the link goes', async () => {
  await reset(A);
  fs.mkdirSync(path.join(api(), 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(api(), 'node_modules', 'x', 'i.js'), 'made again\n');
  fs.mkdirSync(path.join(api(), 'dist'));
  fs.writeFileSync(path.join(api(), 'dist', 'app.js'), 'built\n');
  fs.mkdirSync(path.join(A.ws, 'credentials', 'shop'), { recursive: true });
  fs.writeFileSync(path.join(A.ws, 'credentials', 'shop', 'api.env'), 'KEY=x\n');
  fs.symlinkSync(path.join(A.ws, 'credentials', 'shop', 'api.env'), path.join(api(), '.env'));
  w.commit(web(), '.env', 'TRACKED=1\n'); // a tracked .env is his choice
  w.sh(web(), 'push', '-q');
  // Only a folder of build output git ignores as a whole goes without a word (dropsilent.mjs): a link is a path the drop
  // removes, so it is on the typed list too, with words that say only the link goes and no name of its target.
  const clean = await dropOn(A, ['shop', '--check']);
  assert.equal(clean.code, 1, clean.text);
  assert.match(clean.text, /shop-api\/\.env {2}link \(only the link goes: the file it points to stays where it is\)/);
  assert.doesNotMatch(clean.text, /node_modules\/x|dist\/app|api\.env|credentials/, 'build output is not listed; the target is not named');
  fs.writeFileSync(path.join(A.shop, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(A.shop, 'test-data'));
  fs.writeFileSync(path.join(A.shop, 'test-data', 'dump.sql'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(A.shop, 'run.log'), 'odd\n');
  fs.writeFileSync(path.join(api(), 'deploy.pem'), 'key\n');
  const chk = await dropOn(A, ['shop', '--check']);
  assert.equal(chk.code, 1);
  for (const re of [/shop\/\.env {2}\.env file, 9 B/, /shop\/test-data\/ {2}test data, 2\.0 KB, 1 file/, /shop\/run\.log {2}file, 4 B/, /shop-api\/deploy\.pem {2}key file/]) assert.match(chk.text, re);
  assert.doesNotMatch(chk.text.slice(chk.text.indexOf('Files git ignores')), /node_modules|dist\/|credentials/, 'build output is not on the list to confirm');
  assert.doesNotMatch(chk.text, /credentials/);
  assert.match(chk.text, /drop would delete with it what git ignores and a build or an install makes again: projects\/shop\/code\/shop-api\/dist\/, projects\/shop\/code\/shop-api\/node_modules\//, 'but it is said');
  assert.doesNotMatch(chk.text, /SECRET|KEY=x/, 'no content shown');
  const none = await dropOn(A, ['shop']);
  assert.equal(none.code, 1);
  assert.match(none.text, /no terminal to ask in/);
  const wrong = await dropOn(A, ['shop'], { answers: ['shoop'] });
  assert.equal(wrong.code, 1);
  assert.match(wrong.text, /"shoop" is not shop: nothing is dropped/);
  assert.ok(fs.existsSync(path.join(A.shop, '.env')));
  const ok = await dropOn(A, ['shop'], { answers: ['shop'] });
  assert.equal(ok.code, 0, ok.text);
  assert.equal(fs.existsSync(A.shop), false);
  assert.equal(fs.readFileSync(path.join(A.ws, 'credentials', 'shop', 'api.env'), 'utf8'), 'KEY=x\n', 'the credentials stay');
});
