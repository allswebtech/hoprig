// New session's parts for the coding tool (web/newsession-tools.js), in a small stand-in DOM: another tool's terminal
// asks first unless the owner chose otherwise (its own defaults are an explicit choice, with the warning at once), and
// a warning line follows the choice as it changes. The popup itself: web-newsession-popup.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    const cls = new Set();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
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

const T = await import('../../web/newsession-tools.js');
const all = (n, out = []) => {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
};
const text = (n) => all(n).map((x) => x.text || x.textContent || '').join(' ');

test('another tool\'s terminal asks first; its own defaults are a choice that says what they allow', () => {
  assert.equal(T.terminalMode(''), 'ask', 'nothing chosen: it asks first');
  assert.equal(T.terminalMode('ask'), 'ask');
  assert.equal(T.terminalMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(T.terminalMode('own'), null, 'only when chosen: the tool\'s own rules');
  const st = { profile: '', permissionMode: '', effort: '' };
  const info = { modes: ['manual', 'acceptEdits', 'bypassPermissions'], modeWords: { manual: { chip: 'Ask first' } }, efforts: ['low', 'max'] };
  const [, mode] = T.otherToolOptions({ st, info, name: 'OpenCode', profiles: [], chat: false, same: 'As in Settings' });
  const sel = all(mode).find((x) => x.tag === 'select');
  const options = all(sel).filter((x) => x.tag === 'option');
  assert.deepEqual(options.map((o) => o.value), ['ask', 'own', 'bypassPermissions']);
  assert.deepEqual(options.filter((o) => 'selected' in o.attrs).map((o) => o.value), ['ask'], 'Ask first is preselected');
  assert.match(text(options.find((o) => o.value === 'own')), /OpenCode's own defaults: edits and runs commands without asking/);
  const hint = all(mode).find((x) => /hint/.test(x.className));
  assert.equal(hint.classList.contains('hidden'), true, 'no warning while it asks');
  // The warning comes with the choice, not after something else draws the Options again.
  sel.listeners.change({ target: { value: 'bypassPermissions' } });
  assert.equal(st.permissionMode, 'bypassPermissions');
  assert.equal(hint.classList.contains('hidden'), false);
  assert.match(hint.textContent, /can run any command and change any file without asking/);
  sel.listeners.change({ target: { value: 'own' } });
  assert.match(hint.textContent, /without asking/);
  sel.listeners.change({ target: { value: 'ask' } });
  assert.equal(hint.classList.contains('hidden'), true);
  // In a chat, the tool's own modes, and "as your last chat" first.
  const [, chatMode] = T.otherToolOptions({ st: { permissionMode: '' }, info, name: 'OpenCode', profiles: [], chat: true, same: 'As your last chat in the project' });
  assert.deepEqual(all(chatMode).filter((x) => x.tag === 'option').map((o) => o.value), ['', 'manual', 'acceptEdits', 'bypassPermissions']);
  // A chat's bypass is Hoprig's own: it says what it still puts to the owner.
  const chatSel = all(chatMode).find((x) => x.tag === 'select');
  chatSel.listeners.change({ target: { value: 'bypassPermissions' } });
  assert.match(all(chatMode).find((x) => /hint/.test(x.className)).textContent, /^OpenCode runs commands and changes files without asking\. Hoprig asks you first only when a command names a delete in plain sight \(rm, find -delete, git clean and a few more\) that is not plainly inside the folder it runs in\. It is no wall: a script, a program or a command written to get around it can still delete\. What your own OpenCode settings deny stays denied\.$/);
});
