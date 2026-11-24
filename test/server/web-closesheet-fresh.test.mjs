// The End sheet's press (web/closesheet.js closeWaited) reads the sessions again right before EACH end, not once
// before all of them: the ends go one after another, some to a slow computer, and a session that works again or gets
// a card while an earlier end is still on its way is left and named, never ended with the state it had at the start.
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
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, disabled: false });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  set textContent(t) { this.children = [new FakeText(t)]; }
  get textContent() { return texts(this).join(''); }
}
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const all = (e) => e.children.filter((c) => c instanceof FakeElement).flatMap((c) => [c, ...all(c)]);
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };


const { closeWaited, resultLines } = await import('../../web/closesheet.js');
const NOW = 1_800_000_000_000;
const H = 3600_000;
const s = (name, machine, age, extra = {}) => ({ name, display: `${name} title`, kind: 'claude', status: 'waiting', statusAt: NOW - age, machine, machineLabel: machine || 'This computer', ...extra });
const asMachines = (list) => {
  const byM = new Map();
  for (const x of list) {
    const k = x.machine ?? null;
    if (!byM.has(k)) byM.set(k, { machine: k, status: 'online', sessions: [] });
    byM.get(k).sessions.push(x);
  }
  return [...byM.values()];
};

test('a session that changes while an earlier end is on its way is left, not ended as it was', async () => {
  const list = [s('shop', null, 7 * H), s('alpha', 'box2', 30 * H), s('docs', 'box2', 50 * H)];
  let live = list.map((x) => ({ ...x }));
  const kills = [];
  const result = await closeWaited(list, {
    read: async () => ({ machines: asMachines(live) }),
    kill: async (x) => {
      kills.push(x.name);
      live = live.filter((y) => y.name !== x.name);
      // While the end of shop is on its way, alpha starts working again and docs gets a card.
      if (x.name === 'shop') live = live.map((y) => (y.name === 'alpha' ? { ...y, status: 'working', statusAt: NOW } : y.name === 'docs' ? { ...y, askCard: { kind: 'notice' } } : y));
    },
  });
  assert.deepEqual(kills, ['shop'], 'only the one still as the sheet showed it');
  assert.deepEqual(result.left.map(({ s: x, why }) => [x.name, why]), [['alpha', 'it started working again'], ['docs', 'it has a question for you']]);
  assert.deepEqual(resultLines(result), ['Ended 1 session.', 'Left open: alpha title (it started working again), docs title (it has a question for you).']);
});

test('each end has its own read: a read that fails leaves that one open and the next is read again', async () => {
  const list = [s('shop', null, 7 * H), s('alpha', null, 30 * H)];
  let reads = 0;
  const kills = [];
  const result = await closeWaited(list, {
    read: async () => {
      reads++;
      if (reads === 1) throw new Error('Cannot reach the computer.');
      return { machines: asMachines(list) };
    },
    kill: async (x) => kills.push(x.name),
  });
  assert.equal(reads, 2, 'one read before each end');
  assert.deepEqual(kills, ['alpha']);
  assert.deepEqual(result.failed.map(({ s: x, why }) => [x.name, why]), [['shop', 'Cannot reach the computer.']]);
});
