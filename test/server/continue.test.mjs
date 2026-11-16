// A session that stands at a usage limit goes on, on the provider it is on (POST /api/sessions/<name>/continue):
// what the page calls after another Claude account signed in. The continue prompt is typed; with a menu on the
// screen nothing is typed and the answer says so; { restart: true } starts the same conversation again in place and
// the prompt follows once the new run waits. The built-in terminals and a stand-in launcher: no Claude Code runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-launcher.mjs');
const box = sandbox('continue');
const work = path.join(box.root, 'work');
fs.mkdirSync(work);
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
saveConfig({ launcher: [process.execPath, FAKE], autoSwitch: { prompt: 'Carry on, please.' }, server: { backend: 'pty', roots: [box.root], passwordHash: await hashPassword('test-password-1') } });
writeProfile('sub', { label: 'Stored sign-in' });
const app = createServer({ dashboardFile: false, watchTickMs: 300 });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(async () => {
  await app.close();
  box.cleanup();
});
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'test-password-1' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const req = async (p, body) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const until = async (what, fn, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const card = async (name) => (await req('/api/state')).json.sessions.find((s) => s.name === name);
const screen = async (name) => (await req(`/api/sessions/${name}/history?lines=200`)).json.text;
const say = (name, text) => req(`/api/sessions/${name}/send`, { text });
async function start() {
  const { json } = await req('/api/sessions', { dir: work, profile: 'sub', mode: 'new' });
  await until('the session', async () => ((await card(json.name)) || {}).status === 'waiting');
  return json.name;
}

test('at a limit the continue prompt is typed into the same session; not at a limit, nothing is', { skip: process.platform === 'win32' && 'the stand-in launcher is written for POSIX shells' }, async () => {
  const name = await start();
  let r = await req(`/api/sessions/${name}/continue`, {});
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not waiting at a usage limit/);
  await say(name, 'LIMIT');
  const at = await until('the limit card', async () => {
    const c = await card(name);
    return c && c.limit ? c : null;
  });
  assert.equal(at.profile.kind, 'login');
  await until('since when it stands there', async () => Number.isFinite((await card(name)).limitAt));
  const run = at.runId;
  r = await req(`/api/sessions/${name}/continue`, {});
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  await until('the prompt in the session', async () => (await screen(name)).includes('GOT: Carry on, please.'));
  assert.equal((await card(name)).runId, run, 'the same process: no restart');
  assert.equal((await req('/api/sessions/nope/continue', {})).status, 404);
  await req(`/api/sessions/${name}/kill`, {});
});

test('a menu on the screen: nothing is typed; the restart starts the conversation again in place, then continues', { skip: process.platform === 'win32' && 'the stand-in launcher is written for POSIX shells' }, async () => {
  const name = await start();
  await say(name, 'MENU');
  const at = await until('the limit card', async () => {
    const c = await card(name);
    return c && c.limit ? c : null;
  });
  let r = await req(`/api/sessions/${name}/continue`, {});
  assert.deepEqual([r.status, r.json], [200, { ok: false, menu: true }]);
  await new Promise((res) => setTimeout(res, 600));
  assert.equal((await screen(name)).includes('Carry on'), false, 'nothing was typed into the menu');
  r = await req(`/api/sessions/${name}/continue`, { restart: true });
  assert.deepEqual([r.status, r.json], [200, { ok: true, restarted: true }]);
  const again = await until('the new run', async () => {
    const c = await card(name);
    return c && c.runId && c.runId !== at.runId && c.status === 'waiting' ? c : null;
  });
  assert.equal(again.profile.name, 'sub', 'on the provider it was on');
  assert.equal(again.sessionId, at.sessionId, 'the same conversation');
  const text = await until('the prompt after the restart', async () => {
    const t = await screen(name);
    return t.includes('GOT: Carry on, please.') ? t : null;
  });
  assert.match(text, /FAKE-LAUNCH profile=sub args=\[[^\]]*"--resume","0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b"/);
  assert.equal(text.split('GOT: Carry on, please.').length - 1, 1, 'typed once');
  assert.equal((await card(name)).limit, null, 'the limit is off the screen');
  await req(`/api/sessions/${name}/kill`, {});
});

test('a plain terminal has nothing to continue', async () => {
  const { json } = await req('/api/shells', { dir: work });
  const r = await req(`/api/sessions/${json.name}/continue`, {});
  assert.equal(r.status, 409);
  assert.match(r.json.error, /plain shell/);
  await req(`/api/sessions/${json.name}/kill`, {});
});
