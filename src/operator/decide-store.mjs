// "Tia decides": the owner's switch and budgets (config.json, operator.decide), his standing notes per project
// (operator.notes), and the record of the decisions (<state>/operator/decisions.json) with its own lock.
//
//   operator.decide  { on, missions, perHour, perDay, tokensPerDay, missionsPerDay, model }   off unless on is exactly
//                    true; `missions`: a mission's choices go through her decisions too (off unless exactly true)
//   operator.notes   { "<project ref>": "<his words, at most NOTE_MAX characters>" }
//   operator.mayEnd  { "<project ref>": true }   his tick "Tia may end a stuck session in this project": exactly true is
//                    on; absent (every config written before the tick) or anything else is off
//   decisions.json   { v, calls: [{ at, tokens, item, rev, pick, notDone?, mission? }], seen: { item: rev }, nudged: { session: since },
//                      told: { key: at }, frozenUntil, answers: { item: { rev, pick } } (a mission's choice decided once per rev) }
//   hold.json        { owner, tia, at }   "start nothing new": each setter's own end time (his tap, her decision);
//                    the dashboard's starts read the later one (heldUntil)
//
// Missing means nothing was decided. Broken means it is set aside and no call is made for a day. A time later than now
// counts as now, so a clock set back frees no budget.

import fs from 'node:fs';
import path from 'node:path';
import { cleanInput } from '../assistant/fence.mjs';
import { stateDir } from '../paths.mjs';
import { familyOf } from '../models/tiers.mjs';
import { replaceFile } from '../replacefile.mjs';

/** A decision as counted when its provider reports no usage: above the largest measured on the cheapest model (540
 * calls: 3,434 tokens on average, 3,716 at most; Claude Code adds its own parts to the prompt). */
export const CALL_TOKENS = 4100;
// missionsPerDay: of the decisions a day, at most this many about a mission's choices (its own count, inside perDay).
export const DECIDE_DEFAULTS = Object.freeze({ perHour: 6, perDay: 30, tokensPerDay: 125_000, missionsPerDay: 10 });
export const DECIDE_LIMITS = Object.freeze({ perHour: [1, 60], perDay: [1, 500], tokensPerDay: [1000, 1_000_000], missionsPerDay: [1, 200] });
const WORDS = { perHour: 'Decisions an hour', perDay: 'Decisions a day', tokensPerDay: 'Tokens a day', missionsPerDay: 'Mission decisions a day' };
export const NOTE_MAX = 500;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
// A decision picks one id: only a small model does it, of the fast or the middle family (haiku, sonnet) as the
// product reads a family from a model's id everywhere (src/models/tiers.mjs familyOf: claude-haiku-5-5,
// claude-3-5-haiku, us.anthropic.claude-haiku-4-5-20251001-v1:0, sonnet[1m]). A name that holds two families is no
// family; a stronger family's name anywhere in it refuses it, so a strongest model is a look's only (look.mjs).
const STRONGER = /opus|fable|mythos/i;
const SMALL = { test: (m) => ['haiku', 'sonnet'].includes(familyOf({ id: m })) && !STRONGER.test(m) };
const DAY_MS = 24 * 3600_000;
const LOCK_STALE_MS = 2 * 60_000;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const inRange = (k, v) => Number.isInteger(v) && v >= DECIDE_LIMITS[k][0] && v <= DECIDE_LIMITS[k][1];

/** The switch as it applies now: missing or broken is off, a broken budget is its default. */
export function readDecide(cfg) {
  const raw = isObj(cfg?.operator) && isObj(cfg.operator.decide) ? cfg.operator.decide : {};
  const ok = typeof raw.model === 'string' && MODEL_RE.test(raw.model) && SMALL.test(raw.model);
  // A saved model that is refused is said (modelRefused, on the page), never put in its place without a word.
  const refused = !ok && typeof raw.model === 'string' && raw.model ? raw.model.replace(/[^A-Za-z0-9._:[\]-]/g, '').slice(0, 64) || '?' : null;
  const out = { on: raw.on === true, missions: raw.missions === true, model: ok ? raw.model : null, modelRefused: refused };
  for (const [k, d] of Object.entries(DECIDE_DEFAULTS)) out[k] = inRange(k, raw[k]) ? raw[k] : d;
  return out;
}

