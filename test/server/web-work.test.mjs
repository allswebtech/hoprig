// The Work page's runs (web/workitems.js, web/workdo.js, web/work.js), with a small stand-in for the browser DOM.
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
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener() {}
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x)));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
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
const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const links = (n) => (n instanceof FakeText ? [] : [...(n.attrs && n.attrs.href ? [n.attrs.href] : []), ...(n.children || []).flatMap(links)]);

const { machine } = await import('../../web/lib.js');
const { canDoIt, runLineKind } = await import('../../web/workitems.js');
const { RUN_WORDS, keepFocus, runCard, sessionLink, usableFilter } = await import('../../web/workdo.js');
const { unsavedText, watching } = await import('../../web/work.js');

const run = (x = {}) => ({
  id: '20261117-100000-aaaaaaaa', item: 'renew', title: 'Renew', startedAt: '2026-11-17T10:00:00.000Z', endedAt: null, project: 'shop', folder: '.',
  tool: 'claude', provider: 'sub', providerLabel: 'Main', model: null, session: '0b6c3c1e-1111-4222-8333-444455556666', state: 'running', reason: null,
  answer: '', commits: [], changed: [], more: 0, statusError: null, here: true, ...x,
});

const task = (status) => ({ id: 'renew', at: 0, status, editable: true, title: 'Renew' });

test('the line under a task: a status that could not be written, a run that ended while the task is doing, another computer, open again', () => {
  assert.equal(runLineKind(task('doing'), run()), 'working');
  assert.equal(runLineKind(task('doing'), run({ here: false })), 'elsewhere', 'another computer\'s session is not offered here');
  assert.equal(runLineKind(task('review'), run({ state: 'done' })), 'review');
  assert.equal(runLineKind(task('doing'), run({ state: 'done', statusError: 'The task\'s status could not be changed: 2 items share the id' })), 'ended', 'the row says why and offers Do it again');
  assert.equal(runLineKind(task('doing'), run({ state: 'failed', reason: 'x' })), 'ended');
  assert.equal(runLineKind(task('open'), run({ state: 'done', statusError: 'could not' })), 'refused');
  assert.equal(runLineKind(task('open'), run({ state: 'failed', reason: 'The session ended in an error' })), 'why');
  assert.equal(runLineKind(task('waiting'), run({ state: 'limit', reason: 'limit' })), 'why');
  assert.equal(runLineKind(task('open'), run({ state: 'done' })), 'sentback', 'a task open again keeps a sign of its runs');
  assert.equal(runLineKind(task('done'), run({ state: 'done' })), null);
  assert.equal(runLineKind(task('open'), undefined), null);
});

test('Do it is offered alike on the row and in More: never in review, and again for a task left doing by a run that ended', () => {
  const ctx = (r) => ({ doIt: true, runs: r ? { renew: r } : {} });
  assert.equal(canDoIt(task('open'), ctx()), true);
  assert.equal(canDoIt(task('review'), ctx(run({ state: 'done' }))), false);
  assert.equal(canDoIt(task('doing'), ctx(run())), false, 'a session of this computer works on it');
  assert.equal(canDoIt(task('doing'), ctx(run({ state: 'done' }))), true, 'its run ended: Do it again');
  assert.equal(canDoIt(task('doing'), ctx(run({ here: false }))), true, 'another computer\'s run does not block it here');
  assert.equal(canDoIt(task('done'), ctx()), false);
  assert.equal(canDoIt(task('open'), { doIt: false, runs: {} }), false);
});

test('a run of another computer: no session to open here; a session link keeps the computer whose page is open', () => {
  assert.ok(texts(runCard(run({ state: 'done' }))).includes('Open the session'));
  const there = runCard(run({ here: false }));
  assert.ok(!texts(there).includes('Open the session'), 'nothing that would open a wrong page');
  assert.ok(texts(there).includes('Another computer'));
  // On another computer's Work page, a session link keeps that computer.
  machine.set('laptop');
  try {
    assert.equal(sessionLink('abc'), '#/m/laptop/chat/abc');
    assert.deepEqual(links(runCard(run())).filter((l) => l.includes('chat')), [`#/m/laptop/chat/${run().session}`]);
  } finally {
    machine.set(null);
  }
  assert.equal(sessionLink('abc'), '#/chat/abc');
});

test('Activity\'s filter: a project or day no run has any more is let go, so the runs show again', () => {
  const runs = [run({ project: 'shop', day: '2026-11-17' }), run({ project: 'blog', day: '2026-11-16' })];
  assert.deepEqual(usableFilter({ project: 'oldshop', day: '2026-01-01' }, runs), { project: '', day: '' });
  assert.deepEqual(usableFilter({ project: 'blog', day: '2026-11-17' }, runs), { project: 'blog', day: '2026-11-17' });
});

test('the page looks again by itself only while a session of this computer works', () => {
  assert.equal(watching({ runs: { a: run() } }), true);
  assert.equal(watching({ runs: { a: run({ state: 'done' }) }, items: [{ status: 'doing' }] }), false, 'a task left doing does not make the page reload for ever');
  assert.equal(watching({ runs: { a: run({ here: false }) } }), false);
});

test('a repaint puts the keyboard focus back on the control of the same row and label', () => {
  const control = (id, label) => {
    const row = { dataset: { id } };
    const el = { dataset: {}, textContent: label, closest: () => row, getAttribute: (k) => (k === 'aria-label' ? label : null), focus: () => (document.activeElement = el) };
    return el;
  };
  let shown = [control('a', 'Do it: a'), control('b', 'Do it: b')];
  const slot = { contains: (el) => shown.includes(el), querySelectorAll: () => shown };
  document.activeElement = shown[1];
  keepFocus(slot, () => (shown = [control('a', 'Do it: a'), control('b', 'Do it: b')]));
  assert.equal(document.activeElement, shown[1]);
});

test('the review and run actions are big enough for a finger, as the kit\'s own OK actions', () => {
  const css = fs.readFileSync(new URL('../../web/page-work.css', import.meta.url), 'utf8');
  const touch = (css.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  for (const sel of ['.wk-runline-actions .btn', '.wk-review-bar .btn', '.wk-run-actions .btn', '.wk-show-more']) assert.match(touch, new RegExp(`${sel.replace(/\./g, '\\.')}[^{]*\\{ min-height: 44px;`), sel);
  assert.match(touch, /\.wk-link \{ min-height: 44px; min-width: 44px;/);
});

test('a run card in the product\'s words: the provider\'s label, "Limit reached", files past the list counted; Save counts runs apart from changes', () => {
  assert.equal(RUN_WORDS.limit, 'Limit reached');
  const card = texts(runCard(run({ state: 'done', changed: [{ repo: '.', path: 'a.txt', kind: 'new' }], more: 4 }), { onTask: () => {} }));
  assert.ok(card.includes('Main') && !card.includes('sub'), card.join('|'));
  assert.ok(card.includes('5 files changed, not committed'));
  assert.ok(card.includes('and 4 more'));
  assert.ok(card.includes('All runs of the task'), 'the button says what it opens');
  assert.equal(unsavedText({ changes: [{}, {}, {}], runs: 122, files: [] }), '3 changes and 122 runs');
  assert.equal(unsavedText({ changes: [], runs: 1, files: [{}] }), '1 run');
  assert.equal(unsavedText({ changes: [], runs: 0, files: [{}] }), '1 change');
});
