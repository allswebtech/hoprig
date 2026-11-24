// A hub whose HTTPS certificate was made by itself (Caddy's `tls internal`, for a hub reached by a private IP
// address): how another computer trusts it without turning verification off.
//
// What is pinned: the public key of the hub's certificate AUTHORITY (Caddy's local root, valid for ten years), as
//   sha256:<43 characters>   = "sha256:" + base64url(SHA-256(the DER SubjectPublicKeyInfo)), no padding.
// Not the server certificate: Caddy renews it every few hours (and the intermediate every few days), which would
// break every joined computer each time. The root key stays the same until Caddy's data folder is lost (a reinstall)
// or the root expires; then the hub shows a new line and each computer joins again (it is told so in plain words).
//
// The fingerprint travels with the join code, which the person already carries from the hub to the other computer
// (read on the hub's page or terminal, typed there): the same trusted hand-over. Joining with it:
//   1. a normal, verified connection. Trusted by a public authority: fine (a given fingerprint must still be in the
//      verified chain). Otherwise, without a fingerprint: refused, saying where to read the full line.
//   2. with a fingerprint: the authority's certificate is taken from what the hub presents, or from GET
//      /api/link/ca (public material, fetched without sending anything secret), and kept only when its key matches
//      the fingerprint (constant-time compare).
//   3. a verified connection again, with that certificate as the ONLY authority, the host name checked as usual,
//      and the fingerprint checked in the chain. Only then is the code sent.
// The joined computer keeps the fingerprint and the authority's certificate with the join, and every later
// connection (the link, its reconnects, leaving) verifies against them the same way. Verification is never off.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export const PIN_RE = /^sha256:[A-Za-z0-9_-]{43}$/;
const FORMAT = 'sha256: followed by 43 letters, digits, - or _ (as the main computer shows it)';

export class TrustError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The fingerprint in its one accepted form, or null. Strict: 32 bytes that encode back to exactly the same text. */
export function parsePin(s) {
  if (typeof s !== 'string' || !PIN_RE.test(s)) return null;
  const raw = Buffer.from(s.slice(7), 'base64url');
  return raw.length === 32 && raw.toString('base64url') === s.slice(7) ? s : null;
}

/** An X509Certificate from PEM text, DER bytes or one already parsed; null when it is not a certificate. */
export function toX509(c) {
  try {
    return c instanceof crypto.X509Certificate ? c : new crypto.X509Certificate(c);
  } catch {
    return null;
  }
}

const spkiHash = (x) => crypto.createHash('sha256').update(x.publicKey.export({ type: 'spki', format: 'der' })).digest();

/** The fingerprint of a certificate's public key. */
export function pinOf(cert) {
  const x = toX509(cert);
  if (!x) throw new TrustError('bad-certificate', 'not a certificate', 400);
  return `sha256:${spkiHash(x).toString('base64url')}`;
}

/** Does `cert`'s public key have the fingerprint `pin`? Compared in constant time. */
export function pinMatches(pin, cert) {
  const p = parsePin(pin);
  const x = toX509(cert);
  if (!p || !x) return false;
  return crypto.timingSafeEqual(Buffer.from(p.slice(7), 'base64url'), spkiHash(x));
}

/** The DER certificates of a peer chain (getPeerCertificate(true)), leaf first, each once. */
export function chainOf(peer) {
  const out = [];
  const seen = new Set();
  for (let c = peer; c && c.raw && !seen.has(c); c = c.issuerCertificate) {
    seen.add(c);
    out.push(c.raw);
  }
  return out;
}

/** A certificate's PEM text. */
export const pemOf = (cert) => toX509(cert).toString();

// The errors that mean "nobody this computer trusts signed it" (as opposed to a wrong name, an expired
// certificate, or no answer at all).
const UNTRUSTED = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE']);
export const isUntrusted = (e) => !!e && UNTRUSTED.has(e.code);
const isTlsProblem = (e) => !!e && (isUntrusted(e) || e.code === 'PIN_MISMATCH' || /^(ERR_TLS_|CERT_|ERR_SSL_)/.test(String(e.code || '')));

