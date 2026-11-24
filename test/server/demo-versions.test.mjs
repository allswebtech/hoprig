// The demo's Health and its Computers page name the same Claude Code version (one made-up source, never what this
// computer has installed), and Health's service line names the service of the computer the demo runs on: a
// LaunchAgent on macOS, a systemd user service on Linux, a scheduled task on Windows.
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

const SERVICE = {
  darwin: 'installed (LaunchAgent, starts with your login)',
  linux: 'installed (systemd user service, starts with your login)',
  win32: 'installed (scheduled task, starts with your login)',
};

test('demo: Health names the Claude Code version the Computers page names, and the service of this kind of computer', { timeout: 120_000, skip: process.platform === 'win32' && 'the demo sessions run through a POSIX shell' }, async () => {
  sandbox('demo-versions');
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

    const health = await get('/api/health');
    const machines = await get('/api/machines');
    assert.ok(machines.self && machines.self.claude, JSON.stringify(machines).slice(0, 400));
    assert.equal(health.versions.claude, machines.self.claude, 'Health and Computers name the same Claude Code version');
    const check = health.checks.find((c) => c.id === 'claude.code');
    if (check) assert.equal(check.detail, machines.self.claude, 'the Claude Code check names that version too');

    const want = SERVICE[process.platform];
    if (want) {
      assert.equal(health.service.detail, want, JSON.stringify(health.service));
      assert.equal(health.checks.find((c) => c.id === 'service').detail, want);
    }
  } finally {
    await hooks.stop?.();
  }
});
