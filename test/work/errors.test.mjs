// What an error of the Work routes tells the browser: a plain sentence and a short code. Never a full path (a
// temporary file's, the server's address), never git's own words (they go to the server's log), never a piece of
// the file's content (a broken file is named by line and column).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-errors');
test.after(() => t.cleanup());
// tempWork() gave this server a workspace of its own (never the real one, which a dashboard maps when it starts).
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const SECRET = 'PRIVATE CONTENT OF THE OWNER';
const bare = t.repo(t.brain, { 'README.md': '# brain\n', 'work/tasks.json': '{\n  "items": []\n}\n' });
const dir = path.join(t.brain, 'work');
const file = path.join(dir, 'tasks.json');

test('no full path, no git output and no file content in any error answer; the log keeps git\'s words', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (method, p, body) => {
      const r = await fetch(origin + p, { method, headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json(), text: '' };
    };
    const clean = (r, what) => {
      const text = JSON.stringify(r.body);
      for (const bad of [t.root, t.home, process.env.HOME, 'fatal:', 'error:', SECRET, '.tmp']) assert.ok(!text.includes(bad), `${what}: "${bad}" in ${text}`);
    };

    let r;
    // POSIX modes: on Windows chmod sets only a read-only flag, which keeps no one out of a folder or a file's reading,
    // so a folder that cannot be written and a file that cannot be read are played only elsewhere.
    if (process.platform !== 'win32') {
      // A folder the dashboard may not write: the temporary file's path stays in the log.
      fs.chmodSync(dir, 0o555);
      r = await call('POST', '/api/work/items', { title: 'Cannot be written' });
      fs.chmodSync(dir, 0o755);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'unwritable');
      assert.match(r.body.error, /^the Work file could not be written \(no permission\)$/);
      clean(r, 'unwritable');
      assert.ok(logged.some((l) => l.includes('.tmp')), 'the system\'s words are in the log');

      // An unreadable file.
      fs.chmodSync(file, 0o000);
      r = await call('GET', '/api/work');
      fs.chmodSync(file, 0o644);
      assert.match(r.body.problem, /tasks\.json cannot be read \(no permission\)/);
      clean(r, 'unreadable');
    }

    // A broken file: line and column, no content.
    fs.writeFileSync(file, `{\n  "items": [\n    { "id": "a", "title": "${SECRET}" },\n  ]\n}\n`);
    r = await call('GET', '/api/work');
    assert.match(r.body.problem, /^tasks\.json is not valid JSON at line 4, column 3: fix it by hand/);
    clean(r, 'broken GET');
    r = await call('POST', '/api/work/items', { title: 'Into a broken file' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'broken');
    clean(r, 'broken POST');
    fs.writeFileSync(file, '{\n  "items": []\n}\n');

    // A server that refuses the send: git's words (with its path) only in the log.
    fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "refused by the server" >&2\nexit 1\n', { mode: 0o755 });
    await call('POST', '/api/work/items', { title: 'Refused by the server' });
    r = await call('POST', '/api/work/save', {});
    assert.equal(r.body.saved, false, 'the commit is taken back');
    assert.equal(r.body.sent, false);
    assert.equal(r.body.code, 'not-sent');
    assert.equal(r.body.message, 'Not saved to git: the server refused it. Your changes are kept in the file; Save again.');
    assert.equal(r.body.detail, undefined);
    clean(r, 'push refused');
    assert.ok(logged.some((l) => l.includes(bare) || l.includes('failed to push')), 'git\'s last line is in the log');
    fs.rmSync(path.join(bare, 'hooks', 'pre-receive'));

    // A server that does not answer: no address in the answer.
    t.git(t.brain, 'remote', 'set-url', 'origin', 'https://127.0.0.1:9/private/brain.git');
    await call('POST', '/api/work/items', { title: 'Server away' });
    for (const p of ['/api/work/save?fetch=1']) {
      r = await call('GET', p);
      assert.match(r.body.problem, /did not answer/);
      assert.ok(!JSON.stringify(r.body).includes('127.0.0.1:9'), p);
      clean(r, p);
    }
    r = await call('POST', '/api/work/save', {});
    assert.equal(r.body.code, 'offline');
    assert.ok(!JSON.stringify(r.body).includes('127.0.0.1:9'));
    clean(r, 'fetch failed');
    t.git(t.brain, 'remote', 'set-url', 'origin', bare);

    // Every refusal has a short code.
    for (const [m, p, b] of [['POST', '/api/work/items', { nope: 1 }], ['POST', '/api/work/items/a/status', { at: 0, status: 'done' }], ['POST', '/api/work/items/UPPER', { at: 0 }]]) {
      r = await call(m, p, b);
      assert.ok(r.status >= 400 && typeof r.body.code === 'string' && r.body.code, `${p}: ${JSON.stringify(r.body)}`);
      clean(r, p);
    }
  } finally {
    console.error = realError;
    fs.chmodSync(dir, 0o755);
    await app.close();
  }
});
