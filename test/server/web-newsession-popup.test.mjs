// New session as a popup (web/newsession-popup.js, web/newsession-choice.js), in a small stand-in DOM: App or Terminal
// first (this browser's last choice, the App the first time), then one tile per coding tool with its state (one that
// is not ready says what is missing, links there and cannot be chosen), the default tool (the one chosen here, else
// the project's last one, else the first ready one), and a popup opened from a project: the project set, no computer
// row, "Change" and "Start".
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
// property of its own for it).
const off = (el) => el.disabled === true || (el.disabled === undefined && 'disabled' in el.attrs);
const settle = () => new Promise((r) => realTimeout(r, 30));

test('App or Terminal: this browser\'s last choice, the App the very first time', () => {
  assert.equal(C.openAsDefault(undefined), 'app');
  assert.equal(C.openAsDefault('terminal'), 'terminal');
  assert.equal(C.openAsDefault('chat'), 'app', 'an unknown value: the App');
  const picked = [];
  const row = C.openAsTiles({ chosen: 'terminal', choose: (id) => picked.push(id) });
  assert.equal(row.attrs.role, 'radiogroup');
  const radios = findAll(row, (x) => x.attrs.role === 'radio');
  assert.deepEqual(radios.map((r) => [r.attrs['data-choice'], r.attrs['aria-checked']]), [['app', 'false'], ['terminal', 'true']]);
  assert.match(text(radios[0]), /App A chat, like the Claude Code app/);
  assert.match(text(radios[1]), /Terminal The coding tool in a terminal/);
  radios[0].fire('click');
  assert.deepEqual(picked, ['app']);
});

test('a coding tool that is not ready says what is missing, links there, and is no choice', () => {
  assert.deepEqual(C.toolState({ managed: true, installed: null, on: true, providers: ['k'] }), { ready: false, why: 'Not installed', fix: 'install it in Settings', href: '#/settings/codingtools' });
  assert.deepEqual(C.toolState({ managed: true, installed: '1', on: false, providers: ['k'] }, 'laptop'), { ready: false, why: 'Turned off', fix: 'turn it on in Settings', href: '#/m/laptop/settings/codingtools' });
  assert.deepEqual(C.toolState({ on: true, providers: [] }), { ready: false, why: 'No provider serves it yet', fix: 'add one', href: '#/providers' });
  assert.deepEqual(C.toolState({ on: true, providers: ['k'] }), { ready: true });
  assert.deepEqual(C.toolState({ id: 'claude', name: 'Claude Code' }), { ready: true }, 'an older computer\'s list: what a chat runs is ready');
  const left = [];
  const row = C.toolTiles({
    tools: [{ id: 'claude', name: 'Claude Code', state: { ready: true } }, { id: 'opencode', name: 'OpenCode', state: C.toolState({ on: false }) }],
    chosen: 'claude', choose: () => assert.fail('not a choice'), onleave: () => left.push(1),
  });
  const off = tile(row, 'opencode');
  assert.equal(off.tag, 'div', 'no button');
  assert.equal(off.attrs.role, undefined, 'and no radio');
  assert.match(text(off), /OpenCode Turned off: turn it on in Settings/);
  const a = find(off, (x) => x.tag === 'a');
  assert.equal(a.attrs.href, '#/settings/codingtools');
  a.fire('click');
  assert.deepEqual(left, [1], 'following the link closes the popup');
  assert.equal(tile(row, 'claude').attrs['aria-checked'], 'true');
});

test('the default coding tool: the one chosen here, else the project\'s last one, else the first ready one', () => {
  const t = (id, ready = true) => ({ id, state: { ready } });
  const both = [t('claude'), t('opencode')];
  assert.equal(C.chooseTool(both), 'claude', 'the computer\'s default: the first ready one');
  assert.equal(C.chooseTool(both, { last: 'opencode' }), 'opencode', 'the project used it last');
  assert.equal(C.chooseTool(both, { picked: 'claude', last: 'opencode' }), 'claude', 'chosen here wins');
  assert.equal(C.chooseTool([t('claude', false), t('opencode')]), 'opencode', 'one ready tool: it is chosen');
  assert.equal(C.chooseTool([t('claude'), t('opencode', false)], { picked: 'opencode', last: 'opencode' }), 'claude', 'never one that is not ready');
  assert.equal(C.chooseTool([t('claude', false)]), null, 'none ready');
});

