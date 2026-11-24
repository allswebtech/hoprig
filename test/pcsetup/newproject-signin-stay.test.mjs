// "sign in to GitHub" on the Check step opens GitHub's sign-in sheet over the step: the address does not change (so
// the name and brief he typed stay), and once he is signed in the step is drawn again by the link's own callback.
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
globalThis.location = { hash: '#/new-project', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => (/git\/signin$/.test(u) ? { state: 'done', account: 'alex' } : {}) });

const { signInLink } = await import('../../web/projects.js');
const tick = () => new Promise((r) => setTimeout(r, 30));

test('the link opens the sign-in over the step, keeps the address, and draws the step again once signed in', { timeout: 10_000 }, async () => {
  let again = 0;
  const a = signInLink(() => again++);
  let prevented = false;
  // The press resolves only once the sheet closes: not awaited here, the sheet is answered first.
  const pressed = a.listeners.click({ currentTarget: a, preventDefault: () => (prevented = true) });
  await tick();
  assert.equal(prevented, true, 'the browser does not follow the link to Setup');
  assert.equal(globalThis.location.hash, '#/new-project', 'still on the new project');
  const sheet = document.body.querySelector('dialog');
  assert.ok(sheet, 'GitHub\'s sign-in sheet is open over the step');
  assert.match(texts(sheet).join(' '), /Signed in to GitHub as alex/);
  const done = [...sheet.querySelectorAll('button')].find((b) => texts(b).join('') === 'Done');
  done.listeners.click({ currentTarget: done, preventDefault() {} });
  await pressed;
  await tick();
  assert.equal(again, 1, 'the step is drawn again');
});
