// The Providers page: the provider rows first, the gateway as one row that opens a page of its own, the limit rule and
// the settings-file warning on the page itself as before, no intro, and every old address still lands.
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

test('the first screen: the answer (summary, groups, gateway) first, then the limit panel and the gateways on your computers', () => {
  const l = list();
  const order = [l.indexOf('answer,'), l.indexOf('limit,'), l.indexOf('gatewaysPanel({ useLocal:')];
  assert.ok(order.every((n) => n >= 0) && order[0] < order[1] && order[1] < order[2], 'the answer, then the limit rule, then the gateways');
  const p = page();
  assert.match(p, /groups\.map\(\(g\) => \[groupHead\(g\.title, g\.rows\.length\)/, 'one heading with its count over each group of rows');
  assert.match(p, /here \? \[groupHead\('Gateway'\), h\('div\.rows', listRow\(\{ href: link\('#\/providers\/trouteai'\), icon: 'swap', title: 'TRouteAI'/, 'the gateway row is its own group under the accounts');
  assert.doesNotMatch(p, /intro:/, 'no intro sentence under the title');
  assert.doesNotMatch(l, /trouteaiPanel|fixedPanel/, 'no gateway card on the page');
  assert.match(p, /h\('div\.prov-grid'/, 'two columns from 900 px: the answer, and the limit rule with the gateways');
  assert.match(l, /here \? gatewaysPanel\(\{ useLocal:/, 'the panel of the gateways on your computers, with Use here');
  const g = read('gateways.js');
  assert.match(g, /return panel\(\{ id: 'gateways', icon: 'swap', title: 'Gateways on your computers'/, 'the gateways are an open panel on the list, as before');
  assert.doesNotMatch(g, /fold\('gateways'/, 'no closed fold around the gateway rows: Use here is not one press further');
  // An empty page keeps the Add provider button it had before, as well as the one in the head.
  assert.match(l, /emptyState\('user'[^]*?here \? btn\('primary', \{ icon: 'plus', label: 'Add provider'/);
});

test('the limit rule is on the page: its choices, how it works, the order and Advanced, no press away', () => {
  const s = read('accounts.js');
  assert.match(s, /panel\(\{ id: 'at-limit', icon: 'zap', title: 'When an account reaches its limit' \}, limitBody\(/);
  assert.doesNotMatch(page(), /openLimit/, 'no sheet behind a row any more');
  const body = s.slice(s.indexOf('function limitBody'), s.indexOf('/** Advanced: sessions'));
  for (const w of ["title: 'Stop and ask me'", "title: 'Carry on with the next provider'", "'Order of providers'", "'Also use pay-per-use providers'", "fold('auto-how', 'How it works'", "fold('limit-advanced', 'Advanced', fixedPanel(auto))"]) assert.ok(body.includes(w), w);
  assert.doesNotMatch(body, /open: true/, 'no fold is open at first');
});

test('every old address lands: the gateway cards on the gateway page, the limit fold on the limit panel', () => {
  for (const id of ['gateways', 'trouteai']) assert.ok(A.GATEWAY_PARTS.includes(id), id);
  for (const id of ['accounts', 'auto-how', 'at-limit']) assert.ok(A.LIMIT_PARTS.includes(id), id);
  assert.match(page(), /location\.replace\(link\('#\/providers\/trouteai'\)\)/);
  assert.match(page(), /if \(sub === 'trouteai'\) return viewTrouteai\(/);
  assert.match(page(), /if \(LIMIT_PARTS\.includes\(part\)\) showPart\('at-limit'/);
  assert.match(read('errorways.js'), /'gateway-no-provider': \{ label: 'Providers', href: '#\/providers' \}/, 'the gateway errors lead to the Providers page: the fold of other computers\' gateways is gone');
});

test('a provider row keeps its Works with line where it is news, and a slow or refusing speed line', () => {
  const s = read('accounts.js');
  const row = s.slice(s.indexOf('function accountRow'), s.indexOf('function viewAccounts'));
  assert.match(row, /worksWith\(a\) && !servesClaude\(a\) \? h\('span\.row-sub\.acct-tools'/, 'only where it is news: a provider that does not work with Claude Code');
  assert.match(row, /slow \? h\('span\.row-sub\.acct-speed'/, 'slow or refusing stays on the row');
  assert.match(s, /speedWords\(a\.speed\) \? h\('p\.hint\.acct-speed'/, 'and on the provider page');
});

test('the settings file warning and the copy of the old settings are panels on the list, as before', async () => {
  const O = await import('../../web/ownendpoint.js');
  assert.equal(O.ownEndpointPanel(null, () => {}), null);
  assert.equal(O.ownBackupPanel(null, () => {}), null);
  const l = list();
  assert.match(l, /here \? ownEndpointPanel\(data\.ownEndpoint, \(\) => refresh\(\)\) : null/);
  assert.match(l, /here \? ownBackupPanel\(data\.ownBackup, \(\) => refresh\(\)\) : null/);
});
