// What one Work run used and what the cheaper way saved (src/work/runuse.mjs), from made-up records only: the minutes,
// the tokens per tier, the cost only where a provider billed by use reported one, the saving in tokens of the lead's
// model not used, and in money only where every price is in the tree. A figure the records do not hold is null with
// its reason, never a 0 or a guess.
import assert from 'node:assert/strict';
import test from 'node:test';

const { runUse, useSummary, priceOf } = await import('../../src/work/runuse.mjs');

const use = (i, o, c) => ({ in: i, out: o, cached: c });
const run = (x = {}) => ({ id: '20261117-100000-aaaaaaaa', state: 'done', startedAt: '2026-11-17T10:00:00.000Z', endedAt: '2026-11-17T10:38:00.000Z', provider: 'sub', model: 'claude-opus-5-5', ...x });
const card = (helpers, lead = { model: 'claude-opus-5-5', tokens: 4300, use: use(2400, 1900, 186000) }) => {
  const tiers = [];
  for (const p of helpers) {
    let t = tiers.find((x) => x.tier === (p.tier || 'other'));
    if (!t) tiers.push((t = { tier: p.tier || 'other', models: [], tokens: 0, use: use(0, 0, 0), parts: 0 }));
    if (!t.models.includes(p.model)) t.models.push(p.model);
    t.tokens += p.use.in + p.use.out;
    t.use = use(t.use.in + p.use.in, t.use.out + p.use.out, t.use.cached + p.use.cached);
    t.parts++;
  }
  const parts = helpers.map((p) => ({ kind: 'k', tokens: p.use.in + p.use.out, cacheWrite: 0, ...p }));
  for (const p of parts) if (!p.byModel) p.byModel = [{ model: p.model, ...p.use, cacheWrite: p.cacheWrite, write1h: 0 }];
  return { lead, parts, tiers, span: { first: Date.parse('2026-11-17T10:05:00.000Z'), last: Date.parse('2026-11-17T10:30:00.000Z') } };
};
const SUB = { kind: 'subscription', paid: false };
const PAID = { kind: 'api', paid: true };

test('a run with helpers on a subscription: minutes, tokens per tier, the saving in tokens, never in money', () => {
  const c = card([
    { tier: 'fast', model: 'claude-haiku-5-5', use: use(9100, 1400, 52000) },
    { tier: 'strong', model: 'claude-sonnet-5-5', use: use(14800, 6200, 98000) },
    { tier: 'strongest', model: 'claude-opus-5-5', use: use(3900, 2100, 41000) },
  ]);
  const u = runUse(run({ used: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 3.2 } }), c, SUB);
  assert.equal(u.ms, 38 * 60_000);
  assert.deepEqual(u.lead, { model: 'claude-opus-5-5', use: use(2400, 1900, 186000) });
  assert.deepEqual(u.tiers.map((t) => [t.tier, t.use]), [['fast', use(9100, 1400, 52000)], ['strong', use(14800, 6200, 98000)], ['strongest', use(3900, 2100, 41000)]]);
  assert.deepEqual(u.tokens, use(2400 + 9100 + 14800 + 3900, 1900 + 1400 + 6200 + 2100, 186000 + 52000 + 98000 + 41000));
  assert.deepEqual(u.models, ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(u.cost, null, 'a subscription\'s reported cost is no cost: never shown');
  assert.equal(u.why.cost, 'subscription');
  // Only the helpers on a smaller model than the lead's: Haiku's and Sonnet's new and written tokens, not Opus's.
  assert.equal(u.saving.tokens, 9100 + 1400 + 14800 + 6200);
  assert.equal(u.saving.model, 'claude-opus-5-5');
  assert.equal(u.saving.money, null);
  assert.equal(u.why.money, 'subscription');
});

