// Skills → Learned and its learn panel (web/skilllearned.js), and Work's "Learn from this" (web/workdo.js),
// in a small stand-in DOM with a stand-in for the dashboard's answers.
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
const L = await import('../../web/skilllearned.js');

const text = (n) => all(n).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ');
const find = (n, pred) => all(n).find((x) => x instanceof FakeElement && pred(x));
const button = (n, label) => find(n, (x) => x.tag === 'button' && text(x).trim() === label);
const tick = () => new Promise((r) => realTimeout(r, 10));
const kit = { diffView: () => h('div', 'the diff'), tag: (level, words) => h('span', words || level) };

const draft = (id, x = {}) => ({
  id: id.padEnd(24, '0'), createdAt: '2026-11-18T10:00:00.000Z', state: 'ready', kind: 'new', name: `skill-${id}`, description: 'Run the tests.', why: 'He sent it back.',
  source: { run: '20261118-090000-1a2b3c4d', title: 'Fix the form', trigger: 'sent-back', words: 'run the tests' }, skillMd: '---\nname: x\n---\n\n# X\n\n1. Run the tests.\n',
  diff: {}, findings: [], counts: { block: 0, high: 0, medium: 0, low: 0 }, risky: false, riskyWhy: [], tests: [{ prompt: 'Fix it', without: 'a', with: 'b' }],
  cost: { usd: 0.0047, tokens: 4300 }, installed: null, undone: null, ...x,
});
const sheetButton = (label) => button(body, label);

test('the Undo on the line after Install opens its sheet and undoes', async () => {
  const d = draft('a1');
  let state = [d];
  answers['/api/skills/learned'] = () => ({ on: true, looking: false, drafts: state, recent: [] });
  answers['/api/workspace/link'] = { brain: true, entries: [] };
  answers[`/api/skills/learned/${d.id}/install`] = () => {
    state = [{ ...d, state: 'installed', installed: { commit: 'c'.repeat(40), at: '2026-11-18T11:00:00.000Z' } }];
    return { name: d.name, commit: 'c'.repeat(40) };
  };
  answers[`/api/skills/learned/${d.id}/undo`] = { name: d.name, commit: 'd'.repeat(40) };
  const box = new FakeElement('div');
  L.paintLearned(box, kit);
  await tick();
  button(box, 'Install').fire('click');
  await tick();
  const line = find(box, (x) => x.getAttribute('role') === 'status' && /is installed/.test(text(x)));
  assert.ok(line, text(box));
  button(line, 'Undo').fire('click');
  await tick();
  sheetButton('Undo').fire('click');
  await tick();
  assert.ok(calls.some(([m, p]) => m === 'POST' && p.endsWith('/undo')), 'Undo was not sent');
});

test('a risky draft says what the scan found as a list of reasons, not a broken sentence', async () => {
  answers['/api/skills/learned'] = { on: true, looking: false, drafts: [draft('b1', { risky: true, riskyWhy: ['a long encoded blob (base64 or similar)', 'pushes, or forces a change'] })], recent: [] };
  const box = new FakeElement('div');
  L.paintLearned(box, kit);
  await tick();
  assert.match(text(box), /The scan found: a long encoded blob \(base64 or similar\); pushes, or forces a change\./);
  assert.doesNotMatch(text(box), /found that it/);
});

test('a stopped Learned part paints nothing more and refreshes no more', async () => {
  answers['/api/skills/learned'] = { on: true, looking: false, drafts: [draft('c1', { state: 'trying' })], recent: [] };
  timers.length = 0;
  const box = new FakeElement('div');
  const part = L.paintLearned(box, kit);
  await tick();
  assert.equal(timers.length, 1, 'no refresh while a draft is tried');
  part.stop();
  box.replaceChildren(h('p', 'the Installed tab'));
  const n = calls.length;
  timers.shift()();
  await tick();
  assert.equal(text(box).trim(), 'the Installed tab');
  assert.equal(calls.length, n, 'it asked the dashboard again');
});

