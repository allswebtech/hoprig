// The editor's routes over real HTTP against a sandboxed dashboard (its own settings and state folders, a port the
// system picks, no terminals): the login and the Origin check, another computer's token accepted and Tia's refused,
// and the file and git routes with the cases that matter: a path outside the roots, a symlink that leaves them, a
// binary file, a file over the size limit, a save over a newer version, a folder that is not a repository, and a name
// with spaces and non-Latin letters.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');

const projects = path.join(box.root, 'projects');
const proj = path.join(projects, 'app');
const plain = path.join(projects, 'notes'); // not a git repository
const outside = path.join(box.root, 'elsewhere');
for (const d of [proj, plain, outside]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
fs.writeFileSync(path.join(plain, 'todo.md'), '# todo\nbuy milk\n');
const g = (...a) => execFileSync('git', a, { cwd: proj, stdio: 'pipe' }).toString();
g('init', '-q');
fs.writeFileSync(path.join(proj, 'README.md'), 'hello\n');
g('add', '.');
g('commit', '-qm', 'first');

saveConfig({ server: { passwordHash: await hashPassword('right-password'), port: 1, roots: [projects] } });
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
const get = (p, o, h = {}) => call('GET', `${p}?${q(o)}`, null, { Cookie: cookie, ...h });
const post = (p, body, h = {}) => call('POST', p, body, { Cookie: cookie, ...h });

test('read and save a file: the version guards against a change made meanwhile', async () => {
  let r = await get('/api/code/file', { root: proj, path: 'README.md' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.text, r.json.size, r.json.eol], ['hello\n', 6, '\n']);
  assert.match(r.json.version, /^[0-9a-f]{16}$/);
  const v1 = r.json.version;
  r = await post('/api/code/file', { root: proj, path: 'README.md', text: 'hello, world\n', version: v1 });
  assert.equal(r.status, 200);
  assert.notEqual(r.json.version, v1);
  assert.equal(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), 'hello, world\n');
  // A second writer still holding the first version: refused, told the version on disk, and nothing is lost.
  r = await post('/api/code/file', { root: proj, path: 'README.md', text: 'stale\n', version: v1 });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'changed');
  assert.match(r.json.error, /changed on disk/);
  assert.equal(r.json.version, (await get('/api/code/file', { root: proj, path: 'README.md' })).json.version);
  assert.equal(fs.readFileSync(path.join(proj, 'README.md'), 'utf8'), 'hello, world\n');
  assert.equal((await post('/api/code/file', { root: proj, path: 'README.md', text: 'x' })).status, 400, 'no version: refused');
});

test('a save keeps the file mode and leaves no temporary file; version null makes a new file only', async () => {
  const f = path.join(proj, 'run.sh');
  fs.writeFileSync(f, '#!/bin/sh\n');
  fs.chmodSync(f, 0o751);
  const v = (await get('/api/code/file', { root: proj, path: 'run.sh' })).json.version;
  assert.equal((await post('/api/code/file', { root: proj, path: 'run.sh', text: '#!/bin/sh\necho hi\n', version: v })).status, 200);
  assert.equal(fs.statSync(f).mode & 0o777, 0o751);
  assert.deepEqual(fs.readdirSync(proj).filter((n) => n.endsWith('.tmp')), []);
  let r = await post('/api/code/file', { root: proj, path: 'new.txt', text: 'new\n', version: null });
  assert.equal(r.status, 200);
  r = await post('/api/code/file', { root: proj, path: 'new.txt', text: 'again\n', version: null });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'exists');
  assert.equal(fs.readFileSync(path.join(proj, 'new.txt'), 'utf8'), 'new\n');
});

