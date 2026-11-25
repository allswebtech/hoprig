// Settings → Tia's sentence (web/tia.js spentWords) in the three states of a part of Tia's Lead session, from the
// figures of the ledger itself (src/assistant/spend.mjs detail): a part runs; a part ended and reported its cost; a
// part was cut before it reported. A cut part's rest is counted for the day as what could not be measured, never
// said as spent. The chats are made up; nothing is asked of a provider.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const tia = await import('../../web/tia.js');
const { SpendLedger } = await import('../../src/assistant/spend.mjs');

const KEY = 'this|chat:made-up-part';
/** A $3 limit; a part with a $1 budget that has cost $0.30 so far, inside a turn. */
function running() {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(3, { id: 'part-a', amount: 1 }), null);
  l.bind('part-a', KEY, 0, true);
  l.measure(KEY, 0.3, true);
  return l;
}
const words = (l) => tia.spentWords({ cap: 3, today: l.detail() });

test('a part runs: its budget less what it cost so far is held for it', (t) => {
  const l = running();
  const d = l.detail();
  t.diagnostic(`FIG runs detail=${JSON.stringify(d)} left=${l.left(3)} words=${words(l)}`);
  assert.deepEqual(d, { spent: 0.3, held: 0.7, unmeasured: 0, tapped: 0, parts: 1, partsHeld: 0.7 });
  assert.equal(l.left(3), 2);
  assert.equal(words(l), 'Today: $0.30 spent. $0.70 is held for a part that runs now (a part is a piece of a task that a session handed to another provider); when a part ends, what it cost counts in its place. $1.00 of your $3.00 daily limit is used.');
});

test('a part ended and reported its cost: what it cost, the rest is free again', (t) => {
  const l = running();
  l.measure(KEY, 0.4, false);
  assert.equal(l.settleParts(KEY), 1);
  const d = l.detail();
  t.diagnostic(`FIG reported detail=${JSON.stringify(d)} left=${l.left(3)} words=${words(l)}`);
  assert.deepEqual(d, { spent: 0.4, held: 0, unmeasured: 0, tapped: 0 });
  assert.equal(l.left(3), 2.6);
  assert.equal(words(l), 'Today: $0.40 spent. $0.40 of your $3.00 daily limit is used.');
});

test('a part was cut before it reported: the rest of its budget is counted as not measured, never said as spent', (t) => {
  const l = running();
  assert.equal(l.settleParts(KEY, { cut: true }), 1);
  const d = l.detail();
  t.diagnostic(`FIG cut detail=${JSON.stringify(d)} left=${l.left(3)} words=${words(l)}`);
  assert.deepEqual(d, { spent: 0.3, held: 0.7, unmeasured: 0, tapped: 0, cuts: 1, cutHeld: 0.7 });
  assert.equal(l.left(3), 2, 'counted for the day as before: $1 of the $3');
  const s = words(l);
  assert.equal(s, 'Today: $0.30 spent. $0.70 is counted for a part that stopped before it reported what its last turn cost: Hoprig could not measure it, so the rest of its budget stays counted until the day ends. $1.00 of your $3.00 daily limit is used.');
  assert.doesNotMatch(s, /\$1\.00 spent|runs now/, 'never its whole budget as spent, never as running');
  // Two cut parts: one figure for both, said as several.
  assert.equal(l.take(3, { id: 'part-b', amount: 0.5 }), null);
  l.bind('part-b', 'this|chat:made-up-other', 0, true);
  l.settleParts('this|chat:made-up-other', { cut: true });
  assert.match(words(l), /\$1\.20 is counted for 2 parts that stopped before they reported what their last turn cost: Hoprig could not measure it, so the rest of their budgets stays counted until the day ends\. \$1\.50 of your \$3\.00/);
});

