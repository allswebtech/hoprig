// Health: the sign-out it asks for is a link to About's This device panel, not "Settings → This device" in words.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('"Sign out under one of them" links to #/settings/about?show=this-device', () => {
  const s = fs.readFileSync(new URL('../../web/health.js', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /Settings → This device/);
  assert.match(s, /Sign out under one of them \(`, h\('a', \{ href: link\('#\/settings\/about\?show=this-device'\) \}, 'This device'\), '\), then press Open its page again\.'/);
  // The panel that address names is there.
  assert.match(fs.readFileSync(new URL('../../web/settings.js', import.meta.url), 'utf8'), /panel\(\{ id: 'this-device'/);
});
