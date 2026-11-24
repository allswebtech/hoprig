// The demo shows made-up figures and pretend services only: the quick actions it offers, the computer's figures in the
// Operator's Computers part and in Health, the gateway's port, and Tia answering a first message.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

// Every connection this process opens is seen here. One to the shipped gateway's port is sent to a closed port
// instead, so the test itself never knocks on a gateway the person may run on this computer.
const { SHIPPED } = await import('../../src/addons/gateways.mjs');
const shippedPort = SHIPPED[0].port;
const closedPort = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const knocked = [];
const connect = net.connect;
net.connect = function (...a) {
  const o = a[0] && typeof a[0] === 'object' ? a[0] : null;
  const port = Number(o ? o.port : a[0]);
  knocked.push(port);
  if (port === shippedPort) return connect.call(this, { ...o, host: '127.0.0.1', port: closedPort }, ...a.slice(1));
  return connect.apply(this, a);
};
test.after(() => { net.connect = connect; });

test('demo: plain quick actions, the made-up computer\'s figures, its own gateway port, and Tia answers', { timeout: 120_000, skip: process.platform === 'win32' && 'the demo sessions run through a POSIX shell' }, async () => {
  sandbox('demo-madeup');
  const { main } = await import('../../src/demo/index.mjs');
  const hooks = { onReady: (i) => (hooks.info = i) };
  try {
    assert.equal(await main(['--no-open', '--quiet'], hooks), null);
    const { url, link } = hooks.info;
    const token = link.split('#link=')[1];
    const first = await fetch(`${url}/api/login/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ token }) });
    assert.equal(first.status, 200);
    const auth = { Cookie: first.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', Origin: url };
    const get = async (p) => (await fetch(`${url}${p}`, { headers: auth })).json();
    const post = async (p, body) => (await fetch(`${url}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json();

    // Two plain chips: what a person who is not a programmer presses. No slash commands of the coding tool.
    const state = await get('/api/state');
    assert.deepEqual(state.quickActions, [{ label: 'continue', text: 'continue' }, { label: 'run the tests', text: 'run the tests and fix what fails' }]);

    // Health and the Operator's Computers part read the made-up computer (10 processors, 16 GB), never this one.
    const health = await get('/api/health');
    assert.equal(health.cpus, 10, `Health shows the made-up computer's processors, not ${health.cpus}`);
    assert.deepEqual(health.load, [1.8, 1.5, 1.2]);
    assert.equal(health.memory.total, 16 * 1024 ** 3);
    const rooms = await get('/api/operator/rooms?look=1');
    const here = (rooms.computers || rooms.list || []).find((c) => c.here) || null;
    assert.ok(here, JSON.stringify(rooms).slice(0, 400));
    assert.equal(here.cpus, 10, `the Computers part shows the made-up computer's processors, not ${here.cpus}`);
    assert.equal(here.load1, 1.8);

    // The gateway page knows the pretend gateway on a port the demo picked, never the shipped gateway's own.
    const gw = await get('/api/gateways');
    assert.equal(gw.gateways.length, 1, JSON.stringify(gw));
    const port = Number(new URL(gw.gateways[0].address).port);
    assert.notEqual(port, shippedPort, 'not the shipped gateway\'s port');
    assert.equal(gw.gateways[0].running, false);
    const pretend = (await get('/api/addons')).addons.find((a) => a.id === gw.gateways[0].id);
    assert.ok(pretend, 'the add-on page lists the same pretend gateway');
    if (pretend.url) assert.equal(Number(new URL(pretend.url).port), port, 'the add-on page names the same port');
    // Health → Gateways lists the same pretend gateway, never the shipped one on its own port, and no service manager.
    const host = await get('/api/gatewayhost');
    assert.deepEqual(host.gateways.map((g) => [g.id, g.port, g.running]), [[gw.gateways[0].id, port, false]], JSON.stringify(host));
    assert.equal(host.gateways[0].service.kind, 'none');
    // Health's checks are the made-up computer's, not what this computer's doctor finds (its systemctl, gh, tmux).
    assert.deepEqual(health.checks.filter((c) => c.group === 'system').map((c) => c.label), ['macOS 15.4', 'Free disk space', 'Memory'], JSON.stringify(health.checks).slice(0, 600));
    assert.ok(!health.checks.some((c) => c.fixId), 'no Fix that would run the set-up for real');
    assert.ok(!knocked.includes(shippedPort), `nothing knocked on port ${shippedPort}`);

    // Tia answers his first message: a reply, no spending-cap notice.
    const { conversation } = await post('/api/assistant/chat', { text: 'What needs me?' });
    assert.ok(conversation);
    let evs = [];
    for (let i = 0; i < 120 && !evs.some((e) => e.kind === 'done'); i++) {
      evs = (await get(`/api/assistant/chat/${conversation}?from=0`)).events;
      if (!evs.some((e) => e.kind === 'done')) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(evs.some((e) => e.kind === 'text' && e.text.trim()), JSON.stringify(evs).slice(0, 800));
    assert.ok(!evs.some((e) => e.kind === 'notice'), `no notice: ${JSON.stringify(evs.filter((e) => e.kind === 'notice'))}`);
  } finally {
    await hooks.stop?.();
  }
});
