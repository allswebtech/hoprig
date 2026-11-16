// Source Control routes over real HTTP against a sandboxed dashboard and a temporary repository: status (renames,
// conflicts, untracked files, odd names), the sides of a diff, stage, unstage, discard, commit (a refusing hook),
// log, branches, a folder that is not a repository, and file names that look like options or pathspecs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor-git');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { parseStatusV2 } = await import('../../src/editor/git.mjs');

const projects = path.join(box.root, 'projects');
const repo = path.join(projects, 'repo');
const plain = path.join(projects, 'plain');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(plain, { recursive: true });
const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
g('init', '-q', '-b', 'main');
write('a.txt', 'one\ntwo\n');
write('sub/b é.txt', 'bee\n');
write('old.txt', 'move me\n');
g('add', '.');
g('commit', '-qm', 'first');

saveConfig({ server: { passwordHash: await hashPassword('pw'), port: 1, roots: [projects] } });
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
const app = createServer({ backend, watch: false, dashboardFile: false, machines: { claudeVersion: async () => null }, editor: { cleanup: false } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
let cookie = null;
cookie = (await call('POST', '/api/login', { password: 'pw' })).headers.get('set-cookie').split(';')[0];
const get = (p, o) => call('GET', `${p}?${new URLSearchParams(o)}`);
const post = (p, b) => call('POST', p, b);
const status = async (root = repo) => (await get('/api/code/git/status', { root })).json;
const paths = (list) => list.map((e) => e.path).sort();

test('status: branch, staged, changed, untracked, a rename, names with spaces and odd letters', async () => {
  write('a.txt', 'one\ntwo\nthree\n');
  write('new file ü.txt', 'new\n');
  g('mv', 'old.txt', 'moved.txt');
  write('sub/b é.txt', 'bee!\n');
  g('add', 'sub/b é.txt');
  const s = await status();
  assert.equal(s.repo, true);
  assert.equal(s.branch, 'main');
  assert.deepEqual([s.upstream, s.ahead, s.behind], [null, 0, 0]);
  assert.deepEqual(paths(s.changes), ['a.txt']);
  assert.deepEqual(paths(s.untracked), ['new file ü.txt']);
  assert.deepEqual(s.staged.map((e) => [e.path, e.x, e.from || null]).sort(), [['moved.txt', 'R', 'old.txt'], ['sub/b é.txt', 'M', null]]);
  // Opened on a sub-folder: paths are relative to it, and only what is inside it.
  const sub = await status(path.join(repo, 'sub'));
  assert.deepEqual([paths(sub.staged), paths(sub.changes), sub.prefix], [['b é.txt'], [], 'sub']);
});

test('a folder that is not a repository: status says so, the rest is refused plainly', async () => {
  const s = await status(plain);
  assert.deepEqual([s.repo, s.repos], [false, []]);
  for (const [p, b] of [['/api/code/git/stage', { root: plain, paths: ['x'] }], ['/api/code/git/commit', { root: plain, message: 'm' }]]) {
    const r = await post(p, b);
    assert.deepEqual([r.status, r.json.code], [409, 'not-a-repo'], p);
  }
  assert.equal((await get('/api/code/git/log', { root: plain })).status, 409);
});

test('the diff sides: index against the file on disk, and HEAD against the index', async () => {
  let r = await get('/api/code/git/diff', { root: repo, path: 'a.txt' });
  assert.deepEqual([r.status, r.json.original, r.json.modified], [200, 'one\ntwo\n', 'one\ntwo\nthree\n']);
  r = await get('/api/code/git/diff', { root: repo, path: 'sub/b é.txt', staged: '1' });
  assert.deepEqual([r.json.original, r.json.modified], ['bee\n', 'bee!\n']);
  r = await get('/api/code/git/diff', { root: path.join(repo, 'sub'), path: 'b é.txt', staged: '1' });
  assert.deepEqual([r.json.original, r.json.modified], ['bee\n', 'bee!\n'], 'relative to a sub-folder too');
  r = await get('/api/code/git/diff', { root: repo, path: 'new file ü.txt' });
  assert.deepEqual([r.json.original, r.json.originalExists, r.json.modified], ['', false, 'new\n'], 'a new file has an empty original');
  fs.writeFileSync(path.join(repo, 'pic.bin'), Buffer.from([1, 0, 2]));
  r = await get('/api/code/git/diff', { root: repo, path: 'pic.bin' });
  assert.equal(r.json.binary, true);
  fs.rmSync(path.join(repo, 'pic.bin'));
});

test('stage, unstage and discard (a tracked file goes back, a new file is deleted only when confirmed)', async () => {
  let r = await post('/api/code/git/stage', { root: repo, paths: ['a.txt', 'new file ü.txt'] });
  assert.equal(r.status, 200);
  let s = await status();
  assert.ok(paths(s.staged).includes('a.txt') && paths(s.staged).includes('new file ü.txt'));
  r = await post('/api/code/git/unstage', { root: repo, paths: ['a.txt', 'new file ü.txt'] });
  assert.equal(r.status, 200);
  s = await status();
  assert.deepEqual([paths(s.changes), paths(s.untracked)], [['a.txt'], ['new file ü.txt']]);
  assert.equal((await post('/api/code/git/discard', { root: repo, paths: ['a.txt'] })).status, 400, 'needs confirm');
  r = await post('/api/code/git/discard', { root: repo, paths: ['a.txt', 'new file ü.txt'], confirm: true });
  assert.deepEqual([r.status, r.json.restored, r.json.deleted], [200, ['a.txt'], ['new file ü.txt']]);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(fs.existsSync(path.join(repo, 'new file ü.txt')), false);
  for (const bad of [[], ['../x'], ['.git/config'], ['no-ai/x'], Array(501).fill('a.txt')]) {
    assert.equal((await post('/api/code/git/stage', { root: repo, paths: bad })).status, bad[0] === 'no-ai/x' || bad[0] === '.git/config' ? 403 : 400, JSON.stringify(bad).slice(0, 40));
  }
});

test('names that look like options or pathspecs are only ever those files', async () => {
  write('--output=x', 'opt\n');
  write(':(glob)*', 'magic\n');
  write('a*.txt', 'star\n');
  let s = await status();
  assert.ok(['--output=x', ':(glob)*', 'a*.txt'].every((n) => paths(s.untracked).includes(n)));
  // A leading "-" is refused at the door; the others stage just themselves.
  assert.equal((await post('/api/code/git/stage', { root: repo, paths: ['--output=x'] })).status, 400);
  assert.equal((await post('/api/code/git/stage', { root: repo, paths: ['a*.txt'] })).status, 200);
  s = await status();
  assert.ok(paths(s.staged).includes('a*.txt'));
  assert.ok(!paths(s.staged).includes('a.txt'), '"a*.txt" did not match a.txt');
  assert.equal((await post('/api/code/git/stage', { root: repo, paths: [':(glob)*'] })).status, 200);
  s = await status();
  assert.ok(paths(s.untracked).includes('--output=x'), 'the magic name did not stage everything');
  assert.equal(fs.existsSync(path.join(repo, 'x')), false, 'no file "x" written by an --output option');
  await post('/api/code/git/unstage', { root: repo, paths: ['a*.txt', ':(glob)*'] });
  for (const n of ['--output=x', ':(glob)*', 'a*.txt']) fs.rmSync(path.join(repo, n));
});

test('commit: an empty message and nothing staged are refused; a refusing hook is reported; log and branches', async () => {
  assert.equal((await post('/api/code/git/commit', { root: repo, message: '  ' })).status, 400);
  g('reset', '-q');
  let r = await post('/api/code/git/commit', { root: repo, message: 'nothing' });
  assert.deepEqual([r.status, r.json.code], [409, 'nothing-staged']);
  await post('/api/code/git/stage', { root: repo, paths: ['moved.txt', 'old.txt', 'sub/b é.txt'] });
  // The repository's own hooks folder, whatever core.hooksPath the computer's git settings name.
  g('config', 'core.hooksPath', '.git/hooks');
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed: fix it" >&2\nexit 1\n', { mode: 0o755 });
  r = await post('/api/code/git/commit', { root: repo, message: 'second' });
  assert.deepEqual([r.status, r.json.code], [409, 'commit-failed']);
  assert.match(r.json.error, /lint failed: fix it/);
  fs.rmSync(hook);
  r = await post('/api/code/git/commit', { root: repo, message: 'second: move and edit' });
  assert.equal(r.status, 200);
  assert.match(r.json.commit, /^[0-9a-f]{7,}$/);
  r = await get('/api/code/git/log', { root: repo });
  assert.deepEqual(r.json.commits.map((c) => c.subject), ['second: move and edit', 'first']);
  assert.ok(r.json.commits[0].at > 0 && r.json.commits[0].author.length > 0 && /^[0-9a-f]{40}$/.test(r.json.commits[0].hash));
  r = await get('/api/code/git/log', { root: repo, n: '1', path: 'a.txt' });
  assert.deepEqual(r.json.commits.map((c) => c.subject), ['first']);
  assert.equal((await get('/api/code/git/log', { root: repo, n: '500' })).status, 400);
  g('branch', 'feature');
  r = await get('/api/code/git/branches', { root: repo });
  assert.deepEqual([r.json.current, r.json.local.map((b) => b.name)], ['main', ['feature', 'main']]);
});

test('unstage before the first commit, and a project whose repositories are inside it', async () => {
  const fresh = path.join(projects, 'fresh');
  fs.mkdirSync(path.join(fresh, 'code', 'web'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: fresh });
  fs.writeFileSync(path.join(fresh, 'x.txt'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: path.join(fresh, 'code', 'web') });
  assert.equal((await post('/api/code/git/stage', { root: fresh, paths: ['x.txt'] })).status, 200);
  assert.equal((await post('/api/code/git/unstage', { root: fresh, paths: ['x.txt'] })).status, 200);
  const s = await status(fresh);
  assert.deepEqual([paths(s.staged), s.repos], [[], ['code/web']]);
  assert.deepEqual((await get('/api/code/git/log', { root: fresh })).json.commits, []);
});

test('the porcelain v2 parser: a conflict, a rename with spaces, a detached head', () => {
  const z = [
    '# branch.oid abc', '# branch.head (detached)', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt', 'old name.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 both.txt',
    '1 .M N... 100644 100644 100644 h1 h1 sub/file.txt',
    '? sub/new.txt', '',
  ].join('\0');
  const s = parseStatusV2(Buffer.from(z), 'sub/');
  assert.deepEqual([s.branch, s.detached, s.upstream, s.ahead, s.behind], [null, true, 'origin/main', 2, 1]);
  assert.deepEqual(s.staged, [{ path: '../new name.txt', x: 'R', y: '.', from: '../old name.txt' }]);
  assert.deepEqual(s.conflicts, [{ path: '../both.txt', x: 'U', y: 'U' }]);
  assert.deepEqual(s.changes, [{ path: 'file.txt', x: '.', y: 'M' }]);
  assert.deepEqual(s.untracked, [{ path: 'new.txt', x: '?', y: '?' }]);
});
