// A line-ready session (Health's "Open a terminal with this line", POST /api/health/line) on a whole dashboard: the
// line stands typed and nothing but the owner's own page types there. A text or a key for the coding tool (the queue,
// the continue prompt, Tia's send_to_session, Hands-off: deck.sendToTool / keyToTool) is refused; `owner: true` from
// another computer's token is refused too; the owner's own page here types as before. A stand-in terminal backend
// records every byte: no shell runs, and the line is a made-up program's (test/fixtures/healthline-checks.json).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { sandbox } from './helpers.mjs';

const box = sandbox('lineready');
const CHECKS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'healthline-checks.json'), 'utf8'));
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { defaultHubLabel } = await import('../../src/machines/hub.mjs');
const { relayUpgrade } = await import('../../src/machines/relay.mjs');
saveConfig({ server: { passwordHash: await hashPassword('right-password') } });

const terms = new Map();
const typed = [];
let n = 0;
const backend = {
  kind: 'pty',
  capabilities: {},
  list: async () => [...terms.values()],
  create: async ({ name, dir, argv }) => {
    const id = `pty-made-up-${++n}`;
    terms.set(name, { session: name, id, sid: id, pid: 0, cwd: dir, command: argv ? 'node' : 'bash', created: Date.now(), attached: 0, activity: Date.now(), argv });
    return { name, id };
  },
  sendText: async (id, text) => void typed.push({ id, text }),
  sendKey: async (id, key) => void typed.push({ id, key }),
  capture: async () => '',
  kill: async (name) => void terms.delete(name),
  // A terminal over /ws/term: every byte its socket sends is recorded, nothing runs.
  attach: (name) => ({
    onData: () => {},
    onExit: () => {},
    write: (d) => void typed.push({ ws: name, data: String(d) }),
    resize: () => {},
    pause: () => {},
    resume: () => {},
    close: () => {},
  }),
};
const app = createServer({ backend, watch: false, health: { parts: { checks: async () => CHECKS, plans: async () => ({}) } } });
const { port } = await app.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${port}`;
test.after(async () => {
  await app.close();
  box.cleanup();
});
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
const { token } = createToken('hub', { hub: true });
const PAGE = { Cookie: cookie, Origin: origin };
const TOKEN = { Authorization: `Bearer ${token}` };
const OWNER_PAGE_RELAYED = { ...TOKEN, 'x-hoprig-owner-page': '1' };
const post = async (p, body, headers) => {
  const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test('the session holds the line, no Enter; then only the owner\'s own page types there', async () => {
  const r = await post('/api/health/line', { id: 'made-up.admin', confirm: defaultHubLabel() }, PAGE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const name = r.json.session;
  const t = terms.get(name);
  assert.ok(t && !t.argv, 'a new plain terminal');
  assert.deepEqual(typed, [{ id: t.id, text: 'sudo made-up-admin-tool --fix' }], 'the line, and no Enter');

  const refused = [
    ['send for the coding tool, from the page', `/api/sessions/${name}/send`, { text: 'made-up words' }, PAGE],
    ['send for the coding tool, from a token', `/api/sessions/${name}/send`, { text: 'made-up words' }, TOKEN],
    ['the owner\'s keys, from a token', `/api/sessions/${name}/send`, { text: 'made-up words', owner: true }, TOKEN],
    ['the owner\'s keys, from a hub\'s page relayed', `/api/sessions/${name}/send`, { text: 'made-up words', owner: true }, OWNER_PAGE_RELAYED],
    ['Enter for the coding tool, from the page', `/api/sessions/${name}/key`, { key: 'Enter' }, PAGE],
    ['Enter for the coding tool, from a token', `/api/sessions/${name}/key`, { key: 'Enter' }, TOKEN],
    ['Enter as the owner\'s key, from a token', `/api/sessions/${name}/key`, { key: 'Enter', owner: true }, TOKEN],
    ['Enter as the owner\'s key, from a hub\'s page relayed', `/api/sessions/${name}/key`, { key: 'Enter', owner: true }, OWNER_PAGE_RELAYED],
  ];
  for (const [who, p, body, headers] of refused) {
    const x = await post(p, body, headers);
    assert.equal(x.status, 409, `${who}: ${JSON.stringify(x.json)}`);
    assert.match(x.json.error, /holds a line for you to run yourself/, who);
  }
  assert.equal(typed.length, 1, 'nothing more was typed');

  // His own page, his own keys: as for any session.
  assert.equal((await post(`/api/sessions/${name}/key`, { key: 'Enter', owner: true }, PAGE)).status, 200);
  assert.deepEqual(typed.at(-1), { id: t.id, key: 'Enter' });
});

/** Opens `url` with `headers`, sends `frames`; resolves 'open' or the refusal's status. */
function wsType(url, headers, frames) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      for (const f of frames) ws.send(JSON.stringify(f));
      setTimeout(() => {
        ws.close();
        resolve('open');
      }, 200);
    });
    ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
    ws.on('error', (e) => resolve(`error ${e.message}`));
  });
}

test('the terminal over /ws/term: a token types there only for a hub\'s own page, relayed with its mark', async () => {
  const name = [...terms.values()][0].session;
  const url = `ws://127.0.0.1:${port}/ws/term?name=${encodeURIComponent(name)}&cols=80&rows=24`;
  const before = typed.length;
  const script = createToken('made-up-script').token;
  const refused = [
    ['a paired script\'s token', { Authorization: `Bearer ${script}` }],
    ['a paired script\'s token with a mark it set itself', { Authorization: `Bearer ${script}`, 'x-hoprig-owner-page': '1' }],
    ['a hub\'s token without the page\'s mark', TOKEN],
    ['Tia through a hub', { ...OWNER_PAGE_RELAYED, 'x-hoprig-self': '1' }],
  ];
  for (const [who, headers] of refused) assert.equal(await wsType(url, headers, [{ t: 'in', d: '\r' }]), 409, who);
  assert.equal(typed.length, before, 'no byte reached the session');

  // His own page here, and his hub's page through the hub's relay (src/machines/relay.mjs adds the mark): as before.
  assert.equal(await wsType(url, PAGE, [{ t: 'in', d: 'a' }]), 'open');
  const hubServer = http.createServer();
  hubServer.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, { protocol: 'http:', hostname: '127.0.0.1', port }, { machine: 'made-up', path: `/ws/term?name=${encodeURIComponent(name)}`, token }));
  await new Promise((r) => hubServer.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await wsType(`ws://127.0.0.1:${hubServer.address().port}/`, {}, [{ t: 'in', d: 'b' }]), 'open');
  } finally {
    hubServer.close();
  }
  assert.deepEqual(typed.slice(before), [{ ws: name, data: 'a' }, { ws: name, data: 'b' }]);
});

test('the mark is kept in the state folder, so a dashboard started again still refuses', async () => {
  const file = path.join(process.env.HOPRIG_STATE_DIR || box.state, 'line-ready.json');
  const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = [...terms.values()][0];
  assert.ok(ids.includes(`${t.id}@${t.created}`), JSON.stringify(ids));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
});
