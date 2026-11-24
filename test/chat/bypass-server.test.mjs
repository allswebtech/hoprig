// "Allow bypass permissions mode" in the real dashboard (createServer): off, no list offers Bypass permissions and
// every way to ask for it is refused (a new App session, its mode, a terminal session, New-session defaults); on, all
// of them offer it. The coding tool is the stand-in (fixtures/fake-claude.mjs).
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

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((res) => setTimeout(res, 50));
  }
};

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** A dashboard on the stand-ins, its switch turned off by the one-time step; → { owner(method, path, body), proj } */
async function dashboard(t, name) {
  const box = sandbox(name);
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'manual' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  return { base, cookie, proj, owner: (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } }) };
}

test('a session started before the switch was on shows Bypass permissions at once when chosen, and Shift+Tab goes on from it', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const { modeOf, nextMode } = await import('../../web/chat/words.js');
  const { owner, proj } = await dashboard(t, 'bypasslate');
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: 'auto' })).json.id;
  const A = `/api/chats/${id}`;
  await owner('POST', `${A}/send`, { text: 'hello' });
  await until('the first turn ends, its process running in auto', async () => {
    const v = (await owner('GET', A)).json;
    return v.status === 'waiting' && v.running && v.liveMode === 'auto' && v;
  });
  assert.equal((await owner('POST', '/api/settings/bypass', { allow: true, confirm: true })).json.allow, true);
  // Its process was started without --allow-dangerously-skip-permissions: it refuses the switch, starts again.
  const r = (await owner('POST', `${A}/mode`, { mode: 'bypassPermissions' })).json;
  assert.equal(r.restart, true, 'the page is told it takes effect at the next start');
  let v = (await owner('GET', A)).json;
  assert.equal(modeOf(v), 'bypassPermissions', 'the chip says what the next message runs in, not the ended process\'s Auto');
  assert.notEqual(nextMode(modeOf(v), v.choices.modes), 'bypassPermissions', 'Shift+Tab moves on from Bypass permissions (it got stuck on it)');
  await owner('POST', `${A}/mode`, { mode: 'manual' });
  v = (await owner('GET', A)).json;
  assert.equal(modeOf(v), 'manual', 'and the ring keeps moving');
  await owner('POST', `${A}/send`, { text: 'next message' });
  await until('the next turn ran in Manual', async () => {
    const x = (await owner('GET', A)).json;
    return x.status === 'waiting' && x.liveMode === 'default' && x;
  });
});

test('a mode the busy process cannot take shows at once, with the next start', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const { modeOf } = await import('../../web/chat/words.js');
  const { owner, proj } = await dashboard(t, 'bypassbusy');
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: 'auto' })).json.id;
  const A = `/api/chats/${id}`;
  await owner('POST', `${A}/send`, { text: 'sleep' });
  await until('the turn runs in auto', async () => {
    const v = (await owner('GET', A)).json;
    return v.turn && v.liveMode === 'auto' && v;
  });
  await owner('POST', '/api/settings/bypass', { allow: true, confirm: true });
  assert.equal((await owner('POST', `${A}/mode`, { mode: 'bypassPermissions' })).json.restart, true);
  const v = (await owner('GET', A)).json;
  assert.equal(v.modeLater, 'bypassPermissions');
  assert.equal(modeOf(v), 'bypassPermissions', 'the chip shows the mode chosen while the turn ends in the old one');
  await owner('POST', `${A}/stop`, {});
});

test('the switch gates every list and every request for Bypass permissions', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('bypasssrv');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  // As a home without bypass anywhere: the one-time step turns the switch off.
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'manual' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });

  assert.equal((await owner('GET', '/api/settings/bypass')).json.allow, false, 'the one-time step: off');
  assert.ok(!(await owner('GET', '/api/settings')).json.sessionChoices.permissionModes.includes('bypassPermissions'), 'New-session defaults and the new-session options do not offer it');
  const oc = (await owner('GET', '/api/chats/tools')).json.tools.filter((x) => x.modes);
  assert.ok(oc.every((x) => !x.modes.includes('bypassPermissions')), 'nor another coding tool\'s App session');
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'sub', permissionMode: 'bypassPermissions' })).status, 400, 'a new App session in bypass is refused');
  const chat = await owner('POST', '/api/chats', { dir: proj, profile: 'sub' });
  const id = chat.json.id;
  const look = await owner('GET', `/api/chats/${id}`);
  assert.ok(!look.json.choices.modes.includes('bypassPermissions'), 'the App\'s mode menu and Shift+Tab do not have it');
  assert.equal((await owner('POST', `/api/chats/${id}/mode`, { mode: 'bypassPermissions' })).status, 400, 'its mode cannot be set to it');
  assert.equal((await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', permissionMode: 'bypassPermissions' })).status, 400, 'nor a terminal session');
  assert.equal((await owner('POST', '/api/settings', { sessionDefaults: { permissionMode: 'bypassPermissions' } })).status, 400, 'nor the defaults');

  assert.equal((await owner('POST', '/api/settings/bypass', { allow: true })).status, 400, 'on only with a confirmation');
  assert.equal((await owner('POST', '/api/settings/bypass', { allow: true, confirm: true })).json.allow, true);
  assert.ok((await owner('GET', '/api/settings')).json.sessionChoices.permissionModes.includes('bypassPermissions'));
  assert.ok((await owner('GET', `/api/chats/${id}`)).json.choices.modes.includes('bypassPermissions'));
  assert.equal((await owner('POST', `/api/chats/${id}/mode`, { mode: 'bypassPermissions' })).status, 200, 'allowed now');
  assert.equal((await owner('POST', '/api/settings', { sessionDefaults: { permissionMode: 'bypassPermissions' } })).status, 200);

  // Off again: the defaults lose it, the open App session goes to Manual.
  const off = await owner('POST', '/api/settings/bypass', { allow: false });
  assert.deepEqual([off.json.allow, off.json.changed, off.json.defaults], [false, 1, true]);
  assert.equal((await owner('GET', `/api/chats/${id}`)).json.permissionMode, 'manual');
  assert.equal((await owner('GET', '/api/settings')).json.sessionDefaults.permissionMode, undefined);
});

test('an open App page learns at once that the switch changed: its stream sends the modes it offers now', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const { owner, proj, base, cookie } = await dashboard(t, 'bypassstream');
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  const states = [];
  const req = http.get(new URL(`/api/chats/${id}/stream`, base), { headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev && ev[1] === 'state' && data) states.push(JSON.parse(data[1]));
      }
    });
  });
  t.after(() => req.destroy());
  await until('the stream is open', async () => (await new Promise((r) => setTimeout(r, 300)), true));
  const seen = states.length;
  await owner('POST', '/api/settings/bypass', { allow: true, confirm: true });
  const on = await until('a state with Bypass permissions', async () => states.slice(seen).find((x) => x.choices && x.choices.modes.includes('bypassPermissions')));
  assert.ok(on);
  const after = states.length;
  await owner('POST', '/api/settings/bypass', { allow: false });
  assert.ok(await until('a state without it', async () => states.slice(after).find((x) => x.choices && !x.choices.modes.includes('bypassPermissions'))));
});
