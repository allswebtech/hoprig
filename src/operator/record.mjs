// The record of what the rules did: <state>/operator/reflexes.json, its own file, written atomically (a new file, then
// a rename), read and changed only while this dashboard holds <state>/operator/reflex.lock. So two dashboards on one
// state folder never act at the same time, and one act per subject is ever in flight.
//
//   acts     [{ id, rule, item, subject, act, at, ok, result, move?: { session, from, to }, undone? }]   the last day
//   moves    [{ session, from, to, at }]   every move of a session by a rule or its Undo, the last day
//   stops    { "<rule>|<item>": at }      "Tia tried twice": the rule leaves that subject (24 h, or until he taps it)
//   told     { "<key>": at }              a refusal already written to the line (the same one is written once)
//   his      { "<item>": { rev, words, at } }   the last refusal of an item: the card says why it is his
//   pending  { "<rule>|<item>": { at, rule, item, subject, act } }   an act that started; cut off when still here
//   frozenUntil   after a broken record: no rule acts before this time
//
// Missing means nothing was done. Broken means it is set aside as reflexes.json.broken and no rule acts for 24 hours.
// A time later than now counts as now: a clock set back frees nothing.

import fs from 'node:fs';
import path from 'node:path';
import { replaceFile } from '../replacefile.mjs';

export const LOCK_STALE_MS = 2 * 60_000;
export const DAY_MS = 24 * 3600_000;

const empty = () => ({ v: 1, acts: [], moves: [], stops: {}, told: {}, his: {}, pending: {}, frozenUntil: null });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function valid(d) {
  return isObj(d) && d.v === 1 && Array.isArray(d.acts) && Array.isArray(d.moves) && isObj(d.stops) && isObj(d.told) && isObj(d.pending)
    && d.acts.every((a) => isObj(a) && num(a.at) != null && typeof a.rule === 'string' && typeof a.item === 'string')
    && d.moves.every((m) => isObj(m) && num(m.at) != null) && Object.values(d.stops).every((t) => num(t) != null)
    && Object.values(d.told).every((t) => num(t) != null) && isObj(d.his) && Object.values(d.his).every((h) => isObj(h) && num(h.at) != null) && Object.values(d.pending).every((p) => isObj(p) && num(p.at) != null)
    && (d.frozenUntil === null || num(d.frozenUntil) != null);
}

/** Every time in the record no later than `now`, and what is older than a day gone. */
function normal(d, now) {
  const c = (t) => Math.min(t, now);
  const fresh = (t) => now - c(t) < DAY_MS;
  return {
    v: 1,
    acts: d.acts.map((a) => ({ ...a, at: c(a.at) })).filter((a) => fresh(a.at)).slice(-500),
    moves: d.moves.map((m) => ({ ...m, at: c(m.at) })).filter((m) => fresh(m.at)).slice(-200),
    stops: Object.fromEntries(Object.entries(d.stops).map(([k, t]) => [k, c(t)]).filter(([, t]) => fresh(t))),
    told: Object.fromEntries(Object.entries(d.told).map(([k, t]) => [k, c(t)]).filter(([, t]) => fresh(t))),
    his: Object.fromEntries(Object.entries(d.his).map(([k, h]) => [k, { ...h, at: c(h.at) }]).filter(([, h]) => fresh(h.at))),
    pending: Object.fromEntries(Object.entries(d.pending).map(([k, p]) => [k, { ...p, at: c(p.at) }])),
    // A freeze set while the clock was ahead ends at most a day from now.
    frozenUntil: d.frozenUntil == null ? null : Math.min(d.frozenUntil, now + DAY_MS),
  };
}

export function record({ dir, now = Date.now }) {
  const file = () => path.join(dir(), 'reflexes.json');
  const lockFile = () => path.join(dir(), 'reflex.lock');

  function write(d) {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    replaceFile(tmp, file());
  }

  /** { data, broken }: the record as it applies now. A broken one is set aside and replaced by a frozen one. */
  function read() {
    // A record that cannot be read at all (a folder, no permission) is broken as well: set aside, one line, a freeze.
    // Thrown, it would make every round fail with no line while the page said she acts.
    let text = null;
    try {
      text = fs.readFileSync(file(), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { data: empty(), broken: false };
    }
    try {
      const d = text == null ? null : JSON.parse(text);
      if (valid(d)) return { data: normal(d, now()), broken: false };
    } catch {
      /* broken: below */
    }
    // An earlier record set aside is kept: the next one gets a name of its own.
    const aside = fs.existsSync(`${file()}.broken`) ? `${file()}.broken-${Date.now()}` : `${file()}.broken`;
    try {
      fs.renameSync(file(), aside);
    } catch {
      fs.rmSync(file(), { recursive: true, force: true }); // it cannot be kept: written over below
    }
    const d = empty();
    d.frozenUntil = now() + DAY_MS;
    write(d);
    return { data: d, broken: true };
  }

  /** Only for a look: the record without setting a broken one aside (that is the round's, under the lock). */
  function peek() {
    try {
      const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
      return valid(d) ? normal(d, now()) : null;
    } catch {
      return null;
    }
  }

  const take = () => {
    try {
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(lockFile(), `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  };
  // A lock is fresh only when it was touched within two minutes of now. One stamped further ahead was left by a
  // dashboard that died before the clock was set back (a live one touches it as it goes): it is stale too. (A lock
  // written this very millisecond reads a little ahead: a file's time has parts of a millisecond, Date.now() none.)
  const fresh = (file) => Math.abs(Date.now() - fs.statSync(file).mtimeMs) <= LOCK_STALE_MS;
  /** True when this dashboard now holds the lock. A lock older than two minutes was left by a dashboard that died. */
  function lock() {
    if (take()) return true;
    try {
      if (fresh(lockFile())) return false;
      const aside = `${lockFile()}.${process.pid}.stale`;
      fs.renameSync(lockFile(), aside);
      // Another dashboard may have taken it between the look and the rename: a fresh lock goes back.
      if (fresh(aside)) {
        fs.renameSync(aside, lockFile());
        return false;
      }
      fs.rmSync(aside, { force: true });
    } catch {
      return false;
    }
    return take();
  }
  const unlock = () => fs.rmSync(lockFile(), { force: true });
  // A long round keeps its lock fresh, so another dashboard never takes it for a dead one's.
  const touch = () => {
    try {
      fs.utimesSync(lockFile(), new Date(), new Date());
    } catch {
      /* the lock is gone: the round ends soon */
    }
  };
  const exists = () => fs.existsSync(file());

  return { read, peek, write, lock, unlock, touch, exists, file };
}
