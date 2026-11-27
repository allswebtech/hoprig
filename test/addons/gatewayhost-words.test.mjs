// What the gateways list says on a computer in a state the other tests do not make: a copy installed with npm whose
// program the service search cannot find, and the gateway running. One row must not say both "in use" and "not installed".
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewayhostwords');
test.after(() => box.cleanup());
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
const { servicePlan } = await import('../../src/addons/gatewayservice.mjs');

class HttpError extends Error {}
const env = { PATH: path.join(box.root, 'nothing-here'), XDG_CONFIG_HOME: path.join(box.home, '.config') }; // seal: only servicePlan's input
const relay = (status) => ({ id: 'relay', title: 'Relay', defined: false, command: () => ['relay-not-on-the-path', '--port', '8197'], gateway: { port: () => 8197 }, status: async () => status, start: async () => ({ ok: true }), stop: async () => ({ ok: true }) });
const rowOf = async (status) => {
  const feature = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { run: async () => ({ ok: true, stdout: '', stderr: '' }), addons: () => [relay(status)], computer: () => 'box2', plan: (a) => servicePlan(a, { platform: 'linux', env, home: box.home }) });
  const [, , fn] = feature.routes.find(([m, re]) => m === 'GET' && re.test('/api/gatewayhost'));
  return (await fn({ body: {}, caller: 'page' }, [])).gateways[0];
};

test('a copy that is installed and running is never also said to be not installed', async () => {
  const g = await rowOf({ installed: true, running: true, copy: 'global' });
  assert.equal(g.installed, true);
  assert.ok(!/not installed/i.test(g.service.sentence || ''), g.service.sentence);
  assert.ok(g.service.sentence, 'the row still says why no service is offered');
});

test('no copy at all: the service says install it first', async () => {
  const g = await rowOf({ installed: false, running: false });
  assert.match(g.service.sentence, /not installed on this computer: install it first/);
});

test('the note that its copy was updated after it started reaches the row', async () => {
  const note = 'The copy on this computer was updated after Relay was started: restart it to run 1.0.11';
  assert.equal((await rowOf({ installed: true, running: true, copy: 'global', restart: note })).restart, note);
  assert.equal((await rowOf({ installed: true, running: true, copy: 'global' })).restart, undefined);
});
