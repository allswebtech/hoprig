import assert from 'node:assert/strict';
import test from 'node:test';
import { Watcher, enrich, planAutoSwitch, transitions } from '../../src/server/watcher.mjs';

const card = (o) => ({ name: 'p', kind: 'claude', status: 'waiting', profile: { name: 'sub' }, sessionId: 's1', cwd: '/w', canSwitch: true, limit: null, ...o });

test('enrich joins run fields by session id, profile and folder', () => {
  const runs = [
    { runId: 'old', sessionId: 's1', profile: 'sub', cwd: '/w', startedAt: 1, lastMessage: 'old' },
    { runId: 'new', sessionId: 's1', profile: 'sub', cwd: '/w', startedAt: 2, lastMessage: 'x'.repeat(400), usage: { fiveHour: { pct: 50 } }, limit: { at: 1, error: 'rate' } },
    { runId: 'other', sessionId: 's1', profile: 'api', cwd: '/w', startedAt: 3 },
  ];
  const [c, shell] = enrich([card(), { name: 'sh', kind: 'shell' }], runs);
  assert.equal(c.runId, 'new');
  assert.equal(c.lastMessage.length, 300);
  assert.deepEqual(c.usage, { fiveHour: { pct: 50 } });
  assert.deepEqual(c.runLimit, { at: 1, error: 'rate' });
  assert.deepEqual(shell, { name: 'sh', kind: 'shell' });
});

test('transitions: nothing on first sight; waiting, attention, limit, ended', () => {
  let { events, next } = transitions(new Map(), [card({ status: 'working' })]);
  assert.deepEqual(events, []);
  ({ events, next } = transitions(next, [card({ status: 'waiting' })]));
  assert.deepEqual(events.map((e) => e.status), ['waiting']);
  ({ events, next } = transitions(next, [card({ status: 'waiting' })]));
  assert.deepEqual(events, [], 'no repeat');
  ({ events, next } = transitions(next, [card({ status: 'attention' })]));
  assert.deepEqual(events.map((e) => e.status), ['attention']);
  ({ events, next } = transitions(next, [card({ limit: { text: 'hit' } })]));
  assert.deepEqual(events.map((e) => e.status), ['limit']);
  ({ events, next } = transitions(next, [card({ kind: 'shell', profile: null })]));
  assert.deepEqual(events.map((e) => e.status), ['ended']);
  ({ events } = transitions(new Map([['gone', 'working']]), []));
  assert.deepEqual(events.map((e) => [e.status, e.card.name]), [['ended', 'gone']]);
});

test('auto-switch decision: grace period, once per limit, only screen limits, only when enabled', () => {
  const seen = new Map();
  const done = new Set();
  const auto = { enabled: true };
  const next = (p) => ({ sub: 'api', api: null })[p];
  const limited = card({ runId: 'r1', limit: { text: "You've hit your 5-hour limit" } });
  const plan = (cards, now, a = auto) => planAutoSwitch({ cards, auto: a, now, seen, done, nextProfile: next, graceMs: 20_000 });
  assert.deepEqual(plan([limited], 0), [], 'first sight starts the clock');
  assert.deepEqual(plan([limited], 19_999), []);
  assert.deepEqual(plan([limited], 20_000), [{ name: 'p', from: 'sub', to: 'api', runId: 'r1', text: "You've hit your 5-hour limit" }]);
  assert.deepEqual(plan([limited], 60_000), [], 'never twice for the same limit');
  // the launcher handled it (run.limit set): nothing to do
  assert.deepEqual(plan([card({ runId: 'r2', limit: { text: 'x' }, runLimit: { at: 1 } })], 0), []);
  assert.deepEqual(plan([card({ runId: 'r2', limit: { text: 'x' }, runLimit: { at: 1 } })], 99_000), []);
  // disabled
  assert.deepEqual(plan([card({ runId: 'r3', limit: { text: 'x' } })], 0, { enabled: false }), []);
  assert.deepEqual(plan([card({ runId: 'r3', limit: { text: 'x' } })], 99_000, { enabled: false }), []);
  // no profile left
  assert.deepEqual(plan([card({ runId: 'r4', profile: { name: 'api' }, limit: { text: 'x' } })], 0), []);
  assert.deepEqual(plan([card({ runId: 'r4', profile: { name: 'api' }, limit: { text: 'x' } })], 99_000), []);
  // the limit went away before the grace ended: the clock restarts
  plan([card({ runId: 'r5', limit: { text: 'x' } })], 0);
  plan([card({ runId: 'r5' })], 10_000);
  assert.deepEqual(plan([card({ runId: 'r5', limit: { text: 'x' } })], 25_000), []);
  // an Auto session is the router's business
  assert.deepEqual(plan([card({ runId: 'r7', profile: { name: 'auto' }, limit: { text: 'x' } })], 0), []);
  assert.deepEqual(plan([card({ runId: 'r7', profile: { name: 'auto' }, limit: { text: 'x' } })], 99_000), []);
  // no session id yet: cannot move
  assert.deepEqual(plan([card({ runId: 'r6', canSwitch: false, limit: { text: 'x' } })], 0), []);
  assert.deepEqual(plan([card({ runId: 'r6', canSwitch: false, limit: { text: 'x' } })], 99_000), []);
});

