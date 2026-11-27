// The keys of the encrypted move of credentials between the owner's computers (credmove.mjs), and the sealed message.
//
// Each computer makes ONE X25519 key and ONE Ed25519 key, once, in its state folder (`transfer-keys.json`, mode 600).
// Only the public halves go anywhere: into this computer's own file of the AI brain (`keys`, computer.mjs), which is
// the trust anchor. Another computer's public keys are read from the brain and PINNED here (`transfer-pins.json`) the
// first time they are used; a key that later differs from the pin blocks every send and receive with that computer
// until the owner presses Trust on this computer's page (trustPeer).
//
// A message is standard constructions of Node's own crypto, nothing home-made:
//   - an ephemeral X25519 key of the sender with the receiver's X25519 key gives a shared secret;
//   - HKDF-SHA256 (a random salt, and a context string that names the purpose and BOTH computers) gives the key;
//   - AES-256-GCM with the header (who, to whom, the one-time nonce, the scope, the time) as associated data;
//   - an Ed25519 signature of the sender over the whole sealed message (header, ciphertext and tag).
// The sealed bytes are JSON of base64 fields: { v, h (the header), c, t, s }.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { replaceFile } from '../replacefile.mjs';
import { computersHere } from './computer.mjs';

// `details`: what the server puts in its answer besides the message, so a page can tell a changed key from a stale list.
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code, details: { code } } : {}) });
const b64 = (b) => Buffer.from(b).toString('base64');
const DOMAIN = Buffer.from('hoprig credmove v1 signature\0');
export const PURPOSE = 'hoprig credmove v1';
/** How old a sealed message may be when it is opened. */
export const MAX_AGE_MS = 15 * 60 * 1000;

export const keysFile = () => path.join(stateDir(), 'transfer-keys.json');
export const pinsFile = () => path.join(stateDir(), 'transfer-pins.json');

const KINDS = ['x25519', 'ed25519'];

/** A public key from its text (base64 of the SPKI form) as a key object, only of this kind; else null. */
export function parsePublic(kind, text) {
  if (typeof text !== 'string' || text.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === kind && b64(k.export({ format: 'der', type: 'spki' })) === text ? k : null;
  } catch {
    return null;
  }
}

/** The public keys of an object that should hold both: { x25519, ed25519 } as text; else null. */
export function cleanPublic(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return KINDS.every((k) => parsePublic(k, v[k])) ? { x25519: v.x25519, ed25519: v.ed25519 } : null;
}

function writeOwnerOnly(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  replaceFile(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** This computer's keys as the file holds them, or null (none made, or the file does not hold both). */
function stored() {
  const f = readJson(keysFile());
  if (!f || !KINDS.every((k) => f[k] && typeof f[k].priv === 'string' && parsePublic(k, f[k].pub))) return null;
  return f;
}

/** This computer's PUBLIC keys as text ({ x25519, ed25519 }), or null while none were made. */
export function publicKeys() {
  const f = stored();
  return f ? { x25519: f.x25519.pub, ed25519: f.ed25519.pub } : null;
}

/** Make this computer's keys once (never again). → { x25519, ed25519 } the public keys as text. */
export function ensureKeys() {
  const have = publicKeys();
  if (have) return have;
  const out = { made: new Date().toISOString() };
  for (const k of KINDS) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync(k);
    out[k] = { pub: b64(publicKey.export({ format: 'der', type: 'spki' })), priv: b64(privateKey.export({ format: 'der', type: 'pkcs8' })) };
  }
  writeOwnerOnly(keysFile(), `${JSON.stringify(out, null, 2)}\n`);
  return { x25519: out.x25519.pub, ed25519: out.ed25519.pub };
}

function privateKey(kind) {
  const f = stored();
  if (!f) throw fail(409, 'this computer has no transfer key yet', 'key-none');
  return crypto.createPrivateKey({ key: Buffer.from(f[kind].priv, 'base64'), format: 'der', type: 'pkcs8' });
}

// ---- the other computers' keys ----

const pins = () => {
  const p = readJson(pinsFile());
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
};
const savePins = (p) => writeOwnerOnly(pinsFile(), `${JSON.stringify(p, null, 2)}\n`);
const same = (a, b) => a && b && a.id === b.id && a.x25519 === b.x25519 && a.ed25519 === b.ed25519;

/**
 * The public keys of the computer `label`, from its file in the brain and the pin made here. → { id, x25519, ed25519
 * (key objects), raw, state: 'new' | 'ok' }. Throws 409 { code: 'key-unknown' } when the brain has no key for it, and
 * 409 { code: 'key-changed' } when the brain's key is not the pinned one.
 */
export function peerKeys({ label, dir }) {
  const file = computersHere(dir).files.find((f) => f.label === label);
  const inBrain = file && file.keys ? { id: file.id, ...file.keys } : null;
  const pin = pins()[label] || null;
  let state = 'ok';
  let use = pin;
  if (inBrain) {
    if (pin && !same(pin, inBrain)) throw fail(409, `The key of ${label} is not the one you trusted before. Press Trust for ${label} if you changed that computer, and only then.`, 'key-changed');
    if (!pin) {
      savePins({ ...pins(), [label]: inBrain });
      state = 'new';
    }
    use = inBrain;
  }
  if (!use) throw fail(409, `${label} has no transfer key in your AI brain yet: open its page once, save the brain there and here, then try again`, 'key-unknown');
  return { id: use.id, x25519: parsePublic('x25519', use.x25519), ed25519: parsePublic('ed25519', use.ed25519), raw: { x25519: use.x25519, ed25519: use.ed25519 }, state };
}

/** The state of the computer's key for the page: 'ok' | 'new' | 'changed' | 'none'. Pins nothing. */
export function peerState({ label, dir }) {
  const file = computersHere(dir).files.find((f) => f.label === label);
  const inBrain = file && file.keys ? { id: file.id, ...file.keys } : null;
  const pin = pins()[label] || null;
  if (inBrain) return !pin ? 'new' : same(pin, inBrain) ? 'ok' : 'changed';
  return pin ? 'ok' : 'none';
}

/**
 * The owner's Trust: the pin of `label` becomes what the brain says now. Only the brain is the anchor: a key that came
 * over the relay or the link (an answer of the other computer) is never taken, it could be put there by whoever is on
 * the path. A computer the brain does not know yet is known after its page saved the brain there and this one updated.
 */
export function trustPeer({ label, dir }) {
  const file = computersHere(dir).files.find((f) => f.label === label);
  const take = file && file.keys ? { id: file.id, ...file.keys } : null;
  if (!take) throw fail(409, `${label} has no transfer key in your AI brain yet: open its page, save the brain there, update it here, then try again`, 'key-unknown');
  savePins({ ...pins(), [label]: take });
  return { label, state: 'ok' };
}

// ---- the sealed message ----

const info = (h) => Buffer.from(`${PURPOSE}|from ${h.from} ${h.fromId}|to ${h.to} ${h.toId}`);
const sealKey = (shared, salt, h) => Buffer.from(crypto.hkdfSync('sha256', shared, salt, info(h), 32));
const signed = (hb, c, t) => Buffer.concat([DOMAIN, ...[hb, c, t].map((x) => Buffer.concat([Buffer.from(String(x.length).padStart(10, '0')), x]))]);

/**
 * Seal `plain` for the computer `to` ({ label, id, x25519 key object }) from this computer `me` ({ label, id }). `nonce`:
 * the receiver's one-time nonce, `scope`: what it holds (a small plain object, in the header). → the sealed bytes.
 */
export function seal({ me, to, nonce, scope, plain, now = Date.now() }) {
  const eph = crypto.generateKeyPairSync('x25519');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = { v: 1, purpose: PURPOSE, from: me.label, fromId: me.id, to: to.label, toId: to.id, nonce, scope, at: now, eph: b64(eph.publicKey.export({ format: 'der', type: 'spki' })), salt: b64(salt), iv: b64(iv) };
  const hb = Buffer.from(JSON.stringify(header));
  const key = sealKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: to.x25519 }), salt, header);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(hb);
  const c = Buffer.concat([cipher.update(plain), cipher.final()]);
  const t = cipher.getAuthTag();
  const s = crypto.sign(null, signed(hb, c, t), privateKey('ed25519'));
  return Buffer.from(JSON.stringify({ v: 1, h: b64(hb), c: b64(c), t: b64(t), s: b64(s) }));
}