/**
 * TLS options for every connection to a hub joined with `pin` (and, for a hub with its own authority, `ca`): that
 * certificate as the only authority, the host name checked as usual, and the fingerprint somewhere in the verified
 * chain. `{}` for a hub joined without a fingerprint (public authorities, as before).
 */
export function trustOptions({ pin = null, ca = null } = {}, host = null) {
  if (!pin) return {};
  return {
    ...(ca ? { ca: [ca] } : {}),
    checkServerIdentity(servername, peer) {
      const bad = tls.checkServerIdentity(host || servername, peer);
      if (bad) return bad;
      if (chainOf(peer).some((der) => pinMatches(pin, der))) return undefined;
      return Object.assign(new Error(`no certificate in the chain matches ${pin}`), { code: 'PIN_MISMATCH' });
    },
  };
}

/** A TLS problem said plainly, for the link's status and errors. */
export function explainTls(e, { host, pin = null } = {}) {
  if (!e) return '';
  if (e.code === 'PIN_MISMATCH' || (pin && isUntrusted(e))) {
    return `${host}'s certificate is no longer signed by the authority this computer pinned when it joined (${pin}). Nothing was sent. If the main computer was set up again, show the join line there again and join with it.`;
  }
  if (isUntrusted(e)) return `${host}'s HTTPS certificate is not trusted (${e.message}).`;
  if (e.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `${host}'s certificate is made for another name or address (${e.message}).`;
  if (e.code === 'CERT_HAS_EXPIRED') return `${host}'s certificate has expired.`;
  return e.message;
}

/** One TLS handshake to `ep` (no HTTP). Resolves the peer chain (leaf first, DER); rejects with the TLS error. */
export function handshake(ep, { host = ep.hostname, verify = true, trust = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      host: ep.hostname, port: ep.port, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: verify,
      ...(verify ? { checkServerIdentity: (sn, peer) => tls.checkServerIdentity(host, peer) } : {}), ...trust,
    });
    const t = setTimeout(() => s.destroy(Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })), timeoutMs);
    s.once('secureConnect', () => {
      clearTimeout(t);
      const chain = chainOf(s.getPeerCertificate(true));
      s.end();
      resolve(chain);
    });
    s.once('error', (e) => {
      clearTimeout(t);
      s.destroy();
      reject(e);
    });
  });
}

/** GET <base>/api/link/ca without verifying (the answer is checked against the fingerprint). PEM or null. */
export function fetchHubAuthority(ep, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const r = https.request({ hostname: ep.hostname, port: ep.port, path: `${ep.basePath || ''}/api/link/ca`, method: 'GET', headers: { Accept: 'application/json' }, rejectUnauthorized: false, agent: false, ...(net.isIP(ep.hostname) ? {} : { servername: ep.hostname }) }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (c) => ((size += c.length) > 64 * 1024 ? r.destroy() : chunks.push(c)));
      res.on('end', () => {
        try {
          const pem = JSON.parse(Buffer.concat(chunks).toString('utf8')).certificate;
          resolve(typeof pem === 'string' && toX509(pem) ? pem : null);
        } catch {
          resolve(null);
        }
      });
    });
    r.setTimeout(timeoutMs, () => r.destroy());
    r.on('error', () => resolve(null));
    r.end();
  });
}

const offline = (host, e) => new TrustError('offline', `${host} cannot be reached (${e.message}).`);

/**
 * The trust for joining the hub at `ep` (an https endpoint), before any secret is sent. Resolves
 * { pin, ca } (both null for a publicly trusted hub joined without a fingerprint); throws a TrustError otherwise.
 */
