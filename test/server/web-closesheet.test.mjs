// "End them…" beside Home's fold (web/closesheet.js): the sheet lists each session, all ticked, ONE button with the
// number; the press reads the sessions again and ends each ticked one still as it was through the kill route a
// single session uses, on its own computer. One that changed is left and named; a press twice ends each once.
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
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, disabled: false });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  set textContent(t) { this.children = [new FakeText(t)]; }
  get textContent() { return texts(this).join(''); }
}
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const all = (e) => e.children.filter((c) => c instanceof FakeElement).flatMap((c) => [c, ...all(c)]);
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const closesheet = await import('../../web/closesheet.js');
const { END_TEXT, endLabel, closeSheetBody, closeWaited, closable, resultLines } = closesheet;
const NOW = 1_800_000_000_000;
const H = 3600_000;
const s = (name, machine, age, extra = {}) => ({ name, display: `${name} title`, kind: 'claude', status: 'waiting', statusAt: NOW - age, machine, machineLabel: machine || 'This computer', ...extra });

// A stand-in api: GET /api/machines/sessions answers `machines`, every kill is recorded with the path it went to.
function standIn(machines) {
  const calls = [];
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '~/api/machines/sessions') return { machines: typeof machines === 'function' ? machines() : machines };
    if (/\/api\/sessions\/[^/]+\/kill$/.test(path)) return { ok: true };
    throw new Error(`unexpected call ${path}`);
  };
  return { calls, kills: () => calls.filter((c) => c.path.endsWith('/kill')).map((c) => c.path) };
}
const asMachines = (list) => {
  const byM = new Map();
  for (const x of list) {
    const k = x.machine ?? null;
    if (!byM.has(k)) byM.set(k, { machine: k, status: 'online', sessions: [] });
    byM.get(k).sessions.push(x);
  }
  return [...byM.values()];
};
// closeWaited's own default read and kill go through lib.js api(); the tests give the stand-in's.
const { at } = await import('../../web/lib.js');
const wire = (st, machines) => ({
  read: () => st.api('~/api/machines/sessions'),
  kill: (x) => st.api(at(x.machine, `/api/sessions/${encodeURIComponent(x.name)}/kill`), {}),
});
function setup(list) {
  const st = standIn(asMachines(list));
  const calls = st.calls;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '~/api/machines/sessions') return { machines: asMachines(st.now || list) };
    return { ok: true };
  };
  st.api = api;
  return st;
}

