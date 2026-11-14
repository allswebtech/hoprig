// The automation settings (config.json, key "automation") and the validation of everything the owner can send:
// settings, schedules and queued messages. Every clean* function returns the clean value or throws an Error whose
// message is shown to the owner as is. Unknown keys are refused, so a typo is never silently ignored.
//
// Every automation can be switched off on its own, and `paused` stops them all at once.
//
//   paused     true stops every automation (nothing is sent, started, closed or updated)
//   queue      { enabled }                               default on: it only acts on messages you queued
//   schedules  { enabled, lateHours, list }              default on: it only acts on schedules you made
//   restore    { enabled }                               null = on for the built-in terminals, off for tmux
//   retry      { enabled, max, firstMinutes, prompt }    default off
//   updates    { claude: off|notify|auto }               default off
//   idle       { shells, shellHours, gateway, gatewayMinutes } default off
//   workspace  { map, commitMap, sync, push, everyHours } map on (it acts only where a map exists, and writes only
//                                                         when something changed); commitMap, sync, push off:
//                                                         saving the map in the brain's history, keeping the
//                                                         workspace in step (fetch and fast-forward), uploading
import path from 'node:path';
import { NAME_RE } from '../profiles.mjs';

export const TEXT_MAX = 32 * 1024;
export const QUEUE_MAX = 100;
export const SCHEDULES_MAX = 50;

export const DEFAULTS = Object.freeze({
  paused: false,
  queue: { enabled: true },
  schedules: { enabled: true, lateHours: 2, list: [] },
  restore: { enabled: null },
  retry: { enabled: false, max: 3, firstMinutes: 1, prompt: 'Continue from where you stopped.' },
  updates: { claude: 'off' },
  idle: { shells: false, shellHours: 12, gateway: false, gatewayMinutes: 30 },
  workspace: { map: true, commitMap: false, sync: false, push: false, everyHours: 6 },
});

// For each section: key → check(value) returning the clean value or throwing.
const bool = (what) => (v) => {
  if (typeof v !== 'boolean') throw new Error(`${what} must be on or off (true or false)`);
  return v;
};
const int = (what, lo, hi) => (v) => {
  const n = Number(v);
  if (typeof v === 'boolean' || v === '' || v === null || !Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be a whole number from ${lo} to ${hi}`);
  return n;
};
const oneOf = (what, values) => (v) => {
  if (!values.includes(v)) throw new Error(`${what} must be one of: ${values.join(', ')}`);
  return v;
};
const oneLine = (what, max) => (v) => {
  if (typeof v !== 'string' || !v.trim() || /[\r\n\0]/.test(v) || v.length > max) throw new Error(`${what} must be one line of 1 to ${max} characters`);
  return v.trim();
};

const SECTIONS = {
  queue: { enabled: bool('the queue switch') },
  schedules: { enabled: bool('the schedules switch'), lateHours: int('how late a missed schedule may still run (hours)', 0, 48) },
  restore: {
    enabled: (v) => {
      if (v !== null && typeof v !== 'boolean') throw new Error('restore must be on, off, or null for the default');
      return v;
    },
  },
  retry: {
    enabled: bool('the retry switch'),
    max: int('the number of retries', 1, 10),
    firstMinutes: int('the first wait before a retry (minutes)', 1, 60),
    prompt: oneLine('the retry message', 500),
  },
  updates: {
    claude: oneOf('Claude Code updates', ['off', 'notify', 'auto']),
  },
  idle: {
    shells: bool('closing idle shells'),
    shellHours: int('the hours before an idle shell is closed', 1, 720),
    gateway: bool('stopping an unused gateway'),
    gatewayMinutes: int('the minutes before an unused gateway is stopped', 5, 1440),
  },
  workspace: {
    map: bool('keeping the workspace map up to date'),
    commitMap: bool('saving the map in the brain\'s history'),
    sync: bool('keeping the workspace in step'),
    push: bool('pushing when keeping the workspace in step'),
    everyHours: int('how often the workspace is kept in step (hours)', 1, 168),
  },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A settings change from the page. Returns the full new settings (current + patch). Schedules are not changed
 * here: they have their own add / change / delete calls.
 */
export function cleanSettingsPatch(patch, current = DEFAULTS) {
  if (!isObj(patch)) throw new Error('send the settings as an object');
  const next = JSON.parse(JSON.stringify(current));
  for (const [section, value] of Object.entries(patch)) {
    if (section === 'paused') {
      next.paused = bool('"pause all automations"')(value);
      continue;
    }
    const checks = SECTIONS[section];
    if (!checks) throw new Error(`"${section}" is not an automation setting`);
    if (!isObj(value)) throw new Error(`the ${section} settings must be an object`);
    for (const [k, v] of Object.entries(value)) {
      if (section === 'schedules' && k === 'list') throw new Error('schedules are added, changed and deleted one at a time, not here');
      if (!checks[k]) throw new Error(`"${section}.${k}" is not an automation setting`);
      next[section][k] = checks[k](v);
    }
  }
  return next;
}

/**
 * The settings as stored, made safe to use: missing or broken values take their default, broken schedules are
 * left out. Never throws (a hand-edited config must not stop the service).
 */
export function readSettings(raw) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (!isObj(raw)) return out;
  if (typeof raw.paused === 'boolean') out.paused = raw.paused;
  for (const [section, checks] of Object.entries(SECTIONS)) {
    if (!isObj(raw[section])) continue;
    for (const [k, check] of Object.entries(checks)) {
      if (!(k in raw[section])) continue;
      try {
        out[section][k] = check(raw[section][k]);
      } catch {
        /* keep the default */
      }
    }
  }
  const list = isObj(raw.schedules) && Array.isArray(raw.schedules.list) ? raw.schedules.list : [];
  for (const s of list.slice(0, SCHEDULES_MAX)) {
    try {
      out.schedules.list.push({ ...cleanSchedule(s), id: idOf(s.id), since: Number(s.since) || 0 });
    } catch {
      /* a broken schedule is skipped, not run */
    }
  }
  return out;
}

/** Whether restore is on, given the backend: on by default where sessions end with the service. */
export const restoreOn = (settings, backend) =>
  settings.restore.enabled === null ? !(backend && backend.capabilities && backend.capabilities.persistent) : settings.restore.enabled;

// ---- queued messages ----

/** A queued message: text of 1 byte to 32 KiB, not only spaces, no NUL (terminals take C strings). */
export function cleanText(v, what = 'the message') {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is empty`);
  if (v.includes('\0')) throw new Error(`${what} contains a NUL character`);
  if (Buffer.byteLength(v) > TEXT_MAX) throw new Error(`${what} is longer than 32 KiB`);
  return v.replace(/\r\n?/g, '\n');
}

