// The TRouteAI page is reached from the one row on Providers (#/providers/trouteai), and the old address of the gateway
// cards (#/providers?show=gateways) lands on it; the page is drawn once and no gateway card is drawn on Providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FakeElement } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/', replace() {} };
globalThis.history ||= { replaceState() {} };
globalThis.window ||= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
const { pageById } = await import('../../web/registry.js');
await import('../../web/accounts.js');
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const all = (n, ok) => (n && n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);

test('the row on Providers links to #/providers/trouteai, and that address draws the page of its own once', () => {
  const acc = read('accounts.js');
  assert.match(acc, /listRow\(\{ href: link\('#\/providers\/trouteai'\)/);
  let drawn = [];
  const stop = pageById('providers').render({ frame: (o) => drawn.push(o), sub: 'trouteai', query: new URLSearchParams() });
  assert.equal(drawn.length, 1, 'one frame');
  assert.equal(drawn[0].title, 'TRouteAI');
  assert.equal(drawn[0].back, '#/providers');
  const body = drawn[0].body.filter(Boolean);
  assert.equal(body.length, 1);
  assert.ok(body[0].className.includes('tr-page') || all(body[0], (n) => n.className.includes('tr-page')).length === 1, 'the page of its own, once');
  assert.equal(typeof stop, 'function');
  stop();
});

test('#/providers?show=gateways and ?show=trouteai land on the page; nothing else draws a gateway card', () => {
  for (const part of ['gateways', 'trouteai']) {
    const went = [];
    const was = globalThis.location.replace;
    globalThis.location.replace = (u) => went.push(u);
    pageById('providers').render({ frame() {}, sub: '', query: new URLSearchParams(`show=${part}`) });
    globalThis.location.replace = was;
    assert.deepEqual(went, ['#/providers/trouteai'], part);
  }
  for (const f of fs.readdirSync(new URL('../../web/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    assert.doesNotMatch(src, /trouteaiPanel/, `${f}: the old TRouteAI card is gone`);
  }
  assert.ok(FakeElement);
});

test('the panel of the gateways on your computers has Use here; the gateway page does not repeat it', () => {
  const gateways = read('gateways.js');
  assert.match(gateways, /panel\(\{ id: 'gateways', icon: 'swap', title: 'Gateways on your computers'/);
  assert.match(gateways, /label: 'Use here'/);
  assert.doesNotMatch(read('trouteaipage.js'), /otherComputers|Gateways on your computers/);
});
