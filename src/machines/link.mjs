// The direct link: a computer that cannot be reached (a PC at home behind a router) connects OUT to the hub's own
// dashboard address over a WebSocket, like RustDesk's clients dial their server. No SSH, no extra software: the
// only requirement is that the hub's address can be reached.
//
//   1. On the hub: a one-time code (10 minutes, one use), shown in Settings → Computers or by `machines invite`.
//   2. On the other computer: `hoprig join https://hub <code>`. It sends the code, with a fresh token for itself,
//      in the body of POST /api/link/claim; the hub stores the machine (via "link", a free port on its own
//      127.0.0.1) and answers with a link secret, kept only as a SHA-256 on the hub.
//   3. That computer opens a WebSocket to /api/link with the secret in a header (never in the URL) and keeps it up
//      (LinkClient: backoff, ping, and from its dashboard service's start, so reboots do not matter).
//   4. The hub listens on its 127.0.0.1:<port> while the link is up and carries every TCP connection made there over
//      the socket (mux.mjs); the linked computer connects each one to its own dashboard, nothing else. The hub's relay
//      then reaches it at 127.0.0.1:<port> exactly as through an SSH tunnel.
// A hub with its own certificate (Caddy's `tls internal`, by IP address): the join line carries the fingerprint of its
// authority, and the computer verifies against it from then on (hubcert.mjs). GET /api/link/ca hands out that
// authority's certificate (public material) so a computer that has the fingerprint can check it.
// Joining again (the same computer, the same hub address): the computer proves it is the one already listed by sending
// its current link secret with the claim (`replaces`, in the body, only after the code is accepted). The hub then
// REPLACES that entry: same name, label and port, a new secret and token, the old secret refused from then on and its
// live socket ended. A computer that merely has the same host name proves nothing and gets an entry of its own.
// One live socket per link: a new one replaces the old. Leave (POST /api/link/leave with the secret) or Remove on the
// hub ends it on both sides. The linked computer gets no token for the hub: control goes one way.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { RateLimiter } from '../server/auth.mjs';
import { defaultHubLabel } from './hub.mjs';
import { dashboardUrl, label as cleanLabel, slug, tokenName, uniqueSlug } from './names.mjs';
import { caddyRoot, establishTrust, explainTls, parsePin, toX509, trustOptions } from './hubcert.mjs';
import { OneTimeStore } from './onetime.mjs';
import { CODE_TTL_MS, dashboardAddress, listening, machineInfo, makeCode, normalizeCode } from './pairing.mjs';
import { callJson, rejectUpgrade } from './relay.mjs';
import { Mux, dashboardConnector } from './mux.mjs';
import { LEG_HEADER, noteLinkSocket, upgradeEncrypted } from './legs.mjs';
import { loadMachines, putMachine, removeMachine, saveMachines } from './store.mjs';
import { createToken, revokeToken } from './tokens.mjs';

export const LINK_HEADER = 'x-hoprig-link';
const SECRET_RE = /^ccl_[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^hop_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// ======================= codes (the hub's side) =======================

const codes = new OneTimeStore('link-codes', { salt: 'link' });

/** A one-time code for "Add a computer that connects by itself". { id, code, expires } */
export function createLinkCode({ now = Date.now() } = {}) {
  const { raw, shown } = makeCode();
  const { id, expires } = codes.add(raw, CODE_TTL_MS, { now });
  return { id, code: shown, expires };
}

/** 'pending' | 'expired' | { by } */
export function linkCodeStatus(id) {
  const s = codes.status(id);
  return typeof s === 'string' ? s : { by: s.usedBy };
}

/** A free port on 127.0.0.1 that no other joined or linked computer has. */
export async function freeLinkPort(machines = loadMachines()) {
  const used = new Set(machines.filter((m) => m.via === 'join' || m.via === 'link').map((m) => m.port));
  for (let i = 0; i < 20; i++) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    if (!used.has(port)) return port;
  }
  throw new Error('no free port');
}

/** The linked machine a presented secret belongs to, compared in constant time against every stored hash. */
export function machineForSecret(secret, machines = loadMachines()) {
  const got = sha256(SECRET_RE.test(String(secret)) ? secret : 'x');
  let hit = null;
  for (const m of machines) {
    if (m.via !== 'link') continue;
    const want = Buffer.from(m.linkHash, 'hex');
    if (want.length === got.length && crypto.timingSafeEqual(got, want) && SECRET_RE.test(String(secret)) && !hit) hit = m;
  }
  return hit;
}

class LinkHttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The hub's side: the claim and leave routes, the WebSocket, and one local listener per live link.
 * `clientIp(req)` is the server's (it honours trustProxy behind a reverse proxy).
 */
export class LinkHub {
  constructor({ clientIp = (req) => (req.socket && req.socket.remoteAddress) || 'unknown', limiter = new RateLimiter(), pingMs = 20_000, now = Date.now, authority = caddyRoot } = {}) {
    Object.assign(this, { clientIp, limiter, pingMs, now, authority });
    this.ca = { pem: null, until: 0 };
    this.sessions = new Map(); // linkId -> { ws, mux, listener, since, beat }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  }

  #limited(req) {
    const wait = this.limiter.retryAfter(this.clientIp(req));
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  /** POST /api/link/claim { code, token, tokenId, info }: no login; the code is the proof. */
  async claim(req, body) {
    const ip = this.clientIp(req);
    if (this.#limited(req)) throw new LinkHttpError(429, 'Too many tries. Wait a few minutes.', 'rate-limited');
    this.limiter.fail(ip); // counted before the check, as for the login
    const info = body.info && typeof body.info === 'object' ? body.info : {};
    if (!codes.take(normalizeCode(body.code), cleanLabel(info.label) || 'a computer')) throw new LinkHttpError(403, 'wrong or expired code', 'bad-code');
    this.limiter.succeed(ip);
    if (!TOKEN_RE.test(String(body.token))) throw new LinkHttpError(400, 'no token', 'bad-request');
    const machines = loadMachines();
    // The same computer joining again: proven by the link secret it holds, never by a name it claims.
    const old = body.replaces !== undefined ? machineForSecret(body.replaces, machines) : null;
    const port = old ? old.port : await freeLinkPort(machines);
    const secret = 'ccl_' + crypto.randomBytes(32).toString('base64url');
    const linkId = crypto.randomBytes(6).toString('hex');
    const host = String(info.hostname || '').split('.')[0];
    const m = {
      name: old ? old.name : uniqueSlug(slug(host || info.label), machines.map((x) => x.name)),
      // The label the owner sees (perhaps renamed here) stays.
      label: (old && old.label) || cleanLabel(info.label) || cleanLabel(host) || 'computer',
      via: 'link',
      port,
      linkId,
      linkHash: sha256(secret).toString('hex'),
      token: body.token,
      tokenId: ID_RE.test(String(body.tokenId)) ? body.tokenId : null,
      added: old ? old.added : this.now(),
      info: { hostname: info.hostname || null, platform: info.platform || null, version: info.version || null },
    };
    if (old) this.drop(old.linkId); // its socket, on the old secret, ends now
    putMachine(m); // same name: the old entry, its secret hash and its token are gone
    return { hoprig: 'link', ok: true, linkId, secret, name: m.name, label: m.label, replaced: !!old, hub: { label: defaultHubLabel(), hostname: machineInfo().hostname, version: machineInfo().version } };
  }

  /** POST /api/link/leave, the secret in the header: the linked computer leaves. */
  leave(req) {
    const m = machineForSecret(req.headers[LINK_HEADER]);
    if (!m) {
      this.limiter.fail(this.clientIp(req));
      throw new LinkHttpError(401, 'unknown link', 'link');
    }
    removeMachine(m.name);
    this.drop(m.linkId);
    return { ok: true, removed: true };
  }

  /** The WebSocket /api/link. Resolves true (it always answers). */
  upgrade(req, socket, head) {
    if (this.#limited(req)) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return true;
    }
    const m = machineForSecret(req.headers[LINK_HEADER]);
    if (!m) {
      this.limiter.fail(this.clientIp(req));
      rejectUpgrade(socket, 401, 'Unauthorized', JSON.stringify({ error: 'unknown link', code: 'link' }));
      return true;
    }
    // Whether it came over TLS decides whether a Setup job's password may be relayed over it (legs.mjs).
    const encrypted = upgradeEncrypted(req);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(m, ws, encrypted));
    return true;
  }

  #attach(m, ws, encrypted = false) {
    // One live socket per link: the newer one wins (the old one may be a half-dead connection).
    const old = this.sessions.get(m.linkId);
    if (old) this.#end(m.linkId, old, 4001, 'replaced by a newer connection');
    const s = { ws, since: this.now(), alive: true, port: m.port, encrypted };
    s.mux = new Mux({ role: 'hub', send: (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }), onError: () => ws.close(1002, 'protocol error') });
    ws.on('message', (d, isBinary) => (isBinary ? s.mux.receive(d) : ws.close(1003, 'binary frames only')));
    ws.on('pong', () => (s.alive = true));
    ws.on('close', () => this.#end(m.linkId, s));
    ws.on('error', () => this.#end(m.linkId, s));
    s.beat = setInterval(() => {
      if (!s.alive) return ws.terminate();
      s.alive = false;
      ws.ping();
    }, this.pingMs);
    s.beat.unref?.();
    this.sessions.set(m.linkId, s);
    this.#listen(m, s);
  }

  /** The hub's local end: 127.0.0.1:<port>. A port someone else took meanwhile is replaced by a new one. */
  #listen(m, s, tries = 0) {
    const listener = net.createServer((sock) => {
      // Removed meanwhile (by the CLI, say): stop at once.
      if (!loadMachines().some((x) => x.via === 'link' && x.linkId === m.linkId)) {
        sock.destroy();
        return this.drop(m.linkId);
      }
      s.mux.accept(sock);
    });
    listener.on('error', async (e) => {
      if (e.code !== 'EADDRINUSE' || tries > 3 || this.sessions.get(m.linkId) !== s) return;
      const list = loadMachines();
      const cur = list.find((x) => x.via === 'link' && x.linkId === m.linkId);
      if (!cur) return;
      cur.port = await freeLinkPort(list);
      saveMachines(list);
      s.port = cur.port;
      this.#listen(cur, s, tries + 1);
    });
    listener.listen(s.port, '127.0.0.1');
    s.listener = listener;
  }

