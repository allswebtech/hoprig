// The TRouteAI panel on Providers (web/trouteai.js): window names read plainly; a key typed there is a password field that
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

test('TRouteAI\'s own page opens with no referrer, and the one-time link only on the computer itself', () => {
  assert.equal((src.match(/window\.open\(/g) || []).length, 2);
  assert.ok((src.match(/'noopener,noreferrer'/g) || []).length === 2);
  assert.match(src, /const onThatComputer = LOOPBACK\.includes\(location\.hostname\);\s*if \(onThatComputer\)/);
  assert.match(src, /rel: 'noopener noreferrer'/);
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

test('the Providers page draws the panel on this computer\'s own page only', () => {
  assert.match(read('accounts.js'), /here \? trouteaiPanel\(\{ changed: \(\) => refresh\(\) \}\) : null/);
  assert.match(read('index.html'), /page-gatewaymanage\.css/);
});