test('opened from a project: the project is set, no computer row, Change and Start; its last tool is chosen', async () => {
  localStorage.setItem('pref:new.openAs', JSON.stringify('terminal'));
  const done = P.openNewSession({ m: null, project: { path: '/w/shop', name: 'shop', short: '~/shop' } });
  await settle();
  const sheet = body.children.find((x) => x.tag === 'dialog');
  assert.equal(sheet.open, true);
  assert.equal(sheet.classList.contains('sheet-tall'), true, 'the whole height on a phone');
  const heads = findAll(sheet, (x) => x.className === 'group-head').map(text).map((s) => s.trim());
  assert.deepEqual(heads, ['Open as', 'Coding tool', 'Project'], 'no computer row while a project is set');
  assert.equal(tile(sheet, 'terminal').attrs['aria-checked'], 'true', 'the last choice of this browser');
  assert.equal(tile(sheet, 'opencode').attrs['aria-checked'], 'true', 'the tool its newest conversation ran in');
  const preset = find(sheet, (x) => x.classList.contains('ns-preset'));
  assert.match(text(preset), /shop ~\/shop Change/);
  assert.ok(find(sheet, (x) => x.attrs['data-start'] === '1'), 'a Start button');
  // Change: the list of projects instead, and no Start button.
  find(preset, (x) => x.tag === 'button').fire('click');
  await settle();
  assert.equal(find(sheet, (x) => x.attrs['data-start'] === '1'), undefined);
  assert.ok(find(sheet, (x) => x.attrs['data-name'] === 'shop'), 'the recent projects');
  sheet.close();
  assert.equal(await done, null);
});

test('a tool that is turned off is shown, not chosen; the App is the first choice of a new browser', async () => {
  localStorage.removeItem('pref:new.openAs');
  answers['/api/codetools'] = tools({ on: false });
  const done = P.openNewSession({ m: null });
  await settle();
  const sheet = body.children.find((x) => x.tag === 'dialog');
  assert.equal(tile(sheet, 'app').attrs['aria-checked'], 'true');
  assert.equal(tile(sheet, 'opencode').tag, 'div');
  assert.equal(tile(sheet, 'claude').attrs['aria-checked'], 'true');
  // Choosing Terminal is kept for the next time.
  tile(sheet, 'terminal').fire('click');
  assert.equal(localStorage.getItem('pref:new.openAs'), '"terminal"');
  sheet.close();
  await done;
  answers['/api/codetools'] = tools({});
});

// A project where a session runs: the row starts a NEW one with the choices above; the button beside it opens what runs.
async function openWithRunning() {
  localStorage.removeItem('pref:new.openAs');
  location.hash = '#/';
  const done = P.openNewSession({ m: null });
  await settle();
  const sheet = body.children.find((x) => x.tag === 'dialog');
  return { sheet, done };
}

test('a tap on a project where a session runs starts a new session with the choices above', async () => {
  const { sheet, done } = await openWithRunning();
  const rowBtn = find(sheet, (x) => x.tag === 'button' && x.attrs['data-name'] === 'api');
  assert.ok(rowBtn, 'the row is a button of its own');
  assert.equal(find(rowBtn, (x) => x.attrs['data-open']), undefined, 'the Open button is not inside it');
  calls.length = 0;
  rowBtn.fire('click');
  await settle();
  const post = calls.find(([m, p]) => m === 'POST' && p === '/api/chats');
  assert.ok(post, 'a new session in the App (the default choice)');
  assert.equal(post[2].dir, '/w/api');
  assert.equal(post[2].tool, 'claude');
  assert.equal(location.hash, '#/chat/new-chat');
  sheet.close();
  await done;
});

