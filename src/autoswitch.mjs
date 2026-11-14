// Auto-switch: when the profile a session runs on reaches its usage limit, the same session goes on under the
// next profile, by itself. This file holds the settings, the memory of which profile is at its limit until
// when, and the choice of the next profile. The launcher (launch.mjs) and the dashboard both use it.
//
// config.json, key "autoSwitch":
//   enabled            false by default: moving to an API profile costs money, so the owner turns it on
//   order              profile names, most preferred first, e.g. ["sub", "sub2", "api"]. Only profiles in this
//                      list are ever chosen automatically.
//   returnToPreferred  when a session runs on a later profile and an earlier one is available again, move it back
//                      at the end of the current reply
//   prompt             what is typed after a switch so Claude carries on with the interrupted work
//   cooldownMinutes    how long a profile counts as "at its limit" when the reset time is not known
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.mjs';
import { stateDir } from './paths.mjs';
import { listProfiles, validName } from './profiles.mjs';

export const DEFAULTS = {
  enabled: false,
  order: [],
  returnToPreferred: false,
  prompt: 'Continue from where you stopped.',
  cooldownMinutes: 300, // the longest short window Claude plans have is five hours
};

export function getAutoSwitch() {
  const raw = loadConfig().autoSwitch;
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cooldown = Number(a.cooldownMinutes);
  return {
    enabled: a.enabled === true,
    order: Array.isArray(a.order) ? [...new Set(a.order.filter(validName))] : [],
    returnToPreferred: a.returnToPreferred === true,
    prompt: typeof a.prompt === 'string' && a.prompt.trim() ? a.prompt.trim().slice(0, 500) : DEFAULTS.prompt,
    cooldownMinutes: Number.isFinite(cooldown) && cooldown >= 1 && cooldown <= 7 * 24 * 60 ? cooldown : DEFAULTS.cooldownMinutes,
  };
}

/** Change some of the settings. Unknown profile names in `order` are refused, so a typo cannot hide a profile. */
export function setAutoSwitch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('auto-switch settings must be an object');
  const next = { ...getAutoSwitch() };
  if ('enabled' in patch) next.enabled = patch.enabled === true;
  if ('returnToPreferred' in patch) next.returnToPreferred = patch.returnToPreferred === true;
  if ('order' in patch) {
    if (!Array.isArray(patch.order)) throw new Error('"order" must be a list of profile names');
    const known = new Set(listProfiles().map((p) => p.name));
    for (const n of patch.order) if (!known.has(n)) throw new Error(`there is no profile "${n}"`);
    next.order = [...new Set(patch.order)];
  }
  if ('prompt' in patch) {
    if (typeof patch.prompt !== 'string' || !patch.prompt.trim() || /[\r\n]/.test(patch.prompt) || patch.prompt.length > 500) {
      throw new Error('"prompt" must be one line of at most 500 characters');
    }
    next.prompt = patch.prompt.trim();
  }
  if ('cooldownMinutes' in patch) {
    const c = Number(patch.cooldownMinutes);
    if (!Number.isFinite(c) || c < 1 || c > 7 * 24 * 60) throw new Error('"cooldownMinutes" must be between 1 and 10080');
    next.cooldownMinutes = c;
  }
  saveConfig({ autoSwitch: next });
  return next;
}

// ---- which profile is at its limit, and until when ----

const limitsFile = () => path.join(stateDir(), 'limits.json');

