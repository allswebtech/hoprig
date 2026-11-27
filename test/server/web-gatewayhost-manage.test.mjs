// The page and the server agree on the gateway's own acts: every address Health and Providers call under
// /api/gatewayhost/<id>/ is a route the server answers (src/addons/gatewayhost.mjs), Set up shows only for the gateway
// Hoprig sets up itself, and the page never asks the server for a key or sends the owner's new password anywhere but
// the one route that takes it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('web-gwmanage');
test.after(() => box.cleanup());
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
const { hasSetUp } = await import('../../src/gateway/trouteai.mjs');

class HttpError extends Error {}
const feature = gatewayHostFeature({ HttpError, readJson: async () => ({}) }, { addons: () => [] });

test('every /api/gatewayhost/<id>/<act> the pages call is a route of the server', () => {
  const used = new Set();
  for (const f of ['health.js', 'gateways.js']) {
    for (const m of read(f).matchAll(/\/api\/gatewayhost\/\$\{g\.id\}\/([a-z/]+)/g)) used.add(m[1]);
  }
  for (const act of ['restart', 'log', 'password', 'setup', 'setup/job']) assert.ok(used.has(act), `the page calls ${act}`);
  assert.ok(!used.has('remove'), 'Remove is the add-on\'s own route (/api/addons/<id>/remove), not a second one here');
  for (const act of used) {
    const hit = feature.routes.some(([, re]) => re.test(`/api/gatewayhost/trouteai/${act}`));
    assert.ok(hit, `the server answers /api/gatewayhost/<id>/${act}`);
  }
});

test('Set up is offered for the shipped gateway only, never for one the owner defined', () => {
  assert.equal(hasSetUp({ id: 'trouteai' }), true);
  assert.equal(hasSetUp({ id: 'trouteai', defined: true }), false);
  assert.equal(hasSetUp({ id: 'mine', defined: true }), false);
  assert.equal(hasSetUp(null), false);
  assert.match(read('accounts.js'), /if \(g\.setup\)/);
});

test('the page keeps no key: it reads none from the server and the new password goes only to the password route', () => {
  const src = read('health.js') + read('gateways.js');
  assert.ok(!/\/api\/keys|command token|cli-token/.test(src.replace(/Keys? of|key for/gi, '')), 'no call to the gateway\'s key list');
  const sends = [...src.matchAll(/password: pw/g)];
  assert.equal(sends.length, 1);
});

test('Set up asks its question inside the block, not in a second sheet: a second sheet would take the block and its lines away', () => {
  const src = read('gateways.js');
  const block = src.slice(src.indexOf('export function setupBlock'));
  assert.ok(!/confirmSheet/.test(block.slice(0, block.indexOf('\n}\n'))), 'setupBlock does not open a confirm sheet');
  assert.match(block, /Set up on \$\{computer\}/);
});

test('the Set up block draws the provider list again with the wizard\'s own done, not a name that is not in its scope', () => {
  const src = read('accounts.js');
  const at = src.indexOf('setupBlock(g, {');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 200), /done: \(\) => done\(\)/);
});

test('"how it listens" is said once on Health, in the gateway\'s row, not again under its log', () => {
  const src = read('health.js');
  assert.equal([...src.matchAll(/h\('p\.hint', r\.listens\)/g)].length, 0);
  assert.equal([...src.matchAll(/g\.listens/g)].length, 2);
});
