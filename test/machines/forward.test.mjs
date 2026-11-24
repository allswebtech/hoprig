// "Open its page" of a gateway on another computer (src/machines/forward.mjs, POST /api/machines/<name>/forward):
// a forward on this computer's 127.0.0.1 to that gateway's port only, as that computer itself names the port; offered
// only to a browser on this computer; closed on Stop, when idle, when the computer is removed and when the dashboard
// stops. And no route of the dashboard relays a gateway's page: not a computer route, not /m/<name>/… with its port or path.
// The other computer is a mini dashboard reached through the stand-in ssh (a real TCP forward), traps behind it.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { COOKIE, fakeRemote, miniDashboard } from './harness.mjs';
import { traps } from './traps.mjs';
import { sealedPath } from '../seal.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('machines-forward');
const { createMachines } = await import('../../src/machines/index.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { Forwards, otherLoopback } = await import('../../src/machines/forward.mjs');

const PAGE = 'GATEWAY-PAGE-made-up';
const gw = http.createServer((req, res) => res.end(PAGE));
await new Promise((r) => gw.listen(0, '127.0.0.1', r));
const gwPort = gw.address().port;
let running = true;
const answers = { '/api/gatewayhost': { computer: 'box2', gateways: [{ id: 'relay', title: 'Relay', port: gwPort, get running() { return running; } }] } };
const opts = { claudeVersion: async () => null, hub: { probeTimeoutMs: 2000, tunnelWaitMs: 8000 } };
const other = await miniDashboard({ createMachines, opts, answers }).listen();
const remote = fakeRemote(path.join(box.root, 'ssh'));
const trap = traps(box.root);
const env = { ...remote.sshEnv, PATH: sealedPath(trap.path(remote.bin)) };
const hub = await miniDashboard({ createMachines, opts: { ...opts, hub: { ...opts.hub, ssh: { env } } } }).listen();
const { token } = createToken('hub');
putMachine({ name: 'box2', label: 'Box 2', via: 'ssh', target: 'alex@box2', remoteHost: '127.0.0.1', remotePort: other.port, token, tokenId: null, added: 1 });
test.after(async () => {
  await hub.close();
  await other.close();
  await new Promise((r) => gw.close(r));
  box.cleanup();
});

/** A request to the hub as a browser would send it, with the Host it names (the public link's, or this computer's). */
const ask = (p, { body, host = `127.0.0.1:${hub.port}`, origin = `http://${host}` } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: hub.port, path: p, method: data ? 'POST' : 'GET', headers: { Host: host, Origin: origin, Cookie: COOKIE, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => {
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      resolve({ status: res.statusCode, text, json });
    });
  });
  req.on('error', reject);
  req.end(data);
});
const get = (url) => fetch(url).then((r) => r.text());

test('the forward: on 127.0.0.1, to that gateway\'s port only, after a confirmation that names the computer', { skip }, async () => {
  assert.equal((await ask('/api/machines/box2/forward', { body: { gateway: 'relay' } })).json.code, 'confirm');
  const r = await ask('/api/machines/box2/forward', { body: { gateway: 'relay', confirm: 'box2' } });
  assert.equal(r.status, 200, r.text);
  const url = new URL(r.json.forward.url);
  assert.ok(['[::1]', 'localhost'].includes(url.hostname), `this computer only, never the dashboard's own host name (its cookie): ${url.hostname}`);
  assert.notEqual(Number(url.port), hub.port);
  assert.equal(await get(r.json.forward.url), PAGE);
  const forwardCall = remote.calls().find((c) => c.includes('-L') && c[c.indexOf('-L') + 1].endsWith(`:127.0.0.1:${gwPort}`));
  assert.ok(forwardCall, 'ssh -L to the gateway\'s port as that computer named it');
  assert.equal((await ask('/api/machines/box2/forward', { body: { gateway: 'relay', confirm: 'box2' } })).json.forward.url, r.json.forward.url, 'twice: the same forward');
  assert.equal((await ask('/api/machines/box2/forward')).json.here, true);
  assert.equal((await ask('/api/machines/box2/forward')).json.via, 'ssh');
  putMachine({ name: 'box9', label: 'Box 9', via: 'url', url: 'https://box9.example.com', token: 'x'.repeat(40), tokenId: null, added: 1 });
  assert.equal((await ask('/api/machines/box9/forward')).json.via, 'other', 'linked without SSH: the page says where to open it');
  assert.equal((await ask('/api/machines/box9/forward', { body: { gateway: 'relay', confirm: 'box9' } })).json.code, 'no-forward');
  assert.equal((await ask('/api/machines/nope/forward')).status, 404);
  assert.equal((await ask('/api/machines/box2/forward/stop', { body: {} })).json.stopped, true);
  await assert.rejects(get(r.json.forward.url), 'closed on Stop');
  // A page on [::1] gets a link on 127.0.0.1 instead: never the page's own host name.
  const v6 = await ask('/api/machines/box2/forward', { body: { gateway: 'relay', confirm: 'box2' }, host: `[::1]:${hub.port}` });
  assert.equal(v6.status, 200, v6.text);
  assert.equal(new URL(v6.json.forward.url).hostname, '127.0.0.1');
  assert.equal(await get(v6.json.forward.url), PAGE);
  await ask('/api/machines/box2/forward/stop', { body: {} });
  trap.check();
});

