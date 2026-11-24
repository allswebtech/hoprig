// What `hoprig gateways` shows is on the page: GET /api/gateways tells the owner's page what a gateway runs and why a
// program of his own waits for his confirmation; another computer's machine token is not told.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gateway-runs');
test.after(() => box.cleanup());
const { gatewayFeature } = await import('../../src/gateway/index.mjs');

const addon = (over = {}) => ({
  id: 'relay', title: 'Relay', gateway: { port: () => 1 },
  status: async () => ({ installed: false, version: null, needsConfirm: 'changed' }),
  answering: async () => ({ up: false, mine: false }),
  command: () => ['/opt/relay/bin/relay', '--port', '1'],
  ...over,
});
const ctx = { authed: (req) => req.owner === true, readJson: async () => ({}), clientIp: () => '127.0.0.1' };
async function list(addons, owner) {
  const f = gatewayFeature(ctx, { addons });
  const [, , run] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/gateways'));
  return run({ owner, headers: {} }, null);
}

test('the owner\'s page reads the program a gateway runs and why it waits', async () => {
  const r = await list([addon()], true);
  assert.deepEqual(r.gateways[0].runs, ['/opt/relay/bin/relay', '--port', '1']);
  assert.equal(r.gateways[0].needsConfirm, 'changed');
});

test('a machine token of another computer is not told the program', async () => {
  const g = (await list([addon()], false)).gateways[0];
  assert.equal('runs' in g, false);
  assert.equal('needsConfirm' in g, false);
});

test('an add-on that cannot say what it runs gives null, not an error', async () => {
  const g = (await list([addon({ command: () => { throw new Error('no'); }, status: async () => ({ installed: false }) })], true)).gateways[0];
  assert.equal(g.runs, null);
  assert.equal(g.needsConfirm, null);
});
