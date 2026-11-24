// The Temporary kind of the public link in plain words (the terminal shows the server's own words): who carries the
// link, and that the address changes; no "quick tunnel".
import assert from 'node:assert/strict';
import test from 'node:test';
import { KIND_WORDS } from '../../src/addons/linkswitch.mjs';

test('words: the Temporary link names its carrier plainly, never a quick tunnel', () => {
  const { gives } = KIND_WORDS.temporary;
  assert.doesNotMatch(gives, /quick tunnel|tunnel/i);
  assert.match(gives, /Cloudflare, the company that carries the link/);
  assert.match(gives, /trycloudflare\.com/);
  assert.match(gives, /changes whenever Hoprig or the computer restarts/);
});
