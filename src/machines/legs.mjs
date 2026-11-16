// Whether the leg between a hub and another computer is encrypted, seen from both ends. The administrator (sudo)
// password of a Setup job may be typed on the hub's page for another computer only when it is (docs/PC-SETUP.md).
//
// Encrypted legs: SSH (the hub's tunnel, or the computer's own reverse tunnel: via "ssh" and "join"), an https
// address (via "url"), and a direct link whose WebSocket reached the hub over TLS (via "link"; a hub with a pinned
// certificate is reached that way). Everything else is plain: http, ws.
//
// The hub decides from what it knows: the machine's address, or how the link's WebSocket arrived. It refuses to relay
// a body with `password` on a plain leg, and on an encrypted one tells the computer so (LEG_HEADER).
// The computer decides from what it sees and trusts nothing it cannot tell: a request from the network straight to
// its own plain HTTP is plain; one from a proxy on this computer that says http is plain; a request the link carried
// is as encrypted as that link's address; anything else on loopback (an SSH tunnel) only with the hub's word for it,
// so an older hub that does not check gets no password through.
import { Readable } from 'node:stream';
import { loadConfig } from '../config.mjs';
import { loopbackPeer } from '../server/security.mjs';

export const LEG_HEADER = 'x-hoprig-leg';
const first = (v) => (Array.isArray(v) ? v[0] : v);
const forwardedProto = (req) => {
  const p = first(req.headers && req.headers['x-forwarded-proto']);
  return typeof p === 'string' ? p.split(',')[0].trim().toLowerCase() : null;
};

// ---- the hub's end ----

const trustsProxy = () => {
  try {
    return loadConfig().server.trustProxy === true;
  } catch {
    return false;
  }
};

/**
 * A link's WebSocket arrived over TLS: on this socket, or through a TLS front on this computer (Caddy, cloudflared):
 * the connection then comes from loopback, and either the front says https (counted only with server.trustProxy on,
 * as for the login cookie) or the linked computer says it dialed wss (LEG_HEADER, sent by LinkClient). From any other
 * address a plain socket is a plain leg, whatever it says.
 */
export function upgradeEncrypted(req, trustProxy = trustsProxy()) {
  const s = req.socket || {};
  if (s.encrypted) return true;
  if (!loopbackPeer(s.remoteAddress)) return false;
  return first(req.headers && req.headers[LEG_HEADER]) === 'wss' || (trustProxy && forwardedProto(req) === 'https');
}

/** Is the leg to machine `m` encrypted? `linkEncrypted(linkId)`: how that link's live WebSocket arrived. */
export function legEncrypted(m, linkEncrypted = () => false) {
  if (m.via === 'ssh' || m.via === 'join') return true;
  if (m.via === 'url') return /^https:\/\//i.test(String(m.url));
  if (m.via === 'link') return linkEncrypted(m.linkId) === true;
  return false;
}

/** True when a JSON body carries a `password`. Anything that is not a JSON object carries none the computer reads. */
export function hasPassword(text) {
  try {
    const b = JSON.parse(text);
    return !!b && typeof b === 'object' && !Array.isArray(b) && Object.hasOwn(b, 'password');
  } catch {
    return false;
  }
}

/** What the hub answers instead of relaying a password over a plain leg. `page`: that computer's own page, if known. */
export const plainLegRefusal = (label, page) => ({
  error: `The password is asked only on ${label}'s own page, because the connection from this dashboard to ${label} is not encrypted.`,
  code: 'plain-leg',
  page: page || null,
});

const BODY_MAX = 1024 * 1024; // no API but an upload takes more than 64 KiB; an upload is raw bytes, never a password

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size <= max) chunks.push(c);
  }
  return size > max ? null : Buffer.concat(chunks);
}

/** A stand-in for `req` that sends `buf` again: what relayHttp reads (method, headers, the body). */
function replay(req, buf) {
  const r = Readable.from(buf.length ? [buf] : []);
  r.method = req.method;
  r.headers = { ...req.headers, 'content-length': String(buf.length) };
  return r;
}

/**
 * Before the hub relays `req` to machine `m`: { req, headers } to relay (headers: the hub's word that the leg is
 * encrypted), or { refused: { status, body } }. On a plain leg a body is read first (an upload excepted) and not sent
 * at all when it carries a password. On an encrypted leg nothing is held up: the body streams as before.
 */
export async function relayLeg(req, m, encrypted, { path = '' } = {}) {
  if (encrypted) return { req, headers: { [LEG_HEADER]: 'encrypted' } };
  if (req.method === 'GET' || req.method === 'HEAD' || /\/upload$/.test(path)) return { req, headers: {} };
  const buf = await readBody(req, BODY_MAX);
  if (buf === null) return { refused: { status: 413, body: { error: 'too large' } } };
  if (hasPassword(buf.toString('utf8'))) return { refused: { status: 403, body: plainLegRefusal(m.label || m.name, m.via === 'url' ? m.url : null) } };
  return { req: replay(req, buf), headers: {} };
}

// ---- the computer's end ----

// The local port of each connection the direct link opened to this dashboard, and whether that link is encrypted.
const linkPorts = new Map();

/** Note a connection the link (link.mjs) makes to this dashboard, so a request on it is judged by that link. */
export function noteLinkSocket(sock, encrypted) {
  sock.once('connect', () => {
    const port = sock.localPort;
    linkPorts.set(port, encrypted === true);
    sock.once('close', () => linkPorts.delete(port));
  });
  return sock;
}

/** Can this computer tell that request `req` reached it over an encrypted leg? */
export function arrivedEncrypted(req) {
  const s = req.socket || {};
  if (s.encrypted) return true;
  if (!loopbackPeer(s.remoteAddress)) return false;
  const proto = forwardedProto(req);
  if (proto !== null && proto !== 'https') return false;
  const viaLink = linkPorts.get(s.remotePort);
  if (viaLink !== undefined) return viaLink;
  return first(req.headers && req.headers[LEG_HEADER]) === 'encrypted';
}
