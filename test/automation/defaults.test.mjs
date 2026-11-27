// What a newcomer gets with no setting at all: restore on (also with tmux), retry on for passing errors only, and the
// restore that runs again by itself when tmux is seen gone while the dashboard runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomation } from '../../src/automation/index.mjs';
import * as retry from '../../src/automation/retry.mjs';
import { DEFAULTS, readSettings, restoreOn } from '../../src/automation/settings.mjs';
import { claude, fakeCtx, fakeDeck, tmpDir } from './helpers.mjs';

const MIN = 60_000;
const SID = '44444444-4444-4444-8444-444444444444';
const SID2 = '55555555-5555-4555-8555-555555555555';

test('a fresh config: restore is on with tmux too, retry is on, nothing else changed', () => {
  const s = readSettings(undefined);
  assert.equal(restoreOn(s, { capabilities: { persistent: true } }), true);
  assert.equal(restoreOn(s, { capabilities: { persistent: false } }), true);
  assert.equal(s.retry.enabled, true);
  assert.equal(DEFAULTS.retry.max, 3);
  // The owner's own choice still wins.
  assert.equal(restoreOn(readSettings({ restore: { enabled: false } }), { capabilities: { persistent: true } }), false);
  assert.equal(readSettings({ retry: { enabled: false } }).retry.enabled, false);
});

const failing = (at, text, o = {}) => claude('w', { status: 'attention', statusAt: at, failure: { at, error: 'unknown', text }, ...o });
const due = (card, extra = {}) => retry.decide({ cards: [card], data: {}, now: 60 * MIN, max: 3, firstMinutes: 1, ...extra }).actions;

test('retry: a passing error is tried again; a 4xx, a limit and a provider paid per use never are', () => {
  assert.equal(due(failing(0, 'API Error: 500 internal error')).length, 1, 'a 5xx');
  assert.equal(due(failing(0, 'connection reset')).length, 1, 'a dropped connection');
  for (const code of [400, 401, 403, 404, 413, 422]) assert.deepEqual(due(failing(0, `API Error: ${code} bad request`)), [], String(code));
  assert.deepEqual(due(failing(0, 'API Error: 500', { paidProfile: true })), [], 'a provider paid per use');
  assert.deepEqual(due(failing(0, 'API Error: 500', { runLimit: { at: 0, text: 'Usage limit reached' } })), [], 'at a limit');
  assert.equal(due(failing(0, 'took 4000 ms and 1234 bytes')).length, 1, 'a number inside other text is no status');
});

test('retry: the first wait is a minute', () => {
  let data = {};
  const t0 = 10 * MIN;
  const step = (now) => {
    const r = retry.decide({ cards: [failing(t0, 'API Error: 529 overloaded')], data, now, max: 3, firstMinutes: 1 });
    data = r.data;
    return r.actions.map((a) => a.type);
  };
  assert.deepEqual(step(t0 + 59_000), []);
  assert.deepEqual(step(t0 + MIN), ['retry']);
});

// ---- tmux seen gone while the dashboard runs ----

function rig({ cards }) {
  const t = tmpDir('tmuxgone');
  const deck = fakeDeck(cards);
  const state = { pid: 4242, closedAt: 0 };
  const backend = { kind: 'tmux', capabilities: { persistent: true }, serverPid: async () => state.pid, get closedAt() { return state.closedAt; } };
  let clock = 1_000_000;
  const f = fakeCtx({ deck, stateDir: t.dir, now: () => clock, persistent: true, backend });
  const a = createAutomation(f.ctx);
  return { t, deck, state, a, at: async (ms) => { clock = ms; return a.tick(ms); }, time: () => clock };
}

test('tmux dies while the dashboard runs: the sessions are reopened once, resumed, nothing typed', async () => {
  const r = rig({ cards: [claude('alpha', { sessionId: SID }), claude('beta', { sessionId: SID2, cwd: '/b' })] });
  try {
    await r.at(1_000_000); // the first tick (a start): everything is there
    assert.deepEqual(r.deck.started, []);
    r.deck.cards = [];
    r.state.pid = null; // the server is gone
    await r.at(1_000_000 + 30_000);
    assert.deepEqual(r.deck.started.map((s) => [s.name, s.mode, s.sessionId]).sort(), [['alpha', 'move', SID], ['beta', 'move', SID2]]);
    assert.deepEqual(r.deck.sent, [], 'nothing is typed into a reopened session');
    // The server is back with the sessions; it dies again two minutes later: not again within 10 minutes.
    r.deck.cards = [claude('alpha', { sessionId: SID }), claude('beta', { sessionId: SID2, cwd: '/b' })];
    r.state.pid = 9;
    await r.at(1_000_000 + 60_000);
    r.deck.cards = [];
    r.state.pid = null;
    const before = r.deck.started.length;
    await r.at(1_000_000 + 120_000);
    assert.equal(r.deck.started.length, before, 'once per 10 minutes');
  } finally {
    r.t.cleanup();
  }
});

test('the last session closed by the owner ends the tmux server: that is no death', async () => {
  const r = rig({ cards: [claude('alpha', { sessionId: SID })] });
  try {
    await r.at(1_000_000);
    r.deck.cards = [];
    r.state.pid = null;
    r.state.closedAt = 1_000_000 + 10_000; // he pressed Close
    await r.at(1_000_000 + 30_000);
    assert.deepEqual(r.deck.started, []);
  } finally {
    r.t.cleanup();
  }
});

test('restore off by the owner: a tmux death reopens nothing', async () => {
  const t = tmpDir('tmuxoff');
  try {
    const deck = fakeDeck([claude('alpha', { sessionId: SID })]);
    const state = { pid: 7 };
    const f = fakeCtx({ deck, stateDir: t.dir, now: () => 5_000_000, persistent: true, automation: { restore: { enabled: false } }, backend: { capabilities: { persistent: true }, serverPid: async () => state.pid } });
    const a = createAutomation(f.ctx);
    await a.tick(5_000_000);
    deck.cards = [];
    state.pid = null;
    await a.tick(5_030_000);
    assert.deepEqual(deck.started, []);
  } finally {
    t.cleanup();
  }
});
