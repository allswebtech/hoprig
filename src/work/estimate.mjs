// How long a piece of work will take, ONLY from what was measured here: the time the last finished ones of the same
// kind took. No model writes or changes a number; with fewer than two finished ones there is no estimate, and the
// basis (how many like it) is always said with the number.
//
//   a kind      a Work run: its project and its kind of work (mechanical, code, unknown_cause: read from the model and
//               effort the run had, as Tia's working rules pick them), else the project alone; a run a schedule started:
//               the schedule's id; a workflow of a coding tool: its name
//   the basis   the last ten `done` ones of that kind at most; a duration below zero or over seven days (a clock set
//               back, a lost end) does not count
//   the range   shortest to longest, rounded to five minutes: "about 5 h 30 to 8 h 30, from 4 like it"
//   running     "done by about 14:30 to 17:30" (the local time of the computer, or the zone of Work → Tasks → Work settings (at the foot)); past
//               the longest one: "longer than any like it (the longest took 2 h)", never a new number

export const BASIS_MAX = 10;
export const MIN_BASIS = 2;
export const DAY_MAX_MS = 7 * 86_400_000;
const STEP_MS = 5 * 60_000;
// The words of a row without a basis, short enough for a phone.
export const NO_ESTIMATE = 'no time estimate yet';

// The model and effort each kind of work starts with (src/assistant/worktool.mjs KIND_CHOICE): read back from a run.
const KINDS = [['mechanical', 'sonnet', 'low'], ['code', 'opus', 'medium'], ['unknown_cause', 'opus', 'high']];

/** The kind of work a run's model and effort say, or null. */
export function workKind(model, effort) {
  const m = String(model || '').toLowerCase();
  const k = KINDS.find(([, mm, e]) => m.startsWith(mm) && effort === e);
  return k ? k[0] : null;
}

/** The kind key of a Work run: its schedule's, or its project's with its kind of work. */
export function runKind(r) {
  if (r.schedule) return `schedule:${r.schedule}`;
  const k = workKind(r.model, r.effort);
  return `project:${r.project}${k ? `:${k}` : ''}`;
}

/** A duration in plain words: "45 min", "1 h", "5 h 30". */
export function durationText(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

const round5 = (ms) => Math.max(STEP_MS, Math.round(ms / STEP_MS) * STEP_MS);

/** A measured duration that counts: a number from 0 to seven days. */
export const counts = (ms) => Number.isFinite(ms) && ms >= 0 && ms <= DAY_MAX_MS;

/**
 * The basis of one kind: `finished` is [{ kind, ms, endedAt }] of the finished-well ones (any kinds, any order).
 * → { kind, count, shortestMs, longestMs (rounded, as the words say them), lo, hi (as measured), text } (count 0 or 1: text
 * says there is no estimate yet).
 */
export function basisOf(kind, finished) {
  const like = finished.filter((f) => f.kind === kind && counts(f.ms))
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
    .slice(0, BASIS_MAX);
  if (like.length < MIN_BASIS) return { kind, count: like.length, shortestMs: null, longestMs: null, text: NO_ESTIMATE };
  // The words are rounded to five minutes; the times and "longer than any" use what was measured (lo, hi).
  const lo = Math.min(...like.map((f) => f.ms));
  const hi = Math.max(...like.map((f) => f.ms));
  const shortestMs = round5(lo);
  const longestMs = round5(hi);
  const range = shortestMs === longestMs ? `about ${durationText(shortestMs)}` : `about ${durationText(shortestMs)} to ${durationText(longestMs)}`;
  return { kind, count: like.length, shortestMs, longestMs, lo, hi, text: `${range}, from ${like.length} like it` };
}

/** "14:30" in time zone `tz` ('' = this computer's). */
export function clockText(ms, tz = '') {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  }
}

/**
 * The estimate of a running one that started at `startedMs`, from `basis` (basisOf), at `nowMs`. → { text, doneFrom,
 * doneTo (ISO, UTC), past (true: longer than any like it) } or { text: NO_ESTIMATE } without a basis. A start in the
 * future (a clock set back) counts from now.
 */
export function etaOf(basis, startedMs, nowMs, tz = '') {
  if (!basis || basis.count < MIN_BASIS || !Number.isFinite(startedMs)) return { text: NO_ESTIMATE, doneFrom: null, doneTo: null, past: false };
  const lo = Number.isFinite(basis.lo) ? basis.lo : basis.shortestMs;
  const hi = Number.isFinite(basis.hi) ? basis.hi : basis.longestMs;
  const elapsed = Math.max(0, nowMs - startedMs);
  if (elapsed > hi) return { text: `longer than any like it (the longest took ${durationText(hi)})`, doneFrom: null, doneTo: null, past: true };
  const start = Math.min(startedMs, nowMs);
  const from = Math.max(nowMs, start + lo);
  const to = start + hi;
  const a = clockText(from, tz);
  const b = clockText(to, tz);
  return { text: a === b ? `done by about ${b}` : `done by about ${a} to ${b}`, doneFrom: new Date(from).toISOString(), doneTo: new Date(to).toISOString(), past: false };
}
