// New session as a popup (web/newsession-popup.js, newsession-options.js, newsession-choice.js), in a small stand-in
// DOM: the first screen is the projects as rows (one tap starts an App chat with nothing else sent), the computers are
// chips only where several are linked, "More options" holds only what is needed at the start, and a popup opened from
// a project has the project set, "Change" and "Start". Behaviours are named in the tests below.
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
globalThis.location.replace = (h) => { globalThis.location.hash = h; };
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
const choice = (n, id) => find(n, (x) => x.attrs['data-choice'] === id);
const key = (n, k) => find(n, (x) => x.attrs['data-key'] === k);
const moreBtn = (n) => key(n, 'more');
const opened = async (sheet) => {
  moreBtn(sheet).fire('click');
  await settle();
};
const bodyText = (sheet) => text(sheet);
// Off: the property where the page set it, else the attribute the element was made with (the stand-in has no
// property of its own for it).
const off = (el) => el.disabled === true || (el.disabled === undefined && 'disabled' in el.attrs);
const settle = () => new Promise((r) => realTimeout(r, 30));

const S = await import('../../web/newsession-start.js');
const O = await import('../../web/newsession-options.js');
const { store: pageStore } = await import('../../web/store.js');

const dialog = () => body.children.filter((x) => x.tag === 'dialog').at(-1);
const openOn = async (m, project = null) => {
  const done = P.openNewSession({ m, ...(project ? { project } : {}) });
  await settle();
  return { sheet: dialog(), done };
};
// The computers the page knows: the three of the fixture, or just this one.
async function computers(only) {
  const keep = answers['/api/machines/sessions'];
  if (only) answers['/api/machines/sessions'] = { machines: [keep.machines[0]] };
  await pageStore.refresh();
  return async () => {
    answers['/api/machines/sessions'] = keep;
    await pageStore.refresh();
  };
}
const pcHere = { machine: null, recommended: 'max', recommendedIn: {}, toolDefaults: {}, profiles: [{ name: 'max', tools: ['claude'] }, { name: 'key', tools: ['claude', 'opencode'] }] };
const startButtons = (sheet) => sheet.querySelectorAll('[data-startctl]');

// ---------- the first screen ----------
test('first-screen-controls: the title line, More options, the projects as rows, Another folder; no Start word, no tiles', async () => {
  localStorage.removeItem('pref:new.openAs');
  localStorage.removeItem('pref:new.tool');
  const back = await computers(true);
  try {
    location.hash = '#/';
    const { sheet, done } = await openOn(null);
    const buttons = findAll(sheet, (x) => x.tag === 'button' && !x.attrs['data-name'] && !x.attrs['data-open'] && x.attrs.title !== 'Close');
    assert.deepEqual(buttons.map((b) => b.attrs['data-key'] || text(b).trim()), ['more', 'Another folder…'], 'one computer: More options and Another folder, nothing else');
    assert.equal(text(moreBtn(sheet)).trim(), 'More options');
    assert.match(text(sheet), /Tap a project to start/);
    assert.deepEqual(findAll(sheet, (x) => x.className === 'group-head').map((x) => text(x).trim()), ['Recent'], 'one project list: Recent');
    assert.deepEqual(findAll(sheet, (x) => x.tag === 'button' && x.classList.contains('row') && x.attrs['data-name']).map((x) => x.attrs['data-name']), ['shop', 'api']);
    assert.doesNotMatch(text(sheet), /\bStart\b/, 'no Start word on the rows');
    assert.equal(findAll(sheet, (x) => x.tag === 'select').length, 0, 'no select');
    assert.equal(findAll(sheet, (x) => /ns-tile|ns-choices|ns-chip/.test(x.className)).length, 0, 'no tiles, no line of choices, no chips with one computer');
    assert.doesNotMatch(text(sheet), /Open as|Coding tool|Provider|Also open|Options\b(?!\s*$)/);
    assert.equal(findAll(sheet, (x) => x.classList.contains('ns-elsewhere')).length, 1);
    assert.equal(findAll(sheet, (x) => /Another folder/.test(text(x)) && x.tag === 'button').length, 1, 'one row for another folder');
    assert.equal(document.activeElement, moreBtn(sheet), 'the focus starts on the first control');
    sheet.close();
    await done;
  } finally {
    await back();
  }
});

