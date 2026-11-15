// One request passed on to a gateway, streaming both ways: Claude Code reads its answers as server-sent events, so
// nothing is held back and every chunk goes on as it comes. Only the headers the API needs pass, in both
// directions; whoever calls this adds the credential of the next hop itself.
import http from 'node:http';
import https from 'node:https';

// Request headers a gateway reads for Claude's API. Cookie, Origin, X-Forwarded-*, Authorization and x-api-key stay
// here: the key of the next hop is added by the caller.
const PASS_REQ = ['content-type', 'content-length', 'accept', 'accept-encoding', 'anthropic-version', 'anthropic-beta', 'user-agent', 'x-app', 'x-claude-code-session-id'];
// Response headers worth passing back: the body's shape, and the limits Auto mode reads (src/router.mjs judge()).
const PASS_RES = ['content-type', 'content-length', 'content-encoding', 'cache-control', 'retry-after', 'retry-after-ms', 'request-id', 'x-request-id'];
const PASS_RES_PREFIX = 'anthropic-ratelimit-';

export const BODY_MAX = 64 * 1024 * 1024; // a request with images is large; anything beyond this is not Claude Code

/** An error in the shape Claude Code shows to the person: { type: 'error', error: { type, message } }. */
export function apiError(res, status, type, message, headers = {}) {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

const pickReq = (headers) => {
  const out = {};
  for (const n of PASS_REQ) if (headers[n] !== undefined) out[n] = headers[n];
  // The sign-in beta belongs to a subscription's token, which never travels this way (src/router.mjs does the same).
  if (out['anthropic-beta']) {
    const betas = String(out['anthropic-beta']).split(',').map((b) => b.trim()).filter((b) => b && !/^oauth-/.test(b));
    if (betas.length) out['anthropic-beta'] = betas.join(',');
    else delete out['anthropic-beta'];
  }
  return out;
};
const pickRes = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (PASS_RES.includes(k) || k.startsWith(PASS_RES_PREFIX)) out[k] = v;
  return out;
};

/**
 * Pass `req` on to `target` ({ protocol, hostname, port, path }) with `auth` (the next hop's credential headers) and
 * stream the answer back into `res`. `failed(e)` turns a connection error into { status, type, message } in plain
 * words. `idleMs`: how long nothing may move before it is given up (a long answer keeps sending, so this only
 * catches a gateway that hangs). Resolves when the exchange is over.
 */
export function forward(req, res, { target, auth = {}, failed, idleMs = 10 * 60_000, tls = {} }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const fail = (e) => {
      if (done) return;
      const f = failed(e);
      apiError(res, f.status, f.type, f.message);
      req.resume(); // drain what the client still sends
      finish();
    };
    const mod = target.protocol === 'https:' ? https : http;
    const out = mod.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: target.path,
      headers: { ...pickReq(req.headers), ...auth }, agent: false, ...(target.protocol === 'https:' ? tls : {}),
    });
    out.setTimeout(idleMs, () => out.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    out.on('error', fail);
    out.on('response', (up) => {
      if (done) return void up.destroy();
      done = true;
      res.writeHead(up.statusCode, pickRes(up.headers));
      res.flushHeaders();
      if (res.socket) res.socket.setNoDelay(true);
      up.pipe(res);
      up.on('end', resolve);
      up.on('error', () => {
        res.destroy();
        resolve();
      });
    });
    // The client went away (Claude Code was stopped): stop the gateway too, so it stops working for nobody.
    res.on('close', () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        out.destroy();
        apiError(res, 413, 'request_too_large', 'The request is too large.');
        done = true;
        req.destroy();
        resolve();
      }
    });
    req.pipe(out);
  });
}

/** A connection error in plain words, for `forward`'s `failed`: `who` is what could not be reached. */
export function unreachable(who, startHint = '') {
  return (e) => {
    if (e && e.code === 'timeout') return { status: 504, type: 'api_error', message: `${who} did not answer in time.` };
    if (e && e.code === 'ECONNREFUSED') return { status: 502, type: 'api_error', message: `${who} is not running.${startHint ? ` ${startHint}` : ''}` };
    return { status: 502, type: 'api_error', message: `${who} cannot be reached${e && e.code ? ` (${e.code})` : ''}.` };
  };
}
