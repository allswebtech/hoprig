// Repeating items (docs/WORK.md "Repeating tasks"): an item's `repeat` is a rule of the same kinds a schedule has
// (src/automation/schedules.mjs runsOn, nextDay, dayAtOrBefore), without a time:
//   { kind: 'daily' } | { kind: 'weekly', days: [0-6] } | { kind: 'monthly', day: 1-31 }   (+ Work's own keys below)
// A repeating item keeps ONE open occurrence, so a week away leaves no seven copies:
//   - marked done or dropped: the next occurrence is made, dated with the rule's first day after the later of today
//     and the item's own date;
//   - its date comes round again while it is still open (or waiting): the date moves on to the rule's newest day at or
//     before today, and the days it missed are kept on it (`repeat.missed`, the last MISSED_MAX).
// Every step is DETERMINISTIC: it depends only on the item and today, never on the clock's seconds or chance. An
// occurrence's id is the series id and its date (`<series>-YYYYMMDD`), its `repeat.series` names the series (the id of
// the first item), so two computers that take the same step write the same item and a save meets no conflict.
// Pure: no files here (the one writer, store.mjs, runs these under its lock).
import { dayAtOrBefore, nextDay } from '../automation/schedules.mjs';
import { EFFORTS } from '../config.mjs';
import { MODEL_RE } from '../server/endpoint.mjs';
import { CLOSED, ID_RE, insertItem, isYmd, setKey, statusOf } from './model.mjs';

export const MISSED_MAX = 10;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const COMPUTER_RE = /^[0-9a-f]{16}$/; // a dashboard's writer id (runs.mjs writerId): a computer's stable id in Work
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A repeat rule from the page or the command, checked strictly: the clean rule, or null (no repeat). */
export function checkRepeat(v) {
  if (v === null) return null;
  if (!isObj(v)) throw bad('a repeat is a rule: daily, weekly on days, or monthly on a day');
  const allow = { daily: ['kind'], weekly: ['kind', 'days'], monthly: ['kind', 'day'] }[v.kind];
  if (!allow) throw bad('a repeat is "daily", "weekly" or "monthly"');
  for (const k of Object.keys(v)) if (!allow.includes(k)) throw bad(`"${String(k).slice(0, 20)}" is not part of a ${v.kind} repeat`);
  if (v.kind === 'weekly') {
    if (!Array.isArray(v.days) || !v.days.length || v.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('choose at least one weekday (0 = Sunday … 6 = Saturday)');
    return { kind: 'weekly', days: [...new Set(v.days)].sort((a, b) => a - b) };
  }
  if (v.kind === 'monthly') {
    if (!Number.isInteger(v.day) || v.day < 1 || v.day > 31) throw bad('choose the day of the month (1 to 31; in a shorter month its last day)');
    return { kind: 'monthly', day: v.day };
  }
  return { kind: 'daily' };
}

// No permission mode: the Work file is shared (a collaborator's push, a merge from another computer), so a mode in it
// would let anyone who can write there choose what a run on this computer is allowed. A task's run asks (alone.mjs).
const RUN_AT_KEYS = ['time', 'computer', 'provider', 'model', 'effort', 'minutes', 'tell'];
/**
 * "Run by AI at 07:30" on an item (`work.at`): { time, computer, provider?, model?, effort?, mode?, minutes?, tell? }
 * checked, or null. `computer`: the stable id of the computer that runs it (runs.mjs writerId), or null: then it runs
 * nowhere until one is chosen. The rest are the choices of the run that ends by itself (alone.mjs).
 */
export function checkRunAt(v) {
  if (v === null) return null;
  if (!isObj(v)) throw bad('a run time is { time, computer }');
  for (const k of Object.keys(v)) if (!RUN_AT_KEYS.includes(k)) throw bad(`"${String(k).slice(0, 20)}" is not part of a run time`);
  if (typeof v.time !== 'string' || !TIME_RE.test(v.time)) throw bad('the time must look like 07:30 (24-hour clock)');
  if (v.computer !== undefined && v.computer !== null && (typeof v.computer !== 'string' || !COMPUTER_RE.test(v.computer))) throw bad('choose the computer it runs on');
  const out = { time: v.time, computer: v.computer || null };
  if (v.provider !== undefined && v.provider !== null && v.provider !== '') {
    if (typeof v.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.provider)) throw bad('choose a provider');
    out.provider = v.provider;
  }
  if (v.model !== undefined && v.model !== null) {
    if (typeof v.model !== 'string' || !MODEL_RE.test(v.model)) throw bad('the model is a model name such as sonnet or claude-sonnet-5-5');
    out.model = v.model;
  }
  if (v.effort !== undefined && v.effort !== null) {
    if (!EFFORTS.includes(v.effort)) throw bad(`the effort is one of: ${EFFORTS.join(', ')}`);
    out.effort = v.effort;
  }
  if (v.minutes !== undefined && v.minutes !== null) {
    if (!Number.isInteger(v.minutes) || v.minutes < 1 || v.minutes > 240) throw bad('the time limit is a whole number of minutes from 1 to 240');
    out.minutes = v.minutes;
  }
  if (v.tell !== undefined && v.tell !== null && v.tell !== 'news') {
    if (v.tell !== 'always') throw bad('tell me is "always" or only when there is something to report');
    out.tell = 'always';
  }
  return out;
}

