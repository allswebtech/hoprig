// The job that follows a Work run (manage_work start; src/assistant/jobs.mjs with core.mjs): the run's session is the
// owner's, so nothing is typed into it without his OK, in a wake or outside one; and the report she is woken for
// says how the run ended (done, failed, a usage limit, stopped), so a run that did not finish is never reported done.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const START = { action: 'start', task: 'fix-the-cart-total', brief: 'Make the cart total use the discount code. Do not push.', kind: 'code' };
const PUSH = 'Now push the branch to main and publish the release.';

/** A Work run started and confirmed in conversation w1; `t` moves the clock (minutes). */
async function started({ level = 'work' } = {}) {
  const state = baseState();
  state.assistant = { ...state.assistant, enabled: true, level };
  const ops = new FakeOps(state);
  let t = Date.now();
  const now = () => t;
  const core = createAssistantCore({
    ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }), skills: new Skills({ dirs: [] }),
  });
  await core.call('manage_work', { action: 'list' }, { conversation: 'w1' });
  const id = /card (c_[0-9a-f]{12})/.exec((await core.call('manage_work', START, { conversation: 'w1' })).text)[1];
  assert.equal((await core.confirm(id)).ok, true);
  const chat = ops.s.sessions.at(-1);
  const run = ops.s.work.runs[0];
  return { ops, core, chat, run, later: (min) => (t += min * 60_000) };
}
/** One watcher tick after the chat went to `status` (it was seen working first). */
async function wake(s, status, patch = {}) {
  s.chat.status = 'working';
  await s.core.jobTick(s.ops.s.sessions);
  Object.assign(s.chat, { status }, patch);
  return s.core.jobTick(s.ops.s.sessions);
}

