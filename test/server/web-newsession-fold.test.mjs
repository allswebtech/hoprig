// New session: the project is the question. The computer, App or Terminal and the coding tool are folded under
// one line that says what a start uses, over the project list; they open on a press, or when nothing can start.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    const cls = new Set();
    Object.assign(this, { tag, dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, open: false });
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) };
    Object.defineProperty(this, 'className', { get: () => [...cls].join(' '), set: (v) => { cls.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) cls.add(c); } });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(k, fn) {
    (this.listeners[k] ||= []).push(fn);
  }
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
  // Enough of CSS for the page's own lookups: tag, .class, [attr], [attr="value"], joined, and lists with commas.
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
  get textContent() {
    return all(this).map((x) => x.text || '').join('');
  }
  set textContent(t) {
    this.children = [{ text: t }];
  }
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
// The page's poller keeps a timer: it must not keep this test's process alive.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => {
  const t = realTimeout(fn, ms, ...a);
  t.unref?.();
  return t;
};

// The computer: Claude Code ready, OpenCode as each test says; the project's earlier conversations.
const answers = {};
const calls = []; // [method, path, body] of every request
globalThis.fetch = async (u, o = {}) => {
  calls.push([o.method || 'GET', u.split('?')[0], o.body ? JSON.parse(o.body) : null]);
  const pathOnly = u.split('?')[0];
  const q = new URLSearchParams(u.split('?')[1] || '');
  let data = answers[pathOnly];
  if (typeof data === 'function') data = data(q);
  if (data && data.__status) return { ok: false, status: data.__status, json: async () => ({ error: 'no answer' }) };
  return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data || {} };
};
const tools = (opencode) => ({ tools: [
  { id: 'claude', name: 'Claude Code', on: true, managed: false, installed: null, providers: ['max'] },
  { id: 'opencode', name: 'OpenCode', on: true, managed: true, installed: '2.3.0', providers: ['key'], ...opencode },
] });
Object.assign(answers, {
  '/api/machines/sessions': { machines: [{ machine: null, label: 'This computer', status: 'online', recommended: 'max', profiles: [{ name: 'max', label: 'Claude Max', kind: 'login', tools: ['claude'] }, { name: 'key', label: 'Key', kind: 'api', tools: ['claude', 'opencode'] }], sessions: [{ name: 'api', kind: 'claude', cwd: '/w/api' }] },
    // A second computer whose OpenCode has no App engine yet, and a third that cannot be reached.
    { machine: 'box2', label: 'Box 2', status: 'online', recommended: 'k2', profiles: [{ name: 'k2', label: 'K2', kind: 'api', tools: ['claude', 'opencode'] }], sessions: [] },
    { machine: 'box3', label: 'Box 3', status: 'offline', profiles: [], sessions: [] }] },
  '/m/box2/api/codetools': tools({}),
  '/m/box2/api/chats/tools': { tools: [{ id: 'claude', name: 'Claude Code' }] },
  '/m/box2/api/folders/recent': { folders: [{ path: '/b/site', name: 'site', short: '~/site' }], roots: [] },
  '/m/box2/api/folders/sessions': { sessions: [] },
  '/m/box2/api/sessions': { name: 'site' },
  '/m/box3/api/codetools': { __status: 502 },
  '/api/machines': { self: { claude: '2.1.0' }, machines: [] },
  '/api/chats/tools': { tools: [{ id: 'claude', name: 'Claude Code' }, { id: 'opencode', name: 'OpenCode', modes: ['manual', 'acceptEdits'] }] },
  '/api/codetools': tools({}),
  '/api/folders/recent': { folders: [{ path: '/w/shop', name: 'shop', short: '~/shop' }, { path: '/w/api', name: 'api', short: '~/api', live: true, session: 'api' }], roots: [{ path: '/w', short: '~' }] },
  '/api/chats': { id: 'new-chat' },
  '/api/sessions': { name: 'term-1' },
  '/api/folders/browse': { path: '/w/other', short: '~/other', parent: null, dirs: [] },
  '/api/settings': {},
  // OpenCode's conversation in /w/shop is newer than Claude Code's: the project used OpenCode last.
  '/api/folders/sessions': (q) => ({ sessions: q.get('tool') === 'opencode' ? [{ id: 'o1', at: 2000, title: 'x' }] : [{ id: 'c1', at: 1000, title: 'y' }] }),
});

