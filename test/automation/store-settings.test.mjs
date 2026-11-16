// The store's atomic writes, settings validation, the global pause, and the routes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAutomation } from '../../src/automation/index.mjs';
import { automationFeature } from '../../src/automation/feature.mjs';
import { DEFAULTS, cleanSettingsPatch, readSettings } from '../../src/automation/settings.mjs';
import { createActivityLog, createStore, writeAtomic } from '../../src/automation/store.mjs';
import { claude, fakeCtx, fakeDeck, tmpDir } from './helpers.mjs';

const posix = process.platform !== 'win32';

test('store: atomic writes, mode 600 in a 700 folder, no temporary file left', () => {
  const t = tmpDir('store');
  try {
    const s = createStore(path.join(t.dir, 'automation'));
    s.write('queue', { w: { items: [1] } });
    const file = path.join(t.dir, 'automation', 'queue.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { w: { items: [1] } });
    if (posix) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['queue.json']);
    // A failed write leaves the old file whole and no temporary behind.
    assert.throws(() => writeAtomic(file, { big: 1n }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { w: { items: [1] } });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['queue.json']);
    // Values handed out are copies: changing one does not change the store.
    const v = s.read('queue', {});
    v.w.items.push(2);
    assert.deepEqual(s.read('queue', {}), { w: { items: [1] } });
    assert.deepEqual(s.update('queue', {}, (x) => ({ ...x, n: 1 })), { w: { items: [1] }, n: 1 });
    assert.throws(() => s.read('../etc', {}), /bad store name/);
  } finally {
    t.cleanup();
  }
});

test('store: a broken file gives the fallback and is kept aside', () => {
  const t = tmpDir('store-broken');
  try {
    fs.writeFileSync(path.join(t.dir, 'retry.json'), '{ not json');
    const s = createStore(t.dir);
    assert.deepEqual(s.read('retry', { ok: 1 }), { ok: 1 });
    assert.ok(fs.existsSync(path.join(t.dir, 'retry.json.broken')));
  } finally {
    t.cleanup();
  }
});

test('activity log: JSON lines, newest first, cut back when it grows', () => {
  const t = tmpDir('log');
  try {
    const log = createActivityLog(path.join(t.dir, 'automation.log'), { now: () => 0, max: 2000 });
    for (let i = 0; i < 40; i++) log.add({ automation: 'queue', session: 'w', did: `sent ${i}`, outcome: 'ok' });
    const recent = log.recent(3);
    assert.deepEqual(recent.map((e) => e.did), ['sent 39', 'sent 38', 'sent 37']);
    assert.deepEqual(Object.keys(recent[0]), ['time', 'automation', 'session', 'did', 'outcome']);
    assert.ok(fs.statSync(log.file).size <= 2000 + 200);
    if (posix) assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
  } finally {
    t.cleanup();
  }
});

test('settings: strict validation with plain messages', () => {
  const next = cleanSettingsPatch({ retry: { enabled: true, max: 5 }, idle: { shells: true, shellHours: 24 }, paused: true }, DEFAULTS);
  assert.equal(next.retry.max, 5);
  assert.equal(next.retry.firstMinutes, 1, 'untouched keys keep their value');
  assert.equal(next.paused, true);
  assert.equal(DEFAULTS.retry.max, 3, 'the defaults are not changed');
  const bad = [
    [{ nope: {} }, /"nope" is not an automation setting/],
    [{ retry: { enabled: true, tries: 3 } }, /"retry.tries" is not an automation setting/],
    [{ retry: { max: 0 } }, /from 1 to 10/],
    [{ retry: { max: 2.5 } }, /whole number/],
    [{ retry: { max: '3' } }, null],
    [{ retry: { enabled: 'yes' } }, /on or off/],
    [{ retry: { prompt: 'two\nlines' } }, /one line/],
    [{ updates: { claude: 'auto' } }, /"updates" is not an automation setting/], // Settings → Updates (src/automation/updates.mjs)
    [{ remind: { enabled: true } }, /"remind" is not an automation setting/],
    [{ idle: { gatewayMinutes: 1 } }, /from 5 to 1440/],
    [{ schedules: { list: [] } }, /one at a time/],
    [{ schedules: { lateHours: 49 } }, /from 0 to 48/],
    [{ restore: { enabled: 'auto' } }, /null for the default/],
    [{ paused: 1 }, /on or off/],
    [{ queue: true }, /must be an object/],
    [[], /object/],
  ];
  for (const [p, re] of bad) {
    if (re === null) assert.equal(cleanSettingsPatch(p).retry.max, 3, 'a number in a string is accepted');
    else assert.throws(() => cleanSettingsPatch(p), re, JSON.stringify(p));
  }
});

test('settings as stored: broken values fall back, broken schedules are left out', () => {
  const s = readSettings({
    paused: 'yes',
    retry: { max: 99, enabled: true },
    schedules: { list: [{ id: 'abcd1', when: { kind: 'daily', time: '07:00' }, action: { type: 'send', session: 'w', text: 'hi' }, since: 5 }, { id: 'abcd2', when: { kind: 'hourly' } }] },
  });
  assert.equal(s.paused, false);
  assert.equal(s.retry.max, 3);
  assert.equal(s.retry.enabled, true);
  assert.deepEqual(s.schedules.list.map((x) => [x.id, x.since]), [['abcd1', 5]]);
  assert.deepEqual(readSettings(null), JSON.parse(JSON.stringify(DEFAULTS)));
});

