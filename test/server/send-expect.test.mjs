// The send route with `expect: 'waiting'` (the reply box on a Home card): the words are typed only while the session's
// run record, read on the server at the send, still waits for an answer and no menu stands on its screen; otherwise
// 409 with a plain sentence and nothing is typed. Any other `expect` is refused with 400. A send without `expect`
// is as before. The built-in terminals and a stand-in launcher (fixtures/fake-launcher.mjs): no Claude Code runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-launcher.mjs');
const POSIX = process.platform !== 'win32';
const skip = !POSIX && 'the stand-in launcher is written for POSIX shells';
const box = sandbox('sendexpect');
const work = path.join(box.root, 'work');
fs.mkdirSync(work);
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
saveConfig({ launcher: [process.execPath, FAKE], server: { backend: 'pty', roots: [box.root], passwordHash: await hashPassword('test-password-1') } });
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(150)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const card = async (name) => (await req('/api/state')).json.sessions.find((s) => s.name === name);
const screen = async (name) => (await req(`/api/sessions/${name}/history?lines=200`)).json.text;
const send = (name, body) => req(`/api/sessions/${name}/send`, body);
async function start() {
  const { json } = await req('/api/sessions', { dir: work, profile: 'sub', mode: 'new' });
  await until('the session', async () => ((await card(json.name)) || {}).status === 'waiting');
  return json.name;
}

test('expect waiting: a waiting session gets the words', { skip }, async () => {
  const name = await start();
  const r = await send(name, { text: 'reply one', expect: 'waiting' });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  await until('the reply in the session', async () => (await screen(name)).includes('GOT: reply one'));
  await req(`/api/sessions/${name}/kill`, {});
});

test('expect waiting: a session whose run record says it works gets nothing, with the sentence', { skip }, async () => {
  const name = await start();
  await send(name, { text: 'SLOW job' }); // the stand-in's record says "working" for 1.5 s
  const r = await send(name, { text: 'reply two', expect: 'waiting' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, `Nothing was sent: ${name} is no longer waiting for an answer.`);
  await until('the job done', async () => (await screen(name)).includes('GOT: SLOW job'));
  await wait(600);
  assert.equal((await screen(name)).includes('reply two'), false, 'nothing was typed');
  await req(`/api/sessions/${name}/kill`, {});
});

test('expect waiting: a menu on the screen gets nothing, with the sentence', { skip }, async () => {
  const name = await start();
  await send(name, { text: 'MENU' }); // the record still says "waiting"; the screen shows a numbered menu
  await until('the menu', async () => (await screen(name)).includes('2. Switch to extra usage'));
  assert.equal((await card(name)).limit !== undefined, true);
  const r = await send(name, { text: '2', expect: 'waiting' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, `Nothing was sent: ${name} shows a question on its screen. Open the session to answer it there.`);
  await wait(600);
  assert.equal((await screen(name)).includes('GOT: 2'), false, 'nothing was typed into the menu');
  await req(`/api/sessions/${name}/kill`, {});
});

test('expect waiting: a record that turns to a question between the text and its Enter gets no Enter', { skip }, async () => {
  const { runsDir } = await import('../../src/paths.mjs');
  const { readRun, updateRun } = await import('../../src/runs.mjs');
  const name = await start();
  const file = fs.readdirSync(runsDir()).filter((f) => f.endsWith('.json')).map((f) => path.join(runsDir(), f))
    .find((f) => { const r = readRun(f) || {}; return r.cwd === work && r.status === 'waiting'; });
  const pending = send(name, { text: 'enter-probe', expect: 'waiting' });
  // The text stands on the screen (the terminal echoes it) and its Enter waits 250 ms: the record turns to a question.
  // Looked at without a pause between looks, so the change lands well inside those 250 ms.
  for (const end = Date.now() + 5_000; !(await screen(name)).includes('enter-probe');) if (Date.now() > end) throw new Error('timed out waiting for the typed text');
  updateRun(file, { status: 'attention' });
  const r = await pending;
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'typed_not_sent', 'the text went, its Enter did not');
  await wait(600);
  assert.equal((await screen(name)).includes('GOT: enter-probe'), false, 'the Enter was not pressed');
  await req(`/api/sessions/${name}/kill`, {});
});

test('another expect value is refused with 400 and types nothing; so is expect with the owner\'s own keys', { skip }, async () => {
  const name = await start();
  for (const expect of ['working', 'Waiting', '', 1, true, null]) {
    const r = await send(name, { text: `odd ${String(expect)}`, expect });
    assert.equal(r.status, 400, `expect ${JSON.stringify(expect)}`);
  }
  assert.equal((await send(name, { text: 'own keys', expect: 'waiting', owner: true })).status, 400);
  await wait(600);
  const text = await screen(name);
  assert.equal(text.includes('odd '), false, 'nothing was typed');
  assert.equal(text.includes('own keys'), false, 'nothing was typed');
  await req(`/api/sessions/${name}/kill`, {});
});

test('without expect the send is as before: typed for the tool in front, also while it works', { skip }, async () => {
  const name = await start();
  await send(name, { text: 'SLOW job' });
  const r = await send(name, { text: 'no expect' });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  await until('the message in the session', async () => (await screen(name)).includes('GOT: no expect'));
  const own = await send(name, { text: 'owner words', owner: true });
  assert.deepEqual([own.status, own.json], [200, { ok: true }]);
  await until('the owner\'s words', async () => (await screen(name)).includes('GOT: owner words'));
  await req(`/api/sessions/${name}/kill`, {});
});

test('expect waiting to a plain terminal types nothing', async () => {
  const { json } = await req('/api/shells', { dir: work });
  const r = await send(json.name, { text: 'echo PLAIN-TYPED', expect: 'waiting' });
  assert.equal(r.status, 409);
  await wait(400);
  assert.equal((await screen(json.name)).includes('PLAIN-TYPED'), false);
  await req(`/api/sessions/${json.name}/kill`, {});
});