test('computer-chips-only-when-several: small chips over the projects, none while a project is set', async () => {
  const { sheet, done } = await openOn(null);
  const chips = findAll(sheet, (x) => x.classList.contains('ns-chip'));
  assert.deepEqual(chips.map((c) => text(c).trim()), ['This computer', 'Box 2', 'Box 3'], 'the label only');
  assert.equal(findAll(sheet, (x) => x.classList.contains('ns-chip') && x.classList.contains('ns-is-chosen')).length, 1);
  assert.equal(off(chips[2]), true, 'one that cannot run a session is off');
  assert.doesNotMatch(text(sheet), /providers? ·|has room/, 'no words under a chip');
  sheet.close();
  await done;
  const preset = await openOn(null, { path: '/w/shop', name: 'shop', short: '~/shop' });
  assert.equal(findAll(preset.sheet, (x) => x.classList.contains('ns-chip')).length, 0);
  preset.sheet.close();
  await preset.done;
  localStorage.removeItem('pref:new.machine');
});

test('a chip chooses the computer, the project list is that computer\'s, and it is remembered', async () => {
  const { sheet, done } = await openOn(null);
  choice(sheet, 'box2').fire('click');
  await settle();
  assert.equal(localStorage.getItem('pref:new.machine'), '"box2"');
  assert.ok(find(sheet, (x) => x.attrs['data-name'] === 'site'), 'Box 2\'s own projects');
  assert.equal(find(sheet, (x) => x.attrs['data-name'] === 'shop'), undefined);
  sheet.close();
  await done;
  localStorage.removeItem('pref:new.machine');
});

test('a tap on a project row starts an App chat with nothing else sent', async () => {
  const back = await computers(true);
  try {
    const { sheet, done } = await openOn(null);
    calls.length = 0;
    sheet.querySelector('button.row[data-name="shop"]').fire('click');
    await settle();
    const posts = calls.filter(([m]) => m === 'POST');
    assert.deepEqual(posts, [['POST', '/api/chats', { dir: '/w/shop', tool: 'claude' }]], 'the folder and the coding tool, nothing else: the server takes the rest');
    assert.equal(location.hash, '#/chat/new-chat');
    sheet.close();
    await done;
  } finally {
    await back();
  }
});

test('the removed choices are not in the popup, with More options closed or open', async () => {
  const { sheet, done } = await openOn(null);
  for (const pass of ['closed', 'open']) {
    if (pass === 'open') await opened(sheet);
    assert.equal(findAll(sheet, (x) => x.tag === 'select').length, 0, `${pass}: no select (provider, mode, effort, model, conversation)`);
    for (const k of ['Provider', 'What Claude Code may do without asking', 'How hard it thinks', 'Model', 'Conversation', 'lead', 'lead-others', 'plain']) assert.equal(key(sheet, k), undefined, `${pass}: no ${k}`);
    assert.doesNotMatch(text(sheet), /Provider|Accept edits|Bypass|Extra high|Fable|opusplan|Split work|plain terminal|Continue the last one|Open as|Ready/);
  }
  sheet.close();
  await done;
});

