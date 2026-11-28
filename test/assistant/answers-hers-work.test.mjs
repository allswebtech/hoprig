// "She answers the OKs of her Work runs" (assistant.answersHers): with the owner's switch on, an OK in the run of a Work
// task she started goes through the same rules as an OK in any session of hers (policy.mjs decideLevel): she allows by
// herself only looking inside the project and its own checks; everything else stays his card. Off, nothing changes.
// The dashboard is a stand-in (fake-dashboard.mjs): nothing is typed into a real session.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { SpendLedger } from '../../src/assistant/spend.mjs';
import { tapped } from './tapped.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const START = { action: 'start', task: 'fix-the-cart-total', brief: 'Make the cart total use the discount code. Do not push.', kind: 'code' };
const ask = (tool, judged, more = {}) => ({ type: 'permission', subject: judged.command || judged.file_path || '', tool, known: true, judged, request: 'r1', ...more });
const TEST_OK = ask('Bash', { command: 'npm test' });

/** Her Work run, started on his yes; the switch and her level as given. */
async function started({ level = 'work', on = true, cap = null } = {}) {
  const state = baseState();
  state.assistant = { ...state.assistant, enabled: true, level, answersHers: on, dailyCapUsd: cap };
  const ops = new FakeOps(state);
  let t = Date.now();
  const now = () => t;
  const audit = new AuditLog({ file: null, now });
  const core = createAssistantCore({
    ops, now, cards: new CardStore({ now }), audit, jobs: new JobStore({ dir: null, now }), skills: new Skills({ dirs: [] }), spend: new SpendLedger({ file: null, now }),
  });
  await core.call('manage_work', { action: 'list' }, { conversation: 'w1' });
  const id = /card (c_[0-9a-f]{12})/.exec((await core.call('manage_work', START, { conversation: 'w1' })).text)[1];
  assert.equal((await core.confirm(id)).ok, true);
  return { ops, core, audit, chat: ops.s.sessions.at(-1), run: ops.s.work.runs[0], later: (min) => (t += min * 60_000) };
}

/** The run asks for `ok`; one watcher tick wakes her; she answers `answer` in that wake. → { wake, r, typed } */
async function answerInWake(s, ok, answer = 'allow') {
  s.chat.status = 'working';
  await s.core.jobTick(s.ops.s.sessions);
  Object.assign(s.chat, { status: 'attention', ask: ok, note: `Claude asks to use ${ok.tool}` });
  const [wake] = await s.core.jobTick(s.ops.s.sessions);
  s.core.beginTurn('w1', { origin: 'job', job: wake.job, mode: wake.mode });
  const before = s.ops.calls.length;
  const r = await s.core.call('send_to_chat', { session: s.chat.name, answer }, { conversation: 'w1' });
  s.core.endTurn('w1');
  return { wake, r, typed: s.ops.calls.slice(before).map((c) => c.op) };
}
const hisCard = (x, why) => {
  assert.ok(x.r.card, x.r.text);
  assert.deepEqual(x.typed, [], 'nothing answered');
  if (why) assert.match(x.r.card.lines.join('\n'), why);
};

test('switch on: the run\'s OK to run the project\'s own tests is hers; Activity says she answered it and why', async () => {
  const s = await started();
  const x = await answerInWake(s, TEST_OK);
  assert.equal(x.wake.mode, 'answer');
  assert.match(x.wake.message, /The owner lets you answer the OKs of the Work runs you started/);
  assert.doesNotMatch(x.wake.message, /not yours: its OKs/);
  assert.equal(x.r.isError, false, x.r.text);
  assert.equal(x.r.card, undefined);
  assert.deepEqual(x.typed, ['answerChat']);
  assert.deepEqual(s.ops.calls.at(-1).args, { computer: 'this', id: s.chat.chatId, request: 'r1', allow: true, always: false });
  const done = s.audit.recent(20).find((e) => e.tool === 'send_to_chat' && e.outcome === 'done');
  assert.equal(done.level, 'L1');
  assert.equal(done.result.herWork, true);
  assert.equal(done.result.asked, 'npm test');
  const j = s.core.jobs.list()[0];
  assert.equal(j.state, 'working');
  assert.equal(j.steps, 1, 'it counts against the job\'s answers');
});

test('switch on: what stays his card in her Work run, each kind', async () => {
  const kinds = [
    // A push the wall holds in a session of hers: the chat keeps that OK for the owner.
    ['a wall-held push', ask('Bash', { command: 'git push origin main' }, { owner: true }), /keeps this OK for the owner/],
    ['a push the wall did not hold', ask('Bash', { command: 'git push origin main' }), /not on the short list/],
    ['a release', ask('Bash', { command: 'npm publish' }), /not on the short list/],
    ['a delete outside the folder', ask('Bash', { command: 'rm -rf /home/owner/projects/api' }), /not on the short list|outside/],
    ['an administrator command', ask('Bash', { command: 'sudo systemctl restart nginx' }), /not on the short list/],
    ['a Write', ask('Write', { file_path: '/home/owner/projects/shop/src/cart.js' }), /changing a file is yours/],
    ['a call her rules cannot judge', ask('mcp__x__y', { command: 'npm test' }, { known: false }), /not one Tia can judge/],
    ['an input cut short', ask('Bash', { command: 'npm test' }, { cut: true }), /too long to judge/],
  ];
  for (const [what, ok, why] of kinds) {
    const s = await started();
    const x = await answerInWake(s, ok);
    assert.equal(x.wake.mode, 'answer', what);
    hisCard(x, why);
  }
});

