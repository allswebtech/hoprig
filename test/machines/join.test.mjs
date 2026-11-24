// `hoprig join` with the fake ssh: the joining computer dials out, the reverse forward really forwards, the hub
// reaches it on its own 127.0.0.1:<port>; reconnecting reuses the port; leaving and removing work from either side;
// the token travels only on stdin; a port the hub's sshd opens to the network is refused.
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { saveConfig } from '../../src/config.mjs';
import { sandbox } from '../server/helpers.mjs';
import { REPO, asBrowser, fakeRemote, miniDashboard } from './harness.mjs';

const box = sandbox('machines-join');
const skip = process.platform === 'win32' && 'POSIX scripts';
const { createMachines } = await import('../../src/machines/index.mjs');
const join = await import('../../src/machines/join.mjs');
const { loadMachines } = await import('../../src/machines/store.mjs');
const { storedTokens } = await import('../../src/machines/tokens.mjs');
const { reverseArgs, sshFailure } = await import('../../src/machines/ssh.mjs');

// The "hub" runs this repo's hoprig through the fake ssh (only in the login shell, like nvm); same folders here.
const ssh = fakeRemote(path.join(box.root, 'ssh'), { script: `exec "${process.execPath}" "${path.join(REPO, 'bin', 'hoprig.mjs')}" "$@"` });
const fast = { claudeVersion: async () => null, relayIdleMs: 2000, hub: { probeTimeoutMs: 1500, hubName: 'the-hub' } };
// The computer that joins, and the hub's own dashboard (which shows it).
const me = await miniDashboard({ createMachines, opts: { ...fast, join: { ssh: { env: ssh.sshEnv }, settleMs: 300, syncMs: 200 } }, sessions: [{ name: 'home-session' }] }).listen();
const hub = await miniDashboard({ createMachines, opts: fast, sessions: [{ name: 'hub-session' }] }).listen();
saveConfig({ server: { host: '127.0.0.1', port: me.port, machineLabel: 'Home PC' } }); // where "this computer's dashboard" listens
const keeper = me.machines.joins;
keeper.start();
const browser = asBrowser(hub.base);
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};
const joinedOnHub = () => loadMachines().find((m) => m.via === 'join');
const hubState = async (name) => ((await browser('/api/machines?fresh=1')).json.machines.find((m) => m.name === name) || {}).state;

test.after(async () => {
  keeper.close();
  await me.close();
  await hub.close();
  box.cleanup();
});

test('arguments: a reverse forward bound to the hub\'s 127.0.0.1, forward failure fatal, -- before the target', () => {
  const a = reverseArgs({ target: 'alex@server', hubPort: 41234, localPort: 7433 });
  assert.deepEqual(a.slice(-5), ['-N', '-R', '127.0.0.1:41234:127.0.0.1:7433', '--', 'alex@server']);
  assert.ok(a.includes('ExitOnForwardFailure=yes') && a.includes('BatchMode=yes') && a.includes('ServerAliveInterval=15'));
  assert.equal(sshFailure('srv', 'Warning: remote port forwarding failed for listen port 41234').code, 'ssh-forward');
});

test('join: reserve, tunnel, confirm; the hub reaches this computer; the token only on stdin', { skip }, async () => {
  const h = await join.joinHub('alex@server', { keeper, ssh: { env: ssh.sshEnv } });
  assert.match(h.id, /^[0-9a-f]{12}$/);
  const m = joinedOnHub();
  assert.equal(m.port, h.port);
  assert.equal(m.joinId, h.id);
  assert.equal(m.label, 'Home PC');
  assert.equal(h.name, m.name);
  // The hub's page relays to it through its own 127.0.0.1:<port>.
  assert.deepEqual((await browser(`/m/${m.name}/api/state`)).json.sessions, [{ name: 'home-session' }]);
  assert.equal(await hubState(m.name), 'online');
  // How it was done over SSH: accept requests through the login shell, the request on stdin, never the token in argv.
  const calls = ssh.calls();
  assert.ok(calls.some((c) => c.at(-1) === `$SHELL -lic 'hoprig machines accept --json'`), 'fell back to the login shell');
  assert.ok(calls.some((c) => c.includes('-R') && c.includes(`127.0.0.1:${h.port}:127.0.0.1:${me.port}`) && c.includes('ExitOnForwardFailure=yes')));
  for (const c of calls) assert.equal(JSON.stringify(c).includes('hop_'), false, 'no token on any command line');
  // Control goes one way: the joining computer got nothing for the hub.
  assert.equal(join.loadJoined().length, 1);
  assert.equal(JSON.stringify(join.loadJoined()).includes('hop_'), false);
  // Its page lists the connection.
  const mine = (await asBrowser(me.base)('/api/joins')).json.joined;
  assert.equal(mine[0].state, 'up');
  assert.ok(mine[0].upSince > 0);
});

test('the tunnel drops: the hub shows it offline, then online again by itself, on the same port', { skip }, async () => {
  const h = join.loadJoined()[0];
  const before = ssh.calls().filter((c) => c.includes('-R')).length;
  keeper.map.get(h.id).tunnel.child.kill('SIGKILL');
  await until('offline on the hub', async () => (await hubState(joinedOnHub().name)) === 'offline');
  await until('online again', async () => (await hubState(joinedOnHub().name)) === 'online');
  const r = ssh.calls().filter((c) => c.includes('-R'));
  assert.ok(r.length > before);
  assert.ok(r.at(-1).includes(`127.0.0.1:${h.port}:127.0.0.1:${me.port}`), 'the same port on the hub');
});

