// "New chat started" never covers the message box on a phone (web/tia.js newChatWhere): there the empty chat says it,
// also on her own page (before, only the docked box left the toast out, and at 390 px the page's toast sat over the
// box). A wide window keeps the toast; a chat that was not new says nothing.
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

test('a phone: the empty chat says it; a wide window: the toast; not new: nothing', () => {
  assert.equal(typeof tia.newChatWhere, 'function', 'the page has no rule for where "New chat started" goes');
  assert.equal(tia.newChatWhere(true, true), 'chat');
  assert.equal(tia.newChatWhere(true, false), 'toast');
  assert.equal(tia.newChatWhere(false, true), null);
  assert.equal(tia.newChatWhere(false, false), null);
});

test('the chat panel uses it for her page and the docked box alike', () => {
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(src, /const said = newChatWhere\(fresh, covers\(\)\);/);
  assert.match(src, /const newChatLine = said === 'chat' \? h\('p\.tia-note\.tia-newchat', \{ role: 'status' \}, 'New chat started\.'\) : null;/);
  assert.match(src, /if \(said === 'toast'\) toast\('New chat started'\);/);
  assert.doesNotMatch(src, /!\(scrollEl && covers\(\)\)\) toast\('New chat started'\)/);
});

test('on a phone the line stands right above the message box, not at the top of the chat the cards scroll past', () => {
  const src = fs.readFileSync(path.join(WEB, 'tia.js'), 'utf8');
  assert.match(src, /h\('div\.tia-dock', newPill, newChatLine, err, mic\.note, form\)/, 'in the dock, above the box');
  const empty = src.slice(src.indexOf('const empty = () =>'), src.indexOf('function render(e)'));
  assert.doesNotMatch(empty, /tia-newchat/, 'not in the empty chat, out of sight under waiting cards');
  // It goes with his first message.
  assert.match(src, /mic\.stop\(\);\n {4}if \(newChatLine\) newChatLine\.remove\(\);/);
});
