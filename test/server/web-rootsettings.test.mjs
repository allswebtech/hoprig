// Settings → Runs as root (web/rootsettings.js), driven in a small stand-in for the browser's document: shown only as
// root; not on purpose it says why and offers the move and the sentence; the typed sentence is sent as typed and the
// page then says it is kept and asks nothing; inside a container no sentence is asked and the one line is said.
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

// The computer: `answers[path]` is a value or a function of the request's body; { __status, error } is a refusal.
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

await import('../../web/rootsettings.js');
const { registeredSettingsPages } = await import('../../web/registry.js');
const page = registeredSettingsPages().find((p) => p.id === 'root');
const { ROOT_LIMITS } = await import('../../src/setup/rootfacts.mjs');

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
const button = (root, label) => find(root, (x) => x.tag === 'button' && text(x) === label);
const inputOf = (root, label) => {
  const row = find(root, (x) => x.classList.contains('fieldrow') && text(find(x, (y) => y.classList.contains('field-label'))) === label);
  return row && find(row, (x) => x.tag === 'input');
};
const view = (over = {}) => ({ container: [], stay: false, onPurpose: false, sentence: 'keep Hoprig on root', limits: ROOT_LIMITS, ...over });
const draw = (root) => {
  const el = new FakeElement('div');
  el.append(...page.render({ settings: { root } }));
  return el;
};

test('the page is there only where Hoprig runs as root', () => {
  assert.ok(page, 'registered');
  assert.equal(page.when({ settings: { root: null } }), false);
  assert.equal(page.when({ settings: { root: view() } }), true);
  assert.equal(page.summary({ settings: { root: view() } }), 'Move it to an ordinary user');
  assert.equal(page.summary({ settings: { root: view({ stay: true, onPurpose: true }) } }), 'Kept on root by your choice');
  assert.equal(page.summary({ settings: { root: view({ container: ['/.dockerenv'], onPurpose: true }) } }), 'On purpose: inside a container');
});

test('as root not on purpose: why, the move\'s command, and the sentence; the sentence is sent as typed and then the page asks nothing', async () => {
  const el = draw(view());
  assert.match(text(el), /Hoprig runs as root on this computer\. Claude Code refuses bypass permissions mode for root/);
  assert.match(text(el), /hoprig move-to-user/);
  const typed = inputOf(el, 'Type "keep Hoprig on root"');
  assert.ok(typed, 'the sentence field');
  // A wrong sentence: the computer's refusal is said, and the field stays.
  answers['/api/settings'] = { __status: 400, error: 'type the sentence "keep Hoprig on root" as it is written' };
  typed.value = 'keep it';
  button(el, 'Keep it on root').fire('click');
  await settle();
  assert.deepEqual(calls.at(-1), ['/api/settings', { stayRoot: { sentence: 'keep it' } }]);
  assert.match(text(el), /Type the sentence "keep Hoprig on root"/);
  assert.ok(inputOf(el, 'Type "keep Hoprig on root"'));
  // The sentence: kept; the page now says so, says once what does not work as root, and asks for nothing.
  answers['/api/settings'] = (b) => ({ root: view({ stay: b.stayRoot !== false, onPurpose: b.stayRoot !== false }) });
  typed.value = 'keep Hoprig on root';
  button(el, 'Keep it on root').fire('click');
  await settle();
  assert.deepEqual(calls.at(-1), ['/api/settings', { stayRoot: { sentence: 'keep Hoprig on root' } }]);
  assert.match(text(el), /Kept on root by your choice/);
  assert.ok(text(el).includes(`What does not work as root: ${ROOT_LIMITS}.`));
  assert.equal(inputOf(el, 'Type "keep Hoprig on root"'), undefined, 'no sentence asked any more');
  assert.doesNotMatch(text(el), /Hoprig runs as root on this computer\./, 'no warning banner');
  // Taken back: the move and the sentence are offered again.
  button(el, 'Take the choice back').fire('click');
  await settle();
  assert.deepEqual(calls.at(-1), ['/api/settings', { stayRoot: false }]);
  assert.ok(inputOf(el, 'Type "keep Hoprig on root"'));
});

