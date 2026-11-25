// What one Work run used, and what the cheaper way saved, read only from what the tree records: the run file's start,
// end, provider and `used` (runs.mjs: what the coding tool's result line reported), its lead's and helpers' tokens per
// tier and per model (models/parts.mjs, through pulse.mjs), the provider's kind (profiles.mjs) and the list prices the
// product keeps (operator/prices.mjs). Nothing is estimated, rounded up or guessed: a figure the records do not hold is
// null, and `why` says why it is not measured.
//
// The saving: what helpers did on a smaller model than the lead's, counted per model (a helper that fell back to the
// lead's own model for a turn saved nothing on that turn). In tokens wherever the lead's model is known; in money only
// on a provider billed by use straight to the API (paid), and only when every model involved has a full list price
// here: never on a subscription, which has no price per token.
import { tierOf } from '../models/tiers.mjs';
import { PRICES, PRICES_READ } from '../operator/prices.mjs';
import { addDays } from './model.mjs';

const RANK = { fast: 0, strong: 1, strongest: 2 };
const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];
const TIER_ORDER = ['fast', 'strong', 'strongest', 'other'];
// The run's file is written when its session's turn ends; a message of the session written later than that (or before
// its start) is not this run's. A few seconds of room for the order of two writes on one computer.
const SLACK_MS = 5000;
// Haiku 5.5's list price holds only for a prompt of 100K tokens or fewer, and its cache read has none (prices.mjs). The
// size of each prompt is not recorded here, so that price is not sure for a part: it is not used.
const CONDITIONAL = new Set(['Claude Haiku 5.5']);
const fin = (n) => Number.isFinite(n) && n >= 0;
const msOf = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);
const idOf = (name) => name.toLowerCase().replace(/[ .]/g, '-'); // "Claude Opus 5.5" → claude-opus-5-5
const bareId = (model) => String(model || '').toLowerCase().split('/').pop().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
const tierOfModel = (model) => (model ? tierOf({ id: String(model), label: '' }) : null);
const billedKind = (b) => !!(b && (b.kind === 'api' || b.kind === 'openai'));
const rank = (t) => (TIER_ORDER.includes(t) ? TIER_ORDER.indexOf(t) : TIER_ORDER.length);

/** The list price of exactly this model (its id names the priced model and version), or null. */
export function priceOf(model) {
  const id = bareId(model);
  if (!id) return null;
  const p = Object.values(PRICES).find((x) => idOf(x.name) === id);
  return p && !CONDITIONAL.has(p.name) && FIELDS.every((k) => fin(p[k])) ? p : null;
}

/** What one model's tokens { in (new, with what was written to the cache), out, cached, cacheWrite } cost at price `p`. */
const costAt = (p, x) => ((x.in - x.cacheWrite) * p.input + x.cacheWrite * p.cacheWrite + x.out * p.output + x.cached * p.cacheRead) / 1e6;
const useOf = (u) => ({ in: fin(u && u.in) ? u.in : 0, out: fin(u && u.out) ? u.out : 0, cached: fin(u && u.cached) ? u.cached : 0 });
const addUse = (a, b) => ({ in: a.in + b.in, out: a.out + b.out, cached: a.cached + b.cached });
const ZERO = Object.freeze({ in: 0, out: 0, cached: 0 });

/**
 * One run → { ms, lead: { model, use } | null, tiers: [{ tier, models, use, parts }], tokens: { in, out, cached } | null,
 * models, cost (US dollars the coding tool reported, on a provider billed by use straight to the API) | null, saving, why }.
 * `parts`: the run's "Who did what" card (pulse.mjs cardOf: its parts carry `byModel`, the card `span`) or null;
 * `billing`: { kind, paid } of its provider (null: not known, as for Auto mode). saving: null (not measured), else
 * { tokens (new and written), cached, parts (how many model shares were smaller), model (the lead's), money: { atLead,
 * cost, pricesRead } | null, unpriced? }. why: { time, tokens, cost, saving, money }, each a word when that figure is
 * not measured, else null.
 */