test('the sheet names each session with its computer and how long it waited, all ticked, one button with the number', () => {
  const list = [s('shop', null, 7 * H), s('alpha', 'box2', 30 * H), s('docs', null, 50 * H)];
  const body = closeSheetBody(list, { now: NOW });
  const words = texts(body.el).join(' | ');
  assert.match(words, /shop title \| This computer · waited 7 h/);
  assert.match(words, /alpha title \| box2 · waited 1 day/);
  assert.match(words, /docs title \| This computer · waited 2 days/);
  const boxes = all(body.el).filter((e) => e.tag === 'input');
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every((b) => b.attrs.checked === '' && b.attrs.type === 'checkbox'), 'every one ticked');
  const buttons = all(body.el).filter((e) => e.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Cancel', 'End 3 sessions'], 'ONE button that ends, with the number');
  assert.deepEqual(boxes.map((b) => b.attrs['aria-label']), ['End shop title', 'End alpha title', 'End docs title'], 'a tick says the same word');
  assert.equal(END_TEXT, 'This ends each session: everything running in it stops. Its conversation is kept, and you can continue it from the project\'s page.');
  assert.match(words, new RegExp(END_TEXT.replace(/[.()']/g, '.')));
  body.tick(list[1], false);
  assert.equal(buttons[1].textContent, 'End 2 sessions', 'the number follows the ticks');
  assert.equal(endLabel(1), 'End 1 session');
  assert.doesNotMatch(words, /\bClos/, 'one word for one act: no Close in the sheet');
});

test('what is ended equals the ticked list, each on its own computer through the kill route', async () => {
  const list = [s('shop', null, 7 * H), s('alpha', 'box2', 30 * H), s('docs', null, 50 * H)];
  const st = setup(list);
  const body = closeSheetBody(list, { ...wire(st), now: NOW });
  body.tick(list[2], false);
  const result = await body.press();
  assert.deepEqual(st.kills(), ['~/api/sessions/shop/kill', '/m/box2/api/sessions/alpha/kill'], 'this computer and box2, docs left unticked');
  assert.deepEqual(result.ended.map((x) => x.name), ['shop', 'alpha']);
  assert.deepEqual([result.left, result.failed], [[], []]);
  assert.deepEqual(st.calls.filter((c) => c.path.endsWith('/kill')).map((c) => c.body), [{}, {}], 'the same empty body End session sends');
  assert.deepEqual(resultLines(result), ['Ended 2 sessions.']);
});

test('a session that changed between the sheet and the press is left open and named', async () => {
  const list = [s('shop', null, 7 * H), s('alpha', 'box2', 30 * H), s('docs', null, 50 * H), s('news', null, 9 * H), s('blog', null, 8 * H), s('gone', null, 10 * H)];
  const st = setup(list);
  st.now = [
    { ...list[0] },
    { ...list[1], status: 'working', statusAt: NOW }, // works again
    { ...list[2], statusAt: NOW - H }, // a new turn ended an hour ago: its state time changed
    { ...list[3], bgCommands: 1 }, // a command of its own runs in the background
    { ...list[4], askCard: { kind: 'notice' } }, // a card asks him now
    // gone: ended already
  ];
  const result = await closeWaited(list, wire(st));
  assert.deepEqual(st.kills(), ['~/api/sessions/shop/kill'], 'only the one still as it was');
  assert.deepEqual(result.left.map(({ s: x, why }) => [x.name, why]), [
    ['alpha', 'it started working again'],
    ['docs', 'it changed since the list was shown'],
    ['news', 'a command of it still runs in the background'],
    ['blog', 'it has a question for you'],
    ['gone', 'it has ended already'],
  ]);
  const lines = resultLines(result);
  assert.equal(lines[0], 'Ended 1 session.');
  assert.match(lines[1], /^Left open: alpha title \(it started working again\), docs title/);
});

test('a computer that does not answer at the press: its sessions are left, nothing sent there', async () => {
  const list = [s('shop', null, 7 * H), s('alpha', 'box2', 30 * H)];
  const st = setup(list);
  st.now = [list[0], { ...list[1] }];
  const machines = asMachines(st.now);
  machines[1].status = 'offline';
  const result = await closeWaited(list, { read: async () => ({ machines }), kill: wire(st).kill });
  assert.deepEqual(st.kills(), ['~/api/sessions/shop/kill']);
  assert.deepEqual(result.left.map(({ s: x, why }) => [x.name, why]), [['alpha', 'its computer does not answer']]);
});

test('a press twice sends each kill once', async () => {
  const list = [s('shop', null, 7 * H), s('alpha', 'box2', 30 * H)];
  const st = setup(list);
  let done = 0;
  const body = closeSheetBody(list, { ...wire(st), now: NOW, done: () => done++ });
  const [a, b] = [body.press(), body.press()];
  assert.equal(a, b, 'the second press gives back the run under way');
  await a;
  await body.press();
  assert.deepEqual(st.kills(), ['~/api/sessions/shop/kill', '/m/box2/api/sessions/alpha/kill'], 'one end each');
  assert.equal(st.calls.filter((c) => c.path === '~/api/machines/sessions').length, 2, 'read again once before each end');
  assert.equal(done, 1);
  const go = all(body.el).find((e) => e.tag === 'button' && /^End/.test(e.textContent));
  assert.equal(go.disabled, true, 'the button is off once pressed');
});

test('a kill that fails is said, the rest still end; the read that fails ends nothing', async () => {
  const list = [s('shop', null, 7 * H), s('alpha', null, 30 * H)];
  const calls = [];
  const res = await closeWaited(list, {
    read: async () => ({ machines: asMachines(list) }),
    kill: async (x) => { calls.push(x.name); if (x.name === 'shop') throw new Error('No such session'); },
  });
  assert.deepEqual(calls, ['shop', 'alpha']);
  assert.deepEqual(res.ended.map((x) => x.name), ['alpha']);
  assert.match(resultLines(res).join(' '), /Not ended: shop title \(No such session\)/);
  const none = await closeWaited(list, { read: async () => { throw new Error('Cannot reach the computer.'); }, kill: async () => assert.fail('no kill') });
  assert.deepEqual([none.ended, none.failed.length], [[], 2]);
});

test('the App\'s chats are not in the sheet; Home opens it from the fold, and no route is added', () => {
  assert.equal(closable({ name: 'chat-1', kind: 'chat' }), false);
  assert.equal(closable({ name: 'shop', kind: 'claude' }), true);
  const home = fs.readFileSync(new URL('../../web/home.js', import.meta.url), 'utf8');
  assert.match(home, /openCloseSheet\(old, \{ after: \(\) => store\.refresh\(\) \}\)/);
  assert.match(home, /'End them…'/);
  assert.doesNotMatch(home, /'Close them/);
  const src = fs.readFileSync(new URL('../../web/closesheet.js', import.meta.url), 'utf8');
  assert.match(src, /api\(at\(s\.machine, `\/api\/sessions\/\$\{encodeURIComponent\(s\.name\)\}\/kill`\), \{\}\)/, 'the route End session uses');
  assert.doesNotMatch(src, /setTimeout|setInterval/, 'nothing ends by a timer');
});

test('the result is said once: in the sheet while it is open, a toast only when he closed it before the press ended', () => {
  assert.equal(typeof closesheet.sayResult, 'function', 'the result is said as a toast and in the sheet at once');
  const result = { ended: [s('shop', null, 7 * H)], left: [], failed: [] };
  const toasts = [];
  const drawn = [];
  closesheet.sayResult(result, { open: () => true, show: (l) => drawn.push(l), say: (t) => toasts.push(t) });
  assert.deepEqual([drawn, toasts], [[['Ended 1 session.']], []], 'sheet open: only in the sheet');
  closesheet.sayResult(result, { open: () => false, show: (l) => drawn.push(l), say: (t) => toasts.push(t) });
  assert.deepEqual([drawn.length, toasts], [1, ['Ended 1 session.']], 'sheet closed: only the toast');
  const src = fs.readFileSync(new URL('../../web/closesheet.js', import.meta.url), 'utf8');
  assert.match(src, /sayResult\(result, \{ open: \(\) => open, show:/, 'the sheet uses it');
  assert.doesNotMatch(src.slice(src.indexOf('export function openCloseSheet')), /\btoast\(/, 'no second toast in the sheet');
});

test('after the press the sheet no longer asks its question: its title says what it shows', () => {
  assert.equal(closesheet.AFTER_TITLE, 'Sessions that had waited');
  const src = fs.readFileSync(new URL('../../web/closesheet.js', import.meta.url), 'utf8');
  const shown = src.slice(src.indexOf('show: (lines) => {'));
  assert.match(shown.slice(0, shown.indexOf('fill(body.el')), /title\.textContent = AFTER_TITLE/, 'set before the result is drawn');
  // The subtitle under it follows the title's state: no "They have waited" under a past title.
  assert.equal(closesheet.AFTER_SUBTITLE, 'They had waited for more than 6 hours.');
  assert.match(shown.slice(0, shown.indexOf('fill(body.el')), /sub\.textContent = AFTER_SUBTITLE/, 'the subtitle is set with the title');
});
