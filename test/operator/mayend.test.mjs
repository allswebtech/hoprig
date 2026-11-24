// "Tia may end a stuck session in this project": the tick beside a project's note. A decision is offered `stop` only
// with the tick on; a note, whatever it says, never offers it. Off at first and off for a config written before the
// tick, also where a note asks for the stop. Stored through the note's own route (POST /api/operator/settings, note:
// { project, text, mayEnd }), refused there exactly as the note is. Made-up sources, a stand-in model and stand-in acts:
// nothing here calls a real model or ends anything real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

const box = sandbox('operator-mayend');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');
const { offeredSteps } = await import('../../src/operator/decide-table.mjs');
const { mayEndFor } = await import('../../src/operator/decide-store.mjs');
const { SETTLE_MS } = await import('../../src/operator/decider.mjs');

const projects = path.join(box.workspace, 'projects');
fs.mkdirSync(path.join(projects, 'shop'), { recursive: true });
fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true });
const opDir = path.join(box.state, 'operator');
const STOP_NOTE = 'If a session still hangs after a nudge, stop it.';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- the table: stop only with the tick ----------

test('stop is offered only with the tick on; a note that asks for the stop offers nothing without it', () => {
  const item = { steps: ['nudge', 'stop'] };
  assert.deepEqual(offeredSteps(item, true), ['nudge', 'stop'], 'the tick on: stop is offered');
  for (const off of [false, undefined, null, 'true', 1, {}, STOP_NOTE, 'stop it when stuck']) assert.deepEqual(offeredSteps(item, off), ['nudge'], `not the tick: ${JSON.stringify(off)}`);
  assert.deepEqual(offeredSteps({ steps: ['stop'] }, false), [], 'only stop and no tick: nothing to decide');
  assert.deepEqual(offeredSteps({ steps: ['switch', 'wait'] }, false), ['switch', 'wait'], 'other steps never need the tick');
});

test('a config written before the tick: a note that asks for the stop, no mayEnd, so no stop', () => {
  const old = { operator: { notes: { shop: STOP_NOTE }, decide: { on: true } } };
  assert.equal(mayEndFor(old, 'shop'), false);
  assert.deepEqual(offeredSteps({ steps: ['nudge', 'stop'] }, mayEndFor(old, 'shop')), ['nudge']);
  // Only exactly true is on; another project's tick is not this one's.
  for (const v of ['yes', 1, {}, [], null]) assert.equal(mayEndFor({ operator: { mayEnd: { shop: v } } }, 'shop'), false, JSON.stringify(v));
  for (const broken of [null, 'shop', ['shop'], true]) assert.equal(mayEndFor({ operator: { mayEnd: broken } }, 'shop'), false, JSON.stringify(broken));
  assert.equal(mayEndFor({ operator: { mayEnd: { alpha: true } } }, 'shop'), false);
  assert.equal(mayEndFor({ operator: { mayEnd: { shop: true } } }, 'shop'), true);
  assert.equal(mayEndFor({ operator: { mayEnd: { shop: true } } }, '__proto__'), false);
});

// ---------- a decision: the tick both ways, through the real decider ----------

