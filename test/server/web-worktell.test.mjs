// Settings → Notifications → "Work, by itself" (web/worktell.js): a switch says "Saved" only when it was saved, which
// needs a push address that was saved; without one (or with one typed and not saved yet) its choice waits for Save.
import assert from 'node:assert/strict';
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x)));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.window ??= { dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.Event ??= class {};

const { tellNotice, workTellPanel } = await import('../../web/worktell.js');
const walk = (n, out = []) => {
  if (n instanceof FakeElement) {
    out.push(n);
    for (const c of n.children) walk(c, out);
  }
  return out;
};
/** Flip the first switch of the panel; → [saves made, the text its "Saved" mark shows]. */
async function flip(st) {
  let saves = 0;
  const panel = workTellPanel(st, async () => {
    saves += 1;
  });
  const all = walk(panel);
  const sw = all.find((e) => e.tag === 'input' && String(e.className).includes('switch'));
  const row = all.find((e) => e.tag === 'label' && walk(e).includes(sw));
  const mark = walk(row).find((e) => String(e.className).includes('saved-mark'));
  await sw.listeners.change({ target: { checked: true } });
  return [saves, mark.textContent || ''];
}

test('no push address saved: a Work switch saves nothing and does not say Saved', async () => {
  assert.deepEqual(await flip({ url: '', savedUrl: '', work: {} }), [0, '']);
});

test('a push address typed but not saved yet: the switch waits for Save as well', async () => {
  const st = { url: 'https://ntfy.example.invalid/new', savedUrl: 'https://ntfy.example.invalid/old', work: {} };
  assert.deepEqual(await flip(st), [0, '']);
  assert.equal(st.work.finished, true, 'the choice is kept for the Save above');
});

test('with the push address saved: the switch saves at once and says Saved', async () => {
  assert.deepEqual(await flip({ url: 'https://ntfy.example.invalid/t', savedUrl: 'https://ntfy.example.invalid/t', work: {} }), [1, 'Saved']);
});

test('Today\'s Needs you does not say "Nothing needs you" under a Progress that lists what waits for him', async () => {
  const { needsNoneWords } = await import('../../web/workpulse.js');
  const [title, sub] = needsNoneWords(2);
  assert.notEqual(title, 'Nothing needs you right now');
  assert.match(sub, /Progress above/);
  assert.equal(needsNoneWords(0)[0], 'Nothing needs you right now');
});

test('a teller that cannot keep its record: the panel says so in plain words; when it can, nothing', async () => {
  const text = (n) => walk(n).flatMap((e) => e.children.filter((c) => c instanceof FakeText).map((c) => c.text)).join(' ');
  assert.equal(tellNotice({ ok: true }), null);
  assert.equal(tellNotice(null), null);
  const n = tellNotice({ ok: false, since: '2026-11-19T12:00:00Z', error: 'EISDIR' });
  assert.match(text(n), /cannot keep its record of what it told you/);
  assert.doesNotMatch(text(n), /EISDIR/, 'no programmer words');
  // The panel asks the dashboard and puts the notice in.
  const panel = workTellPanel({ url: '', savedUrl: '', work: {} }, async () => {}, { status: async () => ({ ok: false, since: 'x', error: 'y' }) });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.match(text(panel), /cannot keep its record/);
});

test('the digest switch says in plain words that Tia writes it', () => {
  const panel = workTellPanel({ url: '', savedUrl: '', work: {} }, async () => {});
  const words = walk(panel).flatMap((e) => e.children.filter((c) => c instanceof FakeText).map((c) => c.text)).join(' ');
  assert.match(words, /Tia writes my digest/);
  assert.doesNotMatch(words, /Tia words my digest/);
});
