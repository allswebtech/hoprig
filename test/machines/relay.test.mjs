// The hub relaying to other machines, over real HTTP and WebSockets: normal requests, an upload stream, a
// terminal, header stripping, and what the page gets when a machine is offline, slow, revoked or too old. Also the
// sessions of all machines in parallel, and a machine added by SSH (fake ssh, real TCP tunnel).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { saveConfig } from '../../src/config.mjs';
import { sandbox } from '../server/helpers.mjs';
import { REPO, asBrowser, fakeRemote, miniDashboard } from './harness.mjs';

// Hub and machines share one config folder here: the hub's machines.json and the remotes' token list are
// different files, so they do not get in each other's way.
const box = sandbox('machines-relay');
const { createMachines } = await import('../../src/machines/index.mjs');
const { createToken, listTokens, revokeToken } = await import('../../src/machines/tokens.mjs');
const { putMachine, loadMachines } = await import('../../src/machines/store.mjs');

const skip = process.platform === 'win32' && 'POSIX scripts';
const fast = { claudeVersion: async () => null, relayIdleMs: 800, hub: { probeTimeoutMs: 600, tunnelWaitMs: 5000, hubName: 'test-hub' } };

const seen = [];
const remote = await miniDashboard({ createMachines, opts: fast, sessions: [{ name: 'remote-one' }], onRequest: (req) => seen.push(req) }).listen();
const remoteTok = createToken('test-hub');
// An "old" hoprig: knows nothing about tokens.
const old = await miniDashboard({ createMachines: () => ({ handle: async () => false, upgrade: async () => false, authedByToken: () => false, close() {} }) }).listen();
// A machine that accepts connections and never answers.
const hanging = net.createServer(() => {});
await new Promise((r) => hanging.listen(0, '127.0.0.1', r));
const deadPort = await new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});

let sshRemote = null;
const hubOpts = () => ({ ...fast, hub: { ...fast.hub, ...(sshRemote ? { ssh: { env: sshRemote.sshEnv } } : {}) } });
let hub = await miniDashboard({ createMachines, opts: hubOpts(), sessions: [{ name: 'hub-own' }] }).listen();
let browser = asBrowser(hub.base);

putMachine({ name: 'rem', label: 'Remote', via: 'url', url: remote.base, token: remoteTok.token, tokenId: remoteTok.id });
putMachine({ name: 'oldie', via: 'url', url: old.base, token: 'hop_whatever' });
putMachine({ name: 'dead', via: 'url', url: `http://127.0.0.1:${deadPort}`, token: 'hop_x' });
putMachine({ name: 'slow', via: 'url', url: `http://127.0.0.1:${hanging.address().port}`, token: 'hop_x' });

test.after(async () => {
  await hub.close();
  await remote.close();
  await old.close();
  hanging.close();
  box.cleanup();
});

