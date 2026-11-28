// The address #/providers/trouteai is the gateway's own page, so a new provider can never get that short name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('accounts-name-trouteai');
test.after(() => box.cleanup());

const { cleanNewName } = await import('../../src/server/accounts.mjs');

test('a new provider cannot be named trouteai, in any case', () => {
  for (const n of ['trouteai', 'TRouteAI', ' trouteai ']) {
    assert.throws(() => cleanNewName(n, 'sub2'), (e) => e.status === 400 && /gateway/.test(e.message), n);
  }
});

test('another name still works', () => {
  assert.equal(cleanNewName('trouteai2', 'sub2'), 'trouteai2');
  assert.equal(cleanNewName('', 'sub2'), 'sub2');
});
