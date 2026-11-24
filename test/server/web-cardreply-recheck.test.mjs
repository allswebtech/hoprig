// The reply box on Home's card goes only to a session that still waits as the card showed it. A card is drawn from a
// list that may be seconds old: in that time a permission question can come up, and his "2" would answer it. So no box
// while something of the session runs by itself, and Send reads the session again and refuses when it changed.
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

const { replyBox, changedSince, sessionCard } = await import('../../web/sessionitem.js');
const asks = { name: 'shop', kind: 'claude', status: 'waiting', machine: null, statusAt: 5, lastMessage: 'Done with /api/login. Should I apply the same limit to /api/cart?' };

// A stand-in for the dashboard: the sessions read answers `machines` (as read at Send), every other call is a send.
function wire(t, machines) {
  document.body = new FakeElement('body');
  const fetchWas = globalThis.fetch;
  const calls = { reads: 0, sent: [] };
  globalThis.fetch = async (u, o) => {
    if (u === '/api/machines/sessions') {
      calls.reads++;
      return { ok: true, status: 200, json: async () => ({ machines }) };
    }
    calls.sent.push([u, o && o.body ? JSON.parse(o.body) : null]);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  t.after(() => {
    globalThis.fetch = fetchWas;
    delete document.body;
  });
  return calls;
}
const here = (...sessions) => [{ machine: null, status: 'online', sessions }];
async function press(box, text) {
  const ta = find(box, 'textarea')[0];
  ta.value = text;
  ta.fire('input');
  const send = find(box, 'button').find((b) => texts(b).join('') === 'Send');
  await send.listeners.click[0]({ preventDefault() {}, stopPropagation() {}, currentTarget: send });
  return ta;
}

test('no reply box while a background command or subagents of it still run', () => {
  assert.ok(replyBox(asks), 'a quiet waiting session that asks gets it');
  assert.equal(replyBox({ ...asks, bgCommands: 1 }), null, 'a command of its own runs in the background');
  assert.equal(replyBox({ ...asks, background: true }), null, 'subagents or a workflow go on');
  assert.ok(replyBox({ ...asks, bgCommands: 0 }), 'none running: the box');
  const card = sessionCard({ ...asks, bgCommands: 2 }, [], () => {}, false, { heading: 'waiting' });
  assert.equal(find(card, 'textarea').length, 0, 'Home\'s card has none then');
});

test('Send refuses when a permission question came up since the card was drawn, and keeps his words', async (t) => {
  const calls = wire(t, here({ ...asks, status: 'attention', statusAt: 9, ask: { type: 'permission', what: 'rm -rf build' } }));
  let looks = 0;
  const ta = await press(replyBox(asks, () => looks++), '2');
  assert.equal(calls.reads, 1, 'it read the session again');
  assert.deepEqual(calls.sent, [], 'nothing was sent');
  assert.equal(ta.value, '2', 'his words are kept');
  assert.match(texts(document.body).join(' '), /Not sent: it is asking you something now/);
  assert.ok(looks >= 1, 'Home looks again, so the card shows the question');
});

test('Send refuses for every other change; it sends only to the session still as shown', async (t) => {
  const cases = [
    [here({ ...asks, askCard: { kind: 'notice' } }), /it is asking you something now/],
    [here({ ...asks, held: { what: 'npm publish' } }), /it is asking you something now/],
    [here({ ...asks, status: 'working' }), /it is working again/],
    [here({ ...asks, bgCommands: 1 }), /it is working again/],
    [here({ ...asks, statusAt: 7 }), /it has changed since you read it/],
    [here({ ...asks, lastMessage: 'Which file should I start with?' }), /it has changed since you read it/],
    [here({ ...asks, status: 'ended' }), /the session has ended/],
    // Starting again (a move, a restart): it has not ended, it only no longer waits.
    [here({ ...asks, status: 'starting' }), /it is no longer waiting for an answer/],
    [here(), /the session has ended/],
    [[{ machine: null, status: 'offline', sessions: [] }], /its computer does not answer/],
  ];
  for (const [machines, why] of cases) {
    const calls = wire(t, machines);
    await press(replyBox(asks, () => {}), 'Yes');
    assert.deepEqual(calls.sent, [], String(why));
    assert.match(texts(document.body).join(' '), why);
  }
  const calls = wire(t, here({ ...asks }));
  await press(replyBox(asks, () => {}), 'Yes');
  assert.deepEqual(calls.sent, [['/api/sessions/shop/send', { text: 'Yes', expect: 'waiting' }]], 'unchanged: sent, asking the server to check it still waits');
});

test('a starting session is refused as no longer waiting, not as ended', () => {
  assert.equal(changedSince(asks, { ...asks, status: 'starting' }), 'it is no longer waiting for an answer');
  assert.equal(changedSince(asks, { ...asks, status: 'ended' }), 'the session has ended');
  assert.equal(changedSince(asks, null), 'the session has ended');
});

test('the server refuses at the send: its sentence is shown, his words are kept, Home looks again', async (t) => {
  for (const words of ['Nothing was sent: shop is no longer waiting for an answer.', 'Nothing was sent: shop shows a question on its screen. Open the session to answer it there.']) {
    const calls = wire(t, here({ ...asks }));
    const fetchWas = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      if (u === '/api/machines/sessions') return fetchWas(u, o);
      calls.sent.push([u, JSON.parse(o.body)]);
      return { ok: false, status: 409, json: async () => ({ error: words }) };
    };
    let looks = 0;
    const ta = await press(replyBox(asks, () => looks++), '2');
    assert.deepEqual(calls.sent, [['/api/sessions/shop/send', { text: '2', expect: 'waiting' }]]);
    assert.equal(ta.value, '2', 'his words are kept');
    const shown = texts(document.body).join(' ');
    assert.ok(shown.includes(`${words} Your answer is kept.`), shown);
    assert.equal(shown.includes('Not sent: Nothing was sent'), false, 'said once');
    assert.ok(looks >= 1, 'Home looks again');
  }
});

