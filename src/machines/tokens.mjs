// "Who may control this computer": bearer tokens that other hoprig dashboards use to reach this one.
//
// config.json, server.tokens: [{ id, name, hash, created }]. Only the token's SHA-256 is kept, so a copy of the
// config cannot be used to log in. The last time each token was used is kept apart, in <stateDir>/token-use.json:
// the running dashboard notes every use, and writing config.json for that would race with the CLI changing it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { tokenName } from './names.mjs';
import { recordHubActivity, revokedWords } from './tokenaudit.mjs';

export const TOKEN_PREFIX = 'hop_';
const TOKEN_RE = /^hop_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const TOUCH_EVERY_MS = 5 * 60_000; // a busy hub must not write a file on every request

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const useFile = () => path.join(stateDir(), 'token-use.json');

/** The stored entries that look right. Anything else in the list is ignored, never trusted. */
export function storedTokens(cfg = loadConfig()) {
  const list = cfg.server && Array.isArray(cfg.server.tokens) ? cfg.server.tokens : [];
  return list.filter((t) => t && ID_RE.test(t.id) && /^[0-9a-f]{64}$/.test(t.hash) && typeof t.name === 'string');
}

/**
 * Make a token for the computer called `name`. Returns { id, token }; the token is shown once and never stored.
 * `hub`: it is for a hub the owner added this computer to (by SSH, or with a pairing code he made): the Workspace
 * page's own acts relayed from that hub's page count as his (src/workspace/whomay.mjs).
 */
export function createToken(name, { now = Date.now(), hub = false } = {}) {
  const clean = tokenName(name);
  if (!clean) throw new Error('the name must be 1 to 60 letters, digits, spaces or ._@()-');
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomBytes(6).toString('hex');
  saveConfig({ server: { tokens: [...storedTokens(), { id, name: clean, hash: sha256(token), created: now, ...(hub ? { hub: true } : {}) }] } });
  return { id, token };
}

/**
 * The entry a presented token belongs to, or null. Every stored hash is compared in constant time, so the answer
 * takes as long for a near miss as for a far one.
 */
export function verifyToken(token, list = storedTokens()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const got = Buffer.from(sha256(token), 'hex');
  let found = null;
  for (const t of list) {
    if (crypto.timingSafeEqual(got, Buffer.from(t.hash, 'hex')) && !found) found = t;
  }
  return found;
}

/**
 * Mark the token `id` as a hub's of the owner's, or take the mark away (`hub`: true or false). A token made before the
 * mark existed (an older `hoprig pair --json`, or a hub that runs an older Hoprig) is plain: the owner marks it here,
 * on this computer's own page. → the public entry, or null when there is no such token.
 */
export function markHub(id, hub) {
  const list = storedTokens();
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  const next = list.map((x) => {
    if (x !== t) return x;
    const { hub: _, ...rest } = x;
    return hub ? { ...rest, hub: true } : rest;
  });
  saveConfig({ server: { tokens: next } });
  recordHubActivity(hub ? `The token of ${t.name} was marked as your main computer` : `The token of ${t.name} is no longer marked as your main computer`);
  return publicToken(next.find((x) => x.id === id), readUse());
}

const revokeListeners = new Set();
/**
 * Call `fn({ id, name, keys })` after each revoke (`keys`: how many gateway keys ended with it). Returns the function
 * that removes it. Listeners run after the revoke is saved, never awaited and each on its own, so one that fails or
 * takes long can never stop or slow a revoke.
 */
export function onRevoke(fn) {
  revokeListeners.add(fn);
  return () => revokeListeners.delete(fn);
}

/**
 * Revoke by id, or every token with that name. Returns the entries removed. The gateway keys a token made (a hub's
 * "Use here", src/gateway/keys.mjs) end with it, in the same write: every way of revoking comes through here.
 * Each revoke is a line in the Activity log; `{ log: false }` only for a token that never came into use (a link or
 * a join that failed takes back the token it had just made).
 */
export function revokeToken(idOrName, { log = true } = {}) {
  const cfg = loadConfig();
  const list = storedTokens(cfg);
  const gone = list.filter((t) => t.id === idOrName || t.name === idOrName);
  const keys = new Map();
  if (gone.length) {
    const ids = new Set(gone.map((t) => t.id));
    const patch = { server: { tokens: list.filter((t) => !gone.includes(t)) } };
    const g = cfg.gateways;
    if (g && typeof g === 'object' && Array.isArray(g.keys)) {
      for (const k of g.keys) if (k && ids.has(k.token)) keys.set(k.token, (keys.get(k.token) || 0) + 1);
      patch.gateways = { ...g, keys: g.keys.filter((k) => !(k && ids.has(k.token))) };
    }
    saveConfig(patch);
  }
  for (const t of gone) {
    const ev = { id: t.id, name: t.name, keys: keys.get(t.id) || 0 };
    // In the Activity log here, by the process that revoked it (the page, `hoprig tokens revoke`, a hub's Remove),
    // so the line has the token's name even when no dashboard was running.
    if (log) recordHubActivity(revokedWords(ev.name, ev.keys));
    for (const fn of [...revokeListeners]) {
      queueMicrotask(() => {
        try {
          Promise.resolve(fn(ev)).catch(() => {});
        } catch {
          /* a listener never fails a revoke */
        }
      });
    }
  }
  return gone.map(publicToken);
}

function readUse() {
  try {
    const data = JSON.parse(fs.readFileSync(useFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

const lastWrite = new Map();
/** Note that token `id` was used. Written at most every few minutes per token. */
export function touchToken(id, { now = Date.now() } = {}) {
  if (now - (lastWrite.get(id) || 0) < TOUCH_EVERY_MS) return;
  lastWrite.set(id, now);
  try {
    const use = readUse();
    use[id] = now;
    const live = new Set(storedTokens().map((t) => t.id));
    for (const k of Object.keys(use)) if (!live.has(k)) delete use[k];
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${useFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(use) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, useFile());
  } catch {
    /* only a convenience: never fail a request over it */
  }
}

const publicToken = (t, use = {}) => ({ id: t.id, name: t.name, created: t.created || null, lastUsed: use[t.id] || null, hub: t.hub === true });

/** What the CLI and the page show: never the hash. */
export const listTokens = () => {
  const use = readUse();
  return storedTokens().map((t) => publicToken(t, use));
};

/** The token from an `Authorization: Bearer ...` header; null when there is none (other schemes count as none). */
export function bearerOf(req) {
  const h = req.headers && req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}
