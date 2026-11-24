// Money in the Operator: a move onto a provider billed by use, a decision's own call and a look's session there, done
// without the owner's tap, only at "Hands off" AND inside Tia's daily spending cap, counted by her own ledger (the file
// in this state folder). Made-up providers, a stand-in model and stand-in moves: nothing here spends or moves anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

const box = sandbox('operator-money');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');
const { SETTLE_MS, pickProvider } = await import('../../src/operator/decider.mjs');
const { HOLD_USD, SpendLedger, spendFile } = await import('../../src/assistant/spend.mjs');
const { CAP_SWITCH, capLine } = await import('../../src/operator/money.mjs');
const { missionItem } = await import('../../src/mission/seam.mjs');
const { looks } = await import('../../src/operator/look.mjs');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const projects = path.join(box.workspace, 'projects');
fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true });
const opDir = path.join(box.state, 'operator');
const lines = () => {
  try {
    return fs.readFileSync(path.join(opDir, 'timeline.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
/** What the ledger file holds now: one entry per line. */
const entries = () => {
  try {
    return fs.readFileSync(spendFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const limited = (over = {}) => session({ name: 'alpha', state: 'waiting', folder: path.join(projects, 'alpha'), nextProvider: 'paid-x', limit: { at: ago(3), text: 'Usage limit reached', source: 'hook' }, ...over });

/** A fresh state folder, Tia at `level` with `cap`, the limit rule or "Tia decides" on, a made-up world. */
function rig({ level = 'handsoff', cap = null, way = 'rule', missions = false, sessions = [limited()], answer = 'switch-provider\nThe next provider can go on now.', usd = 0.02, accounts: acc = null, during = null } = {}) {
  fs.rmSync(opDir, { recursive: true, force: true });
  fs.rmSync(spendFile(), { force: true });
  saveConfig({ projectsDir: projects, assistant: { enabled: true, level, accounts: ['plan-a', 'paid-x'], dailyCapUsd: cap }, operator: { acts: true, rules: way === 'rule' ? { limit: true } : {}, decide: { on: way === 'decide' || missions, missions }, notes: {} } });
  const world = { sessions };
  const moves = [];
  const calls = [];
  const clock = { t: NOW };
  const ticker = { fn: null };
  const accounts = acc || { profiles: [{ name: 'plan-a', kind: 'subscription' }, { name: 'paid-x', kind: 'api' }], autoSwitch: { enabled: false } };
  const ctx = { HttpError, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: (fn) => { ticker.fn = fn; return () => {}; } };
  const f = operatorFeature(ctx, {
    sources: { sessions: () => world.sessions, gateways: () => [], live: () => null, leftovers: () => [], machine: () => null },
    now: () => clock.t,
    cacheMs: 0,
    accounts: async () => accounts,
    turn: async (a) => {
      calls.push(a);
      if (during) during(); // what else happens while the call runs (her own paid turn)
      return { ok: true, text: answer, tokens: 900, usd };
    },
    session: {
      nudge: async (name) => moves.push(['nudge', name]),
      stop: async (name) => moves.push(['stop', name]),
      move: async (name, to) => {
        moves.push([name, to]);
        world.sessions = world.sessions.map((s) => (s.name === name ? { ...s, provider: to, limit: null, nextProvider: s.provider } : s));
      },
    },
    acts: {},
  });
  const route = (method, p) => f.routes.find(([m, re]) => m === method && re.test(p))[2];
  const call = (method, p, body) => route(method, p)({ url: p, body, socket: {} });
  // "Tia decides": the item's rev must hold a few seconds before it is decided.
  const decide = async () => {
    await ticker.fn();
    await f.deciding?.();
    clock.t += SETTLE_MS;
    await ticker.fn();
    await f.deciding?.();
  };
  return { f, world, moves, calls, clock, call, decide, round: () => f.reflex.round(), close: () => f.close() };
}

test('the limit rule below "Hands off": no move onto a paid provider, nothing in the ledger, with or without a cap', async () => {
  for (const cap of [null, 5]) {
    const r = rig({ level: 'work', cap });
    await r.round();
    r.close();
    assert.deepEqual(r.moves, [], `cap ${cap}`);
    assert.match(lines().find((l) => l.refused)?.result || '', /only at "Hands off"/);
    assert.deepEqual(entries(), []);
  }
});

test('the limit rule at "Hands off" with no daily cap: the move is his, in one line, and his card offers the cap', async () => {
  const r = rig({ cap: null });
  await r.round();
  assert.deepEqual(r.moves, []);
  assert.deepEqual(entries(), [], 'nothing written to the ledger');
  const want = 'Moving this session to paid-x costs money by use, and Tia has no daily limit for paid use.';
  assert.equal(want, capLine('Moving this session to paid-x', null));
  assert.deepEqual(lines().filter((l) => l.refused).map((l) => l.result), [want], 'one line');
  const v = r.f.reflex.view();
  const [his] = Object.values(v.his);
  assert.deepEqual(his.cap, true, 'the card offers "Set a daily limit for paid use"');
  assert.equal(his.words, want);
  assert.equal(CAP_SWITCH, '#/settings/tia?show=tia-daily-cap');
  // A second round does not write the same line again.
  await r.round();
  r.close();
  assert.equal(lines().filter((l) => l.refused).length, 1);
});

test('the limit rule at "Hands off" inside the cap: the move is done and the ledger holds its hold', async () => {
  const r = rig({ cap: 5 });
  await r.round();
  r.close();
  assert.deepEqual(r.moves, [['alpha', 'paid-x']]);
  const holds = entries().filter((e) => e.kind === 'hold');
  assert.equal(holds.length, 1);
  assert.match(holds[0].id, /^move-[0-9a-f]{8}$/);
  assert.notEqual(holds[0].owner, true, 'hers, checked against the cap');
  assert.deepEqual(new SpendLedger().today(), { spent: 0, held: HOLD_USD });
});

test('the limit rule at "Hands off" with the cap used up: no move, nothing more written, the line names the cap', async () => {
  const r = rig({ cap: 1 });
  new SpendLedger().spent(0.8, 'turn');
  const before = entries().length;
  await r.round();
  r.close();
  assert.deepEqual(r.moves, []);
  assert.equal(entries().length, before, 'nothing written');
  assert.deepEqual(lines().filter((l) => l.refused).map((l) => l.result), ['Moving this session to paid-x costs money by use, and today\'s daily limit for paid use of $1.00 is used up.']);
  assert.equal(Object.values(r.f.reflex.view().his)[0].cap, true);
});

test('a subscription as the next provider needs no cap and writes nothing to the ledger', async () => {
  const r = rig({ cap: null, sessions: [limited({ nextProvider: 'plan-a', provider: 'paid-x' })] });
  await r.round();
  r.close();
  assert.deepEqual(r.moves, [['alpha', 'plan-a']]);
  assert.deepEqual(entries(), []);
});

test('his own tap on "Continue on the next provider" moves the session and writes nothing to the ledger', async () => {
  const r = rig({ cap: null, way: 'none' });
  const it = (await r.f.list()).items.find((i) => i.kind === 'limit');
  await r.call('POST', '/api/operator/act', { item: it.id, act: 'switch', seen: it.rev });
  r.close();
  assert.deepEqual(r.moves, [['alpha', 'paid-x']]);
  assert.deepEqual(entries(), []);
});

test('two moves at once on the last free amount: one passes, the other is his', async () => {
  // $1 a day, $0.40 spent: room for one hold of $0.50, not two.
  const r = rig({ cap: 1, sessions: [limited(), limited({ name: 'beta' })] });
  new SpendLedger().spent(0.4, 'turn');
  await r.round();
  r.close();
  assert.equal(r.moves.length, 1, JSON.stringify(r.moves));
  assert.equal(entries().filter((e) => e.kind === 'hold').length, 1);
  assert.deepEqual(lines().filter((l) => l.refused).map((l) => l.result), ['Moving this session to paid-x costs money by use, and today\'s daily limit for paid use of $1.00 is used up.']);
});

test('"Tia decides" at "Hands off": a paid move inside the cap is held; with no cap no call is made and the item is his', async () => {
  const r = rig({ cap: 5, way: 'decide', usd: 0 });
  await r.decide();
  r.close();
  assert.deepEqual(r.moves, [['alpha', 'paid-x']]);
  assert.equal(r.calls.length, 1);
  assert.equal(entries().filter((e) => e.kind === 'hold').length, 1, 'the move held, the call on a subscription not');
  const n = rig({ cap: null, way: 'decide' });
  await n.decide();
  n.close();
  assert.deepEqual(n.moves, []);
  assert.equal(n.calls.length, 0, 'no decision call on an item whose only step the cap does not allow');
  assert.deepEqual(entries(), []);
  const l = lines().find((x) => x.by === 'decide' && x.refused);
  assert.equal(l?.result, 'Moving this session to paid-x costs money by use, and Tia has no daily limit for paid use.');
  assert.equal(Object.values(n.f.reflex.view().his)[0].cap, true);
});

test('a decision\'s own call on a provider billed by use: only at "Hands off" and inside the cap, held before and settled after', async () => {
  const only = { profiles: [{ name: 'paid-x', kind: 'api' }], autoSwitch: { enabled: false } };
  const cfg = (level, cap) => ({ assistant: { enabled: true, level, accounts: ['paid-x'], dailyCapUsd: cap } });
  fs.rmSync(spendFile(), { force: true });
  assert.match(pickProvider(cfg('work', 5), only).error, /only at "Hands off"/);
  assert.equal(pickProvider(cfg('handsoff', null), only).error, 'every provider Tia may use is billed by use, and Tia has no daily limit for paid use (Settings → Tia)');
  assert.equal(pickProvider(cfg('handsoff', 5), only).provider, 'paid-x');
  new SpendLedger().spent(4.8, 'turn');
  assert.match(pickProvider(cfg('handsoff', 5), only).error, /today's daily limit for paid use of \$5\.00 is used up/);
  assert.deepEqual(entries().filter((e) => e.kind === 'hold'), [], 'choosing writes nothing');
  // A call through the decider: held before the call, settled with what it reported.
  const stuck = session({ name: 'alpha', state: 'working', folder: path.join(projects, 'alpha'), progressAt: ago(50), statusAt: ago(50) });
  const r = rig({ cap: 5, way: 'decide', sessions: [stuck], answer: 'ask_owner\nNot sure.', usd: 0.03, accounts: only });
  saveConfig({ assistant: { ...loadConfig().assistant, accounts: ['paid-x'] } });
  await r.decide();
  r.close();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].provider, 'paid-x');
  const e = entries();
  const h = e.find((x) => x.kind === 'hold');
  assert.match(h?.id || '', /^decide-/);
  assert.deepEqual(e.filter((x) => x.kind === 'spent').map((x) => [x.usd, x.hold]), [[0.03, h.id]]);
  assert.deepEqual(new SpendLedger().today(), { spent: 0.03, held: 0 });
  // No cap: no call at all, and the line says why.
  const n = rig({ cap: null, way: 'decide', sessions: [stuck], accounts: only });
  saveConfig({ assistant: { ...loadConfig().assistant, accounts: ['paid-x'] } });
  await n.decide();
  n.close();
  assert.equal(n.calls.length, 0);
  assert.deepEqual(entries(), []);
  assert.ok(lines().some((l) => l.by === 'decide' && /no daily limit for paid use/.test(l.result)));
});

// A mission's task at a limit, its next provider of his order billed by use.
const taskAtLimit = () => missionItem({ kind: 'mission-limit', mission: 'm-20260310-abcdef', task: 'shop-7', title: 'Add the search page', project: 'alpha', provider: 'plan-a', to: 'paid-x', waitMs: 3 * 3600_000, at: ago(2) });

test('a mission\'s next provider billed by use: the limit rule moves the task there only at "Hands off" and inside the cap', async () => {
  const w = rig({ level: 'work', cap: 5, missions: true });
  const a = await w.f.decide.mission(taskAtLimit());
  w.close();
  assert.equal(a.ask, true);
  assert.match(a.why, /paid-x is paid per use, and Tia moves a task there only at "Hands off"/);
  assert.deepEqual(entries(), []);
  const n = rig({ cap: null, missions: true });
  const b = await n.f.decide.mission(taskAtLimit());
  n.close();
  assert.deepEqual(b, { ask: true, why: 'Moving this task to paid-x costs money by use, and Tia has no daily limit for paid use: it is yours' });
  assert.deepEqual(entries(), []);
  const y = rig({ cap: 5, missions: true });
  const c = await y.f.decide.mission(taskAtLimit());
  y.close();
  assert.equal(c.act, 'next-provider');
  const holds = entries().filter((e) => e.kind === 'hold');
  assert.equal(holds.length, 1);
  assert.match(holds[0].id, /^mission-/);
  // Used up: his, nothing more written.
  const u = rig({ cap: 1, missions: true });
  new SpendLedger().spent(0.8, 'turn');
  const d = await u.f.decide.mission(taskAtLimit());
  u.close();
  assert.deepEqual(d, { ask: true, why: 'Moving this task to paid-x costs money by use, and today\'s daily limit for paid use of $1.00 is used up: it is yours' });
  assert.equal(entries().filter((e) => e.kind === 'hold').length, 0);
});

test('a mission\'s choice by "Tia decides": a next provider the cap does not allow is not offered, and the model is not asked for it', async () => {
  const r = rig({ cap: null, way: 'decide', missions: true, answer: 'next-provider\nGo on.' });
  const a = await r.f.decide.mission(taskAtLimit());
  r.close();
  assert.equal(a.ask, true);
  assert.equal(r.calls.length, 0, 'its only step was the paid move: no call');
  assert.deepEqual(entries(), []);
});

test('a look on a provider billed by use: only inside the cap, held before it starts, its budget at most what is left, settled by its cost', async () => {
  const only = async () => ({ profiles: [{ name: 'paid-x', kind: 'api' }], autoSwitch: { enabled: false } });
  const item = { id: 'unknown-0000000000ab', kind: 'unknown', subject: 'Work run q', facts: [], target: { case: 'reason', project: 'shop' } };
  const run = async (level, cap) => {
    fs.rmSync(opDir, { recursive: true, force: true });
    fs.rmSync(spendFile(), { force: true });
    const cfg = { assistant: { enabled: true, level, accounts: ['paid-x'], dailyCapUsd: cap }, operator: { acts: true, look: { on: true } } };
    const started = [];
    const runner = {
      start: async (j) => {
        started.push(j);
        return { run: { id: 'run-1' }, done: Promise.resolve({ id: 'run-1', state: 'done', answer: '{"cause":"not found","where":[],"mend":"","sure":"a guess"}', usage: { cost: 0.4, tokens: 1000 } }) };
      },
      drop: async () => ({ removed: true }),
    };
    const lk = looks({ ctx: { config: () => cfg }, runner: () => runner, accounts: only, model: 'claude-opus-made-up' });
    const r = await lk.startOne(item);
    if (r.done) await r.done;
    return { r, started };
  };
  const w = await run('work', 5);
  assert.deepEqual(w.started, []);
  assert.match(w.r.why, /only at "Hands off"/);
  const n = await run('handsoff', null);
  assert.deepEqual(n.started, []);
  assert.equal(n.r.why, 'every provider Tia may use is billed by use, and Tia has no daily limit for paid use (Settings → Tia)');
  assert.deepEqual(entries(), []);
  const y = await run('handsoff', 1);
  assert.equal(y.started.length, 1);
  assert.equal(y.started[0].budget, 1, 'what is left of the $1 cap, below the look\'s own $3');
  const e = entries();
  const h = e.find((x) => x.kind === 'hold');
  assert.match(h?.id || '', /^look-/);
  assert.deepEqual(e.filter((x) => x.kind === 'spent').map((x) => [x.usd, x.hold]), [[0.4, h.id]]);
  assert.deepEqual(new SpendLedger().today(), { spent: 0.4, held: 0 });
});

test('a mission\'s paid next provider while her record of acts stays locked: held all the same before the engine goes on', async () => {
  const r = rig({ cap: 5, missions: true });
  fs.mkdirSync(opDir, { recursive: true });
  fs.writeFileSync(path.join(opDir, 'reflex.lock'), 'another dashboard\n');
  let d;
  try {
    d = await r.f.decide.mission(taskAtLimit());
  } finally {
    fs.rmSync(path.join(opDir, 'reflex.lock'), { force: true });
    r.close();
  }
  assert.equal(d, null, 'the engine goes on as without the door');
  assert.equal(entries().filter((e) => e.kind === 'hold' && /^mission-/.test(e.id)).length, 1, 'and the move is held');
});

// The same task at a limit with a wait step too, so dropping the paid step still leaves a step to decide.
const taskWithWait = () => missionItem({ kind: 'mission-limit', mission: 'm-20260310-abcdef', task: 'shop-7', title: 'Add the search page', project: 'alpha', provider: 'plan-a', to: 'paid-x', waitMs: 30 * 60_000, at: ago(2) });
const holdsNow = () => entries().filter((e) => e.kind === 'hold').length;

test('a mission\'s choice asked again for the same picture: a stored next-provider passes the level and the cap again, as a fresh pick', async () => {
  const { mayDo } = await import('../../src/mission/seam.mjs');
  const NO_CAP = 'Moving this task to paid-x costs money by use, and Tia has no daily limit for paid use: it is yours';
  const cases = [
    ['the cap cleared', { dailyCapUsd: null }, (a) => assert.deepEqual(a, { ask: true, why: NO_CAP }), 0],
    ['the level lowered to "Ask me"', { level: 'ask' }, (a) => assert.match(a.why, /only at "Hands off"/), 0],
    ['the level lowered to "Do the work"', { level: 'work' }, (a) => assert.match(a.why, /only at "Hands off"/), 0],
    ['the cap used up', { spent: 4.6 }, (a) => assert.deepEqual(a, { ask: true, why: 'Moving this task to paid-x costs money by use, and today\'s daily limit for paid use of $5.00 is used up: it is yours' }), 0],
    ['the same settings, room left', {}, (a) => assert.equal(a.act, 'next-provider'), 1],
  ];
  for (const [what, { spent, ...change }, check, held] of cases) {
    const r = rig({ cap: 5, way: 'decide', missions: true, answer: 'next-provider\nGo on.' });
    const a = await r.f.decide.mission(taskWithWait());
    assert.equal(a.act, 'next-provider', what);
    assert.equal(holdsNow(), 1, `${what}: the first move held`);
    if (spent) new SpendLedger().spent(spent, 'her own turn');
    saveConfig({ assistant: { ...loadConfig().assistant, ...change } });
    // As the engine asks (seam.mjs mayDo): its own item still lists next-provider.
    const b = await mayDo({ kind: 'mission-limit', mission: 'm-20260310-abcdef', task: 'shop-7', title: 'Add the search page', project: 'alpha', provider: 'plan-a', to: 'paid-x', waitMs: 30 * 60_000, at: ago(2) }, r.f.decide.mission);
    r.close();
    check(b);
    assert.equal(b.ask === true, !held, `${what}: ${JSON.stringify(b)}`);
    assert.equal(holdsNow() - 1, held, `${what}: holds`);
    assert.equal(r.calls.length, 1, `${what}: no second call`);
  }
});

test('a mission\'s next-provider the cap refused after the call: once the cap has room, the same picture asked again is held and done', async () => {
  // $1 a day; while the call runs, her own turn spends $0.80, so the pick is refused when it is held.
  const r = rig({ cap: 1, way: 'decide', missions: true, answer: 'next-provider\nGo on.', during: () => new SpendLedger().spent(0.8, 'her own turn') });
  const a = await r.f.decide.mission(taskWithWait());
  assert.deepEqual(a, { ask: true, why: 'Moving this task to paid-x costs money by use, and today\'s daily limit for paid use of $1.00 is used up: it is yours' });
  assert.equal(holdsNow(), 0);
  const b = await r.f.decide.mission(taskWithWait());
  assert.equal(b.ask, true, 'the same settings: still his, nothing held');
  assert.equal(holdsNow(), 0);
  saveConfig({ assistant: { ...loadConfig().assistant, dailyCapUsd: null } });
  assert.equal((await r.f.decide.mission(taskWithWait())).ask, true, 'no cap: his');
  saveConfig({ assistant: { ...loadConfig().assistant, level: 'ask', dailyCapUsd: 5 } });
  assert.equal((await r.f.decide.mission(taskWithWait())).ask, true, '"Ask me": his');
  assert.equal(holdsNow(), 0);
  saveConfig({ assistant: { ...loadConfig().assistant, level: 'handsoff', dailyCapUsd: 5 } });
  const c = await r.f.decide.mission(taskWithWait());
  r.close();
  assert.equal(c.act, 'next-provider', 'the cap raised at "Hands off": done');
  assert.equal(holdsNow(), 1, 'and counted');
  assert.equal(r.calls.length, 1, 'with no second call');
});

test('"Tia decides" below "Hands off": an item whose only step is a paid move gets no decision call; it is his in one line', async () => {
  for (const level of ['ask', 'work']) {
    const r = rig({ level, cap: 5, way: 'decide' });
    await r.decide();
    r.close();
    assert.deepEqual(r.moves, [], level);
    assert.equal(r.calls.length, 0, `${level}: no call is spent on a move she may not do`);
    assert.deepEqual(entries(), []);
    assert.deepEqual(lines().filter((l) => l.by === 'decide' && l.refused).map((l) => l.result), ['paid-x is paid per use, and Tia moves a session there only at "Hands off" (Settings → Tia): it is yours'], level);
    assert.notEqual(Object.values(r.f.reflex.view().his)[0].cap, true, 'the level is not the cap: no cap button');
  }
});

test('"Tia decides" at "Hands off", no cap: once he sets the cap the card asks for, the same item is decided again and moved', async () => {
  const r = rig({ cap: null, way: 'decide' });
  await r.decide();
  assert.equal(r.calls.length, 0);
  assert.equal(Object.values(r.f.reflex.view().his)[0].cap, true);
  // The same picture again with nothing changed: still his, no call, no new line.
  r.clock.t += 60_000;
  await r.decide();
  assert.equal(r.calls.length, 0);
  assert.equal(lines().filter((l) => l.by === 'decide' && l.refused).length, 1);
  saveConfig({ assistant: { ...loadConfig().assistant, dailyCapUsd: 5 } });
  r.clock.t += 60_000;
  await r.decide();
  r.close();
  assert.equal(r.calls.length, 1, 'decided again once the cap has room');
  assert.deepEqual(r.moves, [['alpha', 'paid-x']]);
  assert.equal(entries().filter((e) => e.kind === 'hold').length, 1, 'and the move is counted');
});

test('"Tia decides" with a wait step left beside a paid move the cap does not allow: the card names the cap, and the cap brings it back', async () => {
  const soon = new Date(NOW + 30 * 60_000).toISOString();
  const r = rig({ cap: null, way: 'decide', answer: 'ask_owner\nNot sure.', sessions: [limited({ limit: { at: ago(3), text: 'Usage limit reached', source: 'hook', resetsAt: soon } })] });
  await r.decide();
  assert.equal(r.calls.length, 1, 'the wait is still offered');
  assert.doesNotMatch(r.calls[0].prompt.split('Steps offered:')[1].split('\n')[0], /switch-provider/);
  const his = Object.values(r.f.reflex.view().his)[0];
  assert.equal(his.words, 'Moving this session to paid-x costs money by use, and Tia has no daily limit for paid use.', 'the move he could allow is named');
  assert.equal(his.cap, true, 'with the button that opens the cap');
  r.clock.t += 60_000;
  await r.decide();
  assert.equal(r.calls.length, 1, 'the same picture and the same cap: no second call');
  saveConfig({ assistant: { ...loadConfig().assistant, dailyCapUsd: 5 } });
  r.clock.t += 60_000;
  await r.decide();
  r.close();
  assert.equal(r.calls.length, 2, 'the cap set: decided again, now with the move offered');
  assert.match(r.calls[1].prompt.split('Steps offered:')[1].split('\n')[0], /switch-provider/);
  assert.notEqual(Object.values(r.f.reflex.view().his)[0]?.cap, true, 'the old cap line is gone');
});

test('a decision with only providers billed by use and no cap: one sentence, never cut, that names the cap, and the card offers it', async () => {
  const acc = { profiles: [{ name: 'plan-a', kind: 'subscription' }, { name: 'paid-x', kind: 'api' }, { name: 'paid-y', kind: 'api' }], autoSwitch: { enabled: true, order: ['plan-a', 'paid-x'] } };
  const stuck = session({ name: 'alpha', state: 'working', folder: path.join(projects, 'alpha'), progressAt: ago(50), statusAt: ago(50) });
  const r = rig({ cap: null, way: 'decide', sessions: [stuck], accounts: acc });
  saveConfig({ assistant: { ...loadConfig().assistant, accounts: ['auto', 'paid-y'] } });
  await r.decide();
  r.close();
  assert.equal(r.calls.length, 0);
  const want = 'Auto mode\'s order holds a provider billed by use (paid-x); every other provider she may use is too, and Tia has no daily limit for paid use: it is yours';
  assert.deepEqual(lines().filter((l) => l.by === 'decide' && l.refused).map((l) => l.result), [want], 'the timeline line whole');
  const his = Object.values(r.f.reflex.view().his)[0];
  assert.equal(his.words, want, 'the card\'s line whole');
  assert.equal(his.cap, true, 'the cap is why: "Set a daily limit for paid use"');
  assert.doesNotMatch(want, /no provider to decide with|\(.*\(/, 'nothing untrue, nothing nested');
});

test('the same line with paid names of ordinary length in Auto mode\'s order: whole on the timeline as on the card', async () => {
  const acc = { profiles: [{ name: 'plan-a', kind: 'subscription' }, { name: 'router-key-one', kind: 'api' }, { name: 'shop-api-key', kind: 'api' }, { name: 'paid-y', kind: 'api' }], autoSwitch: { enabled: true, order: ['plan-a', 'router-key-one', 'shop-api-key'] } };
  const stuck = session({ name: 'alpha', state: 'working', folder: path.join(projects, 'alpha'), progressAt: ago(50), statusAt: ago(50) });
  const head = 'Auto mode\'s order holds a provider billed by use (router-key-one, shop-api-key); every other provider she may use is too, and ';
  for (const [cap, tail] of [[null, 'Tia has no daily limit for paid use: it is yours'], [1000, 'today\'s daily limit for paid use of $1000.00 is used up: it is yours']]) {
    const r = rig({ cap, way: 'decide', sessions: [stuck], accounts: acc });
    saveConfig({ assistant: { ...loadConfig().assistant, accounts: ['auto', 'paid-y'] } });
    if (cap) new SpendLedger().spent(999.8, 'her own turns today');
    await r.decide();
    r.close();
    assert.equal(r.calls.length, 0);
    const want = `${head}${tail}`;
    assert.ok(want.length > 160, `longer than the timeline's usual cut: ${want.length}`);
    assert.deepEqual(lines().filter((l) => l.by === 'decide' && l.refused).map((l) => l.result), [want], `cap ${cap}: the timeline line whole`);
    assert.equal(Object.values(r.f.reflex.view().his)[0].words, want, `cap ${cap}: the card whole`);
  }
  // Names of the longest form a provider's name may have (32 characters): one is named, and the sentence still ends whole.
  const a = `router-${'a'.repeat(25)}`;
  const b = `shop-${'b'.repeat(27)}`;
  const long = { ...acc, profiles: [...acc.profiles, { name: a, kind: 'api' }, { name: b, kind: 'api' }], autoSwitch: { enabled: true, order: ['plan-a', a, b] } };
  for (const cap of [null, 99999]) {
    const r = rig({ cap, way: 'decide', sessions: [stuck], accounts: long });
    saveConfig({ assistant: { ...loadConfig().assistant, accounts: ['auto', 'paid-y'] } });
    if (cap) new SpendLedger().spent(99999, 'her own turns today');
    await r.decide();
    r.close();
    const [l] = lines().filter((x) => x.by === 'decide' && x.refused).map((x) => x.result);
    assert.ok(l.startsWith(`Auto mode's order holds a provider billed by use (${a} and 1 more); every other provider she may use is too, and `), l);
    assert.ok(l.endsWith(': it is yours'), `cap ${cap}: never cut: ${l} (${l.length})`);
    assert.equal(Object.values(r.f.reflex.view().his)[0].words, l);
  }
});

test('a decision call whose hold is refused after the provider was chosen: one sentence, no full stop inside, with the cap button', async () => {
  const { noProvider } = await import('../../src/operator/decider.mjs');
  const held = { no: capLine('A decision of Tia\'s on paid-x', 5) };
  assert.deepEqual(noProvider(held), { code: 'cap', words: 'A decision of Tia\'s on paid-x costs money by use, and today\'s daily limit for paid use of $5.00 is used up: it is yours' });
  // At "Do the work" the level is why, not the cap: no cap button.
  assert.deepEqual(noProvider({ error: 'every provider Tia may use is billed by use, and she spends that only at "Hands off"' }), { code: 'model', words: 'Every provider Tia may use is billed by use, and she spends that only at "Hands off": it is yours' });
  // Any other reason keeps its words in the wrapper.
  assert.equal(noProvider({ error: 'no provider serves Claude Code' }).words, 'Tia has no provider to decide with (no provider serves Claude Code): it is yours');
});

test('"Tia decides" types into a session on a provider billed by use only at "Hands off" and inside the cap, and the cap counts it', async () => {
  const stuck = (provider) => session({ name: 'alpha', state: 'working', provider, folder: path.join(projects, 'alpha'), progressAt: ago(50), statusAt: ago(50) });
  const typed = (r) => r.moves.filter((m) => m[0] === 'nudge');
  for (const level of ['ask', 'work']) {
    const r = rig({ level, cap: 5, way: 'decide', sessions: [stuck('paid-x')], answer: 'nudge-once\nThe usual first step.' });
    await r.decide();
    r.close();
    assert.deepEqual(typed(r), [], level);
    assert.equal(r.calls.length, 0, `${level}: its only step is paid typing: no call`);
    assert.deepEqual(entries(), []);
    assert.deepEqual(lines().filter((l) => l.by === 'decide' && l.refused).map((l) => l.result), ['Typing into this session on paid-x costs money by use, and Tia types into such a session only at "Hands off" (Settings → Tia): it is yours'], level);
  }
  const n = rig({ cap: null, way: 'decide', sessions: [stuck('paid-x')], answer: 'nudge-once\nThe usual first step.' });
  await n.decide();
  n.close();
  assert.deepEqual(typed(n), []);
  assert.equal(n.calls.length, 0);
  assert.deepEqual(entries(), []);
  const his = Object.values(n.f.reflex.view().his)[0];
  assert.equal(his.words, 'Typing into this session on paid-x costs money by use, and Tia has no daily limit for paid use.');
  assert.equal(his.cap, true);
  const y = rig({ cap: 5, way: 'decide', sessions: [stuck('paid-x')], answer: 'nudge-once\nThe usual first step.' });
  await y.decide();
  y.close();
  assert.deepEqual(typed(y), [['nudge', 'alpha']], 'inside the cap: nudged');
  const holds = entries().filter((e) => e.kind === 'hold');
  assert.equal(holds.length, 1);
  assert.match(holds[0].id, /^type-[0-9a-f]{8}$/);
  // A session on a subscription: nudged at every level, nothing written to the ledger.
  const s = rig({ level: 'ask', cap: null, way: 'decide', sessions: [stuck('plan-a')], answer: 'nudge-once\nThe usual first step.' });
  await s.decide();
  s.close();
  assert.deepEqual(typed(s), [['nudge', 'alpha']]);
  assert.deepEqual(entries(), []);
});

test('a stuck session on a provider billed by use, the tick on, typing not allowed: its stop goes with the nudge still owed', async () => {
  const stuck = session({ name: 'alpha', state: 'working', provider: 'paid-x', folder: path.join(projects, 'alpha'), progressAt: ago(50), statusAt: ago(50) });
  const note = 'If a session still hangs after a nudge, stop it.';
  const tick = () => saveConfig({ operator: { ...loadConfig().operator, notes: { alpha: note }, mayEnd: { alpha: true } } });
  const want = {
    work: 'Typing into this session on paid-x costs money by use, and Tia types into such a session only at "Hands off" (Settings → Tia): it is yours',
    handsoff: 'Typing into this session on paid-x costs money by use, and Tia has no daily limit for paid use.',
  };
  for (const [level, cap] of [['work', 5], ['handsoff', null]]) {
    const r = rig({ level, cap, way: 'decide', sessions: [stuck], answer: 'stop-session\nThe note says to stop it.' });
    tick();
    await r.decide();
    r.close();
    assert.deepEqual(r.moves, [], `${level}: nothing typed, nothing ended`);
    assert.equal(r.calls.length, 0, `${level}: no step is hers, so no call`);
    assert.deepEqual(entries(), []);
    assert.deepEqual(lines().filter((l) => l.by === 'decide' && l.refused).map((l) => l.result), [want[level]], `${level}: one line`);
  }
  // Inside the cap at "Hands off" both steps are hers again, the nudge first as the prompt says.
  const y = rig({ cap: 5, way: 'decide', sessions: [stuck], answer: 'nudge-once\nThe usual first step.' });
  tick();
  await y.decide();
  y.close();
  assert.match(y.calls[0].prompt, /Steps offered: nudge-once, stop-session, ask_owner/);
  assert.deepEqual(y.moves, [['nudge', 'alpha']]);
});

// A look on a provider billed by use whose cost is never read back: it counts the most it could spend, its budget.
const paidLook = async ({ answer, now } = {}) => {
  const cfg = { assistant: { enabled: true, level: 'handsoff', accounts: ['paid-x'], dailyCapUsd: 1 }, operator: { acts: true, look: { on: true } } };
  const started = [];
  const runner = {
    start: async (j) => {
      started.push(j);
      return { run: { id: 'run-1' }, done: answer ? Promise.resolve(answer) : new Promise(() => {}) };
    },
    drop: async () => ({ removed: true }),
  };
  const lk = looks({ ctx: { config: () => cfg }, runner: () => runner, accounts: async () => ({ profiles: [{ name: 'paid-x', kind: 'api' }], autoSwitch: { enabled: false } }), model: 'claude-opus-made-up', ...(now ? { now } : {}) });
  return { lk, started };
};
const lookItem = { id: 'unknown-0000000000ef', kind: 'unknown', subject: 'Work run r', facts: [], target: { case: 'reason', project: 'shop' } };

test('a paid look whose tool reports no cost counts its whole budget, not the $0.50 hold', async () => {
  fs.rmSync(opDir, { recursive: true, force: true });
  fs.rmSync(spendFile(), { force: true });
  const { lk, started } = await paidLook({ answer: { id: 'run-1', state: 'done', answer: '{"cause":"not found","where":[],"mend":"","sure":"a guess"}', usage: { tokens: 1000 } } });
  const r = await lk.startOne(lookItem);
  await r.done;
  assert.equal(started[0].budget, 1);
  const h = entries().find((e) => e.kind === 'hold');
  assert.deepEqual(entries().filter((e) => e.kind === 'spent').map((e) => [e.usd, e.hold]), [[1, h.id]]);
  assert.deepEqual(new SpendLedger().today(), { spent: 1, held: 0 });
});

test('a paid look lost to a stopped dashboard is settled by the next one at its budget', async () => {
  fs.rmSync(opDir, { recursive: true, force: true });
  fs.rmSync(spendFile(), { force: true });
  const first = await paidLook();
  const r = await first.lk.startOne(lookItem);
  assert.ok(r.started);
  assert.deepEqual(new SpendLedger().today(), { spent: 0, held: HOLD_USD }, 'only the hold while it runs');
  // The dashboard stopped: the next one, past the time a look may run, finds it lost.
  const next = await paidLook({ now: () => Date.now() + 25 * 60_000 });
  await next.lk.clear();
  const l = next.lk.store.read().looks.find((x) => x.item === lookItem.id);
  assert.equal(l.state, 'lost');
  const h = entries().find((e) => e.kind === 'hold');
  assert.deepEqual(entries().filter((e) => e.kind === 'spent').map((e) => [e.usd, e.hold]), [[1, h.id]], 'its budget, the most it could spend');
  assert.deepEqual(new SpendLedger().today(), { spent: 1, held: 0 });
});
