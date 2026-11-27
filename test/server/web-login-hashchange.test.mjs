// The login page (web/login.js) reads a one-time link that is pasted into a tab that is already open on it: the
// browser only changes the fragment then (hashchange), it does not load the page again.
import assert from 'node:assert/strict';
import test from 'node:test';

const TOKEN = 'A'.repeat(43);
const els = {};
const el = (id) => (els[id] ||= { id, textContent: '', classList: { add() {}, remove() {} }, replaceWith() {}, querySelector: () => ({ disabled: false }), addEventListener() {}, value: '' });
globalThis.document = { title: '', getElementById: el, createElement: () => ({}) };
const listeners = {};
globalThis.window = { addEventListener: (k, fn) => { listeners[k] = fn; } };
globalThis.location = { hash: '', pathname: '/login', search: '', protocol: 'http:', hostname: '127.0.0.1', replace(u) { this.went = u; } };
globalThis.history = { replaceState(_a, _b, url) { globalThis.location.hash = ''; globalThis.location.cleaned = url; } };
const posted = [];
globalThis.fetch = async (u, o = {}) => {
  if (o.method === 'POST') posted.push([u, JSON.parse(o.body)]);
  return { ok: true, status: 200, json: async () => ({ authed: false }) };
};
const tick = () => new Promise((r) => setTimeout(r, 20));

await import('../../web/login.js');

test('a page opened without a link asks only who is signed in', () => {
  assert.equal(posted.length, 0);
  assert.equal(typeof listeners.hashchange, 'function', 'the page listens for a changed fragment');
});

test('a link pasted into the open tab signs in once, and the fragment is cleaned', async () => {
  globalThis.location.hash = `#link=${TOKEN}`;
  listeners.hashchange();
  await tick();
  assert.deepEqual(posted, [['api/login/link', { token: TOKEN }]]);
  assert.equal(globalThis.location.hash, '', 'the token is not left in the address');
  assert.equal(globalThis.location.went, './', 'signed in: on to Home');
});

test('another fragment is not a link', async () => {
  posted.length = 0;
  globalThis.location.hash = '#something';
  listeners.hashchange();
  globalThis.location.hash = `#link=${'short'}`;
  listeners.hashchange();
  await tick();
  assert.equal(posted.length, 0);
});