/** The rule of an item as the schedules' code reads it, or null when it has none it understands. */
export function ruleOf(raw) {
  if (!isObj(raw.repeat)) return null;
  try {
    return checkRepeat(Object.fromEntries(Object.entries(raw.repeat).filter(([k]) => ['kind', 'days', 'day'].includes(k))));
  } catch {
    return null;
  }
}

const compact = (ymd) => ymd.replace(/-/g, '');
export const seriesOf = (raw) => (isObj(raw.repeat) && typeof raw.repeat.series === 'string' && ID_RE.test(raw.repeat.series) ? raw.repeat.series : raw.id);
/** The id of the occurrence of `series` on `date`: deterministic, within the id pattern. */
// 68 + '-' + 8 digits + '-r' (another series has the plain id) = 79: within ID_RE's 80.
export const occurrenceId = (series, date) => `${series.slice(0, 68).replace(/-+$/, '')}-${compact(date)}`;

/** Keep the rule (and the series) on an item, beside what else `repeat` holds; null takes it off. */
export function setRepeat(item, rule) {
  if (rule === null) {
    delete item.repeat;
    return item;
  }
  const keep = isObj(item.repeat) ? Object.fromEntries(Object.entries(item.repeat).filter(([k]) => k === 'series' || k === 'missed')) : {};
  setKey(item, 'repeat', { ...rule, ...keep });
  return item;
}

/** Keep the run time on an item (`work.at`), beside what else its `work` holds; null takes it off. */
export function setRunAt(item, at) {
  const work = isObj(item.work) ? { ...item.work } : {};
  if (at === null) delete work.at;
  else work.at = at;
  if (Object.keys(work).length) setKey(item, 'work', work);
  else delete item.work;
  return item;
}

/**
 * After item `raw` was marked done or dropped: make its next occurrence in `doc` (once: an occurrence of the series
 * on that day already there is it). → the new item, or null (no rule, or none made).
 */
export function nextOccurrence(doc, raw, today) {
  const rule = ruleOf(raw);
  if (!rule || !CLOSED.has(statusOf(raw))) return null;
  const from = isYmd(raw.date) && raw.date > today ? raw.date : today;
  const date = nextDay(rule, from);
  if (!date) return null;
  const series = seriesOf(raw);
  const list = doc.items;
  const sameSeries = (x) => isObj(x) && x !== raw && seriesOf(x) === series && isObj(x.repeat);
  // One open occurrence: another open one of the series (made on another computer) is it already.
  if (list.some((x) => sameSeries(x) && !CLOSED.has(statusOf(x)))) return null;
  let id = occurrenceId(series, date);
  if (list.some((x) => isObj(x) && x.id === id)) {
    if (list.some((x) => sameSeries(x) && x.id === id)) return null;
    id = `${id}-r`; // an item of another series has that id: still the same for every computer
  }
  const item = {};
  setKey(item, 'id', id);
  setKey(item, 'date', date);
  setKey(item, 'approx', false);
  for (const k of ['title', 'brands', 'kind', 'owner', 'by']) if (k in raw) setKey(item, k, structuredClone(raw[k]));
  setKey(item, 'status', 'open');
  for (const k of ['source', 'from', 'note', 'client', 'priority']) if (k in raw) setKey(item, k, structuredClone(raw[k]));
  setKey(item, 'created', today);
  for (const k of ['project', 'plan', 'milestone']) if (k in raw) setKey(item, k, structuredClone(raw[k]));
  setKey(item, 'repeat', { ...rule, series, ...(Array.isArray(raw.repeat.missed) && raw.repeat.missed.length ? { missed: raw.repeat.missed.slice(-MISSED_MAX) } : {}) });
  // The brief and the run time go along; a run of the done one stays its own (runs.mjs: never on the item).
  if (isObj(raw.work)) {
    const { brief, at } = raw.work;
    const work = { ...(typeof brief === 'string' ? { brief } : {}), ...(isObj(at) ? { at: structuredClone(at) } : {}) };
    if (Object.keys(work).length) setKey(item, 'work', work);
  }
  insertItem(list, item);
  return item;
}

