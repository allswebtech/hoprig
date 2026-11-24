// The operator's routes over real HTTP on a test dashboard with made-up sources and stand-in acts: the list, a tap,
// a stale item, an act that is not allowed, a double tap, a request without the login, and the timeline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

const box = sandbox('operator-routes');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });

// What the board sees; a test changes it to make a thing appear, change or go.
const world = { sessions: [session({ name: 'alpha', limit: { at: ago(5), text: 'Usage limit reached' } })] };
const calls = [];
let slowStop = null;
const sources = { sessions: () => world.sessions };
const app = createServer({
  backend: { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} },
  watch: false,
  operator: {
    sources,
    now: () => NOW,
    cacheMs: 0,
    session: {
      move: async (name, to) => { calls.push(['move', name, to]); },
      stop: async (name) => { calls.push(['stop', name]); if (slowStop) await slowStop; },
    },
  },
});
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function call(p, body, { auth = true } = {}) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, ...(auth ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
const first = async () => (await call('/api/operator/attention')).json.items[0];

test('the list: the item, the acts catalog once, what is watched; nothing server-side in it', async () => {
  const r = await call('/api/operator/attention');
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 1);
  const it = r.json.items[0];
  assert.equal(it.kind, 'limit');
  assert.equal(it.recommended, 'switch');
  assert.equal(it.target, undefined);
  assert.equal(r.json.acts.switch.label, 'Continue on the next provider');
  assert.ok(r.json.acts.dismiss, 'Not now is always in the catalog');
  assert.ok(r.json.watched.find((w) => w.source === 'sessions').ok);
  assert.equal(r.json.watched.find((w) => w.source === 'repos').error, 'could not be read: not on this computer');
  assert.equal((await call('/api/operator/attention?kind=asks')).json.count, 0, 'kind narrows the list on the server');
  assert.equal((await call('/api/operator/attention?kind=limit')).json.count, 1);
  assert.equal((await call('/api/operator/attention?kind=weather')).status, 400);
  const b = await call('/api/operator/board');
  assert.equal(b.json.sessions.count, 1);
});

