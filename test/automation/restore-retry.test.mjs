import assert from 'node:assert/strict';
import test from 'node:test';
import * as restore from '../../src/automation/restore.mjs';
import * as retry from '../../src/automation/retry.mjs';
import { DEFAULTS, restoreOn } from '../../src/automation/settings.mjs';
import { claude, fakeDeck, recorder, shell } from './helpers.mjs';

const SID = '22222222-2222-4222-8222-222222222222';
const MIN = 60_000;

// ---- restore ----

test('restore: learns sessions, and at start reopens the ones that vanished, resumed', async () => {
  let r = restore.decide({ cards: [claude('api-work', { cwd: '/p', profile: { name: 'api' }, sessionId: SID, carryArgs: ['--model', 'opus', '--permission-mode', 'plan'] }), shell('sh')], data: null, now: 1000, boot: true, enabled: true });
  assert.deepEqual(r.actions, []);
  assert.deepEqual(Object.keys(r.data.sessions), ['api-work'], 'shells are not remembered');
  // The service restarts; the session is gone.
  r = restore.decide({ cards: [], data: r.data, now: 9000, boot: true, enabled: true });
  assert.deepEqual(r.actions, [{ type: 'reopen', session: { name: 'api-work', cwd: '/p', profile: 'api', sessionId: SID, carryArgs: ['--model', 'opus', '--permission-mode', 'plan'] } }]);
  const deck = fakeDeck();
  const rec = recorder();
  await restore.apply(r.actions, { deck, record: rec.record, conversationExists: () => true });
  assert.deepEqual(deck.started, [{ dir: '/p', profile: 'api', mode: 'move', sessionId: SID, carryArgs: ['--model', 'opus', '--permission-mode', 'plan'], name: 'api-work' }]);
  assert.equal(deck.sent.length, 0, 'nothing is typed');
  assert.match(rec.entries[0].did, /reopened on api \(resumed 22222222\)/);
});

test('restore: a session closed while the service ran is never reopened', () => {
  let r = restore.decide({ cards: [claude('w')], data: null, now: 0, boot: true, enabled: true });
  r = restore.decide({ cards: [], data: r.data, now: 5_000, boot: false, enabled: true }); // closed
  r = restore.decide({ cards: [], data: r.data, now: 5_000 + restore.GONE_WINDOW_MS + 1, boot: false, enabled: true });
  assert.deepEqual(r.data.sessions, {}, 'forgotten');
  r = restore.decide({ cards: [], data: r.data, now: 10 * MIN, boot: true, enabled: true });
  assert.deepEqual(r.actions, []);
});

test('restore: vanished just before the service stopped (a reboot taking tmux down) is reopened', () => {
  let r = restore.decide({ cards: [claude('w')], data: null, now: 0, boot: true, enabled: true });
  r = restore.decide({ cards: [], data: r.data, now: 5_000, boot: false, enabled: true }); // tmux went first
  r = restore.decide({ cards: [], data: r.data, now: 10_000, boot: false, enabled: true }); // last tick
  r = restore.decide({ cards: [], data: r.data, now: 3_600_000, boot: true, enabled: true });
  assert.deepEqual(r.actions.map((a) => a.session.name), ['w']);
});

test('restore: what is still there at start (tmux kept it) is left alone; off means nothing', () => {
  let r = restore.decide({ cards: [claude('w')], data: null, now: 0, boot: true, enabled: true });
  r = restore.decide({ cards: [claude('w')], data: r.data, now: 9000, boot: true, enabled: true });
  assert.deepEqual(r.actions, []);
  const off = restore.decide({ cards: [], data: r.data, now: 9000, boot: true, enabled: false });
  assert.deepEqual(off.actions, []);
  assert.deepEqual(off.data.sessions, {});
});

test('restore: Claude exited (a shell for a while) is forgotten; a just-reopened shell is not', () => {
  let r = restore.decide({ cards: [claude('w')], data: null, now: 0, boot: true, enabled: true });
  r = restore.decide({ cards: [shell('w')], data: r.data, now: 1000, boot: false, enabled: true });
  assert.ok(r.data.sessions.w, 'kept while Claude may still be starting');
  r = restore.decide({ cards: [shell('w')], data: r.data, now: 1000 + restore.SHELL_FORGET_MS + 1, boot: false, enabled: true });
  assert.deepEqual(r.data.sessions, {});
});

test('restore: follows a new session id (/clear); a session with no conversation on disk (nobody typed into it) comes back fresh under its id', async () => {
  let r = restore.decide({ cards: [claude('w')], data: null, now: 0, boot: true, enabled: true });
  r = restore.decide({ cards: [claude('w', { sessionId: SID, cwd: '/p', profile: { name: 'api' }, carryArgs: ['--model', 'opus'] })], data: r.data, now: 1, boot: false, enabled: true });
  assert.equal(r.data.sessions.w.sessionId, SID);
  r = restore.decide({ cards: [], data: r.data, now: 2, boot: true, enabled: true });
  const deck = fakeDeck();
  const rec = recorder();
  await restore.apply(r.actions, { deck, record: rec.record, conversationExists: () => false });
  assert.deepEqual(deck.started, [{ dir: '/p', profile: 'api', mode: 'move', sessionId: SID, carryArgs: ['--model', 'opus'], name: 'w', fresh: true }]);
  assert.equal(rec.entries[0].outcome, 'ok');
  assert.match(rec.entries[0].did, /reopened on api \(started fresh: it had no conversation to resume\)/);
  // What the server's deck makes of it: the same id, started fresh, the session's own flags kept.
  const { launchArgv } = await import('../../src/server/deck.mjs');
  assert.deepEqual(launchArgv(['hoprig'], { ...deck.started[0], profile: { name: 'api', env: {} } }), ['hoprig', 'api', '--model', 'opus', '--session-id', SID]);
});

