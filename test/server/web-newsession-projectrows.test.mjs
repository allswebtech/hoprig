// New session: one row per project. A tap starts in the project own folder; its code folders are no rows; Recent counts a
// session in a code folder for the project, and Continue finds the sessions of the project folder and its code folders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  '/api/machines/sessions': { machines: [{ machine: null, label: 'This computer', status: 'online', recommended: 'max', profiles: [{ name: 'max', label: 'Claude Max', kind: 'login', tools: ['claude'] }, { name: 'key', label: 'Key', kind: 'api', tools: ['claude', 'opencode'] }], sessions: [{ name: 'api', kind: 'claude', cwd: '/w/api' }, { name: 'b1', kind: 'claude', cwd: '/w/blog' }, { name: 'b2', kind: 'chat', cwd: '/w/blog' }] },
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
  '/api/folders/recent': { folders: [{ path: '/w/shop', name: 'shop', short: '~/shop' }, { path: '/w/api', name: 'api', short: '~/api', live: true, session: 'api' }, { path: '/w/blog', name: 'blog', short: '~/blog', live: true, session: 'b1' }], roots: [{ path: '/w', short: '~' }] },
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

// The workspace: shop (a code folder of its own name and one more), blog (one code folder), and a plain repository notes.
const repo = (rel, dir) => ({ rel, dir, ok: true });
Object.assign(answers, {
  '/api/pcsetup/projects': {
    projectsDir: '/w', projectsShort: '~',
    workspaces: [
      { id: 'shop', place: '', name: 'shop', dir: '/w/shop', repos: [repo('.', '/w/shop'), repo('code/shop', '/w/shop/code/shop'), repo('code/shop-api', '/w/shop/code/shop-api')] },
      { id: 'blog', place: '', name: 'blog', dir: '/w/blog', repos: [repo('.', '/w/blog'), repo('code/site', '/w/blog/code/site')] },
    ],
    repos: [{ rel: 'notes', dir: '/w/notes', id: 'notes', place: '' }],
  },
  // Newest first: a session in a code folder of shop, a folder that is no project, shop itself, a code folder of blog.
  '/api/folders/recent': { folders: [
    { path: '/w/shop/code/shop-api', name: 'shop-api', short: '~/shop/code/shop-api', live: true, session: 'sa' },
    { path: '/w/loose', name: 'loose', short: '~/loose' },
    { path: '/w/shop', name: 'shop', short: '~/shop' },
    { path: '/w/blog/code/site', name: 'site', short: '~/blog/code/site' },
  ], roots: [{ path: '/w', short: '~' }] },
});
answers['/api/machines/sessions'].machines[0].sessions = [
  { name: 'sa', kind: 'claude', cwd: '/w/shop/code/shop-api' },
  { name: 'pc', kind: 'chat', cwd: '/w/shop' },
  { name: 'sc', kind: 'chat', cwd: '/w/shop/code/shop' },
];

async function popup() {
  localStorage.removeItem('pref:new.openAs');
  location.hash = '#/';
  const done = P.openNewSession({ m: null });
  await settle();
  return { sheet: body.children.find((x) => x.tag === 'dialog'), done };
}
const names = (sheet) => findAll(sheet, (x) => x.tag === 'button' && x.attrs['data-name'] !== undefined).map((x) => x.attrs['data-name']);

test('one row per project: its code folders have no rows, nothing reads The whole project or Code in', async () => {
  const { sheet, done } = await popup();
  assert.deepEqual(names(sheet).sort(), ['blog', 'loose', 'notes', 'shop']);
  assert.doesNotMatch(text(sheet), /The whole project|Code in |in shop|in blog/);
  assert.equal(findAll(sheet, (x) => /Another folder/.test(text(x)) && x.tag === 'button').length, 1, 'Another folder is still the way to a code folder');
  sheet.close();
  await done;
});

test('a session in a code folder makes its project the recent row, once; a folder that is no project stays', async () => {
  const { sheet, done } = await popup();
  assert.deepEqual(names(sheet), ['shop', 'loose', 'blog', 'notes'], 'Recent: shop (its code folder was the newest), loose, blog; then the rest of the projects');
  sheet.close();
  await done;
});

test('Continue beside a project finds the sessions of its folder and of its code folders', async () => {
  const { sheet, done } = await popup();
  const open = find(sheet, (x) => x.attrs['data-open'] === 'shop');
  assert.equal(text(open).trim(), 'Continue (3)');
  assert.equal(open.attrs['aria-label'], 'Continue one of the 3 sessions running in shop');
  assert.equal(find(sheet, (x) => x.attrs['data-open'] === 'blog'), undefined, 'nothing runs in blog');
  sheet.close();
  await done;
});

test('a tap on a project starts in the project folder, not in its code folder', async () => {
  const { sheet, done } = await popup();
  calls.length = 0;
  sheet.querySelector('button.row[data-name="shop"]').fire('click');
  await settle();
  const posts = calls.filter(([m]) => m === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0][2].dir, '/w/shop');
  sheet.close();
  await done;
});

test('a tap on a project whose code folder holds an empty chat does not open that chat', async () => {
  answers['/api/machines/sessions'].machines[0].sessions.push({ name: 'empty-in-code', kind: 'chat', status: 'waiting', cwd: '/w/blog/code/site', tool: 'claude' });
  const { sheet, done } = await popup();
  calls.length = 0;
  sheet.querySelector('button.row[data-name="blog"]').fire('click');
  await settle();
  assert.equal(calls.filter(([m]) => m === 'POST').length, 1, 'a new chat is made in the project folder');
  assert.notEqual(location.hash, '#/chat/empty-in-code');
  sheet.close();
  await done;
});

// Every other place that starts a session for a project starts in the project folder (pinned here: none of them starts
// in a code folder by default; the code is opened by the editor button only).
const page = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

test('the Projects page rows and a project page start in the project folder; a repository row opens code only', () => {
  const src = page('projects.js');
  assert.match(src, /newSessionButton\(p\.dir, p\.name\)/, 'a row of the Projects page');
  assert.match(src, /onclick: \(\) => p && newIn\(p\.dir, p\.name\)/, 'the project page New session');
  const repos = src.slice(src.indexOf('function paintRepos()'), src.indexOf('reposLabel.textContent'));
  assert.doesNotMatch(repos, /newIn\(|newSessionButton\(|startButton\(|openNewSession\(/, 'a repository row starts no session');
});

test('Work starts in the project folder and the New project card opens its chat in the project folder', () => {
  assert.match(fs.readFileSync(new URL('../../src/work/doit.mjs', import.meta.url), 'utf8'), /const folder = want\.folder !== undefined \? want\.folder : '\.';/, 'a task of a project: its own folder unless one is chosen');
  assert.match(page('firstrun.js'), /const \{ dir \} = await api\('~\/api\/onboarding\/first-chat', \{\}\);[\s\S]*startChat\(dir, \{\}\)/, 'the first project folder itself');
});