test('switch on: "do not ask again", text, a key, carrying on after a limit stay his card in her Work run', async () => {
  const s = await started({ level: 'handsoff' });
  // In the wake, "do not ask again" is refused outright (only allow may be hers); outside it, his card.
  const x = await answerInWake(s, { ...TEST_OK, canAlways: true }, 'allow_always');
  assert.equal(x.r.isError, true, x.r.text);
  assert.match(x.r.text, /the session of a Work run is the owner's/);
  assert.deepEqual(x.typed, []);
  const always = await s.core.call('send_to_chat', { session: s.chat.name, answer: 'allow_always' }, { conversation: 'w1' });
  assert.ok(always.card, always.text);
  assert.match(always.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
  for (const a of [{ text: 'Yes, go on and push it.' }, { stop: true }]) {
    const r = await s.core.call('send_to_chat', { session: s.chat.name, ...a }, { conversation: 'w1' });
    assert.ok(r.card, JSON.stringify(a));
    assert.match(r.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
  }
  assert.deepEqual(s.ops.calls.filter((c) => c.op === 'sendToChat' || c.op === 'answerChat' || c.op === 'stopChat'), []);
});

test('switch on: a no to her Work run\'s OK stays his, in a wake and outside one', async () => {
  const s = await started({ level: 'handsoff' });
  const x = await answerInWake(s, ask('Bash', { command: 'git push origin main' }), 'deny');
  assert.equal(x.r.isError, true, x.r.text);
  assert.match(x.r.text, /the session of a Work run is the owner's/);
  assert.deepEqual(x.typed, []);
  const r = await s.core.call('send_to_chat', { session: s.chat.name, answer: 'deny' }, { conversation: 'w1' });
  assert.ok(r.card, r.text);
  assert.match(r.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
  assert.deepEqual(s.ops.calls.filter((c) => c.op === 'answerChat'), []);
});

test('switch on: at "Ask me" every OK of her Work run is his', async () => {
  const s = await started({ level: 'ask' });
  const x = await answerInWake(s, TEST_OK);
  hisCard(x, /"Ask me"/);
});

test('switch on: a run on a provider billed by use: his card at "Do the work"; at "Hands off" only inside the daily limit', async () => {
  const paid = { name: 'api', label: 'API key', kind: 'api' };
  const s = await started({ level: 'work' });
  s.chat.profile = paid;
  hisCard(await answerInWake(s, TEST_OK), /billed by use/);
  // Hands off with no daily limit for paid use (none at first): the limit holds it, his card.
  const h = await started({ level: 'handsoff', cap: null });
  h.chat.profile = paid;
  hisCard(await answerInWake(h, TEST_OK));
  // Hands off inside a limit: hers, and held against it.
  const in2 = await started({ level: 'handsoff', cap: 5 });
  in2.chat.profile = paid;
  const x = await answerInWake(in2, TEST_OK);
  assert.deepEqual(x.typed, ['answerChat'], x.r.text);
  assert.ok(in2.core.spend.detail().held > 0, 'held against the daily limit');
});

test('switch on: another coding tool\'s OK in her Work run is his', async () => {
  const s = await started();
  s.chat.tool = 'opencode';
  hisCard(await answerInWake(s, TEST_OK), /OpenCode asks for this OK/);
});

test('switch on: a session he started, and a run she did not start (a mission\'s), are his', async () => {
  const s = await started();
  // His own chat (no mark of hers) and a run opened as "hers" for her safety but by the mission's engine (no job of hers).
  for (const extra of [{ byTia: false }, { byTia: false, hers: true }]) {
    const name = `chat:bbbbbbbb-bbbb-4bbb-8bbb-00000000000${s.ops.s.sessions.length % 10}`;
    s.ops.s.sessions.push({ computer: 'this', name, kind: 'chat', chatId: name.slice(5), status: 'attention', ask: TEST_OK, profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/shop', note: 'Claude asks to use Bash', created: Date.now() + 99, ...extra });
    await s.core.call('list_sessions', {}, { conversation: 'w1' });
    const before = s.ops.calls.length;
    const r = await s.core.call('send_to_chat', { session: name, answer: 'allow' }, { conversation: 'w1' });
    assert.ok(r.card, r.text);
    assert.match(r.card.lines.join('\n'), /did not start it/);
    assert.deepEqual(s.ops.calls.slice(before), []);
  }
});

test('switch on: his open chat joined to her Work job (start_chat with the job) stays his, in a wake and outside one', async () => {
  const s = await started();
  const conv = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const name = `chat:${conv}`;
  const his = { computer: 'this', name, kind: 'chat', chatId: conv, sessionId: conv, status: 'attention', ask: TEST_OK, profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/shop', note: 'Claude asks to use Bash', created: Date.now() + 99, byTia: false };
  s.ops.s.sessions.push(his);
  s.ops.s.conversations['/home/owner/projects/shop'] = [{ id: conv, at: Date.now() - 60_000, title: 'His own work on the cart' }];
  await s.core.call('list_sessions', {}, { conversation: 'w1' });
  await s.core.call('list_projects', { folder: '/home/owner/projects/shop' }, { conversation: 'w1' });
  const job = s.core.jobs.list()[0].id;
  const st = await tapped(s.core, (t, a, o) => s.core.call(t, a, o), 'w1')('start_chat', { folder: '/home/owner/projects/shop', account: 'sub', conversation: conv, job }, { conversation: 'w1' });
  assert.equal(st.isError, false, st.text);
  assert.ok(s.core.jobs.get(job).sessions.some((e) => e.session === name), 'the job watches his chat now');
  const before = s.ops.calls.length;
  const r = await s.core.call('send_to_chat', { session: name, answer: 'allow' }, { conversation: 'w1' });
  assert.ok(r.card, r.text);
  // In a wake for his chat's OK: the wake says it is his, and her answer is refused.
  Object.assign(his, { status: 'working', ask: null });
  await s.core.jobTick(s.ops.s.sessions);
  Object.assign(his, { status: 'attention', ask: { ...TEST_OK, request: 'r2' } });
  const [wake] = await s.core.jobTick(s.ops.s.sessions);
  assert.equal(wake.mode, 'notify');
  assert.doesNotMatch(wake.message, /lets you answer the OKs/);
  s.core.beginTurn('w1', { origin: 'job', job: wake.job, mode: wake.mode });
  await s.core.call('send_to_chat', { session: name, answer: 'allow' }, { conversation: 'w1' });
  s.core.endTurn('w1');
  assert.deepEqual(s.ops.calls.slice(before).filter((c) => c.op === 'answerChat'), [], 'nothing answered in his chat');
  // Her own run's chat is still hers.
  const x = await answerInWake(s, TEST_OK);
  assert.deepEqual(x.typed, ['answerChat']);
});

test('switch on: once the run\'s job is over, its chat is the owner\'s again', async () => {
  const s = await started();
  s.run.state = 'done';
  s.chat.status = 'working';
  await s.core.jobTick(s.ops.s.sessions);
  s.chat.status = 'waiting';
  const [w] = await s.core.jobTick(s.ops.s.sessions);
  s.core.beginTurn('w1', { origin: 'job', job: w.job, mode: w.mode });
  await s.core.call('finish_job', { job: w.job, state: 'done', report: 'Done. Waits for Accept.' }, { conversation: 'w1' });
  s.core.endTurn('w1');
  Object.assign(s.chat, { status: 'attention', ask: TEST_OK });
  const r = await s.core.call('send_to_chat', { session: s.chat.name, answer: 'allow' }, { conversation: 'w1' });
  assert.ok(r.card, r.text);
  assert.match(r.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
});

test('switch on, Tia OFF: nothing wakes her and nothing is answered', async () => {
  const s = await started();
  s.ops.s.assistant.enabled = false;
  s.chat.status = 'working';
  assert.deepEqual(await s.core.jobTick(s.ops.s.sessions), []);
  Object.assign(s.chat, { status: 'attention', ask: TEST_OK });
  assert.deepEqual(await s.core.jobTick(s.ops.s.sessions), []);
  const r = await s.core.call('send_to_chat', { session: s.chat.name, answer: 'allow' }, { conversation: 'w1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Tia is turned off/);
  assert.deepEqual(s.ops.calls.filter((c) => c.op === 'answerChat'), []);
});

test('switch off: her Work run\'s OK is his as before, in a wake and outside one', async () => {
  for (const level of ['work', 'handsoff']) {
    const s = await started({ level, on: false });
    const x = await answerInWake(s, TEST_OK);
    assert.equal(x.wake.mode, 'notify', level);
    assert.match(x.wake.message, /not yours: its OKs and questions are the owner's/);
    assert.equal(x.r.isError, true, x.r.text);
    assert.match(x.r.text, /the session of a Work run is the owner's/);
    assert.deepEqual(x.typed, []);
    const r = await s.core.call('send_to_chat', { session: s.chat.name, answer: 'allow' }, { conversation: 'w1' });
    assert.ok(r.card, r.text);
    assert.match(r.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
    assert.equal(s.core.jobs.list()[0].log.at(-1).text, 'the chat in shop asks for an OK; the OK is the owner\'s, waiting for him');
  }
});

test('switch on: the job\'s answers are capped as in any job; past the cap she tells him', async () => {
  const s = await started();
  const j = s.core.jobs.list()[0];
  s.core.jobs.jobs.get(j.id).steps = j.maxSteps;
  const x = await answerInWake(s, TEST_OK);
  assert.equal(x.wake.mode, 'notify');
  assert.deepEqual(x.typed, []);
});
