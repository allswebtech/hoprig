// New session's parts for the coding tool (web/newsession-tools.js), in a small stand-in DOM: the tool choice is a
// row of toggle buttons in plain words, another tool's terminal asks first unless the owner chose otherwise (its own
// defaults are an explicit choice, with the warning at once), and a warning line follows the choice as it changes.
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
});

test('the coding tool choice: toggle buttons that say what a press does', () => {
  const chosen = [];
  const row = T.toolButtons({ tools: [{ id: 'claude', name: 'Claude Code' }, { id: 'opencode', name: 'OpenCode' }], chosen: 'opencode', choose: (id, pressed) => chosen.push([id, pressed]) });
  assert.equal(row.attrs.role, 'group');
  const buttons = all(row).filter((x) => x.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.attrs['aria-pressed']), ['false', 'true'], 'pressed, not a radio that keeps a choice');
  assert.ok(!buttons.some((b) => b.attrs.role === 'radio'));
  assert.match(text(buttons[0]), /Use for the next chat/);
  assert.match(text(buttons[1]), /Chosen/);
  assert.doesNotMatch(text(row), /Tap/);
  buttons[1].listeners.click();
  buttons[0].listeners.click();
  assert.deepEqual(chosen, [['', 'opencode'], ['claude', 'claude']], 'a second press leaves it to each project; the pressed one keeps the focus');
});
