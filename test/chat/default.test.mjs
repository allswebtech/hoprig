// The chat as the default way to code, in the real dashboard (createServer, built-in terminals): a chat opened with
// no choices takes what the last chat in that folder ran with; a chat's card on Home has plain words, the OK it
// waits for (answered from the card) and "working in the background"; New session's recent folders open a chat at
// work; `hoprig chat` prints the address that opens one. Claude Code is the stand-in (fixtures/fake-claude.mjs).
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

test('the chat is the default: the folder\'s last settings, Home\'s card, the recent folders', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatdefault');
  const work = path.join(box.root, 'work');
  const shop = path.join(work, 'shop');
  const blog = path.join(work, 'blog');
  for (const d of [shop, blog]) fs.mkdirSync(d, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'manual' } });
  writeProfile('sub', { label: 'Main' });
  writeProfile('api', { label: 'Gateway', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'secret-of-the-test' } });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 30_000 },
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
  const view = async (id) => (await owner('GET', `/api/chats/${id}`)).json;
  const cardOf = async (id) => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === `chat:${id}`);

  // ---- the first chat in a folder: the recommended provider and Settings ----
  const recommended = (await owner('GET', '/api/state')).json.recommended;
  const first = await owner('POST', '/api/chats', { dir: shop });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const v1 = await view(first.json.id);
  assert.equal(v1.profile.name, recommended, 'no provider chosen: the one recommended now');
  assert.equal(v1.permissionMode, 'manual', 'Settings → New-session defaults');
  assert.equal(v1.model, null);

  // the owner changes the chat's chips: provider, mode, model, effort, ultracode
  assert.equal((await owner('POST', `/api/chats/${first.json.id}/provider`, { profile: 'api' })).status, 200);
  assert.equal((await owner('POST', `/api/chats/${first.json.id}/mode`, { mode: 'acceptEdits' })).status, 200);
  assert.equal((await owner('POST', `/api/chats/${first.json.id}/settings`, { model: 'sonnet', effort: 'high', ultracode: true })).status, 200);

  // ---- one tap on the project again: a new chat with exactly those ----
  const again = await owner('POST', '/api/chats', { dir: shop });
  assert.notEqual(again.json.id, first.json.id, 'a new chat');
  const v2 = await view(again.json.id);
  assert.deepEqual([v2.profile.name, v2.permissionMode, v2.model, v2.effort, v2.ultracode], ['api', 'acceptEdits', 'sonnet', 'high', true]);
  // what is chosen wins; null is "Auto"
  const chosen = await view((await owner('POST', '/api/chats', { dir: shop, profile: 'sub', model: null })).json.id);
  assert.deepEqual([chosen.profile.name, chosen.model, chosen.effort], ['sub', null, 'high']);
  // another folder has its own: nothing yet there
  const other = await view((await owner('POST', '/api/chats', { dir: blog })).json.id);
  assert.deepEqual([other.profile.name, other.permissionMode, other.model, other.ultracode], [recommended, 'manual', null, false]);
  // kept on the server, in its state folder, and no secret in it
  const kept = fs.readFileSync(path.join(box.state, 'chat-folders.json'), 'utf8');
  assert.ok(JSON.parse(kept)[fs.realpathSync(shop)], 'the folder is a key');
  assert.ok(!kept.includes('secret-of-the-test'));
  assert.equal((await owner('POST', '/api/chats', { dir: shop, ultracode: 'yes' })).status, 400);

  // ---- Home's card: plain words, the OK answered from the card, "working in the background" ----
  const id = other.id;
  assert.equal((await owner('POST', `/api/chats/${id}/send`, { text: 'Done: **dark mode** in `App.tsx`' })).status, 200);
  await until('the reply', async () => (await view(id)).status === 'waiting' && (await view(id)).events.some((e) => e.kind === 'turn-end'));
  assert.equal((await cardOf(id)).lastMessage, 'echo: Done: dark mode in App.tsx', 'no Markdown marks on the card');

  assert.equal((await owner('POST', `/api/chats/${id}/send`, { text: 'write out.txt' })).status, 200);
  const asking = await until('the card to ask', async () => {
    const c = await cardOf(id);
    return c && c.status === 'attention' && c;
  });
  assert.match(asking.note, /^Allow Write/);
  assert.equal(asking.ask.type, 'permission');
  assert.equal(typeof asking.ask.request, 'string');
  assert.equal((await owner('POST', `/api/chats/${id}/answer`, { request: asking.ask.request, allow: true })).status, 200, 'the card\'s Allow');
  await until('the file', () => fs.existsSync(path.join(blog, 'out.txt')));
  await until('the turn to end', async () => (await view(id)).status === 'waiting');

  assert.equal((await owner('POST', `/api/chats/${id}/send`, { text: 'bgagent 2500' })).status, 200);
  const bg = await until('the background agent', async () => {
    const c = await cardOf(id);
    return c && c.status === 'working' && c.background && c;
  });
  assert.equal(bg.background, true, 'the turn is over, the agent still works');
  // New session's recent folders: the folder of a chat at work opens that chat
  const recent = (await owner('GET', '/api/folders/recent')).json.folders.find((f) => f.path === fs.realpathSync(blog));
  assert.equal(recent && recent.chat, id);
  assert.equal(recent.live, true);
  await until('the follow-up turn and the end', async () => (await cardOf(id)).status === 'waiting', 30_000);
  assert.equal((await cardOf(id)).background, false);

  // ---- a schedule starts a chat (the folder's last settings) and messages an open chat ----
  const auto = app.features.find((f) => f.name === 'automation').automation;
  const soon = new Date(Date.now() + 120_000);
  const hhmm = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
  const slot = new Date(soon.getFullYear(), soon.getMonth(), soon.getDate(), soon.getHours(), soon.getMinutes()).getTime();
  for (const action of [{ type: 'start', in: 'chat', dir: shop, profile: 'sub', prompt: 'hello from a schedule' }, { type: 'send', session: `chat:${id}`, text: 'scheduled hello' }]) {
    const r = await owner('POST', '/api/automation/schedules', { op: 'add', schedule: { when: { kind: 'daily', time: hhmm }, action } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const before = new Set((await owner('GET', '/api/chats')).json.chats.map((c) => c.chatId));
  const started = await until('the scheduled chat', async () => {
    await auto.tick(slot + 1000);
    return (await owner('GET', '/api/chats')).json.chats.find((c) => !before.has(c.chatId));
  });
  const sv = await until('its reply', async () => {
    const x = await view(started.chatId);
    return x.events.some((e) => e.kind === 'text' && e.text === 'echo: hello from a schedule') && x;
  });
  assert.deepEqual([sv.cwd, sv.profile.name, sv.permissionMode, sv.model, sv.effort], [fs.realpathSync(shop), 'sub', 'acceptEdits', null, 'high'], 'the provider the schedule names, the rest as the last chat there (the "chosen" one)');
  await until('the message in the open chat', async () => (await view(id)).events.some((e) => e.kind === 'text' && e.text === 'echo: scheduled hello'));
  const log = (await owner('GET', '/api/automation/log')).json.entries.filter((e) => e.automation === 'schedules');
  assert.ok(log.some((e) => /in a chat/.test(e.did) && e.outcome === 'ok'), JSON.stringify(log));
  assert.ok(log.some((e) => e.session === `chat:${id}` && e.outcome === 'ok'), JSON.stringify(log));
});

test('hoprig chat prints the address that opens a chat in the folder, and opens it where a browser is at hand', async () => {
  const { browserAtHand, chatAddress, main } = await import('../../src/chat/cli.mjs');
  assert.equal(chatAddress('http://127.0.0.1:7433/', '/home/x/my shop'), 'http://127.0.0.1:7433/#/new?dir=%2Fhome%2Fx%2Fmy+shop');
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'hoprig-chatcli-'));
  try {
    const out = [];
    const opened = [];
    const run = (args, more = {}) => main(args, { cwd: dir, running: () => ({ pid: 1, host: '127.0.0.1', port: 7433 }), base: () => 'https://dash.example', local: () => 'http://127.0.0.1:7433', open: (u) => opened.push(u) || true, atHand: () => true, log: (s) => out.push(s), err: (s) => out.push(`ERR ${s}`), ...more });
    assert.equal(await run([]), 0);
    assert.match(out.join('\n'), new RegExp(`https://dash\\.example/#/new\\?dir=${encodeURIComponent(dir).replace(/%20/g, '\\+')}`));
    assert.deepEqual(opened, [chatAddress('http://127.0.0.1:7433', dir)], 'this computer\'s own address in its browser');
    assert.equal(await run(['--no-open']), 0);
    assert.equal(opened.length, 1, '--no-open only prints');
    assert.equal(await run([], { atHand: () => false }), 0);
    assert.equal(opened.length, 1, 'no browser at hand: only printed');
    assert.equal(await run(['no-such-folder']), 2);
    assert.equal(await run([], { running: () => null }), 1, 'the dashboard must run');
    assert.match(out.join('\n'), /not running\. Start it with "hoprig serve"/);
    assert.equal(await run(['a', 'b']), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(browserAtHand({ DISPLAY: ':0' }, 'linux', true), true);
  assert.equal(browserAtHand({}, 'linux', true), false, 'no screen');
  assert.equal(browserAtHand({ DISPLAY: ':0', SSH_CONNECTION: 'x' }, 'linux', true), false, 'over ssh the browser would open on the far screen');
  assert.equal(browserAtHand({}, 'darwin', false), false, 'not at a terminal');
});