/** The owner's change of the switch, budgets or model, checked → the new operator.decide. Throws a plain Error. */
export function applyDecidePatch(cfg, p) {
  if (!isObj(p)) throw new Error('send an object');
  const cur = isObj(cfg?.operator) && isObj(cfg.operator.decide) ? cfg.operator.decide : {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'on' || k === 'missions') {
      if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
      next[k] = v;
    } else if (k === 'model') {
      if (v !== null && v !== '' && (typeof v !== 'string' || !MODEL_RE.test(v))) throw new Error('the model is a name like haiku, or empty for the cheapest');
      if (typeof v === 'string' && v && !SMALL.test(v)) throw new Error(`"${v}" is not a model of the haiku or sonnet family: a decision uses a small model (a stronger one is for a look only)`);
      next.model = v || null;
    } else if (DECIDE_DEFAULTS[k] !== undefined) {
      if (!inRange(k, v)) throw new Error(`"${WORDS[k]}" must be a whole number from ${DECIDE_LIMITS[k][0]} to ${DECIDE_LIMITS[k][1]}`);
      next[k] = v;
    } else throw new Error(`"${String(k).slice(0, 40)}" is not a setting of "Tia decides"`);
  }
  return next;
}

/** His note, cleaned as Tia's input is cleaned (no characters nobody can see) → { note, changed }. Throws when too long. */
export function cleanNote(text) {
  if (typeof text !== 'string') throw new Error('the note is text');
  const { value, changed } = cleanInput(text);
  const note = value.replace(/[ \t]+/g, ' ').trim();
  if (note.length > NOTE_MAX) throw new Error(`the note is at most ${NOTE_MAX} characters (it has ${note.length})`);
  return { note, changed };
}

/** His standing note for project `ref`, or ''. Cleaned again on reading: a note written into the file by hand counts too. */
export function noteFor(cfg, ref) {
  const all = isObj(cfg?.operator) && isObj(cfg.operator.notes) ? cfg.operator.notes : {};
  const raw = typeof ref === 'string' && typeof all[ref] === 'string' ? all[ref] : '';
  try {
    return cleanNote(raw).note;
  } catch {
    return cleanNote(raw.slice(0, NOTE_MAX)).note.slice(0, NOTE_MAX);
  }
}

/** The item's line when stop needs his tick (a decision left it to him, or the door refused it). */
export const TICK_LINE = 'Ending this session needs the tick "Tia may end a stuck session in this project" on its project page: it is yours';

/** His tick for project `ref`: true only when he ticked it. A note alone never allows her to end a session. */
export function mayEndFor(cfg, ref) {
  const all = isObj(cfg?.operator) && isObj(cfg.operator.mayEnd) ? cfg.operator.mayEnd : {};
  return typeof ref === 'string' && Object.hasOwn(all, ref) && all[ref] === true;
}

const empty = () => ({ v: 1, calls: [], seen: {}, nudged: {}, told: {}, frozenUntil: null, answers: {} });
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function valid(d) {
  return isObj(d) && d.v === 1 && Array.isArray(d.calls) && d.calls.every((c) => isObj(c) && num(c.at) != null && num(c.tokens) != null)
    && isObj(d.seen) && isObj(d.nudged) && isObj(d.told) && Object.values(d.told).every((t) => num(t) != null) && (d.frozenUntil === null || num(d.frozenUntil) != null);
}