export function runUse(run, parts = null, billing = null) {
  const why = { time: null, tokens: null, cost: null, saving: null, money: null };
  const s = msOf(run && run.startedAt);
  const e = msOf(run && run.endedAt);
  const ms = Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : null;
  if (ms === null) why.time = run && run.state === 'running' ? 'running' : 'no-end';

  const helpers = parts && Array.isArray(parts.parts) ? parts.parts : [];
  let lead = null;
  let tiers = [];
  let bounded = null; // why the card's tokens are not this run's alone
  if (helpers.length) {
    // The card reads the whole conversation: only when every message of it lies within the run are its tokens the run's.
    const span = parts.span;
    if (!span || !Number.isFinite(span.first) || !Number.isFinite(span.last)) bounded = 'untimed';
    else if ((Number.isFinite(s) && span.first < s - SLACK_MS) || (Number.isFinite(e) && span.last > e + SLACK_MS)) bounded = 'outside-run';
    else if (parts.lead) {
      lead = { model: parts.lead.model || null, use: useOf(parts.lead.use) };
      tiers = (parts.tiers || []).map((t) => ({ tier: t.tier, models: [...(t.models || [])], use: useOf(t.use), parts: t.parts })).sort((a, b) => rank(a.tier) - rank(b.tier));
    }
  } else if (run && run.used && FIELDS.every((k) => fin(run.used[k]))) {
    // No helper: what the coding tool's result line reported is the lead's own.
    const u = run.used;
    lead = { model: run.model || null, use: { in: u.input + u.cacheWrite, out: u.output, cached: u.cacheRead } };
  }
  if (!lead) why.tokens = bounded || (helpers.length ? 'lead-unread' : 'not-reported');
  const tokens = lead ? tiers.reduce((n, t) => addUse(n, t.use), lead.use) : null;
  const models = [];
  for (const m of [lead && lead.model, ...helpers.map((p) => p.model)]) if (m && !models.includes(m)) models.push(m);

  // The cost the coding tool reported is what was paid only on a key billed by use straight to the API.
  const reported = run && run.used && Number.isFinite(run.used.costUsd) && run.used.costUsd >= 0 ? run.used.costUsd : null;
  const cost = billing && billing.paid === true && billedKind(billing) && reported !== null ? reported : null;
  if (cost === null) why.cost = !billing ? 'provider-unknown' : !billedKind(billing) ? 'subscription' : billing.paid !== true ? 'not-direct' : 'not-reported';

  let saving = null;
  const leadModel = lead && lead.model;
  const leadTier = tierOfModel(leadModel);
  if (!helpers.length) why.saving = 'no-helpers';
  else if (bounded) why.saving = bounded;
  else if (!lead) why.saving = 'lead-unread';
  else if (!leadTier) why.saving = 'lead-model-unknown';
  else {
    // Per model: each helper's share on each model it ran on (parts.mjs byModel), so a fallback turn on the lead's own
    // model is not counted as done by a smaller one.
    const shares = helpers.flatMap((p) => (Array.isArray(p.byModel) ? p.byModel : []));
    const smaller = shares.filter((x) => {
      const t = tierOfModel(x.model);
      return t && RANK[t] < RANK[leadTier];
    }).map((x) => ({ model: x.model, ...useOf(x), cacheWrite: x.cacheWrite, write1h: x.write1h }));
    saving = { tokens: smaller.reduce((n, x) => n + x.in + x.out, 0), cached: smaller.reduce((n, x) => n + x.cached, 0), parts: smaller.length, model: leadModel, money: null };
    if (!billing) why.money = 'provider-unknown';
    else if (billing.paid !== true) why.money = billedKind(billing) ? 'not-direct' : 'subscription';
    else if (!smaller.length) why.money = 'none-smaller';
    else {
      const leadPrice = priceOf(leadModel);
      const unpriced = [];
      if (!leadPrice) unpriced.push(leadModel);
      for (const x of smaller) {
        if (!priceOf(x.model)) unpriced.push(x.model);
        // What was written to the cache for an hour has a price of its own that the tree does not hold.
        if (!fin(x.cacheWrite) || x.cacheWrite > x.in || !fin(x.write1h)) unpriced.push(`what ${x.model} wrote to the cache`);
        else if (x.write1h > 0) unpriced.push(`what ${x.model} wrote to the cache for an hour`);
      }
      if (unpriced.length) {
        why.money = 'no-price';
        saving.unpriced = [...new Set(unpriced)];
      } else {
        saving.money = { atLead: smaller.reduce((n, x) => n + costAt(leadPrice, x), 0), cost: smaller.reduce((n, x) => n + costAt(priceOf(x.model), x), 0), pricesRead: PRICES_READ };
      }
    }
  }
  return { ms, lead, tiers, tokens, models, cost, saving, why };
}

/**
 * Today and the last 7 days (today and the six days before it) of `rows` ([{ day (YYYY-MM-DD, Work's time zone), use
 * (runUse) }]) → { today: sum, week: sum, pricesRead }. A sum: { runs, ms, timed, lead, tiers: [{ tier, use }], tokens,
 * counted, cost, costed, saved, savedCached, saving (runs whose token saving was measured), money: { atLead, cost, runs,
 * tokens (the saved tokens the money covers) } }.
 */
export function useSummary(rows, { today }) {
  const sum = (from) => {
    const of = rows.filter((r) => r && r.use && typeof r.day === 'string' && r.day >= from && r.day <= today);
    const out = { runs: of.length, ms: 0, timed: 0, lead: ZERO, tiers: [], tokens: ZERO, counted: 0, cost: 0, costed: 0, saved: 0, savedCached: 0, saving: 0, money: { atLead: 0, cost: 0, runs: 0, tokens: 0 } };
    for (const { use: u } of of) {
      if (u.ms !== null) {
        out.ms += u.ms;
        out.timed++;
      }
      if (u.tokens) {
        out.counted++;
        out.tokens = addUse(out.tokens, u.tokens);
        out.lead = addUse(out.lead, u.lead.use);
        for (const t of u.tiers) {
          let x = out.tiers.find((y) => y.tier === t.tier);
          if (!x) out.tiers.push((x = { tier: t.tier, use: ZERO }));
          x.use = addUse(x.use, t.use);
        }
      }
      if (u.cost !== null) {
        out.cost += u.cost;
        out.costed++;
      }
      if (u.saving) {
        out.saved += u.saving.tokens;
        out.savedCached += u.saving.cached;
        out.saving++;
        if (u.saving.money) {
          out.money.atLead += u.saving.money.atLead;
          out.money.cost += u.saving.money.cost;
          out.money.tokens += u.saving.tokens;
          out.money.runs++;
        }
      }
    }
    out.tiers.sort((a, b) => rank(a.tier) - rank(b.tier));
    return out;
  };
  return { today: sum(today), week: sum(addDays(today, -6)), pricesRead: PRICES_READ };
}
