// The Go live page as it paints (web/ship.js paintShip, on the page tests' stand-in DOM): the look again every 2.5 s
// while a step runs keeps what the owner picked, typed and opened, and the focus where it was; after a press the focus
// goes to what that press changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { texts } from '../chat/fakedom.mjs';

const { paintShip } = await import('../../web/ship.js');
const ID = 'a'.repeat(20);
const view = (over = {}) => ({
  project: 'shop', folder: '~/Workspace/projects/shop', base: 'main', cut: null, tap: null, limiter: null, last: null,
  branches: [{ name: 'work/cart', title: null, commits: 1, subject: 'Cart' }, { name: 'work/next', title: null, commits: 1, subject: 'Next' }],
  togethers: [{ id: ID, name: 'alpha', branch: 'work/alpha-all', base: 'main', branches: ['work/cart'], titles: {}, done: ['work/cart'], finished: true, problem: null, conflict: null, tree: 'b'.repeat(40), check: { state: 'ready', passed: 1, failed: 0, notCounted: null, last: { at: new Date().toISOString(), ok: true, commands: [] } } }],
  check: { shown: { commands: ['node -e 0  (up to 10 min)'], hash: 'h1' }, problem: null, confirmed: true },
  live: { shown: { update: ['node deploy.mjs {commit}  (up to 2 min)'], verify: ['http://127.0.0.1:8080/ answers 200 within 4 s'], back: ['node deploy.mjs {before}  (up to 2 min)'], keep: ['data'], restarts: false, turnSeconds: 300, waitSeconds: 120, hash: 'h2' }, problem: null, confirmed: true, restarts: false },
  switches: { auto: false, from: '09:00', to: '18:00', autoBack: false },
  step: { id: '1'.repeat(16), name: 'alpha', part: 'update', runningElsewhere: false },
  ...over,
});
let served = view();
globalThis.fetch = async (u, o = {}) => ({ status: 200, ok: true, json: async () => (o.method === 'POST' ? { ok: true } : u === '/api/ship' ? { projects: ['shop'] } : served) });
const settle = () => new Promise((res) => setTimeout(res, 20));
const sp = (slot, key) => slot.querySelector(`[data-sp=${JSON.stringify(key)}]`);

async function open() {
  const slot = document.createElement('div');
  document.body.append(slot);
  const ui = paintShip(slot);
  for (let i = 0; i < 50 && !sp(slot, 'pick-name'); i++) await settle();
  return { slot, ui };
}

test('the look again during a step keeps the picks, the typed words, the open card and the focus', async () => {
  served = view();
  const { slot, ui } = await open();
  try {
    const box = sp(slot, 'pick:work/next');
    box.checked = true;
    box.listeners.change();
    const name = sp(slot, 'pick-name');
    name.value = 'beta';
    name.listeners.input();
    const card = slot.querySelector('.sp-auto');
    card.open = true;
    card.listeners.toggle();
    const typed = sp(slot, 'auto-typed');
    typed.value = 'sh';
    typed.listeners.input();
    name.focus();
    await ui.refresh(); // what the 2.5 s poll runs
    assert.notEqual(sp(slot, 'pick-name'), name, 'the page was drawn again');
    assert.ok('checked' in sp(slot, 'pick:work/next').attrs, 'work/next is still picked');
    assert.equal('checked' in sp(slot, 'pick:work/cart').attrs, false);
    assert.equal(sp(slot, 'pick-name').value, 'beta');
    assert.ok('open' in slot.querySelector('.sp-auto').attrs, 'the card is still open');
    assert.equal(sp(slot, 'auto-typed').value, 'sh');
    assert.equal(document.activeElement, sp(slot, 'pick-name'), 'the focus is back in the name field');
  } finally {
    ui.stop();
    slot.remove();
  }
});

test('after a press the focus goes to what it changed: the confirmed block, not the check above it', async () => {
  served = view({ step: null, live: { ...view().live, confirmed: false } });
  const { slot, ui } = await open();
  try {
    const block = slot.querySelectorAll('.sp-block').find((b) => texts(b).join('').includes('Going live'));
    const confirm = block.querySelectorAll('button').find((b) => texts(b).join('').includes('I have read them: confirm'));
    served = view({ step: null });
    await confirm.listeners.click();
    await settle();
    const head = document.activeElement;
    assert.equal(head.getAttribute('data-sp'), 'block:live');
    assert.match(texts(head).join(''), /Going live.*Confirmed on this computer/);
  } finally {
    ui.stop();
    slot.remove();
  }
});

test('the limiter sits at the foot of Go live and the look again does not draw it again', async () => {
  served = view({ run: null });
  const { slot, ui } = await open();
  try {
    const field = slot.querySelector('[id="sp-limiter"]');
    assert.ok(field, 'the limiter field is on the Go live page');
    assert.match(texts(slot).join(' '), /The limiter/);
    await ui.refresh();
    assert.equal(slot.querySelector('[id="sp-limiter"]'), field, 'the poll leaves it alone');
    const last = slot.children[slot.children.length - 1];
    assert.ok(last.querySelector('[id="sp-limiter"]'), 'it is the last thing on the page');
  } finally {
    ui.stop();
    slot.remove();
  }
});

test('the cards are numbered in the order they show: with no put-together, Go live is the second', async () => {
  served = view({ step: null, togethers: [] });
  const { slot, ui } = await open();
  try {
    const titles = slot.querySelectorAll('.sp-title').map((t) => texts(t).join(''));
    assert.deepEqual(titles.filter((t) => /^\d\. /.test(t)), ['1. Pick the finished tasks', '2. Go live']);
  } finally {
    ui.stop();
    slot.remove();
  }
});