test('start-body-has-no-provider-mode-model: the App and the terminal leave them out', async () => {
  const pc = { machine: null, recommended: 'max', recommendedIn: {}, toolDefaults: {}, profiles: [{ name: 'max', tools: ['claude'] }, { name: 'key', tools: ['claude', 'opencode'] }] };
  const go = async (way, st, name = 'X') => {
    calls.length = 0;
    await S.startSession({ path: '/w/shop', name: 'shop' }, { st: { m: null, ...st }, pc, way, toolName: name, busy() {}, failed: (e) => assert.fail(e.message), leave() {}, picking() {} });
    return calls.filter(([m]) => m === 'POST').map(([, p, b]) => [p, b]);
  };
  assert.deepEqual(await go('chat', { tool: 'claude', profile: 'key', permissionMode: 'plan', effort: 'high', model: 'opus', lead: true, leadTouched: true, conversation: 'continue' }), [['/api/chats', { dir: '/w/shop', tool: 'claude' }]], 'whatever an old field says, none is sent');
  assert.deepEqual(await go('claude', { tool: 'claude', profile: 'key', permissionMode: 'plan', effort: 'high', model: 'opus' }), [['/api/sessions', { dir: '/w/shop', mode: 'new', sessionId: null, permissionMode: null, effort: null, model: null }]]);
  assert.deepEqual(await go('claude', { tool: 'opencode', permissionMode: 'bypassPermissions', effort: 'max' }), [['/api/sessions', { tool: 'opencode', dir: '/w/shop', mode: 'new', sessionId: null, permissionMode: 'ask', effort: null }]], 'another tool asks first, names itself, no provider');
  assert.deepEqual(await go('claude', { tool: 'claude', rootDefaultBypass: true }), [['/api/sessions', { dir: '/w/shop', mode: 'new', sessionId: null, permissionMode: 'manual', effort: null, model: null }]], 'root with Bypass as the default: the terminal asks first');
  answers['/api/chats'] = { id: 'new-chat', worktree: { branch: 'b' } };
  assert.deepEqual(await go('chat', { tool: 'claude', worktree: true, also: ['blog'] }), [['/api/chats', { dir: '/w/shop', tool: 'claude', worktree: true, with: ['blog'] }]], 'a branch and other projects are sent where chosen');
  answers['/api/chats'] = { id: 'new-chat' };
});

test('earlier-conversation-picks-newest-first: the list after the project tap, one tap continues it', async () => {
  const keep = answers['/api/folders/sessions'];
  answers['/api/folders/sessions'] = { sessions: [{ id: 'old', at: 1000, title: 'Old one' }, { id: 'new', at: 3000, title: 'Newest one' }, { id: 'mid', at: 2000, title: 'Middle one' }] };
  try {
    calls.length = 0;
    let picked = null;
    const run = S.startSession({ path: '/w/shop', name: 'shop' }, { st: { m: null, tool: 'claude', earlier: true }, pc: pcHere, way: 'chat', toolName: 'Claude Code', busy() {}, failed: (e) => assert.fail(e.message), leave() {}, picking: () => { picked = true; } });
    await settle();
    assert.equal(picked, true, 'the list took the popup\'s place');
    const sheet = dialog();
    const rows = findAll(sheet, (x) => x.tag === 'button' && x.classList.contains('choice'));
    assert.equal(rows.length, 3);
    ['Newest one', 'Middle one', 'Old one'].forEach((title, n) => assert.ok(text(rows[n]).trim().startsWith(title), `row ${n} is ${title}`));
    rows[0].fire('click');
    await run;
    assert.deepEqual(calls.find(([m, p]) => m === 'POST' && p === '/api/chats')[2], { dir: '/w/shop', tool: 'claude', sessionId: 'new' });
  } finally {
    answers['/api/folders/sessions'] = keep;
  }
});

