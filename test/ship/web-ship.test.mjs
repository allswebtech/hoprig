// The Go live page's words (web/ship.js): an outcome says what runs now. After a failed verify the new version is the
// one running, so the title never reads "not live", which a person who is not a programmer reads as "nothing changed".
import assert from 'node:assert/strict';
import test from 'node:test';

// Just enough of a browser for the module to load (the same stand-in as test/server/web.test.mjs).
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
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { outcomeTitle, limiterInput } = await import('../../web/ship.js');

test('the limiter field takes a list of words, empty for none, and refuses a line of text', () => {
  assert.deepEqual(limiterInput(' ["nice", "-n", "15"] '), { run: ['nice', '-n', '15'] });
  assert.deepEqual(limiterInput(''), { run: null });
  for (const bad of ['nice -n 15', '[]', '["nice", 3]', '{"run": ["x"]}']) assert.match(limiterInput(bad).error, /list of words/, bad);
});

test('an outcome that is not live says what runs now', () => {
  assert.equal(outcomeTitle({ outcome: 'not-verified', name: 'wednesday' }), 'wednesday is running now, but it does not answer as it should');
  assert.equal(outcomeTitle({ outcome: 'not-verified', name: 'wednesday', updateFailed: true }), 'The update of wednesday failed: the project may be part-way updated');
  assert.equal(outcomeTitle({ outcome: 'changed', name: 'wednesday' }), 'wednesday is running now, and files you keep changed');
  assert.equal(outcomeTitle({ outcome: 'update-cut', name: 'wednesday' }), 'The update of wednesday was cut off: the project may be part-way updated');
  assert.equal(outcomeTitle({ outcome: 'taken-back', name: 'wednesday' }), 'Taken back: wednesday');
  for (const o of ['not-verified', 'changed', 'update-cut']) assert.doesNotMatch(outcomeTitle({ outcome: o, name: 'x' }), /not live/i);
});

test('the picker wraps long branch names instead of cutting them', async () => {
  // style.css cuts .row-title and .row-sub with an ellipsis; two branches that differ only at the end would look alike.
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/page-ship.css', import.meta.url), 'utf8');
  const rule = /\.sp-branch \.row-title, \.sp-branch \.row-sub \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'a rule for the picker rows');
  assert.match(rule[1], /white-space: normal/);
  assert.match(rule[1], /overflow-wrap: anywhere/);
});

test('the tap sheet says which commit is which, and how it is taken back', async () => {
  const { tapWords } = await import('../../web/ship.js');
  const w = tapWords({ name: 'alpha', commit: 'ba5124de7052', before: 'b7d122a0541e', autoBack: false });
  assert.equal(w.ids, "ba5124de7052… is alpha's last commit; b7d122a0541e… is the commit the project is on now.");
  assert.match(w.after, /take it back with one press/);
  assert.match(tapWords({ name: 'alpha', commit: 'a', before: 'b', autoBack: true }).after, /taken back by itself/);
});
