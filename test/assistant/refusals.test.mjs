// Tia's tools against the dashboard's "one conversation, one process" refusals (src/runs.mjs heldBefore, src/chat/handoff.mjs
// claim, src/server/deck.mjs move): a start that started nothing is never reported as started, and every refusal comes
// to her as the dashboard's plain sentence with a next step, never as a raw error.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const API = '/home/owner/projects/api';
const CONV = '66666666-6666-4666-8666-666666666666';
const refused = (message) => Object.assign(new Error(message), { status: 409 });

function setup() {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'handsoff' };
  s.conversations[API].push({ id: CONV, at: Date.now(), title: 'Refactor' });
  const ops = new FakeOps(s);
  const core = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }),
  });
  return { ops, core, call: (tool, args) => core.call(tool, args, { conversation: 'c1' }) };
}

test('start_chat whose first message the dashboard did not send (a terminal or another chat runs it): "opened", not "started", and what to do next', async () => {
  for (const why of ['a terminal session runs this conversation', 'another chat runs this conversation right now']) {
    const { call, ops } = setup();
    const open = ops.startChat.bind(ops);
    ops.startChat = async (a) => ({ ...(await open(a)), sent: false, why }); // the chat reads along; nothing runs in it
    await call('list_projects', { folder: API });
    const r = await call('start_chat', { folder: API, account: 'sub', conversation: CONV, message: 'go on' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^Opened chat chat:/, why);
    assert.doesNotMatch(r.text, /Started/, `${why}: no start is reported`);
    assert.ok(r.text.includes('The first message was NOT sent: the conversation runs elsewhere (why_not_sent in the data). Read it with read_session and send it with send_to_chat once that has ended, or ask the owner'), r.text);
    // The computer's own sentence is data: in the fence, never on the summary line.
    assert.ok(!r.text.split('\n')[0].includes(why), r.text);
    assert.ok(r.text.includes(`"why_not_sent":"${why}"`), r.text);
    assert.match(r.text, /"message_sent": ?false/);
  }
});

test('a start or a move the dashboard refuses with 409: her result is its sentence and a next step, and nothing is said to have happened', async () => {
  const cases = [
    ['start_chat', { folder: API, account: 'sub', conversation: CONV, message: 'go on' }, 'startChat', 'another chat runs this conversation right now'],
    ['start_session', { folder: API, account: 'sub', mode: 'resume', conversation: CONV, message: 'go on' }, 'startSession', 'This conversation runs in a terminal outside the dashboard: it cannot run in a second one.'],
    ['switch_account', { session: 'api-fix', account: 'sub2' }, 'switchAccount', 'This session has just moved to another provider. Look at it again before moving it.'],
  ];
  for (const [tool, args, op, sentence] of cases) {
    const { call, ops, core } = setup();
    core.jobs.markStarted('this', 'api-fix', 1_700_000_001_000); // hers: her move runs at once, no card
    ops[op] = async () => {
      throw refused(sentence);
    };
    await call('list_projects', { folder: API });
    await call('list_sessions', {});
    const r = await call(tool, args);
    assert.equal(r.isError, true, `${tool}: ${r.text}`);
    assert.ok(r.text.includes(sentence.replace(/\.$/, '')), `${tool}: the dashboard's own words (${r.text})`);
    assert.match(r.text, / Next: \S/, `${tool}: a next step`);
    assert.doesNotMatch(r.text, /Started|now continues on|\bat [A-Za-z]+\.mjs:\d|Error: Error|\[object/, `${tool}: no start, no move, no raw error`);
  }
});

test('start_session on a conversation that a chat runs: nothing started, that chat named, a next step', async () => {
  const { call, ops } = setup();
  ops.s.sessions.push({ computer: 'this', name: `chat:${CONV}`, kind: 'chat', chatId: CONV, status: 'working', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: API, title: 'Refactor', lastMessage: '', note: '', limit: null, sessionId: CONV, statusAt: Date.now(), created: 1_700_000_009_000 });
  await call('list_projects', { folder: API });
  const before = ops.s.sessions.length;
  const r = await call('start_session', { folder: API, account: 'sub', mode: 'resume', conversation: CONV, message: 'go on' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`Nothing was started: this conversation already runs in the chat chat:${CONV}.*the first message was not sent\\. Read it there \\(read_session\\), or ask the owner`));
  assert.equal(ops.s.sessions.length, before);
});
