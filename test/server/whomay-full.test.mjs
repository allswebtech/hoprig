// Who may use the computer and gateway routes that live outside the machines feature, on a full dashboard (createServer) over real
// HTTP: Health's gateway presses, its Fix, the old add-on routes, a forward, a host key. Each is walked with every
// caller that is not the owner's own page: no sign-in, a Work command header with no sign-in, the sign-in with a
// Work header but no Origin, a foreign Origin, and the owner's page without the confirmation that names the
// computer. Each is refused before anything runs. (A hub that controls this computer reaches Health's routes with
// its token by design: that is the owner's page on the hub, relayed; the hub's own routes refuse a token, which
// test/machines/whomay.test.mjs walks.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('whomay-full');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
let ran = 0;
const relay = { id: 'relay', title: 'Relay', defined: true, command: () => ['/bin/false'], gateway: { port: () => 9 }, status: async () => ({ installed: true, running: false }), start: async () => ((ran += 1), { ok: true }), stop: async () => ((ran += 1), { ok: true }) };
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, gatewayhost: { addons: () => [relay], computer: () => 'box2', run: async (argv) => (/show-user|is-active/.test(argv.join(' ')) ? null : (ran += 1), { ok: true, stdout: '', stderr: '' }) } });
const { port } = await app.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${port}`;
test.after(async () => {
  await app.close();
  box.cleanup();
});

const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
const WORK = { 'x-hoprig-work-command': `hwc_${'a'.repeat(64)}` };
const ROUTES = [
  ['POST', '/api/gatewayhost/relay/start', { confirm: 'box2' }],
  ['POST', '/api/gatewayhost/relay/stop', { confirm: 'box2' }],
  ['POST', '/api/gatewayhost/relay/service', { confirm: 'box2', on: true }],
  ['POST', '/api/gatewayhost/linger', { confirm: 'box2' }],
  ['POST', '/api/pcsetup/fix', { id: 'git.git' }],
  ['POST', '/api/addons/relay/start', {}],
  ['POST', '/api/addons/relay/install', {}],
  ['POST', '/api/machines/box2/forward', { gateway: 'relay', confirm: 'box2' }],
  ['POST', '/api/machines/box2/hostkey', { print: 'SHA256:x', confirm: 'box2' }],
];
const call = (method, p, body, headers) => fetch(origin + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.status);

test('signed in on the owner\'s page: the cookie works here', async () => {
  assert.match(cookie, /^sid=/);
  assert.equal((await fetch(`${origin}/api/gatewayhost`, { headers: { Cookie: cookie } })).status, 200);
});

test('every lane route refuses each caller that is not the owner\'s own page, and nothing runs', async () => {
  const callers = {
    'no sign-in': { Origin: origin },
    'a Work command header, no sign-in': { ...WORK, Origin: origin },
    'the sign-in with a Work header and no Origin': { ...WORK, Cookie: cookie },
    'the sign-in and no Origin': { Cookie: cookie },
    'a foreign Origin': { Cookie: cookie, Origin: 'http://evil.example' },
  };
  for (const [method, p, body] of ROUTES) {
    for (const [who, headers] of Object.entries(callers)) {
      const st = await call(method, p, body, headers);
      assert.ok([401, 403].includes(st), `${method} ${p} by ${who}: ${st}`);
    }
  }
  assert.equal(ran, 0, 'nothing ran');
});

test('the owner\'s page without the confirmation that names this computer changes nothing', async () => {
  for (const [p, body] of [['/api/gatewayhost/relay/start', {}], ['/api/gatewayhost/relay/start', { confirm: 'box3' }], ['/api/gatewayhost/relay/service', { on: true }], ['/api/gatewayhost/linger', { confirm: 'BOX2' }]]) {
    assert.equal(await call('POST', p, body, { Cookie: cookie, Origin: origin }), 400, `${p} ${JSON.stringify(body)}`);
  }
  assert.equal(ran, 0);
  // Twice at once with the confirmation: one press runs, the second is told it is busy (gatewayhost.test.mjs).
});
