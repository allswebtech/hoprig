// Five acts she could not do before, as actions of the tools she has (no new tool): rename, close or move a chat into
// a terminal (send_to_chat name / close / terminal), open a terminal's conversation as a chat and carry a session on
// after its usage limit (send_to_session to_chat / continue). Each is checked again by the core, one line in the audit
// log, a card where the chat is not hers, and refused at the door with any field the route does not need.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { TOOLS } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const ID = '77777777-7777-4777-8777-777777777701';
function setup({ level = 'work', byTia = true } = {}) {
  const s = baseState();
  s.assistant.level = level;
  s.sessions.push({ computer: 'this', name: `chat:${ID}`, kind: 'chat', chatId: ID, byTia, status: 'waiting', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/api', title: 'Login fix', lastMessage: '', note: '', limit: null, sessionId: ID, statusAt: Date.now(), created: 1 });
  s.sessions.find((c) => c.name === 'api-fix').limit = { text: 'usage limit', until: Date.now() - 1000 };
  const ops = new FakeOps(s);
  const audit = new AuditLog({ file: null });
  const jobs = new JobStore({ dir: null });
  const core = createAssistantCore({ ops, audit, cards: new CardStore(), jobs });
  core.shown.add('c1', { session: [`this|chat:${ID}`, 'this|api-fix', 'this|web-ui'] });
  const call = (tool, args) => core.call(tool, args, { conversation: 'c1' });
  const writes = () => ops.calls.map((c) => c.op);
  // A terminal she started herself: the jobs' mark of that very terminal (its name and when it was made).
  const hers = (name) => jobs.markStarted('this', name, s.sessions.find((c) => c.name === name).created);
  return { ops, core, call, audit, writes, hers };
}

test('rename, close and move her own chat run at once, each once, with one audit line', async () => {
  for (const [args, op] of [[{ name: 'Login fix, part two' }, 'renameChat'], [{ close: true }, 'closeChat'], [{ terminal: true }, 'chatToTerminal']]) {
    const { call, audit, writes } = setup();
    const r = await call('send_to_chat', { session: `chat:${ID}`, ...args });
    assert.equal(r.isError, false, r.text);
    assert.ok(!r.card);
    assert.deepEqual(writes(), [op]);
    assert.match(r.text, /Next:|start_chat with conversation/);
    assert.equal(audit.memory.filter((e) => e.outcome === 'done').length, 1);
    assert.equal(audit.memory[0].door, 'team');
  }
});

test('closing or moving a chat she did not start is a card, at every level; a name is not', async () => {
  for (const level of ['work', 'handsoff']) {
    const { call, writes } = setup({ level, byTia: false });
    for (const args of [{ close: true }, { terminal: true }]) {
      const r = await call('send_to_chat', { session: `chat:${ID}`, ...args });
      assert.ok(r.card, r.text);
      assert.match(r.card.lines.join('\n'), /did not start this chat/);
    }
    assert.deepEqual(writes(), []);
  }
  const { call } = setup({ level: 'ask' });
  assert.ok((await call('send_to_chat', { session: `chat:${ID}`, close: true })).card);
});

test('carry on after a limit only when the session waits at one; open a terminal as a chat (in sessions she started)', async () => {
  let { call, writes, hers } = setup();
  hers('api-fix');
  let r = await call('send_to_session', { session: 'api-fix', continue: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(writes(), ['continueSession']);
  // A limit whose time has not come yet: nothing is typed.
  let ops;
  ({ call, writes, ops, hers } = setup());
  hers('api-fix');
  const later = Date.now() + 3 * 3600_000;
  ops.s.sessions.find((c) => c.name === 'api-fix').limit.until = later;
  r = await call('send_to_session', { session: 'api-fix', continue: true });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, new RegExp(`waits at its usage limit until ${new Date(later).toISOString()}.*Next: wait until then, or move it to another provider with switch_account`));
  assert.deepEqual(writes(), []);
  ({ call, writes, hers } = setup());
  hers('web-ui');
  r = await call('send_to_session', { session: 'web-ui', continue: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /does not wait at a usage limit.*Next: read_session/);
  assert.deepEqual(writes(), []);
  ({ call, writes, hers } = setup());
  hers('web-ui');
  r = await call('send_to_session', { session: 'web-ui', to_chat: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(writes(), ['chatFromSession']);
  assert.match(r.text, /its OKs are the owner's/);
});

test('one act per call: two at once, or an act with a stray field, is an error with its one recovering step', async () => {
  const { call, writes } = setup();
  assert.match((await call('send_to_chat', { session: `chat:${ID}`, close: true, name: 'x' })).text, /exactly one of .*Next: call send_to_chat again/);
  assert.match((await call('send_to_session', { session: 'api-fix', continue: true, to_chat: true })).text, /give one of .*Next: call send_to_session again/);
  assert.match((await call('send_to_chat', { session: `chat:${ID}`, name: '   ' })).text, /cannot be empty/);
  assert.match((await call('send_to_chat', { session: 'api-fix', close: true })).text, /is not a chat.*send_to_session/);
  assert.deepEqual(writes(), []);
});

test('the door takes these routes only with the fields her tools send', () => {
  const ok = (m, p, b) => checkRoute(m, p, b, { config: () => ({}) });
  const no = (m, p, b) => assert.throws(() => ok(m, p, b), (e) => e.status === 403, `${p} ${JSON.stringify(b)}`);
  ok('POST', `/api/chats/${ID}/title`, { title: 'x' });
  no('POST', `/api/chats/${ID}/title`, { title: 'x', owner: true });
  ok('POST', `/api/chats/${ID}/close`, {});
  no('POST', `/api/chats/${ID}/close`, { force: true });
  ok('POST', `/api/chats/${ID}/terminal`, {});
  ok('POST', '/api/chats/from-session', { session: 'web-ui' });
  no('POST', '/api/chats/from-session', { session: 'web-ui', byTia: true });
  ok('POST', '/api/sessions/api-fix/continue', {});
  no('POST', '/api/sessions/api-fix/continue', { restart: true }); // a restart in place is the page's own button
});

test('still 25 tools: the new acts are actions of tools she had', () => {
  assert.equal(TOOLS.length, 25);
  const props = (n) => Object.keys(TOOLS.find((t) => t.name === n).input.json.properties);
  for (const k of ['name', 'close', 'terminal']) assert.ok(props('send_to_chat').includes(k), k);
  for (const k of ['continue', 'to_chat']) assert.ok(props('send_to_session').includes(k), k);
});

// A chat given to the terminal tool: the one step that recovers names every act send_to_chat has now.
test('a chat passed to send_to_session is refused with the step that names send_to_chat\'s acts', async () => {
  const { call, writes } = setup();
  const r = await call('send_to_session', { session: `chat:${ID}`, name: 'login-fix' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /Next: use send_to_chat \(text, answer, stop, name, close or terminal\); read_session shows its status/);
  assert.deepEqual(writes(), []);
});

// "Carry on there on its own provider", the provider being a paid one she may not use: a move onto it is no move, and
// its refusal names the act that carries on, not another provider.
test('switch_account onto the provider the session is on already is refused with send_to_session continue as next', async () => {
  const { call, writes, ops } = setup();
  ops.s.sessions.find((c) => c.name === 'api-fix').profile = { name: 'api', label: 'API key', kind: 'api' };
  const r = await call('switch_account', { session: 'api-fix', account: 'api' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /api-fix already runs on api.*Next: to carry on on the same provider after its usage limit use send_to_session continue: true/);
  assert.doesNotMatch(r.text, /not one Tia may use/);
  assert.deepEqual(writes(), []);
});

test('carrying on or showing as a chat a session he started is a card at every level; in hers it runs at once', async () => {
  for (const level of ['work', 'handsoff', 'ask']) {
    for (const [session, args] of [['api-fix', { continue: true }], ['web-ui', { to_chat: true }]]) {
      const { call, writes } = setup({ level });
      const r = await call('send_to_session', { session, ...args });
      assert.ok(r.card, `${level} ${session}: ${r.text}`);
      assert.match(r.card.lines.join('\n'), /did not start this session|the owner set "Ask me"/);
      assert.deepEqual(writes(), [], `${level} ${session}`);
    }
  }
  for (const level of ['work', 'handsoff']) {
    for (const [session, args, op] of [['api-fix', { continue: true }, 'continueSession'], ['web-ui', { to_chat: true }, 'chatFromSession']]) {
      const { call, writes, hers } = setup({ level });
      hers(session);
      const r = await call('send_to_session', { session, ...args });
      assert.ok(!r.card, `${level} ${session}: a card for her own session`);
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(writes(), [op]);
    }
  }
});
