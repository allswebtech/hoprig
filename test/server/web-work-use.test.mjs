// "Used: … · Saved: …" on a Work run's card and the sums at the top of Work → Activity (web/workuse.js, from
// src/work/runuse.mjs), with a small stand-in for the browser DOM: what is not measured says so, a subscription never
// shows money, money is cut (never rounded up), and the runs route and the history route carry the figures.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
const { texts } = await import('../chat/fakedom.mjs');
const { useWords, useLine, sumWords, useSummaryCard, usd, minutes, NOT_MEASURED } = await import('../../web/workuse.js');
const { runCard } = await import('../../web/workdo.js');
const { runUse, useSummary } = await import('../../src/work/runuse.mjs');

const use = (i, o, c) => ({ in: i, out: o, cached: c });
const card = {
  lead: { model: 'claude-opus-5-5', tokens: 4300, use: use(2400, 1900, 186000) },
  parts: [
    { kind: 'Running and recording', tier: 'fast', model: 'claude-haiku-5-5', tokens: 10500, use: use(9100, 1400, 52000), cacheWrite: 0, byModel: [{ model: 'claude-haiku-5-5', ...use(9100, 1400, 52000), cacheWrite: 0, write1h: 0 }] },
    { kind: 'Writing and reviewing code', tier: 'strong', model: 'claude-sonnet-5-5', tokens: 21000, use: use(14800, 6200, 98000), cacheWrite: 0, byModel: [{ model: 'claude-sonnet-5-5', ...use(14800, 6200, 98000), cacheWrite: 0, write1h: 0 }] },
  ],
  tiers: [
    { tier: 'fast', models: ['claude-haiku-5-5'], tokens: 10500, use: use(9100, 1400, 52000), parts: 1 },
    { tier: 'strong', models: ['claude-sonnet-5-5'], tokens: 21000, use: use(14800, 6200, 98000), parts: 1 },
  ],
  span: { first: Date.parse('2026-11-17T10:05:00.000Z'), last: Date.parse('2026-11-17T10:30:00.000Z') },
};
const run = (x = {}) => ({
  id: '20261117-100000-aaaaaaaa', item: 'renew', title: 'Renew', startedAt: '2026-11-17T10:00:00.000Z', endedAt: '2026-11-17T10:38:00.000Z', project: 'shop', folder: '.',
  tool: 'claude', provider: 'sub', providerLabel: 'Main', model: 'claude-opus-5-5', session: null, state: 'done', reason: null, answer: '', commits: [], changed: [], more: 0, ...x,
});

test('money is cut, never rounded up; minutes are whole', () => {
  assert.equal(usd(1.239), '$1.23');
  assert.equal(usd(0.01999), '$0.0199');
  assert.equal(usd(0.0015), '$0.0015');
  assert.equal(minutes(38 * 60_000 + 59_000), '38 min');
  assert.equal(minutes(76 * 60_000), '1 h 16 min');
  assert.equal(minutes(20_000), 'less than 1 min');
});

test('a Lead run on a subscription: minutes, tokens per tier, models, the saving in tokens, no money', () => {
  const [used, saved] = useWords(runUse(run({ used: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 9.99 } }), card, { kind: 'subscription', paid: false }));
  assert.equal(used, 'Used: 38 min · lead 4,300, fast 10,500, strong 21,000 tokens (new and written; 336,000 more read from the cache) · claude-opus-5-5, claude-haiku-5-5, claude-sonnet-5-5 · cost: not measured (a subscription has no price per token)');
  assert.equal(saved, 'Saved: 31,500 tokens (and 150,000 read from the cache) were done by a smaller model than claude-opus-5-5');
  assert.doesNotMatch(`${used} ${saved}`, /\$/, 'no money on a subscription, not even the one the tool reported');
});

test('billed by use: the reported cost, and the helpers at the lead\'s price where every price is in the tree', () => {
  const sonnetOnly = { ...card, parts: [{ ...card.parts[1], cacheWrite: 0 }], tiers: [card.tiers[1]] };
  const [used, saved] = useWords(runUse(run({ used: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.4567 } }), sonnetOnly, { kind: 'api', paid: true }));
  assert.match(used, /cost \$1\.45, as the coding tool reported it$/);
  // Sonnet's 14,800 new, 6,200 out, 98,000 cached: at Opus 5.5 $0.2028, at Sonnet 5.5 $0.1014.
  assert.equal(saved, 'Saved: 21,000 tokens (and 98,000 read from the cache) were done by a smaller model than claude-opus-5-5; at claude-opus-5-5\'s list price they would have cost $0.2028, they cost $0.1014 (list prices read 2026-11-19)');
  const [, haiku] = useWords(runUse(run(), card, { kind: 'api', paid: true }));
  assert.match(haiku, /\(money not measured: Hoprig has no list price for claude-haiku-5-5\)$/);
});