test('a part whose end Hoprig did not see (the dashboard stopped while it ran): its own reason and its own sentence', (t) => {
  const l = running();
  assert.equal(l.settleParts(KEY, { unseen: true }), 1);
  const d = l.detail();
  t.diagnostic(`FIG unseen detail=${JSON.stringify(d)} left=${l.left(3)} words=${words(l)}`);
  assert.deepEqual(d, { spent: 0.3, held: 0.7, unmeasured: 0, tapped: 0, unseen: 1, unseenHeld: 0.7 });
  assert.equal(l.left(3), 2, 'counted for the day as a cut is: $1 of the $3');
  const s = words(l);
  assert.equal(s, 'Today: $0.30 spent. $0.70 is counted for a part whose end Hoprig did not see (the dashboard stopped while it ran): Hoprig could not measure what it cost, so the rest of its budget stays counted until the day ends. $1.00 of your $3.00 daily limit is used.');
  assert.doesNotMatch(s, /stopped before it reported/, 'not the sentence of a part cut inside a turn');
  // Beside a part cut inside a turn: each reason with its own figure.
  assert.equal(l.take(3, { id: 'part-b', amount: 0.5 }), null);
  l.bind('part-b', 'this|chat:made-up-other', 0, true);
  l.settleParts('this|chat:made-up-other', { cut: true });
  assert.match(words(l), /\$0\.50 is counted for a part that stopped before it reported what its last turn cost: .* \$0\.70 is counted for a part whose end Hoprig did not see/);
  // $1.50 of a $1.60 limit used: no room for another $0.50, so the refusal says what holds it.
  assert.match(l.take(1.6), /\$0\.50 counted for the rest of the budget of a part that stopped before it reported what its last turn cost, .*, \$0\.70 counted for the rest of the budget of a part whose end Hoprig did not see \(the dashboard stopped while it ran\)/);
});

// A budget hold an earlier run of the dashboard wrote (its mark is not this run's): the dashboard stopped while that
// part ran, and its process is not this dashboard's. It stays counted for the day (or until its chat starts again,
// which settles it with the same reason: test/models/partbudget.test.mjs), never as a part that runs now.
function restarted(clock) {
  const l = new SpendLedger({ file: null, now: () => clock.t });
  l.memory.push({ at: clock.t, kind: 'hold', id: 'part-old', usd: 1, run: 'earlier-run' });
  l.bind('part-old', KEY, 0, true);
  l.measure(KEY, 0.3, true);
  return l;
}

test('after a restart of the dashboard: a part held by an earlier run is said as one whose end Hoprig did not see, all day', (t) => {
  const clock = { t: new Date(2026, 10, 18, 9, 0).getTime() };
  const l = restarted(clock);
  clock.t = new Date(2026, 10, 18, 23, 59).getTime();
  const d = l.detail();
  const s = words(l);
  t.diagnostic(`FIG restarted detail=${JSON.stringify(d)} words=${s}`);
  assert.deepEqual(d, { spent: 0.3, held: 0.7, unmeasured: 0, tapped: 0, unseen: 1, unseenHeld: 0.7 }, 'at 23:59 still counted, not as running');
  assert.doesNotMatch(s, /runs now/);
  assert.match(s, /\$0\.70 is counted for a part whose end Hoprig did not see \(the dashboard stopped while it ran\)/);
  // The refusals say the same, and never "wait until a part ends": no part of this dashboard runs.
  assert.doesNotMatch(l.take(1.2), /runs now/);
  const short = l.take(1.05, { id: 'part-new', amount: () => 0.001 }); // less than a cent: too little
  assert.match(short, /a part whose end Hoprig did not see/);
  assert.match(short, /or wait for tomorrow$/);
  // A share for a new part counts no running part beside it: all that is free (2 allowed at once, none running).
  assert.equal(l.take(3, { id: 'part-new', amount: (x) => Math.floor(((3 - x.spent - x.held) / Math.max(1, 2 - (x.parts || 0))) * 100) / 100 }), null);
  assert.equal(l.heldFor('part-new'), 1);
  // The next day: nothing of it.
  clock.t = new Date(2026, 10, 19, 0, 1).getTime();
  assert.deepEqual(l.detail(), { spent: 0, held: 0, unmeasured: 0, tapped: 0 });
});

test('the limit\'s refusals name a cut part\'s rest apart from what was spent', () => {
  const l = running();
  l.settleParts(KEY, { cut: true });
  l.spent(1.8, 'her own turn');
  assert.match(l.take(3), /\(\$2\.80 of \$3\.00 used: \$2\.10 spent, \$0\.70 counted for the rest of the budget of a part that stopped before it reported what its last turn cost/);
  assert.match(l.take(2.81, { id: 'part-c', amount: 0.5 }), /too little left for another part \(\$2\.10 spent and \$0\.70 counted for the rest of the budget of a part that stopped/);
});
