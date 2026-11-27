// As root, where a person chooses the mode (Settings → New-session defaults), Bypass is not offered, ONE plain line
// quotes the coding tool's refusal and says what to do, and a default that names Bypass is kept as it is (never changed
// silently) while a terminal start from New session asks first. Driven in a small stand-in for
// the browser's document; the computer's answer is handed in.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    const cls = new Set();
    Object.assign(this, { tag, dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, open: false, value: '', parent: null });
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
  fire(k, e = {}) {
    for (const fn of this.listeners[k] || []) fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...e });
  }
  append(...n) {
    for (const c of n) if (c instanceof FakeElement) c.parent = this;
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  querySelectorAll(sel) {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    if (!m) throw new Error(`selector not known to the stand-in: ${sel}`);
    return all(this).slice(1).filter((el) => el instanceof FakeElement && m[1] in el.attrs);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
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
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const events = [];
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent: (e) => events.push(e.type), scrollTo() {} };
globalThis.location = { hash: '#/settings/addons', pathname: '/', search: '', protocol: 'http:', host: 'localhost', hostname: 'localhost', origin: 'http://localhost' };
globalThis.history = { replaceState() {} };
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => {
  const t = realTimeout(fn, ms, ...a);
  t.unref?.();
  return t;
};

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tools: [] }) });

const { ROOT_BYPASS_LINE } = await import('../../src/bypassgate.mjs');
await import('../../web/sessiondefaults.js');
const { registeredSettingsPages } = await import('../../web/registry.js');

function all(n, out = []) {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
}
const text = (n) => all(n).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ').trim();
const wrap = (nodes) => {
  const el = new FakeElement('div');
  el.append(...nodes.filter(Boolean));
  return el;
};
const modeSelect = (root, label) => all(root).find((x) => x instanceof FakeElement && x.tag === 'select' && (x.attrs['data-key'] === label || x.dataset.key === label));
const optionValues = (sel) => sel.children.filter((c) => c instanceof FakeElement && c.tag === 'option').map((o) => o.attrs.value ?? o.value);
const where = { profiles: [], recommended: null };
const MODES_AS_ROOT = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'];

test('New session as root: the choice of a mode is gone; a terminal start asks first where the default is Bypass', async () => {
  const posts = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => {
    if (o.method === 'POST') posts.push([String(u).split('?')[0], JSON.parse(o.body)]);
    return { ok: true, status: 200, json: async () => ({ name: 't1', id: 'c1' }) };
  };
  try {
    assert.doesNotMatch(await import('node:fs').then((fs) => fs.readFileSync(new URL('../../web/newsession-options.js', import.meta.url), 'utf8')), /MODES|BYPASS_MEANS|permissionMode/, 'no mode to choose in More options');
    const { startSession } = await import('../../web/newsession-start.js');
    const pc = { profiles: [], recommended: 'max', recommendedIn: {}, toolDefaults: {} };
    const go = (way, st) => startSession({ path: '/w/a', name: 'a' }, { st: { m: null, tool: 'claude', ...st }, pc, way, toolName: 'Claude Code', busy() {}, failed: (e) => assert.fail(e.message), leave() {}, picking() {} });
    await go('claude', { rootDefaultBypass: true });
    assert.equal(posts.at(-1)[0], '/api/sessions');
    assert.equal(posts.at(-1)[1].permissionMode, 'manual', 'the mode that asks, which the server accepts as root');
    await go('claude', { rootDefaultBypass: false });
    assert.equal(posts.at(-1)[1].permissionMode, null, 'otherwise the coding tool\'s own');
    await go('chat', { rootDefaultBypass: true });
    assert.equal(posts.at(-1)[0], '/api/chats');
    assert.equal('permissionMode' in posts.at(-1)[1], false, 'an App start leaves it to the server, which gives a person the mode that asks');
  } finally {
    globalThis.fetch = real;
  }
});

test('Settings → New-session defaults as root: the one line, no Bypass to choose, and a Bypass default kept as it is', () => {
  const page = registeredSettingsPages().find((p) => p.id === 'new-sessions');
  const base = { sessionChoices: { permissionModes: MODES_AS_ROOT, efforts: ['low', 'high'], models: [] }, server: { roots: [] }, uploads: { dir: '.uploads', maxMB: 20 }, rootBypass: ROOT_BYPASS_LINE };
  let el = wrap(page.render({ settings: { ...base, sessionDefaults: {} } }));
  let sel = modeSelect(el, undefined) || all(el).find((x) => x instanceof FakeElement && x.tag === 'select');
  assert.ok(text(el).includes(ROOT_BYPASS_LINE));
  assert.ok(!optionValues(sel).includes('bypassPermissions'));
  // His default of before names Bypass: it is shown, marked, and stays chosen (nothing changed silently).
  el = wrap(page.render({ settings: { ...base, sessionDefaults: { permissionMode: 'bypassPermissions' } } }));
  sel = all(el).find((x) => x instanceof FakeElement && x.tag === 'select');
  const opt = sel.children.find((o) => o instanceof FakeElement && (o.attrs.value ?? o.value) === 'bypassPermissions');
  assert.ok(opt, 'kept in the list');
  assert.match(text(opt), /kept from before; refused as root/);
  assert.ok(opt.selected === true || 'selected' in opt.attrs, 'still the chosen one');
  // Not root: no line.
  el = wrap(page.render({ settings: { ...base, rootBypass: null, sessionChoices: { ...base.sessionChoices, permissionModes: [...MODES_AS_ROOT, 'bypassPermissions'] }, sessionDefaults: {} } }));
  assert.ok(!text(el).includes(ROOT_BYPASS_LINE));
});