function rig({ notes = {}, mayEnd, answer = 'stop-session\nThe note says to stop it.', during = null } = {}) {
  fs.rmSync(opDir, { recursive: true, force: true });
  saveConfig({ projectsDir: projects, assistant: { enabled: true }, operator: { acts: true, rules: {}, decide: { on: true }, notes, ...(mayEnd === undefined ? {} : { mayEnd }) } });
  const world = { sessions: [session({ name: 'fixer', folder: path.join(projects, 'shop'), progressAt: ago(40) })], gateways: [], live: null, leftovers: [], machine: null };
  const calls = [];
  const asked = [];
  const clock = { t: NOW };
  const accounts = { profiles: [{ name: 'plan-a', kind: 'subscription' }], autoSwitch: { enabled: false } };
  const ticker = { fn: null };
  const ctx = { HttpError, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: (fn) => { ticker.fn = fn; return () => {}; } };
  const f = operatorFeature(ctx, {
    sources: { sessions: () => world.sessions, gateways: () => world.gateways, live: () => world.live, leftovers: () => world.leftovers, machine: () => world.machine },
    now: () => clock.t,
    cacheMs: 0,
    accounts: async () => accounts,
    turn: async (a) => {
      asked.push(a);
      if (during) during(); // what he does while the call runs
      return { ok: true, text: Array.isArray(answer) ? answer[Math.min(asked.length, answer.length) - 1] : answer, tokens: 900, usd: 0 };
    },
    session: {
      move: async (name, to) => calls.push(['move', name, to]),
      stop: async (name) => calls.push(['stop', name]),
      nudge: async (name, text) => calls.push(['nudge', name, text]),
    },
  });
  const tick = async () => {
    await ticker.fn();
    await f.deciding?.();
  };
  const route = (method, p) => f.routes.find(([mm, re]) => mm === method && re.test(p));
  const call = (method, p, body, who = 'page') => {
    ctx.caller = () => who;
    const r = route(method, p);
    return r[2]({ url: p, body, socket: {} }, p.match(r[1]));
  };
  return { calls, asked, clock, tick, call, view: () => f.reflex.view() };
}
const offeredLine = (a) => a.prompt.split('Steps offered:')[1].split('\n')[0];

test('the tick on: a decision is offered stop and the stuck session is ended through the door', async () => {
  const r = rig({ notes: { shop: STOP_NOTE }, mayEnd: { shop: true } });
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  assert.equal(r.asked.length, 1);
  assert.match(offeredLine(r.asked[0]), /stop-session/);
  assert.deepEqual(r.calls, [['stop', 'fixer']]);
});

test('a note that asks for the stop and no tick: stop is not offered and nothing is ended', async () => {
  const r = rig({ notes: { shop: STOP_NOTE } });
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  assert.equal(r.asked.length, 1, 'the nudge is still offered, so one call is made');
  assert.doesNotMatch(offeredLine(r.asked[0]), /stop-session/);
  assert.match(r.asked[0].prompt, /If a session still hangs after a nudge, stop it\./, 'the note still reaches her as his words');
  assert.ok(!r.calls.some((c) => c[0] === 'stop'), 'nothing was ended');
});

test('another project\'s tick does not offer stop here', async () => {
  const r = rig({ notes: { shop: STOP_NOTE }, mayEnd: { alpha: true } });
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  assert.doesNotMatch(offeredLine(r.asked[0]), /stop-session/);
  assert.ok(!r.calls.some((c) => c[0] === 'stop'));
});