test('a refresh keeps the folds he closed and his focus, and paints nothing when nothing changed', async () => {
  let tries = [{ prompt: 'Fix it', without: null, with: null }];
  const d = draft('e1', { state: 'trying' });
  const other = draft('e2');
  answers['/api/skills/learned'] = () => ({ on: true, looking: false, drafts: [{ ...d, tests: tries }, other], recent: [] });
  timers.length = 0;
  const box = new FakeElement('div');
  L.paintLearned(box, kit);
  await tick();
  const foldOf = () => {
    const card = find(box, (a) => a.tag === 'article' && text(a).includes('skill-e2'));
    return find(card, (x) => x.tag === 'details' && /The new skill/.test(text(x)));
  };
  const f = foldOf();
  f.open = false;
  f.fire('toggle');
  const discard = box.querySelector(`[data-key="${other.id}:discard"]`);
  discard.focus();
  // The same answer: nothing is painted again.
  const first = box.children[1].children[0]; // box.children[0] is the learn panel, drawn once
  timers.shift()();
  await tick();
  assert.equal(box.children[1].children[0], first, 'it painted the same answer again');
  // A changed answer: painted, with the fold still closed and the focus on the same button.
  tries = [{ prompt: 'Fix it', without: 'a', with: null }];
  timers.shift()();
  await tick();
  assert.notEqual(box.children[1].children[0], first);
  assert.equal(foldOf().open, false, 'the fold he closed opened again');
  assert.equal(document.activeElement && document.activeElement.getAttribute('data-key'), `${other.id}:discard`, 'the focus was lost');
});

