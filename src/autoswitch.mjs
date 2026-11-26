// Auto-switch: when the profile a session runs on reaches its usage limit, the same session goes on under the
// next profile, by itself. This file holds the settings, the memory of which profile is at its limit until
// when, and the choice of the next profile. The launcher (launch.mjs) and the dashboard both use it.
//
// config.json, key "autoSwitch":
//   enabled            false by default: moving to an API profile costs money, so the owner turns it on
//   order              profile names, most preferred first, e.g. ["sub", "sub2", "api"]. Only profiles in this
//                      list are ever chosen automatically.
//   payPerUse          "also use pay-per-use providers" (profiles.mjs isPayPerUse), and a stored sign-in billed by use
//                      (routerstate.mjs billedLogin, a Console account's key). Off: Auto never serves or moves a
//                      session through one. Never chosen: on when the saved order already holds one (the owner put it
//                      there). Turning it on adds them at the end of the order; turning it off takes them out.
//   returnToPreferred  when a session runs on a later profile and an earlier one is available again, move it back
//                      at the end of the current reply
//   prompt             what is typed after a switch so Claude carries on with the interrupted work
//   cooldownMinutes    how long a profile counts as "at its limit" when the reset time is not known
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.mjs';
import { stateDir } from './paths.mjs';
import { listProfiles, servesTools, validName } from './profiles.mjs';
import { billedLogin } from './routerstate.mjs';
import { replaceFile } from './replacefile.mjs';

export const DEFAULTS = {
  enabled: false,
  order: [],
  returnToPreferred: false,
  prompt: 'Continue from where you stopped.',
  cooldownMinutes: 300, // the longest short window Claude plans have is five hours
};

