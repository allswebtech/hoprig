// "Improve Tia" as a server feature: only the owner's press on his own page starts, stops or sets a round (Tia's token,
// her door and another dashboard are refused); one round at a time; Stop; a round the dashboard stopped in is marked
// stopped at the next start; a provider billed by use needs the daily limit; the weekly round is off until switched on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const STANDIN = fileURLToPath(new URL('./improve-standin-eval.mjs', import.meta.url));
let tmp;
let log;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improvefeat-')));
  log = path.join(tmp, 'runs.jsonl');
  process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
  process.env.HOPRIG_PROFILES_DIR = path.join(tmp, 'profiles');
  fs.mkdirSync(process.env.HOPRIG_PROFILES_DIR, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { writeProfile } = await import('../../src/profiles.mjs');
const { improveFeature, RESTART_WHY, takeLock, writeStateForTest } = await import('../../src/assistant/improvefeature.mjs');
const { SpendLedger } = await import('../../src/assistant/spend.mjs');

const turn = async (a) => ({ ok: true, text: JSON.stringify({ after: `${a.prompt.split('<current_text>\n')[1].split('\n</current_text>')[0]} MARK:tie` }), usd: 0.001, tokens: 10 });

function feature({ cap = 20, env = {}, ...o } = {}) {
  writeProfile('paid-x', { label: 'Paid X', env: { ANTHROPIC_API_KEY: 'not-a-real-key-0000' } });
  writeProfile('sub', { label: 'Sub', env: { CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token-0000' } });
  const f = improveFeature({ readJson: async (req) => req.body, caller: (req) => req.caller || 'page', config: () => ({ assistant: { dailyCapUsd: cap } }) },
    { turn, runner: STANDIN, env: { ...process.env, STANDIN_LOG: log, ...env }, ...o });
  const call = (method, p, body, req = {}) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === method && r.test(p));
    return fn({ headers: {}, body, ...req }, p.match(re));
  };
  return { f, call };
}
const ended = async (f) => {
  for (let i = 0; i < 400 && f.current(); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.equal(f.current(), null, 'the round ended');
};
const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('Tia\'s token, her door and another dashboard are refused on every route, and nothing starts', async () => {
  const { f, call } = feature();
  const before = fs.existsSync(process.env.HOPRIG_STATE_DIR) ? fs.readdirSync(process.env.HOPRIG_STATE_DIR, { recursive: true }).sort() : [];
  for (const req of [{ headers: { authorization: 'Bearer tia_0123456789abcdef' } }, { caller: 'self' }, { caller: 'computer' }]) {
    await assert.rejects(() => call('GET', '/api/assistant/improve', undefined, req), (e) => e.status === 403);
    for (const [p, body] of [['/api/assistant/improve/start', { provider: 'sub', cap: 2 }], ['/api/assistant/improve/stop', {}], ['/api/assistant/improve/settings', { weekly: true, provider: 'sub' }]]) {
      await assert.rejects(() => call('POST', p, body, req), (e) => e.status === 403, `${p} ${JSON.stringify(req)}`);
    }
  }
  assert.equal(f.current(), null);
  assert.equal(runs().length, 0);
  const after = fs.existsSync(process.env.HOPRIG_STATE_DIR) ? fs.readdirSync(process.env.HOPRIG_STATE_DIR, { recursive: true }).sort() : [];
  assert.deepEqual(after, before, 'nothing was written');
});

test('the page reads the estimate, the providers, the line about money, and the weekly round off', async () => {
  const { call } = feature();
  const v = await call('GET', '/api/assistant/improve');
  assert.equal(v.settings.weekly, false);
  assert.deepEqual(v.providers.map((p) => [p.name, p.paid]), [['paid-x', true], ['sub', false]]);
  assert.equal(v.dailyCapUsd, 20);
  assert.ok(v.estimate.usd > 0 && v.estimate.caseRuns > v.estimate.cases, JSON.stringify(v.estimate));
  assert.match(v.estimate.basis, /shipped eval/);
  assert.equal(v.round, null);
});

test('a provider billed by use needs a daily limit for paid use; a cap is checked', async () => {
  const { call } = feature({ cap: null });
  await assert.rejects(() => call('POST', '/api/assistant/improve/start', { provider: 'paid-x', cap: 2 }), /no daily limit for paid use/);
  await assert.rejects(() => call('POST', '/api/assistant/improve/start', { provider: 'paid-x', cap: 1000 }), /0\.5 to 100/);
  await assert.rejects(() => call('POST', '/api/assistant/improve/start', { provider: 'nobody', cap: 2 }), /choose one of your providers/);
  assert.equal(runs().length, 0);
});

test('a sign-in on a key billed by use counts as billed by use: no round without a daily limit, a hold for every step', async () => {
  // What the sign-in check stores for a Console account's key (routerstate.mjs rememberLogin): its profile holds no key.
  fs.mkdirSync(process.env.HOPRIG_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'claude-login.json'), JSON.stringify({ at: Date.now(), loggedIn: true, paid: true }));
  writeProfile('console', { label: 'Console sign-in' });
  const none = feature({ cap: null });
  const v = await none.call('GET', '/api/assistant/improve');
  assert.equal(v.providers.find((p) => p.name === 'console').paid, true, 'listed as billed by use');
  await assert.rejects(() => none.call('POST', '/api/assistant/improve/start', { provider: 'console', cap: 2 }), /no daily limit for paid use/);
  assert.equal(none.f.current(), null);
  assert.equal(runs().length, 0, 'nothing ran');
  const { f, call } = feature();
  const st = await call('POST', '/api/assistant/improve/start', { provider: 'console', cap: 5 }); // the whole eval holds more than 2 dollars now that it has 166 cases
  assert.equal(st.round.paid, true);
  await ended(f);
  const entries = fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'spend.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const holds = entries.filter((e) => e.kind === 'hold');
  assert.equal(holds.length, runs().length + 3, 'a hold before every eval run and every model call');
  assert.deepEqual(entries.filter((e) => e.kind === 'spent').map((e) => e.hold).sort(), holds.map((e) => e.id).sort(), 'every hold settled');
});

test('each provider has its own estimate: the price of the model it sends the eval to, and a gateway said as such', async () => {
  writeProfile('big', { label: 'Big', env: { ANTHROPIC_API_KEY: 'not-a-real-key-0000', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5-5' } });
  writeProfile('gw', { label: 'Gateway', env: { ANTHROPIC_AUTH_TOKEN: 'not-a-real-token-0000', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  writeProfile('odd', { label: 'Odd', env: { ANTHROPIC_API_KEY: 'not-a-real-key-0000', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'some-other-model' } });
  const { call } = feature();
  const v = await call('GET', '/api/assistant/improve');
  const by = Object.fromEntries(v.providers.map((p) => [p.name, p.estimate]));
  assert.ok(Math.abs(by.big.perCaseUsd - 20 * by['paid-x'].perCaseUsd) < 1e-9, 'Sonnet\'s list price is twenty times Haiku\'s');
  assert.ok(by.big.usd > by['paid-x'].usd);
  assert.match(by.big.basis, /times 20 for Claude Sonnet/);
  assert.match(by.gw.basis, /a gateway that sends those requests to another model costs more/);
  assert.match(by.odd.basis, /price Hoprig does not know, so the round can cost more/);
  assert.match(by['paid-x'].basis, /^the shipped eval's measured cost on Claude Haiku$/);
  // A round measured on one provider: its cost per case is that provider's only.
  fs.mkdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.json'), JSON.stringify({ running: false, provider: 'gw', measured: { cases: 11, failing: 2, injection: 2, perCaseUsd: 0.07, provider: 'gw' } }));
  const w = await call('GET', '/api/assistant/improve');
  const after = Object.fromEntries(w.providers.map((p) => [p.name, p.estimate]));
  assert.equal(after.gw.perCaseUsd, 0.07);
  assert.match(after.gw.basis, /last round's measured cost on this provider/);
  assert.equal(after.big.perCaseUsd, by.big.perCaseUsd, 'not taken for another provider');
});

test('one round at a time; Stop ends its eval by its pid', async () => {
  const { f, call } = feature({ env: { STANDIN_SLOW: '1' } });
  const v = await call('POST', '/api/assistant/improve/start', { provider: 'paid-x', cap: 5 });
  assert.equal(v.round.running, true);
  // Refused by this dashboard's own round, before the lock file is even looked at.
  await assert.rejects(() => call('POST', '/api/assistant/improve/start', { provider: 'sub', cap: 2 }), (e) => e.status === 409 && e.message === 'a round runs already');
  for (let i = 0; i < 200 && !runs().length; i++) await new Promise((ok) => setTimeout(ok, 25));
  const pid = runs()[0].pid;
  const t0 = Date.now();
  await call('POST', '/api/assistant/improve/stop', {});
  await ended(f);
  assert.ok(Date.now() - t0 < 15_000, 'it ended at once, not when the eval would have finished');
  assert.throws(() => process.kill(pid, 0), 'the eval ended');
  const after = await call('GET', '/api/assistant/improve');
  assert.equal(after.round.running, false);
  assert.equal(after.round.stopped, 'you stopped it');
  await assert.rejects(() => call('POST', '/api/assistant/improve/stop', {}), /no round runs now/);
  assert.equal(new SpendLedger().today().held, 0, 'its hold was settled');
});

test('a round on a subscription takes no hold and writes nothing in the spending record', async () => {
  const { f, call } = feature();
  await call('POST', '/api/assistant/improve/start', { provider: 'sub', cap: 2 });
  await ended(f);
  const v = await call('GET', '/api/assistant/improve');
  assert.equal(v.round.paid, false);
  assert.equal(v.round.tried.length, 3);
  assert.equal(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'spend.jsonl')), false);
  assert.ok(v.round.measured && v.round.measured.cases === 11, 'the measured numbers are kept for the next estimate');
  assert.match(v.estimate.basis, /last round/);
});

test('a round the dashboard stopped in is marked stopped at the next start, its holds counted whole', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const l = new SpendLedger();
  assert.equal(l.take(20, { id: 'improve-0123456789ab', amount: 1.5 }), null);
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.json');
  fs.writeFileSync(file, JSON.stringify({ running: true, id: 'aaaaaaaaaaaa', pid: dead, startedAt: new Date().toISOString(), holds: ['improve-0123456789ab'], proposals: [], tried: [] }));
  fs.writeFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock'), JSON.stringify({ pid: dead, id: 'aaaaaaaaaaaa' }));
  const { f, call } = feature();
  f.start();
  try {
    const v = await call('GET', '/api/assistant/improve');
    assert.equal(v.round.running, false);
    assert.equal(v.round.stopped, RESTART_WHY);
    assert.equal(new SpendLedger().today().held, 0);
    assert.ok(Math.abs(new SpendLedger().today().spent - 1.5) < 1e-9, 'the whole hold counts');
    assert.equal(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock')), false);
  } finally {
    f.close();
  }
});

test('a round another dashboard runs (its lock, a live process) is not started twice', async () => {
  fs.mkdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock'), JSON.stringify({ pid: process.pid, id: 'bbbbbbbbbbbb' }));
  const { f, call } = feature();
  await assert.rejects(() => call('POST', '/api/assistant/improve/start', { provider: 'sub', cap: 2 }), /another dashboard/);
  assert.equal(f.current(), null);
  assert.equal(runs().length, 0);
});

test('the weekly round is off by default; switched on, it starts once a week on his provider', async () => {
  const { f, call } = feature();
  assert.equal(f.tick(), null, 'off: nothing starts');
  assert.equal(runs().length, 0);
  await assert.rejects(() => call('POST', '/api/assistant/improve/settings', { weekly: true }), /provider of the weekly round/);
  await assert.rejects(() => call('POST', '/api/assistant/improve/settings', { weekly: 'yes' }), /true or false/);
  await assert.rejects(() => call('POST', '/api/assistant/improve/settings', { other: 1 }), /not a setting/);
  await call('POST', '/api/assistant/improve/settings', { weekly: false, provider: 'sub' });
  assert.equal(f.tick(), null, 'off with a provider chosen: nothing starts');
  const v = await call('POST', '/api/assistant/improve/settings', { weekly: true, provider: 'sub', cap: 3 });
  assert.deepEqual(v.settings, { weekly: true, provider: 'sub', cap: 3 });
  const st = f.tick();
  assert.equal(st.by, 'weekly');
  await ended(f);
  assert.equal(f.tick(), null, 'not again within the week');
});

test('Windows: the round lock whose name is still held a moment by another program is taken once let go, never an error', (t) => {
  const lock = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock');
  const { writeFileSync } = fs;
  t.after(() => (fs.writeFileSync = writeFileSync));
  // What Windows answers while another program (a virus scan) still holds the last round's removed lock a moment.
  const heldUntil = Date.now() + 400;
  fs.writeFileSync = function (p, ...rest) {
    if (p === lock && Date.now() < heldUntil) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return writeFileSync.call(fs, p, ...rest);
  };
  assert.equal(takeLock('r1', { platform: 'win32' }), true, 'taken once the name was let go');
  // A live round's lock is still answered at once: not taken.
  assert.equal(takeLock('r2', { platform: 'win32' }), false);
  fs.rmSync(lock);
  // Elsewhere EPERM stays a refusal, as before.
  fs.writeFileSync = function (p, ...rest) {
    if (p === lock) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return writeFileSync.call(fs, p, ...rest);
  };
  assert.throws(() => takeLock('r3', { platform: 'linux' }), { code: 'EPERM' });
});

test('Windows: a round state written while the page reads it (a rename over an open file is refused) is written once let go', (t) => {
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.json');
  const { renameSync } = fs;
  t.after(() => (fs.renameSync = renameSync));
  let refusals = 0;
  // What Windows answers every time a rename goes over a file another process has open (measured).
  fs.renameSync = function (from, to, ...rest) {
    if (to === file && refusals < 3) {
      refusals++;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return renameSync.call(fs, from, to, ...rest);
  };
  writeStateForTest(file, { id: 'r1', running: true }, 'win32');
  assert.equal(refusals, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { id: 'r1', running: true });
  refusals = 0;
  assert.throws(() => writeStateForTest(file, { id: 'r2' }, 'linux'), { code: 'EPERM' }, 'elsewhere as before');
});

test('a round lock whose pid runs but whose identity is another process is taken over; a matching one is held; an old one as before', () => {
  const lock = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const live = process.ppid;
  for (const [then, now] of [['T:1000', 'T:900000'], ['L:boot-a:500', 'L:boot-a:777']]) {
    const ident = { self: () => now, of: (pids) => new Map(pids.map((p) => [p, now])) };
    fs.writeFileSync(lock, JSON.stringify({ pid: live, proc: then, id: 'old' }));
    assert.equal(takeLock('r1', { ident }), true, `${then}: a round that ended under a pid handed out again`);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).proc, now, 'this round writes its identity');
    fs.writeFileSync(lock, JSON.stringify({ pid: live, proc: now, id: 'live' }));
    assert.equal(takeLock('r2', { ident }), false, 'a round that runs');
    assert.equal(takeLock('r3', { ident: { self: () => now, of: (pids) => new Map(pids.map((p) => [p, null])) } }), false, 'cannot be told: held');
    fs.writeFileSync(lock, JSON.stringify({ pid: live, id: 'older' }));
    assert.equal(takeLock('r4', { ident }), false, 'an older version\'s lock: its pid alive, held as before');
    fs.rmSync(lock);
  }
});

test('a round whose lock cannot be removed at its end leaves no rejection that would end the dashboard, and the next start takes that lock', async (t) => {
  const { f, call } = feature();
  const lock = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock');
  const { rmSync } = fs;
  const rejected = [];
  const onRejection = (e) => rejected.push(e);
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    fs.rmSync = rmSync;
    process.off('unhandledRejection', onRejection);
  });
  // Any error of the removal (on Windows also an EPERM past its second): the lock stays where it is.
  fs.rmSync = function (p, ...rest) {
    if (p === lock) throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' });
    return rmSync.call(fs, p, ...rest);
  };
  await call('POST', '/api/assistant/improve/start', { provider: 'sub', cap: 2 });
  await ended(f);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(rejected.map((e) => e.message), [], 'no rejection left the round');
  assert.ok(fs.existsSync(lock), 'its lock was left');
  fs.rmSync = rmSync;
  await call('POST', '/api/assistant/improve/start', { provider: 'sub', cap: 2 });
  await ended(f);
});

test('a round left running is judged as its lock is: a pid another process has now is a round that ended; its own identity runs on', async () => {
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const live = process.ppid; // a pid that runs: the round's process ended, and the system gave its number to this one
  const ident = { self: () => 'T:900000', of: (pids) => new Map(pids.map((p) => [p, 'T:900000'])) };
  const left = (o) => fs.writeFileSync(file, JSON.stringify({ running: true, id: 'cccccccccccc', pid: live, startedAt: new Date().toISOString(), holds: [], proposals: [], tried: [], ...o }));
  for (const [o, settled, why] of [[{ proc: 'T:1000' }, true, 'its pid handed to another process'], [{ proc: 'T:900000' }, false, 'that very process runs it'], [{}, false, 'an older state, its pid alive: as before']]) {
    left(o);
    const { f, call } = feature({ ident });
    f.start();
    try {
      const v = await call('GET', '/api/assistant/improve');
      assert.equal(v.round.running, !settled, why);
      assert.equal(v.round.stopped, settled ? RESTART_WHY : undefined, why);
    } finally {
      f.close();
    }
  }
  fs.rmSync(file);
  const { f, call } = feature();
  await call('POST', '/api/assistant/improve/start', { provider: 'sub', cap: 2 });
  await ended(f);
  assert.equal(typeof JSON.parse(fs.readFileSync(file, 'utf8')).proc, 'string', 'a round writes its identity beside its pid');
});