test('billed by use, every price in the tree: the helpers at the lead\'s price and at their own', () => {
  const c = card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(1000, 500, 10000), cacheWrite: 200 }]);
  const u = runUse(run({ used: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: 1.25 } }), c, PAID);
  assert.equal(u.cost, 1.25, 'the cost the coding tool reported');
  // Opus 5.5: 800 new × 4 + 200 written × 5 + 500 out × 20 + 10,000 cached × 0.2, per million; Sonnet 5.5: 2, 2.5, 10, 0.1.
  assert.ok(Math.abs(u.saving.money.atLead - (800 * 4 + 200 * 5 + 500 * 20 + 10000 * 0.2) / 1e6) < 1e-12);
  assert.ok(Math.abs(u.saving.money.cost - (800 * 2 + 200 * 2.5 + 500 * 10 + 10000 * 0.1) / 1e6) < 1e-12);
  assert.equal(u.saving.money.pricesRead, '2026-11-19');
  // A helper on the lead's own model saved nothing: it is in neither figure.
  const withOpus = runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(1000, 500, 10000), cacheWrite: 200 }, { tier: 'strongest', model: 'claude-opus-5-5', use: use(5000, 5000, 0), cacheWrite: 0 }]), PAID);
  assert.equal(withOpus.saving.tokens, 1500);
  assert.deepEqual(withOpus.saving.money, u.saving.money);
  assert.equal(runUse(run(), card([{ tier: 'strongest', model: 'claude-opus-5-5', use: use(5, 5, 0) }]), PAID).why.money, 'none-smaller');
  assert.equal(runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(5, 5, 0) }]), null).why.money, 'provider-unknown');
  assert.equal(u.why.money, null);
});

test('money is said only where the tree holds every price: a model without one, Haiku\'s conditional price, no written count', () => {
  const paid = (helpers, lead) => runUse(run(), card(helpers, lead), PAID);
  const haiku = paid([{ tier: 'fast', model: 'claude-haiku-5-5', use: use(100, 10, 0) }]);
  assert.equal(haiku.saving.money, null);
  assert.equal(haiku.why.money, 'no-price');
  assert.deepEqual(haiku.saving.unpriced, ['claude-haiku-5-5']);
  assert.equal(haiku.saving.tokens, 110, 'the tokens are still said');
  const older = paid([{ tier: 'strong', model: 'claude-sonnet-4-5-20250929', use: use(100, 10, 0) }]);
  assert.equal(older.why.money, 'no-price', 'another version has no price here');
  const noWritten = runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(100, 10, 0), byModel: [{ model: 'claude-sonnet-5-5', ...use(100, 10, 0), cacheWrite: null, write1h: 0 }] }]), PAID);
  assert.equal(noWritten.why.money, 'no-price', 'what was written to the cache is not known: no price');
  const gateway = runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(100, 10, 0) }]), { kind: 'api', paid: false });
  assert.equal(gateway.why.money, 'not-direct', 'a key through a gateway: what it costs is the gateway\'s');
  assert.equal(priceOf('claude-opus-5-5').name, 'Claude Opus 5.5');
  assert.equal(priceOf('claude-opus-4-1'), null);
  assert.equal(priceOf('claude-haiku-5-5'), null);
});

test('a figure the records do not hold is not measured, with its reason', () => {
  const plain = runUse(run({ used: null }), null, SUB);
  assert.equal(plain.tokens, null);
  assert.equal(plain.why.tokens, 'not-reported');
  assert.equal(plain.saving, null);
  assert.equal(plain.why.saving, 'no-helpers');
  const going = runUse(run({ state: 'running', endedAt: null }), null, PAID);
  assert.equal(going.ms, null);
  assert.equal(going.why.time, 'running');
  assert.equal(going.why.cost, 'not-reported');
  const auto = runUse(run({ provider: 'auto' }), null, null);
  assert.equal(auto.why.cost, 'provider-unknown');
  // No helper: the result line's usage is the lead's own (new input with what was written to the cache).
  const alone = runUse(run({ used: { input: 100, output: 50, cacheRead: 9000, cacheWrite: 20, costUsd: 0.04 } }), null, PAID);
  assert.deepEqual(alone.lead, { model: 'claude-opus-5-5', use: use(120, 50, 9000) });
  assert.equal(alone.cost, 0.04);
  const noLeadModel = runUse(run(), card([{ tier: 'fast', model: 'claude-haiku-5-5', use: use(1, 1, 0) }], { model: null, tokens: 2, use: use(1, 1, 0) }), SUB);
  assert.equal(noLeadModel.saving, null);
  assert.equal(noLeadModel.why.saving, 'lead-model-unknown');
  const unread = runUse(run(), { ...card([{ tier: 'fast', model: 'claude-haiku-5-5', use: use(1, 1, 0) }]), lead: null }, SUB);
  assert.equal(unread.tokens, null);
  assert.equal(unread.why.tokens, 'lead-unread');
});