test('the "Open running session" button beside the row opens what runs there, and starts nothing', async () => {
  const { sheet, done } = await openWithRunning();
  const open = find(sheet, (x) => x.attrs['data-open'] === 'api');
  assert.ok(open, 'its own button');
  assert.equal(open.tag, 'button');
  assert.match(text(open), /Open running session/);
  assert.equal(open.attrs['aria-label'], 'Open the session running in api', 'a label for screen readers');
  assert.equal(find(sheet, (x) => x.attrs['data-open'] === 'shop'), undefined, 'none where nothing runs');
  calls.length = 0;
  open.fire('click');
  await settle();
  assert.equal(location.hash, '#/s/api', 'what a tap on the row did until now (runningIn)');
  assert.equal(calls.filter(([m]) => m === 'POST').length, 0, 'no session started');
  assert.equal(sheet.open, false, 'the popup closed');
  await done;
});

// ---------- one start at a time ----------
// The answer to a start comes late, as on a slow network: a second tap meanwhile must start nothing.
async function twice(open, control) {
  const { sheet, done } = await open();
  const ctl = control(sheet);
  assert.ok(ctl, 'the control is there');
  let release;
  const late = new Promise((r) => (release = r));
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if ((o && o.method) === 'POST') await late;
    return real(u, o);
  };
  try {
    calls.length = 0;
    ctl.fire('click');
    await settle();
    assert.equal(ctl.disabled, true, 'the pressed control is off while the start is on its way');
    assert.ok(sheet.querySelectorAll('[data-startctl]').every((c) => c.disabled), 'every start control is off');
    assert.match(text(sheet.querySelector('.ns-status')), /Starting|Opening/, 'and the popup says what is happening');
    ctl.fire('click');
    await settle();
    release();
    await settle();
    return calls.filter(([m, p]) => m === 'POST' && /\/api\/(chats|sessions|shells)$/.test(p)).length;
  } finally {
    globalThis.fetch = real;
    if (sheet.open) sheet.close();
    await done;
  }
}

test('one start at a time: two taps on a project\'s row send one request', async () => {
  assert.equal(await twice(openWithRunning, (s) => s.querySelector('button.row[data-name="shop"]')), 1);
});

test('one start at a time: two taps on Start (a project set) send one request', async () => {
  const open = async () => {
    const done = P.openNewSession({ m: null, project: { path: '/w/shop', name: 'shop', short: '~/shop' } });
    await settle();
    return { sheet: body.children.find((x) => x.tag === 'dialog'), done };
  };
  assert.equal(await twice(open, (s) => s.querySelector('[data-start]')), 1);
});

test('one start at a time: two taps on Start here send one request', async () => {
  const open = async () => {
    const r = await openWithRunning();
    r.sheet.querySelector('.ns-elsewhere').querySelector('button').fire('click');
    await settle();
    return r;
  };
  assert.equal(await twice(open, (s) => s.querySelector('[data-starthere]')), 1);
});

test('a failed start gives the controls back, with the error', async () => {
  const { sheet, done } = await openWithRunning();
  const saved = answers['/api/chats'];
  delete answers['/api/chats']; // 404: the start fails
  try {
    const rowBtn = sheet.querySelector('button.row[data-name="shop"]');
    rowBtn.fire('click');
    await settle();
    assert.equal(rowBtn.disabled, false, 'the row can be pressed again');
    assert.ok(sheet.querySelectorAll('[data-startctl]').every((c) => !c.disabled));
    assert.match(text(sheet.querySelector('.ns-status')), /Request failed \(404\)/);
  } finally {
    answers['/api/chats'] = saved;
    sheet.close();
    await done;
  }
});

// ---------- the coding tool a start sends is the one the tile shows ----------
test('from Home a row sends the tool this browser chose last time, not the first ready one', async () => {
  localStorage.setItem('pref:new.tool', JSON.stringify('opencode'));
  try {
    const { sheet, done } = await openWithRunning();
    assert.equal(tile(sheet, 'opencode').attrs['aria-checked'], 'true', 'the tile shows it');
    calls.length = 0;
    sheet.querySelector('button.row[data-name="shop"]').fire('click');
    await settle();
    const post = calls.find(([m, p]) => m === 'POST' && p === '/api/chats');
    assert.equal(post[2].tool, 'opencode', 'and the start sends it');
    if (sheet.open) sheet.close();
    await done;
  } finally {
    localStorage.removeItem('pref:new.tool');
  }
});

