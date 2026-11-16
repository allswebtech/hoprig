// Files, the desktop's file manager (src/desktop/files.mjs on the editor's file module), over real HTTP with a
// signed-in browser: browse, new, rename, copy, move, the trash with put back and empty, upload, download, pack and
// unpack, find; and every refusal: paths that go up or out, private folders, git's folder, sign-in files, the
// workspace's credentials, the dashboard's own folders, links that lead out, the system's views, archives that would
// write outside their folder, and Tia's token. Downloads are never shown as a page of the dashboard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('desk-files');
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { which } = await import('../../src/setup/system.mjs');

const home = fs.realpathSync(box.home);
const ws = fs.realpathSync(box.workspace);
const put = (rel, text = 'x\n', base = home) => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
put('notes/todo.txt', 'buy milk\n');
put('notes/.hidden.txt', 'secret-ish\n');
put('notes/no-ai/mine.txt', 'private\n');
put('notes/page.html', '<script>alert(1)</script>\n');
put('notes/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
fs.writeFileSync(path.join(home, 'notes', 'dot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
put('proj/.git/HEAD', 'ref: refs/heads/main\n');
put('proj/src/app.js', 'console.log(1)\n');
put('credentials/key.env', 'KEY=fake-key-123\n', ws);
fs.symlinkSync('/etc', path.join(home, 'notes', 'out-link'));
fs.symlinkSync(path.join(home, 'proj'), path.join(home, 'notes', 'in-link'));

saveConfig({ server: { passwordHash: await hashPassword('right-password'), roots: [home, ws], uploadMaxMB: 1 } });
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false });
const { port } = await app.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${port}`;
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
test.after(async () => {
  await app.close();
  box.cleanup();
});

/** A request as the signed-in page makes it: { status, json, text, headers }. */
async function call(p, { body, raw, method, headers = {} } = {}) {
  const r = await fetch(origin + p, {
    method: method || (body !== undefined || raw !== undefined ? 'POST' : 'GET'),
    headers: { Cookie: cookie, Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text, headers: r.headers };
}
const q = (o) => new URLSearchParams(o).toString();
const list = (p, extra = {}) => call(`/api/files/list?${q({ path: p, ...extra })}`);
const names = (r) => r.json.entries.map((e) => e.name);

test('a folder lists files and folders with sizes and dates; hidden files only on request; private, git and links out never', async () => {
  const r = await list(path.join(home, 'notes'));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(names(r), ['in-link', 'dot.png', 'logo.svg', 'page.html', 'todo.txt']);
  const todo = r.json.entries.find((e) => e.name === 'todo.txt');
  assert.equal(todo.kind, 'file');
  assert.equal(todo.size, 9);
  assert.ok(todo.mtime > 0);
  assert.equal(r.json.entries[0].link, true);
  assert.equal(r.json.parent, home);
  assert.deepEqual(r.json.reach, { kind: 'home', tops: [home, ws] });
  assert.ok(names(await list(path.join(home, 'notes'), { hidden: '1' })).includes('.hidden.txt'));
  const p = await list(path.join(home, 'proj'), { hidden: '1' });
  assert.deepEqual(names(p), ['src'], 'git\'s folder is never listed');
  assert.equal(p.json.project, path.join(home, 'proj'), 'the repository it is in, for the editor');
  const top = await call('/api/files/list');
  assert.equal(top.json.path, home, 'no path: the top of the reach');
  assert.equal(top.json.parent, null);
  assert.ok(!names(await list(ws, { hidden: '1' })).includes('credentials'), 'the workspace\'s credentials are never listed');
});

test('paths that go up, out, or into what is locked are refused', async () => {
  const cases = [
    ['/etc', 403], [path.join(home, 'notes', 'out-link'), 403], [`${home}/notes/../..`, 400], ['notes', 400], [`${home}/notes\0`, 400],
    [path.join(home, 'notes', 'no-ai'), 403], [path.join(home, 'proj', '.git'), 403], [path.join(ws, 'credentials'), 403],
    [box.state, 403], [box.config, 403], [path.join(home, 'nothing-here'), 404],
  ];
  for (const [p, status] of cases) assert.equal((await list(p)).status, status, p);
  assert.equal((await call(`/api/files/raw?${q({ path: path.join(ws, 'credentials', 'key.env'), download: '1' })}`)).status, 403);
  assert.equal((await call(`/api/files/raw?${q({ path: path.join(home, 'notes', 'no-ai', 'mine.txt') })}`)).status, 403);
  // Through a link that stays inside, a folder opens like any other.
  assert.deepEqual(names(await list(path.join(home, 'notes', 'in-link'))), ['src']);
  // Signed out: nothing.
  assert.equal((await fetch(`${origin}/api/files/list`)).status, 401);
  // Tia's token is not the owner's hand on the files.
  assert.ok([401, 403].includes((await call('/api/files/list', { headers: { Authorization: 'Bearer tia_abc' } })).status));
});

test('new folder and file, rename; nothing is made or renamed over what is there', async () => {
  const dir = path.join(home, 'work');
  fs.mkdirSync(dir);
  assert.equal((await call('/api/files/new', { body: { dir, name: 'a', kind: 'dir' } })).json.path, path.join(dir, 'a'));
  assert.equal((await call('/api/files/new', { body: { dir, name: 'b.txt', kind: 'file' } })).status, 200);
  assert.equal((await call('/api/files/new', { body: { dir, name: 'b.txt', kind: 'file' } })).status, 409);
  for (const name of ['../x', 'a/b', '', '.', '..', '-rf', 'no-ai']) {
    const r = await call('/api/files/new', { body: { dir, name, kind: 'dir' } });
    assert.ok([400, 403].includes(r.status), `${name}: ${r.status}`);
  }
  const r = await call('/api/files/rename', { body: { path: path.join(dir, 'b.txt'), name: 'c.txt' } });
  assert.equal(r.json.path, path.join(dir, 'c.txt'), r.text);
  assert.equal((await call('/api/files/rename', { body: { path: path.join(dir, 'c.txt'), name: 'a' } })).status, 409);
  assert.equal((await call('/api/files/rename', { body: { path: home, name: 'x' } })).status, 400, 'the top is never renamed');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a', 'c.txt']);
});

test('copy and move: a copy in its own folder gets a free name, nothing goes over a name or into itself', async () => {
  const dir = path.join(home, 'cm');
  put('cm/one.txt', '1\n');
  put('cm/box/inner.txt', 'in\n');
  fs.mkdirSync(path.join(dir, 'dest'));
  let r = await call('/api/files/copy', { body: { paths: [path.join(dir, 'one.txt')], to: dir } });
  assert.deepEqual(r.json.done.map((d) => path.basename(d.to)), ['one (2).txt'], r.text);
  r = await call('/api/files/copy', { body: { paths: [path.join(dir, 'box')], to: path.join(dir, 'dest') } });
  assert.equal(fs.readFileSync(path.join(dir, 'dest', 'box', 'inner.txt'), 'utf8'), 'in\n');
  r = await call('/api/files/move', { body: { paths: [path.join(dir, 'one.txt'), path.join(dir, 'box')], to: path.join(dir, 'dest') } });
  assert.deepEqual(r.json.done.map((d) => path.basename(d.to)), ['one.txt']);
  assert.equal(r.json.failed[0].code, 'exists', 'dest/box is there already');
  r = await call('/api/files/move', { body: { paths: [path.join(dir, 'box')], to: path.join(dir, 'box') } });
  assert.match(r.json.failed[0].error, /into itself/);
  r = await call('/api/files/move', { body: { paths: [path.join(home, 'notes')], to: dir } });
  assert.equal(r.json.failed[0].code, 'holds-protected', 'a folder holding a private one does not move');
  assert.equal((await call('/api/files/move', { body: { paths: [path.join(dir, 'one (2).txt')], to: '/etc' } })).status, 403);
  assert.equal((await call('/api/files/copy', { body: { paths: [], to: dir } })).status, 400);
  assert.equal((await call('/api/files/copy', { body: { paths: [path.join(ws, 'credentials')], to: dir } })).json.failed.length, 1);
});

test('the trash: deleted things go to Hoprig\'s own trash, come back where they were, and Empty removes them', async () => {
  const a = put('tr/keep.txt', 'k\n');
  const b = put('tr/sub/deep.txt', 'd\n');
  let r = await call('/api/files/trash', { body: { paths: [a, path.dirname(b)] } });
  assert.equal(r.json.done.length, 2, r.text);
  assert.ok(!fs.existsSync(a) && !fs.existsSync(path.dirname(b)));
  const t = await call('/api/files/trash');
  assert.deepEqual(t.json.items.map((i) => [i.name, i.from, i.kind]).sort(), [['keep.txt', a, 'file'], ['sub', path.dirname(b), 'dir']]);
  // Its name was taken meanwhile: it comes back under a free one.
  fs.writeFileSync(a, 'new\n');
  const keep = t.json.items.find((i) => i.name === 'keep.txt');
  r = await call('/api/files/trash/restore', { body: { id: keep.id } });
  assert.equal(r.json.path, path.join(home, 'tr', 'keep (2).txt'), r.text);
  assert.equal(fs.readFileSync(r.json.path, 'utf8'), 'k\n');
  assert.equal((await call('/api/files/trash/restore', { body: { id: '../x' } })).status, 400);
  assert.equal((await call('/api/files/trash/restore', { body: { id: keep.id } })).status, 404);
  assert.equal((await call('/api/files/trash/empty', { body: {} })).status, 400, 'asked to confirm');
  assert.equal((await call('/api/files/trash/empty', { body: { confirm: true } })).json.removed, 1);
  assert.deepEqual((await call('/api/files/trash')).json.items, []);
  assert.equal((await call('/api/files/trash', { body: { paths: [home] } })).json.failed.length, 1, 'the top is never deleted');
  assert.equal((await list(box.state)).status, 403, 'the trash itself is not browsed');
});

test('upload: raw bytes into a folder, never over a file unless asked, within the size limit; download is always a download', async () => {
  const dir = path.join(home, 'up');
  fs.mkdirSync(dir);
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
  const up = (name, extra = {}, raw = bytes) => call(`/api/files/upload?${q({ dir, name, ...extra })}`, { raw, headers: { 'Content-Type': 'application/octet-stream' } });
  let r = await up('data.bin');
  assert.deepEqual(r.json, { path: path.join(dir, 'data.bin'), name: 'data.bin', size: 6 }, r.text);
  assert.equal((await up('data.bin')).status, 409);
  assert.equal((await up('data.bin', { replace: '1' }, Buffer.from('two'))).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'data.bin'), 'utf8'), 'two');
  assert.equal((await up('../evil.bin')).status, 400);
  assert.equal((await up('x.bin', { dir: path.join(ws, 'credentials') })).status, 403);
  assert.equal((await up('big.bin', {}, Buffer.alloc(1024 * 1024 + 1))).status, 413);
  assert.deepEqual(fs.readdirSync(dir), ['data.bin'], 'nothing half-written is left');
  r = await call(`/api/files/upload?${q({ dir, name: 'nope.txt' })}`, { raw: 'x', headers: { 'Content-Type': 'text/plain', Origin: 'http://evil.example' } });
  assert.equal(r.status, 403, 'another site cannot upload');

  const dl = async (file, extra = {}) => {
    const res = await fetch(`${origin}/api/files/raw?${q({ path: file, ...extra })}`, { headers: { Cookie: cookie } });
    return { res, body: Buffer.from(await res.arrayBuffer()) };
  };
  for (const name of ['page.html', 'logo.svg', 'todo.txt']) {
    const { res } = await dl(path.join(home, 'notes', name));
    assert.equal(res.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(res.headers.get('content-disposition'), new RegExp(`^attachment; filename="${name.replace('.', '\\.')}"`), name);
    assert.match(res.headers.get('content-security-policy'), /^sandbox; default-src 'none'$/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  const pic = await dl(path.join(home, 'notes', 'dot.png'));
  assert.equal(pic.res.headers.get('content-type'), 'image/png', 'a picture is shown');
  assert.match(pic.res.headers.get('content-disposition'), /^inline/);
  assert.match((await dl(path.join(home, 'notes', 'dot.png'), { download: '1' })).res.headers.get('content-disposition'), /^attachment/);
  const back = await dl(path.join(dir, 'data.bin'), { download: '1' });
  assert.equal(back.body.toString(), 'two');
  assert.equal((await dl(dir)).res.status, 400, 'a folder is not a file');
  const odd = put('up/naïve "q".txt', 'u\n');
  assert.match((await dl(odd)).res.headers.get('content-disposition'), /filename="na_ve _q_\.txt"; filename\*=UTF-8''na%C3%AFve%20%22q%22\.txt/);
});

test('pack a selection into a .tar.gz next to it and unpack it into a new folder; archives that write outside or hold links are refused', { skip: !which('tar') && 'no tar here' }, async () => {
  put('pk/a.txt', 'A\n');
  put('pk/d/b.txt', 'B\n');
  put('pk/d/.git/HEAD', 'ref\n');
  const dir = path.join(home, 'pk');
  let r = await call('/api/files/pack', { body: { paths: [path.join(dir, 'a.txt'), path.join(dir, 'd')], name: 'both' } });
  assert.equal(r.json.path, path.join(dir, 'both.tar.gz'), r.text);
  const inside = execFileSync('tar', ['-tzf', r.json.path]).toString();
  assert.match(inside, /a\.txt/);
  assert.doesNotMatch(inside, /\.git/, 'git\'s folder stays out');
  assert.equal((await call('/api/files/pack', { body: { paths: [path.join(dir, 'a.txt'), path.join(home, 'notes', 'todo.txt')] } })).status, 400, 'one folder at a time');
  r = await call('/api/files/unpack', { body: { path: path.join(dir, 'both.tar.gz') } });
  assert.equal(r.json.path, path.join(dir, 'both'), r.text);
  assert.equal(fs.readFileSync(path.join(dir, 'both', 'd', 'b.txt'), 'utf8'), 'B\n');
  r = await call('/api/files/unpack', { body: { path: path.join(dir, 'both.tar.gz') } });
  assert.equal(r.json.path, path.join(dir, 'both (2)'), 'never into a folder that is there');

  // An archive with "../": refused before anything is written.
  const evil = path.join(box.root, 'evil');
  fs.mkdirSync(path.join(evil, 'x'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'out.txt'), 'escaped\n');
  // -P keeps the "../" (tar takes it away by default when it packs).
  execFileSync('tar', ['-cPf', path.join(dir, 'up.tar'), '-C', path.join(evil, 'x'), '../out.txt']);
  r = await call('/api/files/unpack', { body: { path: path.join(dir, 'up.tar') } });
  assert.equal(r.status, 409, r.text);
  assert.match(r.json.error, /outside the folder/);
  // An archive with a link (written first, then written through): refused.
  fs.symlinkSync('/tmp', path.join(evil, 'x', 'lnk'));
  execFileSync('tar', ['-cf', path.join(dir, 'ln.tar'), '-C', path.join(evil, 'x'), 'lnk']);
  r = await call('/api/files/unpack', { body: { path: path.join(dir, 'ln.tar') } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /links/);
  assert.ok(!fs.existsSync(path.join(dir, 'up')) && !fs.existsSync(path.join(dir, 'ln')), 'no folder is left behind');
  assert.equal((await call('/api/files/unpack', { body: { path: path.join(dir, 'a.txt') } })).status, 400);
});

test('find by name inside a folder: case does not matter; private, git and hidden folders are not looked into', async () => {
  put('fd/Report-2026.md', 'r\n');
  put('fd/deep/er/report.txt', 'r\n');
  put('fd/no-ai/report.txt', 'p\n');
  put('fd/.cache/report.txt', 'h\n');
  const r = await call(`/api/files/find?${q({ path: path.join(home, 'fd'), q: 'REPORT' })}`);
  assert.deepEqual(r.json.matches.map((m) => path.relative(home, m.path)).sort(), ['fd/Report-2026.md', 'fd/deep/er/report.txt']);
  assert.equal((await call(`/api/files/find?${q({ path: path.join(home, 'fd'), q: '' })}`)).status, 400);
});

test('how far Files reaches is one setting: the allowed folders, or the whole disk with the system\'s views and Hoprig\'s own still locked', async () => {
  assert.equal((await call('/api/settings', { body: { server: { reach: 'all' } } })).status, 400);
  assert.equal((await call('/api/settings', { body: { server: { reach: 'everything' } } })).status, 200);
  assert.equal(loadConfig().server.reach, 'everything');
  const s = await call('/api/settings');
  assert.equal(s.json.server.reach, 'everything');
  assert.deepEqual(s.json.server.roots, [home, ws], 'the allowed folders stay as they were set');
  const top = await list('/');
  assert.equal(top.status, 200, top.text);
  assert.deepEqual(top.json.reach.tops, ['/']);
  if (process.platform === 'linux') {
    assert.ok(!names(top).includes('proc'), 'the system\'s views are not listed');
    assert.equal((await call(`/api/files/raw?${q({ path: '/proc/self/environ', download: '1' })}`)).status, 403);
  }
  assert.equal((await list(box.state)).status, 403, 'Hoprig\'s own folders stay locked');
  assert.equal((await list(path.join(ws, 'credentials'))).status, 403);
  // The folder picker of a new session follows the same reach.
  assert.equal((await call('/api/settings', { body: { server: { reach: 'home' } } })).status, 200);
  assert.equal((await list('/etc')).status, 403);
});

test('Tia\'s token reaches no route of Files, even one the server let through', async () => {
  const { filesRoutes } = await import('../../src/desktop/files.mjs');
  const routes = filesRoutes({ config: () => ({ server: { roots: [home] } }), readJson: async () => ({}) });
  for (const [, re, fn] of routes) {
    const p = re.source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/');
    await assert.rejects(fn({ headers: { authorization: 'Bearer tia_abc' }, body: {} }, re.exec(p), new URLSearchParams(), null), (e) => e.status === 403, p);
  }
});
