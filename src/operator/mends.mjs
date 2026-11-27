// The acts of self-healing, in one place: the rules of the Operator (rules.mjs, reflex.mjs) and Tia's one door both call
// these, so one act has one function. Each is small, reads before it acts, and touches only what Hoprig itself made or
// started: never the owner's files, his git trees, his accounts or a program Hoprig did not start. No function here
// asks a model or sends a key.
//
//   portHolder(port)              who holds a TCP port on this computer (Linux): { pid, name } or null
//   httpLook(url)                 one request with no key and no body: the status number, or 0 when nothing answered
//   probeAddress(address)         "host:port" or a URL: a knock, then one request: { state, status }
//   defaultNext(current, list)    the provider a limit moves to when the owner set no order: his subscriptions in list order
//   ownTemp({...})                what Hoprig made in its own folders and in the temporary folder that is old enough to go
//   cleanOwnTemp({...})           removes exactly that; returns { freed, files }
//   reopenSession(t, { start })   starts the same conversation again with resume, sending nothing to it

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { knock } from '../knock.mjs';

const DAY = 24 * 3600_000;
export const LOG_KEEP_MS = 14 * DAY;
export const TEMP_KEEP_MS = DAY;
// What Hoprig names its own temporary things with (src/claudecode.mjs and the tests' homes).
export const TEMP_PREFIXES = Object.freeze(['hoprig-', 'hop-']);

// ---- who holds a port ----

const LISTEN = '0A';

/** The inode of the listening socket on `port`, read from /proc/net/tcp and tcp6; null when none. */
function listenInode(port, proc) {
  for (const f of ['tcp', 'tcp6']) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(proc, 'net', f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10 || c[3] !== LISTEN) continue;
      const p = parseInt(c[1].split(':')[1], 16);
      if (p === port && c[9] && c[9] !== '0') return c[9];
    }
  }
  return null;
}

/**
 * The program that listens on `port` (Linux: the table of sockets and the descriptors of this user's processes, read
 * only), or null when none or when it cannot be told here. Never ends or touches it.
 */
export function portHolder(port, { proc = '/proc' } = {}) {
  if (!Number.isInteger(port)) return null;
  const inode = listenInode(port, proc);
  if (!inode) return null;
  let pids = [];
  try {
    pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds = [];
    try {
      fds = fs.readdirSync(path.join(proc, pid, 'fd'));
    } catch {
      continue; // another user's process, or gone
    }
    for (const fd of fds) {
      let to = '';
      try {
        to = fs.readlinkSync(path.join(proc, pid, 'fd', fd));
      } catch {
        continue;
      }
      if (to === `socket:[${inode}]`) {
        // The program's file name (a thread of it may be named otherwise in `comm`), else `comm`, else plain words.
        let name = 'another program';
        try {
          name = path.basename(fs.readlinkSync(path.join(proc, pid, 'exe'))).slice(0, 40) || name;
        } catch {
          try {
            name = fs.readFileSync(path.join(proc, pid, 'comm'), 'utf8').trim().slice(0, 40) || name;
          } catch { /* keeps the plain words */ }
        }
        return { pid: Number(pid), name };
      }
    }
  }
  return null;
}

// ---- looks at an address: no key, no tokens ----

/** One GET with no headers of ours, no body and no redirect followed: the status, or 0 when nothing answered. */
export async function httpLook(url, { timeoutMs = 5000, fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel();
    return r.status;
  } catch {
    return 0;
  }
}

/**
 * Whether something answers at an address: a knock first (is anything listening), then one request with no key. An
 * address that holds a user name or a key (`user:pass@`, `?key=`) is never sent anywhere: it is not looked at.
 * → { state: 'answers' | 'closed' | 'silent' | 'skipped', status }
 */
export async function probeAddress(address, { knockFn = knock, look = httpLook } = {}) {
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(address) ? address : `http://${address}`);
  } catch {
    return { state: 'skipped', status: 0 };
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search) return { state: 'skipped', status: 0 };
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const k = await knockFn({ host: u.hostname.replace(/^\[|\]$/g, ''), port }, 3000);
  if (k !== 'open') return { state: k, status: 0 };
  const status = await look(`${u.origin}/`);
  return { state: status ? 'answers' : 'silent', status };
}

// ---- the limit's default order ----

const subscription = (p) => p && !p.virtual && p.kind !== 'api' && p.paid !== true && p.signedIn !== false && (!Array.isArray(p.tools) || p.tools.includes('claude'));
const atLimit = (p, now) => !!p.limited && !(Number.isFinite(p.limited.until) && p.limited.until <= now);

