// One conversation, one process (the owner's rule), through the real routes of a dashboard (createServer, built-in
// terminals): whoever asks for a conversation that a terminal runs (the chat's "Open in terminal" and /terminal, a
// second tab, New session's "pick an earlier conversation" and "continue", Tia's start_session and start_chat) gets
// that terminal and no second one; "Open as chat" and "Continue here" pressed twice or in two tabs act once; a
// conversation a chat runs gives that chat. Claude Code is the stand-in (fixtures/fake-claude.mjs), the terminal's
// launcher the stand-in of Tia's tests (it registers a run record with the conversation, as the launcher does).
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
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last).slice(0, 300))})`);
};

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('one conversation, one process: no second terminal or chat process on a conversation that runs', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('oneproc');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { listRuns } = await import('../../src/runs.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
  });
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
  const terminalsOn = async (conv) => (await owner('GET', '/api/state')).json.sessions.filter((s) => s.kind === 'claude' && s.sessionId === conv).map((s) => s.name);
  const processesOn = (conv) => listRuns().filter((r) => r.sessionId === conv).length;

  // A chat with a first answer: the conversation exists on disk.
  const made = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'hello' });
  const id = made.json.id;
  const view = async () => (await owner('GET', `/api/chats/${id}`)).json;
  await until('the first answer', async () => (await view()).events.some((e) => e.kind === 'turn-end'));
  await until('the idle chat process to stop', async () => !(await view()).running);

  // ---- "Open in terminal" from the chat, twice at once (a double tap, two tabs): one terminal ----
  const [o1, o2] = await Promise.all([owner('POST', `/api/chats/${id}/terminal`, {}), owner('POST', `/api/chats/${id}/terminal`, {})]);
  assert.equal(o1.status, 200);
  assert.equal(o2.status, 200, 'the second asks for the same conversation: it gets that terminal, not an error');
  assert.equal(o1.json.name, o2.json.name);
  assert.equal([o1.json, o2.json].filter((x) => x.existing).length, 1, 'one of them started it');
  const term = o1.json.name;
  await until('the terminal on the conversation', async () => (await terminalsOn(id)).length === 1);

  // ---- "Open as chat" twice at once: one chat, read along ----
  const [b1, b2] = await Promise.all([owner('POST', '/api/chats/from-session', { session: term }), owner('POST', '/api/chats/from-session', { session: term })]);
  assert.equal(b1.json.id, b2.json.id);
  assert.equal((await owner('GET', '/api/chats')).json.chats.length, 1);
  const chat = b1.json.id;
  const cv = await until('the chat to see the terminal', async () => {
    const x = (await owner('GET', `/api/chats/${chat}`)).json;
    return x.terminal && x;
  });
  assert.equal(cv.terminal.name, term);

  // ---- every way to a second terminal answers with this one ----
  const ways = [
    ['the chat\'s Open in terminal', () => owner('POST', `/api/chats/${chat}/terminal`, {})],
    ['New session: pick an earlier conversation', () => owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id })],
    ['New session: continue the newest', () => owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'continue' })],
    ['Tia\'s start_session with a first message', () => owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id, prompt: 'do it' })],
  ];
  for (const [what, ask] of ways) {
    const r = await ask();
    assert.equal(r.status, 200, what);
    assert.equal(r.json.name, term, `${what}: the terminal that runs it`);
    assert.equal(r.json.existing, true, what);
  }
  assert.equal((await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id, prompt: 'do it' })).json.sent, false, 'a first message is not typed into his terminal');
  assert.equal((await owner('GET', `/api/chats/${chat}`)).status, 200, 'the chat stays open, reading along');
  // Tia's start_chat (and a chat opened on it from the folder's history): the chat that reads along, no process.
  const tia = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: id, text: 'from Tia', defaults: true, byTia: true });
  assert.equal(tia.json.id, chat);
  assert.equal(tia.json.sent, false);
  assert.equal((await owner('POST', `/api/chats/${chat}/send`, { text: 'from the page' })).status, 409, 'the chat does not send while the terminal runs it');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(await terminalsOn(id), [term], 'still one terminal');
  assert.equal(processesOn(id), 1, 'one process on the conversation');
  assert.equal((await owner('GET', `/api/chats/${chat}`)).json.running, false, 'and no chat process');

  // ---- "Continue here" twice at once: the terminal stops once, the chat goes on ----
  const [t1, t2] = await Promise.all([owner('POST', `/api/chats/${chat}/take`, {}), owner('POST', `/api/chats/${chat}/take`, {})]);
  assert.deepEqual([t1.status, t2.status], [200, 200]);
  await until('no terminal on it', async () => (await terminalsOn(id)).length === 0);
  assert.equal((await owner('POST', `/api/chats/${chat}/send`, { text: 'here now' })).status, 200);
  await until('the answer in the chat', async () => (await owner('GET', `/api/chats/${chat}`)).json.events.some((e) => e.text === 'echo: here now'));

  // ---- a chat runs it (its process waits idle): a terminal start gives the chat ----
  assert.ok((await owner('GET', `/api/chats/${chat}`)).json.running, 'the chat process is up');
  const busy = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id });
  assert.deepEqual(busy.json, { chat, existing: true });
  assert.deepEqual(await terminalsOn(id), [], 'no terminal was started beside the chat');
});