  #end(linkId, s, code = 1000, reason = '') {
    clearInterval(s.beat);
    s.mux.close();
    if (s.listener) s.listener.close();
    if (s.ws.readyState === s.ws.OPEN || s.ws.readyState === s.ws.CONNECTING) s.ws.close(code, reason);
    if (this.sessions.get(linkId) === s) this.sessions.delete(linkId);
  }

  drop(linkId) {
    const s = this.sessions.get(linkId);
    if (s) this.#end(linkId, s, 4002, 'removed');
  }

  /** True while link `linkId` is up over a WebSocket that reached this hub encrypted. */
  encrypted(linkId) {
    const s = this.sessions.get(linkId);
    return !!(s && s.encrypted);
  }

  live(linkId) {
    const s = this.sessions.get(linkId);
    return s ? { since: s.since, port: s.port } : null;
  }

  close() {
    for (const [id, s] of this.sessions) this.#end(id, s, 1001, 'the hub is stopping');
    this.wss.close();
  }

  /**
   * GET /api/link/ca: this hub's own certificate authority (Caddy's local root), public material. Cached for a few
   * seconds only: when Caddy's authority is made new, the line the hub shows and this answer must agree at once.
   */
  async authorityPem() {
    if (this.ca.until <= this.now()) {
      const pem = await this.authority().catch(() => null);
      this.ca = { pem: typeof pem === 'string' && toX509(pem) ? pem : null, until: this.now() + 5000 };
    }
    return this.ca.pem;
  }

  /** Route the link's public requests: true when answered. */
  async handle(req, res, p, readJson, send) {
    try {
      if (p === '/api/link/claim' && req.method === 'POST') send(res, 200, await this.claim(req, await readJson(req)));
      else if (p === '/api/link/leave' && req.method === 'POST') send(res, 200, this.leave(req));
      else if (p === '/api/link/ca' && req.method === 'GET') send(res, 200, { certificate: await this.authorityPem() });
      else return false;
    } catch (e) {
      send(res, e.status || 500, { error: e.message, code: e.code || null }, e.status === 429 ? { 'Retry-After': '60' } : {});
    }
    return true;
  }
}

// ======================= the linked computer's side =======================

const isLocalUrl = (u) => /^(127\.|localhost$|\[?::1\]?$)/.test(new URL(u).hostname);

/** The link WebSocket's address for a hub at `base` (http -> ws, https -> wss, a path prefix kept). */
export const linkSocketUrl = (base) => `${base.replace(/^http/, 'ws')}/api/link`;

/**
 * Keeps the link to one hub up: connects, carries the hub's streams to this dashboard, pings, and reconnects with a
 * growing wait (1 s … 1 min, from the start again after a stable minute). A hub that refuses the secret (the link was
 * removed there) is reported as such and tried again only slowly.
 */
