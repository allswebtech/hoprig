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

test('an OK she answered in her Work run: what it asked, and why it was hers; the switch in her settings line', () => {
  const chat = (x) => (x === 'chat:a1' ? 'the App session "Fix the cart total"' : x);
  const w = activityWords({ tool: 'send_to_chat', input: { session: 'chat:a1', answer: 'allow' }, result: { herWork: true, asked: 'npm test' } }, { ...p, chat });
  assert.equal(w.what, 'answered an OK in the App session "Fix the cart total": allowed npm test');
  assert.match(w.detail, /because you let her answer the OKs of her Work runs \(Settings → Tia\), and it only looks inside the project or runs its own checks/);
  // Any other answer of hers reads as before.
  assert.equal(activityWords({ tool: 'send_to_chat', input: { session: 'chat:a1', answer: 'allow' } }, { ...p, chat }).what, 'allow what the App session "Fix the cart total" asks');
  assert.match(activityWords({ tool: 'tia_settings', input: { answersHers: true } }, p).detail, /she answers the OKs of her Work runs: on/);
  assert.match(activityWords({ tool: 'tia_settings', input: { answersHers: false } }, p).detail, /she answers the OKs of her Work runs: off/);
});