/**
 * Item `raw` of a series was opened again after it was done or dropped: the next occurrence its close made is taken
 * back while it is exactly as it was made (nothing of the owner's in it), so one occurrence stays open. One he
 * changed, or one a date roll moved on, stays. → the id taken back, or null.
 */
export function takeBackNext(doc, raw) {
  if (!ruleOf(raw) || CLOSED.has(statusOf(raw))) return null;
  const series = seriesOf(raw);
  const list = doc.items;
  const cand = list.find((x) => isObj(x) && x !== raw && isObj(x.repeat) && seriesOf(x) === series && !CLOSED.has(statusOf(x)) && isYmd(x.created));
  if (!cand) return null;
  // What closing `raw` would have made on the day `cand` was made: the same item, or it is not Work's alone.
  const trial = { items: list.filter((x) => x !== cand).map((x) => (x === raw ? { ...structuredClone(raw), status: 'done' } : x)) };
  const made = nextOccurrence(trial, trial.items.find((x) => isObj(x) && x.id === raw.id && x.status === 'done'), cand.created);
  if (!made || JSON.stringify(made) !== JSON.stringify(cand)) return null;
  list.splice(list.indexOf(cand), 1);
  return cand.id;
}

/**
 * Move on every open (or waiting) repeating item whose date came round again: its date becomes the rule's newest day
 * at or before today, and each day of the rule it missed is kept in `repeat.missed` (the last MISSED_MAX). An item a
 * session works on, or that waits for review, is left as it is. → [{ id, from, to }] (nothing: []).
 */
export function rollRepeats(doc, today) {
  const out = [];
  const list = Array.isArray(doc.items) ? doc.items : [];
  for (const raw of [...list]) {
    if (!isObj(raw) || !isYmd(raw.date) || !['open', 'waiting'].includes(statusOf(raw))) continue;
    const rule = ruleOf(raw);
    if (!rule) continue;
    const to = dayAtOrBefore(rule, today);
    if (!to || to <= raw.date) continue;
    const missed = Array.isArray(raw.repeat.missed) ? raw.repeat.missed.filter(isYmd) : [];
    for (let d = raw.date; d && d < to; d = nextDay(rule, d)) if (!missed.includes(d)) missed.push(d);
    const from = raw.date;
    setKey(raw, 'repeat', { ...raw.repeat, missed: missed.slice(-MISSED_MAX) });
    setKey(raw, 'date', to);
    list.splice(list.indexOf(raw), 1);
    insertItem(list, raw);
    out.push({ id: raw.id, from, to });
  }
  return out;
}

// ---------- two computers' steps of one series (merge.mjs runs this before it merges item by item) ----------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const without = (x, ...keys) => {
  const c = { ...x };
  for (const k of keys) delete c[k];
  return c;
};
const repeating = (x) => isObj(x) && typeof x.id === 'string' && ruleOf(x) !== null;
/** `x` is `b` with only its date moved on (rollRepeats): a later date, more missed days, nothing else. */
const onlyMoved = (b, x) => repeating(x) && isYmd(b.date) && isYmd(x.date) && x.date > b.date && statusOf(x) === statusOf(b)
  && same(without(b, 'date', 'repeat'), without(x, 'date', 'repeat')) && same(without(b.repeat, 'missed'), without(x.repeat, 'missed'));
/** `x` is `b` closed (done or dropped). */
const closedFrom = (b, x) => isObj(x) && !CLOSED.has(statusOf(b)) && CLOSED.has(statusOf(x));
/** The open occurrence `id` of `doc` is exactly what a close in `doc` made on the day it was made: nothing of the owner's in it. */
function untouched(doc, id) {
  const cand = doc.items.find((x) => isObj(x) && x.id === id);
  if (!cand || !isYmd(cand.created)) return false;
  const series = seriesOf(cand);
  for (const c of doc.items) {
    if (!isObj(c) || c === cand || seriesOf(c) !== series || !CLOSED.has(statusOf(c))) continue;
    const made = nextOccurrence({ items: doc.items.filter((x) => x !== cand) }, c, cand.created);
    if (made && same(made, cand)) return true;
  }
  return false;
}

