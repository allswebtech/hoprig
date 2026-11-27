// The Providers page, easy: the provider rows first, the gateway as one row that opens a page of its own, the limit
// rule as one row that opens a sheet, no intro and no heading over the list, and every old address still lands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const WEB = path.resolve('web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const A = await import('../../web/accounts.js');
const page = () => { const s = read('accounts.js'); return s.slice(s.indexOf('function viewAccounts'), s.indexOf("/** One account's own page")); };
const list = () => { const p = page(); return p.slice(p.indexOf('fill(body,'), p.indexOf('// The old "?show=')); };

test('the gateway row says one word: not installed, stopped, running or needs attention', () => {
  const host = (g) => ({ gateways: g ? [{ id: 'trouteai', defined: false, ...g }] : [] });
  assert.equal(A.gatewayWords(host(null)), 'Not installed');
  assert.equal(A.gatewayWords(host({ installed: false })), 'Not installed');
  assert.equal(A.gatewayWords(host({ installed: true, running: false })), 'Stopped');
  assert.equal(A.gatewayWords(host({ installed: true, running: true })), 'Running');
  assert.equal(A.gatewayWords(host({ installed: true, running: true, problem: 'x' })), 'Needs attention');
  assert.equal(A.gatewayWords(null), '', 'when its state is not known the row says nothing instead of a guess');
});

test('the limit row shows the current choice in the same words as its sheet', () => {
  assert.equal(A.limitChoiceText({ enabled: false }), 'Stop and ask me');
  assert.equal(A.limitChoiceText({ enabled: true }), 'Carry on with the next provider');
  assert.equal(A.limitChoiceText(undefined), 'Stop and ask me');
});

test('the first screen: Add provider, the provider rows, then the gateway row and the limit row; nothing else', () => {
  const l = list();
  const order = [l.indexOf('accounts.map('), l.indexOf("title: 'TRouteAI'"), l.indexOf('limitRow : null')];
  assert.ok(order.every((n) => n >= 0) && order[0] < order[1] && order[1] < order[2], 'providers, then TRouteAI, then At a limit');
  assert.doesNotMatch(page(), /intro:/, 'no intro sentence under the title');
  assert.doesNotMatch(l, /groupHead|fold\(|gatewaysPanel|trouteaiPanel|fixedPanel/, 'no heading, no fold and no gateway card on the page');
  const empty = l.split('\n').find((x) => x.includes('emptyState('));
  assert.ok(empty && !empty.includes('btn('), 'an empty page: one line, and the one Add provider stays in the head');
});

test('the limit rule is behind one row: its choices, order and Advanced are in the sheet, closed at first', () => {
  const s = read('accounts.js');
  assert.match(s, /listRow\(\{ onclick: \(\) => openLimit\(\), icon: 'zap', title: 'At a limit', sub: limitChoiceText\(auto\) \}\)/);
  const body = s.slice(s.indexOf('function limitBody'), s.indexOf('/** Advanced: sessions'));
  for (const w of ["title: 'Stop and ask me'", "title: 'Carry on with the next provider'", "'Order of providers'", "'Also use pay-per-use providers'", "fold('auto-how', 'How it works'", "fold('accounts', 'Advanced', fixedPanel(auto))"]) assert.ok(body.includes(w), w);
  assert.doesNotMatch(body, /open: true/, 'no fold is open at first');
});

test('every old address lands: the gateway cards on the gateway page, the limit fold on the limit sheet', () => {
  for (const id of ['gateways', 'trouteai']) assert.ok(A.GATEWAY_PARTS.includes(id), id);
  for (const id of ['accounts', 'auto-how', 'at-limit']) assert.ok(A.LIMIT_PARTS.includes(id), id);
  assert.match(page(), /location\.replace\(link\('#\/providers\/trouteai'\)\)/);
  assert.match(page(), /if \(sub === 'trouteai'\) return viewTrouteai\(/);
  assert.match(page(), /if \(LIMIT_PARTS\.includes\(part\)\) openLimit\(\)/);
  assert.match(read('errorways.js'), /href: '#\/providers\?show=gateways'/, 'the error words still name the old address, which lands on the gateway page');
});

test('the provider rows are lean: no tools line and no speed line on a row, the speed on the provider page', () => {
  const s = read('accounts.js');
  const row = s.slice(s.indexOf('function accountRow'), s.indexOf('function viewAccounts') );
  assert.doesNotMatch(row, /acct-tools|acct-speed|worksWith|speedWords/);
  assert.match(s, /speedWords\(a\.speed\) \? h\('p\.hint\.acct-speed'/, 'kept on the provider page');
});

test('the settings file warning is one row; its lines and two ways out are in its sheet', async () => {
  const O = await import('../../web/ownendpoint.js');
  assert.equal(O.ownEndpointRow(null, () => {}), null);
  assert.equal(O.ownBackupRow(null, () => {}), null);
  assert.equal(O.ownShort, 'Not used by Claude Code now');
  const src = read('ownendpoint.js');
  assert.match(src, /openSheet\(\{ title: 'Claude Code uses its own address' \}/);
  assert.match(src, /ownEndpointPanel\(o, \(\) => \{ close\(\); done\(\); \}\)/);
});