test('today and the last 7 days: sums of what was measured, with how many runs each figure covers', () => {
  const a = runUse(run({ used: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 } }), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(1000, 500, 0), cacheWrite: 0 }]), PAID);
  const b = runUse(run({ used: null }), null, SUB);
  const c = runUse(run({ state: 'running', endedAt: null }), null, SUB);
  const s = useSummary([{ day: '2026-11-24', use: a }, { day: '2026-11-24', use: c }, { day: '2026-11-20', use: b }, { day: '2026-11-17', use: a }], { today: '2026-11-24' });
  assert.deepEqual([s.today.runs, s.today.timed, s.today.counted, s.today.costed, s.today.saving, s.today.money.runs], [2, 1, 1, 1, 1, 1]);
  assert.deepEqual([s.week.runs, s.week.timed, s.week.counted], [3, 2, 1], 'the 17th is eight days back: not in the week');
  assert.equal(s.today.cost, 0.5);
  assert.equal(s.today.saved, 1500);
  assert.equal(s.today.money.tokens, 1500, 'the saved tokens the money covers');
  assert.deepEqual(s.today.tiers, [{ tier: 'strong', use: use(1000, 500, 0) }]);
  assert.equal(s.week.ms, 2 * 38 * 60_000);
});

test('a gateway key\'s cost, a fallback turn, an hour\'s cache write, a session past its run, cache reads, an unread lead', () => {
  const gw = runUse(run({ used: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 } }), null, { kind: 'api', paid: false });
  assert.equal(gw.cost, null, 'a key through a gateway: the reported cost is not what was paid');
  assert.equal(gw.why.cost, 'not-direct');
  assert.equal(runUse(run({ used: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 } }), null, { kind: 'openai', paid: false }).cost, null);
  // A helper on Sonnet that fell back to Opus (the lead's model) for a turn: only the Sonnet share is saved and priced.
  const mixed = runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(1900, 190, 0), byModel: [{ model: 'claude-sonnet-5-5', ...use(1000, 100, 0), cacheWrite: 0, write1h: 0 }, { model: 'claude-opus-5-5', ...use(900, 90, 0), cacheWrite: 0, write1h: 0 }] }]), PAID);
  assert.equal(mixed.saving.tokens, 1100);
  assert.ok(Math.abs(mixed.saving.money.atLead - (1000 * 4 + 100 * 20) / 1e6) < 1e-12);
  assert.ok(Math.abs(mixed.saving.money.cost - (1000 * 2 + 100 * 10) / 1e6) < 1e-12);
  // What was written to the cache for an hour has a price the tree does not hold: no money.
  const hour = runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(10000, 0, 0), byModel: [{ model: 'claude-sonnet-5-5', ...use(10000, 0, 0), cacheWrite: 10000, write1h: 10000 }] }]), PAID);
  assert.equal(hour.saving.money, null);
  assert.equal(hour.why.money, 'no-price');
  assert.match(hour.saving.unpriced.join(), /for an hour/);
  const unsplit = runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(10, 0, 0), byModel: [{ model: 'claude-sonnet-5-5', ...use(10, 0, 0), cacheWrite: 10, write1h: null }] }]), PAID);
  assert.equal(unsplit.why.money, 'no-price', 'a cache write the record does not split: not priced');
  // A conversation that went on after the run (or carries no times): its tokens are not the run's alone.
  const c = card([{ tier: 'fast', model: 'claude-haiku-5-5', use: use(10, 1, 0) }]);
  const late = runUse(run(), { ...c, span: { first: c.span.first, last: Date.parse('2026-11-19T10:00:00.000Z') } }, SUB);
  assert.deepEqual([late.tokens, late.why.tokens, late.saving, late.why.saving], [null, 'outside-run', null, 'outside-run']);
  const untimed = runUse(run(), { ...c, span: null }, SUB);
  assert.deepEqual([untimed.tokens, untimed.why.tokens, untimed.why.saving], [null, 'untimed', 'untimed']);
  // A helper with only cache reads did run on a smaller model: said, with its cache reads apart.
  const reads = runUse(run(), card([{ tier: 'strong', model: 'claude-sonnet-5-5', use: use(0, 0, 5000) }]), SUB);
  assert.deepEqual([reads.saving.tokens, reads.saving.cached, reads.saving.parts], [0, 5000, 1]);
  // The lead's records unread: the reason says so, not that its model is not recorded.
  assert.equal(runUse(run(), { ...c, lead: null }, SUB).why.saving, 'lead-unread');
});
