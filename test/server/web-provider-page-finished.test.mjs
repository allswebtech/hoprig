// The page of one provider and the gateway's page, finished: the head is drawn once per visit, a press asks again in
// place (the check and the model map are not rebuilt), a slow load says so with Try again, the gateway's list row never
// seems to disagree with a provider row, a stopped gateway says why, and Open TRouteAI from a phone has its press.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [], classList: { add() {}, remove() {} } });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
  remove() {}
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', querySelector: () => null };

const read = (f) => fs.readFileSync(path.resolve('web', f), 'utf8');
const A = await import('../../web/accounts.js');
const { otherWords } = await import('../../web/trouteaipage.js');

test('the head of a provider is drawn once: the second and later calls change the title and the line in place', () => {
  const frames = [];
  const title = { textContent: '' };
  const row = { _line: null, querySelector() { return this._line; }, append(l) { this._line = l; } };
  const was = document.querySelector;
  document.querySelector = (sel) => (frames.length ? (sel === 'main.page .page-title' ? title : sel === 'main.page .pagehead-text' ? row : null) : null);
  try {
    const draw = A.pageHead((o) => frames.push(o), { page: 'providers' }, {});
    draw('Provider');
    draw('Claude Max', 'Subscription · Max');
    draw('Max, renamed', 'Subscription · Max');
    assert.equal(frames.length, 1, 'one frame per visit');
    assert.equal(frames[0].title, 'Provider');
    assert.equal(title.textContent, 'Max, renamed');
  } finally {
    document.querySelector = was;
  }
});

test('a frame that was taken away (another page drew) is drawn again, not changed in place', () => {
  const frames = [];
  const draw = A.pageHead((o) => frames.push(o), {}, {}); // document.querySelector finds nothing
  draw('One');
  draw('Two');
  assert.equal(frames.length, 2);
});

test('the page of one provider keeps its check, model map and what is left across a press', () => {
  const src = read('accounts.js');
  assert.match(src, /let health = null;/);
  assert.match(src, /if \(health\) health\.reload\(\);\s*else health = providerHealth\(n\);/);
  assert.doesNotMatch(src, /providerHealth\(a\.name\)/, 'never a new set of panels per press');
  const ph = read('providerhealth.js');
  assert.match(ph, /box\.reload = load;/);
  // The panels are filled when the answer is there: no "Loading…" put in between.
  assert.equal((ph.match(/Loading…/g) || []).length, 1, 'only the first draw says Loading');
});

test('a press that asks the computer shows busy until the answer is there', () => {
  const src = read('accounts.js');
  assert.match(src, /row\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(src, /act\('lock'[^]*?\}, true\) : null,/, 'keep or share is a quick press');
  assert.match(src, /act\('refresh', 'It is free again'[^]*?\}, true\) : null,/, 'free again is a quick press');
});

test('a load that is slow says so after 8 seconds, with Try again, and a late answer of an older load is dropped', () => {
  assert.equal(A.SLOW_MS, 8000);
  const src = read('accounts.js');
  assert.match(src, /This is taking longer than usual\./);
  assert.match(src, /label: 'Try again'/);
  assert.equal((src.match(/if \(mine !== run\) return;/g) || []).length, 2);
  assert.match(src, /errorBox\(e, load\)/, 'an error of the page of one provider has Try again too');
});

test('long words wrap on the page of one provider: a row line, the intro, a warning under its button on a phone', () => {
  const css = read('page-providers.css');
  assert.match(css, /\.acct-act \.row-sub \{ white-space: normal; overflow-wrap: anywhere; \}/);
  assert.match(css, /\.acct-intro \{ overflow-wrap: anywhere; \}/);
  assert.match(css, /\.card \.banner\.mbanner > \.btn \{ flex: 1 1 100%/);
  assert.match(css, /\.ph-mend \{ flex-wrap: wrap; \}/);
});

test('the gateway row of the list names the provider that uses it and never seems to disagree with one', () => {
  const host = (g) => ({ gateways: [{ id: 'trouteai', defined: false, ...g }] });
  const via = (label) => ({ label, viaGateway: { id: 'trouteai', title: 'TRouteAI' } });
  assert.equal(A.gatewayWords(host({ installed: true, running: true }), [via('API via TRouteAI')]), 'Running · used by API via TRouteAI');
  assert.equal(A.gatewayWords(host({ installed: true, running: true }), [via('A'), via('B'), via('C')]), 'Running · used by A and 2 more');
  assert.equal(A.gatewayWords(host({ installed: true, running: false }), [via('API via TRouteAI')]), 'Stopped · API via TRouteAI cannot answer until it runs');
  assert.equal(A.gatewayWords(host({ installed: true, running: true, problem: 'x' }), [via('A')]), 'Needs attention · A cannot answer until it runs');
  // Another gateway carries the sessions: the line says which.
  assert.equal(A.gatewayWords(host({ installed: true, running: false }), [{ label: 'Mine', viaGateway: { id: 'other', title: 'Other gateway' } }]), 'Stopped · your sessions use Other gateway');
  assert.equal(A.gatewayWords(host({ installed: false }), [via('A')]), 'Not installed');
  assert.equal(A.gatewayWords(host({ installed: true, running: true }), []), 'Running');
});

test('the gateway page names the provider that goes through another gateway', () => {
  assert.equal(otherWords([{ label: 'Work key', viaGateway: { title: 'OtherAI' } }]), 'Work key goes through OtherAI.');
  assert.equal(otherWords([{ label: 'Work key', remote: { title: 'TRouteAI', computer: 'laptop' } }, { label: 'x', viaGateway: { title: 'y' } }]),
    'Work key goes through TRouteAI on laptop, and 1 more through other gateways.');
  const page = read('trouteaipage.js');
  assert.match(page, /\.filter\(\(a\) => \(a\.viaGateway && a\.viaGateway\.id !== ID\) \|\| a\.remote\)/);
});

test('a stopped gateway says what Start does and shows the end of its log', () => {
  const page = read('trouteaipage.js');
  assert.match(page, /parts\.push\(whyStopped\(ctx\), addSharedRow\(load\), manageFold\(ctx, gw\)\)/);
  assert.match(page, /Start runs it on port \$\{ctx\.g\.port\}, listening on \$\{ctx\.computer\} only\./);
  assert.match(page, /api\(T\('\/log'\)\)/);
});

test('Open TRouteAI from a phone with the public address off has a press that goes to the Public address', () => {
  const page = read('trouteaipage.js');
  assert.match(page, /label: 'Go to Public address', onclick: goPublic/);
  assert.match(page, /pubFold\.open = true;/);
  assert.match(read('trouteai.js'), /state\.goPublic \? btn\('small secondary', \{ label: 'Go to Public address'/);
});

test('the gateway page says where its other settings are, and Add a shared gateway is there without TRouteAI set up', () => {
  const page = read('trouteaipage.js');
  assert.match(page, /Its other settings are on its own page: the button opens it, signed in\./);
  assert.ok((page.match(/addSharedRow\(load\)/g) || []).length >= 4, 'not installed, stopped, not answering and not shared');
  assert.match(read('gateways.js'), /export const addSharedRow = /);
});

test('a stopped gateway that a provider goes through says those sessions cannot answer', () => {
  assert.match(read('trouteaipage.js'), /g\.running \? null : ', so they cannot answer until it runs\.'/);
});
