// HTTP hardening shared by every response: security headers, the Origin check that stops cross-site requests,
// and how to tell HTTPS and the client address when a reverse proxy sits in front.

const HOST_RE = /^[A-Za-z0-9.:[\]-]{1,300}$/;

/** Headers for every response. `host` is the validated Host header, used to allow the WebSocket of this page. */
export function securityHeaders(host) {
  const ws = host && HOST_RE.test(host) ? ` ws://${host} wss://${host}` : '';
  return {
    // Scripts only from this server, never inline. Styles allow 'unsafe-inline' because xterm.js injects <style>
    // elements for its theme and cell sizes at run time; inline styles cannot run code.
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ` +
      `connect-src 'self'${ws}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; ` +
      `frame-ancestors 'none'; manifest-src 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
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
