// Doctor's line about a gateway on a server that listens beyond this computer (src/setup/gatewaycheck.mjs): read from a
// made-up kernel table of sockets, for gateways Hoprig started (a pid file in its state folder) and only on a server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const G = await import('../../src/setup/gatewaycheck.mjs');

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
// Port 20001 is 4E21, 20002 is 4E22. 0100007F is 127.0.0.1, 00000000 every address, 0A listening, 01 a connection.
const row = (addr, port, st = '0A') => `   0: ${addr}:${port.toString(16).toUpperCase()} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 1 1\n`;
const TCP = (...rows) => HEAD + rows.join('');
const gw = (id, port, kept = true) => ({ id, title: `Gateway ${id}`, gateway: { port: () => port }, keptLocal: () => kept });
const SERVER = { kind: 'ssh' };

test('the kernel table: listening sockets, loopback or wider, IPv4 and IPv6', () => {
  const text = TCP(row('0100007F', 20001), row('00000000', 20002), row('0100007F', 20003, '01'), row('0200A8C0', 20004))
    + HEAD + row('00000000000000000000000001000000', 20005) + row('00000000000000000000000000000000', 20006) + row('0000000000000000FFFF00000100007F', 20007);
  assert.deepEqual(G.listeners(text), [
    { port: 20001, wide: false }, { port: 20002, wide: true }, { port: 20004, wide: true },
    { port: 20005, wide: false }, { port: 20006, wide: true }, { port: 20007, wide: false },
  ]);
  assert.deepEqual(G.listeners(''), []);
});

test('on a server, a gateway Hoprig started that listens on every address fails, with the restart as the fix', () => {
  const net = TCP(row('00000000', 20001), row('0100007F', 20002));
  const started = () => true;
  const r = G.gatewayChecks([gw('alpha', 20001), gw('beta', 20002)], { reason: SERVER, platform: 'linux', net, started });
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0].id, 'gateway-alpha');
  assert.equal(r[0].status, 'fail');
  assert.match(r[0].detail, /^listens on port 20001 beyond this computer, and this computer is a server: anyone who reaches it can use your providers through it \(plain http\)$/);
  assert.equal(r[0].fix, 'hoprig addons stop alpha && hoprig addons start alpha   (started again, it listens on this computer only)');
  // One whose definition cannot keep it here: the fix names the words to add first.
  const own = G.gatewayChecks([gw('shop', 20001, false)], { reason: SERVER, platform: 'linux', net, started });
  assert.match(own[0].fix, /^add "localOnly": \["--host", "127\.0\.0\.1"\] .* then: hoprig addons stop shop && hoprig addons start shop$/);
});

test('nothing is said off a server, off Linux, for a gateway Hoprig did not start, or for one on this computer only', () => {
  const net = TCP(row('00000000', 20001));
  const one = [gw('alpha', 20001)];
  assert.deepEqual(G.gatewayChecks(one, { reason: null, platform: 'linux', net, started: () => true }), [], 'a desktop at home: his open gateway is his choice');
  assert.deepEqual(G.gatewayChecks(one, { reason: SERVER, platform: 'darwin', net, started: () => true }), [], 'not read on macOS');
  assert.deepEqual(G.gatewayChecks(one, { reason: SERVER, platform: 'linux', net, started: () => false }), [], 'a program he runs himself');
  assert.deepEqual(G.gatewayChecks(one, { reason: SERVER, platform: 'linux', net: TCP(row('0100007F', 20001)), started: () => true }), []);
  assert.deepEqual(G.gatewayChecks(one, { reason: SERVER, platform: 'linux', net: TCP(), started: () => true }), [], 'not running');
});

test('"started by Hoprig" is its pid file in the state folder; the shipped gateways are looked at', async () => {
  const { SHIPPED, gatewayAddons } = await import('../../src/addons/gateways.mjs');
  const { saveConfig } = await import('../../src/config.mjs');
  const id = SHIPPED[0].id;
  saveConfig({ addons: { [id]: { port: 20001 } } });
  const list = gatewayAddons();
  const net = TCP(row('00000000', 20001));
  assert.deepEqual(G.gatewayChecks(list, { reason: SERVER, platform: 'linux', net }), [], 'no pid file: not one Hoprig started');
  fs.mkdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'addons'), { recursive: true });
  // A pid file a crash or a restart of the computer left behind (its process is gone): the port may be another
  // program's now, the owner's own. Nothing is said, and no fix that would end that program is named.
  const pidFile = path.join(process.env.HOPRIG_STATE_DIR, 'addons', `${id}.pid`);
  for (const text of ['{"pid":2147483646}\n', '2147483646\n']) {
    fs.writeFileSync(pidFile, text);
    assert.deepEqual(G.gatewayChecks(list, { reason: SERVER, platform: 'linux', net }), [], `left behind: ${text.trim()}`);
  }
  // One whose process runs and is shown to be that one (here: this test's own process, with its identity).
  const { system } = await import('../../src/procid.mjs');
  fs.writeFileSync(pidFile, `${JSON.stringify({ pid: process.pid, proc: system.self() })}\n`);
  const r = G.gatewayChecks(list, { reason: SERVER, platform: 'linux', net });
  assert.deepEqual(r.map((c) => [c.id, c.status]), [[`gateway-${id}`, 'fail']]);
  assert.ok(r[0].fix.startsWith(`hoprig addons stop ${id} && hoprig addons start ${id}`), r[0].fix);
});

