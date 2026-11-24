// The sign-in page's head speaks to a person, not a programmer: what Hoprig holds, in plain words.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('../../web/login.html', import.meta.url), 'utf8');

test('the sign-in page says what it opens in plain words', () => {
  const sub = /<p class="login-sub">([^<]*)<\/p>/.exec(page);
  assert.ok(sub, 'the page has its subtitle');
  assert.equal(sub[1], 'Your coding sessions, on this computer and your other computers', 'the name Home uses for them');
  assert.doesNotMatch(sub[1], /Claude Code sessions|linked to it/);
});