export async function establishTrust(ep, rawPin, { host = ep.hostname, joinHint = 'the main computer', timeoutMs = 8000 } = {}) {
  const pin = rawPin == null || rawPin === '' ? null : parsePin(rawPin);
  if (rawPin != null && rawPin !== '' && !pin) throw new TrustError('bad-fingerprint', `that fingerprint is not in the right form: ${FORMAT}. Copy the whole line from ${joinHint}.`, 400);
  try {
    await handshake(ep, { host, trust: trustOptions({ pin }, host), timeoutMs });
    return { pin, ca: null };
  } catch (e) {
    if (e.code === 'PIN_MISMATCH') throw new TrustError('fingerprint', `${host} has a publicly trusted certificate, but nothing in its chain matches the fingerprint ${pin}. Nothing was sent. Check that you copied the whole line from ${joinHint}.`, 400);
    if (!isUntrusted(e)) throw isTlsProblem(e) ? new TrustError('tls', explainTls(e, { host }), 502) : offline(host, e);
    if (!pin) {
      throw new TrustError('untrusted', `${host}'s HTTPS certificate was made by the main computer itself, not by a public authority, so this computer cannot check it on its own. Hoprig does not turn the check off: copy the whole join line, which ends with --fingerprint sha256:…, from ${joinHint}.`, 400);
    }
  }
  // Its own authority: find the certificate whose key has this fingerprint.
  let presented = [];
  try {
    presented = await handshake(ep, { host, verify: false, timeoutMs });
  } catch (e) {
    throw offline(host, e);
  }
  let root = presented.find((der) => pinMatches(pin, der)) || null;
  if (!root) {
    const pem = await fetchHubAuthority(ep, { timeoutMs });
    if (pem && pinMatches(pin, pem)) root = pem;
  }
  if (!root) throw new TrustError('fingerprint', `${host}'s certificate does not match the fingerprint ${pin}. Nothing was sent. Check that you copied the whole line from ${joinHint}; if the main computer was set up again, show the line there again.`, 400);
  const ca = pemOf(root);
  try {
    await handshake(ep, { host, trust: trustOptions({ pin, ca }, host), timeoutMs });
  } catch (e) {
    if (isUntrusted(e) || e.code === 'PIN_MISMATCH') throw new TrustError('fingerprint', `${host}'s certificate is not signed by the authority with the fingerprint ${pin}. Nothing was sent.`, 400);
    throw isTlsProblem(e) ? new TrustError('tls', explainTls(e, { host }), 502) : offline(host, e);
  }
  return { pin, ca };
}

// ======================= the hub's side: its own fingerprint =======================

/** Where Caddy keeps its local authority's root on disk (readable only by its own user, often). */
export function caddyRootFiles(env = process.env, home = os.homedir()) {
  const rel = path.join('caddy', 'pki', 'authorities', 'local', 'root.crt');
  return [...new Set([
    env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, rel),
    path.join(home, '.local', 'share', rel), // Caddy run by this user (a container runs it as root)
    path.join('/var/lib/caddy/.local/share', rel), // the Debian/Ubuntu/Fedora package's caddy user
    path.join('/root/.local/share', rel),
  ].filter(Boolean))];
}

// Caddy's admin API listens here by default; the product asks it for the local CA. The test seal refuses a knock on
// this port (tools/seal-net.mjs reads this constant), so a test never reaches a Caddy the owner runs.
export const CADDY_ADMIN_PORT = 2019;

/**
 * Caddy's local authority root (PEM), or null. First its admin API (http://localhost:2019/pki/ca/local, on by default
 * and reachable by every user of this computer, also in a container), then its data folder.
 */
export async function caddyRoot({ admin = `http://127.0.0.1:${CADDY_ADMIN_PORT}`, files = caddyRootFiles(), timeoutMs = 2000 } = {}) {
  const viaApi = await new Promise((resolve) => {
    const r = http.get(`${admin}/pki/ca/local`, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')).root_certificate : null);
        } catch {
          resolve(null);
        }
      });
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(null));
  });
  if (typeof viaApi === 'string' && toX509(viaApi)) return pemOf(viaApi);
  for (const f of files) {
    try {
      const x = toX509(fs.readFileSync(f));
      if (x) return x.toString();
    } catch {
      /* not there, or not ours to read */
    }
  }
  return null;
}

