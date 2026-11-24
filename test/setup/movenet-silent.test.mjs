// The move's look at the network (reachAll in src/setup/movenet.mjs) with the REAL fetch, against a host that takes
// the connection and never answers: the look must end after its own time with that host unreached, neither early
// (the process ending while the look still waits) nor hung. The host is a server of this test's own on 127.0.0.1,
// on a port the system picks; never the network. The server and the connections it takes are unref'd, so the only
// thing that keeps this process alive while the look waits is the look itself (its fetch and its time limit).
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

const N = await import('../../src/setup/movenet.mjs');

/** A server on 127.0.0.1 that accepts each connection and says nothing; `end()` destroys them and closes it. */
async function silentServer() {
  const kept = new Set();
  let taken = 0;
  const srv = net.createServer((sock) => {
    taken += 1;
    kept.add(sock);
    sock.unref();
    sock.on('error', () => {});
    sock.on('close', () => kept.delete(sock));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const { port } = srv.address();
  return {
    port,
    taken: () => taken,
    end: () => new Promise((r) => {
      for (const s of kept) s.destroy();
      srv.close(() => r());
    }),
  };
}

test('a host that takes the connection and never answers: the look ends after its time, with that host unreached', { timeout: 15_000 }, async () => {
  const silent = await silentServer();
  try {
    const host = `127.0.0.1:${silent.port}`;
    const ms = 800;
    const t0 = Date.now();
    const r = await N.reachAll([{ host, url: `http://${host}/` }], { ms });
    const took = Date.now() - t0;
    assert.deepEqual(r, { ok: false, unreached: [host] });
    assert.ok(silent.taken() >= 1, 'the connection was taken by the silent server');
    assert.ok(took >= ms - 50, `not early: ${took} ms for a limit of ${ms} ms`);
    assert.ok(took < ms + 4000, `not hung: ${took} ms for a limit of ${ms} ms`);
  } finally {
    await silent.end();
  }
});

test('several silent hosts are asked at once: the look ends after one limit, not one after the other', { timeout: 15_000 }, async () => {
  const a = await silentServer();
  const b = await silentServer();
  try {
    const needs = [a, b].map((s) => ({ host: `127.0.0.1:${s.port}`, url: `http://127.0.0.1:${s.port}/` }));
    const ms = 800;
    const t0 = Date.now();
    const r = await N.reachAll(needs, { ms });
    const took = Date.now() - t0;
    assert.deepEqual(r, { ok: false, unreached: needs.map((n) => n.host) });
    assert.ok(a.taken() >= 1 && b.taken() >= 1, 'each silent server took its connection');
    assert.ok(took >= ms - 50, `not early: ${took} ms`);
    assert.ok(took < 2 * ms, `at once, not one after the other: ${took} ms`);
  } finally {
    await a.end();
    await b.end();
  }
});