test('without the login nothing is shown and nothing is done', async () => {
  assert.equal((await call('/api/operator/attention', undefined, { auth: false })).status, 401);
  const it = await first();
  const r = await call('/api/operator/act', { item: it.id, act: 'switch', seen: it.rev }, { auth: false });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test('a malformed tap is refused before anything is read', async () => {
  const it = await first();
  for (const body of [{}, { item: it.id, act: 'switch' }, { item: '../x', act: 'switch', seen: it.rev }, { item: it.id, act: 'switch', seen: it.rev, extra: 1 }, { item: it.id, act: 'SWITCH; rm', seen: it.rev }]) {
    assert.equal((await call('/api/operator/act', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test('an act that is not one of the item\'s is refused with the allowed ones', async () => {
  const it = await first();
  const r = await call('/api/operator/act', { item: it.id, act: 'push', seen: it.rev });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json.allowed, ['switch', 'open', 'stop', 'dismiss']);
  assert.equal(calls.length, 0);
});

test('a stale item is refused with the current one; a gone item is refused', async () => {
  const it = await first();
  world.sessions = [session({ name: 'alpha', limit: { at: ago(5), text: 'Usage limit reached · other words' } })];
  const r = await call('/api/operator/act', { item: it.id, act: 'switch', seen: it.rev });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /changed since you saw it/);
  assert.equal(r.json.current.id, it.id);
  assert.notEqual(r.json.current.rev, it.rev);
  world.sessions = [];
  const g = await call('/api/operator/act', { item: it.id, act: 'switch', seen: r.json.current.rev });
  assert.equal(g.status, 409);
  assert.match(g.json.error, /gone/);
  assert.equal(calls.length, 0);
});

test('the same tap twice does the act once, also when the two come at the same moment', async () => {
  world.sessions = [session({ name: 'beta', state: 'working', progressAt: ago(45) })];
  const it = await first();
  assert.equal(it.kind, 'stuck');
  let release;
  slowStop = new Promise((r) => (release = r));
  const body = { item: it.id, act: 'stop', seen: it.rev };
  const a = call('/api/operator/act', body);
  const b = call('/api/operator/act', body);
  await new Promise((r) => setTimeout(r, 50));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  slowStop = null;
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.equal(ra.json.said, 'session beta: stopped', 'the words of the timeline, for the toast');
  assert.deepEqual(calls, [['stop', 'beta']]);
  const again = await call('/api/operator/act', body);
  assert.equal(again.status, 200);
  assert.equal(again.json.again, true);
  assert.deepEqual(calls, [['stop', 'beta']]);
});

test('Not now hides an item until its facts change; every tap is one line in the timeline', async () => {
  calls.length = 0;
  world.sessions = [session({ name: 'gamma', state: 'attention', asks: ['main'], askType: 'question', askAt: ago(3) })];
  const it = await first();
  const r = await call('/api/operator/act', { item: it.id, act: 'dismiss', seen: it.rev });
  assert.equal(r.status, 200);
  const after = await call('/api/operator/attention');
  assert.equal(after.json.count, 0);
  assert.equal(after.json.hidden, 1);
  world.sessions = [session({ name: 'gamma', state: 'attention', asks: ['main', 'a77'], askType: 'question', askAt: ago(3) })];
  assert.equal((await call('/api/operator/attention')).json.count, 1, 'an agent now waits too: it is back');
  const tl = after.json.timeline;
  assert.equal(tl[0].act, 'dismiss');
  assert.equal(tl[0].ok, true);
  assert.equal(tl[1].act, 'stop');
  const file = path.join(box.state, 'operator', 'timeline.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.act), ['stop', 'dismiss']);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['act', 'at', 'item', 'kind', 'ok', 'result', 'subject']);
});

test('only the owner\'s page taps: another computer or Tia\'s door is refused', async () => {
  for (const who of ['computer', 'self']) {
    const ctx = { HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, caller: () => who, readJson: async () => ({}), config: () => ({}) };
    const f = operatorFeature(ctx, { sources: {}, now: () => NOW });
    const route = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/operator/act'));
    await assert.rejects(route[2]({ url: '/api/operator/act', socket: {} }), (e) => e.status === 403);
  }
});

test('a tap made a few minutes after the look is still accepted (only time went by); a put-off item that went away and came back is shown, also while a source of another kind cannot be read', async () => {
  calls.length = 0;
  let t = NOW;
  const ctxWorld = { sessions: [session({ name: 'delta', state: 'working', progressAt: ago(30) })] };
  const app2 = createServer({ backend: { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} }, watch: false,
    operator: { sources: { sessions: () => { if (ctxWorld.sessions === null) throw new Error('the dashboard state could not be read'); return ctxWorld.sessions; }, schedules: () => { throw new Error('the schedules file could not be read'); } }, now: () => t, cacheMs: 0, session: { stop: async (n) => calls.push(['stop', n]) } } });
  const { port: p2 } = await app2.listen(0, '127.0.0.1');
  const b2 = `http://127.0.0.1:${p2}`;
  try {
    const l = await fetch(`${b2}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2 }, body: JSON.stringify({ password: 'right-password' }) });
    const c2 = l.headers.get('set-cookie').split(';')[0];
    const go = async (p, body) => (await fetch(b2 + p, { method: body ? 'POST' : 'GET', headers: { Origin: b2, Cookie: c2, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
    const [it] = (await go('/api/operator/attention')).items;
    t = NOW + 3 * 60_000;
    assert.equal((await go('/api/operator/act', { item: it.id, act: 'dismiss', seen: it.rev })).ok, true);
    assert.equal((await go('/api/operator/attention')).count, 0);
    ctxWorld.sessions = [];
    assert.equal((await go('/api/operator/attention')).hidden, 0, 'gone: forgotten');
    ctxWorld.sessions = [session({ name: 'delta', state: 'working', progressAt: ago(30) })];
    assert.equal((await go('/api/operator/attention')).count, 1, 'back again: shown again');
    assert.equal((await go('/api/operator/attention')).watched.find((w) => w.source === 'schedules').ok, false, 'the other source failed all along');
    // Put off again (later than the 60 s in which the same tap is the same tap); then its own source cannot be read:
    // the look cannot tell whether it went, so it stays put off.
    t += 2 * 60_000;
    const [again] = (await go('/api/operator/attention')).items;
    assert.equal((await go('/api/operator/act', { item: again.id, act: 'dismiss', seen: again.rev })).ok, true);
    ctxWorld.sessions = null;
    await go('/api/operator/attention');
    ctxWorld.sessions = [session({ name: 'delta', state: 'working', progressAt: ago(30) })];
    const back = await go('/api/operator/attention');
    assert.deepEqual([back.count, back.hidden], [0, 1], 'its sessions were unread: still put off');
  } finally {
    await app2.close();
  }
});
