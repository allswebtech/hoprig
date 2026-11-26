// "Start new work on <name> until this computer is calm": the Operator's act on the overload item (detect/machine.mjs),
// tapped by the owner or done by his rule "When this computer is overloaded, start new work where there is room".
// It holds only Tia's NEW starts (src/assistant/where-start.mjs sends them to that computer); nothing that runs is
// moved, paused or ended.
//
// <state>/operator/elsewhere.json  { to, label, since, calmSince, by }  kept across a restart. It ends by itself once this
// computer has been calm (not busy, not full) for CALM_MS, and at the latest HOLD_MAX_MS after it began; Undo ends it
// at once. A file that cannot be read, or a start time in the future (the clock was set back), ends it.

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { replaceFile } from '../replacefile.mjs';

export const CALM_MS = 10 * 60_000;
export const HOLD_MAX_MS = 2 * 3600_000;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const file = () => path.join(stateDir(), 'operator', 'elsewhere.json');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** The hold after one more look: `calm` true / false (this computer's room now), or null (not known: unchanged). */
export function stepElsewhere(h, { calm = null, now }) {
  if (!h) return null;
  if (now - h.since < 0 || now - h.since >= HOLD_MAX_MS) return null;
  if (calm === true) {
    const since = isNum(h.calmSince) && h.calmSince <= now ? h.calmSince : now;
    return now - since >= CALM_MS ? null : { ...h, calmSince: since };
  }
  if (calm === false) return { ...h, calmSince: null };
  return h;
}

function readRaw() {
  try {
    const h = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!h || typeof h.to !== 'string' || !NAME.test(h.to) || !isNum(h.since)) return null;
    return { to: h.to, label: typeof h.label === 'string' ? h.label.slice(0, 40) : h.to, since: h.since, calmSince: isNum(h.calmSince) ? h.calmSince : null, by: h.by === 'tia' ? 'tia' : 'owner' };
  } catch {
    return null;
  }
}
function write(h) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h));
  replaceFile(tmp, file());
}
export const endElsewhere = () => fs.rmSync(file(), { force: true });

/**
 * The hold that stands now, or null (one that has run out is removed). `computers`: Settings → Tia's list, when the
 * caller has it: a hold on a computer he no longer lets her use has lost its reason and is removed too.
 */
export function readElsewhere(now = Date.now(), { computers } = {}) {
  if (!fs.existsSync(file())) return null;
  let h = stepElsewhere(readRaw(), { now });
  if (h && computers !== undefined && !(Array.isArray(computers) && computers.includes(h.to))) h = null;
  if (!h) endElsewhere();
  return h;
}

/** `by`: 'owner' (his tap) or 'tia' (his rule did it): Tia OFF ends only hers. */
export function setElsewhere(to, label, now = Date.now(), by = 'owner') {
  if (typeof to !== 'string' || !NAME.test(to)) throw new Error('not a computer of the main computer');
  const h = { to, label: String(label || to).slice(0, 40), since: now, calmSince: null, by: by === 'tia' ? 'tia' : 'owner' };
  write(h);
  return h;
}

/** This computer's room was read now: calm or not. Writes only while a hold stands and its calm stretch changed. */
export function noteCalm(calm, now = Date.now()) {
  const h = readElsewhere(now);
  if (!h) return null;
  const next = stepElsewhere(h, { calm, now });
  if (!next) endElsewhere();
  else if (next.calmSince !== h.calmSince) write(next);
  return next;
}

/**
 * What the overload item offers (board extra): the allowed computer with the most room (`elsewhere`: { name, label }),
 * only when he chose computers for Tia (assistant.computers) and no such hold stands; `elsewhereHeld`: the one that
 * stands. `view`: the rooms (rooms.mjs view).
 */
export function elsewhereOf({ view, computers, held = null }) {
  if (held) return { elsewhere: null, elsewhereHeld: { to: held.to, label: held.label, since: new Date(held.since).toISOString() } };
  if (!Array.isArray(computers) || !computers.length) return { elsewhere: null, elsewhereHeld: null };
  const per = (c) => (c.cpus && c.load1 != null ? c.load1 / c.cpus : Infinity);
  const best = ((view && view.computers) || []).filter((c) => !c.here && computers.includes(c.name) && c.room === 'free').sort((a, b) => per(a) - per(b))[0];
  return { elsewhere: best ? { name: best.name, label: best.label || best.name } : null, elsewhereHeld: null };
}
