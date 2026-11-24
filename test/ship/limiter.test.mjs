// The limiter's field in Settings → Go live (src/ship/feature.mjs, web/ship.js): the owner's own words, confirmed for
// exactly what the sheet showed him (a change asks again), kept per computer; empty clears it. Only from his page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tempShip } from './helpers.mjs';

const t = tempShip('ship-limiter');
test.after(() => t.cleanup());
const { shipFeature } = await import('../../src/ship/feature.mjs');
const { limiterOf } = await import('../../src/ship/allow.mjs');
const { saveConfig, loadConfig } = await import('../../src/config.mjs');

let body = null;
const f = shipFeature({ config: () => ({}), caller: () => 'page', readJson: async () => body, backend: { list: async () => [] } }, { projectsDir: () => t.projects });
const route = (method, url) => {
  const r = f.routes.find(([m, re]) => m === method && re.test(url));
  return (b) => ((body = b), r[2]({ method, url, headers: { host: '127.0.0.1' } }, r[1].exec(url)));
};
const get = route('GET', '/api/ship/limiter');
const post = route('POST', '/api/ship/limiter');

test('set from the page: confirmed for exactly the words shown; changed by hand it is no longer confirmed; empty clears', async () => {
  assert.deepEqual(await get(), { run: null, shown: null, confirmed: false });
  await assert.rejects(post({ run: ['nice', '-n', '15'], seen: 'nice -n 19' }), (e) => e.status === 409 && e.details.code === 'changed');
  assert.equal(limiterOf().run, null, 'nothing kept for words he was not shown');
  await assert.rejects(post({ run: 'nice -n 15', seen: 'nice -n 15' }), (e) => e.status === 400, 'a line of text is refused');
  const set = await post({ run: ['nice', '-n', '15'], seen: 'nice -n 15' });
  assert.deepEqual(set, { run: ['nice', '-n', '15'], shown: 'nice -n 15', confirmed: true });
  assert.deepEqual(limiterOf(), { run: ['nice', '-n', '15'], allowed: true });
  const s = loadConfig().ship;
  saveConfig({ ship: { ...s, limiter: { ...s.limiter, run: ['sh', '-c', 'anything'] } } });
  assert.deepEqual(await get(), { run: ['sh', '-c', 'anything'], shown: 'sh -c anything', confirmed: false }, 'a change by hand asks again');
  assert.deepEqual(await post({ run: null }), { run: null, shown: null, confirmed: false });
  assert.equal(limiterOf().run, null);
  assert.deepEqual(t.trapped(), []);
});
