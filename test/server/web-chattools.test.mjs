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
  '/m/box3/api/chats/tools': [{ id: 'claude', name: 'Claude Code' }],
};
const posted = [];
let answerOf = null; // what the fake POST /api/chats answers
globalThis.location = { hash: '', pathname: '/', replace() {} };
globalThis.fetch = async (url, init = {}) => {
  asked.push(url);
  if (init.method === 'POST') {
    posted.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => answerOf };
  }
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
  assert.equal(S.opensAsChat(oc, 'box3'), true, 'not known yet: offered (the computer refuses a tool that is off)');
  assert.ok(asked.includes('/m/box3/api/chats/tools'), 'and its list is asked for');
  await S.chatTools('box3');
  assert.equal(S.opensAsChat(oc, 'box3'), false, 'known: that computer has no chat for OpenCode');
  assert.equal(S.opensAsChat(claude, 'box3'), true, 'Claude Code\'s always');
  await S.chatTools('laptop');
  assert.equal(S.opensAsChat(oc, 'laptop'), true);
});

test('a worktree start on a computer that does not answer with it (an older version) says so; an answer with it says nothing', async () => {
  const lib = await import('../../web/lib.js');
  const toasts = [];
  const orig = globalThis.document.createElement;
  // toast() builds its box from the page's own helpers; its text is what the owner reads: collect the text nodes it makes
  globalThis.document.createTextNode = (t) => (toasts.push(String(t)), { text: t });
  answerOf = { id: 'old1' };
  await S.startChat('/p/shop', { worktree: true });
  assert.equal(posted.at(-1).worktree, true);
  assert.ok(toasts.some((t) => /does not offer a branch of its own yet/.test(t)), 'the owner is told: ' + toasts.join('|'));
  toasts.length = 0;
  answerOf = { id: 'new1', worktree: { branch: 'worktree-chat-aaaaaa' } };
  await S.startChat('/p/shop', { worktree: true });
  answerOf = { id: 'plain1' };
  await S.startChat('/p/shop', {});
  assert.deepEqual(toasts.filter((t) => /branch of its own/.test(t)), [], 'no notice when it was answered, or not asked for');
  globalThis.document.createElement = orig;
  assert.ok(lib);
});
