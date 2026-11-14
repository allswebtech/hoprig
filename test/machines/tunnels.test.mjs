// The tunnel keeper with a fake ssh process: comes up when the local port answers, restarts with growing waits,
// starts over after a stable run, retries at once when someone needs it, and stops for good on close().
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeRemote } from './harness.mjs';

const box = sandbox('machines-tunnels');
test.after(() => box.cleanup());
const { Tunnel, Tunnels, freePort, tcpProbe } = await import('../../src/machines/tunnels.mjs');

/** A fake ssh child: exit(code, stderr) ends it; `killed` records signals. */
function fakeSpawner() {
  const children = [];
  const spawnImpl = (bin, args) => {
    const c = new EventEmitter();
    c.args = args;
    c.stderr = new EventEmitter();
    c.killed = [];
    c.kill = (sig) => {
      c.killed.push(sig);
      setImmediate(() => c.emit('exit', null, sig));
    };
    c.exit = (code, text = '') => {
      if (text) c.stderr.emit('data', Buffer.from(text));
      c.emit('exit', code, null);
    };
    children.push(c);
    return c;
  };
  return { children, spawnImpl };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const machine = { target: 'box2', remoteHost: '127.0.0.1', remotePort: 7433 };

test('up when the local port answers; the arguments carry the chosen port', async () => {
  const { children, spawnImpl } = fakeSpawner();
  let open = false;
  const t = new Tunnel({ machine, spawnImpl, freePort: async () => 41000, probe: async () => open, probeEveryMs: 5 });
  const p = t.ensure(2000);
  await tick();
  assert.equal(t.state, 'starting');
  assert.ok(children[0].args.includes('127.0.0.1:41000:127.0.0.1:7433'));
  open = true;
  assert.equal(await p, 41000);
  assert.equal(t.state, 'up');
  assert.equal(await t.ensure(10), 41000, 'already up: at once');
  t.close();
  assert.deepEqual(children[0].killed, ['SIGTERM']);
});

test('reconnects with growing waits, starts over after a stable run, and reports why it failed', async () => {
  const { children, spawnImpl } = fakeSpawner();
  let clock = 0;
  const t = new Tunnel({ machine, spawnImpl, freePort: async () => 41001, probe: async () => false, probeEveryMs: 5, minDelayMs: 30, maxDelayMs: 100, stableMs: 1000, now: () => clock });
  const fails = [];
  t.on('fail', (m) => fails.push(m));
  const first = t.ensure(5000);
  await tick();
  children[0].exit(255, 'Warning: Permanently added x\nalex@box2: Permission denied (publickey).\n');
  await assert.rejects(first, /Permission denied/);
  assert.equal(t.state, 'waiting');
  assert.equal(t.failures, 1);
  // backoff 30, 60, 100 (capped): count the spawns over time
  await tick(45);
  assert.equal(children.length, 2);
  children[1].exit(255, 'Connection refused');
  await tick(40);
  assert.equal(children.length, 2, 'second wait is longer (60 ms)');
  await tick(40);
  assert.equal(children.length, 3);
  assert.equal(t.failures, 2);
  assert.match(t.status().error, /Connection refused/);
  // this one comes up, stays up "long" (fake clock), then drops: the count starts over
  t.probe = async () => true;
  await tick(20);
  assert.equal(t.state, 'up');
  clock += 5000;
  children[2].exit(255, 'Connection to box2 closed by remote host.');
  assert.equal(t.failures, 1, 'a stable run resets the backoff');
  assert.equal(fails.at(-1), 'Connection to box2 closed by remote host.');
  t.close();
});

test('someone needing the machine skips the rest of the wait', async () => {
  const { children, spawnImpl } = fakeSpawner();
  let clock = 0;
  const t = new Tunnel({ machine, spawnImpl, freePort: async () => 41002, probe: async () => false, probeEveryMs: 5, minDelayMs: 50, maxDelayMs: 60_000, now: () => clock });
  t.failures = 10; // the next wait would be a minute
  t.ensure(1000).catch(() => {});
  await tick();
  children[0].exit(255, 'down');
  await tick();
  assert.equal(children.length, 1);
  clock += 100;
  const p = t.ensure(1000);
  await tick();
  assert.equal(children.length, 2, 'started again at once');
  t.probe = async () => true;
  assert.equal(await p, 41002);
  t.close();
});

test('a tunnel that never comes up is stopped and counts as a failure', async () => {
  const { children, spawnImpl } = fakeSpawner();
  let clock = 0;
  const t = new Tunnel({ machine, spawnImpl, freePort: async () => 41003, probe: async () => ((clock += 100), false), probeEveryMs: 1, startTimeoutMs: 1000, now: () => clock });
  await assert.rejects(t.ensure(2000), /did not come up/);
  assert.deepEqual(children[0].killed, ['SIGTERM']);
  t.close();
});

test('close() stops it for good: no restart, ensure refuses', async () => {
  const { children, spawnImpl } = fakeSpawner();
  const t = new Tunnel({ machine, spawnImpl, freePort: async () => 41004, probe: async () => true, probeEveryMs: 1, minDelayMs: 5 });
  await t.ensure(1000);
  t.close();
  await tick(30);
  assert.equal(children.length, 1);
  await assert.rejects(t.ensure(10), /stopping/);
});

test('Tunnels: one per machine; a changed port replaces it', () => {
  const { spawnImpl } = fakeSpawner();
  const ts = new Tunnels({ spawnImpl });
  const a = ts.get({ name: 'box2', ...machine });
  assert.equal(ts.get({ name: 'box2', ...machine }), a);
  const b = ts.get({ name: 'box2', ...machine, remotePort: 7500 });
  assert.notEqual(a, b);
  assert.equal(a.state, 'closed');
  ts.closeAll();
  assert.equal(b.state, 'closed');
});

test('end to end with the fake ssh binary: a real TCP forward, and a new one after it dies', { skip: process.platform === 'win32' && 'POSIX scripts' }, async () => {
  // The service on the other computer. A connection through the tunnel can be cut at any moment (the tunnel's probe
  // closes its own at once, and the stand-in ssh dies on purpose): the reset arrives here, and without a listener
  // it was an uncaught exception that failed this test now and then.
  const target = net.createServer((c) => {
    c.on('error', () => {});
    c.end('pong');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  // The stand-in ssh dies 1.5 s after it started: long enough for the tunnel to come up and be read through on a
  // busy computer (with 400 ms it sometimes died first, and the tunnel never came up).
  const r = fakeRemote(path.join(box.root, 'e2e'), { mode: 'die-after-ms:1500' });
  const { spawn } = await import('node:child_process');
  const t = new Tunnel({
    machine: { target: 'box2', remoteHost: '127.0.0.1', remotePort: target.address().port },
    spawnImpl: (bin, args, o) => spawn(bin, args, { ...o, env: r.sshEnv }),
    minDelayMs: 50,
  });
  try {
    const port = await t.ensure(5000);
    const read = (p) => new Promise((resolve, reject) => {
      const s = net.connect(p, '127.0.0.1');
      let d = '';
      s.on('data', (x) => (d += x));
      s.on('end', () => resolve(d));
      s.on('error', reject);
    });
    assert.equal(await read(port), 'pong');
    await new Promise((res) => t.once('fail', res)); // the stand-in ssh dies
    const again = await t.ensure(5000);
    assert.equal(await read(again), 'pong');
    assert.ok(r.calls().length >= 2);
    assert.ok(await tcpProbe(again));
    assert.ok((await freePort()) > 0);
  } finally {
    t.close();
    target.close();
  }
});

test('the default probe is a real TCP check, and a throwing probe never crashes the process', async () => {
  const target = net.createServer();
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const { children, spawnImpl } = fakeSpawner();
  const port = target.address().port;
  const t = new Tunnel({ machine, spawnImpl, freePort: async () => port, probeEveryMs: 5 }); // default probe
  assert.equal(await t.ensure(2000), port, 'something listens there: up');
  t.close();
  const bad = new Tunnel({ machine, spawnImpl, freePort: async () => 41005, probe: () => { throw new Error('boom'); }, probeEveryMs: 5, startTimeoutMs: 100 });
  await assert.rejects(bad.ensure(2000), /did not come up/);
  bad.close();
  target.close();
  assert.ok(children.length >= 2);
});