function readLimits() {
  try {
    const data = JSON.parse(fs.readFileSync(limitsFile(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeLimits(data) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = `${limitsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, limitsFile());
}

/** Profiles that are at their limit right now: { name: { at, until, reason, text } }. Expired entries are dropped. */
export function limitedProfiles(now = Date.now()) {
  const out = {};
  for (const [name, l] of Object.entries(readLimits())) {
    if (l && Number.isFinite(l.until) && l.until > now) out[name] = l;
  }
  return out;
}

/**
 * Remember that `name` reached its limit. `until` (epoch ms) is when it is usable again; when it is not known the
 * cooldown from the settings applies. `text` is the line Claude Code showed, for display.
 */
export function markLimited(name, { until = null, reason = 'limit', text = '' } = {}, now = Date.now()) {
  if (!validName(name)) return null;
  const good = Number.isFinite(until) && until > now && until < now + 8 * 24 * 3600 * 1000;
  const entry = {
    at: now,
    until: good ? until : now + getAutoSwitch().cooldownMinutes * 60_000,
    reason: String(reason).slice(0, 40),
    text: String(text || '').slice(0, 300),
    exact: good, // false: the end is our estimate, not what Claude Code said
  };
  writeLimits({ ...limitedProfiles(now), [name]: entry });
  return entry;
}

export function clearLimited(name) {
  const all = limitedProfiles();
  if (!(name in all)) return false;
  delete all[name];
  writeLimits(all);
  return true;
}

// ---- choosing ----

function usableOrder() {
  const known = new Set(listProfiles().map((p) => p.name));
  return getAutoSwitch().order.filter((n) => known.has(n));
}

/**
 * The profile to continue on when `current` is at its limit: the next one in the order after `current` (going
 * round), skipping profiles that are themselves at their limit. null when there is none.
 */
export function nextProfile(current, now = Date.now()) {
  const order = usableOrder();
  if (!order.length) return null;
  const limited = limitedProfiles(now);
  const i = order.indexOf(current);
  const ring = i < 0 ? order : [...order.slice(i + 1), ...order.slice(0, i)];
  return ring.find((n) => n !== current && !(n in limited)) || null;
}

/** A profile that comes before `current` in the order and is not at its limit, or null. */
export function preferredAvailable(current, now = Date.now()) {
  const order = usableOrder();
  const i = order.indexOf(current);
  if (i <= 0) return null;
  const limited = limitedProfiles(now);
  return order.slice(0, i).find((n) => !(n in limited)) || null;
}

/** The profile to offer first for a new session: the first in the order that is not at its limit. */
export function recommendedProfile(now = Date.now()) {
  const limited = limitedProfiles(now);
  return usableOrder().find((n) => !(n in limited)) || null;
}

// ---- reading "resets 5pm (Europe/Berlin)" ----

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The wall-clock parts of the instant `ms` in time zone `tz`.
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

// The instant at which the clock in `tz` shows the given wall-clock time.
function instantOf({ y, mo, d, h, mi }, tz) {
  let guess = Date.UTC(y, mo, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, tz);
    const shown = Date.UTC(p.y, p.mo, p.d, p.h, p.mi);
    const diff = Date.UTC(y, mo, d, h, mi) - shown;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

/**
 * When a limit message says it resets, as epoch ms; null when the text does not say or cannot be read. Handles the
 * forms Claude Code prints: "resets 5pm", "resets 5:30pm (Europe/Berlin)", "resets at 9am", "resets Nov 18, 9am (UTC)".
 */
export function parseResets(text, now = Date.now()) {
  if (typeof text !== 'string') return null;
  const m = /resets\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]{1,60})\))?/i.exec(text);
  if (!m) return null;
  let tz = m[6] ? m[6].trim() : Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') h += 12;
  const mi = m[4] ? Number(m[4]) : 0;
  if (Number(m[3]) < 1 || Number(m[3]) > 12 || mi > 59) return null;
  const today = partsIn(now, tz);
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    const d = Number(m[2]);
    if (mo < 0 || d < 1 || d > 31) return null;
    let t = instantOf({ y: today.y, mo, d, h, mi }, tz);
    if (t < now - 24 * 3600 * 1000) t = instantOf({ y: today.y + 1, mo, d, h, mi }, tz); // "Jan 2" read in December
    return t > now ? t : null;
  }
  let t = instantOf({ y: today.y, mo: today.mo, d: today.d, h, mi }, tz);
  if (t <= now) t = instantOf({ y: today.y, mo: today.mo, d: today.d + 1, h, mi }, tz);
  return t;
}