test('a request is relayed with the token; cookie, Origin and forwarding headers stay on the hub', async () => {
  const r = await browser('/m/rem/api/sessions/x/send?a=1&b=2', { body: { text: 'hello' }, headers: { 'X-Forwarded-For': '6.6.6.6', 'X-File-Name': 'f.png', Referer: 'http://x' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.path, '/api/sessions/x/send?a=1&b=2');
  assert.equal(r.json.body, '{"text":"hello"}');
  assert.equal(r.json.viaToken, true);
  const h = r.json.headers;
  assert.equal(h.authorization, `Bearer ${remoteTok.token}`, 'the token the hub keeps for this machine');
  for (const k of ['cookie', 'origin', 'x-forwarded-for', 'referer']) assert.equal(h[k], undefined, k);
  assert.equal(h['x-file-name'], 'f.png');
  assert.equal(r.headers.get('set-cookie'), null, "the other side's cookie never reaches the browser");
  assert.equal(r.headers.get('x-remote-only'), null);
});

test('the hub login guards the relay', async () => {
  assert.equal((await fetch(`${hub.base}/m/rem/api/state`)).status, 401);
  assert.equal((await fetch(`${hub.base}/m/rem/api/shells`, { method: 'POST', headers: { Cookie: 'sid=good-cookie', 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'Origin');
  assert.equal((await browser('/m/nope/api/state')).status, 404);
  assert.equal((await browser('/m/Bad..Name/api/state')).status, 404);
  assert.deepEqual((await browser('/m/rem/api/me')).json, { authed: true }, 'answered by the hub');
});

test("the page for another machine is the hub's own page", async () => {
  const r = await browser('/m/rem/app.js');
  assert.equal(r.text, 'STATIC /app.js');
  assert.equal((await browser('/m/rem/')).text, 'STATIC /');
  assert.equal((await browser('/m/rem')).status, 302);
  assert.equal((await browser('/m/nope/')).status, 404);
});

test('an upload is streamed through, not collected first', async () => {
  const chunk = Buffer.alloc(256 * 1024, 7);
  const before = seen.length;
  const res = await new Promise((resolve, reject) => {
    const rq = http.request(`${hub.base}/m/rem/api/sessions/x/upload`, { method: 'POST', headers: { Origin: hub.base, Cookie: 'sid=good-cookie', 'Content-Type': 'application/octet-stream', 'X-File-Name': 'big.bin' } }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(d) }));
    });
    rq.on('error', reject);
    rq.write(chunk);
    // The second half goes only after the other side has started receiving: proof the hub does not wait.
    const wait = setInterval(() => {
      if (seen.length > before) {
        clearInterval(wait);
        rq.wasStreamingAt = Date.now();
        setTimeout(() => {
          rq.secondAt = Date.now();
          rq.end(chunk);
        }, 100);
      }
    }, 10);
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.bytes, chunk.length * 2);
  assert.equal(res.json.headers['content-type'], 'application/octet-stream');
});

test('a terminal through the hub: frames both ways, the close code passes, no cookie or Origin forwarded', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/m/rem/ws/term?name=remote-one&cols=80&rows=24`, { headers: { Origin: hub.base, Cookie: 'sid=good-cookie' } });
  const got = [];
  ws.on('message', (d) => got.push(d.toString()));
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fn());
  };
  await until(() => got.includes('hello remote-one cookie=no origin=no'));
  ws.send('ls\r');
  await until(() => got.includes('echo ls\r'));
  const closed = new Promise((r) => ws.on('close', (code, reason) => r([code, reason.toString()])));
  ws.send('end');
  assert.deepEqual(await closed, [4000, 'session ended']);

  const status = (p, headers) =>
    new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${hub.port}${p}`, { headers });
      w.on('unexpected-response', (rq, res) => resolve(res.statusCode));
      w.on('open', () => resolve('open'));
    });
  assert.equal(await status('/m/rem/ws/term?name=missing', { Origin: hub.base, Cookie: 'sid=good-cookie' }), 404);
  assert.equal(await status('/m/rem/ws/term?name=x', { Origin: 'http://evil.example', Cookie: 'sid=good-cookie' }), 403);
  assert.equal(await status('/m/rem/ws/term?name=x', { Origin: hub.base }), 401);
  assert.equal(await status('/m/dead/ws/term?name=x', { Origin: hub.base, Cookie: 'sid=good-cookie' }), 502);
});

test('offline, slow and too old: clear errors, never a 401', async () => {
  const dead = await browser('/m/dead/api/state');
  assert.equal(dead.status, 502);
  assert.equal(dead.json.code, 'offline');
  assert.match(dead.json.error, /offline/);
  const t = Date.now();
  const slow = await browser('/m/slow/api/state');
  assert.equal(slow.status, 504);
  assert.equal(slow.json.code, 'timeout');
  assert.ok(Date.now() - t < 3000);
  const oldie = await browser('/m/oldie/api/state');
  assert.equal(oldie.status, 502);
  assert.equal(oldie.json.code, 'too-old');
  assert.match(oldie.json.error, /hoprig update/);
  // A route that hangs on a live machine also times out.
  assert.equal((await browser('/m/rem/api/slow')).json.code, 'timeout');
  // A git commit in the code editor may wait for slow hooks: it is given longer than an ordinary request.
  const commit = await browser('/m/rem/api/code/git/commit', { body: { message: 'x' } });
  assert.deepEqual([commit.status, commit.json.committed], [200, true]);
});

