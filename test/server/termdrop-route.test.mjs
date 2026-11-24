// A file dropped or pasted on a session's terminal (web/session.js) goes up through POST /api/sessions/<name>/drop/upload:
// a real server on the built-in pty backend with a plain shell session. The rules are the attachment's (the same size
// limit, a clean name, never a path part from the client, a file of its own each time, the owner's cookie only), but
// the files are kept in Hoprig's state folder, not in the session's folder, and a week later a drop removes them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const posix = process.platform !== 'win32';

test('the drop route: sizes, names, two files of one name, no cookie, no such session, the folder and its cleaning', { timeout: 60_000, skip: !posix && 'a plain POSIX shell is the session here' }, async (t) => {
  const box = sandbox('drop');
  const work = path.join(box.root, 'work');
  fs.mkdirSync(work);
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ usage: false, server: { backend: 'pty', roots: [box.root], uploadMaxMB: 1, passwordHash: await hashPassword('test-password-1') } });
  const app = createServer({ watch: false, automation: { tick: false }, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close().catch(() => {});
    box.cleanup();
  });
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const made = await fetch(`${base}/api/shells`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: work }) });
  assert.equal(made.status, 200, await made.clone().text());
  const { name } = await made.json();
  t.after(() => fetch(`${base}/api/sessions/${name}/kill`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}));

  const up = async (bytes, fileName, { session = name, withCookie = true } = {}) => {
    const r = await fetch(`${base}/api/sessions/${encodeURIComponent(session)}/drop/upload`, {
      method: 'POST',
      headers: { Origin: base, ...(withCookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) },
      body: bytes,
    });
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  const folder = path.join(box.state, 'drops', name);

  // One byte: in the state folder under the session's name, readable by the owner only, not in the session's folder.
  const one = await up(Buffer.from([7]), 'one.bin');
  assert.equal(one.status, 200, one.text);
  assert.equal(path.dirname(one.json.path), folder);
  assert.ok(path.isAbsolute(one.json.path));
  assert.deepEqual([...fs.readFileSync(one.json.path)], [7]);
  assert.equal((fs.statSync(one.json.path).mode & 0o777).toString(8), '600');
  assert.equal((fs.statSync(path.join(box.state, 'drops')).mode & 0o777).toString(8), '700');
  assert.equal((fs.statSync(folder).mode & 0o777).toString(8), '700');
  assert.ok(!fs.existsSync(path.join(work, '.uploads')), 'nothing in the session\'s folder');
  assert.ok(!fs.existsSync(path.join(folder, '.gitignore')), 'no ignore file: the folder is not in a repository');

  // Exactly the limit is taken; one byte more is refused with the limit in the sentence, and nothing is left.
  const limit = 1024 * 1024;
  const full = Buffer.alloc(limit, 1);
  const atLimit = await up(full, 'full.bin');
  assert.equal(atLimit.status, 200, atLimit.text);
  assert.equal(fs.statSync(atLimit.json.path).size, limit);
  const before = fs.readdirSync(folder).sort();
  const over = await up(Buffer.alloc(limit + 1, 1), 'over.bin');
  assert.equal(over.status, 413);
  assert.match(over.json.error, /larger than 1 MB/);
  assert.deepEqual(fs.readdirSync(folder).sort(), before, 'the refused file is not kept');

  // Names: path parts never leave the folder; spaces and quotes are made safe; a Hindi name keeps its extension.
  const parts = await up(Buffer.from('a'), '../../../etc/passwd');
  assert.equal(parts.status, 200, parts.text);
  assert.equal(path.dirname(parts.json.path), folder);
  assert.match(path.basename(parts.json.path), /-passwd$/);
  const quoted = await up(Buffer.from('b'), `my "shot" it's 1.png`);
  assert.equal(quoted.status, 200, quoted.text);
  assert.match(path.basename(quoted.json.path), /^\d{8}-\d{6}-[0-9a-f]{4}-my_shot_it_s_1\.png$/);
  const hindi = await up(Buffer.from('c'), 'स्क्रीनशॉट.png');
  assert.equal(hindi.status, 200, hindi.text);
  assert.equal(path.dirname(hindi.json.path), folder);
  assert.match(path.basename(hindi.json.path), /^[A-Za-z0-9._-]+\.png$/);
  assert.equal(fs.readFileSync(hindi.json.path, 'utf8'), 'c');

  // Two files of one name: two files, each with its own bytes.
  const a = await up(Buffer.from('first'), 'same.txt');
  const b = await up(Buffer.from('second'), 'same.txt');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.json.path, b.json.path);
  assert.equal(fs.readFileSync(a.json.path, 'utf8'), 'first');
  assert.equal(fs.readFileSync(b.json.path, 'utf8'), 'second');

  // Without the owner's cookie: refused, nothing written. A session that does not exist: 404, no folder for it.
  const count = fs.readdirSync(folder).length;
  const anon = await up(Buffer.from('x'), 'anon.txt', { withCookie: false });
  assert.equal(anon.status, 401);
  assert.equal(fs.readdirSync(folder).length, count);
  const gone = await up(Buffer.from('x'), 'gone.txt', { session: 'nosuch' });
  assert.equal(gone.status, 404);
  assert.match(gone.json.error, /no such session/);
  assert.ok(!fs.existsSync(path.join(box.state, 'drops', 'nosuch')));
  const badName = await up(Buffer.from('x'), 'bad.txt', { session: '..' });
  assert.ok([400, 404].includes(badName.status), `${badName.status}`);

  // An empty file is refused as an attachment is.
  const empty = await up(Buffer.alloc(0), 'empty.txt');
  assert.equal(empty.status, 400);

  // Cleaning: a file older than a week (and a folder it leaves empty) goes with the next drop; newer ones stay.
  const old = path.join(box.state, 'drops', 'ended-session');
  fs.mkdirSync(old, { mode: 0o700 });
  fs.writeFileSync(path.join(old, 'old.png'), 'x');
  const weekAgo = new Date(Date.now() - 8 * 24 * 3600_000);
  fs.utimesSync(path.join(old, 'old.png'), weekAgo, weekAgo);
  fs.utimesSync(one.json.path, weekAgo, weekAgo);
  const next = await up(Buffer.from('n'), 'next.txt');
  assert.equal(next.status, 200);
  assert.ok(!fs.existsSync(old), 'the ended session\'s old folder is gone');
  assert.ok(!fs.existsSync(one.json.path), 'the week-old drop is gone');
  assert.ok(fs.existsSync(atLimit.json.path), 'a newer drop stays');
});
