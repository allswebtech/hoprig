// Updates and idle care.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as idle from '../../src/automation/idle.mjs';
import * as updates from '../../src/automation/updates.mjs';
import { createUpdater } from '../../src/automation/updater.mjs';
import { claude, fakeDeck, fakeItem, recorder, shell } from './helpers.mjs';

const H = 3600_000;
const MIN = 60_000;

// ---- updates ----

test('updates: a look every 6 hours in both modes, never while a session works; a wait is tried again in 10 minutes', () => {
  assert.deepEqual(updates.decide({ cards: [claude('w', { status: 'working' })], data: {}, now: 10 * H }).actions, []);
  assert.deepEqual(updates.decide({ cards: [claude('w', { status: 'starting' })], data: {}, now: 10 * H }).actions, []);
  const r = updates.decide({ cards: [claude('w', { status: 'waiting' })], data: {}, now: 10 * H });
  assert.deepEqual(r.actions, [{ type: 'check' }]);
  assert.deepEqual(updates.decide({ cards: [], data: r.data, now: 16 * H - 1 }).actions, []);
  assert.deepEqual(updates.decide({ cards: [], data: r.data, now: 16 * H }).actions, [{ type: 'check' }]);
  const waiting = { ...r.data, retryAt: 10 * H + 10 * MIN };
  assert.deepEqual(updates.decide({ cards: [], data: waiting, now: 10 * H + 10 * MIN - 1 }).actions, []);
  const again = updates.decide({ cards: [], data: waiting, now: 10 * H + 10 * MIN });
  assert.deepEqual(again.actions, [{ type: 'check' }]);
  assert.equal(again.data.retryAt, 0);
});

const row = (id, o = {}) => ({ id, title: id, installed: '1.0.0', latest: '1.1.0', updateAvailable: true, canUpdate: true, auto: true, ...o });

test('updates: manual tells once per new version (only with notify on) and never installs; auto updates what may update itself', () => {
  const rows = [row('claude'), row('hoprig', { auto: false }), row('codex', { installed: null }), row('cloudflared', { updateAvailable: false })];
  assert.deepEqual(updates.afterCheck({ rows, settings: { mode: 'manual', notify: false }, data: {} }).actions, []);
  let r = updates.afterCheck({ rows, settings: { mode: 'manual', notify: true }, data: {} });
  assert.deepEqual(r.actions.map((a) => `${a.type}:${a.id}`), ['tell:claude', 'tell:hoprig'], 'not installed and up to date are not told');
  assert.deepEqual(updates.afterCheck({ rows, settings: { mode: 'manual', notify: true }, data: r.data }).actions, [], 'already told');
  r = updates.afterCheck({ rows: [row('claude', { latest: '1.2.0' })], settings: { mode: 'manual', notify: true }, data: r.data });
  assert.deepEqual(r.actions.map((a) => a.latest), ['1.2.0'], 'a newer one is told again');
  r = updates.afterCheck({ rows, settings: { mode: 'auto', notify: false }, data: {} });
  assert.deepEqual(r.actions.map((a) => `${a.type}:${a.id}`), ['update:claude'], 'Hoprig from a checkout (auto false) is never updated by itself; a missing tool is never installed');
  r = updates.afterCheck({ rows, settings: { mode: 'auto', notify: true }, data: {} });
  assert.deepEqual(r.actions.map((a) => `${a.type}:${a.id}`), ['update:claude', 'tell:hoprig'], 'what may not update itself is still told');
});

