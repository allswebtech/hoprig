// The automation settings (config.json, key "automation") and the validation of everything the owner can send:
// settings, schedules and queued messages. Every clean* function returns the clean value or throws an Error whose
// message is shown to the owner as is. Unknown keys are refused, so a typo is never silently ignored.
//
// Every automation can be switched off on its own, and `paused` stops them all at once.
//
//   paused     true stops every automation (nothing is sent, started, closed or updated)
//   queue      { enabled }                               default on: it only acts on messages you queued
//   schedules  { enabled, lateHours, atOnce, list }      default on: it only acts on schedules you made; atOnce:
//                                                         how many runs that end by themselves at once (1 to 4)
//   restore    { enabled }                               null = on (also with tmux: it reopens only, nothing is sent)
//   retry      { enabled, max, firstMinutes, prompt }    default on: only after a passing error, never a 4xx, a limit
//                                                         or a provider paid per use (./retry.mjs)
//   (updates have their own top-level key "updates": ./updates.mjs, Settings → Version and updates)
//   idle       { shells, shellHours, gateway, gatewayMinutes } default off
//   workspace  { map, commitMap, memory, sync, push, pushBranches, everyHours }
//                                                         map on (it acts only where a map exists, and writes only
//                                                         when something changed); commitMap null = never chosen:
//                                                         on when the AI brain has a git server address
//                                                         (commitMapState); sync, push off:
//                                                         saving the map in the brain's history, keeping the
//                                                         workspace in step (fetch and fast-forward), uploading;
//                                                         memory off: commit the brain's and the groups' memory
//                                                         folders; pushBranches {}: per place that holds projects,
//                                                         push committed work on branches that are not the default;
//                                                         credentials off: commit a change in the credentials
//                                                         repository and push it (only while it is private)
import path from 'node:path';
import { EFFORTS, PERMISSION_MODES } from '../config.mjs';
import { MODEL_RE } from '../server/endpoint.mjs';
import { NAME_RE } from '../profiles.mjs';

export const TEXT_MAX = 32 * 1024;
export const QUEUE_MAX = 100;
export const SCHEDULES_MAX = 50;

export const DEFAULTS = Object.freeze({
  paused: false,
  queue: { enabled: true },
  schedules: { enabled: true, lateHours: 2, atOnce: 1, list: [] },
  restore: { enabled: null },
  retry: { enabled: true, max: 3, firstMinutes: 1, prompt: 'Continue from where you stopped.' },
  idle: { shells: false, shellHours: 12, gateway: false, gatewayMinutes: 30 },
  workspace: { map: true, commitMap: null, memory: false, sync: false, push: false, pushBranches: {}, everyHours: 6, credentials: false, onlyHere: false, servers: false, ffProjects: { projects: true } },
});

/**
 * "Save a change of the map in the AI brain's history": the owner's choice, else on when the brain has a git server
 * address (`remote`, its first remote's address or null). → { on, chosen, github }
 */
export function commitMapState(workspace, remote) {
  if (typeof workspace.commitMap === 'boolean') return { on: workspace.commitMap, chosen: true, github: false };
  return { on: !!remote, chosen: false, github: !!remote && /github\.com[:/]/i.test(remote) };
}

/** The settings with commitMap as true or false, the way everything that acts on it or shows it reads it. */
export function effectiveSettings(s, remote) {
  if (typeof s.workspace.commitMap === 'boolean') return s;
  return { ...s, workspace: { ...s.workspace, commitMap: commitMapState(s.workspace, remote()).on } };
}

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
const oneLine = (what, max) => (v) => {
  if (typeof v !== 'string' || !v.trim() || /[\r\n\0]/.test(v) || v.length > max) throw new Error(`${what} must be one line of 1 to ${max} characters`);
  return v.trim();
};

