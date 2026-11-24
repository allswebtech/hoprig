// The list of computers: one that does not answer says what to do next, not "Offline · Linux".
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, children: [] });
  }
  setAttribute() {}
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => t, getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { computerLine } = await import('../../web/computers.js');

test('an offline computer: "Cannot be reached · open it to see what to check"', () => {
  const off = computerLine({ machine: 'nas', machineLabel: 'NAS', status: 'offline' }, { platform: 'linux', claude: null });
  assert.equal(off.first, 'Cannot be reached · open it to see what to check');
  assert.equal(off.online, false);
  // Another state keeps its own words; an online one keeps its system and sessions.
  assert.match(computerLine({ machine: 'nas', status: 'unauthorised' }, null).first, /^Not allowed any more/);
  assert.equal(computerLine({ machine: 'nas', status: 'online', sessions: [1] }, { platform: 'linux' }).first, 'Online · Linux · 1 session');
});
