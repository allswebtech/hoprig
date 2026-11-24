// "Lead model" through the dashboard's routes (a real createServer, Claude Code a stand-in): a chat's own choice wins,
// then the folder's last chat, then Settings → New-session defaults; it is saved with the chat and survives a restart;
// another coding tool cannot lead; the chat's state says in one line which models Lead uses there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');

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

async function dashboard(t, box, work) {
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  return { app, owner: (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } }) };
}

test('Lead through the routes: chosen, the folder\'s last, Settings; saved; one line; off as before', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('leadroute');
  t.after(() => box.cleanup());
  const work = path.join(box.root, 'work');
  const shop = path.join(work, 'shop');
  const blog = path.join(work, 'blog');
  for (const d of [shop, blog]) fs.mkdirSync(d, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8243', ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });
  writeProfile('beta', { label: 'Beta', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8244', ANTHROPIC_AUTH_TOKEN: 'sk-beta-test-0123456789' } });
  let d = await dashboard(t, box, work);
  const view = async (id) => (await d.owner('GET', `/api/chats/${id}`)).json;

  // Off by default: the state says so, and the settings answer is the one of before.
  const plain = (await d.owner('POST', '/api/chats', { dir: shop, profile: 'sub' })).json.id;
  const v0 = await view(plain);
  assert.equal(v0.lead, false);
  assert.equal(v0.leadLine, null, 'no line is made for a chat with Lead off');
  assert.deepEqual(Object.keys((await d.owner('POST', `/api/chats/${plain}/settings`, { effort: 'high' })).json).sort(), ['effort', 'model', 'restart', 'ultracode']);

  // Turned on in the chat: kept, and the folder's next chat takes it.
  const on = await d.owner('POST', `/api/chats/${plain}/settings`, { lead: true });
  assert.equal(on.json.lead, true);
  assert.equal((await view(plain)).leadLine, 'Fast, running and recording: haiku\nStrong, writing and reviewing code: sonnet\nStrongest, hard thinking: opus', 'on: the line of what it uses');
  assert.equal((await d.owner('POST', `/api/chats/${plain}/settings`, { lead: 'yes' })).status, 400);
  const next = await view((await d.owner('POST', '/api/chats', { dir: shop })).json.id);
  assert.equal(next.lead, true, 'as the last chat in the folder');
  assert.equal((await view((await d.owner('POST', '/api/chats', { dir: shop, lead: false })).json.id)).lead, false, 'a choice wins');
  assert.equal((await d.owner('POST', '/api/chats', { dir: shop, lead: 'on' })).status, 400);

  // Settings → New-session defaults: a folder never chosen in takes it.
  assert.equal((await view((await d.owner('POST', '/api/chats', { dir: blog })).json.id)).lead, false);
  const saved = await d.owner('POST', '/api/settings', { sessionDefaults: { lead: true } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.sessionDefaults, { lead: true });
  assert.equal((await d.owner('POST', '/api/settings', { sessionDefaults: { lead: 'x' } })).status, 400);
  const fresh = path.join(work, 'fresh');
  fs.mkdirSync(fresh);
  const fromDefault = (await d.owner('POST', '/api/chats', { dir: fresh })).json.id;
  assert.equal((await view(fromDefault)).lead, true, 'the default of Settings');

  // "Use other providers": ticked with the chat (only with Lead on), checked by the server, kept.
  const ticked = (await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', lead: true, others: ['alpha'] })).json.id;
  assert.deepEqual((await view(ticked)).others, ['alpha']);
  assert.equal((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', lead: true, others: ['nobody'] })).status, 400);
  assert.equal((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', lead: true, others: ['sub'] })).status, 400, 'not its own provider');
  assert.deepEqual((await view((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', lead: false, others: ['alpha'] })).json.id)).others, [], 'off with Lead off');
  assert.deepEqual((await d.owner('POST', `/api/chats/${ticked}/settings`, { others: ['alpha', 'beta'] })).json.others, ['alpha', 'beta']);
  assert.equal((await d.owner('POST', `/api/chats/${ticked}/settings`, { others: ['zzz'] })).status, 400);
  assert.deepEqual((await view(plain)).others, [], 'none unless ticked');
  // Settings' ticks for new chats: a saved choice wins over them.
  assert.equal((await d.owner('POST', '/api/settings', { sessionDefaults: { lead: true, others: ['beta'] } })).status, 200);
  assert.deepEqual((await view((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', lead: true })).json.id)).others, ['beta'], 'the default');
  assert.deepEqual((await view((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', lead: true, others: [] })).json.id)).others, [], 'a choice wins');
  // A start the owner does not make himself (Tia with her switch off, a schedule, Do it: defaults: true) never takes
  // Settings' Lead or its ticks; her switch on sends lead: true, and then it leads.
  for (const b of [{ defaults: true, byTia: true }, { defaults: true, byTia: true, lead: false }, { defaults: true }]) {
    const v = await view((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', ...b })).json.id);
    assert.deepEqual([v.lead, v.others], [false, []], JSON.stringify(b));
  }
  const hers = await view((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'sub', defaults: true, byTia: true, lead: true, others: ['alpha'] })).json.id);
  assert.deepEqual([hers.lead, hers.others], [true, ['alpha']]);

  // A restart: the switch is read back from the saved chats.
  await d.app.close();
  d = await dashboard(t, box, work);
  t.after(() => d.app.close());
  assert.equal((await view(fromDefault)).lead, true, 'survives a restart');
  assert.equal((await view(plain)).lead, true);
  assert.deepEqual((await view(ticked)).others, ['alpha', 'beta'], 'the ticks survive a restart');
  // Who did what: from Claude Code's records of the chat's conversation (none ran here: empty, never an error).
  const parts = await d.owner('GET', `/api/chats/${fromDefault}/parts`);
  assert.equal(parts.status, 200);
  assert.deepEqual(parts.json, { lead: null, parts: [], tiers: [], others: [] }, 'no helper ran and no part was handed to another provider');
  const rec = JSON.parse(fs.readFileSync(path.join(box.state, 'chats.json'), 'utf8'));
  assert.ok(!JSON.stringify(rec).includes('sk-ant-oat'), 'no key in the saved chats');
});

test('a start with the provider left as it is: Settings\' ticks never include the provider the server picks, and the folder\'s last Lead counts', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('leadpick');
  t.after(() => box.cleanup());
  const work = path.join(box.root, 'work');
  const shop = path.join(work, 'shop');
  const fresh = path.join(work, 'fresh');
  for (const x of [shop, fresh]) fs.mkdirSync(x, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { lead: true, others: ['alpha'] } });
  writeProfile('sub', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8243', ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });
  const d = await dashboard(t, box, work);
  t.after(() => d.app.close());
  const view = async (id) => (await d.owner('GET', `/api/chats/${id}`)).json;
  // The owner's last chat in the shop ran on alpha, Lead off.
  assert.equal((await d.owner('POST', '/api/chats', { dir: shop, profile: 'alpha', lead: false })).status, 200);
  // What a start there would take, left as it is: the folder's provider and its last Lead, not Settings'.
  assert.deepEqual((await d.owner('GET', `/api/chats/lead?dir=${encodeURIComponent(shop)}`)).json, { profile: 'alpha', lead: false, others: [] });
  assert.equal((await d.owner('GET', '/api/chats/lead?dir=/etc')).status, 400);
  // The sheet's Lead turned on with Settings' tick on alpha, the provider left as it is: alpha is the session's own.
  const r = await d.owner('POST', '/api/chats', { dir: shop, lead: true, others: ['alpha'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await view(r.json.id);
  assert.deepEqual([v.profile && (v.profile.name || v.profile), v.lead, v.others], ['alpha', true, []]);
  // A folder never worked in: Settings' Lead, with its ticks less the provider the server picks.
  const there = (await d.owner('GET', `/api/chats/lead?dir=${encodeURIComponent(fresh)}&profile=sub`)).json;
  assert.deepEqual(there, { profile: 'sub', lead: true, others: ['alpha'] });
  // Chosen by name, the own provider is still no other provider.
  assert.equal((await d.owner('POST', '/api/chats', { dir: fresh, profile: 'alpha', lead: true, others: ['alpha'] })).status, 400);
});
