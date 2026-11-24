// The owner's limits, checked before EVERY start of a mission's session (a task's run, its review, its fix): Tia's
// switches, how many sessions of hers at once, his working hours, this computer's load and memory, and the spend cap
// per day. → null (it may start) or one sentence why not. Pure: the facts are handed in.
import { LOAD_PER_CPU, MEM_FREE_PCT } from '../operator/detect/machine.mjs';
import { worksOn } from './settings.mjs';

/** "HH:MM" of `now` in time zone `tz` (Work's; '' is this computer's). */
export function clockIn(tz, now) {
  const f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) });
  return f.format(now);
}
/** Whether `hhmm` is inside his working hours { from, to } (to before from: across midnight). */
export function inHours(hours, hhmm) {
  if (!hours) return true;
  return hours.from < hours.to ? hhmm >= hours.from && hhmm < hours.to : hhmm >= hours.from || hhmm < hours.to;
}

/**
 * What the runs of every mission spent on `day`: { usd, tokens (of runs that reported tokens and no cost), unknown (runs
 * of no known cost and no budget) }. A run that reported neither (stopped at its time limit, failed, or settled after a
 * restart) counts at its whole budget: what it may have spent is never left out of the cap.
 */
export function spentOn(missions, day) {
  let usd = 0;
  let tokens = 0;
  let unknown = 0;
  for (const m of missions) for (const t of m.tasks) for (const r of t.runs) {
    if (r.day !== day) continue;
    if (r.cost !== null) usd += r.cost;
    else if (r.tokens !== null) tokens += r.tokens;
    else if (r.budget) usd += r.budget;
    else unknown += 1;
  }
  return { usd: Math.round(usd * 10000) / 10000, tokens, unknown };
}

export const MIN_RUN_USD = 0.05; // less of the cap than this left for a session: it does not start

/**
 * A new session's budget: what is left of today's cap after what was spent and what her sessions that run now hold,
 * shared with the places still free or, when more, with the sessions still to come (`toCome`: each queued task's next
 * session and its review), in whole cents rounded down. So her sessions of a day, at once or one after another, never
 * hold more than the cap, and one session never holds all of it. → { left, budget } (budget null: under MIN_RUN_USD).
 */
export function budgetFor({ capUsd, spentUsd, held, most, running, toCome = 1 }) {
  const left = Math.round((capUsd - spentUsd - held) * 100) / 100;
  const budget = Math.floor((left / Math.max(1, most - running, toCome)) * 100 + 1e-9) / 100;
  return { left, budget: budget >= MIN_RUN_USD ? budget : null };
}

/** The machine as the operator's machine detector judges it: a sentence when it is overloaded, else null. */
export function overloaded(m) {
  if (!m) return null;
  if (m.cpus && m.load1 / m.cpus > LOAD_PER_CPU) return `this computer is overloaded (load ${m.load1.toFixed(1)} on ${m.cpus} CPUs)`;
  if (m.memTotal && (m.memAvailable / m.memTotal) * 100 < MEM_FREE_PCT) return 'this computer is low on memory';
  return null;
}

/**
 * c: { s (settings), project, running (sessions of hers running now), slots (this computer's "runs by themselves at
 * once"), clock ("HH:MM" now), spent (spentOn today), machine }. → null or why.
 */
export function whyNot(c) {
  const s = c.s;
  if (!s.on) return 'Tia OFF: nothing new starts';
  if (!worksOn(s, c.project)) return `Tia does not work on ${c.project} by herself (its switch is off)`;
  if (!inHours(s.hours, c.clock)) return `outside your working hours (${s.hours.from} to ${s.hours.to})`;
  const most = Math.min(s.atOnce, c.slots);
  if (c.running >= most) return `${c.running} of her sessions run now (at most ${most} at once)`;
  const busy = overloaded(c.machine);
  if (busy) return busy;
  if (!(s.capUsd > 0)) return 'no spend cap is set yet: set one under Work → Team';
  if (c.spent.usd >= s.capUsd) return `the spend cap of today is reached ($${c.spent.usd.toFixed(2)} of $${s.capUsd.toFixed(2)})`;
  if (s.capTokens > 0 && c.spent.tokens >= s.capTokens) return `the token cap of today is reached (${c.spent.tokens} of ${s.capTokens})`;
  return null;
}

/**
 * The providers she may use, in his order, gateway and API-key providers first and a subscription after them (only
 * when he put it in the order). `known`: [{ name, kind }] of this computer; `silent`: providers that reported neither a
 * cost nor tokens, never used unattended again; `tokensOnly`: those that report tokens alone (used only with a token cap).
 */
export function providerOrder(s, known, { silent = [], tokensOnly = [], skip = [] } = {}) {
  const kindOf = new Map(known.map((p) => [p.name, p.kind]));
  const sub = (n) => ['login', 'subscription'].includes(kindOf.get(n));
  const ok = s.providers.filter((n) => kindOf.has(n) && kindOf.get(n) !== 'auto' && !silent.includes(n) && !skip.includes(n) && !(tokensOnly.includes(n) && !(s.capTokens > 0)));
  return [...ok.filter((n) => !sub(n)), ...ok.filter(sub)];
}