test('a 409 that typed nothing is one refusal, whichever check caught it: kept, said once, Home looks again', async (t) => {
  // The run record went (the session ended, its terminal is at its shell), or another message was being typed: the
  // server says "Nothing was typed: …" (code not_in_front where the typing steps set it), not the guard's sentence.
  for (const [error, code] of [
    ['Nothing was typed: no coding tool runs in session "shop" now (its terminal is at its own shell). Start the coding tool there again, then send it again', 'not_in_front'],
    ['Nothing was typed: another message is being typed into this session right now. Send it again in a moment', undefined],
    ['The coding tool is not in front any more', 'not_in_front'],
  ]) {
    const calls = wire(t, here({ ...asks }));
    const fetchWas = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      if (u === '/api/machines/sessions') return fetchWas(u, o);
      calls.sent.push([u, JSON.parse(o.body)]);
      return { ok: false, status: 409, json: async () => ({ error, ...(code ? { code } : {}) }) };
    };
    let looks = 0;
    const ta = await press(replyBox(asks, () => looks++), '2');
    assert.equal(ta.value, '2', 'his words are kept');
    const shown = texts(document.body).join(' ');
    assert.ok(shown.includes(`${error}. Your answer is kept.`), shown);
    // (Toasts of the tests before stay in the stand-in page: look for this refusal's own words only.)
    assert.equal(shown.includes(`Not sent: ${error}`), false, 'the same toast as the guard\'s refusal');
    assert.ok(looks >= 1, 'Home looks again, so the card shows what the session is now');
  }
});

test('a refusal names the session as its card does, not by its terminal\'s name', async (t) => {
  const titled = { ...asks, name: 'shop-cart', display: 'Limit the cart requests' };
  for (const [error, said] of [
    ['Nothing was sent: shop-cart is no longer waiting for an answer.', 'Nothing was sent: "Limit the cart requests" is no longer waiting for an answer. Your answer is kept. Open the session to see what it does now.'],
    ['Nothing was sent: shop-cart shows a question on its screen. Open the session to answer it there.', 'Nothing was sent: "Limit the cart requests" shows a question on its screen. Open the session to answer it there. Your answer is kept.'],
    ['Nothing was typed: no coding tool runs in session "shop-cart" now (its terminal is at its own shell). Start the coding tool there again, then send it again', 'Nothing was typed: no coding tool runs in session "Limit the cart requests" now (its terminal is at its own shell). Start the coding tool there again, then send it again. Your answer is kept. Open the session to see what it does now.'],
  ]) {
    const calls = wire(t, here({ ...titled }));
    const fetchWas = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      if (u === '/api/machines/sessions') return fetchWas(u, o);
      calls.sent.push([u, JSON.parse(o.body)]);
      return { ok: false, status: 409, json: async () => ({ error }) };
    };
    await press(replyBox(titled, () => {}), 'Yes, the same limit please');
    assert.deepEqual(calls.sent.map((c) => c[0]), ['/api/sessions/shop-cart/send'], 'sent by its name');
    const shown = texts(document.body).join(' ');
    assert.ok(shown.includes(said), shown);
  }
  // The toast says where to look next, once: not again after a sentence that already sends him to the session.
  const { keptWords } = await import('../../web/sessionitem.js');
  assert.equal(keptWords('Not sent: the session has ended'), 'Not sent: the session has ended. Your answer is kept. Open the session to see what it does now.');
  assert.equal(keptWords('Nothing was sent: shop shows a question on its screen. Open the session to answer it there.').match(/Open the session/g).length, 1);
  // Only those two forms change: a name that is also a word stays where it is a word.
  const work = { ...asks, name: 'work', display: 'Tidy the work queue' };
  const { inCardWords } = await import('../../web/sessionitem.js');
  assert.equal(inCardWords('Nothing was sent: work is no longer waiting for an answer.', work), 'Nothing was sent: "Tidy the work queue" is no longer waiting for an answer.');
  assert.equal(inCardWords('Nothing was typed: another message is being typed into this session right now. Send it again in a moment', work), 'Nothing was typed: another message is being typed into this session right now. Send it again in a moment');
  assert.equal(inCardWords('Nothing was sent: shop is no longer waiting for an answer.', asks), 'Nothing was sent: shop is no longer waiting for an answer.', 'no title: as the server said');
});

test('a session of another computer is read again on its own computer, not by its name alone', async (t) => {
  const there = { ...asks, machine: 'box2' };
  // The same name on this computer asks a question now; the one on box2 still waits: it is sent there.
  const calls = wire(t, [
    { machine: null, status: 'online', sessions: [{ ...asks, status: 'attention', ask: { type: 'permission' } }] },
    { machine: 'box2', status: 'online', sessions: [there] },
  ]);
  await press(replyBox(there, () => {}), 'No');
  assert.deepEqual(calls.sent, [['/m/box2/api/sessions/shop/send', { text: 'No', expect: 'waiting' }]]);
  assert.equal(changedSince(asks, { silent: true }), 'its computer does not answer');
  assert.equal(changedSince(asks, { ...asks }), null);
});