const SECTIONS = {
  queue: { enabled: bool('the queue switch') },
  schedules: { enabled: bool('the schedules switch'), lateHours: int('how late a missed schedule may still run (hours)', 0, 48), atOnce: int('how many runs by themselves at once', 1, 4) },
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
    memory: bool('committing the memory folders of the brain and the groups'),
    credentials: bool('committing and pushing a change of the credentials'),
    onlyHere: bool('looking once a day at what is only on this computer'),
    servers: bool('looking once a week at the git servers of the map'),
    ffProjects: (v) => {
      // One switch per place that holds projects: on for the projects folder, off for a group's own place unless set.
      if (!isObj(v) || Object.keys(v).length > 50) throw new Error('moving projects that are only behind is set per place: { "<place>": true or false }');
      const out = {};
      for (const [k, on] of Object.entries(v)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/.test(k)) throw new Error(`"${k.slice(0, 40)}" is not a place of the workspace`);
        if (typeof on !== 'boolean') throw new Error(`moving the projects of ${k} that are only behind must be on or off (true or false)`);
        out[k] = on;
      }
      return out;
    },
    pushBranches: (v) => {
      // One switch per place that holds projects: "projects" for the projects folder, else the place's folder.
      if (!isObj(v) || Object.keys(v).length > 50) throw new Error('pushing the other branches is set per place: { "<place>": true or false }');
      const out = {};
      for (const [k, on] of Object.entries(v)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/.test(k)) throw new Error(`"${k.slice(0, 40)}" is not a place of the workspace`);
        if (typeof on !== 'boolean') throw new Error(`pushing the other branches of ${k} must be on or off (true or false)`);
        if (on) out[k] = true;
      }
      return out;
    },
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

/**
 * Whether restore is on: on by default on every backend (it only reopens and sends nothing; with tmux it matters after a
 * reboot or when tmux itself died). `backend` is kept for the callers that pass it.
 */
export const restoreOn = (settings, _backend) => (settings.restore.enabled === null ? true : settings.restore.enabled);

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
const CHAT_RE = /^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // an open chat (src/chat)

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
  if (w.kind === 'monthly') {
    strictKeys(w, ['kind', 'time', 'day'], 'a monthly schedule');
    if (!Number.isInteger(w.day) || w.day < 1 || w.day > 31) throw new Error('choose the day of the month (1 to 31; in a shorter month its last day)');
    return { kind: 'monthly', time, day: w.day };
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
  throw new Error('a schedule runs "once", "daily" or "weekly", or "monthly" on a day');
}

/**
 * A schedule from the page. `checks` (optional) lets the server add what only it knows:
 *   dirOk(dir) → bool        the folder exists and is inside the allowed roots
 *   profileOk(name, tool) → bool   the account exists and serves the coding tool ("auto": Claude Code, when set up)
 *   chatToolOk(tool) → bool  a chat can run that coding tool here
 */
export function cleanSchedule(s, checks = {}) {
  if (!isObj(s)) throw new Error('send the schedule as an object');
  strictKeys(s, ['id', 'label', 'enabled', 'when', 'action', 'since', 'computer', 'hers'], 'a schedule');
  const out = {};
  // `hers`: the schedule came through Tia's door (index.mjs changeSchedules sets it from the route, never from the
  // body): what it starts is hers. Kept as it was stored; it only ever adds the owner's card.
  if (s.hers === true) out.hers = true;
  if (s.label !== undefined && s.label !== '') out.label = oneLine('the schedule name', 60)(s.label);
  out.enabled = s.enabled === undefined ? true : bool('the schedule switch')(s.enabled);
  out.when = cleanWhen(s.when);
  const a = s.action;
  if (!isObj(a)) throw new Error('say what the schedule does');
  if (a.type === 'start') {
    strictKeys(a, ['type', 'dir', 'profile', 'prompt', 'in', 'tool'], 'starting a session');
    if (a.in !== undefined && a.in !== 'chat' && a.in !== 'terminal') throw new Error('a session starts in a chat or in a terminal');
    // The coding tool of a chat (left out: Claude Code); a terminal a schedule starts runs Claude Code.
    const tool = a.tool === undefined || a.tool === null || a.tool === '' ? 'claude' : a.tool;
    if (tool !== 'claude' && (a.in !== 'chat' || typeof tool !== 'string' || !/^[a-z]{1,20}$/.test(tool) || (checks.chatToolOk && !checks.chatToolOk(tool)))) throw new Error('a schedule starts another coding tool only in a chat, and only one this computer offers');
    if (typeof a.dir !== 'string' || !path.isAbsolute(a.dir) || a.dir.includes('\0') || a.dir.length > 4096) throw new Error('choose the folder to start in');
    if (checks.dirOk && !checks.dirOk(a.dir)) throw new Error(`${a.dir} is not a folder the dashboard may use`);
    if (typeof a.profile !== 'string' || (a.profile !== 'auto' && !NAME_RE.test(a.profile))) throw new Error('choose a provider (or Auto)');
    if (checks.profileOk && !checks.profileOk(a.profile, tool)) throw new Error(`there is no provider "${a.profile}"`);
    out.action = { type: 'start', dir: a.dir, profile: a.profile, ...(a.in === 'chat' ? { in: 'chat' } : {}), ...(tool !== 'claude' ? { tool } : {}) }; // without "in": a terminal, as before
    if (a.prompt !== undefined && a.prompt !== '') out.action.prompt = cleanText(a.prompt, 'the first message');
  } else if (a.type === 'send') {
    strictKeys(a, ['type', 'session', 'text'], 'sending a message');
    if (typeof a.session !== 'string' || !(SESSION_RE.test(a.session) || CHAT_RE.test(a.session))) throw new Error('choose the session to send to');
    out.action = { type: 'send', session: a.session, text: cleanText(a.text) };
  } else if (a.type === 'alone') {
    out.action = cleanAlone(a, s.computer ? {} : checks);
  } else {
    throw new Error('a schedule starts a session or sends a message, or runs by itself');
  }
  // The computer a run that ends by itself runs on: this one (left out), or a computer linked to this dashboard by its
  // stable Work id (src/work/runs.mjs writerId). A session or a message is always this computer's.
  if (s.computer !== undefined && s.computer !== null && s.computer !== '') {
    if (a.type !== 'alone') throw new Error('only a run that ends by itself runs on another computer');
    if (typeof s.computer !== 'string' || !COMPUTER_RE.test(s.computer)) throw new Error('choose the computer it runs on');
    out.computer = s.computer;
  }
  return out;
}

