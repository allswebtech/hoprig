// Tia's cards and messages in the page (web/tiacards.js, web/tiamsg.js): markup, links and scripts in any field or in
// her text show as text; a link is only ever a page address of this dashboard; a choice's tap sends its words and
// nothing else; the working line never shows a tool's inside name; a dynamic card follows its subject through the
// page's poller and one batched request, and says "checking" rather than an old state after a reload.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = String(t);
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, disabled: false, hidden: false, value: '' });
    const names = () => this.className.split(' ').filter(Boolean);
    this.classList = {
      add: (...c) => { this.className = [...new Set([...names(), ...c])].join(' '); },
      remove: (c) => { this.className = names().filter((x) => x !== c).join(' '); },
      contains: (c) => names().includes(c),
      toggle: (c, on) => {
        const want = on === undefined ? !names().includes(c) : on;
        if (want) this.classList.add(c);
        else this.classList.remove(c);
        return want;
      },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(n));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  get textContent() {
    return texts(this).join('');
  }
  set textContent(t) {
    this.children = [new FakeText(t)];
  }
  get isConnected() {
    return true;
  }
  get offsetHeight() {
    return 0;
  }
  contains() {
    return false;
  }
  closest() {
    return null;
  }
  focus() {}
  all() {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [c, ...c.all()] : []));
  }
  querySelectorAll(sel) {
    const parts = sel.split(',').map((x) => x.trim());
    const hit = (e, one) => {
      const [tag, ...cls] = one.split(/(?=\.)/).filter(Boolean);
      const tagOk = tag.startsWith('.') ? true : e.tag === tag;
      const classes = (tag.startsWith('.') ? [tag, ...cls] : cls).map((c) => c.slice(1).replace(/:not\(.*\)$/, ''));
      return tagOk && classes.every((c) => e.classList.contains(c));
    };
    return this.all().filter((e) => parts.some((one) => hit(e, one)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
  activeElement: null,
};
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const elements = (n) => (n instanceof FakeElement ? [n, ...n.all()] : []);
const flush = () => new Promise((r) => setTimeout(r, 0));

const { cardElement, closeChoice, setSource, fromStore, formFields } = await import('../../web/tiacards.js');
const { messageView } = await import('../../web/tiamsg.js');
const { doingLine } = await import('../../web/tiawords.js');

const EVIL = '<script>alert(1)</script><img src="https://track.example/p.gif" onerror="x()"> [docs](javascript:alert(1)) <a href="data:text/html,x">y</a>';
const cut = (n) => EVIL.slice(0, n);
const now = Date.now();
const fixtures = [
  { kind: 'open', id: 'v_000000000001', at: now, label: cut(80), href: '#/providers' },
  { kind: 'list', id: 'v_000000000002', at: now, title: cut(120), items: [{ label: cut(120), sub: cut(120), state: 'working', href: 'javascript:alert(1)' }, { label: 'shop', href: '#/s/shop' }], total: 2, all: { label: 'Show all', href: 'https://evil.example' } },
  { kind: 'numbers', id: 'v_000000000003', at: now, title: cut(120), rows: [{ label: cut(60), value: 40, unit: '%', of: 100 }], asOf: now },
  { kind: 'choice', id: 'v_000000000004', at: now, question: cut(300), options: ['<b>shop</b>', 'alpha'], free: true },
  { kind: 'result', id: 'v_000000000005', at: now, ok: true, title: cut(160), changed: [cut(160)], see: { label: 'Open Work', href: 'data:text/html,x' }, undo: true },
  { kind: 'status', id: 'v_000000000006', at: now, subject: { type: 'session', computer: 'this', id: 'shop' }, title: cut(120), state: 'working', since: now - 60_000, note: cut(200), step: { label: 'Open the session', href: '#/s/shop' } },
  { kind: 'progress', id: 'v_000000000007', at: now, subject: { type: 'job', computer: 'this', id: 'j_0123456789' }, title: cut(160), steps: ['a', 'b'], done: 1, state: 'working', started: now - 120_000, step: { label: 'Open the jobs', href: '#/tia/jobs' } },
  { kind: 'needs', id: 'v_000000000008', at: now, items: [{ id: 'limit-aaaaaaaaaaaa', rev: 'r00000000001', subject: cut(80), kind: 'limit', facts: [cut(100)], why: cut(160), act: { id: 'switch', label: 'Continue', risk: 'low' } }], total: 1, all: { label: 'Show all', href: '#/operator' } },
];

// The page's poller and the views route, as stand-ins: what the cards read, and how often.
let sessions = [{ name: 'shop', status: 'working', statusAt: now - 60_000 }];
const calls = { views: [], subscribed: 0 };
const ticks = [];
let readAt = Date.now() + 3_600_000;
let answer = (ids) => Object.fromEntries(ids.map((id) => [id, null]));
setSource({
  computers: () => [{ machine: null, status: 'online', sessions }],
  // The poller's last list was asked for now (a test moves it back to before a card came).
  readAt: () => readAt,
  subscribe: (fn) => {
    calls.subscribed++;
    ticks.push(fn);
    return () => {};
  },
  views: async (ids) => {
    calls.views.push(ids);
    return { cards: answer(ids) };
  },
  now: () => Date.now(),
});

test('a password field renders as a masked input, not cleartext, and is kept out of browser autofill (decision 3)', () => {
  // The Ask card for an administrator command carries a `password` field (owner-tools cardForm). cardkinds defines it
  // as a distinct secret type, but formFields rendered it as type=text, so the password showed in the clear and could
  // be stored by form autofill. It must render as <input type=password autocomplete=off>.
  const { el } = formFields({ title: 'Run an administrator command?', fields: [
    { name: 'command', label: 'Runs as administrator', type: 'readonly', value: 'sudo apt-get update' },
    { name: 'admin_password', label: 'Administrator password', type: 'password', value: null },
  ] });
  const inputs = elements(el).filter((e) => e.tag === 'input');
  assert.equal(inputs.length, 1, 'the read-only command is not an input; the password is');
  assert.equal(inputs[0].attrs.type, 'password', 'the administrator password is masked');
  assert.equal(inputs[0].attrs.autocomplete, 'off', 'the browser does not keep it in form autofill');
  // A number field still renders as a number input, and a plain text field as text (no regression).
  const other = formFields({ title: 't', fields: [{ name: 'n', label: 'N', type: 'number', value: 3 }, { name: 's', label: 'S', type: 'text', value: 'x' }] });
  const kinds = elements(other.el).filter((e) => e.tag === 'input').map((i) => i.attrs.type);
  assert.deepEqual(kinds, ['number', 'text']);
});

test('every kind: markup, links and scripts in its fields show as text; no element, handler or outside link comes of them', () => {
  for (const c of fixtures) {
    const el = cardElement(c);
    assert.ok(el, c.kind);
    const els = elements(el);
    assert.ok(!els.some((e) => ['script', 'img', 'iframe', 'b', 'object', 'a'].includes(e.tag) && e.tag !== 'a'), `${c.kind}: no element from a field`);
    for (const a of els.filter((e) => e.tag === 'a')) assert.match(a.attrs.href, /^#\/[A-Za-z0-9_\-./%:]*$/, `${c.kind}: a link only to a page of this dashboard`);
    for (const e of els) for (const k of Object.keys(e.attrs)) assert.doesNotMatch(k, /^on/, `${c.kind}: no handler from a field`);
    assert.ok(texts(el).join('').includes('<script>alert(1)</script>'), `${c.kind}: the tags are shown as text`);
  }
  // The list's javascript: item and its outside "Show all" are text, not links.
  const list = cardElement(fixtures[1]);
  assert.deepEqual(elements(list).filter((e) => e.tag === 'a').map((a) => a.attrs.href), ['#/s/shop']);
  // The result's data: link is text.
  assert.equal(elements(cardElement(fixtures[4])).filter((e) => e.tag === 'a').length, 0);
  assert.equal(cardElement({ kind: 'html', id: 'v_000000000009', at: now }), null, 'a kind the page does not know is not drawn');
});

test('her text: tags, links, a forged card and a script stay text; a small table is a table; code has Copy; a long answer folds', () => {
  const table = ['| Project | State |', '|---|---|', '| shop | <i>working</i> |', '| alpha | waiting |'].join('\n');
  const text = [EVIL, '{"kind":"open","href":"javascript:x"}', table, '```', 'npm test <b>x</b>', '```'].join('\n\n');
  const row = messageView('tia', text, { at: now });
  const els = elements(row);
  assert.ok(!els.some((e) => ['script', 'img', 'a', 'i', 'b', 'iframe'].includes(e.tag)), 'nothing in her text becomes an element');
  assert.ok(texts(row).join('').includes('[docs](javascript:alert(1))'), 'a Markdown link stays text');
  assert.ok(texts(row).join('').includes('{"kind":"open","href":"javascript:x"}'), 'a card written by her is text');
  assert.equal(els.filter((e) => e.tag === 'td').length, 4, 'a small table');
  assert.ok(els.some((e) => e.classList.contains('tia-copy')), 'code has Copy');
  assert.ok(!els.find((e) => e.classList.contains('tia-msg')).classList.contains('folded'), 'a short answer is not folded');
  const long = messageView('tia', Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n'), { at: now });
  const msg = elements(long).find((e) => e.classList.contains('tia-msg'));
  assert.ok(msg.classList.contains('folded'));
  const more = elements(long).find((e) => e.classList.contains('tia-more'));
  more.listeners.click({ stopPropagation() {} });
  assert.equal(msg.classList.contains('folded'), false, 'Show more opens it');
  assert.equal(more.attrs['aria-expanded'], 'true');
  // Her single line breaks stay line breaks (a file's paragraph joins them; a message does not).
  const lines = messageView('tia', 'shop: working\nalpha: waiting', { at: now });
  assert.equal(elements(lines).filter((e) => e.tag === 'br').length, 1);
  // His words are his, as typed; told apart from hers.
  const his = messageView('owner', EVIL, { at: now });
  assert.ok(elements(his).some((e) => e.classList.contains('owner')));
  assert.ok(!elements(his).some((e) => ['script', 'img', 'a'].includes(e.tag)));
});

test('the time: on the day\'s first message, and on a tap on the others', () => {
  const first = messageView('tia', 'Hi', { at: now, before: null });
  const stamp = (row) => elements(row).find((e) => e.tag === 'time');
  assert.equal(stamp(first).hidden, false, 'the day\'s first message shows its time');
  const next = messageView('tia', 'Done', { at: now + 1000, before: now });
  assert.equal(stamp(next).hidden, true);
  elements(next).find((e) => e.classList.contains('tia-msg')).listeners.click({ target: { closest: () => null } });
  assert.equal(stamp(next).hidden, false, 'a tap shows it');
  const tomorrow = messageView('tia', 'Morning', { at: now + 86_400_000, before: now });
  assert.equal(stamp(tomorrow).hidden, false, 'a new day starts with its time again');
});

test('a choice: a tap sends that answer\'s words as his message and nothing else, once; the card then says what he answered', async () => {
  const sent = [];
  const el = cardElement(fixtures[3], { answer: async (t) => { sent.push(t); return true; } });
  const options = elements(el).filter((e) => e.classList.contains('tia-c-option'));
  assert.deepEqual(options.map((o) => o.textContent), ['<b>shop</b>', 'alpha']);
  await options[1].listeners.click();
  await options[0].listeners.click();
  assert.deepEqual(sent, ['alpha'], 'one answer, sent as it reads');
  assert.ok(options.every((o) => o.disabled));
  assert.match(texts(el).join(''), /You answered: alpha/);
  // A message that could not be sent leaves the question open.
  const el2 = cardElement(fixtures[3], { answer: async () => false });
  await elements(el2).find((e) => e.classList.contains('tia-c-option')).listeners.click();
  assert.equal(el2.classList.contains('answered'), false);
});

test('the working line names what she does in plain words, never a tool\'s inside name', () => {
  assert.equal(doingLine('read_attention'), 'looking at what needs you');
  assert.equal(doingLine('manage_computer', 'update'), 'updating');
  assert.equal(doingLine('some_new_tool'), 'working on it');
  assert.doesNotMatch(doingLine('manage_widgets'), /_/);
  assert.equal(doingLine('notify_owner', 'ask'), 'asking you', 'a question in the chat is not a push');
});

test('a status card follows the session through the page\'s poller; an ended one says so; a gone one says it is gone', async () => {
  const c = { ...fixtures[5], title: 'shop' };
  const el = cardElement(c);
  await flush();
  assert.match(texts(el).join(''), /Working/);
  sessions = [{ name: 'shop', status: 'attention', note: 'Allow npm test?', statusAt: Date.now() }];
  ticks.at(-1)();
  await flush();
  assert.match(texts(el).join(''), /Needs your OK/, 'it changed in place');
  assert.match(texts(el).join(''), /Allow npm test\?/);
  sessions = [{ name: 'shop', status: 'ended', statusAt: Date.now() }];
  ticks.at(-1)();
  await flush();
  assert.match(texts(el).join(''), /Ended/);
  assert.ok(el.classList.contains('ended'));
  sessions = [];
  ticks.at(-1)();
  await flush();
  assert.match(texts(el).join(''), /Gone/);
  assert.match(texts(el).join(''), /This session has ended\./);
  // A computer that cannot be reached: not known, never the old state.
  assert.equal(fromStore(c, [{ machine: null, status: 'offline', sessions: [] }]).state, 'unknown');
});

test('a card from the history after a reload says "checking" until it is read again, never the state it was made in', async () => {
  const old = { ...fixtures[6], id: 'v_0000000000aa', at: Date.now() - 3_600_000 };
  const el = cardElement(old);
  assert.match(texts(el).join(''), /Checking/);
  assert.doesNotMatch(texts(el).join(''), /Working/, 'not the state of an hour ago');
  answer = (ids) => Object.fromEntries(ids.map((id) => [id, id === old.id ? { ...old, state: 'done', done: 2, ended: Date.now() } : null]));
  ticks.at(-1)();
  await flush();
  await flush();
  assert.match(texts(el).join(''), /Done/);
  assert.doesNotMatch(texts(el).join(''), /Checking/);
  // The height kept for the change is let go on the next tick in which nothing changed.
  el.style.minHeight = '300px';
  ticks.at(-1)();
  await flush();
  await flush();
  assert.equal(el.style.minHeight, '', 'no empty frame is left');
});

test('all dynamic cards in view are read by ONE request per tick of the page\'s poller; no card has a timer of its own', async () => {
  const realSet = globalThis.setInterval;
  const timers = [];
  globalThis.setInterval = (...a) => {
    timers.push(a);
    return 0;
  };
  try {
    calls.views.length = 0;
    const subs = calls.subscribed;
    for (let i = 0; i < 10; i++) cardElement({ ...fixtures[6], id: `v_0000000001${String(i).padStart(2, '0')}`, at: Date.now() });
    await flush();
    assert.ok(calls.subscribed - subs <= 1, 'they share the page\'s one poller');
    ticks.at(-1)();
    await flush();
    assert.equal(calls.views.length, 1, 'one request for every card on screen');
    assert.ok(calls.views[0].length >= 10);
    assert.equal(timers.length, 0, 'no timer of a card\'s own');
  } finally {
    globalThis.setInterval = realSet;
  }
});

test('a needs card: a tap goes through the Operator\'s act route with the rev it was drawn on; a changed item refuses and says so', async () => {
  const taps = [];
  setSource({ tap: async (it) => { taps.push([it.id, it.act.id, it.rev]); const e = new Error('that item changed since you saw it'); e.status = 409; e.data = { current: { id: it.id } }; throw e; } });
  const el = cardElement({ ...fixtures[7], id: 'v_0000000002aa', at: Date.now() });
  const act = elements(el).find((e) => e.classList.contains('tia-c-act'));
  assert.equal(act.attrs['aria-label'].startsWith('Continue: '), true, 'its name says which item it is for');
  await act.listeners.click({ currentTarget: act });
  assert.deepEqual(taps, [['limit-aaaaaaaaaaaa', 'switch', 'r00000000001']]);
  assert.match(texts(el).join(''), /It changed since you saw it, so nothing was done/);
});

test('a status card follows its session by the terminal\'s own id, which a rename keeps', () => {
  const c = { ...fixtures[5], subject: { type: 'session', computer: 'this', id: 'shop', created: 1_700_000_000_000, term: '$4' } };
  const renamed = fromStore(c, [{ machine: null, status: 'online', sessions: [{ name: 'shop-2', termId: '$4', created: 1_700_000_000_000, status: 'working', statusAt: now }] }]);
  assert.deepEqual([renamed.state, renamed.subject.id, renamed.step.href], ['working', 'shop-2', '#/s/shop-2'], 'still there under its new name');
  // A new session that took the old name is another terminal: the card's own has ended.
  const other = fromStore(c, [{ machine: null, status: 'online', sessions: [{ name: 'shop', termId: '$9', created: 1_700_000_000_000, status: 'asks', note: 'Allow Bash: x', statusAt: now }] }]);
  assert.equal(other.state, 'gone');
  assert.equal(other.note, undefined);
});

test('two terminals made in the same second: a card never follows the other one, alive or after its own ended', () => {
  const T = 1_700_000_000_000;
  const card = (id, term) => ({ ...fixtures[5], subject: { type: 'session', computer: 'this', id, created: T, ...(term ? { term } : {}) }, step: { label: 'Open the session', href: `#/s/${id}` } });
  const alpha = { name: 'alpha', termId: '$1', created: T, status: 'attention', note: 'Allow Bash: rm -rf build', statusAt: now };
  const beta = { name: 'beta', termId: '$2', created: T, status: 'working', statusAt: now };
  const on = (...ss) => [{ machine: null, status: 'online', sessions: ss }];
  const shows = (x) => [x.subject.id, x.state, x.note, x.step.href];
  // Both alive: each card shows its own.
  assert.deepEqual(shows(fromStore(card('beta', '$2'), on(alpha, beta))), ['beta', 'working', undefined, '#/s/beta']);
  // beta renamed: found by its own id, never alpha by the second.
  assert.deepEqual(shows(fromStore(card('beta', '$2'), on(alpha, { ...beta, name: 'beta-2' }))), ['beta-2', 'working', undefined, '#/s/beta-2']);
  // beta ended, alpha of the same second still open: beta's card says it ended, with nothing of alpha's (the probe of
  // the last look: before, it turned into alpha's card with alpha's question and a step to alpha).
  for (const c of [card('beta', '$2'), card('beta')]) {
    const gone = fromStore(c, on(alpha));
    assert.equal(gone.state, 'gone', JSON.stringify(c.subject));
    assert.deepEqual([gone.subject.id, gone.note, gone.step.href], ['beta', undefined, '#/s/beta']);
  }
  // The same with a newer session that took the name beta: another terminal, so still ended.
  assert.equal(fromStore(card('beta', '$2'), on(alpha, { ...beta, termId: '$5', created: T + 5000 })).state, 'gone');
  // A card made before the id existed follows its name only: renamed, it says its session ended (never alpha's).
  assert.equal(fromStore(card('beta'), on(alpha, { ...beta, name: 'beta-2' })).state, 'gone');
});

test('an ended session\'s card says so in words', () => {
  const el = cardElement({ ...fixtures[5], id: 'v_00000000e0aa', at: Date.now(), state: 'gone' });
  assert.match(texts(el).join(' '), /This session has ended\./);
});

test('a status card just made never says "Gone" before a poll taken after it came', async () => {
  const before = Date.now() - 2000; // the poller's last list was asked for before the session existed
  readAt = before;
  sessions = [];
  const el = cardElement({ ...fixtures[5], id: 'v_0000000003aa', at: Date.now(), title: 'new1', state: 'starting', subject: { type: 'session', computer: 'this', id: 'new1' } });
  await flush();
  assert.match(texts(el).join(''), /Starting/);
  assert.doesNotMatch(texts(el).join(''), /Gone/);
  assert.equal(el.classList.contains('ended'), false);
  ticks.at(-1)();
  await flush();
  assert.doesNotMatch(texts(el).join(''), /Gone/, 'a tick of that old list changes nothing');
  // A list asked for after the card came that still lacks it: gone.
  readAt = Date.now() + 1000;
  ticks.at(-1)();
  await flush();
  assert.match(texts(el).join(''), /Gone/);
  readAt = Date.now() + 3_600_000;
});

test('a dynamic card that could not be read says so and as of when; one never read keeps "Checking…"', async () => {
  const fresh = { ...fixtures[6], id: 'v_0000000004aa', at: Date.now() - 5000 };
  const old = { ...fixtures[6], id: 'v_0000000004bb', at: Date.now() - 3_600_000 };
  const a = cardElement(fresh);
  const b = cardElement(old);
  answer = (ids) => Object.fromEntries(ids.map((id) => [id, id === fresh.id ? { ...fresh, unread: true } : id === old.id ? { ...old, unread: true } : null]));
  ticks.at(-1)();
  await flush();
  await flush();
  assert.match(texts(a).join(''), /Could not be read now; this is as of/);
  assert.match(texts(b).join(''), /Checking/);
  assert.doesNotMatch(texts(b).join(''), /Working/, 'not the state of an hour ago');
  answer = (ids) => Object.fromEntries(ids.map((id) => [id, null]));
});

test('a list with states says when they were read; one drawn again from the history leaves them out until the poller has them', async () => {
  const list = { kind: 'list', id: 'v_0000000005aa', title: 'Sessions', items: [{ label: 'shop', state: 'asks', href: '#/s/shop' }, { label: 'alpha', state: 'working', href: '#/s/alpha' }], total: 2, all: { label: 'Show all', href: '#/' } };
  const was = { sessions, readAt };
  sessions = [{ name: 'shop', status: 'attention' }, { name: 'alpha', status: 'working' }];
  readAt = Date.now() + 3_600_000;
  try {
    const fresh = texts(cardElement({ ...list, at: Date.now() })).join(' ');
    assert.match(fresh, /Needs your OK/);
    assert.match(fresh, /As of /);
    // The poller has nothing yet (the page just opened): an hour-old list claims no state.
    let none = true;
    setSource({ computers: () => (none ? [] : [{ machine: null, status: 'online', sessions }]) });
    const el = cardElement({ ...list, id: 'v_0000000005ab', at: Date.now() - 3_600_000 });
    const old = texts(el).join(' ');
    assert.doesNotMatch(old, /Needs your OK|Working/, 'no state of an hour ago');
    assert.match(old, /Read at .*open the page for what is so now/);
    // Once it has them, the list says the states of now.
    none = false;
    await flush();
    ticks.at(-1)();
    await flush();
    assert.match(texts(el).join(' '), /Needs your OK.*Working.*As of /);
    // A list without states (tasks) has no time line.
    assert.doesNotMatch(texts(cardElement({ ...list, at: Date.now(), items: [{ label: 'Write the docs', href: '#/work' }] })).join(' '), /As of|Read at/);
  } finally {
    setSource({ computers: () => [{ machine: null, status: 'online', sessions }] });
    ({ sessions, readAt } = was);
  }
});

test('a Sessions list drawn 15 s or more after it was made keeps its states: it follows the page\'s poller', async () => {
  // The demo's tia-desktop: the second "Sessions" list was made by list_sessions, the page opened 20 s later. Before,
  // every draw later than 15 s after the card was made left out all its states for good ("Read at …").
  const was = { sessions, readAt };
  sessions = [{ name: 'shop', status: 'attention' }, { name: 'alpha', status: 'working' }, { name: 'chat:c1', kind: 'chat', status: 'waiting' }];
  readAt = Date.now() + 3_600_000;
  try {
    const made = Date.now() - 20_000;
    const el = cardElement({ kind: 'list', id: 'v_0000000005ba', at: made, title: 'Sessions', total: 4, all: { label: 'Show all', href: '#/' },
      items: [{ label: 'shop', state: 'asks', href: '#/s/shop' }, { label: 'alpha', state: 'waiting', href: '#/s/alpha' }, { label: 'Fix the cart', state: 'working', href: '#/chat/c1' }, { label: 'beta', state: 'working', href: '#/s/beta' }] });
    const at0 = texts(el).join(' ');
    assert.match(at0, /shop\s*Needs your OK/, 'the state of now, drawn 20 s after it was made');
    assert.match(at0, /alpha\s*Working/, 'what the poller says now, not what the list said then');
    assert.match(at0, /Fix the cart\s*Finished/, 'a chat by its own name');
    assert.match(at0, /beta\s*Gone/, 'a session the poller does not have any more');
    assert.doesNotMatch(at0, /Read at/);
    // The poller's next ticks (every 3 s): the states stay, and follow a change.
    sessions = [{ name: 'shop', status: 'working' }, { name: 'alpha', status: 'working' }, { name: 'chat:c1', kind: 'chat', status: 'waiting' }];
    await flush();
    for (let i = 0; i < 3; i++) ticks.at(-1)();
    await flush();
    const later = texts(el).join(' ');
    assert.match(later, /shop\s*Working/);
    assert.match(later, /As of /);
    assert.doesNotMatch(later, /Read at|Needs your OK/);
    // A computer that cannot be reached: its sessions' states are not known now, never the old ones.
    setSource({ computers: () => [{ machine: null, status: 'offline', sessions }] });
    ticks.at(-1)();
    await flush();
    assert.match(texts(el).join(' '), /shop\s*Not known now/);
  } finally {
    setSource({ computers: () => [{ machine: null, status: 'online', sessions }] });
    ({ sessions, readAt } = was);
  }
});

test('a status card\'s step says what to do in the state it is in now', () => {
  const c = { ...fixtures[5], state: 'asks', step: { label: 'Answer it', href: '#/s/shop' } };
  const at = (status) => fromStore(c, [{ machine: null, status: 'online', sessions: [{ name: 'shop', status, statusAt: now }] }]);
  assert.equal(at('working').step.label, 'Open the session');
  assert.equal(at('attention').step.label, 'Answer it');
  assert.equal(at('working').step.href, '#/s/shop');
});

test('the page\'s own redraw of a session note cuts a path of the computer, as the server\'s card does', () => {
  const at = (s) => fromStore(fixtures[5], [{ machine: null, status: 'online', sessions: [{ name: 'shop', statusAt: now, ...s }] }]);
  assert.equal(at({ status: 'attention', note: 'Allow Bash: cat /home/alex/.ssh/id_ed25519' }).note, 'Allow Bash: cat …/id_ed25519');
  assert.equal(at({ status: 'working', lastMessage: 'Saved C:\\Users\\alex\\shop\\a.txt and\n/Users/alex/x/y.md' }).note, 'Saved …/a.txt and …/y.md');
});

test('the page\'s own redraw of a session note masks a key, as the server\'s card does, with the server\'s own shapes', async () => {
  const { SHAPES, NAMED, redact } = await import('../../src/assistant/secrets.mjs');
  const { shortText } = await import('../../src/assistant/cardkinds.mjs');
  const { PATTERNS } = await import('../../web/redact.js');
  assert.deepEqual(PATTERNS.shapes, SHAPES.map((re) => re.source), 'the page masks what the server masks');
  assert.equal(PATTERNS.named, NAMED.source);
  const { HIDDEN_PATTERNS } = await import('../../src/assistant/fence.mjs');
  assert.deepEqual(PATTERNS.hidden, HIDDEN_PATTERNS.map((re) => re.source), 'the page takes out what the server takes out, in its order');
  const at = (s) => fromStore(fixtures[5], [{ machine: null, status: 'online', sessions: [{ name: 'shop', statusAt: now, ...s }] }]);
  const ask = 'Allow Bash: curl -H "x-api-key: sk-ant-api03-abcdefghijklmnop" https://api.example.com';
  const note = at({ status: 'attention', note: ask }).note;
  assert.equal(note, shortText(ask, 200));
  assert.doesNotMatch(note, /abcdefghijklmnop/);
  const said = at({ status: 'working', lastMessage: 'Pushed with ghp_abcdefghijklmnopqrstuvwxyz012345 to https://alex:s3cretPassw0rd@example.com/x.git' }).note;
  assert.equal(said, redact('Pushed with ghp_abcdefghijklmnopqrstuvwxyz012345 to https://alex:s3cretPassw0rd@example.com/x.git'));
  assert.doesNotMatch(said, /ghp_a|s3cret/);
});

test('a card the server no longer keeps says it is too old to follow, never that the dashboard restarted', async () => {
  const el = cardElement({ ...fixtures[6], id: 'v_0000000006aa', at: Date.now() });
  answer = (ids) => Object.fromEntries(ids.map((id) => [id, null]));
  ticks.at(-1)();
  await flush();
  await flush();
  assert.match(texts(el).join(''), /too old to follow/);
  assert.doesNotMatch(texts(el).join(''), /restarted/);
});

// The page's own styles for her conversation: a rule's declarations by its exact selector (the last one wins).
const CSS = fs.readFileSync(new URL('../../web/page-tiacards.css', import.meta.url), 'utf8');
const rule = (sel) => {
  const m = [...CSS.matchAll(new RegExp(`(?:^|[}\\n])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))];
  return m.length ? m.at(-1)[1] : '';
};

test('a long answer of a choice card wraps inside the card (the shared button style never wraps)', () => {
  const r = rule('.tia-c-option');
  assert.match(r, /white-space: normal/);
  assert.match(r, /overflow-wrap: anywhere/);
  assert.match(r, /max-width: 100%/);
  assert.match(rule('.tia-c-options'), /min-width: 0/);
});

test('a table keeps its words whole and scrolls in its frame instead of breaking them letter by letter', () => {
  assert.match(rule('.md-table'), /width: max-content/);
  assert.match(rule('.md-table th, .md-table td'), /overflow-wrap: normal/);
  assert.match(rule('.md-table th'), /white-space: nowrap/);
  assert.match(rule('.md-tablewrap'), /overflow-x: auto/);
});

test('a message is no Tab stop: its row is an article a screen reader names with who said it and when', () => {
  const t = new Date(2026, 10, 19, 9, 14).getTime();
  for (const [who, said] of [['tia', 'Tia said'], ['owner', 'You said']]) {
    const row = messageView(who, 'shop ka kya haal hai?', { at: t, before: t - 1000 });
    assert.equal(row.tag, 'article');
    assert.match(row.attrs['aria-label'], new RegExp(`^${said} at `));
    for (const e of elements(row)) assert.equal(e.attrs.tabindex, undefined, `${who}: no Tab stop`);
    assert.equal(elements(row).some((e) => e.tag === 'div' && e.attrs['aria-label']), false, 'no name on a plain div');
  }
});

test('"Show more" goes when the folded answer is whole on this screen, and comes back when it no longer fits', () => {
  const seen = [];
  const real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(fn) {
      seen.push(fn);
    }
    observe() {}
  };
  try {
    const row = messageView('tia', 'x '.repeat(800), { at: now });
    const msg = elements(row).find((e) => e.classList.contains('tia-msg'));
    const md = elements(row).find((e) => e.classList.contains('tia-md'));
    assert.ok(msg.classList.contains('folded'));
    Object.assign(md, { scrollHeight: 408, clientHeight: 408 }); // a wide screen: all of it shows
    seen.at(-1)();
    assert.ok(msg.classList.contains('fits'), 'nothing hidden: no "Show more"');
    assert.match(rule('.tia-msg.fits .tia-more'), /display: none/);
    Object.assign(md, { scrollHeight: 856, clientHeight: 520 }); // narrower: it hides some again
    seen.at(-1)();
    assert.equal(msg.classList.contains('fits'), false);
  } finally {
    globalThis.ResizeObserver = real;
  }
});

test('the day\'s first time is centred; a time shown on a tap sits at its own message\'s side', () => {
  const stampOf = (row) => elements(row).find((e) => e.tag === 'time');
  assert.ok(stampOf(messageView('tia', 'Hi', { at: now, before: null })).classList.contains('day'));
  assert.equal(stampOf(messageView('tia', 'Done', { at: now + 1000, before: now })).classList.contains('day'), false);
  assert.match(rule('.tia-time'), /justify-self: start/);
  assert.doesNotMatch(rule('.tia-time'), /center/, 'not centred by default');
  assert.match(rule('.tia-row.owner .tia-time'), /justify-self: end/);
  assert.match(rule('.tia-time.day, .tia-row.owner .tia-time.day'), /justify-self: center/);
  assert.doesNotMatch(CSS, /\.tia-time\.tap/, 'no dead selector');
});

test('on a phone a one-line code block is tall enough for its Copy button', () => {
  const phone = /@media \(max-width: 899px\) \{([\s\S]*)\}\s*$/.exec(CSS)[1];
  const h = /\.tia-codewrap \.md-code \{ min-height: (\d+)px; \}/.exec(phone);
  assert.ok(h, 'a min-height for the code block on a phone');
  const top = Number(/\.tia-copy \{[^}]*top: (\d+)px/.exec(CSS)[1]);
  assert.ok(Number(h[1]) >= top + 44, `${h[1]} px holds a 44 px button ${top} px from the top`);
});

test('an answer from a choice card\'s own box says "You answered" after a reload and on another device too', async () => {
  const card = { ...fixtures[3], question: 'Kaunsi branch?', options: ['main', 'dev'], free: true };
  const said = (el) => elements(el).find((e) => e.classList.contains('tia-c-said')).textContent;
  // Live: the box sends his words with this card's id; a tap on an answer sends no id.
  const sent = [];
  const live = cardElement(card, { answer: async (t, choice) => { sent.push([t, choice ?? null]); return true; } });
  elements(live).find((e) => e.classList.contains('tia-c-free')).value = 'release-2 please';
  await elements(live).find((e) => e.classList.contains('tia-c-sendown')).listeners.click();
  const tapped = cardElement(card, { answer: async (t, choice) => { sent.push([t, choice ?? null]); return true; } });
  await elements(tapped).find((e) => e.classList.contains('tia-c-option')).listeners.click();
  assert.deepEqual(sent, [['release-2 please', card.id], ['main', null]]);
  // Drawn again from the history: his message carries the card's id, kept by the server.
  const again = cardElement(card);
  closeChoice(again, 'release-2 please', card.id);
  assert.equal(said(again), 'You answered: release-2 please');
  // Another card's id, or none, is not an answer to this one.
  const other = cardElement(card);
  closeChoice(other, 'release-2 please', 'v_0000000000ff');
  assert.equal(said(other), 'Closed: you wrote a message instead.');
  assert.match(fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8'), /closeChoice\(q, e\.text, e\.choice\)/, 'the page passes the id his message carries');
});

test('his next message closes an open choice: "You answered" only for one of its answers or its own box', () => {
  const card = { ...fixtures[3], question: 'Kis project me login page fix karu?', options: ['shop', 'alpha'] };
  const said = (el) => elements(el).find((e) => e.classList.contains('tia-c-said')).textContent;
  const a = cardElement(card);
  closeChoice(a, 'alpha');
  assert.equal(said(a), 'You answered: alpha');
  const b = cardElement(card);
  closeChoice(b, 'ruko, pehle shop ka haal batao');
  assert.equal(said(b), 'Closed: you wrote a message instead.');
  assert.doesNotMatch(said(b), /You answered/);
  assert.ok(b.classList.contains('answered'));
  // Sent from the card's own box: his answer.
  const c = cardElement(card);
  c.dataset.sent = 'both, one after the other';
  closeChoice(c, 'both, one after the other');
  assert.equal(said(c), 'You answered: both, one after the other');
  assert.match(fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8'), /closeChoice\(q, e\.text, e\.choice\)/, 'the page closes open choices this way');
});

test('a key with a hidden character inside is masked in the page\'s note as in the server\'s card text', async () => {
  const { shortText } = await import('../../src/assistant/cardkinds.mjs');
  const { noteText } = await import('../../web/tiacards.js');
  const notes = [
    'Allow Bash: export KEY=sk-ant-api03\u200b-abcdefghijklmnop',
    'curl -u x sk-\u00adproj-abcdefghijklmnopqrstu',
    'token=\u2060abcdef123456 and more',
    'push with ghp_\ufeffabcdefghijklmnopqrstuvwxyz0123',
    '\u001b[31mAllow Bash: echo sk-ant-\u200dapi03-zzzzzzzzzzzz\u001b[0m',
    'Allow Bash: cat /home/alex/.ssh/id_ed25519',
  ];
  for (const n of notes) {
    const page = noteText(n);
    assert.equal(page, shortText(n, 200), JSON.stringify(n));
    assert.doesNotMatch(page, /sk-ant-api03|sk-proj|abcdef123456|ghp_abc/, JSON.stringify(n));
  }
});

test('while the page cannot read the sessions (the dashboard does not answer), a status card says as of when', async () => {
  sessions = [{ name: 'shop', status: 'working', statusAt: now }];
  readAt = Date.now() + 1000;
  const el = cardElement({ ...fixtures[5], id: 'v_00000000d0aa', at: Date.now() });
  await flush();
  ticks.at(-1)();
  await flush();
  assert.doesNotMatch(texts(el).join(''), /Could not be read now/);
  let down = new Error('not reachable');
  setSource({ error: () => down });
  ticks.at(-1)();
  await flush();
  assert.match(texts(el).join(''), /Could not be read now; this is as of /, 'it never shows its state as if it were so now');
  down = null;
  ticks.at(-1)();
  await flush();
  assert.doesNotMatch(texts(el).join(''), /Could not be read now/, 'read again: the note goes');
  setSource({ error: () => null });
});

test('when a restart of the dashboard closed the conversation, the page says so and leaves no card of it', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  const at = src.indexOf('if (e.status === 404) {');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf('\n      }', at));
  assert.match(block, /fill\(cardsBox, null\)/, 'no confirm card of the closed conversation stays');
  assert.match(block, /The dashboard restarted, so this conversation is closed/);
});

test('a card writes a length of time by the page\'s one unit rule: days as days, as Home and the sheet do', async () => {
  const { span } = await import('../../web/lib.js');
  const DAY = 86_400_000;
  const run = (extra) => texts(cardElement({ kind: 'progress', id: `v_00000000${String(Math.random()).slice(2, 6)}`, at: Date.now(), subject: { type: 'job', computer: 'this', id: 'j_0123456789' }, title: 'Build the shop', steps: ['a', 'b'], done: 1, state: 'working', step: { label: 'Open the jobs', href: '#/jobs' }, ...extra })).join('');
  const long = run({ started: Date.now() - 2 * DAY - 5 * 60_000 });
  assert.match(long, /2 days so far/);
  assert.doesNotMatch(long, /\d+ h/, 'never "48 h" against Home\'s "2 days"');
  assert.match(run({ started: Date.now() - 3 * 3600_000 - 20 * 60_000 }), /3 h so far/, 'the hours as lib.js writes them');
  assert.match(run({ started: Date.now() - 20_000 }), /under a minute so far/);
  const ended = Date.now() - 60_000;
  assert.match(run({ state: 'done', started: ended - DAY - 3600_000, ended }), /Took 1 day, ended/);
  assert.equal(span(2 * DAY + 300_000), '2 days', 'the same function as Home\'s');
  const need = texts(cardElement({ kind: 'needs', id: 'v_000000000099', at: Date.now(), items: [{ id: 'limit-bbbbbbbbbbbb', rev: 'r00000000001', subject: 'shop', kind: 'limit', since: new Date(Date.now() - 3 * DAY).toISOString(), facts: [], why: '', act: { id: 'switch', label: 'Continue', risk: 'low' } }], total: 1, all: { label: 'Open the Operator', href: '#/operator' } })).join('');
  assert.match(need, /3 days ago/);
});

test('a status card says what the session asks from its exact card, with the server\'s own words for it', async () => {
  const server = await import('../../src/askcard.mjs');
  const page = await import('../../web/tiacards.js');
  assert.equal(page.askLine.toString(), server.askLine.toString(), 'one function on both sides');
  const question = server.cardOf({ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which branch do I push?', header: 'Branch', options: [{ label: 'main' }, { label: 'dev' }] }, { question: 'Tag it?', options: [] }] } });
  const plan = server.cardOf({ tool: 'ExitPlanMode', input: { plan: 'Step 1' } });
  const allow = server.cardOf({ tool: 'Bash', what: 'npm run build' });
  const at = (s) => fromStore(fixtures[5], [{ machine: null, status: 'online', sessions: [{ name: 'shop', statusAt: now, status: 'attention', note: 'Claude needs your attention', ...s }] }]);
  assert.equal(at({ askCard: question }).note, 'Which branch do I push? (and 1 more question)');
  assert.equal(at({ askCard: plan }).note, 'It shows its plan and asks whether to go ahead.');
  assert.equal(at({ askCard: allow }).note, 'Allow Bash: npm run build');
  assert.equal(at({}).note, 'Claude needs your attention', 'no exact card: the note as before');
  assert.equal(at({ askCard: { kind: 'question', questions: [{ question: 'Use KEY=sk-ant-api03-abcdefghijklmnop?' }] } }).note, 'Use KEY=***?', 'masked as any note');
});

test('a plan card shows every step with where it is, a failed step with its note and a taken-back step, as text', () => {
  const plan = (state, steps, extra = {}) => texts(cardElement({ kind: 'plan', id: 'v_0000000000a1', at: Date.now(), subject: { type: 'plan', computer: 'this', id: 'p_0123456789' }, title: 'Put the shop live', steps, state, started: Date.now() - 90_000, step: { label: 'Open the jobs', href: '#/tia/jobs' }, ...extra })).join('');
  const running = plan('running', [{ label: 'Save the work', state: 'done' }, { label: 'Check the shop', state: 'running' }, { label: '<b>Go live</b>', state: 'waiting' }]);
  assert.match(running, /Running/);
  assert.match(running, /Save the work \(done\)/);
  assert.match(running, /Check the shop \(now\)/);
  assert.match(running, /<b>Go live<\/b> \(to come\)/, 'a step is text, never markup');
  const failed = plan('failed', [{ label: 'Save the work', state: 'undone' }, { label: 'Check the shop', state: 'failed', note: 'The check did not pass.' }], { note: 'Stopped at step 2; step 1 was taken back.', ended: Date.now() });
  assert.match(failed, /Stopped: a step failed/);
  assert.match(failed, /Save the work \(taken back\)/);
  assert.match(failed, /The check did not pass\./);
  assert.match(failed, /Stopped at step 2; step 1 was taken back\./);
});