test('choosing a tool is kept for the next popup', async () => {
  const { sheet, done } = await openWithRunning();
  tile(sheet, 'opencode').fire('click');
  assert.equal(localStorage.getItem('pref:new.tool'), '"opencode"');
  sheet.close();
  await done;
  localStorage.removeItem('pref:new.tool');
});

test('opened from a project: Start waits until the project\'s last tool is known; Change goes back to the browser\'s choice', async () => {
  localStorage.setItem('pref:new.tool', JSON.stringify('claude'));
  try {
    const done = P.openNewSession({ m: null, project: { path: '/w/shop', name: 'shop', short: '~/shop' } });
    const sheet = body.children.find((x) => x.tag === 'dialog');
    // At once, before any answer: no tile to change under a tap, and Start off.
    assert.equal(off(sheet.querySelector('[data-start]')), true, 'Start waits');
    assert.equal(tile(sheet, 'claude'), undefined, 'no tool shown yet');
    assert.match(text(sheet), /Looking at/);
    await settle();
    assert.equal(off(sheet.querySelector('[data-start]')), false, 'Start once the tool is known');
    assert.equal(tile(sheet, 'opencode').attrs['aria-checked'], 'true', 'the project\'s last tool wins over the browser\'s choice');
    sheet.querySelector('.ns-preset').querySelector('button').fire('click'); // Change
    await settle();
    assert.equal(tile(sheet, 'claude').attrs['aria-checked'], 'true', 'after Change: the browser\'s last choice');
    sheet.close();
    await done;
  } finally {
    localStorage.removeItem('pref:new.tool');
  }
});

// ---------- a tile is ready only for a way a start with exactly that tool can be sent ----------
const openOn = async (m) => {
  const done = P.openNewSession({ m });
  await settle();
  return { sheet: body.children.find((x) => x.tag === 'dialog'), done };
};

test('a tool without an App on the computer: not a choice for the App, the way to the Terminal instead', async () => {
  localStorage.setItem('pref:new.openAs', JSON.stringify('app'));
  localStorage.setItem('pref:new.tool', JSON.stringify('opencode'));
  try {
    const { sheet, done } = await openOn('box2');
    const oc = tile(sheet, 'opencode');
    assert.equal(oc.tag, 'div', 'no button for the App');
    assert.match(text(oc), /No App for it on this computer yet: open it in the Terminal/);
    assert.equal(tile(sheet, 'claude').attrs['aria-checked'], 'true', 'what the tile shows is what is sent');
    oc.querySelector('button').fire('click'); // "open it in the Terminal"
    assert.equal(tile(sheet, 'terminal').attrs['aria-checked'], 'true', 'the way switched');
    assert.equal(tile(sheet, 'opencode').attrs['aria-checked'], 'true', 'and the tool is ready for it, chosen as last time');
    calls.length = 0;
    sheet.querySelector('button.row[data-name="site"]').fire('click');
    await settle();
    const post = calls.find(([m, p]) => m === 'POST' && p === '/m/box2/api/sessions');
    assert.ok(post, 'a terminal session');
    assert.equal(post[2].tool, 'opencode', 'with exactly the tool the tile showed');
    if (sheet.open) sheet.close();
    await done;
  } finally {
    localStorage.removeItem('pref:new.tool');
    localStorage.removeItem('pref:new.openAs');
  }
});

test('a computer that cannot be reached says so, and nothing can be started there', async () => {
  const { sheet, done } = await openOn('box3');
  assert.match(text(sheet), /Box 3 cannot be reached now: nothing can be started there\./);
  assert.equal(tile(sheet, 'claude'), undefined, 'no "Claude Code · Ready"');
  assert.equal(sheet.querySelector('button.row'), null, 'no project to tap');
  sheet.close();
  await done;
});

