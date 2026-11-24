// The composer's Send, without a browser: a message on its way is sent once. The page itself is proven in a real
// browser; here the part that decides whether a second tap or Enter sends the same message again.
import assert from 'node:assert/strict';
import test from 'node:test';

// A small stand-in for the browser DOM: what lib.js's h/fill and the composer use.
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: { setProperty() {} }, attrs: {}, children: [], listeners: {}, value: '', disabled: false, scrollHeight: 20 });
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(k, fn) {
    (this.listeners[k] ||= []).push(fn);
  }
  fire(k, e = {}) {
    for (const fn of this.listeners[k] || []) fn({ preventDefault() {}, stopPropagation() {}, currentTarget: this, ...e });
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  focus() {}
  click() {}
  setSelectionRange() {}
  querySelector() {
    return new FakeElement('span');
  }
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  scrollIntoView() {}
  dispatchEvent(e) {
    this.fire(e.type);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
globalThis.Node = FakeNode;
globalThis.innerHeight = 844;
globalThis.innerWidth = 1440;
const kept = new Map(); // the draft and the sent list (prefs); defined, so newer Node's own localStorage is not asked
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) } });
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new FakeElement('body'),
  activeElement: null,
  visibilityState: 'visible',
};
const byClass = (n, c) => (n instanceof FakeText ? [] : [...(n.className.split(' ').includes(c) ? [n] : []), ...n.children.flatMap((x) => byClass(x, c))]);

// POST /send is held until the test lets it go; every call is counted.
const posts = [];
let release = () => {};
globalThis.fetch = async (u, o) => {
  if (String(u).endsWith('/send')) {
    posts.push(JSON.parse(o.body));
    await new Promise((r) => (release = r));
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { createComposer } = await import('../../web/chat/composer.js');
const idle = { id: 'c1', tool: 'opencode', queue: [], choices: { models: [], efforts: [], modes: ['default'] }, usage: {} };

test('Send: a message on its way is sent once, even when a state update of the chat comes in meanwhile', async () => {
  const c = createComposer({ A: '/api/chats/c1', id: 'c1', stop() {}, compact() {}, own: () => [] });
  const send = byClass(c.el, 'chat-send')[0];
  c.paint(idle);
  c.textarea.value = 'hello once';
  c.textarea.fire('input');
  assert.equal(send.disabled, false);

  send.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1);
  assert.equal(send.disabled, true, 'disabled while the message is on its way');

  c.paint({ ...idle, effort: 'high' }); // the chat's state changes (a setting, a turn's progress)
  assert.equal(send.disabled, true, 'a state update keeps it disabled: the box still holds the same text');
  send.fire('click');
  c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1, 'neither a second tap nor Enter sends it again');

  release();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(send.disabled, false, 'Send is back once the POST returned');
  assert.equal(c.textarea.value, '', 'the box is emptied');
  assert.deepEqual(posts, [{ text: 'hello once' }]);

  c.paint({ ...idle, toolOff: true });
  assert.equal(send.disabled, true, 'read only still disables Send');
  c.paint({ ...idle, terminal: { id: 't1' } });
  assert.equal(send.disabled, true, 'a terminal that runs the conversation disables Send too');
  c.paint(idle);
  assert.equal(send.disabled, false);
});

test('a queued message\'s row says its words and its files by name, never a raw "@.uploads/…" path, also in its Remove label', () => {
  const c = createComposer({ A: '/api/chats/c1', id: 'c1', stop() {}, compact() {}, own: () => [] });
  const q = { id: 'q1', state: 'waiting', text: 'look at this\n\n@.uploads/20301117-164344-753d-notes.txt', attachments: [{ type: 'image', name: '20301117-164344-a1b2-screen.png', mime: 'image/png' }] };
  c.paint({ ...idle, queue: [q] });
  const row = byClass(c.el, 'chat-queued')[0];
  assert.ok(row, 'the queued row');
  const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
  const text = said(byClass(row, 'chat-queued-text')[0]).join('|');
  assert.equal(text, 'look at this|screen.png|notes.txt', 'its words, then its files by name');
  const label = byClass(row, 'chat-unqueue')[0].attrs['aria-label'];
  assert.equal(label, 'Take back the message: look at this (screen.png, notes.txt)', 'the desktop app\'s words: a message sent while Claude works, taken back before it is read');
  assert.doesNotMatch(`${text} ${label}`, /\.uploads|@/, 'no upload path anywhere');
});