test('inside a container: on purpose with its fact named, the one line, no sentence and no banner', () => {
  const el = draw(view({ container: ['/run/.containerenv'], onPurpose: true }));
  assert.match(text(el), /Inside a container \(\/run\/\.containerenv\)/);
  assert.ok(text(el).includes(`What does not work as root: ${ROOT_LIMITS}.`));
  assert.equal(inputOf(el, 'Type "keep Hoprig on root"'), undefined);
  assert.doesNotMatch(text(el), /move-to-user|Hoprig runs as root on this computer\./);
});

test('the move: the look only on a press; the user, what runs, what is copied and the steps; the button is off while the look says stop', async () => {
  const plan = {
    ok: true, stops: [], user: { name: 'hoprig', home: '/home/hoprig' },
    parts: [{ id: 'workspace', what: 'the workspace', from: '/root/Workspace', to: '/home/hoprig/Workspace', entries: 88199, bytes: 2.9e9 }],
    total: { entries: 88199, bytes: 2.9e9 }, free: 4e10,
    running: { working: [], idle: [], terminals: [{ socket: '/tmp/tmux-0/default', session: 'shop' }], work: 0, assistant: 0 },
    admin: [{ id: 'linger', why: "keep hoprig's dashboard running without a login", argv: ['loginctl', 'enable-linger', 'hoprig'] }],
  };
  answers['/api/move'] = { root: true, server: 'box2', plan, job: null };
  calls.length = 0;
  const el = draw(view());
  assert.ok(!calls.some(([u]) => u === '/api/move'), 'no look before the press');
  button(el, 'Show what the move does').fire('click');
  await settle();
  const t = text(el);
  assert.match(t, /Hoprig moves from root to the user hoprig \(home \/home\/hoprig\)/);
  assert.match(t, /Terminals of root: shop \(ended after the switch, each by its own socket and session\)/);
  assert.match(t, /the workspace: \/root\/Workspace → \/home\/hoprig\/Workspace ?, 88199 entries, 2\.9 GB/);
  assert.match(t, /loginctl enable-linger hoprig/);
  assert.equal(button(el, 'Move to hoprig').attrs.disabled ?? button(el, 'Move to hoprig').disabled ?? false, false);
  answers['/api/move'] = { root: true, server: 'box2', plan: { ...plan, ok: false, stops: ['a session is working now (shop (working)): end it first, then run the move again'] }, job: null };
  const el2 = draw(view());
  button(el2, 'Show what the move does').fire('click');
  await settle();
  assert.match(text(el2), /a session is working now/);
  const b = button(el2, 'Move to hoprig');
  assert.ok(b.disabled === true || 'disabled' in b.attrs, 'the button is off');
});

