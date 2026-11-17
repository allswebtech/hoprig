// Files, the desktop's file manager (src/desktop/files.mjs on the editor's file module), over real HTTP with a
// signed-in browser: browse, new, rename, copy, move, the trash with put back and empty, upload, download, pack and
// unpack, find; and every refusal: paths that go up or out, private folders, git's folder, sign-in files, the
// workspace's credentials, the dashboard's own folders, links that lead out, the system's views, archives that would
// write outside their folder, and Tia's token. Downloads are never shown as a page of the dashboard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
  // The setting is about files: new sessions and shells keep to the allowed folders (and with them Tia and
  // automations, which start their work through these routes or the same folders).
  assert.equal((await call(`/api/folders/browse?${q({ path: '/etc' })}`)).status, 404);
  assert.equal((await call('/api/shells', { body: { dir: '/etc' } })).status, 400);
  assert.equal((await call('/api/sessions', { body: { dir: '/etc', mode: 'new' } })).status, 400);
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

test('names that start with "-" open, rename, copy and go to the trash; only a typed new name may not start with one', async () => {
  put('-old/-dash.txt', 'dash\n');
  put('-old/inner/deep.txt', 'deep\n');
  const old = path.join(home, '-old');
  assert.ok(names(await list(home)).includes('-old'));
  const r = await list(old);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(names(r), ['inner', '-dash.txt']);
  assert.equal((await list(path.join(old, 'inner'))).status, 200, 'a folder under one opens too');
  assert.equal((await call(`/api/files/raw?${q({ path: path.join(old, '-dash.txt'), download: '1' })}`)).text, 'dash\n');
  assert.equal((await call('/api/files/new', { body: { dir: old, name: '-new.txt', kind: 'file' } })).status, 400, 'a typed name');
  assert.equal((await call('/api/files/rename', { body: { path: path.join(old, '-dash.txt'), name: '-other.txt' } })).status, 400);
  const ren = await call('/api/files/rename', { body: { path: path.join(old, '-dash.txt'), name: 'dash.txt' } });
  assert.equal(ren.status, 200, ren.text);
  fs.mkdirSync(path.join(home, 'dashes'));
  const cp = await call('/api/files/copy', { body: { paths: [old], to: path.join(home, 'dashes') } });
  assert.deepEqual(cp.json.failed, [], cp.text);
  assert.equal(fs.readFileSync(path.join(home, 'dashes', '-old', 'dash.txt'), 'utf8'), 'dash\n', 'a copy keeps the name it had');
  const tr = await call('/api/files/trash', { body: { paths: [old] } });
  assert.deepEqual(tr.json.failed, [], tr.text);
  const back = await call('/api/files/trash/restore', { body: { id: tr.json.done[0].id } });
  assert.equal(back.json.path, old, back.text);
});

test('upload: a file that appears while the bytes come in is never written over', async () => {
  const dir = path.join(home, 'race');
  fs.mkdirSync(dir);
  const target = path.join(dir, 'same.txt');
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/files/upload?${q({ dir, name: 'same.txt' })}`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write('mine, part one\n');
    // Someone else's file lands while the upload is still under way.
    setTimeout(() => {
      fs.writeFileSync(target, 'theirs\n');
      req.end('mine, part two\n');
    }, 150);
  });
  assert.equal(status, 409);
  assert.equal(fs.readFileSync(target, 'utf8'), 'theirs\n');
  assert.deepEqual(fs.readdirSync(dir), ['same.txt'], 'no temporary file is left');
});

test('upload past the limit with no declared length is answered 413, not a dropped connection', async () => {
  const dir = path.join(home, 'chunked');
  fs.mkdirSync(dir);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/files/upload?${q({ dir, name: 'big.bin' })}`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    // A connection cut before the answer came: what this test is about (the answer a moment after it still counts).
    req.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? setTimeout(() => resolve('dropped'), 500) : reject(e)));
    const piece = Buffer.alloc(64 * 1024, 7);
    let sent = 0;
    const more = () => {
      while (sent < 2 * 1024 * 1024) {
        sent += piece.length;
        if (!req.write(piece)) return req.once('drain', more);
      }
      req.end();
    };
    more();
  });
  assert.equal(status, 413);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing half-written is left');
});

