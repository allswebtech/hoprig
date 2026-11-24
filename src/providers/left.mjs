// How much is left, per provider, from what was measured only: what the provider reported of its windows and when each
// resets (the usage the product already keeps, routerstate.mjs), how often it stopped the work in the last day (from the
// stops the Operator's look reads, held in memory and never written), and the pace of the last hour, only from two
// readings of the same window at least 30 minutes apart within the last hour. Nothing is estimated that was not
// measured: without two such readings there is no pace line, and without stops there is no count.

import { clock as dated } from '../operator/detect/util.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const GAP = 30 * 60_000;
// The words of the usage bars on the same page (web/accounts.js usageBars): one name for one window.
const WINDOWS = { fiveHour: 'the 5-hour limit', week: 'the weekly limit' };
const PER_PROVIDER = 200;

const readings = new Map(); // provider → [{ at, win, pct, resetsAt }]
const stops = new Map(); // provider → Map(key → { at, reason })

/** Forget everything (tests). */
export function forgetLeft() {
  readings.clear();
  stops.clear();
}

/** Note a provider's reported usage ({ fiveHour, week, at }); a reading already noted (same time) is not noted twice. */
export function noteReading(name, usage, now = Date.now()) {
  if (!name || !usage || !Number.isFinite(usage.at)) return;
  const list = readings.get(name) || [];
  for (const win of Object.keys(WINDOWS)) {
    const w = usage[win];
    if (!w || !Number.isFinite(w.pct)) continue;
    if (list.some((r) => r.at === usage.at && r.win === win)) continue;
    list.push({ at: usage.at, win, pct: w.pct, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null });
  }
  readings.set(name, list.filter((r) => now - r.at <= 2 * HOUR).slice(-PER_PROVIDER));
}

/** Note the stops of the board's sessions (each once, by who stopped and when), per provider. */
export function noteStops(sessions, now = Date.now()) {
  for (const s of sessions || []) {
    if (!s?.provider) continue;
    const seen = stops.get(s.provider) || new Map();
    const add = (who, x, reason) => {
      const at = Date.parse(x?.at);
      if (Number.isFinite(at) && now - at <= DAY) seen.set(`${s.name}|${who}|${at}`, { at, reason });
    };
    if (s.stop) add('main', s.stop, s.stop.reason);
    if (s.limit) add('main', s.limit, 'limit');
    for (const a of s.agents || []) if (a.stop) add(a.id, a.stop, a.stop.reason);
    for (const [k, v] of seen) if (now - v.at > DAY) seen.delete(k);
    stops.set(s.provider, seen);
  }
}

// A time of day alone reads as today: a reset days away is said with its date (the Operator's own clock).
const clock = (t, now) => dated(t, now);
const minutes = (ms) => `${Math.round(ms / 60_000)} minutes`;

/** The pace line of one window, or null: two readings at least 30 minutes apart within the last hour, the use rising. */
function pace(list, win, now) {
  const last = list.filter((r) => r.win === win && now - r.at <= HOUR).sort((a, b) => a.at - b.at);
  const b = last[last.length - 1];
  if (!b) return null;
  // The same window: a reading of an earlier window (another reset time) says nothing about this one.
  const a = last.find((r) => b.at - r.at >= GAP && (r.resetsAt == null || b.resetsAt == null || Math.abs(r.resetsAt - b.resetsAt) < 60_000));
  if (!a || b.pct <= a.pct) return null;
  const perMs = (b.pct - a.pct) / (b.at - a.at);
  const hours = (100 - b.pct) / perMs / HOUR;
  const basis = `from ${a.pct}% to ${b.pct}% used in ${minutes(b.at - a.at)}`;
  // A window that resets before the pace would use it up is not used up: the line says the reset instead.
  if (Number.isFinite(b.resetsAt) && b.at + hours * HOUR >= b.resetsAt) {
    return { win, hours: null, basis, line: `At the pace of the last hour ${WINDOWS[win]} is not used up before it resets at ${clock(b.resetsAt, now)} (${basis}).` };
  }
  const when = hours < 1 ? 'in less than an hour' : `in about ${Math.round(hours)} hours`;
  return { win, hours: Math.round(hours * 10) / 10, basis, line: `At the pace of the last hour ${WINDOWS[win]} is used up ${when} (${basis}).` };
}

/**
 * What is left of `name`, from what was measured: { windows: [{ win, words, pct, resetsAt, at, line }], stops: { day,
 * limits, line }, paces: [...], advice } — each line with its basis. `usage`: the provider's last kept figures.
 */
export function leftOf(name, usage, now = Date.now()) {
  if (usage) noteReading(name, usage, now);
  const windows = [];
  for (const [win, words] of Object.entries(WINDOWS)) {
    const w = usage?.[win];
    if (!w || !Number.isFinite(w.pct)) continue;
    const resets = Number.isFinite(w.resetsAt) ? `, resets at ${clock(w.resetsAt, now)}` : '';
    windows.push({ win, words, pct: w.pct, resetsAt: w.resetsAt ?? null, at: usage.at, line: `${words}: ${w.pct}% used${resets} (reported by the provider at ${clock(usage.at, now)})` });
  }
  const list = readings.get(name) || [];
  const paces = Object.keys(WINDOWS).map((win) => pace(list, win, now)).filter(Boolean);
  const day = [...(stops.get(name)?.values() || [])].filter((x) => now - x.at <= DAY);
  const limits = day.filter((x) => x.reason === 'limit').length;
  const out = { windows, paces, stops: { day: day.length, limits, line: day.length ? `It stopped the work ${day.length} time${day.length > 1 ? 's' : ''} in the last day, ${limits} of them at a usage limit (counted since the dashboard started).` : null }, advice: null };
  if (day.length && limits * 2 > day.length) out.advice = `Another account would have avoided ${limits} stop${limits > 1 ? 's' : ''}: more than half of the day's stops were limits.`;
  return out;
}
