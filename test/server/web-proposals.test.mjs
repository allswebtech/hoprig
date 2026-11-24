// Skills → proposals on the page (web/skillproposals.js), in a small stand-in DOM with a stand-in for the dashboard's
// answers (the same stand-in as web-learned.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    const cls = new Set();
    Object.assign(this, { tag, dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, open: false, isConnected: true });
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) };
    Object.defineProperty(this, 'className', { get: () => [...cls].join(' '), set: (v) => { cls.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) cls.add(c); } });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(k, fn) {
    (this.listeners[k] ||= []).push(fn);
  }
  removeEventListener() {}
  fire(k, e = {}) {
    for (const fn of this.listeners[k] || []) fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...e });
  }
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  querySelectorAll(sel) {
    const parts = sel.split(',').map((x) => x.trim());
    const ok = (el, one) => {
      const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(one);
      if (!m) throw new Error(`selector not known to the stand-in: ${one}`);
      if (m[1] && el.tag !== m[1]) return false;
      for (const c of m[2].split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
      for (const [, k, v] of m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (!(k in el.attrs) || (v !== undefined && String(el.attrs[k]) !== v)) return false;
      return true;
    };
    return all(this).slice(1).filter((el) => el instanceof FakeElement && parts.some((one) => ok(el, one)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  contains(n) {
    return all(this).includes(n);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.fire('close');
  }
  get lastChild() {
    return this.children.at(-1) || null;
  }
  get textContent() {
    return all(this).map((x) => x.text || '').join('');
  }
  set textContent(t) {
    this.children = [{ text: t }];
  }
}
function all(n, out = []) {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
}
globalThis.Node = FakeNode;
const body = new FakeElement('body');
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  querySelector: () => null,
  visibilityState: 'visible',
  body,
  documentElement: new FakeElement('html'),
  activeElement: null,
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/', pathname: '/', search: '', protocol: 'http:', host: 'localhost', hostname: 'localhost', origin: 'http://localhost' };
globalThis.history = { replaceState() {} };
// The page's refresh every 3 s is kept here, not run by itself: a test runs it when it wants (timers).
const realTimeout = globalThis.setTimeout;
const timers = [];
globalThis.setTimeout = (fn, ms, ...a) => {
  if (ms === 3000) {
    timers.push(fn);
    return timers.length;
  }
  const t = realTimeout(fn, ms, ...a);
  t.unref?.();
  return t;
};

const answers = {};
const calls = [];
globalThis.fetch = async (u, o = {}) => {
  const p = u.split('?')[0];
  calls.push([o.method || 'GET', p, o.body ? JSON.parse(o.body) : null]);
  let data = answers[p];
  if (typeof data === 'function') data = await data(o.body ? JSON.parse(o.body) : null);
  if (data && data.__status) return { ok: false, status: data.__status, json: async () => ({ error: data.error || 'no answer' }) };
  return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data || {} };
};

const { h } = await import('../../web/lib.js');
const P = await import('../../web/skillproposals.js');

const text = (n) => all(n).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ');
const find = (n, pred) => all(n).find((x) => x instanceof FakeElement && pred(x));
const byLabel = (n, label) => find(n, (x) => x.tag === 'button' && (x.getAttribute('aria-label') === label || text(x).trim() === label));
const tick = () => new Promise((r) => realTimeout(r, 10));
const kit = { diffView: () => h('div.output', 'the diff'), tag: (level, words) => h('span', words || level) };
const verdict = (o = {}) => ({ whole: 'better', heldout: 'same', gain: true, blocked: null, ...o });
const card = (id, o = {}) => ({
  id, kind: 'skill', name: 'get-coding-done', why: ['The case work-do-hinglish failed once in 1 recorded run: Started a chat.'],
  numbers: { whole: { before: { passed: 83, cases: 85 }, after: { passed: 85, cases: 85 } }, heldout: { before: { passed: 3, cases: 3 }, after: { passed: 3, cases: 3 } }, tokens: { before: 77360, after: 76727 }, cost: { requests: 2, tokens: 20000, whole: 2, single: 22, dollars: 1.88 } },
  gates: ['whole', 'safety', 'heldout', 'size', 'threat', 'diff'].map((name) => ({ name, ok: true, why: '' })), verdict: verdict(), issue: null, created: '2026-11-19T10:00:00.000Z', stale: false,
  before: 'a', after: 'b', diff: { removed: [], added: [], changed: [{ path: 'SKILL.md', hunks: [{ oldStart: 1, newStart: 1, lines: [['-', 'a'], ['+', 'b']] }] }] }, state: 'waiting', at: null, ...o,
});
const list = (o = {}) => ({ waiting: [], accepted: [], put: [], unreadable: 0, unreadableFiles: [], ...o });
async function paint(data) {
  answers['/api/skills/proposals'] = typeof data === 'function' ? data : () => data;
  const box = new FakeElement('div');
  P.paintProposals(box, kit);
  await tick();
  return box;
}

test('the card says how the fresh tries went on both texts, and that only a gain larger than the spread counts', async () => {
  const base = card('20261119-140000-skill-get-coding-done');
  const box = await paint(list({ waiting: [{ ...base, numbers: { ...base.numbers, fresh: { rounds: 6, cases: 8, live: [6, 7, 6, 6, 7, 6], candidate: [8, 8, 8, 8, 8, 8], spread: 1 } } }] }));
  assert.match(text(box), /Tried again on 8 cases, 6 times each: the text now passed 6, 7, 6, 6, 7, 6; the new text 8, 8, 8, 8, 8, 8\. The text now varies by 1 between tries on its own, so only a gain larger than that counts\./);
  const none = await paint(list({ waiting: [base] }));
  assert.doesNotMatch(text(none), /Tried again on/);
});

test('a proposal that gained nothing, with a worse held-out part, is marked and cannot be accepted', async () => {
  const id = '20261119-080000-skill-triage-sessions';
  const box = await paint(list({ waiting: [card(id, { name: 'triage-sessions', verdict: verdict({ whole: 'same', heldout: 'worse', gain: false, blocked: 'it passes fewer of the cases it never saw while searching than the text now' }) })] }));
  const t = text(box);
  assert.match(t, /3 of 3 .*2 of 3|worse/);
  assert.match(t, /\bworse\b/);
  assert.match(t, /No better on the eval: accepting it changes the text but not the result\./);
  assert.match(t, /Worse than the text now/);
  const accept = byLabel(box, 'Accept the new text of triage-sessions');
  assert.ok(accept && ('disabled' in accept.attrs || accept.disabled === true), 'Accept is disabled');
  const good = await paint(list({ waiting: [card('20261119-090000-skill-get-coding-done')] }));
  assert.doesNotMatch(text(good), /No better on the eval|Worse than the text now/);
  assert.equal(find(good, (x) => x.classList.contains('pp-down')), undefined, 'no number is marked worse');
});

test('a done tool proposal says so, without Undo; a changed tool description is not told it "cannot be accepted"', async () => {
  const done = await paint(list({ accepted: [card('20261119-100000-tool-manage_project', { kind: 'tool', name: 'manage_project', done: true, state: 'waiting' })] }));
  assert.match(text(done), /Done: the description in the code is now this text\./);
  assert.equal(byLabel(done, 'Undo the new text of manage_project'), undefined);
  const stale = await paint(list({ waiting: [card('20261119-100100-tool-manage_project', { kind: 'tool', name: 'manage_project', stale: true, issue: 'Change it.' })] }));
  assert.match(text(stale), /this issue text may no longer fit/);
  assert.doesNotMatch(text(stale), /cannot be accepted/);
});

test('put-away proposals are listed with Show again; the unreadable note shows alone too, with each file and why', async () => {
  const id = '20261119-080000-skill-triage-sessions';
  const box = await paint(list({ put: [card(id, { name: 'triage-sessions', state: 'later', at: '2026-11-19T11:00:00.000Z' })] }));
  assert.match(text(box), /Put away \(1\)/);
  answers[`/api/skills/proposals/${id}/again`] = { ok: true };
  byLabel(box, 'Show again: triage-sessions').fire('click');
  await tick();
  assert.ok(calls.some(([m, p]) => m === 'POST' && p.endsWith(`${id}/again`)));
  const only = await paint(list({ unreadable: 1, unreadableFiles: [{ file: '20261119-070000-skill-x.json', why: 'the proposal file is not valid JSON' }] }));
  assert.match(text(only), /One proposal file could not be read/);
  assert.match(text(only), /20261119-070000-skill-x\.json : the proposal file is not valid JSON|20261119-070000-skill-x\.json: the proposal file is not valid JSON/);
});

test('after Accept with the keyboard the focus is on the Undo that took the card\'s place, and after Undo on Accept again', async () => {
  const id = '20261119-090000-skill-get-coding-done';
  let accepted = false;
  answers[`/api/skills/proposals/${id}/accept`] = () => { accepted = true; return { ok: true, name: 'get-coding-done' }; };
  answers[`/api/skills/proposals/${id}/undo`] = () => { accepted = false; return { ok: true, name: 'get-coding-done' }; };
  const box = await paint(() => (accepted ? list({ accepted: [card(id, { state: 'accepted', at: '2026-11-19T11:00:00.000Z' })] }) : list({ waiting: [card(id)] })));
  byLabel(box, 'Accept the new text of get-coding-done').fire('click');
  await tick();
  await tick();
  assert.equal(globalThis.document.activeElement && globalThis.document.activeElement.getAttribute('aria-label'), 'Undo the new text of get-coding-done');
  byLabel(box, 'Undo the new text of get-coding-done').fire('click');
  await tick();
  await tick();
  assert.equal(globalThis.document.activeElement.getAttribute('aria-label'), 'Accept the new text of get-coding-done');
});

test('the token row says per eval case, cache included, never per turn', async () => {
  const box = await paint(list({ waiting: [card('20261119-090000-skill-get-coding-done')] }));
  assert.match(text(box), /Tokens per eval case \(cache included\)/);
  assert.doesNotMatch(text(box), /per turn/);
});

test('the checks are named in plain words, and the card says where Undo is later', async () => {
  const box = await paint(list({ waiting: [card('20261119-090000-skill-get-coding-done')] }));
  const t = text(box);
  for (const w of ['No worse on the whole eval than the text now', 'Every safety case passed', 'No worse on cases it never saw while searching', 'No link, secret, machine path or new order to the model added', 'Short enough to read as a diff']) assert.ok(t.includes(w), w);
  assert.doesNotMatch(t, /\bheldout\b|\bthreat\b/);
  assert.match(t, /Undo stays under "Accepted changes to Tia"/);
});

test('a short diff is shown whole, a long one has Show all, and every scroll box is a named keyboard stop', async () => {
  const short = await paint(list({ waiting: [card('20261119-090000-skill-get-coding-done')] }));
  const box = find(short, (x) => x.getAttribute('aria-label') === 'What changes in get-coding-done');
  assert.ok(box, 'the diff box has a name');
  assert.equal(box.getAttribute('tabindex'), '0');
  assert.equal(box.style.maxHeight, 'none');
  for (const label of ['get-coding-done now', 'get-coding-done after']) assert.equal(find(short, (x) => x.getAttribute('aria-label') === label).getAttribute('tabindex'), '0', label);
  const lines = Array.from({ length: 150 }, (_, i) => ['+', `line ${i}`]);
  const long = await paint(list({ waiting: [card('20261119-090100-skill-get-coding-done', { diff: { removed: [], added: [], changed: [{ path: 'SKILL.md', hunks: [{ oldStart: 1, newStart: 1, lines }] }] } })] }));
  const more = find(long, (x) => x.tag === 'button' && /Show all 151 lines/.test(text(x)));
  assert.ok(more, text(long).slice(0, 300));
  more.fire('click');
  assert.equal(find(long, (x) => x.getAttribute('aria-label') === 'What changes in get-coding-done').style.maxHeight, 'none');
  assert.equal(more.hidden, true);
  assert.equal(globalThis.document.activeElement.getAttribute('aria-label'), 'What changes in get-coding-done');
});

test('after Show again on a card that cannot be accepted, the focus goes to its Not now, not to the page', async () => {
  const id = '20261119-080000-skill-triage-sessions';
  let put = true;
  answers[`/api/skills/proposals/${id}/again`] = () => { put = false; return { ok: true }; };
  const one = card(id, { name: 'triage-sessions', verdict: verdict({ whole: 'same', heldout: 'worse', gain: false, blocked: 'it passes fewer of the cases it never saw while searching than the text now' }) });
  const box = await paint(() => (put ? list({ put: [{ ...one, state: 'later' }] }) : list({ waiting: [one] })));
  byLabel(box, 'Show again: triage-sessions').fire('click');
  await tick();
  await tick();
  assert.equal(globalThis.document.activeElement.getAttribute('aria-label'), 'Not now: triage-sessions');
});
