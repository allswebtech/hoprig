// Her notice in the chat (web/tia.js noticeView): one with a code draws "Use <label> (included in your plan)" and "Set a
// daily limit for paid use", which opens Settings → Tia at the cap field (one id: tia-daily-cap). The press on "Use …"
// saves "Tia runs on" first and only then sends his message again, once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// Just enough of a browser for the modules to load (the same stand-in as web-automations.test.mjs).
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
const all = (el) => [el, ...(el.children || []).flatMap((c) => (c instanceof FakeElement ? all(c) : []))];
const text = (el) => (el.text ?? '') + (el.children || []).map(text).join('');

test('a coded notice draws its two buttons; a plain one stays a line', () => {
  assert.equal(typeof tia.noticeView, 'function');
  const v = tia.noticeView({ kind: 'notice', code: 'paid-no-cap', text: 'Tia runs on a provider billed by use.', use: { name: 'max', label: 'Claude Max' } }, { resend: () => {} });
  const btns = all(v).filter((e) => e.tag === 'button' || e.tag === 'a');
  assert.deepEqual(btns.map(text), ['Use Claude Max (included in your plan)', 'Set a daily limit for paid use']);
  assert.equal(btns[1].attrs.href, '#/settings/tia?show=tia-daily-cap');
  // No subscription to offer: only the limit.
  const only = tia.noticeView({ kind: 'notice', code: 'paid-no-cap', text: 'x' }, { resend: () => {} });
  assert.deepEqual(all(only).filter((e) => e.tag === 'button' || e.tag === 'a').map(text), ['Set a daily limit for paid use']);
  const plain = tia.noticeView({ kind: 'notice', text: 'Tia stopped: gone.' });
  assert.equal(all(plain).some((e) => e.tag === 'button' || e.tag === 'a'), false);
});

test('"Use …" saves the setting first, then sends his message again once; a failed save sends nothing', async () => {
  assert.equal(typeof tia.useAndResend, 'function');
  const seen = [];
  await tia.useAndResend('max', 'What runs now?', { save: async (p) => seen.push(['save', p]), send: async (t) => seen.push(['send', t]) });
  assert.deepEqual(seen, [['save', { runsOn: 'max' }], ['send', 'What runs now?']]);
  const none = [];
  await assert.rejects(tia.useAndResend('max', 'hi', { save: async () => { throw new Error('refused'); }, send: async (t) => none.push(t) }));
  assert.deepEqual(none, []);
});

test('the cap field has the one id the links name', () => {
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(src, /h\('input\.field', \{ id: 'tia-daily-cap', type: 'number'/);
  assert.equal(tia.CAP_LINK, '#/settings/tia?show=tia-daily-cap');
});
