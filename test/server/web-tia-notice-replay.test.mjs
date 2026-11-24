// A notice's "Use …" is gone once the notice was answered: his next message (also the one "Use …" sent), her words,
// or the end of her turn. The page draws the history again on a reload, event by event, so this holds there too: a
// replayed notice that she answered after has no live button, and his message is never sent a second time.
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

test('the events that answer a notice end its "Use …"; a notice or a tool call does not', () => {
  assert.equal(typeof tia.endsNotice, 'function', 'nothing decides when a notice was answered');
  // The history of the walk: his message, the paid notice, "Use …" sent it again, she answered, her turn ended.
  const history = [
    { kind: 'owner', text: 'Robots file please' },
    { kind: 'notice', code: 'paid-no-cap', origin: 'owner', use: { name: 'max', label: 'Claude Max' } },
    { kind: 'owner', text: 'Robots file please' },
    { kind: 'text', text: 'Done.' },
    { kind: 'done', ok: true },
  ];
  assert.deepEqual(history.map(tia.endsNotice), [true, false, true, true, true]);
  assert.equal(tia.endsNotice({ kind: 'tool_call', tool: 'list_sessions' }), false);
  assert.equal(tia.endsNotice(null), false);
});

test('every drawn event is looked at, the history on a reload as much as a live one', () => {
  // The removal is the first thing render() does, before any kind has its own branch (each of them returns).
  const body = src.slice(src.indexOf('  function render(e) {'), src.indexOf("    if (e.kind === 'owner') {"));
  assert.ok(body.length > 0, 'no render()');
  assert.match(body, /if \(endsNotice\(e\)\) for \(const b of list\.querySelectorAll\('\.tia-notice-use'\)\) b\.remove\(\);/);
  // One drawing path for both: the history and the live events go through render().
  assert.match(src, /for \(const e of events\) \{\n\s+[^\n]*\n\s+if \(render\(e\)\) added = true;/);
});
