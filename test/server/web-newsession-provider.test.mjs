// New session with no provider on the chosen computer (web/newsession-choice.js): the coding tool never reads "Ready";
// it says it needs a provider first, and the button goes to Providers on that computer.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    const cls = new Set();
    Object.assign(this, { tag, dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) };
    Object.defineProperty(this, 'className', { get: () => [...cls].join(' '), set: (v) => { cls.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) cls.add(c); } });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), addEventListener: () => {}, querySelector: () => null, documentElement: new FakeElement('html'), body: new FakeElement('body') };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.location = { hash: '#/', pathname: '/', search: '', protocol: 'http:', host: 'localhost', hostname: 'localhost', origin: 'http://localhost' };

const C = await import('../../web/newsession-choice.js');
const all = (n, out = []) => {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
};
const text = (n) => all(n).map((x) => x.text || '').join(' ').replace(/\s+/g, ' ').trim();

const claude = { id: 'claude', name: 'Claude Code', state: { ready: true } };
const opencode = { id: 'opencode', name: 'OpenCode', state: { ready: true } };

test('no provider on the chosen computer: the tool needs a provider first, never Ready', () => {
  const need = { ready: false, why: 'Needs a provider first', fix: 'Add provider', href: '#/providers', button: true };
  assert.deepEqual(C.providerState(claude, []), need, 'a computer with no provider at all');
  assert.deepEqual(C.providerState(claude, [{ name: 'auto', virtual: true }]), need, 'Auto alone serves nothing by itself');
  assert.deepEqual(C.providerState(opencode, [{ name: 'max', tools: ['claude'] }]), need, 'only providers of another tool');
  assert.deepEqual(C.providerState(claude, [], 'box2'), { ...need, href: '#/m/box2/providers' }, 'Providers of that computer');
  assert.deepEqual(C.providerState(claude, [{ name: 'max', tools: ['claude'] }]), { ready: true });
  assert.deepEqual(C.providerState(claude, null), { ready: true }, 'providers not known: the tool list decides');
  const off = { ...claude, state: { ready: false, why: 'Turned off' } };
  assert.equal(C.providerState(off, []), off.state, 'what was missing before is said first');
  assert.deepEqual(C.toolState({ on: true, providers: [] }), need, 'the tool list itself names no provider');
});

test('the one line that takes the projects\' place says what the tool needs, without Ready', () => {
  const t = { ...claude, state: C.providerState(claude, []) };
  assert.equal(C.lackLine(t), 'Claude Code: Needs a provider first.');
  assert.doesNotMatch(C.lackLine(t), /Ready/);
  assert.equal(t.state.href, '#/providers', 'the one button goes to Providers');
});