export class LinkClient extends EventEmitter {
  constructor({ entry, local = () => dashboardAddress(), minDelayMs = 1000, maxDelayMs = 60_000, stableMs = 30_000, pingMs = 20_000, now = Date.now } = {}) {
    super();
    Object.assign(this, { entry, local, minDelayMs, maxDelayMs, stableMs, pingMs, now });
    this.state = 'idle';
    this.failures = 0;
    this.upSince = null;
    this.lastError = '';
    this.ws = null;
    this.timer = null;
  }

  start() {
    if (this.state === 'idle') this.#connect();
  }

  #connect() {
    if (this.state === 'closed') return;
    this.state = 'starting';
    let ws;
    try {
      // A hub joined with a fingerprint: verified against its pinned authority, every time (never without checking).
      ws = new WebSocket(linkSocketUrl(this.entry.url), { headers: { [LINK_HEADER]: this.entry.secret, [LEG_HEADER]: /^https:/i.test(this.entry.url) ? 'wss' : 'ws' }, perMessageDeflate: false, handshakeTimeout: 15_000, maxPayload: 1024 * 1024, ...linkTrust(this.entry) });
    } catch (e) {
      return this.#failed(e.message);
    }
    this.ws = ws;
    let upAt = null;
    let mux = null;
    let beat = null;
    let why = '';
    ws.on('unexpected-response', (req, res) => {
      why = res.statusCode === 401 ? 'the hub does not know this computer any more (it was removed there)' : `the hub answered HTTP ${res.statusCode}`;
      if (res.statusCode === 401) this.failures = Math.max(this.failures, 6); // retry rarely
      res.resume();
      ws.terminate();
    });
    ws.on('open', () => {
      upAt = this.now();
      this.upSince = upAt;
      this.state = 'up';
      this.lastError = '';
      mux = new Mux({ role: 'machine', send: (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }), connectLocal: () => noteLinkSocket(dashboardConnector(this.local)(), /^https:/i.test(this.entry.url)), onError: () => ws.close(1002, 'protocol error') });
      let alive = true;
      ws.on('pong', () => (alive = true));
      beat = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, this.pingMs);
      beat.unref?.();
      this.emit('up');
    });
    ws.on('message', (d, isBinary) => mux && isBinary && mux.receive(d));
    ws.on('error', (e) => (why ||= explainTls(e, { host: new URL(this.entry.url).hostname, pin: this.entry.pin || null })));
    ws.on('close', (code, reason) => {
      clearInterval(beat);
      if (mux) mux.close();
      if (this.ws === ws) this.ws = null;
      if (this.state === 'closed') return;
      if (upAt !== null && this.now() - upAt >= this.stableMs) this.failures = 0;
      this.#failed(why || (reason && reason.toString()) || `connection closed (${code})`);
    });
  }

  #failed(msg) {
    if (this.state === 'closed') return;
    this.failures++;
    this.lastError = msg;
    this.upSince = null;
    this.state = 'waiting';
    this.emit('fail', msg);
    const delay = Math.min(this.maxDelayMs, this.minDelayMs * 2 ** Math.min(this.failures - 1, 16));
    this.timer = setTimeout(() => this.#connect(), delay);
    this.timer.unref?.();
  }

  /** Resolves once up; rejects with the reason after `ms`. */
  waitUp(ms = 15_000) {
    if (this.state === 'up') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('up', ok);
        reject(new Error(this.lastError || 'the link did not come up'));
      }, ms);
      const ok = () => {
        clearTimeout(t);
        resolve();
      };
      this.once('up', ok);
    });
  }

  status() {
    return { state: this.state, upSince: this.upSince, error: this.lastError || null, failures: this.failures };
  }

  close() {
    this.state = 'closed';
    clearTimeout(this.timer);
    if (this.ws) this.ws.terminate();
    this.ws = null;
  }
}

export class LinkError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The TLS options for every connection of a joined link (none for http:// or a hub joined without a fingerprint). */
export const linkTrust = (entry) => (/^https:/.test(entry.url) ? trustOptions({ pin: entry.pin || null, ca: entry.ca || null }, new URL(entry.url).hostname.replace(/^\[|\]$/g, '')) : {});

const JOIN_HINT = 'the hub (run "hoprig machines invite" there, or on its page: Computers → Add a computer → Show a code)';

/** Where to reach the hub at `base` for a JSON call. */
const endpointOf = (base) => {
  const u = new URL(base);
  return { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), basePath: u.pathname === '/' ? '' : u.pathname };
};

/**
 * Join the hub at `rawUrl` with the code it showed. Plain http to a hub that is not on this computer is refused
 * unless `insecure`: the token, and everything typed into the sessions, would cross the network unencrypted.
 * Over https the certificate is always verified: by a public authority, or, for a hub with its own authority, against
 * `fingerprint` (from the hub's join line; hubcert.mjs). The code is sent only after that.
 * Returns the entry for joined.json (the caller saves it and starts the link).
 */