test('a look on a subscription says tokens and the plan\'s usage limit; dollars only for a provider billed by use', async () => {
  answers['/api/skills/learned'] = { on: true, looking: false, drafts: [draft('f1', { cost: { usd: 0.0047, tokens: 4300, billed: false } }), draft('f2', { cost: { usd: 0.0047, tokens: 4300, billed: true } })], recent: [] };
  const box = new FakeElement('div');
  L.paintLearned(box, kit);
  await tick();
  const cards = all(box).filter((x) => x.tag === 'article');
  assert.match(text(cards[0]), /This look used 4,300 tokens, which count toward your plan's usage limit\./);
  assert.doesNotMatch(text(cards[0]), /\$/);
  assert.match(text(cards[1]), /This look cost about \$0\.0047/);
});

test('the last look says a discarded idea, a name there already, and a look a restart stopped, in their own words', async () => {
  for (const [result, words] of [['refused: declined', 'an idea you discarded before'], ['refused: exists', 'a skill of that name is there already'], ['looking', 'stopped before it finished']]) {
    answers['/api/skills/learned'] = { on: true, looking: false, drafts: [], recent: [{ at: Date.parse('2026-11-18T10:00:00Z'), trigger: 'sent-back', result }] };
    const box = new FakeElement('div');
    L.paintLearned(box, kit);
    await tick();
    assert.ok(text(box).includes(`): ${words}`), `${result}: ${text(box)}`);
  }
});

test('Skills → Learned has the learn panel at its top: the last look is said apart from its cost, and the old Settings page is gone', async () => {
  const { registeredSettingsPages } = await import('../../web/registry.js');
  assert.equal(registeredSettingsPages().find((p) => p.id === 'learn'), undefined, 'no Settings page of its own');
  const base = { settings: { on: true, provider: 'sub', model: 'haiku', perWeek: 5, last: null }, providers: [{ name: 'sub', label: 'Main' }], models: ['haiku'], looksThisWeek: 3, draftsThisWeek: 0, draftsPerWeek: 3 };
  answers['/api/skills/learned'] = { on: true, looking: false, drafts: [draft('p1')], recent: [] };
  for (const [lastLook, want] of [[{ at: Date.parse('2026-11-18T10:00:00Z'), result: 'failed' }, /The last look \(.+\) did not reach the model\./], [null, /No look has been made yet/]]) {
    answers['/api/skills/learn'] = { ...base, lastLook };
    const box = new FakeElement('div');
    const part = L.paintLearned(box, kit);
    await tick();
    assert.match(text(box), want);
    assert.ok(text(box).indexOf('Skills from your own work') < text(box).indexOf('Waiting for you'), 'the panel is above the drafts');
    assert.doesNotMatch(text(box), /Turn it on in Settings/);
    part.stop();
  }
});

test('Learn from this says its answer in the run card, with a label that fits it, and the focus on that line', async () => {
  const W = await import('../../web/workdo.js');
  const r = { id: '20261118-090000-1a2b3c4d', item: 'fix', title: 'Fix', startedAt: '2026-11-18T09:00:00.000Z', endedAt: '2026-11-18T09:05:00.000Z', project: 'shop', folder: '.',
    tool: 'claude', provider: 'sub', providerLabel: 'Main', model: null, session: null, state: 'done', reason: null, answer: 'Done.', commits: [], changed: [], more: 0, statusError: null, here: true };
  for (const [answer, label, words] of [[{ skipped: 'drafts', why: '3 drafts were made this week' }, 'Not looked at', /Not looked at: 3 drafts were made this week\./], [{ started: true }, 'Looked at', /Looking at it\..*Skills → Learned/]]) {
    answers['/api/skills/learned/look'] = answer;
    const card = W.runCard(r, { onLearn: (e, said) => W.learnFrom(r, e.currentTarget, said) });
    const b = button(card, 'Learn from this');
    b.fire('click');
    await tick();
    assert.equal(text(b.lastChild).trim(), label);
    const said = find(card, (x) => x.getAttribute('role') === 'status');
    assert.match(text(said), words);
    assert.equal(document.activeElement, said, 'the focus is not on the answer');
  }
});

test('while the brain\'s skills are not linked, Install and the Undo sheet say the coding tools do not use it yet', async () => {
  const d = draft('g1');
  let state = [d];
  answers['/api/skills/learned'] = () => ({ on: true, looking: false, drafts: state, recent: [] });
  answers['/api/workspace/link'] = { brain: true, entries: [{ id: 'skills', action: 'link', what: 'skills' }] };
  answers[`/api/skills/learned/${d.id}/install`] = () => {
    state = [{ ...d, state: 'installed', installed: { commit: 'c'.repeat(40), at: '2026-11-18T11:00:00.000Z' } }];
    return { name: d.name, commit: 'c'.repeat(40) };
  };
  const box = new FakeElement('div');
  L.paintLearned(box, kit);
  await tick();
  button(box, 'Install').fire('click');
  await tick();
  assert.match(text(box), /is saved in your AI brain \(commit c{7}\)\. Your coding tools use it once you press Switch on, above/);
  assert.doesNotMatch(text(box), /is installed and saved/);
  const line = find(box, (x) => x.getAttribute('role') === 'status' && /saved in your AI brain/.test(text(x)));
  button(line, 'Undo').fire('click');
  await tick();
  assert.match(text(body), /do not use it yet: the skills of your AI brain are not linked/);
  sheetButton('Cancel').fire('click');
  await tick();
  answers['/api/workspace/link'] = { brain: true, entries: [] };
});

test('each button names its skill; a risky one stays in the Tab walk; with many drafts only the newest card is open', async () => {
  const many = ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => draft(id));
  many[2] = { ...many[2], risky: true, riskyWhy: ['pushes, or forces a change'] };
  answers['/api/skills/learned'] = { on: true, looking: false, drafts: many, recent: [] };
  let counted = null;
  const box = new FakeElement('div');
  L.paintLearned(box, { ...kit, onCount: (n) => (counted = n) });
  await tick();
  assert.equal(counted, 5);
  assert.ok(find(box, (x) => x.getAttribute('aria-label') === 'Install skill-h1'), 'Install has no name');
  assert.ok(find(box, (x) => x.getAttribute('aria-label') === 'Discard skill-h4'), 'Discard has no name');
  const blocked = find(box, (x) => x.getAttribute('aria-label') === 'skill-h3 cannot be installed');
  assert.ok(blocked && blocked.getAttribute('aria-disabled') === 'true' && !blocked.disabled, 'the risky button left the Tab walk');
  const cards = all(box).filter((x) => x.tag === 'article');
  const opened = cards.map((c) => all(c).filter((x) => x.tag === 'details' && x.open).length);
  assert.ok(opened[0] > 0, 'the newest card is closed');
  assert.deepEqual(opened.slice(1), [0, 0, 0, 0], 'older cards are open');
});