function rawSettings() {
  const raw = loadConfig().autoSwitch;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// Billed by use: a key the profile file says is paid per use, or the stored sign-in when its last check said it holds
// a key billed by use (a Console account's). The one rule for everything Auto mode does with "payPerUse".
const billed = (p) => p.paid === true || billedLogin(p);
const paidNames = (profiles = listProfiles()) => new Set(profiles.filter(billed).map((p) => p.name));

// The default of a choice never made: on when the owner put a key paid by its own file into the order. A sign-in that
// became billed by use after he put it there is no such choice, so it does not count here. The profile files are read
// once, and only when the order is not empty: getAutoSwitch() runs on every state poll.
function orderHasPaid(order) {
  if (!order.length) return false;
  const keys = new Set(listProfiles().filter((p) => p.paid === true).map((p) => p.name));
  return order.some((n) => keys.has(n));
}

export function getAutoSwitch() {
  const a = rawSettings();
  const cooldown = Number(a.cooldownMinutes);
  const order = Array.isArray(a.order) ? [...new Set(a.order.filter(validName))] : [];
  return {
    enabled: a.enabled === true,
    order,
    payPerUse: typeof a.payPerUse === 'boolean' ? a.payPerUse : orderHasPaid(order),
    returnToPreferred: a.returnToPreferred === true,
    prompt: typeof a.prompt === 'string' && a.prompt.trim() ? a.prompt.trim().slice(0, 500) : DEFAULTS.prompt,
    cooldownMinutes: Number.isFinite(cooldown) && cooldown >= 1 && cooldown <= 7 * 24 * 60 ? cooldown : DEFAULTS.cooldownMinutes,
  };
}

/** Change some of the settings. Unknown profile names in `order` are refused, so a typo cannot hide a profile. */
export function setAutoSwitch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('auto-switch settings must be an object');
  // A choice never made stays unmade (it keeps following the order), unless this change makes it.
  let chosen = typeof rawSettings().payPerUse === 'boolean';
  const next = { ...getAutoSwitch() };
  const before = next.order;
  if ('enabled' in patch) next.enabled = patch.enabled === true;
  if ('returnToPreferred' in patch) next.returnToPreferred = patch.returnToPreferred === true;
  if ('order' in patch) {
    if (!Array.isArray(patch.order)) throw new Error('"order" must be a list of profile names');
    const known = new Set(listProfiles().map((p) => p.name));
    for (const n of patch.order) if (!known.has(n)) throw new Error(`there is no profile "${n}"`);
    next.order = [...new Set(patch.order)];
  }
  const paid = paidNames();
  if ('payPerUse' in patch) {
    next.payPerUse = patch.payPerUse === true;
    next.order = next.payPerUse ? [...next.order, ...[...paid].filter((n) => !next.order.includes(n))] : next.order.filter((n) => !paid.has(n));
    chosen = true;
  } else if ('order' in patch && next.order.some((n) => paid.has(n) && !before.includes(n))) {
    // The owner put a pay-per-use key in the order. One that was there already is no choice: moving the rows of the
    // order (or a sign-in that became billed by use while it stood there) never turns paid use on.
    next.payPerUse = true;
    chosen = true;
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
  const { payPerUse, ...rest } = next;
  saveConfig({ autoSwitch: chosen ? next : rest });
  return { ...rest, payPerUse: chosen ? payPerUse : orderHasPaid(rest.order) };
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
  replaceFile(tmp, limitsFile());
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

/**
 * The order Auto mode really uses: providers that exist, without one billed by use (a pay-per-use key, a sign-in on a
 * Console account's key) unless the owner allows them. The router serves from it and every move at a limit picks from it.
 */
export function usableOrder() {
  return splitOrder().usable;
}

/**
 * The providers of the order that exist and serve Claude Code but are left out of usableOrder only because they are
 * billed by use while "Also use pay-per-use providers" is off. Empty while it is on. `names` asks the same of other
 * names than the order's: the router asks it of the provider a running Auto session runs as (its "/as/<name>"),
 * which turning the switch off takes out of the order.
 */
export function billedOutOfOrder(names) {
  return splitOrder(names).billed;
}

/**
 * Why each provider of the order is left out of usableOrder, read only: [{ name, why }], in the order's order, with
 * why 'missing' (no provider of that name any more), 'tools' (it does not serve Claude Code) or 'billed' (billed by
 * use while "Also use pay-per-use providers" is off). Empty for an empty order and when every provider takes part.
 * `accounts` ({ profiles, autoSwitch } as the dashboard lists them, perhaps another computer's) asks the same of that
 * list: its `tools` and its `paid` mark (a stored sign-in billed by use carries it there) stand in for the files.
 */
export function leftOutOfOrder(accounts) {
  if (accounts && typeof accounts === 'object') {
    const listed = Array.isArray(accounts.profiles) ? accounts.profiles : [];
    const as = accounts.autoSwitch || {};
    return [...new Set(Array.isArray(as.order) ? as.order : [])].map((name) => {
      const p = listed.find((x) => x && x.name === name && !x.virtual);
      const why = !p ? 'missing' : Array.isArray(p.tools) && !p.tools.includes('claude') ? 'tools' : as.payPerUse === false && p.paid === true ? 'billed' : null;
      return why ? { name, why, ...(p && p.label ? { label: p.label } : {}) } : null;
    }).filter(Boolean);
  }
  const profiles = listProfiles();
  const paid = paidNames(profiles);
  const as = getAutoSwitch();
  return as.order.map((name) => {
    const p = profiles.find((x) => x.name === name);
    const why = !p ? 'missing' : !servesTools(p).includes('claude') ? 'tools' : !as.payPerUse && paid.has(name) ? 'billed' : null;
    return why ? { name, why, ...(p && p.label ? { label: p.label } : {}) } : null;
  }).filter(Boolean);
}

// The one rule of both: a provider of the order takes part when it exists and serves Claude Code (Auto mode moves
// Claude Code sessions), unless it is billed by use while the switch is off.
function splitOrder(names) {
  const profiles = listProfiles();
  const known = new Set(profiles.filter((p) => servesTools(p).includes('claude')).map((p) => p.name));
  const paid = paidNames(profiles);
  const as = getAutoSwitch();
  const inOrder = (Array.isArray(names) ? names : as.order).filter((n) => known.has(n));
  const left = (n) => !as.payPerUse && paid.has(n);
  return { usable: inOrder.filter((n) => !left(n)), billed: inOrder.filter(left) };
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