test('a name with spaces and non-Latin letters: create, read, save, rename, list, delete', async () => {
  const name = 'docs/नई फ़ाइल – ü 文件.md';
  assert.equal((await post('/api/code/create', { root: proj, path: 'docs', kind: 'dir' })).status, 200);
  let r = await post('/api/code/create', { root: proj, path: name, kind: 'file' });
  assert.equal(r.status, 200);
  r = await get('/api/code/file', { root: proj, path: name });
  assert.deepEqual([r.status, r.json.text], [200, '']);
  r = await post('/api/code/file', { root: proj, path: name, text: 'नमस्ते\n', version: r.json.version });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(proj, name), 'utf8'), 'नमस्ते\n');
  r = await get('/api/code/tree', { root: proj, dir: 'docs' });
  assert.deepEqual(r.json.entries.map((e) => [e.name, e.kind]), [['नई फ़ाइल – ü 文件.md', 'file']]);
  r = await post('/api/code/rename', { root: proj, from: name, to: 'docs/renamed é.md' });
  assert.deepEqual([r.status, r.json.to], [200, 'docs/renamed é.md']);
  assert.equal((await post('/api/code/create', { root: proj, path: 'docs/renamed é.md', kind: 'file' })).status, 409, 'create never overwrites');
  fs.writeFileSync(path.join(proj, 'docs', 'other.md'), 'x');
  assert.equal((await post('/api/code/rename', { root: proj, from: 'docs/other.md', to: 'docs/renamed é.md' })).status, 409, 'rename never overwrites');
  assert.equal((await post('/api/code/delete', { root: proj, path: 'docs' })).status, 400, 'a delete needs confirm');
  assert.equal((await post('/api/code/delete', { root: proj, path: 'docs', confirm: true })).status, 200);
  assert.equal(fs.existsSync(path.join(proj, 'docs')), false);
});

test('the tree: folders first, git\'s folder, packages and private folders hidden, a link out of the root not shown', async () => {
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'no-ai'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'no-ai', 'mine.md'), 'private');
  fs.symlinkSync(outside, path.join(proj, 'out-link'));
  fs.symlinkSync(path.join(proj, 'src'), path.join(proj, 'src-link'));
  const r = await get('/api/code/tree', { root: proj });
  assert.equal(r.status, 200);
  const names = r.json.entries.map((e) => e.name);
  assert.equal(r.json.entries[0].kind, 'dir');
  for (const hidden of ['.git', 'node_modules', 'no-ai', 'out-link']) assert.ok(!names.includes(hidden), hidden);
  assert.deepEqual(r.json.entries.find((e) => e.name === 'src-link'), { name: 'src-link', kind: 'dir', link: true });
  assert.ok(names.includes('README.md') && names.includes('.git') === false);
  assert.equal((await get('/api/code/tree', { root: proj, dir: 'README.md' })).status, 400, 'not a folder');
});

test('paths that leave the roots or reach private places are refused', async () => {
  const refused = async (p, o, want) => assert.equal((await get(p, o)).status, want, JSON.stringify(o));
  await refused('/api/code/file', { root: outside, path: 'secret.txt' }, 403); // a root outside server.roots
  await refused('/api/code/file', { root: proj, path: '../../elsewhere/secret.txt' }, 400);
  await refused('/api/code/file', { root: proj, path: '/etc/passwd' }, 400);
  await refused('/api/code/file', { root: proj, path: 'out-link/secret.txt' }, 403); // a symlink out of the root
  await refused('/api/code/tree', { root: proj, dir: 'out-link' }, 403);
  await refused('/api/code/file', { root: proj, path: 'no-ai/mine.md' }, 403);
  await refused('/api/code/file', { root: path.join(proj, 'no-ai') }, 403);
  await refused('/api/code/file', { root: proj, path: 'a\\..\\b' }, 400);
  await refused('/api/code/file', { root: proj, path: '-rf' }, 400);
  await refused('/api/code/file', { root: proj, path: 'x\0y' }, 400);
  await refused('/api/code/file', { root: 'relative/dir', path: 'x' }, 403);
  await refused('/api/code/file', { root: process.env.HOPRIG_STATE_DIR, path: 'x' }, 403);
  let r = await post('/api/code/file', { root: proj, path: 'out-link/secret.txt', text: 'pwned', version: null });
  assert.equal(r.status, 403, 'a new file through a link out of the root');
  r = await post('/api/code/create', { root: proj, path: '.git/hooks/pre-commit', kind: 'file' });
  assert.equal(r.status, 403, '.git is never written');
  r = await post('/api/code/delete', { root: proj, path: 'out-link', confirm: true });
  assert.equal(r.status, 200, 'deleting a link removes the link, not what it points to');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside\n');
});

