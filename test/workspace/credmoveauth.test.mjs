// Who may call each leg of the encrypted move of credentials (credweb.mjs, over real HTTP on a temporary home): his own
// page, here or through a main computer of his that sets the page's mark; never Tia's token, a script's or a pairing
// token, a hub's token without the page's mark, a session's or Tia's in-process call, a linked computer's token, or
// another site. Each is tried on each leg, and nothing of the move happens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropWorld } from './dropfix.mjs';

const w = await dropWorld('credmoveauth', { labels: ['desk'] });
const [D] = w.computers;
D.use();
process.env.HOPRIG_WORKSPACE_DIR = D.ws; // a workspace of its own: never the real one
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { OWNER_PAGE_HEADER, SELF_HEADER } = await import('../../src/machines/relay.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [D.home], backend: 'pty' } });
const script = createToken('a script');
const hub = createToken('hub');
const stranger = createToken('stranger');
fs.writeFileSync(path.join(D.env.HOPRIG_CONFIG_DIR, 'joined.json'), JSON.stringify({ hubs: [{ id: '0123456789ab', target: 'alex@box2', port: 7433, tokenId: hub.id }] }));
const traps = path.join(w.root, 'traps');
fs.mkdirSync(traps, { recursive: true });
const trapped = path.join(w.root, 'trapped.log');
for (const n of ['ssh', 'sudo', 'systemctl', 'loginctl', 'npm', 'apt-get']) fs.writeFileSync(path.join(traps, n), `#!/bin/sh\necho "${n} $*" >> '${trapped}'\nexit 99\n`, { mode: 0o755 });
process.env.PATH = `${traps}${path.delimiter}${process.env.PATH}`;
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `credmoveauth-${process.pid}` });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const { port } = app.server.address();
saveConfig({ server: { port } });
const origin = `http://127.0.0.1:${port}`;
test.after(async () => {
  await new Promise((r) => app.server.close(r));
  assert.equal(fs.existsSync(trapped) ? fs.readFileSync(trapped, 'utf8') : '', '', 'no trapped program was started');
  w.cleanup();
});
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const page = { Cookie: cookie, Origin: origin };
const bearer = (t, extra = {}) => ({ Authorization: `Bearer ${t}`, ...extra });
const MOVE = '/api/workspace/credmove';
const LEGS = [
  ['GET', MOVE, undefined],
  ['POST', `${MOVE}/expect`, {}],
  ['POST', `${MOVE}/pack`, { to: 'other', nonce: 'a'.repeat(32), project: 'shop' }],
  ['POST', `${MOVE}/upload?dryRun=1`, 'raw'],
  ['POST', `${MOVE}/trust`, { label: 'other' }],
  ['POST', `${MOVE}/own`, { own: false }],
  ['POST', `${MOVE}/mark`, { machine: 'nobody', own: false }],
];
async function send([method, p, body], headers) {
  const raw = body === 'raw';
  const r = await fetch(origin + p, { method, headers: { ...(method === 'POST' ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...headers }, body: method === 'POST' ? (raw ? Buffer.from('{}') : JSON.stringify(body)) : undefined });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* no body */
  }
  return { status: r.status, json };
}
const state = () => `${fs.existsSync(path.join(D.env.HOPRIG_STATE_DIR, 'transfer-keys.json'))}|${fs.existsSync(path.join(D.env.HOPRIG_STATE_DIR, 'credmove-nonces.json'))}|${fs.existsSync(path.join(D.env.HOPRIG_STATE_DIR, 'transfer-pins.json'))}`;

test('each leg is refused to every caller that is not his own page, and nothing happens', async () => {
  const before = state();
  const callers = [
    ['Tia\'s token', bearer('tia_0123456789abcdef0123456789abcdef', { [OWNER_PAGE_HEADER]: '1' })],
    ['a script or pairing token, even with the mark', bearer(script.token, { [OWNER_PAGE_HEADER]: '1' })],
    ['a token of a computer that is not a hub of his', bearer(stranger.token, { [OWNER_PAGE_HEADER]: '1' })],
    ['a hub without the page\'s mark', bearer(hub.token)],
    ['a hub with Tia\'s mark', bearer(hub.token, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' })],
    ['his page from another site', { Cookie: cookie, Origin: 'http://evil.example' }],
  ];
  for (const leg of LEGS) {
    for (const [who, headers] of callers) {
      const r = await send(leg, headers);
      if (leg[0] === 'GET' && /another site/.test(who)) assert.ok([200, 401, 403].includes(r.status), `${who} ${leg[1]} ${r.status}`); // a read from the page's own cookie is still the page
      else assert.ok(r.status === 401 || r.status === 403, `${who}: ${leg[0]} ${leg[1]} gave ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert.ok([401, 403].includes((await send(leg, {})).status), `${leg[1]}: nobody logged in`);
  }
  assert.equal(state(), before, 'no key, nonce or pin was made by a refused call');
});

test('Tia\'s door never reaches a leg, here or on another computer', () => {
  for (const [m, p] of LEGS.map(([m, p]) => [m, p.split('?')[0]])) {
    for (const url of [p, `/m/box2${p}`]) assert.throws(() => checkRoute(m, url, {}, { config: () => ({}), settingsOf: () => null }), (e) => e.status === 403, `${m} ${url}`);
  }
});

test('a session\'s or Tia\'s in-process call is refused on each leg', async () => {
  const f = workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: (req) => req.by }, { dir: D.ws, projectsDir: () => D.projects });
  for (const [method, p, body] of LEGS) {
    const route = f.routes.find(([m, re]) => m === method && re.test(p.split('?')[0]));
    for (const by of ['self', 'computer']) {
      await assert.rejects(route[2]({ by, headers: by === 'computer' ? {} : { [OWNER_PAGE_HEADER]: '1' }, body: body === 'raw' ? undefined : body }, null, new URLSearchParams()), (e) => e.status === 403, `${by} ${p}`);
    }
  }
});

test('his own page, here or through a main computer of his that sets its mark, may read and ask for a nonce', async () => {
  const mine = await send(LEGS[0], page);
  assert.equal(mine.status, 200, JSON.stringify(mine));
  assert.equal(mine.json.label, 'desk');
  assert.equal(mine.json.keys, false, 'reading makes no key');
  const viaHub = await send(LEGS[1], bearer(hub.token, { [OWNER_PAGE_HEADER]: '1', 'Content-Type': 'application/json' }));
  assert.equal(viaHub.status, 200, JSON.stringify(viaHub));
  assert.match(viaHub.json.nonce, /^[0-9a-f]{32}$/);
  assert.equal(viaHub.json.label, 'desk');
  assert.deepEqual(Object.keys(viaHub.json.keys).sort(), ['ed25519', 'x25519']);
  assert.equal(JSON.stringify(viaHub.json).includes('priv'), false, 'no private key leaves');
  assert.equal((await send(LEGS[0], page)).json.keys, true, 'a computer asked to receive has made its keys');
});