/**
 * The provider a session at a limit continues on when the owner has set no order: the next of his subscription
 * providers in the list's order after the current one (going round), skipping one that is at its limit. A provider paid
 * per use is never named here: it needs its own card. → the provider's name or null.
 */
export function defaultNext(current, profiles, now = Date.now()) {
  const list = (Array.isArray(profiles) ? profiles : []).filter((p) => p && typeof p.name === 'string');
  const ok = list.filter((p) => subscription(p) && !atLimit(p, now));
  const i = list.findIndex((p) => p.name === current);
  const ring = i < 0 ? ok : [...list.slice(i + 1), ...list.slice(0, i)].filter((p) => ok.includes(p));
  return ring.find((p) => p.name !== current)?.name ?? null;
}

// ---- Hoprig's own temporary things ----

const lst = (f) => {
  try {
    return fs.lstatSync(f);
  } catch {
    return null;
  }
};

/** The bytes of a file, or of a folder's files (no link followed), at most 20000 entries looked at. */
function sizeOf(p, budget = { n: 20000 }) {
  const st = lst(p);
  if (!st || budget.n-- <= 0) return 0;
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try {
    for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e), budget);
  } catch { /* unreadable: counts nothing */ }
  return total;
}

/**
 * What Hoprig made itself and may remove: its own log files older than 14 days (`<state>/logs` and `*.log` in the state
 * folder), and the folders and files in the temporary folder that carry its own prefixes, older than a day. A link is
 * never followed or removed through; nothing else is named. → [{ path, bytes }]
 */
export function ownTemp({ state, tmp = os.tmpdir(), now = Date.now(), prefixes = TEMP_PREFIXES } = {}) {
  const out = [];
  const add = (p, keepMs) => {
    const st = lst(p);
    if (!st || st.isSymbolicLink() || now - st.mtimeMs < keepMs) return;
    out.push({ path: p, bytes: sizeOf(p) });
  };
  const files = (dir, only) => {
    let list = [];
    try {
      list = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of list) if (only(n)) add(path.join(dir, n), LOG_KEEP_MS);
  };
  if (state) {
    files(path.join(state, 'logs'), () => true);
    files(state, (n) => /\.log(\.\d+)?$/.test(n) && !!lst(path.join(state, n))?.isFile());
  }
  let list = [];
  try {
    list = fs.readdirSync(tmp);
  } catch { /* no temporary folder to read */ }
  for (const n of list) if (prefixes.some((p) => n.startsWith(p))) add(path.join(tmp, n), TEMP_KEEP_MS);
  return out;
}

/** The bytes `ownTemp` would free. */
export const ownTempBytes = (o) => ownTemp(o).reduce((s, f) => s + f.bytes, 0);

/** Removes exactly what `ownTemp` names, now. → { freed, files } (bytes and a count). */
export function cleanOwnTemp(o = {}) {
  let freed = 0;
  let files = 0;
  for (const f of ownTemp(o)) {
    try {
      fs.rmSync(f.path, { recursive: true, force: true });
      freed += f.bytes;
      files++;
    } catch { /* stays; the next round tries again */ }
  }
  return { freed, files };
}

/** "1.2 GB", "340 MB", "12 KB": for the line a mend writes. */
export function bytesWords(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ---- reopening a session whose coding tool died ----

/**
 * Starts the conversation again the way a restart does (`mode: move`: resume it, keep its arguments), under the same
 * name where it is free, and types nothing into it. `start` is the dashboard's own deck start; a conversation that runs
 * already makes it throw `existing` and nothing is reopened.
 */
export async function reopenSession(t, { start }) {
  if (!t || typeof t.session !== 'string' || typeof t.cwd !== 'string' || typeof t.profile !== 'string' || typeof t.sessionId !== 'string') {
    throw Object.assign(new Error('that session cannot be reopened: its conversation is not known'), { status: 409 });
  }
  try {
    const name = await start({ ...(t.tool && t.tool !== 'claude' ? { tool: t.tool } : {}), dir: t.cwd, profile: t.profile, mode: 'move', sessionId: t.sessionId, carryArgs: Array.isArray(t.carryArgs) ? t.carryArgs : [], name: t.session });
    return { did: `reopened session ${name} where it stopped; nothing was sent to it` };
  } catch (e) {
    if (e.existing) throw Object.assign(new Error('its conversation runs already: nothing was reopened'), { status: 409 });
    throw e;
  }
}
