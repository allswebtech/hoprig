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
const { improveFeature, RESTART_WHY } = await import('../../src/assistant/improvefeature.mjs');
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
  const st = await call('POST', '/api/assistant/improve/start', { provider: 'console', cap: 2 });
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
  const v = await call('POST', '/api/assistant/improve/start', { provider: 'paid-x', cap: 2 });
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