test('joining the same hub again keeps the registration and the port; the old token is revoked', { skip }, async () => {
  const h1 = join.loadJoined()[0];
  const h2 = await join.joinHub('alex@server', { keeper, ssh: { env: ssh.sshEnv } });
  assert.equal(h2.id, h1.id);
  assert.equal(h2.port, h1.port);
  assert.notEqual(h2.tokenId, h1.tokenId);
  assert.equal(storedTokens().some((t) => t.id === h1.tokenId), false);
  assert.equal(loadMachines().filter((m) => m.via === 'join').length, 1);
  assert.equal((await browser(`/m/${joinedOnHub().name}/api/state`)).status, 200, 'the new token works');
});

test('leave from this computer: the hub forgets it, the token is revoked, the tunnel closes', { skip }, async () => {
  const h = join.loadJoined()[0];
  const r = await join.leaveHub('alex@server', { keeper, ssh: { env: ssh.sshEnv } });
  assert.deepEqual(r, { left: true, hub: h.hubLabel, hubForgot: true });
  assert.equal(joinedOnHub(), undefined);
  assert.deepEqual(join.loadJoined(), []);
  assert.equal(storedTokens().some((t) => t.id === h.tokenId), false);
  assert.equal(keeper.map.size, 0);
  await until('the port is free on the hub', () => new Promise((resolve) => {
    const s = net.connect(h.port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), resolve(false)));
    s.on('error', () => resolve(true));
  }));
});

test('Remove on the hub: this computer notices its token is gone and stops connecting', { skip }, async () => {
  const h = await join.joinHub('alex@server', { keeper, ssh: { env: ssh.sshEnv } });
  const name = joinedOnHub().name;
  const rm = await browser(`/api/machines/${name}/remove`, { body: { confirm: name } });
  assert.equal(rm.json.revoked, true);
  assert.match(rm.json.note, /stops connecting by itself/);
  await until('forgotten here', async () => join.loadJoined().length === 0 && !keeper.map.has(h.id));
});

test('the joining side refuses when its own dashboard is not running; the hub CLI answers bad requests', { skip }, async () => {
  saveConfig({ server: { port: 1 } });
  await assert.rejects(join.joinHub('alex@server', { keeper, ssh: { env: ssh.sshEnv } }), (e) => e.code === 'not-running');
  saveConfig({ server: { port: me.port } });
  assert.equal((await join.accept('not json')).code, 'bad-request');
  assert.equal((await join.accept('{"step":"confirm","id":"0123456789ab","token":"hop_x"}')).code, 'bad-request');
  assert.equal((await join.accept(`{"step":"confirm","id":"0123456789ab","token":"hop_${'A'.repeat(43)}"}`)).code, 'expired');
  assert.equal((await browser('/api/joins', { body: { target: '-oProxyCommand=x' } })).status, 400);
});

test('a reverse port that answers on the network is refused (sshd GatewayPorts yes)', { skip }, async () => {
  // The check itself: a socket on every address is found, one on 127.0.0.1 is not.
  const addrs = join.networkAddresses();
  const open = net.createServer().listen(0, '0.0.0.0');
  const closed = net.createServer().listen(0, '127.0.0.1');
  await Promise.all([open, closed].map((s) => new Promise((r) => s.on('listening', r))));
  if (addrs.length) assert.ok(await join.exposedOnNetwork(open.address().port), 'found on a network address');
  assert.equal(await join.exposedOnNetwork(closed.address().port), null);
  open.close();
  closed.close();
  // The whole join with the fake sshd binding like GatewayPorts yes.
  const gw = fakeRemote(path.join(box.root, 'ssh-gw'), { mode: 'gateway-yes', script: `exec "${process.execPath}" "${path.join(REPO, 'bin', 'hoprig.mjs')}" "$@"` });
  const k = new join.JoinKeeper({ ssh: { env: gw.sshEnv }, settleMs: 300 });
  try {
    if (!addrs.length) return; // no network address on this machine: nothing can be exposed
    await assert.rejects(join.joinHub('alex@server', { keeper: k, ssh: { env: gw.sshEnv } }), (e) => e.code === 'exposed' && /GatewayPorts/.test(e.message));
    assert.equal(joinedOnHub(), undefined, 'not stored');
    assert.deepEqual(join.loadJoined(), []);
    assert.equal(k.map.size, 0, 'tunnel closed');
  } finally {
    k.close();
  }
});

test('a port the hub cannot give: the tunnel fails with sshd\'s reason', { skip }, async () => {
  const taken = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => taken.on('listening', r));
  // A tunnel counts as up when ssh is still running after settleMs. The stand-in ssh is a Node program: on a busy
  // computer it needs more than the 300 ms of the other tests to start and be refused the port, and the tunnel
  // was taken for up. The refusal ends the wait at once, so the long settle time costs nothing when it comes.
  const k = new join.JoinKeeper({ ssh: { env: ssh.sshEnv }, settleMs: 10_000 });
  try {
    const t = k.tunnelFor({ id: 'aaaaaaaaaaaa', target: 'srv', port: taken.address().port });
    await assert.rejects(t.ensure(20_000), /remote port forwarding failed/);
  } finally {
    k.close();
    taken.close();
  }
});
