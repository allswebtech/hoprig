// The owner's choices about field reports (docs/FIELD-REPORTS.md), and what this computer remembers of them.
//
// Settings, in config.json under "fieldReports" (the owner's own; nothing here is set in the public code):
//   sendTo      the address reports may be sent to: EMPTY by default, so a fresh install never sends and never asks
//   choice      null (not chosen yet: the same as never), "never", "ask" (each new report waits for Send or Don't
//               send) or "always". Changing the address makes it null again: he is asked again for the new address.
//   choiceAt    when he chose: only reports made after it are sent or asked about
//   choiceFor   the address he chose for: a choice read with another address (config.json edited by hand, or copied
//               from another computer) is no choice, so he is asked again
//   ownNetwork  the address is on his own network (as a webhook's: a private or this computer's address is allowed)
//   copyDir     "also write each report into this folder": an absolute path of his, empty (off) by default
//
// State, in <state>/field/state.json: the Home lines he dismissed, his answers to "ask each time", and the sends that
// failed (kept and tried with the next send, at most TRIES_MAX tries each).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { checkHookUrl } from '../work/hookaddr.mjs';
import { writeAtomic } from '../automation/store.mjs';
import { recordActivity } from './activity.mjs';

export const CHOICES = Object.freeze(['never', 'ask', 'always']);
export const TRIES_MAX = 3;
const fail = (message, code) => Object.assign(new Error(message), { status: 400, details: { code } });

const blank = () => ({ sendTo: '', choice: null, choiceAt: null, choiceFor: null, ownNetwork: false, copyDir: '' });

/** The settings as they are, every value checked (a hand edit that is not one is read as its default). */
export function readFieldSettings() {
  let raw;
  try {
    raw = loadConfig().fieldReports;
  } catch {
    raw = null;
  }
  const s = blank();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  if (typeof raw.sendTo === 'string' && raw.sendTo) {
    try {
      const u = checkHookUrl(raw.sendTo);
      if (u.protocol === 'https:') s.sendTo = u.href;
    } catch {
      /* not an address: as if empty */
    }
  }
  if (s.sendTo && CHOICES.includes(raw.choice) && typeof raw.choiceAt === 'string' && !Number.isNaN(Date.parse(raw.choiceAt))
    && raw.choiceFor === s.sendTo) {
    s.choice = raw.choice;
    s.choiceAt = raw.choiceAt;
    s.choiceFor = s.sendTo;
  }
  s.ownNetwork = raw.ownNetwork === true;
  if (typeof raw.copyDir === 'string' && path.isAbsolute(raw.copyDir)) s.copyDir = raw.copyDir;
  return s;
}

/**
 * Was a report (its time, whole seconds in UTC) made after his choice? Strictly after the choice's own second: a
 * report of that same second may have ended before he pressed, so it is never sent or asked about (the safe side).
 */
export const madeAfterChoice = (time, s) => !!(s && s.choiceAt) && typeof time === 'string' && time > `${s.choiceAt.slice(0, 19)}Z`;

/** What may be sent now: the choice, but "never" when there is no address or no choice. */
export const sendChoice = (s = readFieldSettings()) => (s.sendTo && s.choice ? s.choice : 'never');

/**
 * Change the settings from the page. patch: { sendTo?, choice?, ownNetwork?, copyDir? }. Checked here: an https
 * address (or "" to clear it), a choice from the list (only with an address), an absolute path of a folder that is
 * there (or ""). A new address clears the choice. → the settings.
 */
export function writeFieldSettings(patch, { now = Date.now } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('the body must be a JSON object', 'body');
  for (const k of Object.keys(patch)) if (!['sendTo', 'choice', 'ownNetwork', 'copyDir'].includes(k)) throw fail(`there is no setting "${String(k).slice(0, 30)}"`, 'unknown');
  const cur = readFieldSettings();
  const next = { ...cur };
  if (patch.sendTo !== undefined) {
    if (typeof patch.sendTo !== 'string') throw fail('the address is text', 'address');
    const raw = patch.sendTo.trim();
    let href = '';
    if (raw) {
      const u = checkHookUrl(raw);
      if (u.protocol !== 'https:') throw fail('reports are sent to an https address only', 'address');
      href = u.href;
    }
    if (href !== cur.sendTo) {
      next.sendTo = href;
      next.choice = null; // asked again: "always" was said for another address
      next.choiceAt = null;
      next.choiceFor = null;
    }
  }
  if (patch.ownNetwork !== undefined) {
    if (typeof patch.ownNetwork !== 'boolean') throw fail('ownNetwork is true or false', 'own-network');
    next.ownNetwork = patch.ownNetwork;
  }
  if (patch.choice !== undefined) {
    if (!CHOICES.includes(patch.choice)) throw fail('the choice is never, ask or always', 'choice');
    if (!next.sendTo) throw fail('set the address first: with no address nothing is ever sent', 'no-address');
    next.choice = patch.choice;
    next.choiceAt = new Date(now()).toISOString();
    next.choiceFor = next.sendTo;
  }
  if (patch.copyDir !== undefined) {
    if (typeof patch.copyDir !== 'string') throw fail('the folder is a path', 'folder');
    const dir = patch.copyDir.trim();
    if (dir) {
      if (!path.isAbsolute(dir)) throw fail('give the folder\'s whole path (it starts with / or a drive letter)', 'folder');
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        st = null;
      }
      if (!st || !st.isDirectory()) throw fail('that folder is not there: make it first', 'folder');
    }
    next.copyDir = dir;
  }
  saveConfig({ fieldReports: next });
  return readFieldSettings();
}

