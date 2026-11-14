// Login: one password (scrypt hash in config.json), random session tokens in a cookie, and a login rate limit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt cost. N=2^15, r=8 needs 32 MiB per hash; maxmem leaves room for it. Kept in the hash string so it can
// be raised later without breaking old hashes.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const maxmem = (n, r) => 256 * n * r;

/** "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('empty password');
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Constant-time check of `password` against a stored hash. A malformed hash never matches. */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isInteger) || n < 2 || n > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const want = Buffer.from(parts[5], 'base64url');
  if (!salt.length || !want.length) return false;
  let got;
  try {
    got = await scrypt(password.normalize('NFKC'), salt, want.length, { N: n, r, p, maxmem: maxmem(n, r) });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(got, want);
}

/** A strong random password for `passwd --generate`: 24 random bytes, 32 URL-safe characters. */
export const generatePassword = () => crypto.randomBytes(24).toString('base64url');

export const SESSION_DAYS = 30;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Logged-in browser sessions. The cookie holds a random token; the file holds only its SHA-256, so a copy of the
 * state file cannot be used as a cookie. Persisted so that restarting the server does not log anyone out.
 */
export class SessionStore {
  constructor(file, { now = Date.now, days = SESSION_DAYS } = {}) {
    this.file = file;
    this.now = now;
    this.ttl = days * 24 * 3600 * 1000;
    this.map = new Map();
    this.#load();
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [h, s] of Object.entries(data)) if (s && s.expires > this.now()) this.map.set(h, s);
    } catch {
      /* no file yet, or unreadable: start empty (everyone logs in again) */
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /**
   * Make a new session; returns the token for the cookie. `tag` ties it to the current password (a hash of the
   * password hash), so setting a new password logs every browser out at once, even while the server runs.
   */
  create(tag = '') {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    for (const [h, s] of this.map) if (s.expires <= t) this.map.delete(h);
    this.map.set(sha256(token), { created: t, expires: t + this.ttl, tag });
    this.#save();
    return token;
  }

  valid(token, tag = '') {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return false;
    const s = this.map.get(sha256(token));
    if (!s || (s.tag || '') !== tag) return false;
    if (s.expires <= this.now()) {
      this.map.delete(sha256(token));
      return false;
    }
    return true;
  }

  destroy(token) {
    if (typeof token === 'string' && this.map.delete(sha256(token))) this.#save();
  }

  clear() {
    this.map.clear();
    this.#save();
  }
}

/**
 * Failed-login limiter: at most `perIp` failures per IP and `global` failures overall in `windowMs`. The global
 * cap stops a slow spread-out guess from many addresses; it can also lock the owner out for a while during an
 * attack, which is the right trade for a page that controls the whole PC.
 */
export class RateLimiter {
  constructor({ perIp = 5, global = 30, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { perIp, global, windowMs, now });
    this.byIp = new Map();
    this.all = [];
  }

  #prune(list) {
    const cut = this.now() - this.windowMs;
    while (list.length && list[0] <= cut) list.shift();
    return list;
  }

  /** Milliseconds until `ip` may try again, or 0 when it may try now. */
  retryAfter(ip) {
    const mine = this.#prune(this.byIp.get(ip) || []);
    const all = this.#prune(this.all);
    let wait = 0;
    if (mine.length >= this.perIp) wait = Math.max(wait, mine[0] + this.windowMs - this.now());
    if (all.length >= this.global) wait = Math.max(wait, all[0] + this.windowMs - this.now());
    return wait;
  }

  fail(ip) {
    const mine = this.#prune(this.byIp.get(ip) || []);
    mine.push(this.now());
    this.byIp.set(ip, mine);
    this.all.push(this.now());
    if (this.byIp.size > 10000) this.byIp.clear(); // bound memory under a flood of addresses
  }

  /**
   * A login worked. The try was counted with fail() before the password was checked (see the login handler), so
   * take it back: this address starts clean and the overall count loses the one entry it added.
   */
  succeed(ip) {
    this.byIp.delete(ip);
    this.all.pop();
  }
}

/** Parse a Cookie header into an object (first value wins). */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export const COOKIE = 'sid';

export function sessionCookie(token, { secure, maxAgeSec = SESSION_DAYS * 24 * 3600 }) {
  return [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, secure ? 'Secure' : '']
    .filter(Boolean)
    .join('; ');
}

export const clearCookie = (secure) => sessionCookie('', { secure, maxAgeSec: 0 });