test('updates: the settings, and the old Claude-only setting read once into them', () => {
  assert.deepEqual(updates.readUpdateSettings({}), { mode: 'manual', notify: false }, 'Manual by default');
  assert.deepEqual(updates.readUpdateSettings({ automation: { updates: { claude: 'auto' } } }), { mode: 'auto', notify: false });
  assert.deepEqual(updates.readUpdateSettings({ automation: { updates: { claude: 'notify' } } }), { mode: 'manual', notify: true });
  assert.deepEqual(updates.readUpdateSettings({ automation: { updates: { claude: 'off' } } }), { mode: 'manual', notify: false });
  assert.deepEqual(updates.readUpdateSettings({ updates: { mode: 'auto', notify: true }, automation: { updates: { claude: 'off' } } }), { mode: 'auto', notify: true }, 'the new one wins');
  assert.deepEqual(updates.readUpdateSettings({ updates: { mode: 'sometimes' } }), { mode: 'manual', notify: false });
  let saved = null;
  const cfg = { automation: { retry: { enabled: true }, updates: { claude: 'auto' } } };
  assert.equal(updates.migrateUpdates(cfg, (p) => { saved = p; }), true);
  assert.deepEqual(saved, { updates: { mode: 'auto', notify: false }, automation: { retry: { enabled: true } } });
  assert.equal(updates.migrateUpdates({ automation: { retry: {} } }, () => assert.fail('nothing to move')), false);
  assert.deepEqual(updates.cleanUpdateSettings({ mode: 'auto' }, { mode: 'manual', notify: true }), { mode: 'auto', notify: true });
  assert.throws(() => updates.cleanUpdateSettings({ mode: 'always' }, {}), /"manual" or "auto"/);
  assert.throws(() => updates.cleanUpdateSettings({ notify: 'yes' }, {}), /on or off/);
  assert.throws(() => updates.cleanUpdateSettings({ claude: 'auto' }, {}), /not an update setting/);
  assert.deepEqual(updates.fromLegacy('notify'), { mode: 'manual', notify: true });
  assert.throws(() => updates.fromLegacy('always'), /off, notify, auto/);
  assert.equal(updates.legacyValue({ mode: 'auto', notify: false }), 'auto');
  assert.equal(updates.legacyValue({ mode: 'manual', notify: true }), 'notify');
  assert.equal(updates.legacyValue({ mode: 'manual', notify: false }), 'off');
});

/** An updater over stand-in items, for the apply tests. */
function updaterOf(items, cards = []) {
  let cfg = { updates: { mode: 'auto' } };
  const rec = recorder();
  const u = createUpdater({ items, cards: async () => cards, config: () => cfg, saveConfig: (p) => (cfg = { ...cfg, ...p }), record: rec.record });
  return { u, rec };
}

test('updates apply: Automatic updates only at a safe moment; a wait is logged once per version and tried again', async () => {
  const newer = { installed: '2.1.0', latest: '2.2.0', method: 'native', updateAvailable: true, canUpdate: true };
  let working = true;
  const item = fakeItem('claude', { title: 'Claude Code', info: newer, autoBlocked: () => (working ? '1 working Claude Code session' : null) });
  const { u } = updaterOf([item]);
  const rec = recorder();
  let data = { lastCheckAt: 5 };
  const ctx = () => ({ updater: u, record: rec.record, notify: rec.notify, settings: { mode: 'auto', notify: false }, data, save: (d) => { data = d; }, now: () => 1000 });
  await updates.apply([{ type: 'check' }], ctx());
  assert.equal(item.calls.update, 0);
  assert.match(rec.entries[0].outcome, /postponed: 1 working Claude Code session/);
  assert.equal(data.retryAt, 1000 + updates.RETRY_MS, 'tried again in 10 minutes');
  await updates.apply([{ type: 'check' }], ctx());
  assert.equal(rec.entries.length, 1, 'the same wait is not logged again');
  working = false;
  await updates.apply([{ type: 'check' }], ctx());
  assert.equal(item.calls.update, 1);
  assert.match(rec.entries[1].outcome, /ok: now 2\.2\.0/);
  assert.equal(rec.notes[0].title, 'Claude Code updated to 2.2.0');
  assert.deepEqual(data.waiting, {});
});

test('updates apply: a failed look is logged as the item\'s error, not thrown; a refused update is reported', async () => {
  const broken = fakeItem('codex', { fail: 'offline' });
  const bad = fakeItem('opencode', { info: { installed: '2.3.0', latest: '2.4.0', updateAvailable: true, canUpdate: true }, update: () => ({ ok: false, output: 'npm error\nE404 no such version' }) });
  const { u } = updaterOf([broken, bad]);
  const rec = recorder();
  await updates.apply([{ type: 'check' }], { updater: u, record: rec.record, notify: rec.notify, settings: { mode: 'auto', notify: false }, data: {}, save: () => {}, now: () => 0 });
  assert.deepEqual(rec.entries.map((e) => e.outcome), ['failed: E404 no such version']);
  assert.equal((await u.view()).items[0].error, 'offline');
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
