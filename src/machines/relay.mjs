// The hub's relay: a browser request for /m/<machine>/api/... or /m/<machine>/ws/term goes to that machine's
// dashboard with the hub's bearer token. Only what the API needs is passed on: the hub's cookie, Origin and every
// other header stay here, and the other side's cookies never come back.
//
// `ep` everywhere is where the machine's dashboard is reached: { protocol: 'http:' | 'https:', hostname, port,
// basePath } (basePath: '' or a reverse proxy's prefix).
import http from 'node:http';
import https from 'node:https';

// Request headers the API reads. Everything else (Cookie, Origin, Authorization, X-Forwarded-*, ...) is dropped.
const PASS_REQ = ['content-type', 'content-length', 'x-file-name', 'accept'];
// Response headers worth passing back. Set-Cookie and the other side's security headers are dropped (the hub
// sets its own).
const PASS_RES = ['content-type', 'content-length', 'cache-control', 'retry-after', 'content-disposition', 'last-modified', 'etag'];
// WebSocket handshake headers, both ways.
const PASS_WS_REQ = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];
const PASS_WS_RES = ['sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol'];

const pick = (headers, names) => {
  const out = {};
  for (const n of names) if (headers[n] !== undefined) out[n] = headers[n];
  return out;
};

const mod = (ep) => (ep.protocol === 'https:' ? https : http);

export class RelayError extends Error {
  /** code: offline | timeout | not-authorised | too-old | bad-answer */
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const STATUS = { offline: 502, timeout: 504, 'not-authorised': 403, 'too-old': 502, 'bad-answer': 502 };

/** The error a page gets: never 401 (that would mean "your login on the hub expired"). */
export function errorBody(machine, e) {
  const code = e.code in STATUS ? e.code : 'offline';
  return { status: e.status || STATUS[code], body: { error: e.message, code, machine } };
}

/** Network errors in plain words. */
export function netError(machine, e) {
  if (e instanceof RelayError) return e;
  if (e && e.code === 'timeout') return new RelayError('timeout', `${machine} did not answer in time.`);
  if (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EHOSTUNREACH' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || e.code === 'ETIMEDOUT')) {
    return new RelayError('offline', `${machine} is offline or its dashboard is not running.`);
  }
  if (e && /certificate|self[- ]signed|SSL|TLS/i.test(`${e.code} ${e.message}`)) {
    return new RelayError('offline', `${machine}: the HTTPS certificate is not trusted (${e.message}).`);
  }
  return new RelayError('offline', `${machine} cannot be reached${e && e.message ? ` (${e.message})` : ''}.`);
}

/**
 * Decide what a 401/403/404 from the other side means. A current hoprig answers a bad token with
 * { code: 'token' }; an old one does not know tokens at all ('log in first', or the Origin check refuses).
 */
export function classifyRefusal(machine, status, json) {
  if (status === 401 && json && json.code === 'token') {
    return new RelayError('not-authorised', `${machine} no longer lets this dashboard in (it was revoked there). Allow it again in Settings → Computers.`);
  }
  if (status === 403 && json && json.code === 'token-forbidden') return new RelayError('bad-answer', `${machine} does not allow that from another dashboard.`, 403);
  if (status === 401 || (status === 403 && json && json.error === 'cross-site request refused')) {
    return new RelayError('too-old', `${machine} runs a Hoprig too old for this dashboard. Update it there: hoprig update`);
  }
  return null;
}

/**
 * A JSON call to a machine (machine list, sessions of all machines, pairing). Resolves { status, json }; rejects
 * with a RelayError when the machine cannot be reached, does not answer in `timeoutMs` or refuses the token.
 */
// `tls`: extra TLS options for an https endpoint (a pinned hub's authority and check: hubcert.mjs trustOptions).
export function callJson(ep, { machine, method = 'GET', path, body, token, headers: extra = {}, timeoutMs = 5000, raw = false, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json', ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    const timer = setTimeout(() => r.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs);
    const r = mod(ep).request({ protocol: ep.protocol, hostname: ep.hostname, port: ep.port, method, path: `${ep.basePath || ''}${path}`, headers, agent: false, ...(ep.protocol === 'https:' ? tlsOpts : {}) }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) r.destroy(new RelayError('bad-answer', `${machine} sent too much.`));
        else chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* not JSON */
        }
        const refused = token && !raw ? classifyRefusal(machine, res.statusCode, json) : null;
        if (refused) return reject(refused);
        resolve({ status: res.statusCode, json });
      });
      res.on('error', (e) => {
        clearTimeout(timer);
        reject(netError(machine, e));
      });
    });
    r.on('error', (e) => {
      clearTimeout(timer);
      reject(netError(machine, e));
    });
    r.end(payload || undefined);
  });
}

