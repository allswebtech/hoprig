// The tick "Tia may end a stuck session in this project" beside a project's note (web/operator-decide.js
// projectNoteBox), in a stand-in DOM with a stand-in fetch: off as stored, saved through the note's route with the
// note's saved words, always sent with "Save the note", and not shown for an older computer that sends none. The page
// itself is proven in a real browser as well.
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  contains(n) {
    return n === this || this.children.some((c) => c instanceof FakeElement && c.contains(n));
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
document.body ??= new FakeElement('body');
document.activeElement = null;
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const all = (n, f) => (n instanceof FakeText ? [] : [...(f(n) ? [n] : []), ...n.children.flatMap((c) => all(c, f))]);

// The server as the page sees it: GET /api/operator/note and POST /api/operator/settings, every request recorded.
const sent = [];
let stored = null;
globalThis.fetch = async (url, o = {}) => {
  const body = o.body ? JSON.parse(o.body) : undefined;
  sent.push({ url, method: o.method, body });
  let json;
  if (String(url).startsWith('/api/operator/note')) json = { project: 'shop', text: stored.text, ...(stored.old ? {} : { mayEnd: stored.mayEnd }), max: 500 };
  else {
    const n = body.note;
    stored = { ...stored, text: n.text, ...(n.mayEnd === undefined ? {} : { mayEnd: n.mayEnd }) };
    json = { note: { project: n.project, text: stored.text, mayEnd: stored.mayEnd === true, cleaned: false } };
  }
  return { ok: true, status: 200, json: async () => json };
};

const d = await import('../../web/operator-decide.js');
const posts = () => sent.filter((s) => s.method === 'POST').map((s) => s.body);
async function draw(state) {
  stored = state;
  sent.length = 0;
  const box = new FakeElement('div');
  await d.projectNoteBox(box, 'shop');
  const tick = all(box, (n) => n.tag === 'input' && n.dataset.key === 'may-end')[0] || null;
  const area = all(box, (n) => n.tag === 'textarea')[0];
  const save = all(box, (n) => n.tag === 'button' && texts(n).join('') === 'Save the note')[0];
  return { box, tick, area, save, words: texts(box).join(' ') };
}

test('the tick beside the note: its words, off as stored, and its one-sentence hint', async () => {
  const p = await draw({ text: 'If a session still hangs after a nudge, stop it.', mayEnd: false });
  assert.ok(p.tick, 'the tick is there');
  assert.equal(p.tick.attrs.type, 'checkbox');
  assert.equal(p.tick.attrs.checked, undefined, 'off: a note that asks for the stop is not the tick');
  assert.match(p.words, /Tia may end a stuck session in this project/);
  assert.match(p.words, /With it on, she may end a stuck session here when your note says when; off, she never ends one\./);
  const label = all(p.box, (n) => n.tag === 'label' && n.attrs.for === p.tick.attrs.id);
  assert.equal(label.length, 1, 'the label names the tick');
  assert.ok(p.tick.attrs['aria-describedby'], 'the hint describes it');
  const on = await draw({ text: '', mayEnd: true });
  assert.equal(on.tick.attrs.checked, '', 'on as stored');
});

test('a tap on the tick saves it through the note\'s route with the note\'s saved words, not the words being written', async () => {
  const p = await draw({ text: 'Stop a session that hangs.', mayEnd: false });
  p.area.value = 'half-written words';
  p.tick.checked = true;
  await p.tick.listeners.change({ target: p.tick });
  assert.deepEqual(posts(), [{ note: { project: 'shop', text: 'Stop a session that hangs.', mayEnd: true } }]);
  assert.equal(p.tick.checked, true);
  assert.equal(stored.text, 'Stop a session that hangs.');
  p.tick.checked = false;
  await p.tick.listeners.change({ target: p.tick });
  assert.deepEqual(posts()[1], { note: { project: 'shop', text: 'Stop a session that hangs.', mayEnd: false } });
});

test('"Save the note" always sends the tick as it stands', async () => {
  const p = await draw({ text: 'Wait for a short reset.', mayEnd: true });
  p.area.value = 'Ask me first.';
  await p.save.listeners.click();
  assert.deepEqual(posts(), [{ note: { project: 'shop', text: 'Ask me first.', mayEnd: true } }]);
  const off = await draw({ text: 'x', mayEnd: false });
  await off.save.listeners.click();
  assert.deepEqual(posts(), [{ note: { project: 'shop', text: 'x', mayEnd: false } }]);
});

test('an older computer that sends no tick: no tick is shown and the note is saved without the field', async () => {
  const p = await draw({ text: 'Wait.', old: true });
  assert.equal(p.tick, null);
  assert.doesNotMatch(p.words, /may end a stuck session/);
  await p.save.listeners.click();
  assert.deepEqual(posts(), [{ note: { project: 'shop', text: 'Wait.' } }]);
});