test('restore: a renamed session is reopened once, under its new name', () => {
  let r = restore.decide({ cards: [claude('old', { sessionId: SID })], data: null, now: 0, boot: true, enabled: true });
  r = restore.decide({ cards: [claude('new', { sessionId: SID })], data: r.data, now: 1000, boot: false, enabled: true });
  assert.deepEqual(Object.keys(r.data.sessions), ['new']);
  r = restore.decide({ cards: [], data: r.data, now: 9000, boot: true, enabled: true });
  assert.deepEqual(r.actions.map((a) => a.session.name), ['new']);
});

test('restore: the reopened command line is the launcher\'s move, so the session keeps its arguments', async () => {
  const { launchArgv } = await import('../../src/server/deck.mjs');
  const argv = launchArgv(['hop'], { profile: { name: 'auto', env: {} }, mode: 'move', sessionId: SID, carryArgs: ['--model', 'opus', '--effort', 'high', '--permission-mode', 'plan'] });
  assert.deepEqual(argv, ['hop', 'auto', '--model', 'opus', '--effort', 'high', '--permission-mode', 'plan', '--resume', SID]);
});

test('restore default: on for the built-in terminals, off for tmux, the owner decides otherwise', () => {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  assert.equal(restoreOn(s, { capabilities: { persistent: false } }), true);
  assert.equal(restoreOn(s, { capabilities: { persistent: true } }), false);
  s.restore.enabled = true;
  assert.equal(restoreOn(s, { capabilities: { persistent: true } }), true);
  s.restore.enabled = false;
  assert.equal(restoreOn(s, { capabilities: { persistent: false } }), false);
});

// ---- retry ----

const failing = (at, error = 'server_error', o = {}) => claude('w', { status: 'attention', statusAt: at, failure: { at, error, text: 'API Error: 500' }, ...o });

test('retry: backs off 1, 2, 4 minutes and stops at the maximum, telling the owner once', () => {
  const opts = { max: 3, firstMinutes: 1 };
  let data = {};
  const step = (card, now) => {
    const r = retry.decide({ cards: [card], data, now, ...opts });
    data = r.data;
    return r.actions.map((a) => a.type + (a.attempt ? a.attempt : ''));
  };
  const t0 = 1_000_000;
  assert.deepEqual(step(failing(t0), t0 + 59_999), []);
  assert.deepEqual(step(failing(t0), t0 + MIN), ['retry1']);
  assert.deepEqual(step(failing(t0), t0 + MIN + 5000), [], 'once per failure');
  assert.deepEqual(step(claude('w', { status: 'working' }), t0 + MIN + 6000), []);
  const t1 = t0 + 3 * MIN;
  assert.deepEqual(step(failing(t1), t1 + MIN), [], 'the second wait is 2 minutes');
  assert.deepEqual(step(failing(t1), t1 + 2 * MIN), ['retry2']);
  const t2 = t1 + 5 * MIN;
  assert.deepEqual(step(failing(t2), t2 + 3 * MIN), []);
  assert.deepEqual(step(failing(t2), t2 + 4 * MIN), ['retry3']);
  const t3 = t2 + 10 * MIN;
  assert.deepEqual(step(failing(t3), t3 + 60 * MIN), ['give-up']);
  assert.deepEqual(step(failing(t3), t3 + 61 * MIN), [], 'told once');
});

test('retry: a finished reply resets the count', () => {
  let r = retry.decide({ cards: [failing(0)], data: {}, now: MIN, max: 3, firstMinutes: 1 });
  assert.equal(r.data.w.attempts, 1);
  r = retry.decide({ cards: [claude('w', { stopAt: MIN + 10 })], data: r.data, now: MIN + 20, max: 3, firstMinutes: 1 });
  assert.deepEqual(r.data, {});
  r = retry.decide({ cards: [failing(5 * MIN)], data: r.data, now: 6 * MIN, max: 3, firstMinutes: 1 });
  assert.deepEqual(r.actions.map((a) => a.attempt), [1]);
});

test('retry: never for limits, credit, login or a bad request; only overloaded, server and connection errors', () => {
  for (const error of ['rate_limit', 'billing_error', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'invalid_request', 'model_not_found', 'max_output_tokens', 'cloud_credential_error']) {
    assert.deepEqual(retry.decide({ cards: [failing(0, error)], data: {}, now: 60 * MIN, max: 3, firstMinutes: 1 }).actions, [], error);
  }
  for (const error of ['server_error', 'overloaded', 'unknown']) {
    assert.equal(retry.decide({ cards: [failing(0, error)], data: {}, now: 60 * MIN, max: 3, firstMinutes: 1 }).actions.length, 1, error);
  }
  assert.deepEqual(retry.decide({ cards: [failing(0, 'server_error', { runLimit: { at: 0 } })], data: {}, now: 60 * MIN, max: 3, firstMinutes: 1 }).actions, [], 'never at a limit');
  assert.deepEqual(retry.decide({ cards: [failing(0, 'server_error', { status: 'working' })], data: {}, now: 60 * MIN, max: 3, firstMinutes: 1 }).actions, [], 'never while working');
});

test('retry apply: sends the continue message; giving up notifies', async () => {
  const deck = fakeDeck();
  const rec = recorder();
  await retry.apply([{ type: 'retry', session: 'w', attempt: 1, error: 'overloaded' }, { type: 'give-up', session: 'w', attempts: 3, error: 'overloaded' }], { deck, prompt: 'Continue.', max: 3, record: rec.record, notify: rec.notify });
  assert.deepEqual(deck.sent, [['w', 'Continue.']]);
  assert.equal(rec.notes.length, 1);
  assert.match(rec.notes[0].message, /3 times in a row/);
});
