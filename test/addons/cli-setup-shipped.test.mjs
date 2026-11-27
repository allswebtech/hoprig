// `hoprig addons setup trouteai` asks nothing and needs no terminal: it runs the one set-up function and says one
// sentence at the end (src/addons/cli.mjs setupShipped).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('cli-setup');
test.after(() => box.cleanup());
const { setupShipped } = await import('../../src/addons/cli.mjs');

const capture = async (fn) => {
  const said = [];
  const log = console.log;
  const e = console.error;
  console.log = (t) => said.push(String(t));
  console.error = (t) => said.push(`ERR ${t}`);
  try {
    return { code: await fn(), said };
  } finally {
    console.log = log;
    console.error = e;
  }
};

test('it runs the set-up function with this computer\'s name and prints no key', async () => {
  const seen = [];
  const { code, said } = await capture(() => setupShipped({ id: 'trouteai', title: 'TRouteAI' }, { computer: 'box9', setup: async ({ computer, onLine }) => (seen.push(computer), onLine('Starting…'), { ok: true, kept: false, name: 'api' }) }));
  assert.equal(code, 0);
  assert.deepEqual(seen, ['box9']);
  assert.match(said[0], /TRouteAI is set up: the provider api uses the key "Hoprig sessions \(box9\)"/);
});

test('a failure is one sentence on the error output and the exit code is 1', async () => {
  const { code, said } = await capture(() => setupShipped({ id: 'trouteai', title: 'TRouteAI' }, { computer: 'box9', out: () => {}, setup: async () => ({ ok: false, error: 'It did not start. Next step: read the log.' }) }));
  assert.equal(code, 1);
  assert.deepEqual(said, ['ERR It did not start. Next step: read the log.']);
});
