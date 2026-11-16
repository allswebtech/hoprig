// How far the editor reaches is the dashboard's one setting (server.reach, folders.mjs reachRoots), shared with Files
// and new sessions: the allowed folders, or the whole disk. Either way the workspace's credentials folder, the system's
// views of processes and devices and Hoprig's own folders stay locked. locate() (paths.mjs) turns the full paths Files
// sends into the editor's (root, path inside it) and refuses what the editor refuses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor-reach');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { locate } = await import('../../src/editor/paths.mjs');
const { reachRoots } = await import('../../src/server/folders.mjs');

fs.mkdirSync(path.join(box.root, 'projects'));
const projects = fs.realpathSync(path.join(box.root, 'projects'));
const outside = path.join(fs.realpathSync(box.root), 'elsewhere');
const ws = fs.realpathSync(box.workspace);
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'notes.txt'), 'outside\n');
fs.mkdirSync(path.join(ws, 'credentials'), { recursive: true });
fs.writeFileSync(path.join(ws, 'credentials', 'key.env'), 'KEY=fake-key-123\n');
fs.writeFileSync(path.join(ws, 'readme.md'), '# ws\n');
fs.writeFileSync(path.join(projects, 'todo.md'), 'buy milk\n');

saveConfig({ server: { passwordHash: await hashPassword('right-password'), port: 1, roots: [projects, ws] } });
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
const app = createServer({ backend, watch: false, dashboardFile: false, machines: { claudeVersion: async () => null }, editor: { cleanup: false } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: base, ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const cookie = (await call('POST', '/api/login', { password: 'right-password' })).headers.get('set-cookie').split(';')[0];
const q = (o) => new URLSearchParams(o).toString();
const get = (p, o) => call('GET', `${p}?${q(o)}`, null, { Cookie: cookie });
const post = (p, body) => call('POST', p, body, { Cookie: cookie });
const reach = (v) => post('/api/settings', { server: { reach: v } });

test('the workspace\'s credentials folder is locked for the editor, read and write', async () => {
  assert.equal((await get('/api/code/file', { root: ws, path: 'readme.md' })).status, 200);
  assert.equal((await get('/api/code/file', { root: ws, path: 'credentials/key.env' })).status, 403);
  assert.equal((await get('/api/code/tree', { root: ws, dir: 'credentials' })).status, 403);
  assert.equal((await get('/api/code/file', { root: path.join(ws, 'credentials'), path: 'key.env' })).status, 403);
  assert.equal((await post('/api/code/create', { root: ws, path: 'credentials/new.env', kind: 'file' })).status, 403);
  assert.equal(fs.readFileSync(path.join(ws, 'credentials', 'key.env'), 'utf8'), 'KEY=fake-key-123\n');
});

test('the reach setting: the allowed folders by default, the whole disk on request, and back', async () => {
  assert.equal((await get('/api/code/file', { root: outside, path: 'notes.txt' })).status, 403, 'outside the allowed folders');
  assert.equal((await reach('anything')).status, 400);
  assert.equal((await reach('everything')).status, 200);
  const r = await get('/api/code/file', { root: outside, path: 'notes.txt' });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, 'outside\n');
  // Still locked with the whole disk in reach.
  assert.equal((await get('/api/code/file', { root: process.env.HOPRIG_STATE_DIR, path: 'x' })).status, 403);
  assert.equal((await get('/api/code/file', { root: ws, path: 'credentials/key.env' })).status, 403);
  if (process.platform === 'linux') {
    assert.equal((await get('/api/code/file', { root: '/proc/self', path: 'environ' })).status, 403);
    assert.equal((await get('/api/code/tree', { root: '/sys', dir: '' })).status, 403);
  }
  assert.equal((await reach('home')).status, 200);
  assert.equal((await get('/api/code/file', { root: outside, path: 'notes.txt' })).status, 403, 'back to the allowed folders');
});

test('reachRoots: the allowed folders, or the top of every disk', () => {
  assert.deepEqual(reachRoots({ roots: [projects] }), [projects]);
  assert.deepEqual(reachRoots({ roots: [projects], reach: 'everything' }, 'linux'), ['/']);
  assert.deepEqual(reachRoots({ roots: [projects], reach: 'bogus' }), [projects]);
});

test('locate: a full path as a root and a path inside it; what is not one is refused', () => {
  const roots = [projects, ws];
  assert.deepEqual(locate(path.join(projects, 'todo.md'), roots), { root: projects, abs: path.join(projects, 'todo.md'), rel: 'todo.md' });
  const st = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.status;
    }
    return 200;
  };
  assert.equal(st(() => locate('todo.md', roots)), 400, 'not a full path');
  assert.equal(st(() => locate(`${projects}/../elsewhere/notes.txt`, roots)), 400, 'goes up');
  assert.equal(st(() => locate(`${projects}/a\0b`, roots)), 400);
  assert.equal(st(() => locate(path.join(outside, 'notes.txt'), roots)), 403, 'outside the reach');
  assert.equal(st(() => locate(path.join(projects, 'no-ai', 'x.md'), roots, { mode: 'new' })), 403, 'a private folder');
  assert.equal(st(() => locate(path.join(projects, '.git', 'HEAD'), roots, { mode: 'new' })), 403, 'git\'s folder');
  assert.equal(st(() => locate(path.join(projects, 'nothing-here.md'), roots)), 404);
  assert.equal(st(() => locate(projects, roots, { mode: 'entry' })), 400, 'the top of the reach is never renamed or moved');
  assert.equal(st(() => locate('/', ['/'], { mode: 'new' })), 400, 'nor the top of a disk');
  assert.equal(st(() => locate(path.join(ws, 'credentials', 'key.env'), roots)), 403);
});