/** The header of a sealed message, read and shape-checked, NOT yet trusted. → { header, parts } */
function parts(sealed) {
  let m;
  try {
    m = JSON.parse(Buffer.from(sealed).toString('utf8'));
  } catch {
    throw fail(400, 'this is not a sealed message');
  }
  if (!m || typeof m !== 'object' || m.v !== 1 || !['h', 'c', 't', 's'].every((k) => typeof m[k] === 'string')) throw fail(400, 'this is not a sealed message of this version');
  const [hb, c, t, s] = ['h', 'c', 't', 's'].map((k) => Buffer.from(m[k], 'base64'));
  let h;
  try {
    h = JSON.parse(hb.toString('utf8'));
  } catch {
    throw fail(400, 'the header of the sealed message cannot be read');
  }
  const ok = h && typeof h === 'object' && h.v === 1 && h.purpose === PURPOSE && ['from', 'fromId', 'to', 'toId', 'nonce', 'eph', 'salt', 'iv'].every((k) => typeof h[k] === 'string') && Number.isFinite(h.at) && t.length === 16 && s.length === 64;
  if (!ok) throw fail(400, 'the header of the sealed message is not right');
  return { header: h, hb, c, t, s };
}

/**
 * Open a sealed message on the computer `me` ({ label, id }). `peerOf(label)`: the sender's Ed25519 key object (from
 * peerKeys: a changed key throws there). Checks, in this order: the receiver, the sender's signature over the whole
 * message, the age; then decrypts. → { header, plain }. Nothing is trusted before the signature is checked.
 */
export function open(sealed, { me, peerOf, now = Date.now() }) {
  const { header: h, hb, c, t, s } = parts(sealed);
  if (h.to !== me.label || h.toId !== me.id) throw fail(403, 'this message is not for this computer');
  const senderKey = peerOf(h.from, h.fromId);
  if (!crypto.verify(null, signed(hb, c, t), senderKey, s)) throw fail(403, 'the signature is not the sender\'s: the message was changed or is not from that computer');
  if (now - h.at > MAX_AGE_MS || h.at - now > MAX_AGE_MS) throw fail(403, 'this message is too old or from another time: make it again');
  const ephKey = parsePublic('x25519', h.eph);
  if (!ephKey) throw fail(400, 'the header of the sealed message is not right');
  try {
    const key = sealKey(crypto.diffieHellman({ privateKey: privateKey('x25519'), publicKey: ephKey }), Buffer.from(h.salt, 'base64'), h);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(h.iv, 'base64'));
    d.setAAD(hb);
    d.setAuthTag(t);
    return { header: h, plain: Buffer.concat([d.update(c), d.final()]) };
  } catch (e) {
    if (e.status) throw e;
    throw fail(403, 'the message could not be opened: it was changed or is not for this computer');
  }
}

/** The header of a sealed message, only to read who it is from (before it is opened); never trusted by itself. */
export const headerOf = (sealed) => parts(sealed).header;