test('an upload into a folder it may not write in is answered at once', { skip: (process.getuid && process.getuid() === 0) && 'root writes anywhere' }, async () => {
  const dir = path.join(home, 'locked-up');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o555);
  try {
    const r = await Promise.race([
      call(`/api/files/upload?${q({ dir, name: 'x.txt' })}`, { raw: 'x\n', headers: { 'Content-Type': 'application/octet-stream' } }),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'no answer' }), 5000)),
    ]);
    assert.ok(r.status >= 400 && r.status < 600, String(r.status));
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test('a long name in any script: the upload\'s temporary name and the archive\'s stay within the disk\'s 255 bytes', async () => {
  const dir = path.join(home, 'long');
  fs.mkdirSync(dir);
  const name = `${'क'.repeat(80)}.txt`; // 244 bytes
  const r = await call(`/api/files/upload?${q({ dir, name })}`, { raw: 'x\n', headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 200, r.text);
  if (which('tar')) {
    const pk = await call('/api/files/pack', { body: { paths: [path.join(dir, name)] } });
    assert.equal(pk.status, 200, pk.text);
    assert.ok(Buffer.byteLength(path.basename(pk.json.path)) <= 255);
  }
});

test('a disk without hard links (FAT, many network disks): upload and pack still place their file, never over another', async () => {
  const dir = path.join(home, 'nolinks');
  fs.mkdirSync(dir);
  const real = fs.linkSync;
  fs.linkSync = () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  try {
    const up = (name) => call(`/api/files/upload?${q({ dir, name })}`, { raw: 'new\n', headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal((await up('a.txt')).status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'new\n');
    const { placeNew } = await import('../../src/editor/manage.mjs');
    fs.writeFileSync(path.join(dir, 't.tmp'), 'tmp\n');
    assert.throws(() => placeNew(path.join(dir, 't.tmp'), path.join(dir, 'a.txt')), (e) => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'new\n', 'the copy never goes over a file');
    if (which('tar')) {
      const pk = await call('/api/files/pack', { body: { paths: [path.join(dir, 'a.txt')] } });
      assert.equal(pk.status, 200, pk.text);
    }
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.')), [], 'no temporary file is left');
  } finally {
    fs.linkSync = real;
  }
});

test('unpack never writes git\'s folder or a private one: such an archive could run a program when git looks at it', { skip: !which('tar') && 'no tar here' }, async () => {
  const src = path.join(box.root, 'crafted');
  put('.git/config', '[core]\n\tfsmonitor = "touch PWNED; false"\n', src);
  put('.git/HEAD', 'ref: refs/heads/main\n', src);
  put('no-ai/mine.txt', 'private\n', src);
  put('ok.txt', 'fine\n', src);
  const dir = path.join(home, 'unp');
  fs.mkdirSync(dir);
  execFileSync('tar', ['-cf', path.join(dir, 'git.tar'), '-C', src, '.git', 'ok.txt']);
  execFileSync('tar', ['-cf', path.join(dir, 'private.tar'), '-C', src, 'no-ai', 'ok.txt']);
  execFileSync('tar', ['-cf', path.join(dir, 'deep.tar'), '-C', box.root, 'crafted/.git/config']);
  for (const [file, why] of [['git.tar', /git's own folder/], ['private.tar', /private folder/], ['deep.tar', /git's own folder/]]) {
    const r = await call('/api/files/unpack', { body: { path: path.join(dir, file) } });
    assert.equal(r.status, 409, `${file}: ${r.text}`);
    assert.match(r.json.error, why);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['deep.tar', 'git.tar', 'private.tar'], 'nothing was unpacked');
});

test('the dashboard\'s git never runs a repository\'s fsmonitor command', { skip: !which('git') && 'no git here' }, async () => {
  const { gitRead } = await import('../../src/gitread.mjs');
  const repo = path.join(box.root, 'fsm');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const mark = path.join(box.root, 'fsm-ran');
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', `touch '${mark}'; false`]);
  assert.equal((await gitRead(repo, ['status', '--porcelain'])).ok, true);
  assert.ok(!fs.existsSync(mark), 'the command in the repository\'s settings did not run');
});

// A .zip as Info-ZIP writes it (stored, no compression), with a link when `link` is set and an entry marked as
// encrypted when `locked` is, and an unpacked size of `claim` in its listing when that is given: enough for unzip.
function zipOf(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data || '');
    const mode = e.link ? 0o120777 : e.name.endsWith('/') ? 0o040755 : 0o100644;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(10, 4); l.writeUInt16LE(e.locked ? 1 : 0, 6); l.writeUInt32LE(crc(data), 14);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 30, 4); c.writeUInt16LE(10, 6); c.writeUInt16LE(e.locked ? 1 : 0, 8); c.writeUInt32LE(crc(data), 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(e.claim ?? data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(l, name, data);
    centrals.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('a .zip unpacks with unzip, with the same refusals as a tar', { skip: !which('unzip') && 'no unzip here' }, async () => {
  const dir = path.join(home, 'zips');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'good.zip'), zipOf([{ name: 'docs/' }, { name: 'docs/read me.txt', data: 'hello\n' }, { name: 'top.txt', data: 'top\n' }]));
  let r = await call('/api/files/unpack', { body: { path: path.join(dir, 'good.zip') } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.path, path.join(dir, 'good'));
  assert.equal(fs.readFileSync(path.join(dir, 'good', 'docs', 'read me.txt'), 'utf8'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'up.zip'), zipOf([{ name: '../out.txt', data: 'escaped\n' }]));
  fs.writeFileSync(path.join(dir, 'git.zip'), zipOf([{ name: '.git/config', data: '[core]\n' }]));
  fs.writeFileSync(path.join(dir, 'link.zip'), zipOf([{ name: 'lnk', data: '/etc', link: true }]));
  for (const [file, why] of [['up.zip', /outside the folder/], ['git.zip', /git's own folder/], ['link.zip', /links/]]) {
    r = await call('/api/files/unpack', { body: { path: path.join(dir, file) } });
    assert.equal(r.status, 409, `${file}: ${r.text}`);
    assert.match(r.json.error, why, file);
  }
  assert.ok(!fs.existsSync(path.join(home, 'out.txt')) && !fs.existsSync(path.join(dir, 'up')) && !fs.existsSync(path.join(dir, 'git')) && !fs.existsSync(path.join(dir, 'link')));
});

test('a .zip with a password is refused in plain words at once; unpacking never asks for it on a terminal', { skip: !which('unzip') && 'no unzip here' }, async () => {
  const dir = path.join(home, 'locked-zips');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'mixed.zip'), zipOf([{ name: 'open.txt', data: 'open\n' }, { name: 'shut.txt', data: 'shut\n', locked: true }]));
  const t = Date.now();
  const r = await call('/api/files/unpack', { body: { path: path.join(dir, 'mixed.zip') } });
  assert.equal(r.status, 409, r.text);
  assert.match(r.json.error, /password/);
  assert.ok(Date.now() - t < 10_000, 'answered at once');
  assert.deepEqual(fs.readdirSync(dir), ['mixed.zip'], 'nothing was unpacked');
  // A real one, where the computer can make it.
  if (which('zip')) {
    put('locked-zips/a.txt', 'secret\n');
    execFileSync('zip', ['-q', '-P', 'pw', 'real.zip', 'a.txt'], { cwd: dir });
    const r2 = await call('/api/files/unpack', { body: { path: path.join(dir, 'real.zip') } });
    assert.equal(r2.status, 409, r2.text);
    assert.match(r2.json.error, /password/);
  }
});

test('tar and unzip run without the dashboard\'s terminal: in a session of their own', { skip: (process.platform === 'win32' || !which('ps')) && 'no sessions here' }, async () => {
  const { run } = await import('../../src/server/platform/common.mjs');
  // The shell's own process id, its process group and ps's state letters: "s" is the leader of a session (procps and
  // the BSD ps of macOS alike; a session's id has no keyword that both know: "sid" is procps's own).
  const ids = async (opts) => {
    const [pid, pgid, state = ''] = (await run('sh', ['-c', 'echo $$ $(ps -o pgid=,stat= -p $$)'], opts)).stdout.trim().split(/\s+/);
    return { pid: Number(pid), pgid: Number(pgid), leads: state.includes('s'), state };
  };
  const own = await ids({ noTerminal: true });
  assert.ok(own.pid > 0 && own.pgid === own.pid && own.leads, `its own session: ${JSON.stringify(own)}`);
  const plain = await ids({});
  assert.ok(plain.pid > 0 && plain.pgid !== plain.pid && !plain.leads, `a plain run stays in the dashboard's: ${JSON.stringify(plain)}`);
  const src = fs.readFileSync(new URL('../../src/editor/archive.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/noTerminal: true/g) || []).length, 2, 'tar and unzip both');
  assert.match(src, /'-P', ''/, 'unzip is given an empty password, so it never asks');
});

test('an archive that unpacks to more than the disk has free is refused before anything is written', { skip: !which('unzip') && 'no unzip here' }, async () => {
  const { listedBytes } = await import('../../src/editor/archive.mjs');
  assert.equal(listedBytes(['-rw-rw-r-- me/me         7 2026-11-16 17:58 a.txt', 'drwxr-xr-x me/me 0 2026-11-16 17:58 d/']), 7, 'GNU tar');
  assert.equal(listedBytes(['-rw-r--r--  0 me     staff       7 Nov 16 17:58 a.txt']), 7, 'bsdtar');
  assert.equal(listedBytes(['Archive:  x.zip', '-rw-rw-r--  3.0 unx        6 tx stor 26-Nov-16 17:58 b.txt', '-rw-rw-r--  3.0 unx        7 BX defN 26-Nov-16 17:58 a.txt', '2 files, 13 bytes uncompressed']), 13, 'zipinfo');
  assert.equal(listedBytes(['what is this']), null, 'no size it reads: no bound');
  const dir = path.join(home, 'bomb');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'big.zip'), zipOf([{ name: 'huge.bin', data: 'x', claim: 0xfffffff0 }, { name: 'huge2.bin', data: 'x', claim: 0xfffffff0 }]));
  const free = fs.statfsSync(dir);
  if (free.bavail * free.bsize > 2 * 0xfffffff0) return; // a disk with 8 GB free: this archive fits
  const r = await call('/api/files/unpack', { body: { path: path.join(dir, 'big.zip') } });
  assert.equal(r.status, 409, r.text);
  assert.match(r.json.error, /MB free/);
  assert.deepEqual(fs.readdirSync(dir), ['big.zip'], 'nothing was unpacked');
});

test('delete for good: asked for, with the same refusals as the trash; the trash refuses a big thing from another disk', async () => {
  put('gone/forever/a.txt', 'bye\n');
  put('keep/no-ai/mine.txt', 'private\n');
  assert.equal((await call('/api/files/delete', { body: { paths: [path.join(home, 'gone')] } })).status, 400, 'not without confirm');
  let r = await call('/api/files/delete', { body: { paths: [path.join(home, 'gone'), path.join(home, 'keep'), home], confirm: true } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.done.map((d) => d.path), [path.join(home, 'gone')]);
  assert.equal(r.json.failed.length, 2, 'a folder with a private one, and the top of the reach');
  assert.ok(!fs.existsSync(path.join(home, 'gone')) && fs.existsSync(path.join(home, 'keep', 'no-ai', 'mine.txt')) && fs.existsSync(home));
  // Another disk than the trash's: the trash moves for a moment to this checkout's disk, which is another one than the
  // temporary folder's where /tmp is kept in memory (elsewhere this part has nothing to compare and stops).
  const { toTrash, sizeUpTo } = await import('../../src/editor/trash.mjs');
  const f = put('sized/b.bin', 'x'.repeat(5000));
  assert.equal(await sizeUpTo(path.join(home, 'sized'), 1e6), 5000);
  assert.equal(await sizeUpTo(path.join(home, 'sized'), 100), Infinity);
  const state = process.env.HOPRIG_STATE_DIR;
  const disk = fs.mkdtempSync(path.join(path.dirname(new URL(import.meta.url).pathname), '.trash-'));
  try {
    if (fs.statSync(disk).dev === fs.statSync(f).dev) return;
    process.env.HOPRIG_STATE_DIR = disk;
    put('far/big.bin', 'x'.repeat(5000));
    put('far/small.bin', 'x');
    const t = await toTrash([path.join(home, 'far', 'big.bin'), path.join(home, 'far', 'small.bin')], [home], { copyMax: 1000 });
    assert.deepEqual(t.failed.map((x) => [path.basename(x.path), x.code]), [['big.bin', 'other-disk']]);
    assert.deepEqual(t.done.map((x) => path.basename(x.path)), ['small.bin'], 'a small one is still copied into the trash');
    assert.ok(fs.existsSync(path.join(home, 'far', 'big.bin')));
  } finally {
    process.env.HOPRIG_STATE_DIR = state;
    fs.rmSync(disk, { recursive: true, force: true });
  }
});
