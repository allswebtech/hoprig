// A gateway whose program was not found: the Providers page says what Hoprig starts it with, from GET /api/gateways,
// and no longer sends him to a terminal to run hoprig gateways.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => t, getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const { programFacts } = await import('../../web/gateways.js');

test('the program and its words are shown on the page', () => {
  const [text, runs] = programFacts('Relay', { id: 'relay', runs: ['/opt/relay/bin/relay', '--port', '4000'], needsConfirm: null });
  assert.match(text, /^Relay is defined on this computer, but its program was not found\. Hoprig starts it with:$/);
  assert.equal(runs, '/opt/relay/bin/relay --port 4000');
});

test('why a program of his own waits is said in plain words', () => {
  const [text] = programFacts('Relay', { runs: ['relay'], needsConfirm: 'changed' });
  assert.match(text, /changed since you confirmed it/);
});

test('when the route does not answer, a plain step and no command', () => {
  const [text, runs] = programFacts('Relay', null);
  assert.equal(runs, null);
  assert.match(text, /Install its program on this computer, then try again\./);
});

test('the Providers page no longer sends him to a terminal for hoprig gateways', () => {
  const src = fs.readFileSync(new URL('../../web/accounts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /In a terminal there, \$\{COMMAND\} gateways shows what it runs/);
  assert.match(src, /programFacts\(/);
});
