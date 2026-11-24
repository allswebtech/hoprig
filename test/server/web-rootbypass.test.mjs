// As root, where a person chooses the mode (New session → Options, Settings → New-session defaults), Bypass is not
// offered, ONE plain line quotes the coding tool's refusal and says what to do, and a default that names Bypass is
// kept as it is (never changed silently) while the sheet preselects the mode that asks. Driven in a small stand-in for
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
const { optionsFor } = await import('../../web/newsession-options.js');
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

test('New session → Options as root: no Bypass, the root line under the choice, and a Bypass default gets the mode that asks', () => {
  const st = { tool: 'claude', profile: '', permissionMode: '', effort: '', model: '', conversation: 'new', plain: false, modes: MODES_AS_ROOT, rootBypass: ROOT_BYPASS_LINE, rootDefaultBypass: true };
  const el = wrap(optionsFor({ st, where, run: 'claude', info: null, toolName: 'Claude Code', onplain: () => {} }));
  const sel = modeSelect(el, 'What Claude Code may do without asking');
  assert.ok(sel, 'the mode choice');
  assert.ok(!optionValues(sel).includes('bypassPermissions'), 'not offered');
  assert.equal(st.permissionMode, 'manual', 'the mode that asks is preselected');
  assert.ok(text(el).includes(ROOT_BYPASS_LINE), 'the one line says why');
  // A default that does not name Bypass: nothing is preselected, and the line still says why it is missing.
  const st2 = { ...st, permissionMode: '', rootDefaultBypass: false };
  const el2 = wrap(optionsFor({ st: st2, where, run: 'claude', info: null, toolName: 'Claude Code', onplain: () => {} }));
  assert.equal(st2.permissionMode, '');
  assert.ok(text(el2).includes(ROOT_BYPASS_LINE));
  // Not root: as before, no line.
  const st3 = { ...st, permissionMode: '', modes: [...MODES_AS_ROOT, 'bypassPermissions'], rootBypass: null, rootDefaultBypass: false };
  const el3 = wrap(optionsFor({ st: st3, where, run: 'claude', info: null, toolName: 'Claude Code', onplain: () => {} }));
  assert.ok(!text(el3).includes(ROOT_BYPASS_LINE));
  assert.ok(optionValues(modeSelect(el3, 'What Claude Code may do without asking')).includes('bypassPermissions'));
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