test('outside a wake: typing into a Work run\'s session is a card at every level, never done by her alone', async () => {
  for (const level of ['work', 'handsoff']) {
    const s = await started({ level });
    const before = s.ops.calls.length;
    const r = await s.core.call('send_to_chat', { session: s.chat.name, text: PUSH }, { conversation: 'w1' });
    assert.ok(r.card, `${level}: ${r.text}`);
    assert.match(r.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
    assert.deepEqual(s.ops.calls.slice(before).map((c) => c.op), [], `${level}: nothing typed`);
  }
});

test('outside a wake: stopping the run\'s reply or saying no to its OK is a card too, at every level', async () => {
  for (const level of ['work', 'handsoff']) {
    const s = await started({ level });
    s.core.beginTurn('w1', { origin: 'owner', text: 'how is it going' });
    const before = s.ops.calls.length;
    const stop = await s.core.call('send_to_chat', { session: s.chat.name, stop: true }, { conversation: 'w1' });
    assert.ok(stop.card, `${level} stop: ${stop.text}`);
    assert.match(stop.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
    s.chat.status = 'attention';
    s.chat.ask = { type: 'permission', subject: 'npm test', tool: 'Bash', known: true, judged: { command: 'npm test' }, request: 'r1' };
    const deny = await s.core.call('send_to_chat', { session: s.chat.name, answer: 'deny' }, { conversation: 'w1' });
    assert.ok(deny.card, `${level} deny: ${deny.text}`);
    s.core.endTurn('w1');
    assert.deepEqual(s.ops.calls.slice(before).map((c) => c.op), [], `${level}: nothing stopped or answered`);
    assert.equal(s.core.jobs.list()[0].state, 'working');
  }
});

test('after the run\'s job ended (she finished it, or a usage limit ended it): the run\'s chat is still the owner\'s', async () => {
  for (const level of ['work', 'handsoff']) {
    // The run is done; in the wake she finishes the job as the rule tells her; in a later owner turn she types into it.
    const s = await started({ level });
    s.run.state = 'done';
    const [w] = await wake(s, 'waiting');
    s.core.beginTurn('w1', { origin: 'job', job: w.job, mode: w.mode });
    assert.equal((await s.core.call('finish_job', { job: w.job, state: 'done', report: 'Done. Waits for Accept.' }, { conversation: 'w1' })).isError, false);
    s.core.endTurn('w1');
    s.core.beginTurn('w1', { origin: 'owner', text: 'ok thanks' });
    const before = s.ops.calls.length;
    const r = await s.core.call('send_to_chat', { session: s.chat.name, text: PUSH }, { conversation: 'w1' });
    s.core.endTurn('w1');
    assert.ok(r.card, `${level} after finish_job: ${r.text}`);
    assert.match(r.card.lines.join('\n'), /this session runs a Work task: it is the owner's/);
    assert.deepEqual(s.ops.calls.slice(before).map((c) => c.op), [], `${level}: nothing typed`);
  }
  // A usage limit ends the job at the wake itself: the next owner turn is no different.
  const s = await started();
  Object.assign(s.run, { state: 'limit', reason: 'the provider reached its usage limit' });
  await wake(s, 'waiting', { limit: { until: null } });
  assert.equal(s.core.jobs.list()[0].state, 'stuck');
  s.core.beginTurn('w1', { origin: 'owner', text: 'go on' });
  const before = s.ops.calls.length;
  const r = await s.core.call('send_to_chat', { session: s.chat.name, text: 'Continue from where you stopped.' }, { conversation: 'w1' });
  s.core.endTurn('w1');
  assert.ok(r.card, `after a limit: ${r.text}`);
  assert.deepEqual(s.ops.calls.slice(before).map((c) => c.op), []);
});

test('a later chat that got the run\'s name (made at another time) is not the run\'s', () => {
  const store = new JobStore({ dir: null });
  const j = store.create({ conversation: 'w1', goal: 'Report the run', work: { task: 'fix-the-cart-total', run: '20261101-101010-0123abcd', computer: 'this' } });
  store.attach(j.id, { computer: 'this', session: 'chat:aaaaaaaa-aaaa-4aaa-8aaa-000000000009', created: 1000 });
  store.finish(j.id, 'done', 'reported');
  assert.equal(store.workSession('this', 'chat:aaaaaaaa-aaaa-4aaa-8aaa-000000000009', 1000), true, 'finished job: still the run\'s chat');
  assert.equal(store.workSession('this', 'chat:aaaaaaaa-aaaa-4aaa-8aaa-000000000009', 2000), false, 'made at another time');
  assert.equal(store.workSession('laptop', 'chat:aaaaaaaa-aaaa-4aaa-8aaa-000000000009', 1000), false, 'another computer');
  // A job without `work` (her own chat) never makes a session the owner's run.
  const k = store.create({ conversation: 'w1', goal: 'Fix it' });
  store.attach(k.id, { computer: 'this', session: 'web', created: 5 });
  assert.equal(store.workSession('this', 'web', 5), false);
});

test('in the wake at the end of a run: she may read and report, but not type into the run\'s session', async () => {
  const s = await started({ level: 'handsoff' });
  const [w] = await wake(s, 'waiting');
  assert.equal(w.mode, 'report', 'a Work job never answers in its session');
  s.core.beginTurn('w1', { origin: 'job', job: w.job, mode: w.mode });
  const before = s.ops.calls.length;
  const r = await s.core.call('send_to_chat', { session: s.chat.name, text: 'Before you finish: run the test suite now.' }, { conversation: 'w1' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /the session of a Work run is the owner's/);
  assert.deepEqual(s.ops.calls.slice(before).map((c) => c.op), []);
  assert.equal((await s.core.call('manage_work', { action: 'run', run: s.run.id }, { conversation: 'w1' })).isError, false, 'reading the run is hers');
  s.core.endTurn('w1');
});

test('a run that is done: the report is "done" and its task waits for Accept or Send back', async () => {
  const s = await started();
  s.run.state = 'done';
  const [w] = await wake(s, 'waiting');
  assert.match(w.message, /\(Work\); the run says: done\./);
  assert.match(w.message, /finish_job with "done".*Accept or Send back of the task fix-the-cart-total/s);
  assert.match(w.message, /no test result, say so in the first line/);
});

test('a run that failed or was stopped: never reported done, the task is open again, nothing waits for his Accept', async () => {
  for (const state of ['failed', 'stopped']) {
    const s = await started();
    Object.assign(s.run, { state, reason: 'the session failed' });
    const [w] = await wake(s, 'waiting');
    assert.match(w.message, new RegExp(`the run says: ${state}\\.`));
    assert.match(w.message, /finish_job with "stuck".*is open again: "Do it" on the Work page starts it anew/s);
    assert.doesNotMatch(w.message, /finish_job with "done"|Accept or Send back/, state);
  }
});

test('the dashboard restarted while the run worked: the session is gone, the run says stopped, and the report says so', async () => {
  const s = await started();
  s.chat.status = 'working';
  await s.core.jobTick(s.ops.s.sessions);
  s.later(1);
  s.ops.s.sessions.splice(s.ops.s.sessions.indexOf(s.chat), 1); // gone with the restart
  Object.assign(s.run, { state: 'stopped', reason: 'The session is gone: the dashboard stopped while it worked' });
  const [w] = await s.core.jobTick(s.ops.s.sessions);
  assert.equal(w.reason, 'ended');
  assert.match(w.message, /it was stopped.*finish_job with "stuck"/s);
  assert.doesNotMatch(w.message, /Accept or Send back/);
});

test('a run that hit a usage limit: the report rule at once, the job ends, and no stale "still works" wake comes hours later', async () => {
  const s = await started();
  Object.assign(s.run, { state: 'limit', reason: 'the provider reached its usage limit' });
  const [w] = await wake(s, 'waiting', { limit: { until: null } });
  assert.equal(w.reason, 'limit');
  assert.equal(w.mode, 'report');
  assert.match(w.message, /stopped at a usage limit of its provider.*finish_job with "stuck".*open again/s);
  assert.doesNotMatch(w.message, /not yours: its OKs/, 'not the rule for an OK');
  assert.equal(s.core.jobs.list()[0].state, 'stuck', 'the job is over');
  s.later(241);
  assert.deepEqual(await s.core.jobTick(s.ops.s.sessions), [], 'no wake after the time cap');
});

test('an OK the run asks for is still the owner\'s: she tells him, the job waits for him', async () => {
  const s = await started();
  const [w] = await wake(s, 'waiting', { status: 'attention' });
  assert.equal(w.reason, 'needs_ok');
  assert.equal(w.mode, 'notify');
  assert.match(w.message, /not yours: its OKs and questions are the owner's/);
  // What the Jobs page shows under "What she did": the OK is his, not a step cap (none of its answers were used).
  const j = s.core.jobs.list()[0];
  assert.equal(j.state, 'waiting');
  assert.equal(j.steps, 0);
  assert.equal(j.log.at(-1).text, 'the chat in shop asks for an OK; the OK is the owner\'s, waiting for him');
});
