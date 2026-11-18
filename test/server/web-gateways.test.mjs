// Settings → Add-ons with its "Add a gateway" sheet (web/addons.js, web/gatewaydefine.js), driven in a small stand-in
// for the browser's document: the question is asked in the form's own sheet, nothing typed is lost, an error after
// the yes is said, the focus lands where a keyboard user can go on, and another computer's page offers no add or remove.
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

// The computer: `answers[path]` is a value or a function of the request's body; { __status, error, ... } is a refusal.
const answers = {};
const calls = [];
globalThis.fetch = async (u, o = {}) => {
  const b = o.body ? JSON.parse(o.body) : null;
  calls.push([u, b]);
  let data = answers[u.split('?')[0]];
  if (typeof data === 'function') data = data(b);
  if (data && data.__status) {
    const { __status, ...rest } = data;
    return { ok: false, status: __status, json: async () => rest };
  }
  return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data || {} };
};

const { defineGatewaySheet, removeGateway } = await import('../../web/gatewaydefine.js');
await import('../../web/addons.js');
const { registeredSettingsPages } = await import('../../web/registry.js');
const addonsPage = registeredSettingsPages().find((p) => p.id === 'addons');

function all(n, out = []) {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
}
const text = (n) => all(n).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ').trim();
const find = (n, pred) => all(n).find((x) => x instanceof FakeElement && pred(x));
const settle = () => new Promise((r) => realTimeout(r, 20));
const sheet = () => body.children.find((c) => c.tag === 'dialog');
const hidden = (el) => (el.hidden !== undefined ? el.hidden === true : 'hidden' in el.attrs);
const shown = (el) => { for (let p = el; p; p = p.parent) if (hidden(p)) return false; return true; };
const button = (root, label) => find(root, (x) => x.tag === 'button' && text(x) === label && shown(x));
const inputOf = (root, label) => {
  const row = find(root, (x) => x.classList.contains('fieldrow') && text(find(x, (y) => y.classList.contains('field-label'))) === label);
  return find(row, (x) => x.tag === 'input');
};
const toasts = () => all(body).filter((x) => x instanceof FakeElement && x.classList.contains('toast')).map(text);

const RELAY = { 'Name': 'Relay', 'Program': '/opt/relay/bin/relay', 'Port': '7777', 'Arguments': '--listen=127.0.0.1:PORT' };
function type(root, fields) {
  for (const [label, v] of Object.entries(fields)) {
    const i = inputOf(root, label);
    i.value = v;
    i.fire('input');
  }
}
const QUESTION = { ok: false, confirm: 'Relay is a program Hoprig will run on this computer.', runs: ['When it starts, Hoprig runs:', '  /opt/relay/bin/relay --listen=127.0.0.1:7777'], pin: { bin: '/opt/relay/bin/relay', sha256: 'a'.repeat(64) } };

test('Add a gateway: the question is asked in the same sheet; Back brings the form back as it was typed; the focus starts on Name', async () => {
  answers['/api/gateways/defined/add'] = (b) => (b.confirmed ? { ok: true, id: 'relay' } : QUESTION);
  let drawn = 0;
  const closed = defineGatewaySheet(() => drawn++);
  const d = sheet();
  assert.equal(d.open, true);
  assert.equal(document.activeElement, inputOf(d, 'Name'), 'the focus starts on Name, not on Close');
  type(d, RELAY);
  button(d, 'Check').fire('click');
  await settle();
  assert.equal(d.open, true, 'the sheet stays open');
  assert.match(text(d), /Let Hoprig run Relay\?.*Relay is a program Hoprig will run.*\/opt\/relay\/bin\/relay --listen=127\.0\.0\.1:7777/);
  assert.equal(button(d, 'Check'), undefined, 'the form makes way for the question');
  assert.match(document.activeElement.className, /gw-ask-title/, 'the focus is on the question');
  // Back: the form again, with everything that was typed in it.
  button(d, 'Back').fire('click');
  assert.ok(button(d, 'Check'), 'the form is back');
  assert.equal(button(d, 'Add gateway'), undefined);
  for (const [label, v] of Object.entries(RELAY)) assert.equal(inputOf(d, label).value, v, `${label} kept`);
  assert.equal(inputOf(d, 'Short name').value, 'relay');
  assert.equal(document.activeElement, button(d, 'Check'));
  // Check again and say yes: the pin it was shown goes with the yes; then the list is drawn again.
  button(d, 'Check').fire('click');
  await settle();
  button(d, 'Add gateway').fire('click');
  await settle();
  assert.deepEqual(calls.at(-1)[1], { definition: { id: 'relay', title: 'Relay', port: 7777, bin: '/opt/relay/bin/relay', args: ['--listen=127.0.0.1:PORT'] }, confirmed: true, pin: QUESTION.pin });
  assert.equal(await closed, true);
  assert.equal(drawn, 1);
  assert.ok(toasts().includes('Relay added'));
});