// ---- the gateway with a copy of its own (ownGatewayChecks) ----
const own = (over = {}) => ({
  id: 'alpha', title: 'Gateway alpha', ownCopy: true,
  copyInfo: () => (over.status?.installed === false ? null : { copy: 'own', version: '1.0.11', ...over.status }),
  answering: async () => ({ up: Boolean(over.status?.running || over.status?.foreign), mine: Boolean(over.status?.running), ...(over.status?.foreign ? { otherUser: true } : {}) }),
  ready: async () => over.ready !== false,
  folders: () => ({ copy: over.copy || path.join(s.tmp, 'tools', 'alpha'), data: over.data || path.join(s.tmp, 'alpha-data'), global: over.global ?? null }),
});

test('doctor: nothing is said for a gateway that is not installed and not running, or one with no copy of its own', async () => {
  assert.deepEqual(await G.ownGatewayChecks([own({ status: { installed: false } })]), []);
  assert.deepEqual(await G.ownGatewayChecks([gw('plain', 20001)]), []);
});

test('doctor: the own copy and its data folder are this user\'s, and it answers its health route', async () => {
  const copy = path.join(s.tmp, 'tools', 'alpha');
  const data = path.join(s.tmp, 'alpha-data');
  fs.mkdirSync(copy, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'cli-token'), 'x');
  const r = await G.ownGatewayChecks([own({ status: { running: true } })]);
  assert.deepEqual(r.map((x) => [x.id, x.status]), [['gateway-alpha-copy', 'ok'], ['gateway-alpha-data', 'ok'], ['gateway-alpha-health', 'ok']]);
  assert.match(r[0].detail, /1\.0\.11.*Hoprig's own folder/);
  const down = await G.ownGatewayChecks([own({ status: { running: true }, ready: false })]);
  assert.equal(down.at(-1).status, 'warn');
  assert.match(down.at(-1).fix, /hoprig addons stop alpha && hoprig addons start alpha/);
  const foreign = await G.ownGatewayChecks([own({ status: { running: false, foreign: true } })]);
  assert.equal(foreign.at(-1).status, 'warn');
  assert.match(foreign.at(-1).detail, /another user/);
});

test('doctor: a copy or data folder of another user (root) is named plainly with the next step', { skip: process.platform === 'win32' && 'Windows has no user ids: a folder there is never another user\'s by id' }, async () => {
  const copy = path.join(s.tmp, 'tools', 'alpha');
  const data = path.join(s.tmp, 'alpha-data');
  const me = process.getuid?.() ?? 1000;
  const r = await G.ownGatewayChecks([own()], { uid: me + 1 }); // as if the folders were another user's
  const byId = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.equal(byId['gateway-alpha-copy'].status, 'fail');
  assert.match(byId['gateway-alpha-copy'].detail, /belongs to another user/);
  assert.ok(byId['gateway-alpha-copy'].fix.includes(copy) && /chown|hoprig addons install alpha/.test(byId['gateway-alpha-copy'].fix));
  assert.equal(byId['gateway-alpha-data'].status, 'fail');
  assert.ok(byId['gateway-alpha-data'].detail.includes(data));
  assert.match(byId['gateway-alpha-data'].fix, /chown -R .* /);
  const asRoot = await G.ownGatewayChecks([own()], { uid: me + 1, owner: (st) => (st.uid === me ? 'root' : null) });
  assert.match(asRoot.find((x) => x.id === 'gateway-alpha-data').detail, /root/);
});

test('doctor: a global copy is said to be used until Install is pressed, a root-owned one plainly', async () => {
  const r = await G.ownGatewayChecks([own({ status: { copy: 'global', version: '1.0.8' }, global: '/usr/lib/node_modules/gw/bin/gw' })]);
  const c = r.find((x) => x.id === 'gateway-alpha-copy');
  assert.equal(c.status, 'ok');
  assert.match(c.detail, /global copy.*1\.0\.8.*until/);
  assert.match(c.fix || c.detail, /hoprig addons install alpha/);
  const broken = await G.ownGatewayChecks([own({ status: { problem: 'its copy is damaged' } })]);
  assert.equal(broken.find((x) => x.id === 'gateway-alpha-copy').status, 'fail');
});
