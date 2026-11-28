// How a plan step is really taken back. A row that claims an undo (acts.json "undo") is taken back in a PLAN only when it has
// an entry here: the act that does it, and how that act's own values are made from what the first act had (its own args and
// its answer). Every value is the card's own: the door binds the back act to the card's step, so no other request passes.
// A row without an entry is shown on the plan card as one that cannot be taken back, before the person taps.
import { rowById } from './catalog.mjs';

/** act id -> { act: the act that takes it back, args(args, answer): its values, or null when they cannot be made }. */
export const INVERSE = Object.freeze({
  // Going live is taken back by the project's own back act, for the same project (design example 6).
  'ship.p.live': Object.freeze({ act: 'ship.p.back', args: (a) => (typeof a.target === 'string' ? { target: a.target } : null) }),
});

/** { act, args } that takes back one run of `row` made with `args` (the step's args without computer) and answering `answer`, or null. */
export function inverseOf(row, args, answer) {
  const inv = row && INVERSE[row.id];
  if (!inv) return null;
  const made = inv.args(args && typeof args === 'object' ? args : {}, answer);
  return made && rowById(inv.act) ? { act: inv.act, args: made } : null;
}

/** The row that takes `row` back in a plan, or null. */
export const backRowOf = (row) => (row && INVERSE[row.id] ? rowById(INVERSE[row.id].act) : null);

/**
 * What the rows that claim an undo really have: `real` (an inverse for plans), `byTool` (her own tool records the way back, so
 * done alone it is undone from Activity), `none` (a claim with nothing behind it).
 */
export function backCensus(rows) {
  const claims = rows.filter((r) => r.undo);
  const real = claims.filter((r) => INVERSE[r.id]).map((r) => r.id);
  const byTool = claims.filter((r) => !INVERSE[r.id] && r.tool && r.tool.name).map((r) => r.id);
  const none = claims.filter((r) => !INVERSE[r.id] && !(r.tool && r.tool.name)).map((r) => r.id);
  return { claims: claims.length, real, byTool, none };
}
