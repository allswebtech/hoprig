// A gateway Hoprig starts listens no wider than the dashboard of its computer: on a server, and where the dashboard is
// "only this computer", the start passes the definition's --host 127.0.0.1; where the owner opened the dashboard to his
// network (a home), it starts as before, so a page he opens from another device stays open after an update.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-gwhost-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
const argsFile = path.join(tmp, 'started-with.txt');
// A stand-in gateway first on PATH: it writes down its arguments and listens on the port it is given (127.0.0.1 only).
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'trouteai'), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('TRouteAI 1.0.0'); process.exit(0); }
require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(' '));
const i = process.argv.indexOf('--port');
require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[i + 1]), '127.0.0.1');
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { SHIPPED } = await import('../../src/addons/gateways.mjs');
const { hostArgs, localGateway } = await import('../../src/addons/localgateway.mjs');
const def = SHIPPED.find((d) => d.id === 'trouteai');
const SERVER = { kind: 'cloud', name: 'Amazon EC2' };
test.after(() => {
  try { process.kill(JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'addons', 'trouteai.pid'), 'utf8')).pid, 'SIGKILL'); } catch { /* none left */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start the gateway with the dashboard on `host` and `reason`; → the arguments it was started with. */
async function startedWith(host, reason) {
  saveConfig({ ...loadConfig(), server: { ...(host ? { host } : {}) }, addons: { trouteai: { port } } });
  fs.rmSync(argsFile, { force: true });
  const g = localGateway(def, { shipped: true, reason: () => reason });
  const r = await g.start();
  assert.equal(r.ok, true, r.error);
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.equal(g.command().slice(1).join(' '), args, 'what `hoprig gateways` shows is what ran');
  assert.equal((await g.stop()).ok, true);
  return args;
}

test('on a server, and where the dashboard is this computer only: --host 127.0.0.1 in the start', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  assert.equal(await startedWith(null, null), `--port ${port} --host 127.0.0.1`, 'the default dashboard: this computer only');
  assert.equal(await startedWith('127.0.0.1', SERVER), `--port ${port} --host 127.0.0.1`);
  assert.equal(await startedWith('0.0.0.0', SERVER), `--port ${port} --host 127.0.0.1`, 'a server whose dashboard is still open: never wider');
});

test('a home as the last version leaves it (dashboard open to the network): the gateway starts as before', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.20']) assert.equal(await startedWith(host, null), `--port ${port}`, host);
});

test('only a shipped definition\'s own words are added, and only safe ones', () => {
  assert.deepEqual(hostArgs(def, { host: '127.0.0.1' }), ['--host', '127.0.0.1']);
  assert.deepEqual(hostArgs({ ...def, localOnly: undefined }, { host: '127.0.0.1' }), [], 'a gateway without it: nothing guessed');
  assert.deepEqual(hostArgs({ ...def, localOnly: ['--host', '127.0.0.1; rm'] }, { host: '127.0.0.1' }), []);
});

test('where the dashboard really listens decides, not only its settings: serve --host 0.0.0.0, HOST, and Tailscale', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  const file = path.join(tmp, 'state', 'dashboard.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A home: no host in the settings, the dashboard started with `hoprig serve --host 0.0.0.0` (Settings → Network says
  // so); its dashboard.json says where it listens (this process stands in for it: it lives).
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: '0.0.0.0', port: 7433, at: Date.now() }));
  try {
    assert.equal(await startedWith(null, null), `--port ${port}`, 'the running dashboard is open to the network: as before');
    assert.equal(await startedWith(null, SERVER), `--port ${port} --host 127.0.0.1`, 'a server: never wider');
  } finally {
    fs.rmSync(file, { force: true });
  }
  // None running: what a start takes, HOST first (as serveopts.mjs resolveListen).
  process.env.HOST = '0.0.0.0';
  try {
    assert.equal(await startedWith(null, null), `--port ${port}`, 'HOST=0.0.0.0');
  } finally {
    delete process.env.HOST;
  }
  // Reached over Tailscale (set-up keeps 127.0.0.1 and a ts.net origin): the owner's other devices keep the gateway.
  saveConfig({ ...loadConfig(), server: { host: '127.0.0.1', allowedOrigins: ['https://box2.tail1234.ts.net'] }, addons: { trouteai: { port } } });
  assert.deepEqual(hostArgs(def, { host: '127.0.0.1' }), [], 'Tailscale: as before');
  assert.deepEqual(hostArgs(def, { host: '127.0.0.1', reason: SERVER }), ['--host', '127.0.0.1'], 'Tailscale on a server: this computer only');
  saveConfig({ ...loadConfig(), server: { host: '127.0.0.1', allowedOrigins: [] } });
});

test('an owner\'s own gateway may name its localOnly words: used on a server; without them, a server says it cannot keep it local', async () => {
  const { checkDefinition } = await import('../../src/addons/gateways.mjs');
  const raw = { id: 'relay', title: 'Relay', bin: '/opt/relay/bin/relay', port: 23456, args: ['--listen-port', 'PORT'] };
  const own = checkDefinition({ ...raw, localOnly: ['--bind', '127.0.0.1'] }, { cfg: { server: {} } });
  assert.deepEqual(own.def.localOnly, ['--bind', '127.0.0.1'], own.error);
  assert.match(checkDefinition({ ...raw, localOnly: ['--bind', '127.0.0.1; rm'] }, { cfg: { server: {} } }).error, /localOnly/);
  const kept = localGateway(own.def, { shipped: false, reason: () => SERVER });
  assert.deepEqual(kept.command(), ['/opt/relay/bin/relay', '--listen-port', '23456', '--bind', '127.0.0.1']);
  assert.equal(kept.keptLocal(), true);
  const bare = localGateway(checkDefinition(raw, { cfg: { server: {} } }).def, { shipped: false, reason: () => SERVER });
  assert.equal(bare.keptLocal(), false, 'nothing to pass: said, not guessed');
  assert.deepEqual(bare.command(), ['/opt/relay/bin/relay', '--listen-port', '23456']);
  assert.equal(localGateway(own.def, { shipped: false, reason: () => null }).keptLocal(), null, 'not a server: nothing to say');
});
