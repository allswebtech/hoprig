// Passing requests between the browser and the VS Code server (process.mjs), HTTP and WebSocket. The feature has
// checked the dashboard's login before anything gets here; the dashboard's own cookie never reaches VS Code.
import http from 'node:http';

// Request headers never passed on: the browser's credentials and what a proxy in front of the dashboard added.
const DROP_REQ = /^(host|cookie|authorization|proxy-authorization|forwarded|x-forwarded-.*|x-real-ip|cf-.*|true-client-ip)$/;
// Headers that belong to one connection, not to the request (RFC 9110 §7.6.1). An upgrade keeps its own two.
const HOP = /^(connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade)$/;
// The dashboard's own headers that would break VS Code's pages; VS Code sends its own (its scripts need 'unsafe-eval'
// and nonces, its editors and previews are frames of this same site).
const OWN_HEADERS = ['Content-Security-Policy', 'X-Frame-Options', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy'];

/** The Cookie header for VS Code: the browser's cookies without the dashboard's login (null when none are left). */
export function upstreamCookie(header, ownCookie = 'sid') {
  const keep = String(header || '').split(';').map((c) => c.trim()).filter((c) => c && c.split('=')[0].trim() !== ownCookie);
  return keep.length ? keep.join('; ') : null;
}

/** The headers to send VS Code. `host` is the address the browser uses, so the links VS Code writes lead back here. */
export function upstreamHeaders(reqHeaders, { host, upgrade = false }) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v === undefined || DROP_REQ.test(k) || (HOP.test(k) && !(upgrade && (k === 'connection' || k === 'upgrade')))) continue;
    out[k] = v;
  }
  out.host = host || 'localhost';
  const cookie = upstreamCookie(reqHeaders.cookie);
  if (cookie) out.cookie = cookie;
  return out;
}

/** VS Code's answer headers as the browser gets them: without the hop-by-hop ones. */
export function downstreamHeaders(upHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(upHeaders)) if (!HOP.test(k)) out[k] = v;
  return out;
}

/** Where the server listens, as options for http.request. */
const where = (target) => ({ socketPath: target.socketPath });

/** Pass one HTTP request to VS Code and its answer back, streaming both ways. Resolves when it is over. */
export function proxyHttp(req, res, target, { host, path }) {
  return new Promise((resolve) => {
    const out = http.request({ ...where(target), method: req.method, path, headers: upstreamHeaders(req.headers, { host }), agent: false });
    out.on('error', () => {
      if (!res.headersSent) {
        for (const h of OWN_HEADERS) res.removeHeader(h);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('VS Code did not answer.');
      } else res.destroy();
      resolve();
    });
    out.on('response', (up) => {
      for (const h of OWN_HEADERS) res.removeHeader(h);
      const headers = downstreamHeaders(up.headers);
      // A page of VS Code that says nothing about frames may still only be framed by this site.
      if (!headers['x-frame-options'] && !/frame-ancestors/i.test([].concat(headers['content-security-policy'] || []).join(' '))) headers['x-frame-options'] = 'SAMEORIGIN';
      res.writeHead(up.statusCode, headers);
      up.pipe(res);
      up.on('end', resolve);
      up.on('error', () => res.destroy());
    });
    res.on('close', () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    req.pipe(out);
  });
}

/** Write a plain answer on a raw socket (an upgrade that is refused). */
export function refuseUpgrade(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Pass a WebSocket upgrade to VS Code. Once it answers 101 the two sockets are joined byte for byte. `onOpen` and
 * `onClose` let the caller count open connections (the idle stop waits for none). Resolves true when joined.
 */
export function proxyUpgrade(req, socket, head, target, { host, path, onOpen = () => {}, onClose = () => {} }) {
  return new Promise((resolve) => {
    const headers = upstreamHeaders(req.headers, { host, upgrade: true });
    const out = http.request({ ...where(target), method: 'GET', path, headers, agent: false });
    out.on('error', () => {
      refuseUpgrade(socket, 502, 'Bad Gateway');
      resolve(false);
    });
    out.on('response', (up) => {
      up.resume();
      refuseUpgrade(socket, up.statusCode, up.statusMessage || 'Refused');
      resolve(false);
    });
    out.on('upgrade', (up, upSocket, upHead) => {
      if (socket.destroyed) {
        upSocket.destroy();
        return resolve(false);
      }
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (const [k, v] of Object.entries(downstreamHeaders(up.headers))) for (const one of [].concat(v)) lines.push(`${k}: ${one}`);
      lines.push('Connection: Upgrade', 'Upgrade: websocket');
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      let closed = false;
      const end = () => {
        socket.destroy();
        upSocket.destroy();
        if (!closed) {
          closed = true;
          onClose();
        }
      };
      for (const s of [socket, upSocket]) {
        s.setTimeout(0);
        s.setNoDelay(true);
        s.on('error', end);
        s.on('close', end);
      }
      onOpen();
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      resolve(true);
    });
    out.end();
  });
}
