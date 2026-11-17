// A folder the dashboard did not make, whose own git settings name programs (test/fixtures/hostile-repo.mjs): every
// read of its git state over the real routes of a sandboxed dashboard (quick open, the tree, Source Control's status,
// diff, log and branches, find in files with git grep) starts none of them, and the answers are still right.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hostileRepo } from '../fixtures/hostile-repo.mjs';
import { sandbox } from '../server/helpers.mjs';

const posix = process.platform !== 'win32';
const box = sandbox('editor-hostile');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const projects = path.join(box.root, 'projects');
const h = posix ? hostileRepo(path.join(projects, 'cloned'), path.join(box.root, 'marks')) : null;
// git grep is the engine only where ripgrep is not found: a PATH without it (git itself stays reachable).
const gitDir = (process.env.PATH || '').split(path.delimiter).find((d) => fs.existsSync(path.join(d, 'git')));
const noRg = path.join(box.root, 'bin-no-rg');
fs.mkdirSync(noRg, { recursive: true });
if (gitDir) fs.symlinkSync(path.join(gitDir, 'git'), path.join(noRg, 'git'));

saveConfig({ server: { passwordHash: await hashPassword('pw'), port: 1, roots: [projects] } });
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
const app = createServer({ backend, watch: false, dashboardFile: false, machines: { claudeVersion: async () => null }, editor: { cleanup: false, searchEnv: { ...process.env, PATH: noRg } } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
let cookie = null;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
cookie = (await call('POST', '/api/login', { password: 'pw' })).headers.get('set-cookie').split(';')[0];
const get = (p, o) => call('GET', `${p}?${new URLSearchParams(o)}`);

/** GET a route, and assert that none of the folder's programs ran for it. */
async function read(what, p, o) {
  h.clear();
  const r = await get(p, o);
  assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.json)}`);
  assert.deepEqual(h.ran(), [], `${what} started a program the folder's git settings name`);
  return r.json;
}

test('quick open lists the files of a folder whose git settings name programs, and starts none', { skip: !posix && 'the programs are shell scripts' }, async () => {
  const r = await read('quick open', '/api/code/files', { root: h.dir });
  assert.deepEqual(r.files, ['.gitattributes', 'a.txt', 'b.txt', 'c.md', 'gone.txt', 'new.txt']);
});

test('the tree, Source Control and find in files read it without starting any of its programs, and answer right', { skip: !posix && 'the programs are shell scripts' }, async () => {
  const tree = await read('the tree', '/api/code/tree', { root: h.dir });
  assert.ok(JSON.stringify(tree).includes('a.txt'));

  const s = await read('Source Control\'s status', '/api/code/git/status', { root: h.dir });
  assert.equal(s.branch, 'main');
  assert.deepEqual(s.changes.map((e) => `${e.y} ${e.path}`), ['M a.txt'], 'b.txt and c.md have the same text: not changed');
  assert.deepEqual(s.untracked.map((e) => e.path), ['new.txt']);

  const d = await read('a diff', '/api/code/git/diff', { root: h.dir, path: 'a.txt' });
  assert.deepEqual([d.original, d.modified], ['one\n', 'one\ntwo\n']);
  const gone = await read('a diff whose stored copy is missing', '/api/code/git/diff', { root: h.dir, path: 'gone.txt', staged: '1' });
  assert.equal(gone.originalExists, false, 'not fetched from the folder\'s remote');

  const log = await read('the log', '/api/code/git/log', { root: h.dir });
  assert.deepEqual(log.commits.map((c) => c.subject), ['signed']);
  const one = await read('the log of a file', '/api/code/git/log', { root: h.dir, path: 'a.txt' });
  assert.equal(one.commits.length, 1);
  const b = await read('the branches', '/api/code/git/branches', { root: h.dir });
  assert.equal(b.current, 'main');

  const f = await read('find in files', '/api/code/search', { root: h.dir, q: 'two' });
  assert.equal(f.engine, 'git');
  assert.deepEqual(f.matches.map((m) => `${m.path}:${m.line}`), ['a.txt:2']);
  const ci = await read('find in files, any case', '/api/code/search', { root: h.dir, q: 'STORED', regex: '1' });
  assert.deepEqual(ci.matches.map((m) => m.path), ['gone.txt']);
});

test('what the owner presses runs as git runs it from his terminal: staging a file runs its filter', { skip: !posix && 'the programs are shell scripts' }, async () => {
  h.clear();
  const r = await call('POST', '/api/code/git/stage', { root: h.dir, paths: ['a.txt'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(h.ran().includes('clean'), 'git add runs the clean filter the folder binds, as in a terminal');
  // The status read after it is a read again: nothing of the folder's runs.
  const s = await read('the status after staging', '/api/code/git/status', { root: h.dir });
  assert.deepEqual(s.staged.map((e) => e.path), ['a.txt']);
});