export async function claimLink(rawUrl, rawCode, { insecure = false, fingerprint = null, replaces = null, now = Date.now } = {}) {
  const base = dashboardUrl(String(rawUrl || ''));
  if (!base) throw new LinkError('bad-url', 'type the other dashboard\'s address, like https://hub.example.com', 400);
  if (base.startsWith('http://') && !isLocalUrl(base) && !insecure) {
    throw new LinkError('insecure', `${base} is not encrypted (http://): the token and everything typed into the sessions would cross the network readable by anyone on the way. Put that dashboard behind HTTPS, or confirm with --insecure (in the page: "Connect without encryption") on a network you trust.`, 400);
  }
  const code = normalizeCode(rawCode);
  if (!code) throw new LinkError('bad-code', 'the code has 8 letters and digits, like K7QM-4XP2', 400);
  const hasPin = fingerprint !== null && fingerprint !== undefined && fingerprint !== '';
  if (hasPin && !parsePin(fingerprint)) throw new LinkError('bad-fingerprint', `that fingerprint is not in the right form: sha256: followed by 43 letters, digits, - or _. Copy the whole line from ${JOIN_HINT}.`, 400);
  if (hasPin && !base.startsWith('https://')) throw new LinkError('bad-fingerprint', 'a fingerprint is for an https:// address; this one is not encrypted', 400);
  const addr = dashboardAddress();
  if (!(await listening(addr))) {
    throw new LinkError('not-running', `This computer's dashboard is not running (nothing on ${addr.host}:${addr.port}). Start it first: hoprig service install`);
  }
  const host = new URL(base).hostname;
  // Trust first, before a token is made or the code leaves this computer.
  let trust = { pin: null, ca: null };
  if (base.startsWith('https://')) {
    try {
      trust = await establishTrust(endpointOf(base), hasPin ? fingerprint : null, { host: host.replace(/^\[|\]$/g, ''), joinHint: JOIN_HINT });
    } catch (e) {
      throw new LinkError(e.code || 'tls', e.message, e.status || 502);
    }
  }
  const { id: tokenId, token } = createToken(tokenName(host.replace(/[^A-Za-z0-9 ._@()-]/g, '-').slice(0, 60)) || 'hub');
  const me = machineInfo();
  let r;
  try {
    r = await callJson(endpointOf(base), { machine: host, method: 'POST', path: '/api/link/claim', body: { code, token, tokenId, info: { hostname: me.hostname, platform: me.platform, version: me.version, label: defaultHubLabel() }, ...(SECRET_RE.test(String(replaces)) ? { replaces } : {}) }, timeoutMs: 15_000, raw: true, tls: linkTrust({ url: base, ...trust }) });
  } catch (e) {
    revokeToken(tokenId, { log: false }); // never in use
    throw new LinkError(e.code || 'offline', e.message, 502);
  }
  if (r.status !== 200 || !r.json || !SECRET_RE.test(String(r.json.secret))) {
    revokeToken(tokenId, { log: false });
    if (r.status === 403) throw new LinkError('bad-code', 'that code is wrong or has expired. Show a new one on the other dashboard.', 400);
    if (r.status === 429) throw new LinkError('rate-limited', 'too many tries; wait a few minutes', 429);
    throw new LinkError('too-old', `${host} does not answer like a Hoprig dashboard that accepts direct links (HTTP ${r.status}). Update Hoprig there, and check the address.`, 502);
  }
  return {
    id: r.json.linkId, via: 'link', url: base, secret: r.json.secret, tokenId,
    name: r.json.name, hubLabel: (r.json.hub && r.json.hub.label) || host, hubHostname: (r.json.hub && r.json.hub.hostname) || null, joined: now(),
    ...(trust.pin ? { pin: trust.pin } : {}), ...(trust.ca ? { ca: trust.ca } : {}),
    ...(r.json.replaced === true ? { replaced: true } : {}),
  };
}

/** Tell the hub this computer leaves (best effort). True when the hub confirmed. */
export async function leaveLink(entry) {
  try {
    const r = await callJson(endpointOf(entry.url), { machine: entry.url, method: 'POST', path: '/api/link/leave', body: {}, headers: { [LINK_HEADER]: entry.secret }, timeoutMs: 10_000, raw: true, tls: linkTrust(entry) });
    return r.status === 200;
  } catch {
    return false;
  }
}
