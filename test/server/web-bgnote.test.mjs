// "A command it started still runs in the background": the one line a card shows for a session that WAITS for the
// owner while a background command runs (web/lib.js bgCommandNote). The state stays "Waiting for your next message";
// this is an extra line, shown only when the session is waiting and a command runs — never when it is working (the
// card then says "Working in the background") and never without a command. Wired into Home and the Workspace (the card
// and the row in sessionitem.js), the session page (session.js) and the App's list (chat/sidebar.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { bgCommandNote, BG_COMMAND_LINE } = await import('../../web/lib.js');

test('the line shows only for a waiting session with a background command', () => {
  assert.equal(bgCommandNote({ status: 'waiting', bgCommands: 1 }), BG_COMMAND_LINE);
  assert.equal(bgCommandNote({ status: 'waiting', bgCommands: 2 }), BG_COMMAND_LINE);
  assert.equal(bgCommandNote({ status: 'waiting' }), null, 'no command, no line');
  assert.equal(bgCommandNote({ status: 'waiting', bgCommands: 0 }), null);
  assert.equal(bgCommandNote({ status: 'working', bgCommands: 1 }), null, 'a working session says "Working in the background", not this line');
  assert.equal(bgCommandNote({ status: 'attention', bgCommands: 1 }), null, 'a question is its own card, not this line');
});

test('the line is the plain words the request asked for, and promises nothing', () => {
  assert.equal(BG_COMMAND_LINE, 'A command it started still runs in the background. It may go on by itself when that ends.');
  assert.doesNotMatch(BG_COMMAND_LINE, /\bwill\b/, 'no word that promises it will go on by itself');
});

test('the card surfaces render the line from the helper (Home, Workspace, the session page, the App\'s list)', () => {
  for (const f of ['sessionitem.js', 'session.js', 'chat/sidebar.js']) {
    assert.match(fs.readFileSync(path.join(WEB, f), 'utf8'), /bgCommandNote\(s\)/, `${f} shows the line`);
  }
  const si = fs.readFileSync(path.join(WEB, 'sessionitem.js'), 'utf8');
  assert.match(si, /card-bg-note/, 'Home card shows the line');
  assert.match(si, /si-bg-note/, 'the Workspace row shows the line');
});
