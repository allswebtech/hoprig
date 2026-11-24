// HTTP hardening shared by every response: security headers, the Origin check that stops cross-site requests,
// and how to tell HTTPS and the client address when a reverse proxy sits in front.
import net from 'node:net';

const HOST_RE = /^[A-Za-z0-9.:[\]-]{1,300}$/;

/** Headers for every response. `host` is the validated Host header, used to allow the WebSocket of this page. */
export function securityHeaders(host) {
  const ws = host && HOST_RE.test(host) ? ` ws://${host} wss://${host}` : '';
  return {
    // Scripts only from this server, never inline. Styles allow 'unsafe-inline' because xterm.js injects <style>
    // elements for its theme and cell sizes at run time; inline styles cannot run code. Fonts also from data: URLs,
    // because the code editor (monaco) carries its icon font inside its style sheet; a font cannot run code.
    // Framing: only by this same site (the desktop shows its pages as windows, web/desktop/); a page of any other
    // site still cannot frame the dashboard, so it cannot trick a click on it. Nothing a user controls is served as
    // a document of this site, so no framed page can be someone else's.
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ` +
      `connect-src 'self'${ws}; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; ` +
      `frame-ancestors 'self'; manifest-src 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // The microphone for this dashboard's own pages only (voice typing, web/voice.js); no other site, no frame of one.
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  };
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** The host the browser thinks it talks to: Host, or X-Forwarded-Host behind a trusted proxy. */
export function requestHost(req, { trustProxy = false } = {}) {
  let host = first(req.headers.host);
  if (trustProxy) {
    const fwd = first(req.headers['x-forwarded-host']);
    if (fwd) host = fwd.split(',')[0].trim();
  }
  return typeof host === 'string' && HOST_RE.test(host) ? host.toLowerCase() : null;
}

/**
 * True when the request comes from a page of this same site. Browsers always send Origin on POST/DELETE fetches
 * and on WebSocket upgrades, so a missing Origin is refused too. `allowed` lists extra origins from the config.
 */
export function originOk(req, { trustProxy = false, allowed = [] } = {}) {
  const origin = first(req.headers.origin);
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  if (allowed.includes(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = requestHost(req, { trustProxy });
  return !!host && u.host.toLowerCase() === host;
}

/** HTTPS, directly or (with trustProxy) as told by the proxy. Decides the cookie's Secure flag. */
export function isHttps(req, { trustProxy = false } = {}) {
  if (req.socket && req.socket.encrypted) return true;
  if (!trustProxy) return false;
  const p = first(req.headers['x-forwarded-proto']);
  return typeof p === 'string' && p.split(',')[0].trim().toLowerCase() === 'https';
}

/** A connection from this computer itself: 127.0.0.0/8 or ::1, also written as an IPv4-mapped IPv6 address. */
export const loopbackPeer = (addr) => typeof addr === 'string' && (addr === '::1' || /^(::ffff:)?127\./i.test(addr));

/**
 * Who a sign-in try forwarded by a proxy on this computer is, while trustProxy is off; null for any other request.
 * The public link's cloudflared connects from loopback for every visitor on the internet: counted by the loopback
 * address, five wrong tries from anyone there locked everyone out, the owner and his sign-in link too. Cloudflare's
 * edge writes Cf-Connecting-Ip itself (a browser cannot set it through the tunnel), so each visitor counts on its own.
 * A program on this computer could write the header too: it then gets a count per value it invents, which the overall
 * cap still bounds. A forwarded try without that header counts under one key, whatever loopback address it uses.
 */
export function forwardedVisitor(req, { trustProxy = false } = {}) {
  if (trustProxy || !loopbackPeer(req.socket && req.socket.remoteAddress)) return null;
  const cf = first(req.headers['cf-connecting-ip']);
  const ip = typeof cf === 'string' ? cf.trim() : '';
  return net.isIP(ip) ? ip : 'forwarded on this computer';
}

/**
 * Client address for the rate limit. Behind a trusted proxy: the last X-Forwarded-For entry (the one it added), but
 * only when the connection itself comes from this computer, where that proxy runs (cloudflared for the public link,
 * Caddy or nginx for a hub). From anywhere else the header is the sender's own words: with the dashboard also open
 * to the network, a computer there could send a new one with every login try and get a fresh rate-limit bucket.
 */
export function clientIp(req, { trustProxy = false } = {}) {
  const peer = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (trustProxy && loopbackPeer(peer)) {
    const fwd = first(req.headers['x-forwarded-for']);
    if (typeof fwd === 'string' && fwd.trim()) {
      const list = fwd.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) return list[list.length - 1];
    }
  }
  return peer;
}

export const isLoopback = (host) => host === '127.0.0.1' || host === '::1' || host === 'localhost' || /^127\./.test(host);