// ---- schedules ----

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_RE = /^[a-z0-9]{4,32}$/;
const SESSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;

const idOf = (v) => {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error('bad schedule id');
  return v;
};

function strictKeys(obj, allowed, what) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`"${k}" is not part of ${what}`);
}

export function cleanWhen(w) {
  if (!isObj(w)) throw new Error('say when the schedule runs');
  const time = w.time;
  if (typeof time !== 'string' || !TIME_RE.test(time)) throw new Error('the time must look like 09:30 (24-hour clock)');
  if (w.kind === 'daily') {
    strictKeys(w, ['kind', 'time'], 'a daily schedule');
    return { kind: 'daily', time };
  }
  if (w.kind === 'weekly') {
    strictKeys(w, ['kind', 'time', 'days'], 'a weekly schedule');
    if (!Array.isArray(w.days) || !w.days.length || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error('choose at least one weekday (0 = Sunday … 6 = Saturday)');
    }
    return { kind: 'weekly', time, days: [...new Set(w.days)].sort((a, b) => a - b) };
  }
  if (w.kind === 'once') {
    strictKeys(w, ['kind', 'time', 'date'], 'a one-time schedule');
    const m = typeof w.date === 'string' ? DATE_RE.exec(w.date) : null;
    const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!m || d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
      throw new Error('the date must be a real day like 2026-12-31');
    }
    return { kind: 'once', time, date: w.date };
  }
  throw new Error('a schedule runs "once", "daily" or "weekly"');
}

/**
 * A schedule from the page. `checks` (optional) lets the server add what only it knows:
 *   dirOk(dir) → bool        the folder exists and is inside the allowed roots
 *   profileOk(name) → bool   the account exists ("auto" included when Auto mode is set up)
 */
export function cleanSchedule(s, checks = {}) {
  if (!isObj(s)) throw new Error('send the schedule as an object');
  strictKeys(s, ['id', 'label', 'enabled', 'when', 'action', 'since'], 'a schedule');
  const out = {};
  if (s.label !== undefined && s.label !== '') out.label = oneLine('the schedule name', 60)(s.label);
  out.enabled = s.enabled === undefined ? true : bool('the schedule switch')(s.enabled);
  out.when = cleanWhen(s.when);
  const a = s.action;
  if (!isObj(a)) throw new Error('say what the schedule does');
  if (a.type === 'start') {
    strictKeys(a, ['type', 'dir', 'profile', 'prompt'], 'starting a session');
    if (typeof a.dir !== 'string' || !path.isAbsolute(a.dir) || a.dir.includes('\0') || a.dir.length > 4096) throw new Error('choose the folder to start in');
    if (checks.dirOk && !checks.dirOk(a.dir)) throw new Error(`${a.dir} is not a folder the dashboard may use`);
    if (typeof a.profile !== 'string' || (a.profile !== 'auto' && !NAME_RE.test(a.profile))) throw new Error('choose a provider (or Auto)');
    if (checks.profileOk && !checks.profileOk(a.profile)) throw new Error(`there is no provider "${a.profile}"`);
    out.action = { type: 'start', dir: a.dir, profile: a.profile };
    if (a.prompt !== undefined && a.prompt !== '') out.action.prompt = cleanText(a.prompt, 'the first message');
  } else if (a.type === 'send') {
    strictKeys(a, ['type', 'session', 'text'], 'sending a message');
    if (typeof a.session !== 'string' || !SESSION_RE.test(a.session)) throw new Error('choose the session to send to');
    out.action = { type: 'send', session: a.session, text: cleanText(a.text) };
  } else {
    throw new Error('a schedule either starts a session or sends a message');
  }
  return out;
}

export const newId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 32);
