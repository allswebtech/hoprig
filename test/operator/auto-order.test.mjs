// Auto mode is judged by what is in its order: a decision's call or a look on "auto" is free of charge only when no
// provider of Auto mode's order is billed by use; otherwise it is paid per use (only at "Hands off" and inside the
// daily cap), and the reason names the paid provider of the order. Made-up providers, a stand-in model and a stand-in
// runner: nothing here spends anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-auto-order');
test.after(() => box.cleanup());

const { pickProvider } = await import('../../src/operator/decider.mjs');
const { SpendLedger, spendFile } = await import('../../src/assistant/spend.mjs');
const { looks } = await import('../../src/operator/look.mjs');

const profiles = [{ name: 'plan-a', kind: 'subscription' }, { name: 'plan-b', kind: 'login' }, { name: 'paid-x', kind: 'api' }, { name: 'paid-y', kind: 'subscription', paid: true }];
const acc = (order) => ({ profiles, autoSwitch: { enabled: true, order } });
const free = acc(['plan-a', 'plan-b']);
const paid = acc(['plan-a', 'paid-x']);
const cfg = (level, accounts, cap = null) => ({ assistant: { enabled: true, level, accounts, dailyCapUsd: cap } });
const entries = () => {
  try {
    return fs.readFileSync(spendFile(), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

test('only Auto mode allowed, its order free of charge: a call goes through Auto mode at every level, nothing held', () => {
  fs.rmSync(spendFile(), { force: true });
  for (const level of ['ask', 'work', 'handsoff']) {
    for (const cap of [null, 5]) assert.deepEqual(pickProvider(cfg(level, ['auto'], cap), free), { provider: 'auto' }, `${level}, cap ${cap}`);
  }
  // An empty order serves nothing: Auto mode is not picked, and the reason says the order is empty.
  assert.deepEqual(pickProvider(cfg('work', ['auto']), acc([])), { error: 'Auto mode has no providers in its order' });
  assert.deepEqual(entries(), []);
});

test('Auto mode with nothing left in the order the router uses is not picked: the call goes on to what she may use, or says why', () => {
  fs.rmSync(spendFile(), { force: true });
  // A stored sign-in on a Console account's key (marked paid by the list), a key paid by its own file, an OpenAI key.
  const list = [...profiles, { name: 'acct', label: 'Account', kind: 'login', paid: true }, { name: 'oai', kind: 'openai', paid: true, tools: ['codex'] }];
  const off = (order) => ({ profiles: list, autoSwitch: { enabled: true, order, payPerUse: false } });
  for (const level of ['work', 'handsoff']) {
    assert.deepEqual(pickProvider(cfg(level, ['auto', 'plan-a'], 5), off(['acct'])), { provider: 'plan-a' }, level);
    assert.deepEqual(pickProvider(cfg(level, ['auto', 'plan-a'], 5), off(['acct', 'paid-x'])), { provider: 'plan-a' }, level);
  }
  assert.deepEqual(pickProvider(cfg('handsoff', ['auto'], 5), off(['acct'])), { error: 'Auto mode has nothing it may use, because Account in its order is billed by use and "Also use pay-per-use providers" is off' });
  assert.deepEqual(pickProvider(cfg('work', ['auto']), off(['ghost', 'oai', 'acct'])), { error: 'Auto mode has nothing it may use, because ghost in its order does not exist any more, oai does not serve Claude Code, and Account is billed by use and "Also use pay-per-use providers" is off' });
  // Beside a key billed by use only: the key is what is left, at "Hands off" inside the cap.
  assert.deepEqual(pickProvider(cfg('handsoff', ['auto', 'paid-x'], 5), off(['acct'])), { provider: 'paid-x', paid: true, cap: 5 });
  for (const order of [['acct'], ['ghost'], ['oai']]) {
    assert.doesNotMatch(String(pickProvider(cfg('work', ['auto']), off(order)).error), /no order of providers|no providers in its order/, order.join(' '));
  }
  // One provider of the order left is enough: Auto mode is picked as before.
  assert.deepEqual(pickProvider(cfg('work', ['auto', 'plan-a']), off(['acct', 'plan-b'])), { provider: 'auto' });
  assert.deepEqual(entries(), [], 'choosing writes nothing');
});

test('only Auto mode allowed, its order holding a provider billed by use: paid, and the reason names it', () => {
  fs.rmSync(spendFile(), { force: true });
  const work = pickProvider(cfg('work', ['auto'], 5), paid);
  assert.equal(work.error, 'Auto mode\'s order holds a provider billed by use (paid-x), and she spends that only at "Hands off"');
  const none = pickProvider(cfg('handsoff', ['auto']), paid);
  assert.equal(none.error, 'Auto mode\'s order holds a provider billed by use (paid-x), and Tia has no daily limit for paid use (Settings → Tia)');
  for (const r of [work, none]) assert.doesNotMatch(r.error, /every provider Tia may use is billed by use/, 'never that untrue sentence');
  // A profile marked paid per use counts as one billed by use too, and each such provider is named.
  assert.match(pickProvider(cfg('work', ['auto']), acc(['paid-y', 'plan-a', 'paid-x'])).error, /^Auto mode's order holds a provider billed by use \(paid-y, paid-x\), /);
  assert.deepEqual(pickProvider(cfg('handsoff', ['auto'], 5), paid), { provider: 'auto', paid: true, cap: 5 });
  new SpendLedger().spent(4.8, 'turn');
  assert.equal(pickProvider(cfg('handsoff', ['auto'], 5), paid).error, 'Auto mode\'s order holds a provider billed by use (paid-x), and today\'s daily limit for paid use of $5.00 is used up (Settings → Tia)');
  assert.equal(entries().length, 1, 'choosing writes nothing');
});

test('Auto mode beside a subscription: free Auto goes first; a paid Auto leaves the subscription, at "Do the work" and at "Hands off"', () => {
  for (const level of ['work', 'handsoff']) {
    assert.deepEqual(pickProvider(cfg(level, ['auto', 'plan-a']), free), { provider: 'auto' }, level);
    assert.deepEqual(pickProvider(cfg(level, ['auto', 'plan-a'], 5), paid), { provider: 'plan-a' }, level);
  }
});

test('Auto mode beside a provider billed by use: both paid, and the reason says so of each in true words', () => {
  fs.rmSync(spendFile(), { force: true });
  assert.deepEqual(pickProvider(cfg('work', ['auto', 'paid-x']), free), { provider: 'auto' }, 'a free Auto mode is not paid');
  const r = pickProvider(cfg('work', ['auto', 'paid-y']), paid);
  assert.equal(r.error, 'Auto mode\'s order holds a provider billed by use (paid-x); every other provider she may use is too, and she spends that only at "Hands off"');
  assert.deepEqual(pickProvider(cfg('handsoff', ['auto', 'paid-y'], 5), paid), { provider: 'auto', paid: true, cap: 5 });
  // Without Auto mode the sentence stays the one it was.
  assert.equal(pickProvider(cfg('work', ['paid-x']), { profiles }).error, 'every provider Tia may use is billed by use, and she spends that only at "Hands off"');
});

test('a look judges Auto mode by its order the same way: free order starts with no hold, a paid one only inside the cap', async () => {
  const item = { id: 'unknown-0000000000cd', kind: 'unknown', subject: 'Work run q', facts: [], target: { case: 'reason', project: 'shop' } };
  const run = async (level, cap, accounts) => {
    fs.rmSync(`${box.state}/operator`, { recursive: true, force: true });
    fs.rmSync(spendFile(), { force: true });
    const c = { assistant: { enabled: true, level, accounts: ['auto'], dailyCapUsd: cap }, operator: { acts: true, look: { on: true } } };
    const started = [];
    const runner = {
      start: async (j) => {
        started.push(j);
        return { run: { id: 'run-1' }, done: Promise.resolve({ id: 'run-1', state: 'done', answer: '{"cause":"not found","where":[],"mend":"","sure":"a guess"}', usage: { cost: 0.2, tokens: 900 } }) };
      },
      drop: async () => ({ removed: true }),
    };
    const lk = looks({ ctx: { config: () => c }, runner: () => runner, accounts: async () => accounts, model: 'claude-opus-made-up' });
    const r = await lk.startOne(item);
    if (r.done) await r.done;
    return { r, started };
  };
  const f = await run('work', null, free);
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0].provider, 'auto');
  assert.deepEqual(entries(), [], 'a free Auto mode holds nothing');
  const w = await run('work', 5, paid);
  assert.deepEqual(w.started, []);
  assert.equal(w.r.why, 'Auto mode\'s order holds a provider billed by use (paid-x), and she spends that only at "Hands off"');
  const n = await run('handsoff', null, paid);
  assert.deepEqual(n.started, []);
  assert.match(n.r.why, /^Auto mode's order holds a provider billed by use \(paid-x\), and Tia has no daily limit for paid use/);
  const y = await run('handsoff', 5, paid);
  assert.equal(y.started.length, 1);
  assert.match(JSON.parse(entries()[0]).id, /^look-/, 'held before it starts');
});
