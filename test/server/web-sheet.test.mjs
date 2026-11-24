// The page's sheets (web/lib.js openSheet) with a stand-in <dialog>: the focus goes back to what opened a sheet when
// it closes, also after a row of sheets; a question has the focus on Cancel; a sheet that must be closed by its own
// button (the token or secret shown once, web/workaccess.js) has no X and ignores Escape and a tap beside it.
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, isConnected: true });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k, fn) {
    (this.listeners[k] ||= []).push(fn);
  }
  /** → true when nothing called preventDefault. */
  dispatch(type, props = {}) {
    let stopped = false;
    const e = { type, target: this, preventDefault: () => (stopped = true), get defaultPrevented() { return stopped; }, ...props };
    for (const fn of this.listeners[type] || []) fn(e);
    return !stopped;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  focus() {
    document.activeElement = this;
  }
  get all() {
    return this.children.filter((c) => c instanceof FakeElement).flatMap((c) => [c, ...c.all]);
  }
  querySelector(sel) {
    if (sel === '[autofocus]') return this.all.find((c) => c.autofocus === true || 'autofocus' in c.attrs) || null;
    return null;
  }
  querySelectorAll() {
    return [];
  }
}
class FakeDialog extends FakeElement {
  constructor() {
    super('dialog');
    this.open = false;
    this.classList = { toggle() {} };
  }
  showModal() {
    this.open = true;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    setTimeout(() => this.dispatch('close'), 0); // a browser reports a close a moment later
  }
  /** A phone's back gesture after the one stop Chrome allows: a cancel with no keydown, and closed all the same. */
  back() {
    this.dispatch('cancel');
    this.close();
  }
  /** Escape: the browser sends keydown, then cancel, and closes unless one of them was stopped. */
  escape() {
    if (this.dispatch('keydown', { key: 'Escape' }) && this.dispatch('cancel')) this.close();
  }
}
globalThis.Node = FakeNode;
let dialog = null;
globalThis.document = {
  createElement: (t) => (t === 'dialog' ? (dialog = new FakeDialog()) : new FakeElement(t)),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
  body: { append() {} },
  activeElement: null,
};
const { openSheet, confirmSheet } = await import('../../web/lib.js');
const tick = () => new Promise((r) => setTimeout(r, 5));
const textOf = (n) => (n instanceof FakeText ? n.text : n.children.map(textOf).join(''));
const buttons = () => dialog.all.filter((c) => c.tag === 'button');

test('when a sheet closes, the focus goes back to what opened it, also after a row of sheets', async () => {
  const opener = new FakeElement('button');
  opener.focus();
  let close;
  const one = openSheet({ title: 'One' }, (c) => ((close = c), []));
  document.activeElement = null; // the sheet has the focus now
  close('a');
  assert.equal(await one, 'a');
  await tick();
  assert.equal(document.activeElement, opener);
  // A name, then a question, then what it made: three sheets one after the other, the focus back on the first opener.
  opener.focus();
  let c1;
  const first = openSheet({ title: 'Name' }, (c) => ((c1 = c), []));
  document.activeElement = null;
  c1(null);
  let c2;
  const second = openSheet({ title: 'Question' }, (c) => ((c2 = c), []));
  await first;
  c2(true);
  await tick();
  assert.equal(await second, true);
  assert.equal(document.activeElement, opener, 'not the body');
  // An opener that is gone (the list it was in was drawn again) is not focused.
  const gone = new FakeElement('button');
  gone.focus();
  let c3;
  const third = openSheet({ title: 'Three' }, (c) => ((c3 = c), []));
  gone.isConnected = false;
  document.activeElement = null;
  c3(null);
  await third;
  await tick();
  assert.equal(document.activeElement, null);
});

test('a question opens with the focus on Cancel: Enter says no, the action is one Tab away', async () => {
  const q = confirmSheet({ title: 'Revoke Shop script?', text: 'It is refused from now on.', ok: 'Revoke', danger: true });
  await tick();
  assert.equal(textOf(document.activeElement), 'Cancel');
  document.activeElement.dispatch('click');
  assert.equal(await q, false);
});

test('a sheet kept for its own button has no X and ignores Escape and a tap beside it; another sheet closes on them', async () => {
  let close;
  const kept = openSheet({ title: 'The token', keep: true }, (c) => ((close = c), [new FakeText('hwt_...')]));
  assert.ok(!buttons().some((b) => b.attrs.title === 'Close' || b.title === 'Close'), 'no X');
  dialog.escape();
  dialog.dispatch('click'); // a tap on the dimmed page beside the panel: the dialog itself is the target
  await tick();
  assert.equal(dialog.open, true, 'still open');
  close(true);
  assert.equal(await kept, true);
  await tick();
  const plain = openSheet({ title: 'Plain' }, () => []);
  assert.ok(buttons().some((b) => b.title === 'Close' || b.attrs.title === 'Close'), 'an X');
  dialog.escape();
  assert.equal(await plain, null, 'Escape closes it');
  const tapped = openSheet({ title: 'Plain' }, () => []);
  dialog.dispatch('click');
  assert.equal(await tapped, null, 'a tap beside it closes it');
});

test('a kept sheet the browser closes by itself (a back gesture it does not let the page stop) opens again', async () => {
  let close;
  let ended = false;
  const kept = openSheet({ title: 'The token', keep: true }, (c) => ((close = c), [new FakeText('hwt_...')]));
  kept.then(() => (ended = true));
  for (let i = 0; i < 3; i++) {
    dialog.back();
    await tick();
    assert.equal(dialog.open, true, `open again after back gesture ${i + 1}`);
    assert.equal(ended, false, 'not answered');
  }
  assert.match(textOf(dialog), /hwt_\.\.\./, 'what it shows is still there');
  close(true);
  assert.equal(await kept, true);
  await tick();
  assert.equal(dialog.open, false, 'its own button closes it');
  const plain = openSheet({ title: 'Plain' }, () => []);
  dialog.back();
  assert.equal(await plain, null, 'another sheet closes on a back gesture');
});

test('the token or secret shown once is such a sheet: it closes only with "I have copied it"', async () => {
  const { shownOnce } = await import('../../web/workaccess.js');
  const shown = shownOnce({ title: 'The token Shop script', what: 'this token', value: 'hwt_example', after: null });
  assert.ok(!buttons().some((b) => b.title === 'Close' || b.attrs.title === 'Close'), 'no X');
  dialog.escape();
  dialog.dispatch('click');
  await tick();
  assert.equal(dialog.open, true);
  assert.match(textOf(dialog), /closes with "I have copied it"/);
  buttons().find((b) => textOf(b) === 'I have copied it').dispatch('click');
  assert.equal(await shown, true);
});
