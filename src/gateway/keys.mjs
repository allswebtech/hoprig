// What this computer keeps about sharing its gateways, in config.json under "gateways" (file mode 600):
//
//   shared   { <gateway id>: { provider } }   sharing is on for that gateway and uses the key of that provider on
//                                            this computer; a missing entry means off (the safe default)
//   keys     [{ id, gateway, name, hash, created }]
//            gateway keys this computer made for other computers. Only a key's SHA-256 is kept, as for the machine
//            tokens (src/machines/tokens.mjs), so a copy of the config cannot be used to call the gateway.
import crypto from 'node:crypto';
import { loadConfig, saveConfig } from '../config.mjs';
import { tokenName } from '../machines/names.mjs';
import { validName } from '../profiles.mjs';

export const KEY_PREFIX = 'hop_gw_';
const KEY_RE = /^hop_gw_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{12}$/;
export const GATEWAY_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const looksLikeKey = (k) => typeof k === 'string' && KEY_RE.test(k);

function raw() {
  const g = loadConfig().gateways;
  return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
}
const save = (patch) => saveConfig({ gateways: { ...raw(), ...patch } });

// ---------- sharing ----------

/** The provider whose key a shared gateway uses, or null when sharing is off. */
export function sharedProvider(id) {
  const s = raw().shared?.[id];
  return s && typeof s === 'object' && validName(s.provider) ? s.provider : null;
}

/** Sharing on with `provider`'s key, or off (`provider` null). */
export function setShared(id, provider) {
  if (!GATEWAY_ID_RE.test(id)) throw new Error('not a gateway');
  const shared = { ...(raw().shared || {}) };
  if (provider) shared[id] = { provider };
  else delete shared[id];
  save({ shared });
}

// ---------- the keys other computers use ----------

/** The stored entries that look right; anything else in the list is ignored, never trusted. */
export function storedKeys() {
  const list = Array.isArray(raw().keys) ? raw().keys : [];
  return list.filter((k) => k && ID_RE.test(k.id) && GATEWAY_ID_RE.test(k.gateway) && /^[0-9a-f]{64}$/.test(k.hash) && typeof k.name === 'string');
}

/** A new key for the computer called `name`. Returns { id, key }: the key is shown once and never stored. */
export function createKey(gateway, name, { now = Date.now() } = {}) {
  if (!GATEWAY_ID_RE.test(gateway)) throw new Error('not a gateway');
  const clean = tokenName(name) || 'another computer';
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomBytes(6).toString('hex');
  save({ keys: [...storedKeys(), { id, gateway, name: clean, hash: sha256(key), created: now }] });
  return { id, key };
}

/**
 * The entry `key` belongs to for `gateway`, or null. Every stored hash is compared in constant time, so a near miss
 * takes as long as a far one.
 */
export function verifyKey(key, gateway, list = storedKeys()) {
  if (!looksLikeKey(key)) return null;
  const got = Buffer.from(sha256(key), 'hex');
  let found = null;
  for (const k of list) {
    if (crypto.timingSafeEqual(got, Buffer.from(k.hash, 'hex')) && !found && k.gateway === gateway) found = k;
  }
  return found;
}

export function removeKey(id) {
  const list = storedKeys();
  const gone = list.find((k) => k.id === id);
  if (gone) save({ keys: list.filter((k) => k !== gone) });
  return gone ? publicKey(gone) : null;
}

/** What a page may see of a key: never the hash. */
export const publicKey = (k) => ({ id: k.id, gateway: k.gateway, name: k.name, created: k.created || null });
export const listKeys = (gateway) => storedKeys().filter((k) => k.gateway === gateway).map(publicKey);