test('he takes the tick off while the call runs: the stop picked is not done, and the item is his with one line', async () => {
  const r = rig({ notes: { shop: STOP_NOTE }, mayEnd: { shop: true }, during: () => saveConfig({ operator: { ...loadConfig().operator, mayEnd: {} } }) });
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  assert.equal(r.asked.length, 1);
  assert.match(offeredLine(r.asked[0]), /stop-session/, 'offered while the tick was on');
  assert.deepEqual(r.calls, [], 'nothing was ended once the tick was off');
  const tl = fs.readFileSync(path.join(opDir, 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(tl.some((l) => l.refused && /needs the tick "Tia may end a stuck session in this project"/.test(l.result)), JSON.stringify(tl));
});

test('nudged once and still stuck, a note that asks for the stop and no tick: his with one line that names the tick, no call', async () => {
  const r = rig({ notes: { shop: STOP_NOTE }, answer: 'nudge-once\nThe usual first step.' });
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  assert.deepEqual(r.calls.map((c) => c.slice(0, 2)), [['nudge', 'fixer']], 'the nudge first');
  // Past the wait between two tries on one item, the nudged item comes back with only stop left, and no tick.
  r.clock.t += 11 * 60_000;
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  await r.tick();
  assert.equal(r.asked.length, 1, 'no second call: stop is not hers to pick');
  assert.ok(!r.calls.some((c) => c[0] === 'stop'));
  const tl = fs.readFileSync(path.join(opDir, 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const said = tl.filter((l) => l.by === 'decide' && l.refused).map((l) => l.result);
  assert.deepEqual(said, ['Ending this session needs the tick "Tia may end a stuck session in this project" on its project page: it is yours'], 'one line, once');
  const his = Object.values(r.view().his);
  assert.equal(his.length, 1);
  assert.match(his[0].words, /needs the tick/);
});

test('the card asks for the tick and he sets it through the note\'s route: the same item is decided again, offered stop', async () => {
  const r = rig({ notes: { shop: STOP_NOTE }, answer: ['nudge-once\nThe usual first step.', 'stop-session\nThe note says to stop it.'] });
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  r.clock.t += 11 * 60_000;
  await r.tick();
  r.clock.t += SETTLE_MS;
  await r.tick();
  assert.equal(r.asked.length, 1);
  assert.match(Object.values(r.view().his)[0].words, /needs the tick/);
  // Ticks with no change make no call: the picture decided is the same.
  r.clock.t += 60_000;
  await r.tick();
  assert.equal(r.asked.length, 1);
  const res = await r.call('POST', '/api/operator/settings', { note: { project: 'shop', text: STOP_NOTE, mayEnd: true } });
  assert.equal(res.note.mayEnd, true);
  r.clock.t += 60_000;
  await r.tick();
  assert.equal(r.asked.length, 2, 'the tick brings the same item back: one call');
  assert.match(offeredLine(r.asked[1]), /stop-session/);
  assert.deepEqual(r.calls.map((c) => c.slice(0, 2)), [['nudge', 'fixer'], ['stop', 'fixer']]);
  r.clock.t += 60_000;
  await r.tick();
  assert.equal(r.asked.length, 2, 'decided once with the tick');
  assert.ok(!Object.values(r.view().his).some((h) => /needs the tick/.test(h.words)), 'the card no longer says the tick is needed');
});

// ---------- the route: the note's body carries the tick ----------

test('the note\'s route stores and clears the tick; a note saved without the field keeps it; other settings keep it', async () => {
  const r = rig();
  const set = (note) => r.call('POST', '/api/operator/settings', { note });
  assert.equal((await r.call('GET', '/api/operator/note?project=shop')).mayEnd, false, 'off at first');
  const on = await set({ project: 'shop', text: STOP_NOTE, mayEnd: true });
  assert.deepEqual(on.note, { project: 'shop', text: STOP_NOTE, mayEnd: true, cleaned: false });
  assert.deepEqual(loadConfig().operator.mayEnd, { shop: true });
  assert.equal(loadConfig().operator.notes.shop, STOP_NOTE, 'the note keeps its shape: a string');
  assert.equal((await r.call('GET', '/api/operator/note?project=shop')).mayEnd, true);
  // A body without the field leaves the tick as it was.
  const kept = await set({ project: 'shop', text: 'Wait for a short reset.' });
  assert.equal(kept.note.mayEnd, true);
  assert.deepEqual(loadConfig().operator.mayEnd, { shop: true });
  // Another setting saved through the same route keeps it too.
  await r.call('POST', '/api/operator/settings', { decide: { perHour: 5 } });
  assert.deepEqual(loadConfig().operator.mayEnd, { shop: true });
  // The projects prefix the page may send names the same project.
  await set({ project: 'projects/alpha', text: '', mayEnd: true });
  assert.deepEqual(loadConfig().operator.mayEnd, { shop: true, alpha: true });
  const off = await set({ project: 'shop', text: 'Wait for a short reset.', mayEnd: false });
  assert.equal(off.note.mayEnd, false);
  assert.deepEqual(loadConfig().operator.mayEnd, { alpha: true }, 'cleared: the key is gone, the other project keeps its own');
  assert.equal((await r.call('GET', '/api/operator/note?project=shop')).mayEnd, false);
  // Only true or false; nothing else of the note's body; never a project that is not here.
  for (const bad of ['yes', 1, null, {}]) await assert.rejects(set({ project: 'shop', text: 'x', mayEnd: bad }), (e) => e.status === 400, JSON.stringify(bad));
  await assert.rejects(set({ project: 'shop', text: 'x', mayStop: true }), (e) => e.status === 400);
  await assert.rejects(set({ project: 'nowhere', text: 'x', mayEnd: true }), (e) => e.status === 400);
  assert.deepEqual(loadConfig().operator.mayEnd, { alpha: true }, 'a refused body changed nothing');
});

test('a note emptied with no tick field clears the tick; the page, which always sends the field, still sets it alone', async () => {
  const r = rig();
  const set = (note) => r.call('POST', '/api/operator/settings', { note });
  await set({ project: 'shop', text: STOP_NOTE, mayEnd: true });
  const gone = await set({ project: 'shop', text: '' });
  assert.deepEqual(gone.note, { project: 'shop', text: '', mayEnd: false, cleaned: false }, 'no note and no field: the tick goes with it');
  assert.deepEqual(loadConfig().operator.mayEnd, {});
  assert.equal((await r.call('GET', '/api/operator/note?project=shop')).mayEnd, false);
  const alone = await set({ project: 'shop', text: '', mayEnd: true });
  assert.equal(alone.note.mayEnd, true, 'his tick sent with an empty note stands');
  assert.deepEqual(loadConfig().operator.mayEnd, { shop: true });
});

test('the tick is refused to Tia\'s own in-process call and to another dashboard, exactly as the note', async () => {
  const r = rig({ mayEnd: {} });
  for (const who of ['self', 'computer', 'assistant']) {
    const note = await r.call('POST', '/api/operator/settings', { note: { project: 'shop', text: 'x' } }, who).catch((e) => e.status);
    const tick = await r.call('POST', '/api/operator/settings', { note: { project: 'shop', text: 'x', mayEnd: true } }, who).catch((e) => e.status);
    assert.equal(note, 403, who);
    assert.equal(tick, note, `${who}: refused as the note is`);
  }
  assert.deepEqual(loadConfig().operator.mayEnd, {});
});

test('over HTTP: her token, a session\'s own call with no sign-in and another site are refused as the note is', async () => {
  fs.rmSync(opDir, { recursive: true, force: true });
  saveConfig({ projectsDir: projects, operator: { acts: false, notes: {}, mayEnd: {} }, server: { passwordHash: await hashPassword('right-password') } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} }, watch: false, dashboardFile: false, operator: { sources: { sessions: () => [] }, now: () => NOW, cacheMs: 0 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = async (body, headers) => (await fetch(`${origin}/api/operator/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })).status;
    const note = { note: { project: 'shop', text: 'x' } };
    const tick = { note: { project: 'shop', text: 'x', mayEnd: true } };
    const ways = [
      ['her token alone', { Authorization: 'Bearer tia_0123456789abcdef' }],
      ['her token with the cookie', { Authorization: 'Bearer tia_0123456789abcdef', Cookie: cookie, Origin: origin }],
      ['a session\'s own call, no sign-in', {}],
      ['no sign-in, from this dashboard\'s address', { Origin: origin }],
      ['another site', { Cookie: cookie, Origin: 'http://evil.example' }],
    ];
    for (const [why, headers] of ways) {
      const a = await post(note, headers);
      const b = await post(tick, headers);
      assert.ok([401, 403].includes(a), `${why}: the note is refused (${a})`);
      assert.equal(b, a, `${why}: the tick is refused as the note is`);
    }
    assert.deepEqual(loadConfig().operator.mayEnd, {}, 'none of those stored the tick');
    assert.equal(await post(tick, { Cookie: cookie, Origin: origin }), 200, 'his own page stores it');
    assert.deepEqual(loadConfig().operator.mayEnd, { shop: true });
  } finally {
    await app.close();
  }
});
