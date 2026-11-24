// A computer that no longer lets this dashboard in: Setup, Health and Advanced say only what is true of it. Setup's
// reason has one period and no advice to look at Overview; Health's red box names the state, not "never reached";
// Advanced offers neither the move to an ordinary user nor power, which could not reach it.
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
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.location ??= { hostname: '127.0.0.1', pathname: '/', hash: '', origin: 'http://127.0.0.1' };
globalThis.fetch = () => new Promise(() => {}); // the move box asks whether a move runs: never answered here

const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const words = (nodes) => [nodes].flat().filter(Boolean).flatMap(texts).join(' ');
const pc = await import('../../web/pc.js');
const health = await import('../../web/health.js');
const setup = await import('../../web/pcsetup.js');

const refused = { machine: 'oldbox', machineLabel: 'Old box', status: 'unauthorised' };
const online = { machine: 'oldbox', machineLabel: 'Old box', status: 'online' };
const reason = 'Old box no longer lets this dashboard in. Add it again here: Computers → Add a computer.';

test('Setup: one period after the reason, and no Overview advice for a computer that refuses us', () => {
  const e = Object.assign(new Error(reason), { code: 'computer-not-allowed' });
  const line = setup.checkFailWords(e);
  assert.equal(line, reason);
  assert.doesNotMatch(line, /\.\./);
  assert.doesNotMatch(line, /Overview|check again/);
  // A computer that does not answer keeps the advice, with one period between.
  const off = setup.checkFailWords(Object.assign(new Error('Old box does not answer.'), { code: 'offline' }));
  assert.equal(off, 'Old box does not answer. If it is another computer, see whether it answers on Overview, then check again.');
  assert.equal(setup.checkFailWords(new Error('Request failed (502)')), 'Request failed (502). If it is another computer, see whether it answers on Overview, then check again.');
});

test('Health: the red box names the state of a computer that refuses us, never "never reached"', () => {
  const w = health.unreachedWords({ state: 'unauthorised', seenAt: null }, 'Old box');
  assert.equal(w.head, 'Old box: Not allowed any more.');
  assert.doesNotMatch(`${w.head} ${w.hint}`, /never reached|not reached since|until it answers/);
  assert.match(w.hint, /Do what the line above says, then press Refresh\./);
  // The other states keep their words.
  assert.equal(health.unreachedWords({ state: 'offline', seenAt: null }, 'Old box').head, 'Old box was never reached from here.');
  assert.match(health.unreachedWords({ state: 'offline', seenAt: null }, 'Old box').hint, /Check that it is on and online/);
  assert.match(health.unreachedWords({ state: 'hostkey', seenAt: null }, 'Old box').hint, /Its host key shows both prints/);
  assert.match(health.unreachedWords({ state: 'too-old', seenAt: Date.now() }, 'Old box').head, /^Old box was not reached since /);
});

test('Advanced: no move and no power while it refuses us; both, with its label, once it answers', () => {
  const powerBtn = (action, label) => Object.assign(new FakeElement('button'), { children: [new FakeText(label)] });
  const powerMsg = new FakeElement('div');
  const ctx = (m) => ({ entry: () => m, label: () => (m && m.machineLabel) || 'oldbox' });
  const none = words(pc.advancedActs(ctx(refused), 'oldbox', { powerBtn, powerMsg }));
  assert.doesNotMatch(none, /Move Hoprig|Show what the move does|Restart|Shut down/);
  const both = words(pc.advancedActs(ctx(online), 'oldbox', { powerBtn, powerMsg }));
  assert.match(both, /Move Hoprig to an ordinary user/);
  assert.match(both, /Where Hoprig works as root on Old box \(added by SSH\)/);
  assert.doesNotMatch(both, /on oldbox/);
  assert.match(both, /Restart/);
  assert.match(both, /Shut down/);
  // This computer: power, and no move (that is another computer's).
  const here = words(pc.advancedActs(ctx(null), null, { powerBtn, powerMsg }));
  assert.match(here, /Restart/);
  assert.doesNotMatch(here, /Move Hoprig/);
});
