// The demo's Providers page and its question "who is signed in" (GET /api/accounts/claude-login/account) agree:
// the demo answers that question from its own made-up sign-in, never by starting a program, and a provider that uses
// Claude Code's stored sign-in shows the same state on both.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

// As in demo-madeup.test.mjs: a connection to the shipped gateway's port is sent to a closed port instead.
const { SHIPPED } = await import('../../src/addons/gateways.mjs');
const shippedPort = SHIPPED[0].port;
const closedPort = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const connect = net.connect;
net.connect = function (...a) {
  const o = a[0] && typeof a[0] === 'object' ? a[0] : null;
  const port = Number(o ? o.port : a[0]);
  if (port === shippedPort) return connect.call(this, { ...o, host: '127.0.0.1', port: closedPort }, ...a.slice(1));
  return connect.apply(this, a);
};
test.after(() => { net.connect = connect; });

async function demo(signin) {
  sandbox(`demo-signin-${signin || 'default'}`);
  if (signin) process.env.HOPRIG_TEST_SIGNIN = signin;
  else delete process.env.HOPRIG_TEST_SIGNIN;
  const { main } = await import('../../src/demo/index.mjs');
  const hooks = { onReady: (i) => (hooks.info = i) };
  assert.equal(await main(['--no-open', '--quiet'], hooks), null);
  const { url, link } = hooks.info;
  const token = link.split('#link=')[1];
  const first = await fetch(`${url}/api/login/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ token }) });
  assert.equal(first.status, 200);
  const auth = { Cookie: first.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', Origin: url };
  const get = async (p) => (await fetch(`${url}${p}`, { headers: auth })).json();
  const pro = async () => (await get('/api/accounts')).accounts.find((a) => a.name === 'pro');
  return { get, pro, stop: () => hooks.stop?.() };
}
const skip = process.platform === 'win32' && 'the demo sessions run through a POSIX shell';

test('demo: by default "Claude Pro" is not signed in, and the question who is signed in says the same', { timeout: 120_000, skip }, async () => {
  const d = await demo(null);
  try {
    const a = await d.pro();
    assert.deepEqual([a.kind, a.signedIn], ['login', false]);
    assert.deepEqual(await d.get('/api/accounts/claude-login/account?fresh=1'), { loggedIn: false, plan: null, email: null, org: null }, 'not "could not tell"');
  } finally {
    await d.stop();
  }
});

test('demo: signed in (HOPRIG_TEST_SIGNIN=in), Providers shows "Claude Pro" signed in and who is signed in', { timeout: 120_000, skip }, async () => {
  const d = await demo('in');
  try {
    const a = await d.pro();
    assert.deepEqual([a.kind, a.signedIn, a.plan], ['login', true, 'pro']);
    assert.deepEqual(await d.get('/api/accounts/claude-login/account?fresh=1'), { loggedIn: true, plan: 'pro', email: 'demo@example.invalid', org: 'Example' });
    // The other providers keep their own made-up states.
    const all = Object.fromEntries((await d.get('/api/accounts')).accounts.map((x) => [x.name, x.signedIn]));
    assert.deepEqual([all.max, all.team], [true, true]);
  } finally {
    await d.stop();
    delete process.env.HOPRIG_TEST_SIGNIN;
  }
});
