// Computers → Add a computer → "Install it there for me" on a root login (web/rootlogin.js, web/computers.js,
// web/sshkey.js), in a small stand-in for the browser's document: the hub's words are shown, the ordinary login with
// sudo is the way recommended, and the sentence typed is what a second install sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const { rootLoginBox, STAY_ROOT_SENTENCE } = await import('../../web/rootlogin.js');
const R = await import('../../src/setup/rootfacts.mjs');

function all(n, out = []) {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
}
const text = (n) => all(n).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ').trim();
const find = (n, pred) => all(n).find((x) => x instanceof FakeElement && pred(x));
const button = (root, label) => find(root, (x) => x.tag === 'button' && text(x) === label);
const input = (root) => find(root, (x) => x.tag === 'input');

test('the box says the hub\'s words, recommends an ordinary login with sudo, and sends the sentence as typed', () => {
  assert.equal(STAY_ROOT_SENTENCE, R.STAY_ROOT_SENTENCE, 'the page and the computer ask for the same sentence');
  const words = `The login root@box2 is root, so nothing was installed there. ${R.ROOT_LOGIN_WHY}`;
  const sent = [];
  const box = rootLoginBox(words, (s) => sent.push(s));
  assert.ok(text(box).includes(words));
  assert.match(text(box), /an ordinary login that has sudo/);
  assert.equal(text(box).split('"keep Hoprig on root"').length - 1, 1, 'the sentence to type is quoted once, at its field');
  assert.match(text(box), /type "keep Hoprig on root"/);
  input(box).value = 'keep Hoprig on root';
  button(box, 'Install on root on purpose').fire('click');
  assert.deepEqual(sent, [{ sentence: 'keep Hoprig on root' }]);
  // A sentence refused by the computer is said under the field.
  assert.match(text(rootLoginBox(words, () => {}, 'Type the sentence "keep Hoprig on root" as it is written')), /as it is written/);
});

test('the box offers first to make the work user there, after a confirmation that names the server', async () => {
  const made = [];
  const box = rootLoginBox('The login root@box2 is root.', () => {}, null, { server: 'box2', makeUser: () => made.push('make') });
  // The defaults on the sheet: the user hoprig, sudo without a password.
  const b = button(box, 'Make the user and set Hoprig up on box2');
  assert.ok(b, text(box));
  const sentence = find(box, (x) => x.tag === 'input' && x.attrs['aria-label'] !== 'The name of the user');
  assert.ok(all(box).indexOf(b) < all(box).indexOf(sentence), 'offered before the sentence');
  // The press opens the sheet; nothing starts until its own button says yes.
  b.fire('click');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(made, [], 'not before the confirmation');
  const where = all(body).find((x) => x instanceof FakeElement && x.tag === 'dialog' && x.open);
  assert.ok(where, 'a confirmation sheet is open');
  assert.match(text(where), /Make an ordinary user on box2\?/);
  assert.match(text(where), /give it sudo without a password through one file in \/etc\/sudoers\.d/);
  assert.match(text(where), /Root's own login is not changed\./);
  button(where, 'Make it on box2').fire('click');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(made, ['make']);
  // Without makeUser (no way for this install): no such button.
  assert.equal(button(rootLoginBox('x', () => {}), 'Make the user and set Hoprig up on this server'), undefined);
});

test('both installs show the box for a root login, and send the sentence with the next install', () => {
  // workUser is his choice from the box ({ name, noAdmin }), sent as it is.
  for (const [file, route, made] of [['computers.js', "'~/api/machines/install', { target, confirm: target, ...(stayRoot ? { stayRoot } : {}), ...(workUser ? { workUser } : {}) }", 'makeUser: (w) => install(target, null, words, w || true)'], ['sshkey.js', "'~/api/machines/ssh/key/install', { pending, confirm: s.name, ...(stayRoot ? { stayRoot } : {}), ...(workUser ? { workUser } : {}) }", 'makeUser: (w) => install(pending, s, null, words, w || true)']]) {
    const src = fs.readFileSync(path.join(WEB, file), 'utf8');
    assert.ok(src.includes(route), `${file} sends the sentence and his choices`);
    assert.ok(src.includes(made), `${file} hands the box's choice to the install`);
    assert.match(src, /e\.code === 'root-login'[^\n]*rootLoginBox\(/, `${file} shows the box`);
  }
});

test('on the same screen he chooses the user\'s name and whether it gets administrator rights; both are sent', async () => {
  const made = [];
  const box = rootLoginBox('The login root@box2 is root.', () => {}, null, { server: 'box2', makeUser: (w) => made.push(w) });
  const name = find(box, (x) => x.tag === 'input' && x.attrs['aria-label'] === 'The name of the user');
  const admin = find(box, (x) => x.tag === 'select');
  assert.ok(name && admin, text(box));
  assert.equal(name.value, 'hoprig', 'the default name is filled in');
  assert.match(text(admin), /sudo without a password, as cloud servers give their first user/);
  assert.match(text(admin), /no administrator rights/);
  assert.doesNotMatch(text(box), /--no-admin/, 'no flag on a page');
  // A name that is not one: said, nothing opens.
  name.value = 'Alex Smith';
  button(box, 'Make the user and set Hoprig up on box2').fire('click');
  await new Promise((r) => setImmediate(r));
  assert.match(text(box), /A user name is small letters/);
  assert.deepEqual(made, []);
  name.value = 'alex';
  admin.value = 'none';
  button(box, 'Make the user and set Hoprig up on box2').fire('click');
  await new Promise((r) => setImmediate(r));
  const where = all(body).find((x) => x instanceof FakeElement && x.tag === 'dialog' && x.open);
  assert.match(text(where), /make the user alex \(no password\).*give it no administrator rights/);
  button(where, 'Make it on box2').fire('click');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(made, [{ name: 'alex', noAdmin: true }]);
});
