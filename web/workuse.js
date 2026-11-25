// What a Work run used, and what the cheaper way saved (src/work/runuse.mjs): one line "Used: … · Saved: …" on a run's
// card, beside Who did what, and the sums of today and the last 7 days at the top of Work → Activity. Every figure is
// one the records hold; one they do not hold says "not measured" and why. Money only as the records and the list
// prices allow: never rounded up (cut, not rounded), never on a subscription.
import { moneyCut } from './chat/words.js';
import { h } from './lib.js';

const num = (n) => Math.floor(Number(n) || 0).toLocaleString('en-US');
/** US dollars, cut (never rounded up): the one place that writes a dollar amount does it (chat/words.js). */
export const usd = moneyCut;
/** Minutes from start to end, whole minutes cut (38 min, 1 h 16 min, less than 1 min). */
export function minutes(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'less than 1 min';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
const TIER = { fast: 'fast', strong: 'strong', strongest: 'strongest', other: 'other helpers' };
const tokensOf = (u) => u.in + u.out; // the headline, as Who did what says it: cache reads apart

const WHY = {
  time: { running: 'time: still running', 'no-end': 'time: not measured (no end recorded)' },
  tokens: {
    'not-reported': 'tokens: not measured (the coding tool reported none)',
    'lead-unread': 'tokens: not measured (the lead\'s own records could not be read)',
    'outside-run': 'tokens: not measured (its session went on before or after the run, so its records are not this run\'s alone)',
    untimed: 'tokens: not measured (its records carry no times, so they cannot be told to be this run\'s alone)',
  },
  cost: {
    subscription: 'cost: not measured (a subscription has no price per token)',
    'not-reported': 'cost: not measured (the coding tool reported none)',
    'not-direct': 'cost: not measured (a key through a gateway is priced by the gateway)',
    'provider-unknown': 'cost: not measured (its provider is not known here)',
  },
  saving: {
    'no-helpers': 'not measured (no part was handed to a helper)',
    'lead-model-unknown': 'not measured (the lead\'s model is not recorded)',
    'lead-unread': 'not measured (the lead\'s own records could not be read)',
    'outside-run': 'not measured (its session went on before or after the run)',
    untimed: 'not measured (its records carry no times)',
  },
};

/** The words of a run's line: [used, saved] (runuse.mjs runUse's answer). */
export function useWords(u) {
  const used = [];
  used.push(u.ms !== null ? minutes(u.ms) : WHY.time[u.why.time]);
  if (u.tokens) {
    const per = [`lead ${num(tokensOf(u.lead.use))}`, ...u.tiers.map((t) => `${TIER[t.tier] || t.tier} ${num(tokensOf(t.use))}`)];
    used.push(`${per.join(', ')} tokens (new and written; ${num(u.tokens.cached)} more read from the cache)`);
  } else used.push(WHY.tokens[u.why.tokens]);
  if (u.models.length) used.push(u.models.join(', '));
  used.push(u.cost !== null ? `cost ${usd(u.cost)}, as the coding tool reported it` : WHY.cost[u.why.cost]);
  let saved;
  if (!u.saving) saved = WHY.saving[u.why.saving];
  else {
    const cached = u.saving.cached ? ` (and ${num(u.saving.cached)} read from the cache)` : '';
    saved = u.saving.parts ? `${num(u.saving.tokens)} tokens${cached} were done by a smaller model than ${u.saving.model}` : `no part ran on a smaller model than ${u.saving.model}`;
    const m = u.saving.money;
    if (m && u.saving.parts) saved += `; at ${u.saving.model}'s list price they would have cost ${usd(m.atLead)}, they cost ${usd(m.cost)} (list prices read ${m.pricesRead})`;
    else if (u.why.money === 'no-price' && u.saving.parts) saved += ` (money not measured: Hoprig has no list price for ${u.saving.unpriced.join(', ')})`;
    else if (u.why.money === 'not-direct' && u.saving.parts) saved += ' (money not measured: a key through a gateway is priced by the gateway)';
  }
  return [`Used: ${used.join(' · ')}`, `Saved: ${saved}`];
}

/** The line on a run's card. */
export function useLine(u) {
  const [used, saved] = useWords(u);
  return h('p.hint.wk-run-use', h('span', used), ' · ', h('span', saved));
}

/** One sum's words (runuse.mjs useSummary: today or week). */
export function sumWords(label, s) {
  if (!s.runs) return `${label}: no run.`;
  const parts = [`${s.runs === 1 ? '1 run' : `${s.runs} runs`}`];
  parts.push(s.timed ? `${minutes(s.ms)}${s.timed < s.runs ? ` (of ${s.timed} that ended)` : ''}` : 'time not measured');
  if (s.counted) {
    const per = [`lead ${num(tokensOf(s.lead))}`, ...s.tiers.map((t) => `${TIER[t.tier] || t.tier} ${num(tokensOf(t.use))}`)];
    parts.push(`${per.join(', ')} tokens${s.counted < s.runs ? ` (of ${s.counted} ${s.counted === 1 ? 'run' : 'runs'})` : ''}`);
  } else parts.push('tokens not measured');
  parts.push(s.costed ? `cost ${usd(s.cost)} (of ${s.costed} ${s.costed === 1 ? 'run' : 'runs'})` : 'cost not measured');
  if (s.saving) {
    const cached = s.savedCached ? ` (and ${num(s.savedCached)} read from the cache)` : '';
    let w = `${num(s.saved)} tokens${cached} done by a smaller model than the lead's (of ${s.saving} ${s.saving === 1 ? 'run' : 'runs'})`;
    // The money covers only the runs billed by use with every price known: said with its own tokens and runs.
    if (s.money.runs) w += `; of them, ${num(s.money.tokens)} tokens of ${s.money.runs === 1 ? '1 run' : `${s.money.runs} runs`} billed by use would have cost ${usd(s.money.atLead)} at their leads' list prices and cost ${usd(s.money.cost)}`;
    parts.push(w);
  } else parts.push('saving not measured');
  return `${label}: ${parts.join(' · ')}.`;
}

export const NOT_MEASURED = 'Read from the runs\' own records only. Not measured: the cost on a subscription (it has no price per token) or where the coding tool reported none, the time of a run still running, the tokens of a run whose tool reported none or whose session went on before or after it. A saving is said in money only on a provider billed by use and where Hoprig has a list price for every model; else in tokens.';

/** The card at the top of Activity (the history answer's `use`). */
export function useSummaryCard(sum) {
  return h('section.card.wk-use-sum', { dataset: { key: 'work-use' } },
    h('p.wk-use-line', sumWords('Today', sum.today)),
    h('p.wk-use-line', sumWords('Last 7 days', sum.week)),
    h('p.hint', NOT_MEASURED));
}
