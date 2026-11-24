// A reply box on Home's card of a session that waits and ends in a question: he answers there instead of in a
// terminal view. It sends only on his press of Send, only to that session (on its own computer), and never on a
// permission card (that one is answered by Allow / Do not allow).
import assert from 'node:assert/strict';
import test from 'node:test';

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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  fire(k, e = {}) { for (const fn of this.listeners[k] || []) fn({ preventDefault() {}, stopPropagation() {}, currentTarget: this, target: this, ...e }); }
  remove() {}
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.location ??= { hash: '#/', pathname: '/', search: '', protocol: 'http:', hostname: 'localhost' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const find = (n, tag) => (n instanceof FakeText ? [] : [...(n.tag === tag ? [n] : []), ...n.children.flatMap((c) => find(c, tag))]);

const { replyBox, endsInQuestion, sessionCard } = await import('../../web/sessionitem.js');
const asks = { name: 'shop', kind: 'claude', status: 'waiting', machine: null, statusAt: 5, lastMessage: 'Done with /api/login. Should I apply the same limit to /api/cart?' };

// Send reads the sessions again before it sends (sessionitem.js changedSince): the stand-in answers that read with the
// session as the card shows it, and records only what is sent.
function wire(t, answer = { ok: true, status: 200, json: async () => ({ ok: true }) }, sessions = [asks, { ...asks, name: 'web ui', machine: 'box2' }]) {
  document.body = new FakeElement('body');
  const fetchWas = globalThis.fetch;
  const sent = [];
  const machines = [...new Set(sessions.map((s) => s.machine ?? null))].map((machine) => ({ machine, status: 'online', sessions: sessions.filter((s) => (s.machine ?? null) === machine) }));
  globalThis.fetch = async (u, o) => {
    if (u === '/api/machines/sessions') return { ok: true, status: 200, json: async () => ({ machines }) };
    sent.push([u, o && o.body ? JSON.parse(o.body) : null]);
    return answer;
  };
  t.after(() => {
    globalThis.fetch = fetchWas;
    delete document.body;
  });
  return sent;
}
const typeIn = (box, text) => {
  const ta = find(box, 'textarea')[0];
  ta.value = text;
  ta.fire('input');
  return ta;
};
const sendBtn = (box) => find(box, 'button').find((b) => texts(b).join('') === 'Send');

test('only a waiting session whose last message is a question gets the box', () => {
  assert.equal(endsInQuestion(asks), true);
  assert.equal(endsInQuestion({ ...asks, lastMessage: 'All tests pass.' }), false);
  assert.equal(endsInQuestion({ ...asks, lastMessage: 'Which one do you want?  \n' }), true, 'space after it');
  assert.equal(replyBox({ ...asks, lastMessage: 'All tests pass.' }), null);
  assert.equal(replyBox({ ...asks, status: 'attention', ask: { type: 'permission', what: 'npm test' } }), null, 'never on a permission card');
  assert.equal(replyBox({ ...asks, status: 'attention', ask: { type: 'question' } }), null, 'a question of the tool\'s own form is answered in the terminal');
  assert.equal(replyBox({ ...asks, status: 'working' }), null);
  assert.equal(replyBox({ ...asks, kind: 'chat', chatId: 'c1' }), null, 'a chat has its own page to answer in');
  assert.equal(replyBox({ ...asks, kind: 'shell' }), null);
  assert.equal(replyBox({ ...asks, limit: { text: 'limit' } }), null, 'a limit card has its own buttons');
  assert.ok(replyBox(asks));
});

test('typing sends nothing; Send sends his words to that session only, and then the box is empty', async (t) => {
  const sent = wire(t);
  let looks = 0;
  const box = replyBox(asks, () => looks++);
  const ta = typeIn(box, 'Yes, the same limit please');
  ta.fire('keydown', { key: 'Enter' });
  assert.deepEqual(sent, [], 'no key sends it');
  await sendBtn(box).listeners.click[0]({ preventDefault() {}, stopPropagation() {}, currentTarget: sendBtn(box) });
  assert.deepEqual(sent, [['/api/sessions/shop/send', { text: 'Yes, the same limit please', expect: 'waiting' }]]);
  assert.equal(ta.value, '');
  assert.match(texts(document.body).join(' '), /Sent to shop\./);
  assert.ok(looks >= 1);
  // Empty: nothing is sent.
  await sendBtn(box).listeners.click[0]({ preventDefault() {}, stopPropagation() {}, currentTarget: sendBtn(box) });
  assert.equal(sent.length, 1);
});

test('a session of another computer gets it on that computer', async (t) => {
  const sent = wire(t);
  const box = replyBox({ ...asks, name: 'web ui', machine: 'box2' }, () => {});
  typeIn(box, 'No');
  await sendBtn(box).listeners.click[0]({ preventDefault() {}, stopPropagation() {}, currentTarget: sendBtn(box) });
  assert.deepEqual(sent, [['/m/box2/api/sessions/web%20ui/send', { text: 'No', expect: 'waiting' }]]);
});

test('a refusal keeps his words and says why', async (t) => {
  wire(t, { ok: false, status: 409, json: async () => ({ error: 'nothing was typed: the coding tool is not in front', code: 'not_in_front' }) });
  const box = replyBox(asks, () => {});
  const ta = typeIn(box, 'Yes');
  await sendBtn(box).listeners.click[0]({ preventDefault() {}, stopPropagation() {}, currentTarget: sendBtn(box) });
  assert.equal(ta.value, 'Yes');
  assert.match(texts(document.body).join(' '), /Nothing was typed: the coding tool is not in front\. Your answer is kept\./);
  // Any other failure: "Not sent:" and the reason, his words kept as well.
  wire(t, { ok: false, status: 500, json: async () => ({ error: 'server error' }) });
  const other = replyBox(asks, () => {});
  const ta2 = typeIn(other, 'Yes');
  await sendBtn(other).listeners.click[0]({ preventDefault() {}, stopPropagation() {}, currentTarget: sendBtn(other) });
  assert.equal(ta2.value, 'Yes');
  assert.match(texts(document.body).join(' '), /Not sent: Server error/);
});

test('a draft survives the card drawn again; a press in the box never opens the session', () => {
  const box = replyBox({ ...asks, name: 'draft' });
  typeIn(box, 'half a reply');
  assert.equal(find(replyBox({ ...asks, name: 'draft' }), 'textarea')[0].value, 'half a reply');
  let stopped = false;
  box.fire('click', { stopPropagation: () => (stopped = true) });
  assert.equal(stopped, true);
});

test('Home\'s card has it', () => {
  const card = sessionCard(asks, [], () => {}, false, { heading: 'waiting' });
  assert.equal(find(card, 'textarea').length, 1);
  assert.equal(find(sessionCard({ ...asks, lastMessage: 'Done.' }, [], () => {}, false, { heading: 'waiting' }), 'textarea').length, 0);
});

test('on a phone the box takes the card\'s width and Send goes under it, left of the floating button', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /:is\([^)]*\.card-reply[^)]*\)\s*\{\s*padding-right/, 'the field is not squeezed by the button\'s room');
  const phone = css.split('@media (max-width: 899px)').slice(1).join('');
  assert.match(phone, /\.card-reply\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(phone, /\.card-reply-text\s*\{[^}]*flex-basis:\s*100%/);
});
