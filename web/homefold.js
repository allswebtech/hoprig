// Home's fold (home.js): the sessions under "Finished" that have waited for more than 6 hours
// stand under one line, so the ones of the last hours are not lost in a long row of work that finished long ago.
// Nothing here ends a session: ending them is the owner's own press in the sheet of closesheet.js.
import { span, stateOf } from './lib.js';

export const FOLD_AFTER_MS = 6 * 3600_000;
// The states of Home's group "Finished" (home.js GROUPS): finished (waiting) and ended.
const WAITS = ['waiting', 'ended'];

/** Since when the session has been in its state (ms): its state time, else its last activity; 0 when not known. */
export const waitedSince = (s) => Number(s && (s.statusAt || s.activity)) || 0;
/** Something on its card asks him or shows him an act (a question, a notice, a held act). */
export const hasCard = (s) => Boolean(s && (s.ask || s.askCard || s.held));
/** A command of its own still runs in the background (the run record's bgCommands): it may go on by itself. */
export const runsInBackground = (s) => Number(s && s.bgCommands) > 0;

/**
 * The fold's rule: a session of the waiting group whose state is older than 6 hours. Never one with a command still
 * running in the background or with a card, and never one whose age is not known.
 */
export function foldsAway(s, now = Date.now()) {
  if (!s || !WAITS.includes(stateOf(s).key)) return false;
  if (runsInBackground(s) || hasCard(s)) return false;
  const since = waitedSince(s);
  return since > 0 && now - since > FOLD_AFTER_MS;
}

/** The waiting group split in two: { recent, old }, the old ones newest first. */
export function splitWaiting(list, now = Date.now()) {
  const recent = [];
  const old = [];
  for (const s of list) (foldsAway(s, now) ? old : recent).push(s);
  old.sort((a, b) => waitedSince(b) - waitedSince(a));
  return { recent, old };
}

/** The fold's line: "Ready for more than 6 hours: 12" (the group is Ready). */
export const foldLine = (n) => `Ready for more than 6 hours: ${n}`;

/** How long it has waited, in the unit the card's "1 day ago" uses (lib.js span): "7 h", "1 day". */
export function waitedFor(s, now = Date.now()) {
  const since = waitedSince(s);
  return since ? span(now - since) : '';
}
