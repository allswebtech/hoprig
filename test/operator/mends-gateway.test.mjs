// The three mends her acts call, as functions in the server (src/operator/mends.mjs): restart and stop a gateway
// add-on, and look at whether a provider or gateway answers. They never go through a route or her door. A stop on
// the owner's tap is his own stop (the Operator's rule leaves it stopped); a restart clears that mark.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('mends-gateway');
test.after(() => box.cleanup());
const M = await import('../../src/operator/mends.mjs');
const { stoppedAt } = await import('../../src/addons/stopmark.mjs');

const addon = (over = {}) => {
  const calls = [];
  return { calls, id: 'gw1', title: 'Gateway one', gateway: { port: () => 8197 }, stop: async () => (calls.push('stop'), { ok: true }), start: async () => (calls.push('start'), { ok: true }), ...over };
};

test('the three mends exist as functions', () => {
  for (const n of ['restartGateway', 'stopGateway', 'probeProvider']) assert.equal(typeof M[n], 'function', n);
});

test('a restart stops and starts the gateway once', async () => {
  const a = addon();
  const r = await M.restartGateway({ id: 'gw1' }, { find: () => a });
  assert.deepEqual(a.calls, ['stop', 'start']);
  assert.equal(r.ok, true);
});

test('a restart of a gateway that is not there, or that does not stop, says so and starts nothing', async () => {
  const gone = await M.restartGateway({ id: 'nope' }, { find: () => null });
  assert.equal(gone.ok, false);
  assert.match(gone.said, /no such/);
  const a = addon({ stop: async () => ({ ok: false, error: 'its service runs it' }) });
  const held = await M.restartGateway({ id: 'gw1' }, { find: () => a });
  assert.equal(held.ok, false);
  assert.match(held.said, /service runs it/);
  assert.equal(a.calls.includes('start'), false);
});

test('a stop stops it once and is noted as the owner own stop', async () => {
  const a = addon();
  const r = await M.stopGateway({ id: 'gw1' }, { find: () => a });
  assert.deepEqual(a.calls, ['stop']);
  assert.equal(r.ok, true);
  assert.ok(stoppedAt('gw1') != null, 'the Operator rule leaves it stopped');
  await M.restartGateway({ id: 'gw1' }, { find: () => a });
  assert.equal(stoppedAt('gw1'), null, 'a start clears it');
});

test('a probe looks at the gateway address on this computer and sends nothing else', async () => {
  const seen = [];
  const r = await M.probeProvider({ name: 'gw1' }, { find: () => addon(), probe: async (address) => (seen.push(address), { state: 'answers', status: 200 }) });
  assert.deepEqual(seen, ['127.0.0.1:8197']);
  assert.equal(r.up, true);
  const down = await M.probeProvider({ name: 'gw1' }, { find: () => addon(), probe: async () => ({ state: 'closed', status: 0 }) });
  assert.equal(down.up, false);
  const none = await M.probeProvider({ name: 'zz' }, { find: () => null, probe: async () => assert.fail('nothing to look at'), profile: () => null });
  assert.equal(none.ok, false);
});
