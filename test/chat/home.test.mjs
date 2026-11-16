// Home's copy of the sessions (web/store.js) right after the owner answered an OK card in a chat: the page asks
// for the state again at once, also when a look is under way whose answer was read before the OK was given.
// Without that, Home showed "Needs your OK" for a chat that was already working, until the next look seconds later.
import assert from 'node:assert/strict';
import test from 'node:test';

// What store.js and lib.js touch of a browser.
globalThis.window = globalThis;
globalThis.document = { addEventListener: () => {}, visibilityState: 'visible', title: '' };
const asked = []; // each request for the state, with the way to answer it
globalThis.fetch = (url) => new Promise((resolve) => asked.push({ url, answer: (status) => resolve({ ok: true, status: 200, json: async () => ({ machines: [{ machine: null, sessions: [{ name: 'chat:1', kind: 'chat', status }] }] }) }) }));
// The poller's own timers (seconds) must not hold the test process up after the last check.
const slow = new Set();
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  const t = realTimeout(fn, ms, ...rest);
  if (ms >= 1000) slow.add(t);
  return t;
};
test.after(() => {
  for (const t of slow) clearTimeout(t);
});

const until = async (what, fn, ms = 1000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => realTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('Home after an OK: a look that was under way is followed by another at once, so the old state does not stay', async () => {
  const { store } = await import('../../web/store.js');
  const seen = [];
  store.subscribe((d) => d && seen.push(d.sessions[0].status));
  await until('the first look', () => asked.length === 1);
  assert.equal(asked[0].url, '/api/machines/sessions');
  asked.shift().answer('attention');
  await until('its answer', () => seen.length === 1);

  // The page's regular look is under way; the server read the sessions before the owner pressed Allow.
  const look = store.refresh();
  await until('the regular look', () => asked.length === 1);
  // The owner allows: the chat page asks for the state again (web/chat.js).
  store.refresh();
  assert.equal(asked.length, 1, 'never two looks at once');
  asked.shift().answer('attention');
  await look;
  assert.deepEqual(seen, ['attention', 'attention']);
  // One more look right away, not seconds later.
  await until('the look after the OK', () => asked.length === 1, 500);
  asked.shift().answer('working');
  await until('its answer', () => seen.length === 3, 500);
  assert.equal(store.data.sessions[0].status, 'working');

  // And with nothing asked meanwhile, the next look is the regular one (seconds away).
  await new Promise((r) => realTimeout(r, 150));
  assert.equal(asked.length, 0);
});
