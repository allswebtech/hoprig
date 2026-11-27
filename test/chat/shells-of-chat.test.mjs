// A shell the terminal pane makes is made FOR its chat (POST /api/shells with the chat's id). Archiving that chat
// through the close route ends those shells on the server, whoever pressed it and whatever the open page knew; a shell
// made without a chat (the editor's terminal) and a shell of another chat stay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');

test('archiving a chat ends the shells made for it, and only those', { timeout: 90_000, skip: process.platform === 'win32' && 'POSIX shells' }, async (t) => {
  const box = sandbox('chatshells');
  const proj = path.join(box.root, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [path.join(box.root, 'work')], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'manual' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const made = [];
  t.after(async () => {
    for (const n of made) await owner('POST', `/api/sessions/${n}/kill`, {}).catch(() => {});
    await app.close();
    box.cleanup();
  });
  const shell = async (extra = {}) => {
    const r = await owner('POST', '/api/shells', { dir: proj, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    made.push(r.json.name);
    return r.json.name;
  };
  const alive = async (n) => (await owner('GET', `/api/sessions/${n}`)).status === 200;

  const a = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  const b = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  const a1 = await shell({ chat: a });
  const a2 = await shell({ chat: a });
  const b1 = await shell({ chat: b });
  const loose = await shell();
  assert.equal((await owner('POST', '/api/shells', { dir: proj, chat: 5 })).status, 400, 'a chat id is a string');

  assert.equal((await owner('POST', `/api/chats/${a}/close`, {})).status, 200);
  const gone = async (n) => { const end = Date.now() + 10_000; while (Date.now() < end) { if (!(await alive(n))) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
  assert.ok(await gone(a1), 'the first shell of the archived chat is ended');
  assert.ok(await gone(a2), 'and the second');
  assert.ok(await alive(b1), 'the shell of another chat stays');
  assert.ok(await alive(loose), 'a shell made without a chat stays');
});
