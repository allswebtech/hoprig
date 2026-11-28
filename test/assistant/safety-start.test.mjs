// Tia cannot start a session or a chat in, or inside, the credentials folder or any other secret place (the
// providers' folder, a Claude Code sign-in): not by her tools, not by her token, not by another computer's dashboard
// relaying her, not by any caller that is not the owner's own page, whatever her level says. The owner's own page
// may. Over a real dashboard on the stand-ins (the launcher and Claude Code are made up). Nothing here is a real key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRoute } from '../../src/assistant/door.mjs';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, 'fixtures', 'fake-session.mjs');
const POSIX = { skip: process.platform === 'win32' && 'the stand-ins are POSIX' };

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
        resolve({ status: res.statusCode, json, text: t });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('no way for Tia, or any caller but the owner\'s page, to start a session or a chat inside a secret place', { timeout: 90_000, ...POSIX }, async (t) => {
  const box = sandbox('safety-start');
  const top = fs.realpathSync(box.root);
  const creds = path.join(fs.realpathSync(box.workspace), 'credentials');
  const shopKeys = path.join(creds, 'shop');
  fs.mkdirSync(shopKeys, { recursive: true });
  const proj = path.join(top, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.symlinkSync(creds, path.join(proj, 'creds-link')); // a way in through a link
  const providers = box.profiles;
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { SELF_HEADER, OWNER_PAGE_HEADER } = await import('../../src/machines/relay.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [top], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'full', accounts: ['sub'], dailyCapUsd: 5 }, operator: { acts: true }, sessionDefaults: { permissionMode: 'manual' } });
  // A provider that looks like a subscription: no per-token cost, so no card is asked for a start on it.
  writeProfile('sub', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-not-a-token' } });
  const app = createServer({ watchTickMs: 300, watch: true, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 } });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
  t.after(async () => {
    await app.close().catch(() => {});
    box.cleanup();
  });
  const cookie = (await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, resolve);
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const tiaToken = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const tia = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tiaToken}`, 'X-Hoprig-Conversation': 'conv-safety' } })).json;
  const { token } = createToken('hub');
  const joined = (p, body, extra = {}) => request(base, 'POST', p, { body, headers: { Authorization: `Bearer ${token}`, ...extra } });
  const hub = createToken('owner hub', { hub: true }).token; // a main computer of his: its own page's start carries the page mark
  const viaHub = (p, body, extra = {}) => request(base, 'POST', p, { body, headers: { Authorization: `Bearer ${hub}`, ...extra } });
  const sessionsIn = async (dir) => (await owner('GET', '/api/state')).json.sessions.filter((s) => s.cwd === dir || String(s.cwd).startsWith(`${dir}/`));
  const chatsIn = async () => (await owner('GET', '/api/chats')).json.chats.length;

  const PLACES = { 'the credentials folder': creds, 'a folder inside it': shopKeys, 'a link to it': path.join(proj, 'creds-link'), 'the providers folder': providers };

  // ---- her tools ----
  for (const [what, dir] of Object.entries(PLACES)) {
    const s = await tia('start_session', { folder: dir, account: 'sub' });
    assert.equal(s.isError, true, `start_session in ${what}: ${s.text}`);
    assert.match(s.text, /credential|secret|sign-in|private/i, `start_session in ${what}: says why`);
    const c = await tia('start_chat', { folder: dir });
    assert.equal(c.isError, true, `start_chat in ${what}: ${c.text}`);
  }
  assert.equal((await owner('GET', '/api/state')).json.sessions.length, 0, 'no session was started by her');
  assert.equal(await chatsIn(), 0, 'no chat was started by her');

  // ---- the routes: her token, a relay of her, a plain token, whatever the body says ----
  for (const [what, dir] of Object.entries(PLACES)) {
    const body = { dir, profile: 'sub', mode: 'new' };
    const herToken = await request(base, 'POST', '/api/sessions', { body, headers: { Authorization: `Bearer ${tiaToken}` } });
    assert.equal(herToken.status, 403, `her token, session in ${what}: ${herToken.text}`);
    const relayed = await joined('/api/sessions', body, { [SELF_HEADER]: '1' });
    assert.equal(relayed.status, 403, `her relayed session in ${what}: ${relayed.text}`);
    const plain = await joined('/api/sessions', body);
    assert.equal(plain.status, 403, `a plain token, session in ${what}: ${plain.text}`);
    const noMark = await joined('/api/sessions', body, { [OWNER_PAGE_HEADER]: '1' });
    assert.equal(noMark.status, 403, `a token that only says it is a page, session in ${what}: ${noMark.text}`);
    const cb = { dir, profile: 'sub', defaults: true, byTia: true };
    for (const [who, r] of [['her token', await request(base, 'POST', '/api/chats', { body: cb, headers: { Authorization: `Bearer ${tiaToken}` } })], ['her relay', await joined('/api/chats', cb, { [SELF_HEADER]: '1' })], ['a plain token', await joined('/api/chats', { dir, profile: 'sub' })]]) {
      assert.equal(r.status, 403, `${who}, chat in ${what}: ${r.text}`);
    }
  }
  assert.equal((await owner('GET', '/api/state')).json.sessions.length, 0, 'the routes started nothing');
  assert.equal(await chatsIn(), 0);

  // ---- the door says it too, before anything is sent ----
  for (const dir of [creds, shopKeys, providers]) {
    assert.throws(() => checkRoute('POST', '/api/sessions', { dir, profile: 'sub', mode: 'new' }, {}), (e) => e.status === 403 && e.code === 'tia-route', dir);
    assert.throws(() => checkRoute('POST', '/api/chats', { dir, profile: 'sub', defaults: true, byTia: true }, {}), (e) => e.status === 403 && e.code === 'tia-route', dir);
  }
  assert.doesNotThrow(() => checkRoute('POST', '/api/sessions', { dir: proj, profile: 'sub', mode: 'new' }, {}), 'an ordinary folder is as before');

  // ---- an ordinary folder still starts, for her and for him ----
  const ok = await tia('start_session', { folder: proj, account: 'sub' });
  assert.equal(ok.isError, false, ok.text);
  assert.equal((await sessionsIn(proj)).length, 1);

  // ---- a main computer of his relaying his own page may; the same main computer relaying her may not ----
  assert.equal((await viaHub('/api/sessions', { dir: shopKeys, profile: 'sub', mode: 'new' }, { [SELF_HEADER]: '1' })).status, 403, 'her start through his main computer');
  assert.equal((await viaHub('/api/chats', { dir: shopKeys, profile: 'sub', defaults: true, byTia: true }, { [SELF_HEADER]: '1' })).status, 403, 'her chat through his main computer');
  const viaPage = await viaHub('/api/sessions', { dir: shopKeys, profile: 'sub', mode: 'new' }, { [OWNER_PAGE_HEADER]: '1' });
  assert.equal(viaPage.status, 200, `his page through his main computer: ${viaPage.text}`);

  // ---- his own page may: it is his folder ----
  const his = await owner('POST', '/api/sessions', { dir: shopKeys, profile: 'sub', mode: 'new' });
  assert.equal(his.status, 200, his.text);
  const hisChat = await owner('POST', '/api/chats', { dir: shopKeys, profile: 'sub' });
  assert.equal(hisChat.status, 200, hisChat.text);
  for (const s of (await owner('GET', '/api/state')).json.sessions) await owner('POST', `/api/sessions/${encodeURIComponent(s.name)}/kill`, {});
  if (hisChat.json && hisChat.json.id) await owner('POST', `/api/chats/${hisChat.json.id}/close`, {});
});
