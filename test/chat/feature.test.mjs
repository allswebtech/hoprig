// The coding chat in the real dashboard (createServer, built-in terminals): its routes behind the login, a chat as a
// card among the sessions, the OK card through the page's route, and the owner's rule that one conversation never
// runs in two places at once (a terminal runs it → the chat refuses to send and offers to take it over; a chat runs
// it → a terminal resume answers with that chat). Claude Code is the stand-in (fixtures/fake-claude.mjs), the terminal's
// launcher the stand-in of Tia's tests (no Claude Code, no quota).
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

test('the coding chat in the dashboard', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatsrv');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'manual' } });
  writeProfile('sub', { label: 'Main' });
  writeProfile('api', { label: 'Gateway', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'secret-of-the-test' } });
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
  const realProj = fs.realpathSync(proj);

  assert.equal((await request(base, 'GET', '/api/chats')).status, 401, 'behind the login');
  const login = await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } });
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  assert.equal(login.status, 200);
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });

  // ---- input is checked ----
  assert.equal((await owner('POST', '/api/chats', { dir: '/etc', profile: 'sub' })).status, 400, 'only inside the roots');
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'nobody' })).status, 400);
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'sub', model: 'gpt-9' })).status, 400, 'models from the fixed list');
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: '00000000-0000-4000-8000-000000000000' })).status, 400, 'an id must be a conversation of the folder');

  // ---- a new chat with a first message ----
  const made = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'hello chat' });
  assert.equal(made.status, 200);
  const id = made.json.id;
  const view = async (q = '') => (await owner('GET', `/api/chats/${id}${q}`)).json;
  const v1 = await until('the first answer', async () => {
    const x = await view();
    return x.events.some((e) => e.kind === 'turn-end') && x;
  });
  assert.equal(v1.permissionMode, 'manual', 'the session defaults apply');
  assert.equal(v1.profile.label, 'Main');
  assert.equal(v1.short.endsWith('proj'), true);
  assert.deepEqual(v1.events.map((e) => e.kind), ['user', 'text', 'turn-end']);
  assert.ok(!JSON.stringify(v1).includes('secret-of-the-test'));

  // the long poll waits while nothing changes (first the idle process stops: that is news too, `running` changes)
  await until('the idle process to stop', async () => !(await view()).running);
  const t0 = Date.now();
  const quiet = await view(`?from=${v1.next}&epoch=${v1.epoch}&wait=1`);
  assert.ok(Date.now() - t0 >= 900, 'waited for news');
  assert.deepEqual(quiet.events, []);
  assert.equal(quiet.reset, false);

  // ---- the card among the sessions ----
  const st = (await owner('GET', '/api/state')).json;
  const card = st.sessions.find((s) => s.kind === 'chat');
  assert.equal(card.name, `chat:${id}`);
  assert.equal(card.display, 'hello chat');
  assert.equal(card.status, 'waiting');
  assert.equal(card.lastMessage, 'echo: hello chat');

  // ---- a tool use that needs the OK: the card says so; allowed through the route ----
  const waitNews = owner('GET', `/api/chats/${id}?from=${v1.next}&epoch=${v1.epoch}&wait=10`);
  assert.equal((await owner('POST', `/api/chats/${id}/send`, { text: 'write out.txt' })).status, 200);
  assert.ok((await waitNews).json.events.length > 0, 'the waiting page hears of it');
  const asking = await until('the OK card', async () => {
    const x = await view();
    return x.status === 'attention' && x;
  });
  const ask = asking.events.find((e) => e.kind === 'ask');
  assert.equal(ask.tool, 'Write');
  assert.deepEqual(asking.pending, [ask.request]);
  const needs = await until('Home to see it', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === `chat:${id}` && s.status === 'attention'));
  assert.match(needs.note, /^Claude wants to write: out.txt$/, 'the file, inside the folder');
  assert.equal(needs.ask.subject, path.join(proj, 'out.txt'), 'the whole path, for Tia\'s rules');
  assert.equal((await owner('POST', `/api/chats/${id}/answer`, { request: ask.request })).status, 400, 'allow must be said');
  assert.equal((await owner('POST', `/api/chats/${id}/answer`, { request: ask.request, allow: true })).status, 200);
  assert.equal((await owner('POST', `/api/chats/${id}/answer`, { request: ask.request, allow: true })).status, 409, 'once');
  await until('the file', () => fs.existsSync(path.join(proj, 'out.txt')));

  // ---- a chat runs it: a terminal may not resume it ----
  await until('the turn to end', async () => (await view()).status === 'waiting');
  const meanwhile = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id });
  assert.equal(meanwhile.status, 200);
  assert.deepEqual(meanwhile.json, { chat: id, existing: true }, 'the chat that runs it, and no terminal');

  // ---- a terminal runs it: the chat reads along, refuses to send, and takes it over ----
  await until('the idle chat process to stop', async () => !(await view()).running);
  const term = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'resume', sessionId: id });
  assert.equal(term.status, 200);
  const vt = await until('the chat to see the terminal', async () => {
    const x = await view();
    return x.terminal && x;
  });
  assert.equal(vt.terminal.name, term.json.name);
  const refused = await owner('POST', `/api/chats/${id}/send`, { text: 'from the chat' });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /runs in the terminal session/);
  // Nothing else starts Claude Code on it either: no rewind, and the / menu from what the chat knew.
  const firstMsg = vt.events.find((e) => e.kind === 'user');
  const rw = await owner('POST', `/api/chats/${id}/rewind`, { messageId: firstMsg.messageId, dryRun: true });
  assert.equal(rw.status, 409, 'a rewind would run a second process on the conversation');
  assert.match(rw.json.error, /runs in the terminal session/);
  assert.equal((await owner('GET', `/api/chats/${id}/commands`)).status, 200);
  assert.equal((await view()).running, false, 'the menu started no process');
  assert.equal((await owner('POST', `/api/chats/${id}/take`, {})).status, 200);
  assert.equal((await view()).terminal, null, 'the terminal stopped Claude');
  const shell = await until('the terminal to be a plain shell', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === term.json.name && s.kind === 'shell'));
  assert.ok(shell, 'the terminal itself stays');
  assert.equal((await owner('POST', `/api/chats/${id}/send`, { text: 'back in the chat' })).status, 200);
  await until('the answer', async () => (await view()).events.some((e) => e.kind === 'text' && e.text === 'echo: back in the chat'));
  await until('the turn to end', async () => (await view()).status === 'waiting');

  // ---- provider, next turn, Stop ----
  assert.equal((await owner('POST', `/api/chats/${id}/provider`, { profile: 'api' })).json.profile.label, 'Gateway');
  assert.ok((await view()).events.some((e) => e.kind === 'notice' && e.text === 'The next message goes to another provider (Gateway).'), 'the owner\'s name for it, not its id');
  assert.equal((await owner('POST', `/api/chats/${id}/settings`, { model: 'haiku', effort: 'low' })).json.model, 'haiku');
  assert.equal((await owner('POST', `/api/chats/${id}/settings`, { effort: 'enormous' })).status, 400);
  await owner('POST', `/api/chats/${id}/send`, { text: 'sleep' });
  await until('the long command', async () => (await view()).events.some((e) => e.kind === 'tool' && e.name === 'Bash'));
  // "continue" (-c) means the folder's newest conversation: this one, which the chat works on right now.
  const cont = await owner('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'continue' });
  assert.deepEqual(cont.json, { chat: id, existing: true });
  assert.equal((await owner('POST', `/api/chats/${id}/stop`, {})).json.stopped, true);
  await until('stopped', async () => (await view()).status === 'waiting');

  // ---- open in a terminal: the chat closes, a terminal session resumes the conversation ----
  const opened = await owner('POST', `/api/chats/${id}/terminal`, {});
  assert.equal(opened.status, 200);
  const handed = await owner('GET', `/api/chats/${id}`);
  assert.equal(handed.status, 404, 'the chat is closed');
  assert.equal(handed.json.closed.terminal, opened.json.name, 'its page can open the terminal it went to');
  const resumed = await until('the terminal session', async () => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === opened.json.name && s.kind === 'claude'));
  assert.equal(resumed.sessionId, id, 'the same conversation');

  // ---- and from the terminal back to a chat ----
  const back = await owner('POST', '/api/chats/from-session', { session: opened.json.name });
  assert.equal(back.status, 200);
  assert.equal(back.json.id, id);
  const vb = await view();
  assert.ok(vb.terminal, 'read only until "Continue here"');
  assert.ok(vb.events.some((e) => e.kind === 'user' && e.text === 'hello chat'), 'the history comes from the transcript');
  assert.deepEqual([vb.model, vb.effort], ['haiku', 'low'], 'taken back from the terminal with the model and effort it ran with');
  assert.equal((await owner('POST', `/api/chats/${id}/close`, {})).status, 200);
  assert.deepEqual((await owner('GET', '/api/chats')).json.chats, []);
  // Its page, opened again, can still name it and continue its conversation in a new chat.
  const shut = await owner('GET', `/api/chats/${id}`);
  assert.equal(shut.status, 404);
  assert.deepEqual([shut.json.closed.cwd, shut.json.closed.conversationId], [realProj, id]);
  // One closed before its first message has no conversation to continue: its page offers only the way back.
  const empty = await owner('POST', '/api/chats', { dir: proj, profile: 'sub' });
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.equal((await owner('POST', `/api/chats/${empty.json.id}/close`, {})).status, 200);
  const emptyShut = await owner('GET', `/api/chats/${empty.json.id}`);
  assert.deepEqual([emptyShut.status, emptyShut.json.closed.cwd, emptyShut.json.closed.conversationId], [404, realProj, null]);

  // the list of open chats is kept in a file of the state folder, 600, without secrets
  const { stateDir } = await import('../../src/paths.mjs');
  const kept = path.join(stateDir(), 'chats.json');
  assert.equal((fs.statSync(kept).mode & 0o777).toString(8), '600');
  assert.ok(!fs.readFileSync(kept, 'utf8').includes('secret-of-the-test'));
  assert.equal(realProj.length > 0, true);
});