test('the machine list and the sessions of all machines: in parallel, a dead one does not block', async () => {
  const t = Date.now();
  const all = await browser('/api/machines/sessions');
  assert.ok(Date.now() - t < 2500, `took ${Date.now() - t} ms`);
  const by = Object.fromEntries(all.json.machines.map((m) => [m.machine ?? 'self', m]));
  assert.deepEqual(by.self.sessions, [{ name: 'hub-own' }]);
  assert.equal(by.rem.status, 'online');
  assert.deepEqual(by.rem.sessions, [{ name: 'remote-one' }]);
  assert.equal(by.dead.status, 'offline');
  assert.equal(by.slow.status, 'offline');
  assert.equal(by.oldie.status, 'too-old');

  const list = (await browser('/api/machines')).json;
  assert.equal(list.hubName, 'test-hub');
  const st = Object.fromEntries(list.machines.map((m) => [m.name, m]));
  assert.equal(st.rem.state, 'online');
  assert.equal(st.rem.label, 'Remote');
  assert.ok(st.rem.hostname && st.rem.platform);
  assert.equal(st.dead.state, 'offline');
  assert.equal(st.oldie.state, 'too-old');
  assert.equal(JSON.stringify(list).includes('hop_'), false, 'no tokens in the list');
});

test('a revoked token: "not authorised" in the list and on every relayed call', async () => {
  const extra = createToken('test-hub');
  putMachine({ name: 'rev', via: 'url', url: remote.base, token: extra.token, tokenId: extra.id });
  assert.equal((await browser('/m/rev/api/state')).status, 200);
  revokeToken(extra.id);
  const r = await browser('/m/rev/api/state');
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'not-authorised');
  assert.match(r.json.error, /revoked/);
  const t = (await browser('/api/machines/rev/test', { body: {} })).json.machine;
  assert.equal(t.state, 'unauthorised');
});

test('rename and remove', async () => {
  assert.equal((await browser('/api/machines/rev/rename', { body: { name: 'rev2', label: 'Revoked one' } })).json.name, 'rev2');
  assert.equal((await browser('/api/machines/rev2/rename', { body: { name: 'rem' } })).status, 409);
  const rm = await browser('/api/machines/rev2/remove', { body: {} });
  assert.equal(rm.json.removed, true);
  assert.equal(rm.json.revoked, false);
  assert.match(rm.json.note, /Who may control this computer/);
  assert.equal((await browser('/api/machines/rev2/remove', { body: {} })).status, 404);
});