test('the link\'s host name is never the page\'s own', () => {
  for (const [page, link] of [['127.0.0.1:7433', 'localhost'], ['localhost:7433', '127.0.0.1'], ['[::1]:7433', '127.0.0.1'], ['LOCALHOST', '127.0.0.1']]) assert.equal(otherLoopback(page), link, page);
});

test('two opens at once give one forward, and Stop and closeAll leave nothing listening', { skip }, async () => {
  const f = new Forwards({ ssh: { env } });
  const m = { name: 'box2', target: 'alex@box2' };
  const [a, b] = await Promise.all([f.open(m, 'relay', gwPort), f.open(m, 'relay', gwPort)]);
  assert.equal(a.url, b.url, 'the second open got the first one\'s forward');
  assert.equal(await get(a.url), PAGE);
  f.stop('box2');
  f.closeAll();
  await assert.rejects(get(a.url), 'closed');
  await assert.rejects(get(b.url), 'closed');
  trap.check();
});

test('a browser that is not on this computer is told so in plain words; a gateway that is not running is said', { skip }, async () => {
  const far = await ask('/api/machines/box2/forward', { body: { gateway: 'relay', confirm: 'box2' }, host: 'pc.example.com' });
  assert.equal(far.status, 409);
  assert.equal(far.json.code, 'not-here');
  assert.match(far.json.error, /not open on the computer this dashboard runs on/);
  assert.equal((await ask('/api/machines/box2/forward', { host: 'pc.example.com' })).json.here, false);
  running = false;
  try {
    assert.equal((await ask('/api/machines/box2/forward', { body: { gateway: 'relay', confirm: 'box2' } })).json.code, 'not-running');
  } finally {
    running = true;
  }
  assert.equal((await ask('/api/machines/box2/forward', { body: { gateway: 'nope', confirm: 'box2' } })).status, 404);
  trap.check();
});

test('no route of the dashboard relays a gateway\'s page', { skip }, async () => {
  const tries = ['/m/box2/', `/m/box2/:${gwPort}/`, '/m/box2/gateway/relay/', '/m/box2/api/gatewayhost/relay', `/m/box2/api/gatewayhost/relay/page`, '/api/machines/box2/forward', `/m/box2/api/machines/box2/forward`, `/api/machines/box2/health`];
  for (const p of tries) {
    const r = await ask(p);
    assert.ok(!r.text.includes(PAGE), `${p} carried the gateway's page`);
  }
  trap.check();
});

test('closed by itself when idle, when the computer is removed, and when the dashboard stops', { skip }, async () => {
  let t = 0;
  const f = new Forwards({ ssh: { env }, idleMs: 1000, checkEveryMs: 20, now: () => t });
  const m = { name: 'box2', target: 'alex@box2' };
  const s = await f.open(m, 'relay', gwPort);
  assert.ok(['::1', '127.0.0.1'].includes(f.map.get('box2').server.address().address), 'bound to this computer only');
  assert.equal(await get(s.url), PAGE);
  t = 5000;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(f.status('box2'), null, 'idle: closed');
  await assert.rejects(get(s.url));
  const again = await ask('/api/machines/box2/forward', { body: { gateway: 'relay', confirm: 'box2' } });
  assert.equal(again.status, 200, again.text);
  assert.equal((await ask('/api/machines/box2/remove', { body: { confirm: 'box2' } })).status, 200);
  await assert.rejects(get(again.json.forward.url), 'removed with the computer');
  // Removing it gave its token back there: added again, it pairs anew.
  putMachine({ name: 'box2', label: 'Box 2', via: 'ssh', target: 'alex@box2', remoteHost: '127.0.0.1', remotePort: other.port, token: createToken('hub').token, tokenId: null, added: 1 });
  const last = await ask('/api/machines/box2/forward', { body: { gateway: 'relay', confirm: 'box2' } });
  assert.equal(last.status, 200, last.text);
  hub.machines.close();
  await assert.rejects(get(last.json.forward.url), 'the dashboard stopped');
  trap.check();
});
