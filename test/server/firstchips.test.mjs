// A session's first look: the quick-message chips leave out /compact and /model; the key bar folds where there is a mouse.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { DEFAULT_QUICK_ACTIONS } = await import('../../src/server/settings.mjs');

test('the default chips are continue and /clear, without /compact and /model', () => {
  assert.deepEqual(DEFAULT_QUICK_ACTIONS.map((q) => q.label), ['continue', '/clear']);
});

test('the key bar starts folded behind Keys on a computer with a mouse, open on a phone', () => {
  const s = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'session.js'), 'utf8');
  assert.match(s, /let keysOn = prefs\.get\('session\.keys', !finePointer\);/);
});
