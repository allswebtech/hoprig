// The OpenCode condition is said on the Add a shared gateway sheet, which is reached from TRouteAI's page (its fold
// Share with your other computers), not in a first sentence of a card.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('../../web/gateways.js', import.meta.url), 'utf8');

test('the Add a shared gateway sheet says the OpenCode condition and where the other computer makes the key', () => {
  const sheet = src.slice(src.indexOf('function addSheet'), src.indexOf('export function setupBlock') > 0 ? src.indexOf('/**\n * Providers → Other providers') : undefined);
  assert.match(sheet, /OpenCode can use it too, when Test on its provider finds what OpenCode needs\./);
  assert.match(sheet, /open Providers → the gateway → Share with your other computers/);
  assert.doesNotMatch(src, /finds the APIs it needs/);
});

test('the Add a shared gateway button is in the sharing fold of the TRouteAI page', () => {
  assert.match(src, /label: 'Add a shared gateway', onclick: \(\) => addSheet\(reload\)/);
});
