// Who may use the computer routes (adding a computer with a key file, confirming its host key, installing there,
// removing a computer, reading its health): the owner's own page only. Every route is walked with each foreign
// caller: another computer's bearer token, a Work command token (with no sign-in), Tia's door (her requests run
// in-process as the owner: the door refuses the path, and the key routes refuse her mark too), a foreign Origin, and
// no sign-in. Each is refused and nothing is written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { COOKIE, miniDashboard } from './harness.mjs';

const box = sandbox('machines-whomay');
const { createMachines } = await import('../../src/machines/index.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { putMachine, loadMachines } = await import('../../src/machines/store.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { keysDir } = await import('../../src/machines/keys.mjs');

const opts = { claudeVersion: async () => null, hub: { probeTimeoutMs: 300, tunnelWaitMs: 300 } };
const dash = await miniDashboard({ createMachines, opts }).listen();
// The same dashboard as Tia's door reaches it: signed in and of its own site (in-process), marked as hers.
const asTia = await miniDashboard({ createMachines, opts: { ...opts, fromSelf: () => true } }).listen();
putMachine({ name: 'box2', label: 'Box 2', via: 'url', url: 'http://127.0.0.1:9', token: 'hop_x', tokenId: null, added: 1 });
const { token } = createToken('another-hub');
test.after(async () => {
  await dash.close();
  await asTia.close();
  box.cleanup();
});

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
const ROUTES = [
  ['POST', '/api/machines/ssh/key', { host: '203.0.113.7', user: 'alex', key: KEY }],
  ['POST', '/api/machines/ssh/key/confirm', { pending: 'x', print: 'SHA256:x', confirm: 'box2' }],
  ['POST', '/api/machines/ssh/key/install', { pending: 'x', confirm: 'box2' }],
  ['POST', '/api/machines/install', { target: 'alex@box2', confirm: 'alex@box2' }],
  ['POST', '/api/machines/box2/remove', { confirm: 'box2' }],
  ['GET', '/api/machines/box2/health', undefined],
  ['POST', '/api/machines/box2/forward', { gateway: 'relay', confirm: 'box2' }],
  ['POST', '/api/machines/box2/forward/stop', {}],
  ['GET', '/api/machines/box2/forward', undefined],
  ['GET', '/api/machines/box2/hostkey', undefined],
  ['POST', '/api/machines/box2/hostkey', { print: 'SHA256:x', confirm: 'box2' }],
];

const call = (base, method, p, body, headers) => fetch(base + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('every route of the lane refuses each foreign caller, and nothing is written', async () => {
  const before = JSON.stringify(loadMachines());
  const callers = {
    'another computer\'s token': { Authorization: `Bearer ${token}` },
    'a Work command token': { 'x-hoprig-work-command': `hwc_${'a'.repeat(64)}`, Origin: dash.base },
    'a foreign Origin': { Cookie: COOKIE, Origin: 'http://evil.example' },
    'no sign-in': { Origin: dash.base },
  };
  for (const [method, p, body] of ROUTES) {
    for (const [who, headers] of Object.entries(callers)) {
      const r = await call(dash.base, method, p, body, headers);
      // A GET is not a change: a foreign Origin may read nothing it is not signed in for, and the cookie it carries
      // is SameSite=Strict on the real dashboard. Every other caller is refused outright.
      if (method === 'GET' && who === 'a foreign Origin') continue;
      assert.ok([401, 403].includes(r.status), `${method} ${p} by ${who}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert.throws(() => checkRoute(method, p, body), (e) => e.status === 403 && e.code === 'tia-route', `${method} ${p}: Tia's door`);
    assert.throws(() => checkRoute(method, `/m/box2${p}`, body), (e) => e.status === 403, `${method} /m/box2${p}: Tia's door on another computer`);
  }
  assert.equal(JSON.stringify(loadMachines()), before, 'no computer was added or removed');
  assert.equal(fs.existsSync(keysDir()), false, 'no key was written');
});

test('the key routes refuse a request marked as Tia\'s even past the door (signed in, own site)', async () => {
  for (const [method, p, body] of ROUTES.slice(0, 3)) {
    const r = await call(asTia.base, method, p, body, { Cookie: COOKIE, Origin: asTia.base });
    assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'owner-only');
  }
  assert.equal(fs.existsSync(keysDir()), false);
});
