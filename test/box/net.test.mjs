// The box (docs/BOX.md): no network at all. Not an address outside, not this computer's own services on the loopback or on
// its own address, no socket of the session outside, no abstract socket name. Every listener here is one this test
// opened on a free port the system gave; no request goes to a real address.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boxCheck, planRun, runBoxed } from '../../src/box/box.mjs';
import { bwrapArgs } from '../../src/box/linux.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-net-')));
const work = path.join(tmp, 'work');
const outside = path.join(tmp, 'outside');
for (const d of [work, outside]) fs.mkdirSync(d);
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

const servers = [];
test.after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A listener of this test's own: on `host` and a free port, or on a socket path or abstract name. */
async function listen(where) {
  const s = net.createServer((c) => c.end('reached'));
  servers.push(s);
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    if (typeof where === 'string') s.listen(where, resolve);
    else s.listen(0, where.host, resolve);
  });
  return s;
}

/** Whether a connection to `target` ({ host, port } or { path }) gets an answer, from this process. */
function reach(target) {
  return new Promise((resolve) => {
    const c = net.connect(target);
    let got = '';
    c.setTimeout(3000, () => (c.destroy(), resolve('timeout')));
    c.on('data', (d) => (got += d));
    c.on('end', () => resolve(got));
    c.on('error', (e) => resolve(e.code));
  });
}

/** This computer's own address that is not the loopback, where it has one. */
const ownAddress = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const noBox = process.platform === 'win32' && 'the box is made for Linux and macOS: Windows has none (means.mjs)';

test('the arguments give the box a network space of its own', { skip: noBox }, () => {
  const p = planRun(['/bin/true'], { cwd: work, write: [work], timeoutMs: 1000 });
  const { args } = bwrapArgs(p);
  for (const o of ['--unshare-net', '--unshare-ipc', '--unshare-uts']) assert.ok(args.includes(o), o);
  assert.ok(!args.includes('--share-net'));
});

test('in the real box: no listener of this computer is reached, and only the loopback is there', { skip, timeout: 60_000 }, async () => {
  const targets = {};
  const lo = await listen({ host: '127.0.0.1' });
  targets.loopback = { host: '127.0.0.1', port: lo.address().port };
  if (ownAddress) {
    const own = await listen({ host: ownAddress });
    targets.ownAddress = { host: ownAddress, port: own.address().port };
  }
  const sockFile = path.join(outside, 'session.sock');
  await listen(sockFile);
  targets.socketFile = { path: sockFile };
  const abstract = `\0hoprig-box-test-${process.pid}`;
  await listen(abstract);
  targets.abstract = { path: abstract };
  // Each listener answers from outside: a "no" inside is the box's doing, not a listener that was never up.
  for (const [name, t] of Object.entries(targets)) assert.equal(await reach(t), 'reached', `${name} answers outside`);

  const script = `
    const net = require('net'), os = require('os');
    const targets = ${JSON.stringify(targets)};
    const reach = (t) => new Promise((r) => { const c = net.connect(t); let g = '';
      c.setTimeout(3000, () => (c.destroy(), r('timeout'))); c.on('data', (d) => (g += d)); c.on('end', () => r(g)); c.on('error', (e) => r(e.code)); });
    (async () => {
      const out = { interfaces: Object.keys(os.networkInterfaces()).sort() };
      for (const [k, t] of Object.entries(targets)) out[k] = await reach(t);
      console.log(JSON.stringify(out));
    })();`;
  const r = await runBoxed([process.execPath, '-e', script], { cwd: work, write: [work], timeoutMs: 30_000 });
  assert.equal(r.ok, true, r.why + r.out);
  const seen = JSON.parse(r.out.trim().split('\n').pop());
  for (const name of Object.keys(targets)) assert.notEqual(seen[name], 'reached', `${name} is not reached from inside (${seen[name]})`);
  assert.equal(seen.socketFile, 'ENOENT', 'the folder of a socket outside is not there');
  assert.ok(seen.interfaces.every((n) => n === 'lo'), `only a loopback of its own: ${seen.interfaces}`);
  if (!ownAddress) test.diagnostic('this computer has no address but the loopback: that trial was left out');
});