/** The record of decisions, read and written only while its lock is held. */
export function decideStore({ dir = () => path.join(stateDir(), 'operator'), now = Date.now } = {}) {
  const file = () => path.join(dir(), 'decisions.json');
  const lockFile = () => path.join(dir(), 'decide.lock');
  const write = (d) => {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    replaceFile(tmp, file());
  };
  const normal = (d) => {
    const t = now();
    const c = (x) => Math.min(x, t);
    return {
      v: 1,
      calls: d.calls.map((x) => ({ ...x, at: c(x.at) })).filter((x) => t - x.at < DAY_MS).slice(-1000),
      seen: d.seen,
      nudged: d.nudged,
      told: Object.fromEntries(Object.entries(d.told).map(([k, x]) => [k, c(x)]).filter(([, x]) => t - x < DAY_MS)),
      frozenUntil: d.frozenUntil == null ? null : Math.min(d.frozenUntil, t + DAY_MS),
      // A mission's choice decided for one picture of it (its rev): the same picture is not asked again. Only the pick.
      answers: Object.fromEntries(Object.entries(isObj(d.answers) ? d.answers : {}).filter(([, a]) => isObj(a) && typeof a.rev === 'string' && typeof a.pick === 'string' && num(a.at) != null && t - a.at < DAY_MS).slice(-200)),
    };
  };
  /** { data, broken } */
  function read() {
    let text = null;
    try {
      text = fs.readFileSync(file(), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { data: empty(), broken: false };
    }
    try {
      const d = text == null ? null : JSON.parse(text);
      if (valid(d)) return { data: normal(d), broken: false };
    } catch {
      /* broken: below */
    }
    try {
      fs.renameSync(file(), `${file()}.broken-${Date.now()}`);
    } catch {
      fs.rmSync(file(), { recursive: true, force: true });
    }
    const d = empty();
    d.frozenUntil = now() + DAY_MS;
    write(d);
    return { data: d, broken: true };
  }
  const peek = () => {
    try {
      const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
      return valid(d) ? normal(d) : null;
    } catch {
      return null;
    }
  };
  const take = () => {
    try {
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(lockFile(), `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  };
  // As record.mjs: a stale lock is renamed aside, not removed, and put back when it turns out fresh, so two dashboards
  // that both saw it stale never both hold it (one would remove the lock the other had just taken).
  const fresh = (f) => Math.abs(Date.now() - fs.statSync(f).mtimeMs) <= LOCK_STALE_MS;
  function lock() {
    if (take()) return true;
    try {
      if (fresh(lockFile())) return false;
      const aside = `${lockFile()}.${process.pid}.stale`;
      fs.renameSync(lockFile(), aside);
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
  const touch = () => {
    try {
      fs.utimesSync(lockFile(), new Date(), new Date());
    } catch {
      /* gone: the decision ends soon */
    }
  };
  return { read, peek, write, lock, unlock, touch, file };
}

/** What a day and an hour of decisions used, from the record's calls. */
export function used(data, t) {
  const calls = data?.calls || [];
  const hour = calls.filter((c) => t - c.at < 3600_000).length;
  return { hour, day: calls.length, tokens: calls.reduce((n, c) => n + (c.tokens || 0), 0), missions: calls.filter((c) => c.mission === true).length };
}

// ---- the hold: "start nothing new for N minutes" ----
// Each setter keeps its own end: his tap and her decision never overwrite each other, so Tia OFF can lift hers and
// leave his. A file of the older shape ({ until, by }) is read as that one setter's (no `by`: hers).
const holdFile = () => path.join(stateDir(), 'operator', 'hold.json');
const SETTERS = ['owner', 'tia'];

/** { owner, tia }: each setter's end time, or null when that one holds nothing now (each at most a day from now). */
function holds(now = Date.now()) {
  const out = { owner: null, tia: null };
  let h;
  try {
    h = JSON.parse(fs.readFileSync(holdFile(), 'utf8'));
  } catch {
    return out;
  }
  if (!isObj(h)) return out;
  const old = num(h.until) != null && h.owner === undefined && h.tia === undefined;
  for (const who of SETTERS) {
    const until = old ? (who === (h.by === 'owner' ? 'owner' : 'tia') ? num(h.until) : null) : num(h[who]);
    out[who] = until != null && until > now ? Math.min(until, now + DAY_MS) : null;
  }
  return out;
}
function writeHolds(h, now) {
  if (h.owner == null && h.tia == null) return fs.rmSync(holdFile(), { force: true });
  fs.mkdirSync(path.dirname(holdFile()), { recursive: true });
  const tmp = `${holdFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ owner: h.owner, tia: h.tia, at: now }));
  replaceFile(tmp, holdFile());
}

/** The time the hold ends (the later of his and hers), or null when none holds now. */
export function heldUntil(now = Date.now()) {
  const h = holds(now);
  const t = Math.max(h.owner ?? -1, h.tia ?? -1);
  return t > now ? t : null;
}
/** Who holds new starts now: 'owner', 'tia', 'both' or null. */
export function heldBy(now = Date.now()) {
  const h = holds(now);
  return h.owner != null && h.tia != null ? 'both' : h.owner != null ? 'owner' : h.tia != null ? 'tia' : null;
}
/** `by`: 'owner' for his own tap, anything else is hers. Only that setter's own end changes. */
export function setHold(until, now = Date.now(), by = 'tia') {
  const h = holds(now);
  h[by === 'owner' ? 'owner' : 'tia'] = until;
  writeHolds(h, now);
}
/** `who`: 'tia' lifts only her own hold (Tia OFF); no argument lifts every hold (his "Lift the hold"). */
export function liftHold(who = null, now = Date.now()) {
  if (who !== 'tia') return fs.rmSync(holdFile(), { force: true });
  const h = holds(now);
  h.tia = null;
  writeHolds(h, now);
}

/** The one line a start refused by a hold says, naming whose hold it is. */
export const holdWords = (until, now = Date.now(), by = heldBy(now)) => {
  const min = `for about ${Math.max(1, Math.ceil((until - now) / 60_000))} min more`;
  const lift = 'Lift the hold in Settings → Tia to start now.';
  if (by === 'owner') return `You hold new starts ${min}. ${lift}`;
  if (by === 'both') return `You and Tia hold new starts ${min} (hers because the computer is overloaded). ${lift}`;
  return `Tia holds new starts ${min}, because the computer is overloaded. ${lift}`;
};

/**
 * A start refused by a hold, as a route answers it: 409 with holdWords, and the code of the Operator page (the one
 * table of places, web/errorways.js) so the page draws the button to where the hold is lifted.
 */
export const heldError = (until, now = Date.now()) => Object.assign(new Error(holdWords(until, now)), { status: 409, details: { code: 'operator-page' } });