test('watcher: moves, marks the old profile, sends the prompt once the new run waits, notifies', async () => {
  let now = 0;
  let cards = [card({ runId: 'r1', status: 'working' })];
  const calls = [];
  const sent = [];
  const w = new Watcher({
    cards: async () => cards,
    deck: {
      find: async (name) => ({ term: { id: '%1' }, run: { runId: 'r1' }, name }),
      move: async (term, run, to) => calls.push(['move', term.id, to]),
      sendToTool: async (name, text) => calls.push(['send', name, text]),
    },
    auto: {
      getAutoSwitch: () => ({ enabled: true, prompt: 'continue', order: ['sub', 'api'] }),
      nextProfile: (p) => (p === 'sub' ? 'api' : null),
      markLimited: (name, o) => calls.push(['mark', name, o.reason]),
      parseResets: () => 123,
    },
    settings: () => ({ notify: { url: 'https://ntfy.sh/t' }, publicUrl: 'https://pc.example' }),
    now: () => now,
    log: () => {},
    send: async (n, ev) => sent.push(ev),
  });
  await w.tick(); // first sight
  cards = [card({ runId: 'r1', limit: { text: "You've hit your limit" } })];
  now = 1000;
  await w.tick();
  assert.deepEqual(sent.map((e) => [e.status, e.url]), [['limit', 'https://pc.example/#/s/p']]);
  now = 22_000;
  await w.tick();
  assert.deepEqual(calls, [['move', '%1', 'api'], ['mark', 'sub', 'screen']]);
  assert.ok(sent.some((e) => e.status === 'switched'));
  cards = [card({ runId: 'r9', profile: { name: 'api' }, status: 'starting' })];
  await w.tick();
  assert.equal(calls.filter((c) => c[0] === 'send').length, 0, 'not before it waits');
  cards = [card({ runId: 'r9', profile: { name: 'api' }, status: 'waiting' })];
  await w.tick();
  await w.tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'send'), [['send', 'p', 'continue']], 'prompt sent exactly once, for the coding tool of that session');
  w.stop();
});

test('watcher: after a restart on the same provider the prompt is for the new run, never the one that was stopped', async () => {
  let cards = [card({ runId: 'r1', status: 'waiting' })];
  const calls = [];
  const w = new Watcher({
    cards: async () => cards,
    deck: { find: async () => ({ term: { id: '%1' }, run: { runId: 'r1' } }), move: async () => {}, sendToTool: async (name, text) => calls.push([name, text]) },
    auto: { getAutoSwitch: () => ({ enabled: false, prompt: 'continue', order: [] }), nextProfile: () => null, markLimited: () => {} },
    settings: () => ({ notify: null, publicUrl: '' }),
    log: () => {},
  });
  // what POST /api/sessions/<name>/continue { restart: true } leaves (server.mjs)
  w.pending.set('p', { to: 'sub', prompt: 'continue', since: Date.now(), notRun: 'r1' });
  await w.tick();
  assert.deepEqual(calls, [], 'the stopped run is still listed, waiting: not into that one');
  cards = [card({ runId: 'r2', status: 'starting' })];
  await w.tick();
  assert.deepEqual(calls, [], 'not before the new one waits');
  cards = [card({ runId: 'r2', status: 'waiting' })];
  await w.tick();
  await w.tick();
  assert.deepEqual(calls, [['p', 'continue']], 'once');
  w.stop();
});