/** How to read the fingerprint by hand on the hub (Caddy's package keeps its data there; run as root: ~root/.local/share). */
export const BY_HAND = 'sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt | hoprig machines fingerprint -';
export const MANUAL = `hoprig machines fingerprint   (or: ${BY_HAND})`;

const cache = new Map();

/**
 * What this hub's certificate at `base` is, for the join line:
 *   { kind: 'plain' }                 http://: no certificate (the line says --insecure where it applies)
 *   { kind: 'public' }                a public authority signed it: nothing more is needed
 *   { kind: 'own', pin, ca }          Caddy's own authority signed it: the line carries --fingerprint pin
 *   { kind: 'unknown', why }          it could not be found out: the line says so and names MANUAL
 * It asks the address through this computer's own 127.0.0.1 first (where Caddy listens, also when the public address
 * cannot be reached from inside: NAT, a container), then the address itself. Cached a few seconds (as /api/link/ca).
 */
export async function hubCertificate(base, { root = caddyRoot, timeoutMs = 3000, now = Date.now() } = {}) {
  let u;
  try {
    u = new URL(base);
  } catch {
    return { kind: 'unknown', why: 'this main computer has no address set' };
  }
  if (u.protocol !== 'https:') return { kind: 'plain' };
  const hit = cache.get(u.origin);
  if (hit && hit.until > now) return hit.value;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 443;
  const tries = [...new Set(['127.0.0.1', host])].map((h) => ({ hostname: h, port }));
  let value = null;
  let last = null;
  for (const ep of tries) {
    try {
      await handshake(ep, { host, timeoutMs });
      value = { kind: 'public' };
    } catch (e) {
      last = e;
      if (!isUntrusted(e)) continue; // nothing there, or another problem: try the next way
      const pem = await root();
      if (!pem) {
        value = { kind: 'unknown', why: 'its certificate is not publicly trusted, and Caddy\'s own authority could not be read here' };
        break;
      }
      const pin = pinOf(pem);
      try {
        await handshake(ep, { host, trust: trustOptions({ pin, ca: pem }, host), timeoutMs });
        value = { kind: 'own', pin, ca: pem };
      } catch {
        value = { kind: 'unknown', why: 'its certificate is not publicly trusted, and not signed by Caddy\'s own authority on this computer' };
      }
    }
    if (value) break;
  }
  value ||= { kind: 'unknown', why: `its own address did not answer here (${last ? last.message : 'no answer'})` };
  cache.set(u.origin, { value, until: now + 5000 });
  return value;
}

/** Forget what hubCertificate() found (tests; after setup changed the certificate). */
export const forgetHubCertificate = () => cache.clear();

/**
 * The line to type on the other computer, and a note when something about it must be said. `cert` from
 * hubCertificate(). Never contains anything secret but the one-time code itself, which is meant to be shown.
 */
export function joinCommand(base, code, cert, app = 'hoprig') {
  const url = String(base).replace(/\/+$/, '');
  const plain = cert && cert.kind === 'plain' && !/^http:\/\/(127\.|localhost[:/]|\[::1\])/.test(`${url}/`);
  const line = `${app} join ${url} ${code}${cert && cert.kind === 'own' ? ` --fingerprint ${cert.pin}` : ''}${plain ? ' --insecure' : ''}`;
  let note = null;
  if (cert && cert.kind === 'own') note = 'The fingerprint is that of this main computer\'s own certificate authority: with it, that computer checks it really talks to this main computer. It stays the same when the certificate renews.';
  if (cert && cert.kind === 'unknown') note = `This main computer could not check its own certificate (${cert.why}). If that computer says the certificate is not trusted, read the fingerprint here with: ${MANUAL}, and add --fingerprint <it> to the line.`;
  return { line, note };
}
