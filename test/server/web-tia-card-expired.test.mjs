// A Tia card whose time ran out (web/tia.js expireCard, called by the card's countdown): Confirm and Decline are off,
// and the card says "This ran out. Ask Tia again." While time is left nothing changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

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
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const tia = await import('../../web/tia.js');

test('time left: the buttons stay on and nothing is said', () => {
  assert.equal(typeof tia.expireCard, 'function', 'there is no rule for a card whose time ran out');
  const parts = { buttons: [{ disabled: false }, { disabled: false }], result: { textContent: '' } };
  assert.equal(tia.expireCard(parts, 30_000), false);
  assert.deepEqual(parts.buttons.map((b) => b.disabled), [false, false]);
  assert.equal(parts.result.textContent, '');
});

test('time ran out: Confirm and Decline are off, and the card says to ask Tia again', () => {
  assert.equal(typeof tia.expireCard, 'function', 'there is no rule for a card whose time ran out');
  for (const ms of [0, -5000]) {
    const parts = { buttons: [{ disabled: false }, { disabled: false }], result: { textContent: '' } };
    assert.equal(tia.expireCard(parts, ms), true);
    assert.deepEqual(parts.buttons.map((b) => b.disabled), [true, true]);
    assert.equal(parts.result.textContent, 'This ran out. Ask Tia again.');
  }
});

test('time ran out: the badge says "ran out", as the line does, and the card no longer asks him to confirm', () => {
  assert.equal(tia.mmss(0), 'ran out');
  assert.equal(tia.mmss(-1000), 'ran out');
  assert.equal(tia.mmss(65_000), '1:05 left');
  // A card with no time (expiresAt missing): the badge and the buttons say one thing.
  for (const ms of [NaN, undefined - 1, Number(undefined)]) assert.equal(tia.mmss(ms), 'ran out');
  const none = { buttons: [{ disabled: false }], result: { textContent: '' }, wait: { textContent: '' } };
  assert.equal(tia.expireCard(none, NaN), true, 'the buttons go off as the badge says');
  const parts = { buttons: [{ disabled: false }], result: { textContent: '' }, wait: { textContent: ' Nothing happens until you confirm.' } };
  tia.expireCard(parts, 0);
  assert.equal(parts.wait.textContent, ' Nothing happened.');
  const live = { buttons: [{ disabled: false }], result: { textContent: '' }, wait: { textContent: ' Nothing happens until you confirm.' } };
  tia.expireCard(live, 5000);
  assert.equal(live.wait.textContent, ' Nothing happens until you confirm.', 'time left: as before');
});

test('the card\'s countdown calls it with both of its buttons', () => {
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(src, /expireCard\(\{ buttons: \[ok, no\], result, wait \}, ms\);/);
  assert.match(src, /h\('p\.tia-card-why', p\.why, wait\)/);
  assert.match(src, /h\('div\.tia-card-actions', ok, no, result\)/);
});
