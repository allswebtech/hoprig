// The TRouteAI parts (web/trouteai.js), drawn by its page (web/trouteaipage.js): window names read plainly; a key typed there is a password field that
// is emptied after it is sent and kept nowhere; the sign-in code's poll runs only while its sheet is open; the page of
// TRouteAI opens without a referrer; the provider check's combo sentence becomes a press only where the check says so.
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
const { windowLabel } = await import('../../web/trouteai.js');
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const src = read('trouteai.js');

test('a quota window is named the way a person says it', () => {
  assert.equal(windowLabel('window5h'), '5h window');
  assert.equal(windowLabel('weekly'), 'Weekly');
  assert.equal(windowLabel('session_limit'), 'Session limit');
});

test('the key is typed into a password field, emptied after it is sent, and kept nowhere', () => {
  assert.match(src, /h\('input\.field\.mono', \{ type: 'password'/);
  assert.match(src, /apiKey: key\.value \}\);\s*key\.value = '';/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|prefs\.set|console\./);
});

test('the sign-in code is polled only while its sheet is open, never by a timer of the panel', () => {
  assert.match(src, /for \(let waitedS = 0; open && waitedS < s\.expiresIn/);
  assert.match(src, /if \(!open \|\| !body\.isConnected\) break;/);
  assert.doesNotMatch(src, /setInterval/);
});

test('TRouteAI\'s own page opens in a tab made at once, cut loose from this page, then sent where Hoprig says', () => {
  assert.equal((src.match(/window\.open\(/g) || []).length, 1);
  assert.match(src, /const tab = window\.open\('about:blank', '_blank'\);\s*if \(tab\) tab\.opener = null;/);
  assert.match(src, /tab\.location\.replace\(u\)/);
  assert.match(src, /rel: 'noopener noreferrer'/);
  // The address is worked out on the server: where is 'local' or 'public', never a link the page builds from the gateway's answer.
  assert.match(src, /where: onThatComputer \? 'local' : 'public'/);
});

test('a removal names the computer in its confirmation, and every press carries the computer\'s name', () => {
  assert.equal((src.match(/confirmSheet\(/g) || []).length, 3);
  assert.ok((src.match(/confirm: state\.computer/g) || []).length >= 9);
});

test('the provider check makes the press for a managed TRouteAI, and copies the sentence otherwise', () => {
  const ph = read('providerhealth.js');
  assert.match(ph, /if \(!r\.mend\.make \|\| machine\.current \|\| !reload\) return copyLine\(r\.mend\.combo\);/);
  assert.match(ph, /label: 'Make the combo'/);
});

test('the Providers page holds no gateway cards: TRouteAI is one row and a page of its own, on this computer only', () => {
  const acc = read('accounts.js');
  assert.match(acc, /here \? \[groupHead\('Gateway'\), h\('div\.rows', listRow\(\{ href: link\('#\/providers\/trouteai'\), icon: 'swap', title: 'TRouteAI'/);
  assert.doesNotMatch(acc.slice(acc.indexOf('function viewAccounts')), /trouteaiPanel/, 'the page itself draws no TRouteAI card (its closed fold of the gateways on your computers is the one gateway part, with Use here)');
  assert.match(acc, /import \{ viewTrouteai \} from '\.\/trouteai\.js'/);
  assert.match(acc, /if \(sub === 'trouteai'\) return viewTrouteai\(\{ frame, sub, query \}\);/, 'its address draws the page of its own');
  assert.doesNotMatch(src, /export function trouteaiPanel/, 'the old panel is gone: the page holds what it held');
  assert.match(read('gateways.js'), /export function gatewaysPanel/, 'the fold of the gateways on your computers, with Use here');
  assert.match(read('index.html'), /page-gatewaymanage\.css/);
});
