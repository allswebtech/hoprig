// Tia's activity line names the public link's helper as Settings → Updates does, never "the tunnel helper".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.location ||= { hash: '#/tia', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {} });
const { activityWords } = await import('../../web/tiaactivity.js');
const p = { computer: (x) => x, provider: (x) => x };

test('an update of cloudflared in Activity: the helper for the public link, the words of Updates', () => {
  const w = activityWords({ tool: 'manage_computer', input: { action: 'update', item: 'cloudflared' } }, p);
  assert.equal(w.what, 'update the helper for the public link (cloudflared)');
  const strings = fs.readFileSync(new URL('../../web/tiaactivity.js', import.meta.url), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
  for (const s of strings) assert.doesNotMatch(s, /tunnel helper/i, s);
  assert.match(fs.readFileSync(new URL('../../web/updates.js', import.meta.url), 'utf8'), /the helper for the public link \(cloudflared\)/);
});