test('the move\'s look says when it makes the user first, and when it goes on from an earlier copy of its own', async () => {
  const plan = {
    ok: true, stops: [], make: true, again: { at: '2026-11-20T10:00:00.000Z', switchedAt: null }, user: { name: 'hoprig', home: '/home/hoprig' },
    parts: [], total: { entries: 0, bytes: 0 }, free: 4e10,
    running: { working: [], idle: [], terminals: [], work: 0, assistant: 0 },
    admin: [{ id: 'make-user', why: 'make the user hoprig with no password (the installer of this Hoprig)', argv: ['useradd', '--create-home', '--comment', 'Hoprig work user', 'hoprig'] }],
    network: { hosts: ['registry.npmjs.org', 'nodejs.org'], line: "The user hoprig's own install needs the network (Node.js and the packages come from there): registry.npmjs.org and nodejs.org. The move checks them before it makes or copies anything." },
  };
  answers['/api/move'] = { root: true, server: 'box2', plan, job: null };
  const el = draw(view());
  button(el, 'Show what the move does').fire('click');
  await settle();
  const t = text(el);
  assert.match(t, /Hoprig moves from root to a new user hoprig ?, made by the move first \(home \/home\/hoprig\): an ordinary user with sudo and the key you use for root\. Root's own login is not changed\./);
  assert.match(t, /An earlier move to hoprig began a copy and did not switch: that copy is taken away first and made again\./);
  // A copy whose switch stopped root's dashboard, then went back: set aside, never "taken away".
  answers['/api/move'] = { root: true, server: 'box2', plan: { ...plan, again: { ...plan.again, used: true } }, job: null };
  const used = draw(view());
  button(used, 'Show what the move does').fire('click');
  await settle();
  assert.match(text(used), /An earlier move to hoprig switched already: its copy is set aside beside it and made again from root's\./);
  assert.doesNotMatch(text(used), /that copy is taken away/);
  answers['/api/move'] = { root: true, server: 'box2', plan, job: null };
  assert.match(t, /useradd --create-home --comment 'Hoprig work user' hoprig/);
  // Before the yes, as on the command line: the user's install needs the network, after the administrator steps.
  assert.ok(t.indexOf("The user hoprig's own install needs the network (Node.js and the packages come from there): registry.npmjs.org and nodejs.org. The move checks them before it makes or copies anything.") > t.indexOf('useradd'), t);
  // A flag in a step's words is one piece that does not wrap (it broke at its hyphen in a browser).
  const sudo = { ...plan, admin: [{ id: 'sudoers', why: 'administrator rights (checked by visudo; --no-admin for none)', argv: null }] };
  answers['/api/move'] = { root: true, server: 'box2', plan: sudo, job: null };
  const el2 = draw(view());
  button(el2, 'Show what the move does').fire('click');
  await settle();
  assert.ok(all(el2).some((x) => x instanceof FakeElement && x.tag === 'code' && text(x) === '--no-admin'), text(el2));
});

test('right after "Move it", a job with no result yet is shown as running, never as "The move stopped"', async () => {
  const { jobParts } = await import('../../web/moveuser.js');
  const out = new FakeElement('pre');
  const box = new FakeElement('div');
  // What GET /api/move/job answers before the detached process wrote its first line.
  box.append(...jobParts({ running: false, lines: [], result: null }, out));
  assert.match(text(box), /The move runs\./);
  assert.doesNotMatch(text(box), /The move stopped/);
  const box2 = new FakeElement('div');
  box2.append(...jobParts({ running: false, lines: ['x'], result: { ok: false, lost: true } }, out));
  assert.match(text(box2), /The move stopped/);
});

test("the hub's move: a move that runs there is followed, on open and after a press another tab was first to", async () => {
  const { hubMoveBox } = await import('../../web/moveuser.js');
  const base = '/api/machines/box2/move';
  const running = { running: true, lines: ['Copying 47 entries (27 KB) to /home/hoprig…'], next: 1, result: null };
  const ended = { running: false, lines: ['Copying 47 entries (27 KB) to /home/hoprig…'], next: 1, result: { ok: true, switched: true, target: 'hoprig@box2.example.com' } };
  // Opened while the move runs (another tab started it): its lines and "runs", no look and no button to press again.
  answers[`${base}/job`] = running;
  const el = new FakeElement('div');
  el.append(hubMoveBox('box2', 'box2'));
  await settle();
  assert.match(text(el), /Copying 47 entries/);
  assert.match(text(el), /The move runs on box2\./);
  assert.equal(button(el, 'Move to hoprig'), undefined);
  answers[`${base}/job`] = ended;
  await new Promise((r) => realTimeout(r, 1600)); // its next ask: the end
  assert.match(text(el), /Done\. This main computer now reaches box2 as hoprig@box2\.example\.com\./);
  // No move runs at the open: the look and its button. The press is refused, because another tab's press came first.
  answers[`${base}/job`] = { running: false, lines: [], next: 0, result: null };
  const plan = {
    ok: true, stops: [], make: false, user: { name: 'hoprig', home: '/home/hoprig' }, parts: [], total: { entries: 0, bytes: 0 }, free: 4e10,
    running: { working: [], idle: [], terminals: [], work: 0, assistant: 0 }, admin: [],
  };
  answers[base] = (b) => (b ? (answers[`${base}/job`] = running, { __status: 409, error: 'the move there is running already' }) : { plan, error: null });
  const el2 = new FakeElement('div');
  el2.append(hubMoveBox('box2', 'box2'));
  await settle();
  button(el2, 'Show what the move does').fire('click');
  await settle();
  button(el2, 'Move to hoprig').fire('click');
  await settle();
  const sheet = body.children.find((n) => n.tag === 'dialog' && n.open);
  assert.ok(sheet, 'the sheet that asks for the name');
  find(sheet, (x) => x.tag === 'input').value = 'box2';
  find(sheet, (x) => x.tag === 'form').fire('submit');
  await settle();
  assert.match(text(el2), /Copying 47 entries/);
  assert.match(text(el2), /The move runs on box2\./);
  assert.doesNotMatch(text(el2), /running already/, 'no red line under a button that would only be refused');
  assert.equal(button(el2, 'Move to hoprig'), undefined);
  answers[`${base}/job`] = ended; // its polling ends
  await new Promise((r) => realTimeout(r, 1600));
});
