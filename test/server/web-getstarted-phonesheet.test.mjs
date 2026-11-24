// Get started's phone step: its button says it makes a sign-in code; once the code is shown the sheet's button makes
// another one, says so as a second choice, and the sheet says that an earlier code still works; the scan sentence once.
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

const { runAction, actionLabel } = await import('../../web/getstarted.js');
const tick = () => new Promise((r) => setTimeout(r, 20));

test('the step says what its press makes, and the sheet does not offer the same code twice', async () => {
  assert.equal(actionLabel({ kind: 'page', target: 'settings/signin-device' }), 'Show a sign-in code');
  assert.equal(actionLabel({ kind: 'page', target: 'pc/setup' }), 'Open');
  const done = runAction({ kind: 'page', target: 'settings/signin-device' });
  await tick();
  const sheet = document.body.querySelector('dialog');
  assert.equal(made.length, 1);
  const said = texts(sheet).join(' ');
  assert.equal((said.match(/no password to type/g) || []).length, 1, 'the scan sentence once');
  assert.doesNotMatch(said, /Show a sign-in code/, 'no button for a code already on screen');
  const b = [...sheet.querySelectorAll('button')].find((x) => texts(x).join('') === 'Make a new code');
  assert.ok(b, 'the button makes a new code');
  assert.match(b.className, /\bsecondary\b/);
  assert.doesNotMatch(b.className, /\bprimary\b/);
  assert.match(said, /A new code does not end the one before: each works once, until its time runs out\./);
  sheet.close();
  await done;
});
