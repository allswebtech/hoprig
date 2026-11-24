// Her notice in the chat is her reply to his message: "Tia is thinking…" ends with it, it is kept in sight above the
// cards that wait under it, and its "Use …" sends again only the message that brought it, from the newest notice only
// (a job's wake-up brought none).
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], on: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.on[k] = fn;
  }
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
const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
const branch = src.slice(src.indexOf("if (e.kind === 'notice') {"), src.indexOf("if (e.kind === 'done') {"));

test('a notice ends "Tia is thinking…" and is the part kept in sight', () => {
  assert.ok(branch.length > 0, 'no notice branch of its own');
  assert.ok(branch.indexOf('busy(null)') >= 0 && branch.indexOf('busy(null)') < branch.indexOf('add(list'), 'the notice leaves "thinking" on');
  assert.match(branch, /lastNotice = row;/);
  assert.match(src, /const shown = lastNotice && lastNotice\.isConnected \? lastNotice : \[\.\.\.cardsBox\.querySelectorAll\('\.tia-card:not\(\.decided\)'\)\]\.pop\(\);/);
});

test('"Use …" sends again the message that brought this notice, from the newest notice only', () => {
  assert.equal(typeof tia.resendText, 'function');
  assert.equal(tia.resendText({ kind: 'notice', origin: 'owner' }, 'What runs?'), 'What runs?');
  assert.equal(tia.resendText({ kind: 'notice', origin: 'job' }, 'What runs?'), '', 'a job\'s wake-up sends his last message');
  assert.equal(tia.resendText({ kind: 'notice' }, 'What runs?'), '', 'a notice of an older dashboard says nothing of its origin');
  // The text is taken when the notice is drawn, and an older notice's button is taken away.
  assert.match(branch, /const text = resendText\(e, lastOwnerText\);/);
  assert.match(branch, /for \(const b of list\.querySelectorAll\('\.tia-notice-use'\)\) b\.remove\(\);/);
  const v = tia.noticeView({ kind: 'notice', code: 'paid-no-cap', text: 'x', use: { name: 'max', label: 'Claude Max' } }, { resend: () => {} });
  const all = (el) => [el, ...(el.children || []).flatMap((c) => (c instanceof FakeElement ? all(c) : []))];
  assert.ok(all(v).some((e) => e.tag === 'button' && /\btia-notice-use\b/.test(e.className)));
});

