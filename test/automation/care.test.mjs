// Updates and idle care.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as idle from '../../src/automation/idle.mjs';
import * as updates from '../../src/automation/updates.mjs';
import { claude, fakeDeck, recorder, shell } from './helpers.mjs';

const H = 3600_000;
const MIN = 60_000;

// ---- updates ----

test('updates: off means no look; a working session postpones it; at most one look per 6 hours', () => {
  const on = { claude: 'notify' };
  assert.deepEqual(updates.decide({ cards: [], data: {}, now: 10 * H, settings: { claude: 'off' } }).actions, []);
  assert.deepEqual(updates.decide({ cards: [claude('w', { status: 'working' })], data: {}, now: 10 * H, settings: on }).actions, []);
  assert.deepEqual(updates.decide({ cards: [claude('w', { status: 'starting' })], data: {}, now: 10 * H, settings: on }).actions, []);
  const r = updates.decide({ cards: [claude('w', { status: 'waiting' })], data: {}, now: 10 * H, settings: on });
  assert.deepEqual(r.actions, [{ type: 'check' }]);
  assert.deepEqual(updates.decide({ cards: [], data: r.data, now: 16 * H - 1, settings: on }).actions, []);
  assert.deepEqual(updates.decide({ cards: [], data: r.data, now: 16 * H, settings: on }).actions, [{ type: 'check' }]);
});

test('updates: one message per new version; "auto" updates Claude Code', () => {
  const claudeNew = { installed: '2.1.0', latest: '2.2.0', updateAvailable: true };
  let r = updates.afterCheck({ claude: claudeNew, settings: { claude: 'notify' }, data: {} });
  assert.deepEqual(r.actions, [{ type: 'tell', current: '2.1.0', latest: '2.2.0' }]);
  r = updates.afterCheck({ claude: claudeNew, settings: { claude: 'notify' }, data: r.data });
  assert.deepEqual(r.actions, [], 'already told');
  r = updates.afterCheck({ claude: { ...claudeNew, latest: '2.3.0' }, settings: { claude: 'notify' }, data: r.data });
  assert.deepEqual(r.actions.map((a) => a.latest), ['2.3.0'], 'a newer one is told again');
  r = updates.afterCheck({ claude: claudeNew, settings: { claude: 'auto' }, data: {} });
  assert.deepEqual(r.actions, [{ type: 'update-claude', current: '2.1.0', latest: '2.2.0' }]);
  assert.deepEqual(updates.afterCheck({ claude: { ...claudeNew, updateAvailable: false }, settings: { claude: 'auto' }, data: {} }).actions, []);
});

test('updates apply: updates only while nothing works; a session that started meanwhile postpones it', async () => {
  const run = async (cards) => {
    const deck = fakeDeck(cards);
    const rec = recorder();
    let saved = null;
    let updated = 0;
    await updates.apply([{ type: 'check' }], {
      deck, record: rec.record, notify: rec.notify, settings: { claude: 'auto' }, data: { lastCheckAt: 5 },
      save: (d) => { saved = d; },
      updates: { claudeInfo: async () => ({ installed: '2.1.0', latest: '2.2.0', updateAvailable: true }), claudeUpdate: async () => { updated++; return { ok: true, version: '2.2.0' }; } },
    });
    return { rec, saved, updated };
  };
  const quiet = await run([claude('w', { status: 'waiting' })]);
  assert.equal(quiet.updated, 1);
  assert.match(quiet.rec.entries[0].outcome, /ok: now 2\.2\.0/);
  assert.equal(quiet.rec.notes[0].title, 'Claude Code updated to 2.2.0');
  const busy = await run([claude('w', { status: 'working' })]);
  assert.equal(busy.updated, 0);
  assert.match(busy.rec.entries[0].outcome, /postponed/);
  assert.equal(busy.saved.lastCheckAt, 0, 'looks again at the next quiet moment');
});

test('updates apply: a failed look is logged, not thrown', async () => {
  const rec = recorder();
  await updates.apply([{ type: 'check' }], {
    deck: fakeDeck(), record: rec.record, notify: rec.notify, settings: { claude: 'notify' }, data: {}, save: () => {},
    updates: { claudeInfo: async () => { throw new Error('offline'); } },
  });
  assert.deepEqual(rec.entries.map((e) => e.outcome), ['failed: offline']);
});

// ---- idle care ----

test('idle shells: only plain, unwatched shells quiet for longer than N hours', () => {
  const now = 100 * H;
  const cards = [
    shell('old', { activity: now - 13 * H }),
    shell('login', { activity: now - 13 * H, command: '-zsh' }),
    shell('fresh', { activity: now - 11 * H }),
    shell('build', { activity: now - 13 * H, command: 'make' }),
    shell('watched', { activity: now - 13 * H, attached: true }),
    claude('c', { activity: now - 50 * H }),
  ];
  const r = idle.decide({ cards, data: {}, now, settings: { shells: true, shellHours: 12, gateway: false, gatewayMinutes: 30 } });
  assert.deepEqual(r.actions.map((a) => a.session), ['old', 'login']);
  assert.deepEqual(idle.decide({ cards, data: {}, now, settings: { shells: false, shellHours: 12, gateway: false } }).actions, []);
});

test('idle gateway: stopped once after N unused minutes; a session on its account or in Auto keeps it', () => {
  const settings = { shells: false, gateway: true, gatewayMinutes: 30 };
  const addons = [{ id: 'trouteai', profile: 'api' }];
  let r = idle.decide({ cards: [claude('a', { profile: { name: 'api' } })], data: {}, now: 0, settings, addons });
  r = idle.decide({ cards: [], data: r.data, now: 30 * MIN, settings, addons });
  assert.deepEqual(r.actions, []);
  r = idle.decide({ cards: [claude('x', { profile: { name: 'auto' } })], data: r.data, now: 31 * MIN, settings, addons, autoOrder: ['sub', 'api'] });
  assert.deepEqual(r.actions, [], 'Auto mode may route to it');
  r = idle.decide({ cards: [], data: r.data, now: 61 * MIN + 1, settings, addons });
  assert.deepEqual(r.actions.map((a) => a.type), ['stop-gateway']);
  r = idle.decide({ cards: [], data: r.data, now: 200 * MIN, settings, addons });
  assert.deepEqual(r.actions, [], 'one stop per quiet spell');
});

test('idle apply: closes shells; stops only a gateway that runs', async () => {
  const deck = fakeDeck([shell('old')]);
  const rec = recorder();
  let stops = 0;
  let running = true;
  const addon = { id: 'trouteai', title: 'TRouteAI', status: async () => ({ running }), stop: async () => { stops++; return { ok: true }; } };
  await idle.apply([{ type: 'close-shell', session: 'old', idleMs: 13 * H }, { type: 'stop-gateway', addon: 'trouteai', idleMs: 31 * MIN }], { deck, addons: [addon], record: rec.record });
  assert.deepEqual(deck.killed, ['old']);
  assert.equal(stops, 1);
  running = false;
  await idle.apply([{ type: 'stop-gateway', addon: 'trouteai', idleMs: 31 * MIN }], { deck, addons: [addon], record: rec.record });
  assert.equal(stops, 1);
  assert.equal(rec.entries.length, 2, 'an already stopped gateway is not logged');
});
