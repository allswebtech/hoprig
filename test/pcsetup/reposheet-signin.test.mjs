// "sign in to GitHub" inside the open Add a repository sheet: GitHub's sign-in takes the sheet's place (one sheet at a
// time), and once it ends the Add a repository sheet is there again with the name he typed; signed in, it now offers
// GitHub. Stopped, it comes back without that choice; Cancel then ends it for good.
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
globalThis.location = { hash: '#/workspace/project/shop', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
let signedIn = false;
let signin = 'done';
globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => {
  if (/project\/preview/.test(u)) return { github: signedIn ? { signedIn: true, account: 'alex' } : { signedIn: false } };
  if (/git\/signin$/.test(u)) {
    if (signin === 'done') signedIn = true;
    return signin === 'done' ? { state: 'done', account: 'alex' } : { state: 'cancelled' };
  }
  return {};
} });

const { repoSheet } = await import('../../web/projects.js');
const tick = () => new Promise((r) => setTimeout(r, 40));
const sheet = () => document.body.querySelector('dialog');
const text = () => texts(sheet()).join(' ');
const press = (el) => el.listeners.click({ currentTarget: el, preventDefault() {} });
const button = (label) => [...sheet().querySelectorAll('button')].find((b) => texts(b).join('') === label);
const type = (v) => {
  const input = sheet().querySelector('input.field');
  input.value = v;
  input.listeners.input();
};
const signInLinkNow = () => [...sheet().querySelectorAll('a')].find((a) => texts(a).join('') === 'sign in to GitHub');

test('signed in from inside the sheet: the sheet comes back with the name, and now offers GitHub', { timeout: 10_000 }, async () => {
  signedIn = false;
  signin = 'done';
  const pending = repoSheet({ id: 'shop', name: 'shop' });
  await tick();
  assert.match(text(), /Add a repository/);
  type('web');
  assert.match(text(), /you come back to this sheet with the name you typed/);
  press(signInLinkNow());
  await tick();
  assert.match(text(), /Signed in to GitHub as alex/, 'the sign-in is on screen');
  press(button('Done'));
  await tick();
  await tick();
  assert.equal(sheet().open, true, 'a sheet is open again');
  assert.match(text(), /Add a repository/);
  assert.equal(sheet().querySelector('input.field').value, 'web', 'the name he typed is still there');
  assert.ok(sheet().querySelectorAll('p.hint').some((x) => x.textContent === 'It is called shop-web, in code/.'), 'the name it gets is shown again');
  assert.match(text(), /Also on GitHub, private/, 'signed in now: the GitHub choice is offered');
  const gh = sheet().querySelectorAll('input').find((i) => i.attrs.type === 'radio' && i.value === 'github');
  gh.listeners.change();
  sheet().querySelector('form').listeners.submit({ preventDefault() {} });
  assert.deepEqual(await pending, { repo: 'web', github: true });
});

test('the sign-in stopped: the sheet comes back with the name and no GitHub choice; Cancel ends it', { timeout: 10_000 }, async () => {
  signedIn = false;
  signin = 'cancelled';
  const pending = repoSheet({ id: 'shop', name: 'shop' });
  await tick();
  type('api');
  press(signInLinkNow());
  await tick();
  assert.match(text(), /Stopped\./);
  press(button('Close'));
  await tick();
  await tick();
  assert.match(text(), /Add a repository/);
  assert.equal(sheet().querySelector('input.field').value, 'api');
  assert.doesNotMatch(text(), /Also on GitHub/);
  press(button('Cancel'));
  assert.equal(await pending, null);
  await tick();
  assert.equal(sheet().open, false, 'no sheet opens again after Cancel');
});