// ---------- More options ----------
test('options-closed-list: exactly the kept ones, each with its show rule', async () => {
  const keys = (sheet) => findAll(sheet, (x) => x.tag === 'input' || (x.tag === 'button' && x.classList.contains('ns-seg-btn'))).map((x) => x.attrs['data-key'] || x.attrs['data-choice']);
  const { sheet, done } = await openOn(null);
  assert.equal(moreBtn(sheet).attrs['aria-expanded'], 'false');
  assert.equal(findAll(sheet, (x) => x.tag === 'input' && x.attrs.type === 'checkbox').length, 0, 'closed: nothing of them is drawn');
  await opened(sheet);
  assert.equal(moreBtn(sheet).attrs['aria-expanded'], 'true');
  // Claude Code and OpenCode are ready, the App has both: terminal, tool (2 parts), earlier, worktree.
  assert.deepEqual(keys(sheet), ['terminal', 'claude', 'opencode', 'earlier', 'worktree']);
  assert.match(text(sheet), /Open in a terminal/);
  assert.match(text(sheet), /Claude Code's own screen instead of the chat/);
  assert.match(text(sheet), /On a branch of its own/);
  assert.match(text(sheet), /Changes stay apart until you merge them\. Git projects only\./);
  assert.match(text(sheet), /An earlier conversation/);
  // The terminal: no branch (an App with Claude Code only).
  key(sheet, 'terminal').checked = true;
  key(sheet, 'terminal').fire('change');
  await settle();
  assert.deepEqual(keys(sheet), ['terminal', 'claude', 'opencode', 'earlier']);
  assert.equal(localStorage.getItem('pref:new.openAs'), '"terminal"');
  // Closed again: the same button closes it, and nothing is remembered about being open.
  moreBtn(sheet).fire('click');
  assert.equal(findAll(sheet, (x) => x.tag === 'input').length, 0);
  sheet.close();
  await done;
  localStorage.removeItem('pref:new.openAs');
  localStorage.removeItem('pref:new.tool');
  // Only one tool ready (OpenCode off): no coding tool switch.
  answers['/api/codetools'] = tools({ on: false });
  const one = await openOn(null);
  await opened(one.sheet);
  assert.deepEqual(keys(one.sheet), ['terminal', 'earlier', 'worktree'], 'a tool that is not ready is never listed');
  assert.doesNotMatch(text(one.sheet), /OpenCode|Not installed|Turned off/);
  one.sheet.close();
  await one.done;
  answers['/api/codetools'] = tools({});
});

test('options: Read other projects too only where the map offers something, behind More options and before the projects', async () => {
  location.hash = '#/';
  const { sheet: none, done: d0 } = await openOn(null);
  await opened(none);
  assert.equal(key(none, 'also:blog'), undefined, 'nothing to offer: nothing shown');
  none.close();
  await d0;
  answers['/api/folders/extras'] = { project: null, needs: [], choices: ['blog', 'shop'] };
  try {
    const { sheet, done } = await openOn(null);
    assert.equal(key(sheet, 'also:blog'), undefined, 'closed: not drawn');
    await opened(sheet);
    assert.match(text(sheet), /Read other projects too/);
    const order = all(sheet).filter((x) => x instanceof FakeElement);
    const also = order.findIndex((x) => x.attrs['data-key'] === 'also:blog');
    const row = order.findIndex((x) => x.tag === 'button' && x.attrs['data-name'] === 'shop');
    assert.ok(also >= 0 && row > also, 'the ticks come before the first row that starts a session');
    sheet.close();
    await done;
  } finally {
    delete answers['/api/folders/extras'];
  }
});

test('more-options-summary-only-when-not-default: the button says why a tap will not open the App', async () => {
  localStorage.setItem('pref:new.openAs', JSON.stringify('terminal'));
  const a = await openOn(null);
  assert.match(text(moreBtn(a.sheet)), /^\s*Terminal\s*More options\s*$/);
  a.sheet.close();
  await a.done;
  localStorage.removeItem('pref:new.openAs');
  const b = await openOn(null);
  assert.equal(text(moreBtn(b.sheet)).trim(), 'More options', 'the plain start: no summary');
  b.sheet.close();
  await b.done;
});

test('the remembered three: the computer, App or Terminal, and the coding tool; the one-time choices are not', async () => {
  localStorage.removeItem('pref:new.openAs');
  localStorage.removeItem('pref:new.tool');
  localStorage.removeItem('pref:new.machine');
  const { sheet, done } = await openOn(null);
  choice(sheet, 'box2').fire('click');
  await settle();
  choice(sheet, '~').fire('click');
  await settle();
  await opened(sheet);
  choice(sheet, 'opencode').fire('click');
  key(sheet, 'terminal').checked = true;
  key(sheet, 'terminal').fire('change');
  key(sheet, 'earlier').checked = true;
  key(sheet, 'earlier').fire('change');
  assert.equal(localStorage.getItem('pref:new.machine'), '"~"');
  assert.equal(localStorage.getItem('pref:new.tool'), '"opencode"');
  assert.equal(localStorage.getItem('pref:new.openAs'), '"terminal"');
  assert.deepEqual([...store.keys()].filter((k) => k.startsWith('pref:')).sort(), ['pref:new.machine', 'pref:new.openAs', 'pref:new.tool'], 'nothing else is kept (not the earlier conversation, not the branch)');
  sheet.close();
  await done;
  // The next popup: the three come back as chosen, one tap on a project starts there.
  const next = await openOn(null);
  assert.match(text(moreBtn(next.sheet)), /Terminal · OpenCode/);
  calls.length = 0;
  next.sheet.querySelector('button.row[data-name="shop"]').fire('click');
  await settle();
  assert.ok(calls.find(([m, p, b]) => m === 'POST' && p === '/api/sessions' && b.tool === 'opencode'), 'a terminal session of OpenCode');
  if (next.sheet.open) next.sheet.close();
  await next.done;
  for (const k of ['new.openAs', 'new.tool', 'new.machine']) localStorage.removeItem(`pref:${k}`);
});

// ---------- opened from a project, another folder, nothing ready ----------
test('opened from a project: the project set, Change, Start, no heading and no computer; its last tool is the one sent', async () => {
  localStorage.setItem('pref:new.openAs', JSON.stringify('terminal'));
  const { sheet, done } = await openOn(null, { path: '/w/shop', name: 'shop', short: '~/shop' });
  assert.equal(sheet.open, true);
  assert.equal(sheet.classList.contains('sheet-tall'), true, 'the whole height on a phone');
  assert.deepEqual(findAll(sheet, (x) => x.className === 'group-head').length, 0, 'no heading');
  const preset = find(sheet, (x) => x.classList.contains('ns-preset'));
  assert.match(text(preset), /shop ~\/shop Change/);
  assert.ok(find(sheet, (x) => x.attrs['data-start'] === '1'), 'a Start button');
  assert.match(text(moreBtn(sheet)), /Terminal · OpenCode/, 'the tool its newest conversation ran in');
  calls.length = 0;
  find(sheet, (x) => x.attrs['data-start'] === '1').fire('click');
  await settle();
  assert.equal(calls.find(([m, p]) => m === 'POST' && p === '/api/sessions')[2].tool, 'opencode');
  localStorage.removeItem('pref:new.openAs');
  if (sheet.open) sheet.close();
  await done;
});

test('opened from a project: Start waits until the last tool is known; Change goes back to the list and the browser\'s choice', async () => {
  localStorage.setItem('pref:new.tool', JSON.stringify('claude'));
  try {
    const done = P.openNewSession({ m: null, project: { path: '/w/shop', name: 'shop', short: '~/shop' } });
    const sheet = dialog();
    assert.equal(off(sheet.querySelector('[data-start]')), true, 'Start waits');
    await settle();
    assert.equal(off(sheet.querySelector('[data-start]')), false, 'Start once the tool is known');
    sheet.querySelector('.ns-preset').querySelector('button').fire('click'); // Change
    await settle();
    assert.equal(find(sheet, (x) => x.attrs['data-start'] === '1'), undefined);
    assert.ok(find(sheet, (x) => x.attrs['data-name'] === 'shop'), 'the projects');
    assert.equal(text(moreBtn(sheet)).trim(), 'More options', 'after Change: the browser\'s last choice, Claude Code, the App');
    sheet.close();
    await done;
  } finally {
    localStorage.removeItem('pref:new.tool');
  }
});

test('Another folder: browse starts in the first root, Up goes on, Start here is pinned, the project line stays', async () => {
  answers['/api/folders/browse'] = (q) => ({ path: q.get('path'), short: '~/other', parent: '/', dirs: [{ name: 'deep', path: '/w/other/deep' }] });
  answers['/api/pcsetup/projects'] = { projectsDir: '/p', projectsShort: '~/p', workspaces: [], repos: [] };
  try {
    const { sheet, done } = await openOn(null);
    calls.length = 0;
    sheet.querySelector('.ns-elsewhere').querySelector('button').fire('click');
    await settle();
    assert.equal(calls.find(([m, p]) => m === 'GET' && p === '/api/folders/browse') && true, true);
    assert.ok(find(sheet, (x) => x.attrs['title'] === 'Up one folder'));
    assert.ok(find(sheet, (x) => x.attrs['data-starthere'] === '1'), 'Start here');
    assert.match(text(sheet), /Make it a project/, 'a folder outside the projects folder');
    sheet.close();
    await done;
  } finally {
    answers['/api/folders/browse'] = { path: '/w/other', short: '~/other', parent: null, dirs: [] };
    delete answers['/api/pcsetup/projects'];
  }
});

test('nothing ready to start: the projects give way to one plain line and one button to the fix', async () => {
  answers['/api/codetools'] = { tools: [{ id: 'claude', name: 'Claude Code', on: true, providers: [] }] };
  try {
    const { sheet, done } = await openOn(null);
    assert.equal(sheet.querySelector('button.row'), null, 'no project to tap');
    assert.match(text(sheet), /Claude Code: Needs a provider first\./);
    const fix = find(sheet, (x) => x.tag === 'a' && x.attrs.href === '#/providers');
    assert.ok(fix, 'the one button');
    assert.match(text(fix), /Add provider/);
    assert.equal(find(sheet, (x) => x.classList.contains('ns-intro')).classList.contains('hidden'), true, 'the line over the projects goes too');
    assert.doesNotMatch(text(sheet), /Ready/);
    sheet.close();
    await done;
  } finally {
    answers['/api/codetools'] = tools({});
  }
});

// ---------- an empty App chat is opened again, not made twice ----------
test('empty-chat-reused: a chat of the folder with no message yet is opened instead of a second one', async () => {
  const keep = answers['/api/machines/sessions'];
  const empty = { name: 'chat-1', kind: 'chat', chatId: 'abc', cwd: '/w/shop', status: 'waiting', lastMessage: '', title: '', tool: 'claude' };
  const withSession = (extra) => ({ machines: [{ ...keep.machines[0], sessions: [...keep.machines[0].sessions, ...extra] }, ...keep.machines.slice(1)] });
  try {
    answers['/api/machines/sessions'] = withSession([empty]);
    await pageStore.refresh();
    const { sheet, done } = await openOn(null);
    calls.length = 0;
    sheet.querySelector('button.row[data-name="shop"]').fire('click');
    await settle();
    assert.equal(calls.filter(([m]) => m === 'POST').length, 0, 'no second chat');
    assert.equal(location.hash, '#/chat/abc', 'the empty one opens');
    assert.equal(sheet.open, false, 'and the popup closed');
    await done;
    // A chat that has a message (or a title) is no empty one: a new chat is made.
    answers['/api/machines/sessions'] = withSession([{ ...empty, lastMessage: 'Done.' }]);
    await pageStore.refresh();
    const again = await openOn(null);
    calls.length = 0;
    again.sheet.querySelector('button.row[data-name="shop"]').fire('click');
    await settle();
    assert.ok(calls.some(([m, p]) => m === 'POST' && p === '/api/chats'), 'a new chat');
    again.sheet.close();
    await again.done;
    // A branch of its own asks for a new one.
    answers['/api/machines/sessions'] = withSession([empty]);
    await pageStore.refresh();
    const wt = await openOn(null);
    await opened(wt.sheet);
    key(wt.sheet, 'worktree').checked = true;
    key(wt.sheet, 'worktree').fire('change');
    calls.length = 0;
    answers['/api/chats'] = { id: 'new-chat', worktree: { branch: 'b' } };
    wt.sheet.querySelector('button.row[data-name="shop"]').fire('click');
    await settle();
    assert.deepEqual(calls.find(([m, p]) => m === 'POST' && p === '/api/chats')[2], { dir: '/w/shop', tool: 'claude', worktree: true });
    answers['/api/chats'] = { id: 'new-chat' };
    wt.sheet.close();
    await wt.done;
  } finally {
    answers['/api/machines/sessions'] = keep;
    await pageStore.refresh();
  }
});

// ---------- the addresses ----------
test('the addresses: #/new opens the popup, #/new?dir= asks Open the App here? and starts nothing until yes', async () => {
  location.hash = '#/new';
  const done = P.newFromAddress({ query: new URLSearchParams() });
  await settle();
  const sheet = dialog();
  assert.ok(moreBtn(sheet), 'the popup');
  sheet.close();
  await done;
  location.hash = '#/new?dir=%2Fw%2Fshop';
  calls.length = 0;
  const asked = P.newFromAddress({ query: new URLSearchParams('dir=/w/shop') });
  await settle();
  const ask = dialog();
  assert.match(text(ask), /Open the App here\?/);
  assert.match(text(ask), /Nothing is sent until you write/);
  assert.equal(calls.filter(([m]) => m === 'POST').length, 0, 'nothing started yet');
  find(ask, (x) => x.tag === 'button' && /Open the App/.test(text(x))).fire('click');
  await asked;
  await settle();
  assert.deepEqual(calls.find(([m, p]) => m === 'POST' && p === '/api/chats')[2], { dir: '/w/shop' }, 'the chat of that folder, as the last one there');
});

// ---------- the pieces ----------
test('App or Terminal: this browser\'s last choice, the App the very first time', () => {
  assert.equal(C.openAsDefault(undefined), 'app');
  assert.equal(C.openAsDefault('terminal'), 'terminal');
  assert.equal(C.openAsDefault('chat'), 'app', 'an unknown value: the App');
});

test('a coding tool that is not ready says what is missing and where it is fixed', () => {
  assert.deepEqual(C.toolState({ managed: true, installed: null, on: true, providers: ['k'] }), { ready: false, why: 'Not installed', fix: 'install it in Settings', href: '#/settings/new-sessions?show=coding-tools' });
  assert.deepEqual(C.toolState({ managed: true, installed: '1', on: false, providers: ['k'] }, 'laptop'), { ready: false, why: 'Turned off', fix: 'turn it on in Settings', href: '#/m/laptop/settings/new-sessions?show=coding-tools' });
  assert.deepEqual(C.toolState({ on: true, providers: [] }), { ready: false, why: 'Needs a provider first', fix: 'Add provider', href: '#/providers', button: true });
  assert.deepEqual(C.toolState({ on: true, providers: ['k'] }), { ready: true });
  assert.deepEqual(C.toolState({ id: 'claude', name: 'Claude Code' }), { ready: true }, 'an older computer\'s list: what a chat runs is ready');
  assert.equal(C.lackLine({ name: 'OpenCode', state: C.toolState({ managed: true, installed: null }) }), 'OpenCode: Not installed.');
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

test('More options built by itself: the terminal switch changes the way, the tool switch the tool', () => {
  const st = { openAs: 'app', tool: 'claude', earlier: false };
  const seen = [];
  const tools2 = [{ id: 'claude', name: 'Claude Code' }, { id: 'opencode', name: 'OpenCode' }];
  const nodes = O.optionsFor({ st, tools: tools2, toolName: (id) => (id === 'claude' ? 'Claude Code' : 'OpenCode'), onchange: (w) => seen.push(w) });
  const inputs = (n) => findAll(n, (x) => x.tag === 'input').map((x) => x.attrs['data-key']);
  assert.deepEqual(nodes.flatMap(inputs), ['terminal', 'earlier', 'worktree']);
  find(nodes[0], (x) => x.tag === 'input').fire('change', { target: { checked: true } });
  assert.equal(st.openAs, 'terminal');
  find(nodes[1], (x) => x.attrs['data-choice'] === 'opencode').fire('click');
  assert.equal(st.tool, 'opencode');
  assert.deepEqual(seen, ['way', 'tool']);
  assert.equal(O.summaryOf(st, tools2), 'Terminal · OpenCode');
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
    assert.ok(startButtons(sheet).every((c) => c.disabled), 'every start control is off');
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
async function openWithRunning() {
  localStorage.removeItem('pref:new.openAs');
  location.hash = '#/';
  const done = P.openNewSession({ m: null });
  await settle();
  return { sheet: dialog(), done };
}

test('a tap on a project where a session runs starts a new session; Continue beside it opens what runs and starts nothing', async () => {
  const { sheet, done } = await openWithRunning();
  const rowBtn = find(sheet, (x) => x.tag === 'button' && x.attrs['data-name'] === 'api');
  assert.ok(rowBtn, 'the row is a button of its own');
  assert.equal(find(rowBtn, (x) => x.attrs['data-open']), undefined, 'the Continue button is not inside it');
  const open = find(sheet, (x) => x.attrs['data-open'] === 'api');
  assert.equal(open.tag, 'button');
  assert.match(text(open), /Continue/);
  assert.equal(open.attrs['aria-label'], 'Continue the session running in api', 'a label for screen readers');
  assert.equal(find(sheet, (x) => x.attrs['data-open'] === 'shop'), undefined, 'none where nothing runs');
  calls.length = 0;
  open.fire('click');
  await settle();
  assert.equal(location.hash, '#/s/api', 'what runs there (runningIn)');
  assert.equal(calls.filter(([m]) => m === 'POST').length, 0, 'no session started');
  assert.equal(sheet.open, false, 'the popup closed');
  await done;
  const again = await openWithRunning();
  calls.length = 0;
  again.sheet.querySelector('button.row[data-name="api"]').fire('click');
  await settle();
  const post = calls.find(([m, p]) => m === 'POST' && p === '/api/chats');
  assert.ok(post, 'a new session in the App');
  assert.equal(post[2].dir, '/w/api');
  assert.equal(location.hash, '#/chat/new-chat');
  again.sheet.close();
  await again.done;
});

test('one start at a time: two taps on a project\'s row send one request', async () => {
  assert.equal(await twice(openWithRunning, (s) => s.querySelector('button.row[data-name="shop"]')), 1);
});

test('one start at a time: two taps on Start (a project set) send one request', async () => {
  const open = () => openOn(null, { path: '/w/shop', name: 'shop', short: '~/shop' });
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
    assert.ok(startButtons(sheet).every((c) => !c.disabled));
    assert.match(text(sheet.querySelector('.ns-status')), /Request failed \(404\)/);
  } finally {
    answers['/api/chats'] = saved;
    sheet.close();
    await done;
  }
});

// ---------- a tool without an App on the computer ----------
test('a tool without an App on the computer is no choice for the App; the terminal switch makes it one', async () => {
  localStorage.setItem('pref:new.openAs', JSON.stringify('app'));
  localStorage.setItem('pref:new.tool', JSON.stringify('opencode'));
  try {
    const { sheet, done } = await openOn('box2');
    assert.equal(text(moreBtn(sheet)).trim(), 'More options', 'the App with Claude Code: what a start sends is what the button says');
    await opened(sheet);
    assert.equal(choice(sheet, 'opencode'), undefined, 'OpenCode has no App there: not listed');
    key(sheet, 'terminal').checked = true;
    key(sheet, 'terminal').fire('change');
    await settle();
    assert.ok(choice(sheet, 'opencode'), 'ready for the terminal');
    assert.match(text(moreBtn(sheet)), /Terminal · OpenCode/, 'and chosen, as last time');
    calls.length = 0;
    sheet.querySelector('button.row[data-name="site"]').fire('click');
    await settle();
    const post = calls.find(([m, p]) => m === 'POST' && p === '/m/box2/api/sessions');
    assert.ok(post, 'a terminal session');
    assert.equal(post[2].tool, 'opencode', 'with exactly the tool the button names');
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
  assert.equal(sheet.querySelector('button.row'), null, 'no project to tap');
  assert.ok(find(sheet, (x) => x.tag === 'a' && x.attrs.href === '#/computers'), 'the one button');
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
    const sheet = dialog();
    assert.ok(sheet.contains(document.activeElement), 'the focus starts in the popup');
    const more = moreBtn(sheet);
    more.focus();
    release();
    await settle();
    assert.notEqual(moreBtn(sheet), more, 'it was drawn again');
    assert.equal(document.activeElement, moreBtn(sheet), 'the same button has the focus');
    sheet.close();
    await done;
  } finally {
    globalThis.fetch = real;
  }
});