const COMPUTER_RE = /^[0-9a-f]{16}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FOLDER_RE = /^(\.|code\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})$/;
export const ALONE_MINUTES = { default: 30, max: 240 };

/**
 * A run that ends by itself (src/work/alone.mjs): { type: 'alone', project, folder?, prompt, provider, model?, effort?,
 * mode? (left out: the mode that asks), minutes? (1 to 240, left out: 30), tell? ('always'; left out: only when there
 * is something to report) }. `checks.projectOk(name)`, `checks.profileOk(name)`: on this computer (another computer
 * checks its own when the run reaches it).
 */
export function cleanAlone(a, checks = {}) {
  strictKeys(a, ['type', 'project', 'folder', 'prompt', 'provider', 'model', 'effort', 'mode', 'minutes', 'tell'], 'a run that ends by itself');
  if (typeof a.project !== 'string' || !PROJECT_RE.test(a.project)) throw new Error('choose the project it runs in');
  if (checks.projectOk && !checks.projectOk(a.project)) throw new Error(`"${a.project}" is not a project of the workspace`);
  if (a.folder !== undefined && a.folder !== '.' && (typeof a.folder !== 'string' || !FOLDER_RE.test(a.folder))) throw new Error('choose the project\'s own folder or one of its code repositories');
  if (typeof a.prompt !== 'string' || !a.prompt.trim() || a.prompt.length > 4000 || a.prompt.includes('\0')) throw new Error('say what it should do (1 to 4000 characters)');
  if (typeof a.provider !== 'string' || (a.provider !== 'auto' && !NAME_RE.test(a.provider))) throw new Error('choose a provider (or Auto)');
  if (checks.profileOk && !checks.profileOk(a.provider, 'claude')) throw new Error(`there is no provider "${a.provider}"`);
  const out = { type: 'alone', project: a.project, ...(a.folder && a.folder !== '.' ? { folder: a.folder } : {}), prompt: a.prompt.replace(/\r\n?/g, '\n').trim(), provider: a.provider };
  if (a.model !== undefined && a.model !== null) {
    // Any model name (the provider's list is offered where it is picked; a saved name keeps working when it is checked again).
    if (typeof a.model !== 'string' || !MODEL_RE.test(a.model)) throw new Error('the model is a model name such as sonnet or claude-sonnet-5-5');
    out.model = a.model;
  }
  if (a.effort !== undefined && a.effort !== null) {
    if (!EFFORTS.includes(a.effort)) throw new Error(`the effort is one of: ${EFFORTS.join(', ')}`);
    out.effort = a.effort;
  }
  if (a.mode !== undefined && a.mode !== null && a.mode !== 'manual') {
    if (!PERMISSION_MODES.includes(a.mode)) throw new Error(`the permission mode is one of: ${PERMISSION_MODES.join(', ')}`);
    out.mode = a.mode;
  }
  if (a.minutes !== undefined && a.minutes !== null) out.minutes = int('the time limit (minutes)', 1, ALONE_MINUTES.max)(a.minutes);
  if (a.tell !== undefined && a.tell !== null && a.tell !== 'news') {
    if (a.tell !== 'always') throw new Error('tell me is "always" or only when there is something to report');
    out.tell = 'always';
  }
  return out;
}

export const newId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 32);
