// GET /api/gateways asks each gateway's status once per answer: status() runs the gateway's own program for its
// version, so asking twice doubles that work on every look at the Providers page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

sandbox('gateway-status-once');
const { gatewayFeature } = await import('../../src/gateway/index.mjs');

function standIn() {
  const calls = { status: 0 };
  const addon = {
    id: 'examplegw', title: 'Example gateway',
    gateway: { port: () => 1 }, // nothing listens there
    status: async () => {
      calls.status += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { installed: true, version: '1.0.0' };
    },
    answering: async () => ({ up: false, mine: false }),
    command: () => ['examplegw', 'serve'],
  };
  return { addon, calls };
}

for (const owner of [true, false]) {
  test(`GET /api/gateways asks the status once (${owner ? "the owner's page" : "another computer's token"})`, async () => {
    const { addon, calls } = standIn();
    let t = 0;
    const f = gatewayFeature({ authed: () => owner }, { addons: [addon], now: () => (t += 60_000) }); // every read is past the cache
    const route = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/gateways'));
    const r = await route[2]({ headers: {} });
    assert.equal(r.gateways.length, 1);
    assert.equal(r.gateways[0].version, '1.0.0');
    if (owner) assert.deepEqual(r.gateways[0].runs, ['examplegw', 'serve']);
    assert.equal(calls.status, 1, `status() ran ${calls.status} times for one answer`);
  });
}