const C = await import('../../web/newsession-choice.js');
const P = await import('../../web/newsession-popup.js');

function all(n, out = []) {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
}
const text = (n) => all(n).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ');
const find = (n, pred) => all(n).find((x) => x instanceof FakeElement && pred(x));
const findAll = (n, pred) => all(n).filter((x) => x instanceof FakeElement && pred(x));
const tile = (n, id) => find(n, (x) => x.attrs['data-choice'] === id);
// Off: the property where the page set it, else the attribute the element was made with (the stand-in has no

const settle = () => new Promise((r) => realTimeout(r, 30));

test('the choices read as one line: on which computer, how, with which tool', () => {
  assert.equal(C.choiceLine({ openAs: 'app', tool: 'Claude Code' }), 'In the App · with Claude Code');
  assert.equal(C.choiceLine({ computer: 'Workstation', openAs: 'app', tool: 'Claude Code' }), 'On Workstation · in the App · with Claude Code');
  assert.equal(C.choiceLine({ openAs: 'terminal', tool: 'OpenCode' }), 'In a terminal · with OpenCode');
  assert.equal(C.choiceLine({ openAs: 'app', known: false }), 'In the App · looking at the coding tools…');
  assert.equal(C.choiceLine({ openAs: 'app', tool: null }), 'In the App · no coding tool is ready');
  assert.equal(C.choiceLine({ plain: true, tool: 'Claude Code' }), 'A plain terminal, without a coding tool');
  assert.equal(C.choiceLine({ computer: 'Box 3', unreachable: true }), 'On Box 3 · cannot be reached now');
});

test('the project list comes first: the choices are folded under one line over it', async () => {
  localStorage.removeItem('pref:new.openAs');
  localStorage.removeItem('pref:new.tool');
  location.hash = '#/';
  const done = P.openNewSession({ m: null });
  await settle();
  const sheet = body.children.find((x) => x.tag === 'dialog');
  const fold = find(sheet, (x) => x.tag === 'details' && x.classList.contains('ns-choices'));
  assert.ok(fold, 'one fold for the choices');
  assert.equal(fold.open, false, 'closed: the projects are the first thing to answer');
  const line = find(fold, (x) => x.tag === 'summary');
  assert.equal(text(line).trim(), 'On This computer · in the App · with Claude Code Change', 'it says what a start uses (three computers are linked)');
  assert.equal(document.activeElement, line, 'the focus starts on it');
  for (const id of ['app', 'terminal', 'claude', 'opencode']) assert.ok(tile(fold, id), `${id} is inside the fold`);
  const order = all(sheet).filter((x) => x instanceof FakeElement);
  assert.ok(order.indexOf(fold) < order.findIndex((x) => x.attrs['data-name'] === 'shop'), 'the line is over the list');
  // A change inside is said in the line at once.
  tile(sheet, 'terminal').fire('click');
  assert.equal(text(line).trim(), 'On This computer · in a terminal · with Claude Code Change');
  sheet.close();
  await done;
  localStorage.removeItem('pref:new.openAs');
});

test('several computers: the line names the chosen one', async () => {
  const done = P.openNewSession({ m: 'box2' });
  await settle();
  const sheet = body.children.find((x) => x.tag === 'dialog');
  const line = find(sheet, (x) => x.tag === 'summary' && x.classList.contains('ns-choices-line'));
  assert.match(text(line), /^\s*On Box 2 · in the App · with Claude Code/);
  sheet.close();
  await done;
});

test('nothing can start as chosen: the choices open, so what is missing is in view', async () => {
  const done = P.openNewSession({ m: 'box3' });
  await settle();
  const sheet = body.children.find((x) => x.tag === 'dialog');
  const fold = find(sheet, (x) => x.tag === 'details' && x.classList.contains('ns-choices'));
  assert.equal(fold.open, true);
  assert.match(text(fold), /Box 3 cannot be reached now/);
  sheet.close();
  await done;
});