test('the page is left while the microphone listens: the composer\'s destroy stops it, so no word reaches the box or its draft', () => {
  let rec = null;
  globalThis.window ||= {};
  globalThis.window.webkitSpeechRecognition = class {
    constructor() {
      rec = this;
    }
    start() {
      this.on = true;
    }
    abort() {
      this.on = false;
      this.onerror?.({ error: 'aborted' });
      this.onend?.();
    }
  };
  try {
    const c = createComposer({ A: '/api/chats/c2', id: 'c2', stop() {}, compact() {}, own: () => [] });
    c.paint(idle);
    byClass(c.el, 'voice-btn')[0].fire('click');
    assert.equal(rec.on, true, 'listening');
    c.destroy();
    assert.equal(rec.on, false, 'the recognition is aborted with the page');
    assert.equal(rec.onresult, null, 'and nothing it hears later reaches the box');
  } finally {
    delete globalThis.window.webkitSpeechRecognition;
  }
});

test('"!" lines: a second one while one runs stays in the box; a slash command goes alone and the runs wait for the next message', async () => {
  const before = globalThis.fetch;
  const sends = [];
  let shellDone = () => {};
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.endsWith('/shell') && o && o.method === 'POST') {
      await new Promise((r) => (shellDone = r));
      return { ok: true, status: 200, json: async () => ({ code: 0, output: 'ok\n', cut: false, timedOut: false }) };
    }
    if (url.endsWith('/send')) sends.push(JSON.parse(o.body).text);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const c = createComposer({ A: '/api/chats/c2', id: 'c2', stop() {}, compact() {}, own: () => [] });
    c.paint(idle);
    const enter = () => c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    c.textarea.value = '!sleep 3';
    enter();
    await tick();
    c.textarea.value = '!echo second';
    enter();
    await tick();
    assert.equal(c.textarea.value, '!echo second', 'not wiped: it runs once the first has ended');
    shellDone();
    await tick();
    await tick();
    c.textarea.value = '/compact keep the tests';
    enter();
    await tick();
    await tick();
    assert.deepEqual(sends, ['/compact keep the tests'], 'the slash command stays a command');
    c.textarea.value = 'and now';
    enter();
    await tick();
    await tick();
    assert.match(sends[1], /^I ran this command in the session's folder:\n\$ sleep 3\n[\s\S]*\n\nand now$/, 'the run goes with the next plain message');
  } finally {
    globalThis.fetch = before;
  }
});

test('Claude Code\'s argument forms of the page\'s commands: /model sonnet, /effort high, /branch name, /fork prompt are done by the page, never sent as text', async () => {
  const { ownSlash } = await import('../../web/chat/popovers.js');
  const own = [{ name: 'model', run() {}, arg() {} }, { name: 'fork', run() {}, arg() {} }, { name: 'compact', run() {} }];
  assert.deepEqual([ownSlash('/model sonnet', own).cmd.name, ownSlash('/model sonnet', own).arg], ['model', 'sonnet']);
  assert.equal(ownSlash('/fork  write the tests  ', own).arg, 'write the tests');
  assert.equal(ownSlash('/fork', own).arg, '');
  assert.equal(ownSlash('/compact keep the tests', own), null, '/compact is Claude Code\'s own and a message: sent');
  assert.equal(ownSlash('/review this', own), null, 'a coding tool\'s command: sent');
  assert.equal(ownSlash('say /model', own), null);
  const before = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u, o) => {
    calls.push([String(u).replace(/^.*\/api\/chats\/c3/, ''), o && o.body ? JSON.parse(o.body) : null]);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const did = [];
    let c = null;
    c = createComposer({ A: '/api/chats/c3', id: 'c3', stop() {}, compact() {}, own: () => [
      { name: 'model', run: () => did.push('model menu'), arg: (t) => c.setChoice('model', t) },
      { name: 'effort', run: () => did.push('effort menu'), arg: (t) => c.setChoice('effort', t) },
      { name: 'fork', run: () => did.push('fork'), arg: (t) => did.push(`fork: ${t}`) },
    ] });
    c.paint({ ...idle, choices: { models: ['opus', 'sonnet'], efforts: ['low', 'high'], modes: ['default'] } });
    const type = async (t) => {
      c.textarea.value = t;
      c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    };
    await type('/model sonnet');
    await type('/effort High');
    await type('/effort auto');
    await type('/fork write the tests');
    // A name the chat does not offer is refused, and the line stays in the box (also a sentence that starts with /model).
    for (const t of ['/model gpt-9', '/model is wrong in config.js, please fix', '/effort max please']) {
      await type(t);
      assert.equal(c.textarea.value, t, `refused, kept in the box: ${t}`);
    }
    await type('/model');
    assert.deepEqual(calls.filter(([u]) => u === '/settings').map(([, b]) => b), [{ model: 'sonnet' }, { effort: 'high' }, { effort: null }], 'the chips\' own route; an unknown name is refused');
    assert.deepEqual(did, ['fork: write the tests', 'model menu']);
    assert.equal(calls.filter(([u]) => u === '/send').length, 0, 'nothing went to the coding tool as text');
    assert.equal(c.textarea.value, '', 'a command done empties the box');
  } finally {
    globalThis.fetch = before;
  }
});