/**
 * Two computers that took repeat steps of one series on different days write items that differ (the day it was done,
 * the day the next one was made, how far the date moved on), so a merge item by item would ask the owner, or keep two
 * open occurrences. These steps carry nothing of the owner's, so they are brought together here, the same on every
 * computer: both closed the occurrence: one close (the server's); one closed it and the other only moved its date on:
 * the close (and the next occurrence it made); both only moved the date: the later date, with the missed days of both;
 * both made an open occurrence of the series: one, the one the owner changed, else the server's. Anything else is left
 * to the merge. → { mine, theirs }: copies, with those items made the same.
 */
export function mergeSeries(baseDoc, mineDoc, theirsDoc) {
  const mine = structuredClone(mineDoc);
  const theirs = structuredClone(theirsDoc);
  const lists = [baseDoc, mine, theirs].map((d) => (isObj(d) && Array.isArray(d.items) ? d.items : []));
  if (lists.slice(1).some((l, i) => l !== [mine, theirs][i].items)) return { mine, theirs };
  const [B, M, T] = lists;
  const doubled = new Set();
  for (const l of lists) {
    const seen = new Set();
    for (const x of l) if (isObj(x) && typeof x.id === 'string') (seen.has(x.id) ? doubled : seen).add(x.id);
  }
  const at = (l, id) => (doubled.has(id) ? -1 : l.findIndex((x) => isObj(x) && x.id === id));
  for (const b of B) {
    if (!repeating(b) || doubled.has(b.id)) continue;
    const mi = at(M, b.id);
    const ti = at(T, b.id);
    if (mi < 0 || ti < 0) continue;
    const [m, t] = [M[mi], T[ti]];
    if (same(m, t) || same(m, b) || same(t, b)) continue;
    if (closedFrom(b, m) && closedFrom(b, t) && same(without(m, 'doneAt'), without(t, 'doneAt'))) M[mi] = t;
    else if (closedFrom(b, m) && onlyMoved(b, t)) T[ti] = m;
    else if (closedFrom(b, t) && onlyMoved(b, m)) M[mi] = t;
    else if (onlyMoved(b, m) && onlyMoved(b, t)) {
      const later = m.date > t.date ? m : t;
      const missed = [...new Set([m, t].flatMap((x) => (Array.isArray(x.repeat.missed) ? x.repeat.missed.filter(isYmd) : [])))].filter((d) => d < later.date).sort().slice(-MISSED_MAX);
      const v = structuredClone(later);
      v.repeat = { ...later.repeat, missed };
      M[mi] = v;
      T[ti] = structuredClone(v);
    }
  }
  const inBase = new Set(B.filter(isObj).map((x) => x.id));
  const added = (l) => l.filter((x) => repeating(x) && !inBase.has(x.id) && !doubled.has(x.id) && seriesOf(x) !== x.id && !CLOSED.has(statusOf(x)));
  for (const m of added(M)) {
    const t = added(T).find((x) => seriesOf(x) === seriesOf(m));
    if (!t || same(m, t)) continue;
    if (untouched(mineDoc, m.id)) {
      if (m.id === t.id) M[M.indexOf(m)] = t;
      else M.splice(M.indexOf(m), 1);
    } else if (untouched(theirsDoc, t.id)) {
      if (m.id === t.id) T[T.indexOf(t)] = m;
      else T.splice(T.indexOf(t), 1);
    }
  }
  return { mine, theirs };
}

/** A rule in plain words: "every day", "every Monday and Thursday", "every month on the 31st (the last day in a shorter month)". */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const nth = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
export function repeatText(rule) {
  if (!rule) return '';
  if (rule.kind === 'daily') return 'every day';
  if (rule.kind === 'weekly') {
    const names = rule.days.map((d) => DAY_NAMES[d]);
    if (rule.days.join() === '1,2,3,4,5') return 'every weekday';
    return `every ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}`;
  }
  return `every month on the ${nth(rule.day)}${rule.day > 28 ? ' (the last day in a shorter month)' : ''}`;
}