test('Add a gateway: a refusal after the yes is said, the list is drawn again, and the form is back with the reason', async () => {
  answers['/api/gateways/defined/add'] = (b) => (b.confirmed ? { __status: 400, error: 'there is a gateway "relay" already', field: 'id', hint: 'there is a gateway "relay" already' } : QUESTION);
  let drawn = 0;
  defineGatewaySheet(() => drawn++);
  const d = sheet();
  type(d, RELAY);
  button(d, 'Check').fire('click');
  await settle();
  button(d, 'Add gateway').fire('click');
  await settle();
  assert.equal(d.open, true, 'nothing closes on a refusal');
  assert.ok(toasts().some((t) => /There is a gateway "relay" already/.test(t)), toasts().join(' | '));
  assert.equal(drawn, 1, 'the list is drawn again: another tab may have added it');
  assert.ok(button(d, 'Check'), 'the form is back');
  assert.equal(inputOf(d, 'Program').value, RELAY.Program, 'with what was typed');
  assert.match(text(d), /Short name: there is a gateway "relay" already/, 'the reason under its field');
  assert.equal(document.activeElement, inputOf(d, 'Short name'));
  d.close();
});

test('Remove: after it, the focus is on Add a gateway (the row it was on is gone)', async () => {
  answers['/api/addons'] = { addons: [{ id: 'trouteai', title: 'TRouteAI', summary: 'A gateway', installed: true, running: false }, { id: 'relay', title: 'Relay', summary: 'Yours', installed: true, running: false, defined: true, installable: false, command: ['/opt/relay/bin/relay', '--port', '7777'] }] };
  answers['/api/gateways/defined/remove'] = (b) => (b.confirmed ? { ok: true } : { ok: false, confirm: 'Relay is stopped and forgotten.' });
  events.length = 0;
  const root = new FakeElement('div');
  root.append(...addonsPage.render({ isAlive: () => true, here: true }).filter(Boolean));
  await settle();
  assert.deepEqual(events, [], 'the first drawing changes nothing in the Settings list');
  button(root, 'Remove').fire('click');
  await settle();
  button(sheet(), 'Remove').fire('click');
  await settle();
  await settle();
  assert.equal(document.activeElement, button(root, 'Add a gateway'));
  assert.ok(events.includes('saved'), 'the Settings list\'s line under Add-ons is drawn again');
});