test('add by address and code, through the hub API', async () => {
  const code = (await asBrowser(remote.base)('/api/pair/code', { body: {} })).json.code;
  const bad = await browser('/api/machines/url', { body: { url: remote.base, code: 'ZZZZ-ZZZZ' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'bad-code');
  const added = await browser('/api/machines/url', { body: { url: remote.base, code, name: 'bycode' } });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.machine.state, 'online');
  assert.equal((await browser('/m/bycode/api/state')).json.sessions[0].name, 'remote-one');
  const tooOld = await browser('/api/machines/url', { body: { url: old.base, code } });
  assert.equal(tooOld.json.code, 'too-old');
  assert.equal((await browser('/api/machines/url', { body: { url: 'ftp://x', code } })).status, 400);
});

test('add by SSH in one step: hoprig only in the login shell, a real tunnel, then requests and a terminal', { skip }, async () => {
  saveConfig({ server: { host: '127.0.0.1', port: remote.port } });
  sshRemote = fakeRemote(path.join(box.root, 'ssh'), { script: `exec "${process.execPath}" "${path.join(REPO, 'bin', 'hoprig.mjs')}" "$@"` });
  await hub.close();
  hub = await miniDashboard({ createMachines, opts: hubOpts(), sessions: [{ name: 'hub-own' }] }).listen();
  browser = asBrowser(hub.base);

  const r = await browser('/api/machines/ssh', { body: { target: 'alex@box2' } });
  assert.equal(r.status, 200, r.text);
  const m = r.json.machine;
  assert.equal(m.state, 'online', JSON.stringify(m));
  assert.equal(m.via, 'ssh');
  assert.equal(r.json.hint, null);
  const calls = sshRemote.calls();
  assert.equal(calls[0].at(-1), 'hoprig pair --json --name test-hub');
  assert.equal(calls[1].at(-1), `$SHELL -lic 'hoprig pair --json --name test-hub'`);
  assert.ok(calls.some((c) => c.includes('-N') && c.includes('ExitOnForwardFailure=yes')), 'a tunnel was started');
  const stored = loadMachines().find((x) => x.name === m.name);
  assert.equal(stored.remotePort, remote.port);

  assert.equal((await browser(`/m/${m.name}/api/state`)).json.sessions[0].name, 'remote-one');
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/m/${m.name}/ws/term?name=remote-one`, { headers: { Origin: hub.base, Cookie: 'sid=good-cookie' } });
  const first = await new Promise((resolve, reject) => {
    ws.on('message', (d) => resolve(d.toString()));
    ws.on('error', reject);
  });
  assert.equal(first, 'hello remote-one cookie=no origin=no');
  ws.close();

  // Adding the same target again re-pairs (new token) instead of making a second entry, and the old token there is
  // revoked before the answer: nothing goes on changing that computer after it.
  const again = await browser('/api/machines/ssh', { body: { target: 'alex@box2' } });
  assert.equal(again.json.machine.name, m.name);
  assert.equal(loadMachines().filter((x) => x.via === 'ssh').length, 1);
  assert.notEqual(loadMachines().find((x) => x.name === m.name).tokenId, stored.tokenId);
  assert.ok(!listTokens().some((x) => x.id === stored.tokenId), 'the old token is revoked there');
  // Remove: the token there is revoked over SSH too.
  const rm = await browser(`/api/machines/${m.name}/remove`, { body: {} });
  assert.equal(rm.json.revoked, true);
});

test('add by SSH where hoprig is missing: the install command, and the install runs with live output', { skip }, async () => {
  sshRemote = fakeRemote(path.join(box.root, 'ssh-missing'), { installed: false });
  await hub.close();
  const script = path.join(box.root, 'fake-install.sh');
  (await import('node:fs')).writeFileSync(script, 'echo "Installing hoprig $1"\necho done\n');
  hub = await miniDashboard({ createMachines, opts: { ...hubOpts(), hub: { ...hubOpts().hub, installer: () => ({ kind: 'file', value: script }) } } }).listen();
  browser = asBrowser(hub.base);
  const r = await browser('/api/machines/ssh', { body: { target: 'pc3' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'not-installed');
  assert.equal(r.json.canInstall, true);
  assert.ok(r.json.installCommand);
  assert.equal((await browser('/api/machines/ssh', { body: { target: '-oProxyCommand=x' } })).status, 400);

  assert.equal((await browser('/api/machines/install', { body: { target: 'pc3' } })).json.started, true);
  let st;
  for (let i = 0; i < 100; i++) {
    st = (await browser('/api/machines/install?from=0')).json;
    if (!st.running && st.result) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(st.result.ok, true);
  assert.ok(st.lines.includes('Installing hoprig --yes'), st.lines.join('|'));
});

test('the hub stops its tunnels on close', { skip }, async () => {
  await hub.close();
  assert.equal(hub.machines.hub.tunnels.map.size, 0);
  hub = await miniDashboard({ createMachines, opts: hubOpts() }).listen();
});