test('a binary file and a file over the size limit are not opened as text', async () => {
  fs.writeFileSync(path.join(proj, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  fs.writeFileSync(path.join(proj, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1: not UTF-8
  let r = await get('/api/code/file', { root: proj, path: 'logo.bin' });
  assert.deepEqual([r.status, r.json.binary, r.json.size, r.json.text], [200, true, 8, undefined]);
  r = await get('/api/code/file', { root: proj, path: 'latin1.txt' });
  assert.equal(r.json.binary, true);
  fs.writeFileSync(path.join(proj, 'big.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
  r = await get('/api/code/file', { root: proj, path: 'big.log' });
  assert.deepEqual([r.status, r.json.code, r.json.size], [413, 'too-large', 5 * 1024 * 1024 + 1]);
  r = await post('/api/code/file', { root: proj, path: 'big2.log', text: 'a'.repeat(5 * 1024 * 1024 + 1), version: null });
  assert.equal(r.status, 413);
  r = await post('/api/code/file', { root: proj, path: 'ok.log', text: 'a'.repeat(5 * 1024 * 1024), version: null });
  assert.equal(r.status, 200, 'exactly the limit is saved (a body larger than the server\'s usual 64 KB)');
  for (const f of ['big.log', 'ok.log']) fs.rmSync(path.join(proj, f));
});

test('who may: the login and this site; another computer\'s token yes; Tia\'s token no', async () => {
  assert.equal((await call('GET', `/api/code/tree?${q({ root: proj })}`)).status, 401);
  assert.equal((await call('POST', '/api/code/create', { root: proj, path: 'x.txt', kind: 'file' }, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
  assert.equal(fs.existsSync(path.join(proj, 'x.txt')), false);
  const { token } = createToken('hub');
  const viaToken = { Authorization: `Bearer ${token}`, Origin: '' };
  let r = await call('GET', `/api/code/file?${q({ root: proj, path: 'README.md' })}`, null, viaToken);
  assert.deepEqual([r.status, r.json.text], [200, 'hello, world\n']);
  r = await call('POST', '/api/code/create', { root: proj, path: 'from-hub.txt', kind: 'file' }, viaToken);
  assert.equal(r.status, 200);
  r = await call('GET', `/api/code/file?${q({ root: proj, path: 'README.md' })}`, null, { Authorization: `Bearer tia_${'A'.repeat(43)}` });
  assert.ok([401, 403].includes(r.status), `Tia's token: ${r.status}`);
  fs.rmSync(path.join(proj, 'from-hub.txt'));
});

test('git\'s folder as the opened folder: its config and hooks are never written, so git never runs what they say', async () => {
  const marker = path.join(box.root, 'ran-by-git');
  for (const [root, p] of [[path.join(proj, '.git'), 'config'], [path.join(proj, '.git', 'hooks'), 'pre-commit']]) {
    assert.equal((await get('/api/code/file', { root, path: p })).status, 403, `${root} read`);
    const r = await post('/api/code/file', { root, path: p, text: `[core]\n\tfsmonitor = "touch ${marker}"\n`, version: null });
    assert.equal(r.status, 403, `${root} write`);
  }
  assert.equal((await get('/api/code/git/status', { root: proj })).status, 200);
  assert.equal(fs.existsSync(marker), false);
});

test('the versions of open files: which changed on disk, which are gone', async () => {
  fs.writeFileSync(path.join(proj, 'v.txt'), 'one\n');
  const v1 = (await get('/api/code/file', { root: proj, path: 'v.txt' })).json.version;
  let r = await get('/api/code/versions', { root: proj, paths: 'v.txt\ngone.txt\nno-ai/mine.md' });
  assert.deepEqual(r.json.versions, { 'v.txt': v1, 'gone.txt': null }, 'a private path is left out');
  fs.writeFileSync(path.join(proj, 'v.txt'), 'two\n');
  r = await get('/api/code/versions', { root: proj, paths: 'v.txt' });
  assert.notEqual(r.json.versions['v.txt'], v1);
  fs.rmSync(path.join(proj, 'v.txt'));
});

test('only a save takes a large body; the editor\'s files are cached privately (they need the login)', async () => {
  const r = await post('/api/code/create', { root: proj, path: 'x'.repeat(70 * 1024), kind: 'file' });
  assert.equal(r.status, 413);
  const m = (await get('/vendor/monaco.json', {})).json;
  const loader = await fetch(`${base}${m.base}loader.js`, { headers: { Cookie: cookie } });
  assert.equal(loader.status, 200);
  assert.equal(loader.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  await loader.arrayBuffer();
});

test('a folder that is gone says so; outside the roots nothing is told about the disk', async () => {
  assert.equal((await get('/api/code/tree', { root: path.join(proj, 'gone-folder') })).status, 404);
  assert.equal((await get('/api/code/tree', { root: path.join(outside, 'gone-folder') })).status, 403);
  assert.equal((await get('/api/code/tree', { root: outside })).status, 403);
});
