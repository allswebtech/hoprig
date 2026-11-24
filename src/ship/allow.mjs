// The owner's yes for a project's commands (docs/GO-LIVE.md). A project's "check" and "live" blocks are
// someone else's words: they run only after the owner confirmed THOSE commands for that project on THIS computer.
//
// The yes is kept in Hoprig's settings (config.json "ship.allowed"), keyed by the project's real path, one value per
// block: an HMAC of the block's canonical form under a key that lives only in this computer's state folder
// (ship/computer.key, mode 600). So a block that changed (also one a task branch changed) asks again, and a settings
// file copied from another computer, or a yes written by hand, holds nothing here. A program that runs as the owner can
// read the key as he can: the yes does not guard against that (docs/GO-LIVE.md says so). The limiter prefix (a command the
// checks run through, the owner's own words) is kept and confirmed the same way.
//
// Only the owner's own press calls allow(): the page after it showed him the block (its plain hash, `seen`), and the
// command line after a question on a terminal. Never the assistant's token, another computer, or a flag.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { canonical } from './project.mjs';

const keyFile = () => path.join(stateDir(), 'ship', 'computer.key');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** This computer's key: made once, at the first yes (never at a look: reading needs none). */
function computerKey({ make = false } = {}) {
  try {
    const k = fs.readFileSync(keyFile(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(k)) return k;
  } catch {
    /* made below */
  }
  if (!make) return null;
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true, mode: 0o700 });
  const k = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile(), `${k}\n`, { mode: 0o600, flag: 'wx' });
    return k;
  } catch {
    return computerKey(); // another process made it first
  }
}

/** The plain hash of a block, as the page shows it and sends back as `seen`. */
export const blockHash = (block) => crypto.createHash('sha256').update(canonical(block)).digest('hex');

const mac = (key, real, kind, block) => crypto.createHmac('sha256', key).update(`${real}\0${kind}\0${canonical(block)}`).digest('hex');
const shipOf = (cfg = loadConfig()) => (isObj(cfg.ship) ? cfg.ship : {});

function saveShip(fn) {
  const cur = shipOf();
  const next = fn(JSON.parse(JSON.stringify(cur)));
  saveConfig({ ship: next });
  return next;
}

/** Whether the owner confirmed exactly `block` of kind 'check' | 'live' for the project at real path `real` here. */
export function isAllowed(real, kind, block, cfg = loadConfig()) {
  if (!block) return false;
  const key = computerKey();
  if (!key) return false;
  const kept = shipOf(cfg).allowed;
  const v = isObj(kept) && Object.hasOwn(kept, real) && isObj(kept[real]) ? kept[real][kind] : null;
  if (typeof v !== 'string' || v.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(mac(key, real, kind, block)));
}

/** Keep the owner's yes for `block` (his press after he saw it). */
export function allow(real, kind, block) {
  if (!['check', 'live'].includes(kind) || !block) throw new Error('nothing to confirm');
  const key = computerKey({ make: true });
  saveShip((s) => {
    const all = isObj(s.allowed) ? s.allowed : {};
    const mine = Object.hasOwn(all, real) && isObj(all[real]) ? all[real] : {};
    Object.defineProperty(all, real, { value: { ...mine, [kind]: mac(key, real, kind, block) }, enumerable: true, writable: true, configurable: true });
    return { ...s, allowed: all };
  });
}

/** Take the yes back. */
export function forget(real, kind) {
  saveShip((s) => {
    const all = isObj(s.allowed) ? s.allowed : {};
    if (Object.hasOwn(all, real) && isObj(all[real])) delete all[real][kind];
    return { ...s, allowed: all };
  });
}

/** The limiter prefix as kept: { run: [words] | null, allowed } (allowed: confirmed on this computer). */
export function limiterOf(cfg = loadConfig()) {
  const l = shipOf(cfg).limiter;
  if (!isObj(l) || !Array.isArray(l.run) || !l.run.length || l.run.some((w) => typeof w !== 'string' || !w)) return { run: null, allowed: true };
  const key = computerKey();
  const ok = !!key && typeof l.mac === 'string' && l.mac.length === 64 && crypto.timingSafeEqual(Buffer.from(l.mac), Buffer.from(mac(key, '', 'limiter', l.run)));
  return { run: [...l.run], allowed: ok };
}

/** Set (his own words, his press) or clear (null) the limiter prefix. */
export function setLimiter(run) {
  if (run === null) return saveShip((s) => ({ ...s, limiter: null }));
  if (!Array.isArray(run) || !run.length || run.length > 20 || run.some((w) => typeof w !== 'string' || !w || w.length > 500 || /[\0\r\n]/.test(w))) throw Object.assign(new Error('the limiter is a list of words, such as ["bash", "/path/to/limit.sh"]'), { status: 400 });
  const key = computerKey({ make: true });
  return saveShip((s) => ({ ...s, limiter: { run: [...run], mac: mac(key, '', 'limiter', run) } }));
}

/** The per-project switches: { auto, from, to, autoBack } (defaults: off, 09:00 to 18:00, off). */
export function switchesOf(real, cfg = loadConfig()) {
  const p = shipOf(cfg).projects;
  const v = isObj(p) && Object.hasOwn(p, real) && isObj(p[real]) ? p[real] : {};
  const hm = (x, d) => (typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : d);
  return { auto: v.auto === true, from: hm(v.from, '09:00'), to: hm(v.to, '18:00'), autoBack: v.autoBack === true };
}

/** Change a project's switches (the caller checked the typed name for `auto: true`). */
export function setSwitches(real, patch) {
  saveShip((s) => {
    const all = isObj(s.projects) ? s.projects : {};
    const cur = Object.hasOwn(all, real) && isObj(all[real]) ? all[real] : {};
    Object.defineProperty(all, real, { value: { ...cur, ...patch }, enumerable: true, writable: true, configurable: true });
    return { ...s, projects: all };
  });
  return switchesOf(real);
}

/** Whether `date` (local time) is inside the hours from–to ("09:00"–"18:00"; a range over midnight works too). */
export function insideHours({ from, to }, date = new Date()) {
  const m = date.getHours() * 60 + date.getMinutes();
  const [a, b] = [from, to].map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