test('another computer\'s Add-ons page: no Add a gateway and no Remove, one line that says where', async () => {
  const root = new FakeElement('div');
  root.append(...addonsPage.render({ isAlive: () => true, here: false }).filter(Boolean));
  await settle();
  assert.match(text(root), /Relay/, 'its gateways are listed');
  assert.equal(button(root, 'Add a gateway'), undefined);
  assert.equal(button(root, 'Remove'), undefined);
  assert.match(text(root), /A gateway of your own is added or removed on that computer's own dashboard, or with hoprig gateways add in its terminal\./);
  // This computer's own page still has both.
  const own = new FakeElement('div');
  own.append(...addonsPage.render({ isAlive: () => true, here: true }).filter(Boolean));
  await settle();
  assert.ok(button(own, 'Add a gateway'));
  assert.ok(button(own, 'Remove'));
});

test('the remove question\'s Cancel changes nothing', async () => {
  answers['/api/gateways/defined/remove'] = (b) => (b.confirmed ? { ok: true } : { ok: false, confirm: 'Relay is stopped and forgotten.' });
  let drawn = 0;
  const n = calls.length;
  const p = removeGateway({ id: 'relay', title: 'Relay' }, () => drawn++);
  await settle();
  button(sheet(), 'Cancel').fire('click');
  await p;
  assert.equal(drawn, 0);
  assert.equal(calls.slice(n).some(([, b]) => b && b.confirmed), false);
});

test('a gateway whose program moved: "Program moved" with Confirm the new program; one added before the typed program was kept names the command instead', async () => {
  const row = (needsConfirm) => ({ id: 'relay', title: 'Relay', summary: 'Yours', installed: false, running: false, defined: true, installable: false, needsConfirm, command: ['/opt/relay-1/relay', '--port', '7777'] });
  answers['/api/addons'] = { addons: [row('gone')] };
  let root = new FakeElement('div');
  root.append(...addonsPage.render({ isAlive: () => true, here: true }).filter(Boolean));
  await settle();
  assert.match(text(root), /Program moved/);
  assert.doesNotMatch(text(root), /Not installed|Its program was not found/);
  assert.ok(button(root, 'Confirm the new program'));
  assert.match(text(root), /Its program is not where you confirmed it any more \(an update may have moved it\)/);
  answers['/api/addons'] = { addons: [row('gone-old')] };
  root = new FakeElement('div');
  root.append(...addonsPage.render({ isAlive: () => true, here: true }).filter(Boolean));
  await settle();
  assert.match(text(root), /Program moved/);
  assert.equal(button(root, 'Confirm the program'), undefined, 'no button that could only fail');
  assert.equal(button(root, 'Confirm the new program'), undefined);
  assert.match(text(root), /In this computer's terminal: hoprig gateways confirm relay --program <path>/);
});

test('a gateway in config.json that was not loaded: its warning line has Remove, through the same question and route; none without an id or on another computer', async () => {
  answers['/api/addons'] = { addons: [{ id: 'trouteai', title: 'TRouteAI', summary: 'A gateway', installed: true, running: false }], skipped: [{ at: 0, id: 'relay-hand', error: 'the arguments use only letters' }, { at: 1, id: null, error: 'a gateway is an object' }] };
  answers['/api/gateways/defined/remove'] = (b) => (b.confirmed ? { ok: true } : { ok: false, confirm: 'The gateway relay-hand is taken out of config.json. It was not loaded (the arguments use only letters), so Hoprig does not stop it.' });
  const root = new FakeElement('div');
  root.append(...addonsPage.render({ isAlive: () => true, here: true }).filter(Boolean));
  await settle();
  const banners = all(root).filter((x) => x instanceof FakeElement && x.classList.contains('banner'));
  assert.equal(banners.length, 2);
  assert.match(text(banners[0]), /A gateway in config\.json \(relay-hand\) was not loaded: the arguments use only letters\./);
  assert.ok(button(banners[0], 'Remove'), 'the line of one with an id offers Remove');
  assert.equal(button(banners[1], 'Remove'), undefined, 'one without an id cannot be named: no Remove');
  const n = calls.length;
  button(banners[0], 'Remove').fire('click');
  await settle();
  assert.deepEqual(calls[n], ['/api/gateways/defined/remove', { id: 'relay-hand' }], 'the question first');
  assert.match(text(sheet()), /Remove relay-hand\?.*taken out of config\.json\. It was not loaded/);
  button(sheet(), 'Remove').fire('click');
  await settle();
  await settle();
  assert.ok(calls.slice(n).some(([u, b]) => u === '/api/gateways/defined/remove' && b && b.id === 'relay-hand' && b.confirmed === true), 'then the yes, by the same route');
  assert.equal(document.activeElement, button(root, 'Add a gateway'), 'drawn again, the focus on Add a gateway');
  const other = new FakeElement('div');
  other.append(...addonsPage.render({ isAlive: () => true, here: false }).filter(Boolean));
  await settle();
  assert.equal(button(other, 'Remove'), undefined, 'another computer\'s page offers no Remove');
});