test('pause all: nothing is sent, started or closed until it is lifted', async () => {
  const t = tmpDir('pause');
  try {
    const deck = fakeDeck([claude('w', { stopAt: 100 })]);
    const f = fakeCtx({ deck, stateDir: t.dir, now: () => 1000, automation: { paused: true, idle: { shells: true, shellHours: 1 } } });
    const a = createAutomation(f.ctx);
    a.enqueue('w', 'A');
    assert.deepEqual(await a.tick(), { paused: true });
    assert.deepEqual(deck.sent, []);
    a.api.changeSettings({ paused: false });
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']]);
    a.api.changeSettings({ queue: { enabled: false } });
    a.enqueue('w', 'B');
    deck.cards = [claude('w', { stopAt: 200 })];
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']], 'the queue\'s own switch');
    await a.close();
    assert.deepEqual(await a.tick(), { skipped: 'closed' });
  } finally {
    t.cleanup();
  }
});

// ---- routes ----

const req = (body) => Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
const call = async (feature, method, url, body) => {
  const u = new URL(url, 'http://x');
  for (const [m, re, fn] of feature.routes) {
    const match = re.exec(u.pathname);
    if (match && m === method) return fn(req(body), match, u.searchParams);
  }
  throw new Error(`no route ${method} ${url}`);
};

test('routes: settings, queue and schedules through the plug-in, with refusals as 400s', async () => {
  const t = tmpDir('routes');
  try {
    const deck = fakeDeck([claude('w', { status: 'working' })]);
    const f = fakeCtx({ deck, stateDir: t.dir, now: () => Date.UTC(2026, 5, 1, 12), checks: { dirOk: (d) => d === '/w', profileOk: (p) => ['sub', 'auto'].includes(p) } });
    const feature = automationFeature(null, { ctx: f.ctx, tick: false }); // no timer in tests; ticks are driven by hand
    assert.equal(feature.name, 'automation');
    await assert.rejects(call(feature, 'GET', '/api/automation'), (e) => e.status === 503);
    feature.start();

    const st = await call(feature, 'GET', '/api/automation');
    assert.equal(st.restoreOn, true);
    assert.equal(st.settings.workspace.commitMap, false, 'never chosen, the brain has no address (the fake): off, as true or false');
    assert.deepEqual(st.commitMap, { on: false, chosen: false, github: false });
    assert.deepEqual((await call(feature, 'POST', '/api/automation/settings', { retry: { enabled: true } })).settings.retry.enabled, true);
    assert.equal(f.config().automation.retry.enabled, true, 'saved under the "automation" key');
    await assert.rejects(call(feature, 'POST', '/api/automation/settings', { retry: { max: 50 } }), (e) => e.status === 400 && /from 1 to 10/.test(e.message));
    await assert.rejects(call(feature, 'POST', '/api/automation/settings', 'not json'), (e) => e.status === 400);
    await assert.rejects(call(feature, 'POST', '/api/automation/settings', { x: 'y'.repeat(70 * 1024) }), (e) => e.status === 413);

    let q = await call(feature, 'POST', '/api/automation/queue/w', { op: 'add', text: 'A' });
    q = await call(feature, 'POST', '/api/automation/queue/w', { op: 'add', text: 'B', position: 0 });
    assert.deepEqual(q.items.map((x) => x.text), ['B', 'A']);
    q = await call(feature, 'POST', '/api/automation/queue/w', { op: 'move', id: q.items[1].id, to: 0 });
    assert.deepEqual(q.items.map((x) => x.text), ['A', 'B']);
    q = await call(feature, 'POST', '/api/automation/queue/w', { op: 'pause', paused: true });
    assert.equal(q.paused, true);
    assert.deepEqual((await call(feature, 'GET', '/api/automation')).queues, { w: { paused: true, count: 2 } });
    await assert.rejects(call(feature, 'POST', '/api/automation/queue/nobody', { op: 'add', text: 'A' }), (e) => e.status === 404);
    await assert.rejects(call(feature, 'POST', '/api/automation/queue/w', { op: 'add', text: 'A', extra: 1 }), (e) => e.status === 400 && /"extra"/.test(e.message));
    await assert.rejects(call(feature, 'POST', '/api/automation/queue/w', { op: 'explode' }), (e) => e.status === 400);
    await assert.rejects(call(feature, 'POST', '/api/automation/queue/w', { op: 'remove', id: 'zzzz' }), (e) => e.status === 404);
    await assert.rejects(call(feature, 'GET', '/api/automation/queue/..%2Fx'), (e) => e.status === 400);
    q = await call(feature, 'POST', '/api/automation/queue/w', { op: 'clear' });
    assert.deepEqual(q.items, []);

    const schedule = { label: 'Morning', when: { kind: 'daily', time: '07:00' }, action: { type: 'start', dir: '/w', profile: 'auto', prompt: 'go' } };
    let list = (await call(feature, 'POST', '/api/automation/schedules', { op: 'add', schedule })).schedules;
    assert.equal(list.length, 1);
    assert.ok(list[0].nextAt > Date.UTC(2026, 5, 1, 12));
    const id = list[0].id;
    list = (await call(feature, 'POST', '/api/automation/schedules', { op: 'change', id, schedule: { ...schedule, enabled: false } })).schedules;
    assert.equal(list[0].enabled, false);
    assert.equal(list[0].nextAt, null);
    await assert.rejects(call(feature, 'POST', '/api/automation/schedules', { op: 'add', schedule: { ...schedule, action: { ...schedule.action, dir: '/etc' } } }), (e) => e.status === 400 && /may use/.test(e.message));
    await assert.rejects(call(feature, 'POST', '/api/automation/schedules', { op: 'delete', id: 'nope1' }), (e) => e.status === 404);
    list = (await call(feature, 'POST', '/api/automation/schedules', { op: 'delete', id })).schedules;
    assert.deepEqual(list, []);

    const log = await call(feature, 'GET', '/api/automation/log?limit=5');
    assert.ok(Array.isArray(log.entries));
    await feature.close();
  } finally {
    t.cleanup();
  }
});