/**
 * Relay one HTTP request, streaming both ways (an upload goes through as it arrives). `path` is the path and
 * query on the machine ("/api/state?x=1"). `idleMs` is how long the connection may sit with nothing moving.
 */
// `headers`: extra headers from the hub itself (legs.mjs: the leg is encrypted), never the browser's.
export function relayHttp(req, res, ep, { machine, path, token, idleMs = 30_000, headers: extra = {} }) {
  return new Promise((resolve) => {
    let finished = false;
    const fail = (e) => {
      if (finished) return;
      finished = true;
      const { status, body } = errorBody(machine, netError(machine, e));
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      } else res.destroy();
      req.resume(); // drain what the browser still sends
      resolve();
    };
    const headers = { ...pick(req.headers, PASS_REQ), ...extra };
    headers.authorization = `Bearer ${token}`;
    const out = mod(ep).request({ protocol: ep.protocol, hostname: ep.hostname, port: ep.port, method: req.method, path: `${ep.basePath || ''}${path}`, headers, agent: false });
    out.setTimeout(idleMs, () => out.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    out.on('error', fail);
    out.on('response', (up) => {
      // A refused token is not passed on as 401: the page would think its own login on the hub expired.
      if (up.statusCode === 401 || up.statusCode === 403) {
        const chunks = [];
        up.on('data', (c) => chunks.length < 64 && chunks.push(c));
        up.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* not JSON */
          }
          const refused = classifyRefusal(machine, up.statusCode, json);
          if (refused) return fail(refused);
          finished = true;
          res.writeHead(up.statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(json || { error: 'refused' }));
          resolve();
        });
        return;
      }
      finished = true;
      // A file from another computer's Files is never a page of this site either: the same sandbox the computer
      // itself puts on it (src/editor/manage.mjs sendFile), set here, since the hub does not pass on its policy.
      const sandbox = /^\/api\/files\/raw(\?|$)/.test(path) ? { 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' } : {};
      res.writeHead(up.statusCode, { ...pick(up.headers, PASS_RES), ...sandbox });
      up.pipe(res);
      up.on('end', resolve);
      up.on('error', () => res.destroy());
    });
    // The browser went away: stop the other side too.
    res.on('close', () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    req.pipe(out);
  });
}

/** Write a plain HTTP answer on a raw socket (an upgrade that is refused). */
export function rejectUpgrade(socket, status, text, body = '') {
  if (socket.destroyed) return;
  const b = Buffer.from(body);
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\n\r\n${body}`);
}

/**
 * Relay a WebSocket upgrade. The handshake goes to the machine with the token; once it answers 101 the two
 * sockets are joined byte for byte, so frames, close codes ("session ended") and back-pressure pass unchanged.
 */
export function relayUpgrade(req, socket, head, ep, { machine, path, token, timeoutMs = 15_000 }) {
  return new Promise((resolve) => {
    const headers = pick(req.headers, PASS_WS_REQ);
    Object.assign(headers, { connection: 'Upgrade', upgrade: 'websocket', authorization: `Bearer ${token}` });
    const out = mod(ep).request({ protocol: ep.protocol, hostname: ep.hostname, port: ep.port, method: 'GET', path: `${ep.basePath || ''}${path}`, headers, agent: false });
    const timer = setTimeout(() => out.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs);
    const refuse = (e) => {
      clearTimeout(timer);
      const { status, body } = errorBody(machine, e);
      rejectUpgrade(socket, status, status === 403 ? 'Forbidden' : status === 504 ? 'Gateway Timeout' : 'Bad Gateway', JSON.stringify(body));
      resolve(false);
    };
    out.on('error', (e) => refuse(netError(machine, e)));
    out.on('response', (up) => {
      // Not upgraded: pass the status on (404 = no such session), with a refused token named as such.
      clearTimeout(timer);
      const chunks = [];
      up.on('data', (c) => chunks.length < 16 && chunks.push(c));
      up.on('error', () => refuse(new RelayError('offline', `${machine} closed the connection.`)));
      up.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* an old dashboard answers with no body */
        }
        const refused = up.statusCode === 401 || up.statusCode === 403 ? classifyRefusal(machine, up.statusCode, json) : null;
        if (refused) return refuse(refused);
        rejectUpgrade(socket, up.statusCode, up.statusMessage || 'Refused');
        resolve(false);
      });
    });
    out.on('upgrade', (up, upSocket, upHead) => {
      clearTimeout(timer);
      if (socket.destroyed) {
        upSocket.destroy();
        return resolve(false);
      }
      const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const [k, v] of Object.entries(pick(up.headers, PASS_WS_RES))) lines.push(`${k}: ${v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      for (const s of [socket, upSocket]) {
        s.setTimeout(0);
        s.setNoDelay(true);
        s.on('error', () => {
          socket.destroy();
          upSocket.destroy();
        });
      }
      socket.on('close', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      resolve(true);
    });
    out.end();
  });
}
