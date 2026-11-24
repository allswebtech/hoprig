// Where Tia starts new work: one computer and one clause of why, from the candidates and their facts. Pure: nothing
// here reads a computer, a file or the network.
//
//   chooseWhere({ candidates, named, placed, now }) → { computer, why }   (computer null: nowhere, the why says so)
//
// candidates: [{ name ('this' for this computer), label, here, allowed, room ('free' | 'busy' | 'full' | 'unknown'),
//   load1, cpus, at (when this dashboard received its answer), lacks (null, or one clause: "the project is not
//   there") }]. named: the computer he named in his words (the start tool's `computer`), or null. placed: [{ name, at }]
// the starts placed in the last minutes, each counted as one more load there until an answer of that computer received
// a minute or more after it (SHOWN_MS), so ten starts in one second spread instead of all landing on the one computer
// that said "free".
//
// The order (decided): the computer he names wins if she may use it; else this computer unless it is full; else the
// allowed candidate with the most room; a tie goes to this computer. A computer that lacks the project, a provider or
// the coding tool is never a candidate: its clause is said instead. A computer whose room is not known never has room.

import { LOAD_PER_CPU } from './detect/machine.mjs';

export const LOCAL = 'this';
/** A start placed on a computer counts there as one more load until its next answer, at most this long. */
export const PLACED_MS = 5 * 60_000;
/**
 * An answer shows a start only when it was received this long after it: the 1-minute load average rises over about a
 * minute, so a reading taken a second after a start (this computer is read at every start) does not show it yet.
 */
export const SHOWN_MS = 60_000;

/**
 * At most this many starts go to one other computer within PLACED_MS, whatever size it claims: a computer that says
 * it has 1024 processors at load 0 would otherwise take every start (each start adds 1/1024 to its load).
 */
export const PLACED_MAX = 3;

const RANK = { free: 0, busy: 1 };
const placedOn = (c, placed, now) => placed.filter((p) => p.name === c.name && now - p.at >= 0 && now - p.at < PLACED_MS).length;
const capped = (c, placed, now) => !c.here && placedOn(c, placed, now) >= PLACED_MAX;
const nameOf = (c) => (c.here ? 'this computer' : c.label || c.name);

/** Load per processor with the starts placed there since its answer counted in. */
function perCpu(c, placed, now) {
  const extra = placed.filter((p) => p.name === c.name && now - p.at >= 0 && now - p.at < PLACED_MS && !(Number.isFinite(c.at) && c.at - p.at >= SHOWN_MS)).length;
  const cpus = Number.isFinite(c.cpus) && c.cpus > 0 ? c.cpus : 1;
  return ((Number.isFinite(c.load1) ? c.load1 : 0) + extra) / cpus;
}

/** Full now: its word says so, or the starts placed on it took it above the detector's line. */
const fullNow = (c, placed, now) => c.room === 'full' || (c.room !== 'unknown' && perCpu(c, placed, now) > LOAD_PER_CPU);

export function chooseWhere({ candidates = [], named = null, placed = [], now = Date.now() } = {}) {
  const here = candidates.find((c) => c.here) || { name: LOCAL, here: true, allowed: true, room: 'unknown', lacks: null };
  if (named && named !== LOCAL) {
    const c = candidates.find((x) => x.name === named);
    if (!c) return { computer: null, why: `${named} is not one of your computers` };
    if (!c.allowed) return { computer: null, why: `you have not allowed her to start work on ${nameOf(c)} (Settings → Tia)` };
    if (c.lacks) return { computer: null, why: `${nameOf(c)} cannot take it: ${c.lacks}` };
    return { computer: c.name, why: `you named ${nameOf(c)}` };
  }
  if (named === LOCAL) return here.lacks ? { computer: null, why: `this computer cannot take it: ${here.lacks}` } : { computer: LOCAL, why: 'you named this computer' };
  const hereFull = fullNow(here, placed, now);
  // here.held: "Start new work on <name> until this computer is calm" stands; its room stays what it is, only the
  // choice goes to the held computer first.
  const hereHeld = here.held === true;
  if (!here.lacks && !hereFull && !hereHeld) return { computer: LOCAL, why: here.room === 'free' ? 'this computer has room' : here.room === 'busy' ? 'this computer is busy, not full' : 'this computer is not known to be full' };
  const others = candidates
    .filter((c) => !c.here && c.allowed && !c.lacks && (c.room === 'free' || c.room === 'busy') && !fullNow(c, placed, now) && !capped(c, placed, now))
    .sort((a, b) => RANK[a.room] - RANK[b.room] || perCpu(a, placed, now) - perCpu(b, placed, now));
  const best = others[0];
  const mine = here.lacks ? `this computer cannot take it (${here.lacks})` : hereFull ? 'this computer is full' : 'new work is held off this computer until it is calm';
  if (best) return { computer: best.name, why: `${mine} and ${nameOf(best)} ${best.room === 'free' ? 'has room' : 'is busy but not full'}` };
  // Nowhere better: this computer, as today, unless it cannot take the start at all.
  const why = whyNot(candidates.filter((c) => !c.here && c.allowed), (c) => capped(c, placed, now), hereFull);
  if (here.lacks) return { computer: null, why: `${mine}, and ${why}` };
  return { computer: LOCAL, why: hereFull ? `${mine}, but ${why}` : `${mine}, but ${why}, so it starts here` };
}

/** Why no allowed other computer took it, in one clause. */
function whyNot(list, isCapped = () => false, too = true) {
  if (!list.length) return 'you have allowed her no other computer';
  const lacking = list.find((c) => c.lacks);
  if (list.length === 1) {
    const c = list[0];
    return c.lacks ? `${nameOf(c)} cannot take it: ${c.lacks}` : c.room === 'unknown' ? `the room of ${nameOf(c)} is not known`
      : isCapped(c) ? `${nameOf(c)} got ${PLACED_MAX} new starts in the last 5 minutes` : `${nameOf(c)} is full${too ? ' too' : ''}`;
  }
  if (list.some(isCapped) && list.every((c) => c.lacks || c.room === 'unknown' || c.room === 'full' || isCapped(c))) return `your other computers are full or got ${PLACED_MAX} new starts in the last 5 minutes`;
  if (lacking && list.every((c) => c.lacks)) return `no other computer you allowed can take it (${nameOf(lacking)}: ${lacking.lacks})`;
  if (list.every((c) => c.lacks || c.room === 'unknown')) return 'the room of your other computers is not known';
  return 'your other computers are full or cannot take it';
}
