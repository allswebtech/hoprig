// Which coding tools a page offers a chat in (web/chat/start.js): they are asked of the computer whose screen is
// open (Workspace, the schedule form), never of this one by mistake, and "Open as chat" on a terminal of another
// tool is offered unless that computer is known not to have a chat for it.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
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

const asked = [];
const lists = {
  '/api/chats/tools': [{ id: 'claude', name: 'Claude Code' }],
  '/m/laptop/api/chats/tools': [{ id: 'claude', name: 'Claude Code' }, { id: 'opencode', name: 'OpenCode' }],
  '/m/pc3/api/chats/tools': [{ id: 'claude', name: 'Claude Code' }],
};
globalThis.fetch = async (url) => {
  asked.push(url);
  return { ok: true, status: 200, json: async () => ({ tools: lists[url] || [] }) };
};

const { machine } = await import('../../web/lib.js');
const S = await import('../../web/chat/start.js');

test('the coding tools are asked of the computer whose screen is open; null is this computer', async () => {
  machine.set('laptop');
  try {
    assert.deepEqual((await S.chatTools()).map((t) => t.id), ['claude', 'opencode']);
    assert.equal(asked.at(-1), '/m/laptop/api/chats/tools', 'Workspace and the schedule form of another computer list its tools');
    assert.deepEqual(S.knownChatTools().map((t) => t.id), ['claude', 'opencode']);
    assert.deepEqual((await S.chatTools(null)).map((t) => t.id), ['claude']);
    assert.equal(asked.at(-1), '/api/chats/tools', 'null: this computer, whatever screen is open');
  } finally {
    machine.set(null);
  }
});

test('"Open as chat" on another tool\'s terminal: offered until the computer is known not to have its chat', async () => {
  const oc = { kind: 'claude', tool: 'opencode', name: 'oc-1', sessionId: 'ses_x' };
  const claude = { kind: 'claude', name: 'cc-1', sessionId: 'x' };
  assert.equal(S.opensAsChat(oc, 'pc3'), true, 'not known yet: offered (the computer refuses a tool that is off)');
  assert.ok(asked.includes('/m/pc3/api/chats/tools'), 'and its list is asked for');
  await S.chatTools('pc3');
  assert.equal(S.opensAsChat(oc, 'pc3'), false, 'known: that computer has no chat for OpenCode');
  assert.equal(S.opensAsChat(claude, 'pc3'), true, 'Claude Code\'s always');
  await S.chatTools('laptop');
  assert.equal(S.opensAsChat(oc, 'laptop'), true);
});