test('a "!" line or one of the page\'s own / commands sent while the microphone listens stops it, as a message does', async () => {
  let rec = null;
  globalThis.window ||= {};
  globalThis.window.webkitSpeechRecognition = class {
    constructor() {
      rec = this;
    }
    start() {
      this.on = true;
    }
    abort() {
      this.on = false;
      this.onerror?.({ error: 'aborted' });
      this.onend?.();
    }
  };
  const before = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, output: '', cut: false, timedOut: false }) });
  try {
    const c = createComposer({ A: '/api/chats/c4', id: 'c4', stop() {}, compact() {}, own: () => [{ name: 'model', run: () => true }] });
    c.paint(idle);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    for (const line of ['!echo hi', '/model']) {
      byClass(c.el, 'voice-btn')[0].fire('click');
      assert.equal(rec.on, true, `listening before ${line}`);
      c.textarea.value = line;
      c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
      await tick();
      await tick();
      assert.equal(rec.on, false, `${line}: the microphone stopped`);
      assert.equal(rec.onresult, null, `${line}: nothing heard later reaches the box`);
    }
  } finally {
    globalThis.fetch = before;
    delete globalThis.window.webkitSpeechRecognition;
  }
});

test('a message that did not arrive stays in the box with Retry beside it; Retry sends it again, once it arrives the note goes', async () => {
  const before = globalThis.fetch;
  const sent = [];
  let down = true;
  globalThis.fetch = async (u, o) => {
    if (String(u).endsWith('/send')) {
      sent.push(JSON.parse(o.body).text);
      if (down) return { ok: false, status: 503, json: async () => ({ error: 'the provider does not answer' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const c = createComposer({ A: '/api/chats/c5', id: 'c5', stop() {}, compact() {}, own: () => [] });
    c.paint(idle);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    c.textarea.value = 'fix the cart total';
    c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
    await tick();
    await tick();
    const note = byClass(c.el, 'chat-unsent')[0];
    const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
    assert.match(said(note).join(' '), /Not sent: The provider does not answer/);
    assert.equal(c.textarea.value, 'fix the cart total', 'the words stay in the box');
    const retry = byClass(note, 'btn').find((b) => said(b).includes('Retry'));
    assert.ok(retry, 'Retry on the note, not only a toast');
    down = false;
    retry.fire('click');
    await tick();
    await tick();
    assert.deepEqual(sent, ['fix the cart total', 'fix the cart total']);
    assert.equal(c.textarea.value, '', 'arrived: the box is emptied');
    assert.equal(note.children.length, 0, 'and the note is gone');
  } finally {
    globalThis.fetch = before;
  }
});

test('the + menu\'s Slash commands with words in the box: the list opens, and neither Enter on a command nor Escape loses or changes the words', async () => {
  globalThis.window ||= {};
  globalThis.window.addEventListener ||= () => {};
  globalThis.window.removeEventListener ||= () => {};
  const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ran = [];
  const c = createComposer({ A: '/api/chats/c6', id: 'c6', stop() {}, compact() {}, own: () => [{ name: 'branch', description: 'A copy of the conversation', run: () => ran.push('branch') }] });
  c.paint(idle);
  const slash = async () => {
    c.plusMenu();
    const item = byClass(document.body, 'chat-menu-item').filter((b) => said(b).includes('Slash commands')).at(-1);
    item.fire('click');
    await tick();
  };
  c.textarea.value = 'fix the cart total';
  c.textarea.fire('input');
  await slash();
  assert.equal(c.textarea.value, '/', 'the box shows / alone while the commands are listed');
  assert.equal(c.textarea.getAttribute('aria-expanded'), 'true', 'the command list is open');
  c.textarea.fire('keydown', { key: 'Escape' });
  assert.equal(c.textarea.value, 'fix the cart total', 'Escape: the words are back as they were, no / in front');
  await slash();
  c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
  await tick();
  assert.deepEqual(ran, ['branch'], 'Enter runs the command picked');
  assert.equal(c.textarea.value, 'fix the cart total', 'and the words are still in the box');
  c.textarea.value = '';
  c.textarea.fire('input');
  await slash();
  c.textarea.fire('keydown', { key: 'Escape' });
  assert.equal(c.textarea.value, '/', 'an empty box gets the / as before');
});

test('Slash commands from the + menu, a filter typed, then Escape: the words put aside come back, and new words are the saved draft', async () => {
  globalThis.window ||= {};
  globalThis.window.addEventListener ||= () => {};
  globalThis.window.removeEventListener ||= () => {};
  const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const draft = () => JSON.parse(kept.get('pref:chat.draft.c10'));
  const c = createComposer({ A: '/api/chats/c10', id: 'c10', stop() {}, compact() {}, own: () => [{ name: 'branch', description: 'A copy of the conversation', run() {} }] });
  c.paint(idle);
  const type = (t) => {
    c.textarea.value = t;
    c.textarea.fire('input');
  };
  const slash = async () => {
    c.plusMenu();
    byClass(document.body, 'chat-menu-item').filter((b) => said(b).includes('Slash commands')).at(-1).fire('click');
    await tick();
  };
  type('fix the cart total');
  await slash();
  type('/br');
  assert.equal(c.textarea.getAttribute('aria-expanded'), 'true', 'the list is open on the filter');
  c.textarea.fire('keydown', { key: 'Escape' });
  assert.equal(c.textarea.value, 'fix the cart total', 'Escape on a filter typed: the words are back in its place');
  type('');
  type('a new question');
  assert.equal(draft(), 'a new question', 'the saved draft is what the box shows, so a reload keeps the new words');
  // The / line taken away by hand (the list open): the words are back before what is typed now.
  type('fix the cart total');
  await slash();
  type('');
  assert.equal(c.textarea.value, 'fix the cart total', 'the / gone: the words are back');
  type('fix the cart total and the tax');
  assert.equal(draft(), 'fix the cart total and the tax');
  // A command line written out keeps them aside, and the saved draft holds both until it is sent.
  type('');
  type('keep this');
  await slash();
  type('/review the tax ');
  assert.equal(draft(), 'keep this\n\n/review the tax ', 'a reload loses neither');
});

test('the chip row in the desktop app\'s order: ultracode, Lead and the mode at the left, the model picker toward the right with the ring next to it', () => {
  const c = createComposer({ A: '/api/chats/c7', id: 'c7', stop() {}, compact() {}, own: () => [] });
  c.paint(idle);
  const row = byClass(c.el, 'chat-chips')[0];
  const kind = (n) => ['chat-ultra', 'chat-lead', 'chat-modechip', 'chat-chips-gap', 'chat-modelchip', 'chat-ring'].find((k) => n.className.split(' ').includes(k));
  // Ultracode and Lead model are Hoprig's own chips: they go first, so they break none of the desktop app's order.
  assert.deepEqual(row.children.map(kind), ['chat-ultra', 'chat-lead', 'chat-modechip', 'chat-chips-gap', 'chat-modelchip', 'chat-ring'], 'the gap before the model, none between it and the ring');
});

test('Esc Esc with words in the box (the composer\'s clearDraft) clears them, and Up brings them back, as in the terminal', () => {
  const c = createComposer({ A: '/api/chats/c8', id: 'c8', stop() {}, compact() {}, own: () => [] });
  c.paint(idle);
  c.textarea.value = 'half a message';
  c.textarea.fire('input');
  c.clearDraft();
  assert.equal(c.textarea.value, '', 'cleared');
  c.textarea.selectionStart = 0;
  c.textarea.selectionEnd = 0;
  c.textarea.fire('keydown', { key: 'ArrowUp', shiftKey: false });
  assert.equal(c.textarea.value, 'half a message', 'Up brings the words back');
});

test('Esc Esc on a "!" line clears it and the box leaves the shell look; Up brings the line back with it', () => {
  const c = createComposer({ A: '/api/chats/c11', id: 'c11', stop() {}, compact() {}, own: () => [] });
  const on = new Set();
  c.el.classList = { add: (k) => on.add(k), remove: (k) => on.delete(k), toggle: (k, f) => (f ? on.add(k) : on.delete(k)), contains: (k) => on.has(k) };
  c.paint(idle);
  c.textarea.value = '!ls -la';
  c.textarea.fire('input');
  assert.ok(on.has('chat-shell-mode'), 'a "!" line: the shell look');
  c.clearDraft();
  assert.equal(c.textarea.value, '');
  assert.ok(!on.has('chat-shell-mode'), 'the empty box is a message box again');
  c.textarea.selectionStart = 0;
  c.textarea.selectionEnd = 0;
  c.textarea.fire('keydown', { key: 'ArrowUp', shiftKey: false });
  assert.equal(c.textarea.value, '!ls -la');
  assert.ok(on.has('chat-shell-mode'), 'the line brought back by Up has the shell look again');
});

test('the usage ring pressed on a subscription asks the running tool for the plan\'s usage, and its sheet shows the plan; a gateway is not asked', async () => {
  const before = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (u) => {
    asked.push(String(u));
    return { ok: true, status: 200, json: async () => ({ usage: { contextPercent: 3 }, limits: { five_hour: { percent: 42, resetsAt: Date.now() + 3_600_000 } } }) };
  };
  const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    const sub = { ...idle, tool: 'claude', running: true, engine: { id: 'claude', capabilities: { usage: true } }, profile: { kind: 'subscription' }, limits: {}, usage: { contextPercent: 3 } };
    const c = createComposer({ A: '/api/chats/c9', id: 'c9', stop() {}, compact() {}, own: () => [] });
    c.paint(sub);
    byClass(c.el, 'chat-ring')[0].fire('click');
    await tick();
    await tick();
    assert.deepEqual(asked.filter((u) => u.endsWith('/usage')), ['/api/chats/c9/usage'], 'asked once, on the press');
    const sheet = byClass(document.body, 'sheet').at(-1);
    assert.match(said(sheet).join(' '), /Plan usage[\s\S]*5-hour limit[\s\S]*42% used/, 'the sheet shows the plan, not Context');
    asked.length = 0;
    c.paint({ ...sub, profile: { kind: 'api' } });
    byClass(c.el, 'chat-ring')[0].fire('click');
    await tick();
    assert.deepEqual(asked, [], 'a key billed by use has no plan: nothing asked');
  } finally {
    globalThis.fetch = before;
  }
});

test('the usage ring pressed while the tool is slow to answer: the sheet opens at once and says it asks; a second press asks nothing more', async () => {
  const before = globalThis.fetch;
  const asked = [];
  let answer = () => {};
  globalThis.fetch = async (u) => {
    if (!String(u).endsWith('/usage')) return { ok: true, status: 200, json: async () => ({}) }; // the composer's own look for a "!" run
    asked.push(String(u));
    await new Promise((r) => (answer = r));
    return { ok: true, status: 200, json: async () => ({ usage: { contextPercent: 3 }, limits: { seven_day: { percent: 17, resetsAt: Date.now() + 86_400_000 } } }) };
  };
  const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    const sub = { ...idle, tool: 'claude', running: true, engine: { id: 'claude', capabilities: { usage: true } }, profile: { kind: 'subscription' }, limits: {}, usage: { contextPercent: 3 } };
    const c = createComposer({ A: '/api/chats/c12', id: 'c12', stop() {}, compact() {}, own: () => [] });
    c.paint(sub);
    const ring = byClass(c.el, 'chat-ring')[0];
    ring.fire('click');
    await tick();
    const sheet = byClass(document.body, 'sheet').at(-1);
    assert.equal(sheet.open, true, 'open before the answer');
    assert.match(said(sheet).join(' '), /Plan usage[\s\S]*Asking Claude how much of your plan is used/, 'it says it asks');
    ring.fire('click');
    await tick();
    assert.deepEqual(asked, ['/api/chats/c12/usage'], 'a second press while it asks starts no second ask');
    answer();
    await tick();
    await tick();
    assert.match(said(sheet).join(' '), /Weekly limit\s+17% used/, 'the answer fills the open sheet');
    assert.doesNotMatch(said(sheet).join(' '), /Asking/);
  } finally {
    globalThis.fetch = before;
  }
});

test('the usage ring pressed again after its sheet was closed during the ask: it opens at once, and the one ask fills it', async () => {
  const before = globalThis.fetch;
  const asked = [];
  let answer = () => {};
  globalThis.fetch = async (u) => {
    if (!String(u).endsWith('/usage')) return { ok: true, status: 200, json: async () => ({}) };
    asked.push(String(u));
    await new Promise((r) => (answer = r));
    return { ok: true, status: 200, json: async () => ({ usage: { contextPercent: 3 }, limits: { seven_day: { percent: 17, resetsAt: Date.now() + 86_400_000 } } }) };
  };
  const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    const sub = { ...idle, tool: 'claude', running: true, engine: { id: 'claude', capabilities: { usage: true } }, profile: { kind: 'subscription' }, limits: {}, usage: { contextPercent: 3 } };
    const c = createComposer({ A: '/api/chats/c13', id: 'c13', stop() {}, compact() {}, own: () => [] });
    c.paint(sub);
    const ring = byClass(c.el, 'chat-ring')[0];
    ring.fire('click');
    await tick();
    const sheet = byClass(document.body, 'sheet').at(-1);
    assert.equal(sheet.open, true);
    sheet.close(); // closed while the tool has not answered
    ring.fire('click');
    await tick();
    assert.equal(sheet.open, true, 'the second press opens the sheet at once');
    assert.match(said(sheet).join(' '), /Asking Claude how much of your plan is used/);
    assert.deepEqual(asked, ['/api/chats/c13/usage'], 'and asks nothing more');
    answer();
    await tick();
    await tick();
    assert.match(said(sheet).join(' '), /Weekly limit\s+17% used/, 'the first ask\'s answer fills the sheet that is open');
  } finally {
    globalThis.fetch = before;
  }
});

test('Esc Esc on a command line written out after Slash commands: the words put aside come back in the box, not only in the saved draft', async () => {
  globalThis.window ||= {};
  globalThis.window.addEventListener ||= () => {};
  globalThis.window.removeEventListener ||= () => {};
  const said = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(said));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const draft = () => JSON.parse(kept.get('pref:chat.draft.c14'));
  const c = createComposer({ A: '/api/chats/c14', id: 'c14', stop() {}, compact() {}, own: () => [{ name: 'branch', description: 'A copy of the conversation', run() {} }] });
  c.paint(idle);
  const type = (t) => {
    c.textarea.value = t;
    c.textarea.fire('input');
  };
  type('keep this');
  c.plusMenu();
  byClass(document.body, 'chat-menu-item').filter((b) => said(b).includes('Slash commands')).at(-1).fire('click');
  await tick();
  type('/review the tax '); // the space closes the / list; the words stay aside
  c.clearDraft();
  assert.equal(c.textarea.value, 'keep this', 'the words put aside are in the box again');
  assert.equal(draft(), 'keep this', 'and the saved draft is what the box shows');
});

test('a start the server refuses after the message arrived (POST /send answers OK, the turn ends "could not start"): the box empties and Up brings the words back', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'm1', queued: false }) });
  try {
    const c = createComposer({ A: '/api/chats/c9', id: 'c9', stop() {}, compact() {}, own: () => [] });
    c.paint(idle);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    c.textarea.value = 'run the nightly report';
    c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
    await tick();
    await tick();
    assert.equal(c.textarea.value, '', 'the message arrived (it is in the timeline, the refusal under it): the box is emptied');
    c.textarea.selectionStart = 0;
    c.textarea.selectionEnd = 0;
    c.textarea.fire('keydown', { key: 'ArrowUp', shiftKey: false });
    assert.equal(c.textarea.value, 'run the nightly report', 'the words are not lost: Up brings them back to send again');
  } finally {
    globalThis.fetch = before;
  }
});
