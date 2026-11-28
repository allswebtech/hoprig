// The keys of a session on a linked computer for one of the hub's providers (hop_hl_...), and the check of a request
// that carries one.
//
// A hub provider's real key is never on this computer. A session gets an address of this very dashboard on loopback
// (/hub/p/<name>) and one of these keys, made for it. A key works only for a request that came in on a loopback socket
// without a proxy header, and only until it expires (a session's own length) or it is revoked. Only the SHA-256 of a key
// is kept (one file each in <state>/hub-keys, mode 600), so a dashboard restart does not cut a session that is still
// running, a terminal's launcher can make a key without the dashboard, and nobody who reads the files finds a key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { replaceFile } from '../replacefile.mjs';

export const HL_RE = /^hop_hl_[A-Za-z0-9_-]{43}$/;
export const SESSION_TTL_MS = 12 * 3600_000;
const dir = () => path.join(stateDir(), 'hub-keys');
const sha256hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const fileOf = (key) => path.join(dir(), `${sha256hex(key)}.json`);

/** A new key for one session of provider `row` (the hub provider's name). Returns the key; only its hash is kept. */
export function mintKey({ row, ttlMs = SESSION_TTL_MS, now = Date.now(), pid = process.pid } = {}) {
  const key = 'hop_hl_' + crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const file = fileOf(key);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ row: String(row || ''), expires: now + ttlMs, pid: Number.isInteger(pid) && pid > 0 ? pid : null }), { mode: 0o600 });
  replaceFile(`${file}.tmp`, file);
  sweep(now);
  return key;
}

// Keys that ran out are removed now and then (never more than once a minute per process).
let swept = 0;
function sweep(now) {
  if (now - swept < 60_000) return;
  swept = now;
  try {
    for (const f of fs.readdirSync(dir())) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')).expires <= now) fs.rmSync(path.join(dir(), f), { force: true });
      } catch {
        /* being written */
      }
    }
  } catch {
    /* none yet */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The session ended: revoke the hub keys in the environment it had (the launcher calls this when the tool exits). */
export function revokeSessionKeys(env = {}) {
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) if (HL_RE.test(String(env[k] || ''))) revokeKey(env[k]);
}

/**
 * A chat, a Work run or Tia starts her tool from the dashboard's own process: the keys in its environment were made there, so
 * they would live as long as the dashboard (12 hours). Here they are tied to the tool's own process instead: they end when
 * it exits (revoked at once), and a key is refused while that process is gone whatever happens to the exit event.
 */
export function endWith(child, env = {}) {
  if (!child || typeof child.once !== 'function') return;
  const pid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) {
    const key = String(env[k] || '');
    if (!HL_RE.test(key) || !pid) continue;
    try {
      const file = fileOf(key);
      const e = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...e, pid }), { mode: 0o600 });
      replaceFile(`${file}.tmp`, file);
    } catch {
      /* the key is not one of this computer's */
    }
  }
  const end = () => revokeSessionKeys(env);
  child.once('exit', end);
  child.once('close', end);
}

/** The row a key was made for, or null: unknown, expired, or revoked. */
export function keyRow(key, now = Date.now()) {
  if (!HL_RE.test(String(key))) return null;
  try {
    const e = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    // A key lives as long as the process that made it for its session (the launcher of that session): when that is gone
    // the session is over, and so is the key, whatever its 12 hours say.
    return e && e.expires > now && (!e.pid || alive(e.pid)) ? e.row : null;
  } catch {
    return null;
  }
}

export function revokeKey(key) {
  if (!HL_RE.test(String(key))) return false;
  try {
    fs.rmSync(fileOf(key));
    return true;
  } catch {
    return false;
  }
}

export function revokeAll() {
  fs.rmSync(dir(), { recursive: true, force: true });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
/** A request that came in on a loopback socket, with no sign of a proxy (a proxy on this computer would make it look local). */
export const fromLoopback = (req) => !!req.socket && LOOPBACK.has(req.socket.remoteAddress) && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);

/** The hop_hl_ key a request presents: as a bearer token or as x-api-key. */
export function presentedKey(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  if (m) return m[1];
  const x = req.headers['x-api-key'];
  return typeof x === 'string' && x ? x.trim() : null;
}