test('a run without helpers and without a reported use says what is not measured', () => {
  const [used, saved] = useWords(runUse(run({ used: null, model: null }), null, { kind: 'subscription', paid: false }));
  assert.equal(used, 'Used: 38 min · tokens: not measured (the coding tool reported none) · cost: not measured (a subscription has no price per token)');
  assert.equal(saved, 'Saved: not measured (no part was handed to a helper)');
});

test('the run\'s card has the line under Who did what; a card without `use` has none', () => {
  const u = runUse(run(), card, { kind: 'subscription', paid: false });
  const el = runCard(run({ parts: card, use: u }));
  const kids = el.children.map((c) => (c && c.className) || '');
  const at = kids.findIndex((c) => /wk-run-parts/.test(c));
  assert.ok(at >= 0 && /wk-run-use/.test(kids[at + 1]), 'right after Who did what');
  assert.equal(texts(useLine(u)).join(''), useWords(u).join(' · '));
  assert.ok(!runCard(run()).children.some((c) => c && /wk-run-use/.test(c.className || '')));
});

test('the sums of today and the last 7 days, with the sentence of what is not measured', () => {
  const a = runUse(run(), card, { kind: 'subscription', paid: false });
  const b = runUse(run({ used: null, state: 'running', endedAt: null }), null, { kind: 'subscription', paid: false });
  const s = useSummary([{ day: '2026-11-24', use: a }, { day: '2026-11-24', use: b }, { day: '2026-11-21', use: a }], { today: '2026-11-24' });
  assert.equal(sumWords('Today', s.today), 'Today: 2 runs · 38 min (of 1 that ended) · lead 4,300, fast 10,500, strong 21,000 tokens (of 1 run) · cost not measured · 31,500 tokens (and 150,000 read from the cache) done by a smaller model than the lead\'s (of 1 run).');
  assert.match(sumWords('Last 7 days', s.week), /^Last 7 days: 3 runs · 1 h 16 min \(of 2 that ended\) · lead 8,600, fast 21,000, strong 42,000 tokens \(of 2 runs\)/);
  assert.equal(sumWords('Today', useSummary([], { today: '2026-11-24' }).today), 'Today: no run.');
  const el = useSummaryCard(s);
  assert.deepEqual(el.children.map((c) => texts(c).join('')), [sumWords('Today', s.today), sumWords('Last 7 days', s.week), NOT_MEASURED]);
});

test('the runs route and the history route carry the figures', async () => {
  const { doRoutes } = await import('../../src/work/dofeature.mjs');
  const { historyRoutes } = await import('../../src/work/historyfeature.mjs');
  const r = { ...run(), billing: { kind: 'subscription', paid: false } };
  const parts = new Map([[r.id, card]]);
  const route = doRoutes({ runs: { list: () => [r] }, readJson: async () => ({}), refOf: () => null, ownerOnly: () => {}, resume: async () => {}, partsByRun: async () => parts })
    .find(([m, re]) => m === 'GET' && re.test('/api/work/runs'));
  const got = await route[2]({}, [], new URLSearchParams());
  assert.deepEqual(got.runs[0].use, runUse(r, card, r.billing));
  const hist = historyRoutes({ ownerOnly: () => {}, place: () => ({ settings: { timeZone: 'UTC' } }), runs: { list: () => [{ ...r, day: '2026-11-24' }] }, read: async () => [], now: () => Date.parse('2026-11-24T12:00:00Z'), partsByRun: async () => parts })
    .find(([m, re]) => m === 'GET' && re.test('/api/work/history'));
  const body = await hist[2]({}, [], new URLSearchParams());
  assert.equal(body.use.today.runs, 1);
  assert.equal(body.use.today.saved, 31_500);
  assert.equal(body.use.today.costed, 0);
});

test('a gateway key shows no cost, a tiny cost is never $0, the sums say which tokens the money covers', () => {
  const [used] = useWords(runUse(run({ used: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 } }), null, { kind: 'api', paid: false }));
  assert.match(used, /cost: not measured \(a key through a gateway is priced by the gateway\)$/);
  assert.equal(usd(0.00004), 'less than $0.0001');
  const paid = runUse(run(), { ...card, parts: [card.parts[1]], tiers: [card.tiers[1]] }, { kind: 'api', paid: true });
  const sub = runUse(run(), card, { kind: 'subscription', paid: false });
  const s = useSummary([{ day: '2026-11-24', use: paid }, { day: '2026-11-24', use: sub }], { today: '2026-11-24' });
  assert.match(sumWords('Today', s.today), /; of them, 21,000 tokens of 1 run billed by use would have cost \$0\.2028 at their leads' list prices and cost \$0\.1014\.$/);
});
