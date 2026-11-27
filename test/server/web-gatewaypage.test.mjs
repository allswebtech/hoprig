// A gateway's own page as the browser can open it (web/gateways.js gatewayPageLink): on a loopback name a link under
// the other loopback name, never one the owner is signed in under; elsewhere, or for another computer's gateway, one
// plain sentence and no dead localhost link. The Providers and Add-ons pages draw the link through it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => t, getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const { addressWarning, gatewayLine, gatewayPageLink } = await import('../../web/gateways.js');

const PAGE = 'http://localhost:4123/dashboard';
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

test('on a loopback name the link is under the other loopback name', () => {
  assert.deepEqual(gatewayPageLink(PAGE, { pageHost: 'localhost' }), { href: 'http://127.0.0.1:4123/dashboard' });
  assert.deepEqual(gatewayPageLink(PAGE, { pageHost: '127.0.0.1' }), { href: 'http://localhost:4123/dashboard' });
  // The same rule as Health's Open its page (web/health.js plainHost): another host name, so the cookie stays home.
  assert.deepEqual(gatewayPageLink(PAGE, { pageHost: '[::1]' }), { href: 'http://localhost:4123/dashboard' });
  assert.deepEqual(gatewayPageLink('http://localhost:4123', { pageHost: '127.0.0.1' }), { href: 'http://localhost:4123/' });
});

test('never a name the owner is signed in under', () => {
  assert.deepEqual(gatewayPageLink(PAGE, { pageHost: '127.0.0.1', signedIn: ['127.0.0.1'] }), { href: 'http://localhost:4123/dashboard' });
  const both = gatewayPageLink(PAGE, { title: 'Alpha', pageHost: 'localhost', signedIn: ['localhost', '127.0.0.1'] });
  assert.equal(both.href, undefined);
  assert.match(both.text, /signed in to this dashboard under both localhost and 127\.0\.0\.1, so a link to Alpha would hand it your sign-in/);
});

test('opened by the computer\'s name or the public link: no localhost link, one sentence of where it opens', () => {
  for (const pageHost of ['box2.local', '192.168.1.20', 'shop.example.com']) {
    const r = gatewayPageLink(PAGE, { title: 'Alpha', pageHost });
    assert.equal(r.href, undefined, pageHost);
    assert.equal(r.text, 'Alpha\'s own page opens only in a browser on the computer this dashboard runs on, at http://127.0.0.1:4123/dashboard');
    assert.doesNotMatch(r.text, new RegExp(pageHost.replace(/\./g, '\\.')), 'never the page\'s own host with the gateway\'s port');
  }
});

test('another computer\'s gateway: no link, the sentence names Health\'s Open its page', () => {
  for (const pageHost of ['localhost', 'box2.local']) {
    const r = gatewayPageLink(PAGE, { title: 'Alpha', pageHost, other: true });
    assert.equal(r.href, undefined);
    assert.equal(r.text, 'Alpha\'s own page opens only in a browser on that computer itself. For a computer added by SSH, Open its page under that computer\'s Health opens it in a browser on the computer this dashboard runs on.');
  }
  assert.equal(gatewayPageLink(null, { pageHost: 'localhost' }), null);
});

test('the Providers and Add-ons pages draw the gateway\'s page through it', () => {
  const accounts = read('accounts.js');
  assert.doesNotMatch(accounts, /g\.page\.replace\('localhost'/, 'the old link put the page\'s own host before the gateway\'s port');
  assert.match(accounts, /gatewayPageLink\(g\.page,/);
  const addons = read('addons.js');
  assert.match(addons, /gatewayPageLink\(pageOf\(a\),/);
  assert.doesNotMatch(addons, /`Its dashboard is at \$\{pageOf\(a\)\} on this computer\.`/);
  assert.doesNotMatch(addons, /href: pageOf\(a\)/);
});

test('the warning under a key\'s address says exactly where another address comes from', () => {
  for (const a of ['http://localhost:7000/gateway/alpha', 'http://127.0.0.1:7000/gateway/alpha', 'http://[::1]:7000/gateway/alpha']) {
    const w = addressWarning(a);
    assert.match(w, /^This address works only on this computer\./, a);
    // The computer's name works only where the dashboard was opened to the network; by default it listens on this one.
    assert.match(w, /by this computer's name on your network if the dashboard is open to your network \(Settings → Security and sign-in → Network\)/);
    assert.match(w, /by its public link \(Settings → Public link\)/);
  }
  for (const a of ['https://shop.example.com/gateway/alpha', 'http://box2.local:7000/gateway/alpha', 'http://192.168.1.20:7000/gateway/alpha']) assert.equal(addressWarning(a), null, a);
  const src = read('gateways.js');
  assert.doesNotMatch(src, /Open this page by the computer\\'s name on your network or by its public link/, 'the old sentence promised the name always works');
});

test('the line under a gateway says its copy was updated after it started, beside the version', () => {
  const note = 'The copy on this computer was updated after TRouteAI was started: restart it to run 1.0.11';
  const c = { machine: null, label: 'here' };
  assert.equal(gatewayLine(c, { installed: true, running: true, version: '1.0.11', restart: note }), `Running · version 1.0.11 · ${note}`);
  assert.equal(gatewayLine(c, { installed: true, running: true, version: '1.0.11' }), 'Running · version 1.0.11');
});
