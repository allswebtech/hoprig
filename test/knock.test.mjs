// Whether something listens at an address, three ways (src/knock.mjs): "not running" is only an address that refuses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { knock } from '../src/knock.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knock-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const serve = (where) => new Promise((r) => { const s = net.createServer(() => {}).listen(where, () => r(s)); });
/** This process held up for `ms` (a computer under load runs it late), as one piece of synchronous work. */
const heldUp = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('open, closed: a port and a Unix socket', async () => {
  assert.equal(await knock({ port: await freePort(), host: '127.0.0.1' }), 'closed');
  const tcp = await serve({ port: 0, host: '127.0.0.1' });
  assert.equal(await knock({ port: tcp.address().port, host: '127.0.0.1' }), 'open');
  tcp.close();
  const sock = path.join(tmp, 's.sock');
  assert.equal(await knock({ path: sock }), 'closed', 'no such socket');
  const unix = await serve(sock);
  assert.equal(await knock({ path: sock }), 'open');
  unix.close();
});

test('an answer that came while this process was held up is an answer, not "silent"', async () => {
  const tcp = await serve({ port: 0, host: '127.0.0.1' });
  const sock = path.join(tmp, 'late.sock');
  const unix = await serve(sock);
  try {
    for (const target of [{ port: tcp.address().port, host: '127.0.0.1' }, { path: sock }]) {
      const said = knock(target, 200);
      // Node starts a TCP connection on the next tick: the process is held up after the connection was asked for,
      // so its answer comes while it is held (without this the hold came first, and macOS then had no answer yet).
      await new Promise((r) => process.nextTick(r));
      heldUp(600); // longer than the time it was given
      assert.equal(await said, 'open', JSON.stringify(target));
    }
  } finally {
    tcp.close();
    unix.close();
  }
});

test('silent: a program that listens but takes no more connections', { skip: process.platform !== 'linux' && 'a full queue makes a connect wait on Linux; elsewhere it may be refused' }, async () => {
  // A paused program with a short queue: once the queue is full, a connect to its port waits, and one to its Unix
  // socket is refused at once with EAGAIN. Neither means it is gone.
  const sock = path.join(tmp, 'busy.sock');
  const c = spawn(process.execPath, ['-e', `const net = require('net');
    const a = net.createServer(() => {}).listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
      net.createServer(() => {}).listen({ path: ${JSON.stringify(sock)}, backlog: 1 }, () => console.log(a.address().port));
    });`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const held = [];
  try {
    const port = Number(await new Promise((r) => c.stdout.once('data', (d) => r(String(d).trim()))));
    assert.equal(await knock({ port, host: '127.0.0.1' }), 'open');
    process.kill(c.pid, 'SIGSTOP');
    for (const target of [{ port, host: '127.0.0.1' }, { path: sock }]) {
      let said = 'open';
      for (let i = 0; i < 20 && said === 'open'; i++) {
        held.push(net.connect(target).on('error', () => {}));
        said = await knock(target, 500);
      }
      assert.equal(said, 'silent', JSON.stringify(target));
    }
  } finally {
    for (const s of held) s.destroy();
    c.kill('SIGKILL');
  }
});