// ---------- what this computer remembers ----------

const stateFile = () => path.join(stateDir(), 'field', 'state.json');
const ID_RE = /^[0-9a-f]{16}$/;
const KEY_RE = /^[a-z-]{2,20}:[a-z-]{2,20}$/;
const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const KEEP = 200;

// A state file that is there but cannot be read (a hand edit, a disk error) is never taken for an empty one: that would
// make every report look fresh, and "always" would send each of them again. It is put aside as state.json.broken, said
// once in Activity, and a new state is written in which the reports on disk now count as "given-up": whether they went
// is not known, so they never go again. Reports made after that are sent as before. When it cannot even be put aside,
// the state reads as `broken`: nothing is sent and nothing is written over it, and Activity says so once.
let brokenSaid = false;
function readStateFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? { raw: {} } : { broken: true };
  }
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { raw } : { broken: true };
  } catch {
    return { broken: true };
  }
}

function repairState(file) {
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(stateDir(), 'field', 'reports')).map((n) => /-([0-9a-f]{16})\.json$/.exec(n)).filter(Boolean).map((m) => m[1]);
  } catch {
    ids = [];
  }
  try {
    fs.renameSync(file, `${file}.broken`);
    writeAtomic(file, { dismissed: {}, answered: Object.fromEntries(ids.slice(-KEEP).map((id) => [id, 'given-up'])), kept: {} });
  } catch {
    if (!brokenSaid) recordActivity('Field reports are not sent: this computer\'s record of what was sent could not be read or put aside', 'failed: its state file is broken');
    brokenSaid = true;
    return false;
  }
  brokenSaid = false;
  recordActivity('Field reports: the record of what was sent could not be read; it was put aside, and the reports made before now are not sent again', 'failed: its state file was broken');
  return true;
}

/**
 * { dismissed: { "<kind>:<class>": time }, answered: { id: "sent" | "not-sent" | "given-up" }, kept: { id: tries } },
 * and `broken: true` while a state file that cannot be read could not be put aside (then nothing may be sent).
 */
export function readFieldState() {
  const file = stateFile();
  let got = readStateFile(file);
  if (got.broken) {
    if (!repairState(file)) return { dismissed: {}, answered: {}, kept: {}, broken: true };
    got = readStateFile(file);
    if (got.broken) return { dismissed: {}, answered: {}, kept: {}, broken: true };
  }
  const raw = got.raw;
  const out = { dismissed: {}, answered: {}, kept: {} };
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  for (const [k, v] of Object.entries(obj(raw.dismissed))) if (KEY_RE.test(k) && isTime(v)) out.dismissed[k] = v;
  for (const [k, v] of Object.entries(obj(raw.answered))) if (ID_RE.test(k) && (v === 'sent' || v === 'not-sent' || v === 'given-up')) out.answered[k] = v;
  for (const [k, v] of Object.entries(obj(raw.kept))) if (ID_RE.test(k) && Number.isInteger(v) && v > 0 && v < TRIES_MAX) out.kept[k] = v;
  return out;
}

/** Change the state with fn(state) → state; bounded. */
export function changeFieldState(fn) {
  const now = readFieldState();
  // Never written over a state file that could not be put aside: what it held would be lost, and sent again.
  if (now.broken) throw Object.assign(new Error('the field reports\' state file is broken'), { code: 'EBROKEN' });
  const next = fn(now);
  const last = (o) => Object.fromEntries(Object.entries(o).slice(-KEEP));
  writeAtomic(stateFile(), { dismissed: last(next.dismissed), answered: last(next.answered), kept: last(next.kept) });
  return next;
}
