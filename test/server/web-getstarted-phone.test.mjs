// Get started's phone step: its button opens the sign-in code at once (the sheet of Settings → Security and sign-in),
// and a code is made only by that press, never by loading the page or by an address alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeElement, texts } from '../chat/fakedom.mjs';

FakeElement.prototype.showModal = function () {
  this.open = true;
};
FakeElement.prototype.close = function () {
  this.open = false;
  this.listeners.close?.();
};
FakeElement.prototype.click = function () {
  this.listeners.click?.({ currentTarget: this, preventDefault() {} });
};
globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
const made = [];
globalThis.fetch = async (u, o = {}) => {
  if (/\/api\/login\/links$/.test(u) && o.method === 'POST') made.push(u);
  const body = /\/api\/login\/links$/.test(u) ? { id: 'k1', url: 'http://localhost/login#code=abc', expires: Date.now() + 600000, qr: null } : { status: 'waiting' };
  return { ok: true, status: 200, json: async () => body };
};

const { runAction, TARGETS } = await import('../../web/getstarted.js');
const tick = () => new Promise((r) => setTimeout(r, 20));

test('loading Get started makes no code, and the phone step\'s button opens the code in a sheet at once', async () => {
  assert.equal(made.length, 0, 'nothing made on load');
  const done = runAction({ kind: 'page', target: 'settings/signin-device' });
  await tick();
  const sheet = document.body.querySelector('dialog');
  assert.ok(sheet && sheet.open, 'a sheet is open');
  assert.equal(globalThis.location.hash, '#/', 'he stays on Home: no settings page to search on');
  assert.equal(made.length, 1, 'his press made one code');
  assert.match(texts(sheet).join(' '), /Sign in your phone/);
  assert.match(texts(sheet).join(' '), /Scan it with the phone's camera/);
  sheet.close();
  await done;
  assert.equal(TARGETS['settings/signin-device'], '#/settings/security', 'the address itself still opens the page, which makes no code by itself');
});
