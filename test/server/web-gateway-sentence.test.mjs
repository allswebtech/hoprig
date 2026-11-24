// The Providers page's gateway panel opens with one sentence for a person, not a programmer; the OpenCode condition
// is said on the Add a shared gateway sheet instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync(new URL('../../web/gateways.js', import.meta.url), 'utf8');

test('the gateway panel says what a gateway is for in plain words', () => {
  assert.match(src, /desc: 'A gateway lets Claude Code use AI accounts of other companies\. Use one on this computer or on another of yours\.'/);
  assert.doesNotMatch(src, /finds the APIs it needs/);
  const sheet = src.slice(src.indexOf('function addSheet'), src.indexOf('export function gatewaysPanel'));
  assert.match(sheet, /OpenCode can use it too, when Test on its provider finds what OpenCode needs\./);
});
