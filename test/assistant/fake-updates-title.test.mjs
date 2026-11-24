// The fake dashboard's Updates list names cloudflared as the real list does (src/automation/updateitems.mjs), so a
// test of Tia's words about updates reads the words a person sees.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the fake names cloudflared "The helper for the public link (cloudflared)", as Settings → Updates does', () => {
  const real = fs.readFileSync(new URL('../../src/automation/updateitems.mjs', import.meta.url), 'utf8');
  const fake = fs.readFileSync(new URL('./fake-dashboard.mjs', import.meta.url), 'utf8');
  const title = /id: 'cloudflared',\s*title: '([^']+)'/.exec(real)[1];
  assert.equal(title, 'The helper for the public link (cloudflared)');
  assert.match(fake, /\{ id: 'cloudflared', title: 'The helper for the public link \(cloudflared\)'/);
  assert.doesNotMatch(fake, /Tunnel helper/);
});
