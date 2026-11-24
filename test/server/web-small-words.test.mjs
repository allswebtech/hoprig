// Small words and looks of the page for a reader who never used a terminal: the toast's button looks like a button
// and a tap closes the toast, the page head is solid, the Advanced and Setup lines wrap at 390 px, a computer that
// refuses this dashboard offers no Open desktop, the Operator's "Computers → Add a computer" is a link, and the
// provider's check line has no "endpoint".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener() {}, querySelector: () => null, body: new FakeElement('body') };
globalThis.location ??= { hostname: '127.0.0.1', pathname: '/', hash: '', origin: 'http://127.0.0.1' };
globalThis.window ??= { addEventListener() {} };
globalThis.fetch = () => new Promise(() => {});

const src = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const css = src('style.css');
const texts = (n) => (n instanceof FakeText ? [n.text] : typeof n === 'string' ? [n] : (n.children || []).flatMap(texts));

test('the toast\'s button has an outline in the accent colour, and a tap on the toast closes it', () => {
  assert.match(css, /\.toast \.btn\.ghost\.toast-action \{ border-color: var\(--accent\); color: var\(--accent\); \}/);
  assert.match(css, /\.toast \{ pointer-events: auto; cursor: pointer; \}/);
  assert.match(src('lib.js'), /t\.addEventListener\('click', \(e\) => \{\n\s+if \(!\(e\.target && e\.target\.closest && e\.target\.closest\('\.toast-action'\)\)\) t\.remove\(\);/);
});

test('the page head is solid: no text of the page shows through it', () => {
  assert.doesNotMatch(css, /color-mix\(in srgb, var\(--bg\) 96%, transparent\)/);
  assert.match(css, /\.pagehead \{[^}]*background: var\(--bg\);/);
});

test('at 390 px the Advanced part\'s lines (Rename) and Setup\'s Workspace line wrap instead of being cut', () => {
  assert.match(css, /\.cp-acts \.row-sub, \.ws-link \.row-sub \{ white-space: normal; overflow-wrap: anywhere; \}/);
  assert.match(src('pc.js'), /section\('This computer', undefined, h\('div\.rows\.cp-acts', rename,/);
  assert.match(src('pcsetup.js'), /h\('div\.rows\.ws-link'/);
});

test('a computer that no longer lets this dashboard in offers no Open desktop', () => {
  assert.match(src('pc.js'), /actions: notAllowed\(entry\(\)\) \? \[\] : \[desktop\]/);
});

test('the Operator\'s "Computers → Add a computer" is a link to that step, the sentence word for word', async () => {
  const { sinceParts } = await import('../../web/operator-rooms.js');
  const { NOT_ONLINE } = await import('../../web/lib.js');
  const line = `${NOT_ONLINE.unauthorised}.`;
  assert.equal(line, 'It no longer lets this dashboard in. Add it again here: Computers → Add a computer.');
  const parts = sinceParts(line);
  const a = parts.find((p) => p && p.tag === 'a');
  assert.ok(a, 'a link');
  assert.equal(a.attrs.href ?? a.href, '#/computers/add');
  assert.equal(texts(a).join(''), 'Computers → Add a computer');
  assert.equal(parts.flatMap(texts).join(''), line, 'every word kept');
  assert.deepEqual(sinceParts('Did not answer when asked.'), ['Did not answer when asked.'], 'another line stays text');
});

test('a sign-in\'s check line says it plainly, with no "endpoint"', () => {
  assert.match(src('providerhealth.js'), /'There is nothing to check for a sign-in\.'/);
  assert.doesNotMatch(src('providerhealth.js'), /endpoint of its own/);
});
