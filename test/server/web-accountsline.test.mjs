// Home's near-limit line (web/home.js accountsLine): one line per provider, said once with the computers it is used on
// after it, and what happens when it runs out only when another provider is free.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { accountsLine } = await import('../../web/home.js');
const acct = (label, pct, extra = {}) => ({ name: label.toLowerCase(), label, kind: 'subscription', usage: pct === null ? null : { fiveHour: { pct } }, ...extra });

test('the same provider near its limit on two computers is one line, its computers after it', () => {
  const line = accountsLine([
    { machine: null, machineLabel: 'Workstation', profiles: [acct('Claude Max', 96), acct('Team plan', 10)] },
    { machine: 'lap', machineLabel: 'Laptop', profiles: [acct('Claude Max', 96)] },
  ], true);
  assert.deepEqual(line.lines, ['Claude Max is almost used up (96% of its 5-hour limit), on Workstation and Laptop. When it runs out, sessions can go on with Team plan.']);
  assert.equal(line.warn, true);
  assert.equal(line.text, line.lines[0]);
});

test('no other free provider: no promise of one', () => {
  const line = accountsLine([{ machine: null, machineLabel: 'Desk', profiles: [acct('Max', 96)] }], false);
  assert.deepEqual(line.lines, ['Max is almost used up (96% of its 5-hour limit).'], 'one computer: not named');
});

test('two providers near a limit: one line each; one at its limit says where sessions go on', () => {
  const line = accountsLine([
    { machine: null, machineLabel: 'A', profiles: [acct('Max', 20, { limited: {} }), acct('Pro', 92), acct('Team', 5)] },
    { machine: 'b', machineLabel: 'B', profiles: [acct('Max', 20, { limited: {} })] },
  ], true);
  assert.deepEqual(line.lines, [
    'Max is at its limit, on A and B. Sessions can go on with Team.',
    'Pro is almost used up (92% of its 5-hour limit), on A. When it runs out, sessions can go on with Team.',
  ]);
});

test('the quiet line stays as it was', () => {
  assert.deepEqual(accountsLine([{ machineLabel: 'A', profiles: [acct('Max', 40), acct('Team', 10)] }], false), { text: '2 providers · all available', warn: false, lines: [] });
  assert.deepEqual(accountsLine([{ machineLabel: 'A', profiles: [{ label: 'Pro', signedIn: false }, { label: 'Max', signedIn: true }] }], false).text, '2 providers · 1 not signed in');
  assert.equal(accountsLine([{ machineLabel: 'A', profiles: [] }], false).warn, true);
});
