// Settings → Public link: the Temporary card says who carries the link and what changes, without "cloudflared",
// "quick tunnel" or "helper"; the Custom card keeps the server's words.
import assert from 'node:assert/strict';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
const { kindWords } = await import('../../web/publiclink.js');

test('the Temporary card: a small free program from Cloudflare, a new address each time the computer starts', () => {
  const t = kindWords({ id: 'temporary', title: 'Temporary', text: 'x', needs: 'Nothing. Hoprig installs Cloudflare\'s free helper (cloudflared) the first time you turn it on.', gives: 'An https://….trycloudflare.com address through Cloudflare\'s free quick tunnel.' });
  assert.equal(t.needs, 'Nothing. The first time, Hoprig downloads a small free program from Cloudflare (the company that carries the link).');
  assert.match(t.gives, /a new address each time the computer starts\.$/);
  assert.doesNotMatch(`${t.needs} ${t.gives}`, /cloudflared|quick tunnel|helper/);
  assert.equal(t.title, 'Temporary');
  const c = { id: 'custom', title: 'Custom', needs: 'A domain', gives: 'The same' };
  assert.deepEqual(kindWords(c), c, 'Custom: as the server says');
});
