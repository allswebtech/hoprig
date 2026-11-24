// An error whose code names a place gets one button to that place (web/errorways.js, one table for the whole page):
// on a toast of the error and in errorBox. An unknown code adds nothing, and the button only opens the place.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  remove() { this.removed = true; }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.location ??= { hash: '#/', pathname: '/' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const all = (n) => (n instanceof FakeElement ? [n, ...n.children.flatMap(all)] : []);
const ways = (n) => all(n).filter((e) => /\berr-way\b/.test(e.className));

const { WAYS, wayOf } = await import('../../web/errorways.js');
const { ApiError, toast } = await import('../../web/lib.js');
const { errorBox } = await import('../../web/shell.js');

const pageFiles = () => fs.readdirSync(WEB, { recursive: true }).map(String).filter((x) => x.endsWith('.js'));
const allSource = pageFiles().map((f) => fs.readFileSync(path.join(WEB, f), 'utf8')).join('\n');

test('every code of the table has a label and leads to a page address that exists, and a ?show id is on the page', () => {
  const list = /export const PAGE_ADDRESSES = \[([\s\S]*?)\];/.exec(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'))[1];
  const addresses = new Set([...list.matchAll(/'(#\/[^']*)'/g)].map((m) => m[1]));
  // The Computer page's parts (web/pc.js PARTS: #/computer/health and so on) are addresses of that page too.
  const parts = /export const PARTS = \[([\s\S]*?)\];/.exec(fs.readFileSync(path.join(WEB, 'pc.js'), 'utf8'))[1];
  for (const m of parts.matchAll(/id: '([a-z]+)'/g)) addresses.add(`#/computer/${m[1]}`);
  assert.ok(Object.keys(WAYS).length >= 10);
  for (const [code, w] of Object.entries(WAYS)) {
    assert.match(code, /^[a-z][a-z0-9-]*$/, `${code} is kebab-case`);
    assert.ok(typeof w.label === 'string' && w.label.trim(), `${code} has a label`);
    const [where, query] = w.href.split('?');
    assert.ok(addresses.has(where), `${code}: ${where} is one of the page's addresses`);
    if (query) {
      const id = new URLSearchParams(query).get('show');
      assert.match(id, /^[a-z][a-z0-9-]{0,39}$/, `${code}: only ?show=<id>`);
      assert.equal([...new URLSearchParams(query).keys()].join(), 'show', `${code}: nothing but show in its address`);
      assert.ok(new RegExp(`id: '${id}'`).test(allSource), `${code}: an element with id ${id} is on the page`);
    }
  }
  assert.deepEqual(WAYS['computer-not-allowed'], { label: 'Computers → Add a computer', button: 'Add a computer', href: '#/computers/add', perComputer: false });
});

test('errorBox of an error with a code shows its words and one button to the place, on the computer that answered', () => {
  const here = errorBox(new ApiError('Box no longer lets this dashboard in.', 403, { code: 'computer-not-allowed' }));
  assert.ok(texts(here).includes('Box no longer lets this dashboard in.'));
  const [b] = ways(here);
  assert.equal(b.tag, 'a');
  assert.equal(b.attrs.href, '#/computers/add');
  assert.deepEqual(texts(b), ['Add a computer']);
  // A place of one computer opens on the computer whose answer it was.
  const far = errorBox(new ApiError('OpenCode is off on this computer.', 409, { code: 'tool-off' }, 'laptop'));
  assert.equal(ways(far)[0].attrs.href, '#/m/laptop/settings/codingtools');
  // A plain text, as before: no button.
  assert.equal(ways(errorBox('Something failed.')).length, 0);
  assert.deepEqual(texts(errorBox('Something failed.')).filter((x) => x.trim()), ['Something failed.']);
});

test('an unknown code, or none, adds no button', () => {
  for (const e of [new ApiError('x', 409, { code: 'no-such-code' }), new ApiError('x', 409, {}), new Error('x'), { error: 'x', code: 'toString' }, { error: 'x', code: '__proto__' }]) {
    assert.equal(wayOf(e), null, String(e.code));
    assert.equal(ways(errorBox(e)).length, 0, String(e.code));
  }
});

test('a toast of an error with a code gets the button; pressing it only opens the place', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  document.body = new FakeElement('body');
  location.hash = '#/';
  const el = toast(new ApiError('Learning skills is off: turn it on in Settings → Learn skills', 409, { code: 'learn-off' }), { kind: 'error' });
  assert.ok(texts(el).includes('Learning skills is off: turn it on in Settings → Learn skills'));
  const b = all(el).find((x) => x.tag === 'button');
  assert.deepEqual(texts(b), ['Open Learn skills']);
  b.listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(location.hash, '#/settings/learn', 'it goes there and does nothing else');
  // The link in errorBox has no handler: it is an address, never a press of a switch.
  const link = ways(errorBox(new ApiError('x', 409, { code: 'bypass-off' })))[0];
  assert.deepEqual(link.listeners, {});
  assert.equal(link.attrs.href, '#/settings/new-sessions?show=bypass');
  // An unknown code: no button on the toast.
  const plain = toast(new ApiError('Nope', 409, { code: 'no-such-code' }), { kind: 'error' });
  assert.equal(all(plain).filter((x) => x.tag === 'button').length, 0);
  // A text toast is as before.
  assert.ok(texts(toast('Saved')).includes('Saved'));
});

test('with Try again too, the way and Try again stand in one row', () => {
  const box = errorBox(new ApiError('x', 409, { code: 'tool-off' }), () => {});
  const row = all(box).find((e) => /\bsavebar\b/.test(e.className));
  assert.ok(row, 'one row');
  assert.deepEqual(row.children.map((c) => texts(c).join('').trim()), ['Open Coding tools', 'Try again']);
  // Without a code: Try again alone, as before.
  assert.equal(all(errorBox('x', () => {})).some((e) => /\bsavebar\b/.test(e.className)), false);
});