// ---------- the focus stays where it was while parts are drawn again ----------
test('the focus keeps its control while the coding tools arrive late, and never leaves the popup', async () => {
  let release;
  const late = new Promise((r) => (release = r));
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (u.split('?')[0] === '/api/codetools') await late;
    return real(u, o);
  };
  try {
    const done = P.openNewSession({ m: null });
    await settle();
    const sheet = body.children.find((x) => x.tag === 'dialog');
    assert.ok(sheet.contains(document.activeElement), 'the focus starts in the popup');
    // On the Options' "How hard it thinks", the tools arrive and the Options are drawn again.
    const effort = sheet.querySelector('[data-key="How hard it thinks"]');
    effort.focus();
    release();
    await settle();
    assert.notEqual(sheet.querySelector('[data-key="How hard it thinks"]'), effort, 'it was drawn again');
    assert.equal(document.activeElement, sheet.querySelector('[data-key="How hard it thinks"]'), 'the same field has the focus');
    // On a tool tile, the way changes and the tiles are drawn again: the same tile keeps it.
    tile(sheet, 'opencode').focus();
    tile(sheet, 'terminal').fire('click');
    tile(sheet, 'opencode').focus();
    tile(sheet, 'app').fire('click');
    assert.ok(sheet.contains(document.activeElement), 'never outside the popup');
    sheet.close();
    await done;
  } finally {
    globalThis.fetch = real;
  }
});

// ---------- what a start sends ----------
const S = await import('../../web/newsession-start.js');
const pcHere = { machine: null, recommended: 'max', recommendedIn: {}, toolDefaults: {}, profiles: [{ name: 'max', tools: ['claude'] }, { name: 'key', tools: ['claude', 'opencode'] }] };
async function sent(way, st, info = null) {
  calls.length = 0;
  const went = [];
  await S.startSession({ path: '/w/shop', name: 'shop' }, {
    st: { m: null, profile: '', permissionMode: '', effort: '', model: '', conversation: 'new', ...st }, pc: pcHere, way, info,
    toolName: 'X', busy: () => {}, failed: (e) => assert.fail(e.message), leave: (h) => went.push(h), picking: () => {},
  });
  return { posts: calls.filter(([m]) => m === 'POST').map(([, p, b]) => [p, b]), went };
}

test('a Terminal start sends the provider, the mode, the effort and the model chosen', async () => {
  const { posts, went } = await sent('claude', { tool: 'claude', profile: 'key', permissionMode: 'acceptEdits', effort: 'high', model: 'opus' });
  assert.deepEqual(posts, [['/api/sessions', { dir: '/w/shop', profile: 'key', mode: 'new', sessionId: null, permissionMode: 'acceptEdits', effort: 'high', model: 'opus' }]]);
  assert.deepEqual(went, ['#/s/term-1']);
  const oc = await sent('claude', { tool: 'opencode', permissionMode: 'bypassPermissions', effort: 'max' }, { id: 'opencode', modes: ['manual'] });
  assert.deepEqual(oc.posts, [['/api/sessions', { tool: 'opencode', dir: '/w/shop', mode: 'new', sessionId: null, permissionMode: 'bypassPermissions', effort: 'max' }]], 'another tool names itself; no provider chosen: none sent');
});

test('"Continue the last one": the App and another tool continue the newest conversation; Claude Code\'s terminal finds it itself', async () => {
  const app = await sent('chat', { tool: 'claude', conversation: 'continue' });
  assert.deepEqual(app.posts, [['/api/chats', { dir: '/w/shop', tool: 'claude', sessionId: 'c1' }]]);
  const term = await sent('claude', { tool: 'claude', conversation: 'continue' });
  assert.deepEqual(term.posts, [['/api/sessions', { dir: '/w/shop', mode: 'continue', sessionId: null, permissionMode: null, effort: null, model: null }]]);
  const oc = await sent('claude', { tool: 'opencode', conversation: 'continue' }, { id: 'opencode', modes: ['manual'] });
  assert.deepEqual(oc.posts, [['/api/sessions', { tool: 'opencode', dir: '/w/shop', mode: 'resume', sessionId: 'o1', permissionMode: 'ask', effort: null }]]);
});
