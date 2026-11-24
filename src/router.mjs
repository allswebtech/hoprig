// The router: what makes Auto mode seamless.
//
// Claude Code is started with ANTHROPIC_BASE_URL pointing here. Every model request it makes is answered by the
// account it runs as, and when that account answers "limit reached" the SAME request goes to an API account of
// the owner's order before Claude Code has seen anything: no error on screen, no restart, nothing to continue.
// When the account is free again, requests go back to it by themselves.
//
// How an account is used, and the one rule behind it:
//   the identity account  the subscription (or key) Claude Code itself runs as in this session (see
//                         autoIdentity): its requests pass through UNTOUCHED, with the credentials Claude Code
//                         attached. This is the documented gateway setup.
//   an API key            x-api-key: <ANTHROPIC_API_KEY>
//   a proxy / gateway     its ANTHROPIC_BASE_URL with Authorization: Bearer <ANTHROPIC_AUTH_TOKEN>
//   another subscription  NEVER from here. A subscription's token may only be used by Claude Code itself
//                         (Anthropic's terms for subscription sign-in), so the router does not attach one to a
//                         request. To continue on another subscription the launcher restarts Claude Code as that
//                         account (launch.mjs); the router only tells Claude Code "limit reached" so that happens.
// A profile may map model names for its endpoint: MODELS="claude-fable-*=claude-opus-5-5" (first match wins).
//
// It listens on 127.0.0.1 only, under a secret path (routerstate.mjs), keeps no request or answer text, and logs
// one line per request: which account, which status. Per account it keeps how soon answers start and its refusals
// (routerstate.mjs noteSpeed), from the requests it passes on.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { gatewayOfPrerun } from './addons/gateways.mjs';
import { billedOutOfOrder, leftOutOfOrder, limitedProfiles, markLimited, usableOrder } from './autoswitch.mjs';
import { binFile, stateDir } from './paths.mjs';
import { listProfiles } from './profiles.mjs';
import { providerName } from './operator/detect/util.mjs';
import { noteSpeed, routerAddress, routerSessions, routerSpeed, saveProfileUsage, saveRouterSessions, saveRouterSpeed, usageFromHeaders } from './routerstate.mjs';

export const AUTO = 'auto';
const BODY_MAX = 128 * 1024 * 1024; // requests carry whole conversations, images included
const ERROR_BODY_MAX = 1024 * 1024;
const OAUTH_BETA = 'oauth-2025-04-20';
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);

/** Anthropic's API. $HOPRIG_ANTHROPIC_URL replaces it (a company proxy; the tests). */
const anthropicBase = () => (process.env.HOPRIG_ANTHROPIC_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

const isSubscription = (p) => p.kind === 'login' || p.kind === 'subscription';

const WHY_LEFT = { missing: ['does not exist any more', 'do not exist any more'], tools: ['does not serve Claude Code', 'do not serve Claude Code'], billed: ['is billed by use', 'are billed by use'] };
const listed = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);

/**
 * Why Auto mode has nothing it may use, from the providers its order leaves out (autoswitch.mjs leftOutOfOrder, or the
 * same reasons read from the accounts list): "Auto mode has nothing it may use, because …", each provider named with
 * its own reason. null when nothing is left out (an empty order has its own sentences).
 */
export function nothingUsable(left) {
  if (!Array.isArray(left) || !left.length) return null;
  const clauses = Object.keys(WHY_LEFT).filter((k) => left.some((x) => x.why === k)).map((k, i) => {
    const names = left.filter((x) => x.why === k).map((x) => providerName(x.name, x.label));
    return `${listed(names)}${i ? '' : ' in its order'} ${WHY_LEFT[k][names.length > 1 ? 1 : 0]}${k === 'billed' ? ' and "Also use pay-per-use providers" is off' : ''}`;
  });
  return `Auto mode has nothing it may use, because ${clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}` : clauses[0]}`;
}

/** The reason and what to do (Tia's chat and a Work run say it after their own start). null when nothing is left out. */
export function nothingUsableWhy(left) {
  const why = nothingUsable(left);
  if (!why) return null;
  const todo = left.some((x) => x.why === 'billed')
    ? 'turn that switch on on the Providers page, or put a subscription into the order'
    : 'put a provider that serves Claude Code into the order on the Providers page, or run: hoprig auto order <provider> <provider>';
  return `${why}: ${todo}`;
}

/** The router's 503 and the start's line for it. null when nothing is left out. */
export function nothingUsableLine(left) {
  const why = nothingUsableWhy(left);
  return why ? `hoprig: ${why}.` : null;
}

/**
 * The account Claude Code should run as in an Auto session: the first subscription of the order that is not at
 * its limit (and not in `unusable`, e.g. a stored login that has expired), else the first subscription, else the
 * first account. Returns the profile or null.
 */
export function autoIdentity(order, profiles, limited = {}, unusable = []) {
  const inOrder = order.map((n) => profiles.find((p) => p.name === n)).filter((p) => p && !unusable.includes(p.name));
  const subs = inOrder.filter(isSubscription);
  return subs.find((p) => !(p.name in limited)) || subs[0] || inOrder[0] || null;
}

/**
 * What to do with one model request: { next: the account to try now, or null; handoff: a subscription Claude
 * Code should be restarted as, or null }. `limited` are the accounts at their limit, `tried` those that already
 * refused this request.
 *
 * The router itself can use the identity account (pass-through) and API accounts (their own keys). Another
 * subscription can only be used by restarting Claude Code as it, and that is asked for only when the identity
 * cannot serve: a session is never interrupted just because a more preferred subscription is free again (the
 * launcher moves it back between replies).
 */
export function pick(order, profiles, identity, limited, tried = new Set()) {
  const inOrder = order.map((n) => profiles.find((p) => p.name === n)).filter(Boolean);
  if (!inOrder.some((p) => p.name === identity.name)) inOrder.unshift(identity); // an identity outside the order still serves itself
  const free = (p) => !(p.name in limited) && !tried.has(p.name);
  const usable = inOrder.filter((p) => free(p) && (p.name === identity.name || p.kind === 'api'));
  if (free(identity)) return { next: usable[0], handoff: null };
  const otherSub = inOrder.find((p) => free(p) && isSubscription(p) && p.name !== identity.name);
  if (otherSub && (!usable.length || inOrder.indexOf(otherSub) < inOrder.indexOf(usable[0]))) return { next: null, handoff: otherSub.name };
  return { next: usable[0] || null, handoff: null };
}

const glob = (pattern) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** The model name to send to `profile`'s endpoint for a request that asks for `model`. */
export function mapModel(model, profile) {
  if (typeof model !== 'string') return model;
  for (const rule of String(profile.models || '').split(',')) {
    const i = rule.indexOf('=');
    if (i < 1) continue;
    const from = rule.slice(0, i).trim();
    const to = rule.slice(i + 1).trim();
    if (from && to && glob(from).test(model)) return to;
  }
  return model;
}

const betaList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The request to send to `profile` for what Claude Code sent us: { url, headers, body } or null when the router
 * may not use this profile (a subscription that is not the session's identity: only Claude Code itself may send
 * a subscription's token, so the router never attaches one).
 */
export function upstreamRequest(profile, { isIdentity, rest, headers, body }) {
  const base = (profile.env.ANTHROPIC_BASE_URL || anthropicBase()).replace(/\/+$/, '');
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k)) out[k] = v;
  if (!isIdentity) {
    delete out.authorization;
    delete out['x-api-key'];
    let betas = betaList(out['anthropic-beta']);
    if (profile.env.ANTHROPIC_API_KEY) {
      out['x-api-key'] = profile.env.ANTHROPIC_API_KEY;
      betas = betas.filter((b) => b !== OAUTH_BETA);
    } else if (profile.env.ANTHROPIC_AUTH_TOKEN) {
      out.authorization = `Bearer ${profile.env.ANTHROPIC_AUTH_TOKEN}`;
      betas = betas.filter((b) => b !== OAUTH_BETA);
    } else {
      return null;
    }
    if (betas.length) out['anthropic-beta'] = betas.join(',');
    else delete out['anthropic-beta'];
  }
  let payload = body;
  if (profile.models && body.length && /json/i.test(String(headers['content-type'] || ''))) {
    try {
      const json = JSON.parse(body.toString('utf8'));
      const mapped = mapModel(json.model, profile);
      if (mapped !== json.model) payload = Buffer.from(JSON.stringify({ ...json, model: mapped }));
    } catch {
      /* not JSON after all: send as it is */
    }
  }
  out['content-length'] = String(payload.length);
  return { url: new URL(base + rest), headers: out, body: payload };
}

/**
 * What an answer means for routing: { next: try the next account?, mark: remember this account as unusable
 * until when and why (or null) }.
 */
export function judge(status, headers, now = Date.now()) {
  if (status === 429) {
    const reset = Number(headers['anthropic-ratelimit-unified-reset']);
    if (headers['anthropic-ratelimit-unified-status'] === 'rejected' && Number.isFinite(reset) && reset * 1000 > now) {
      return { next: true, mark: { until: reset * 1000, reason: 'rate_limit' } };
    }
    const retry = Number(headers['retry-after']);
    if (Number.isFinite(retry) && retry > 15) return { next: true, mark: { until: now + retry * 1000, reason: 'rate_limit' } };
    return { next: true, mark: null }; // a short burst limit: use another account for this request only
  }
  if (status === 401 || status === 403) return { next: true, mark: { until: now + 10 * 60_000, reason: 'auth' } };
  if (status === 402) return { next: true, mark: { until: now + 60 * 60_000, reason: 'billing_error' } };
  if (status === 529 || status === 502 || status === 503 || status === 504) return { next: true, mark: null };
  return { next: false, mark: null };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Send one request upstream; resolves when the answer's headers are in: { status, headers, res, sentAt } or { error }.
function send({ url, headers, body }, method, signal) {
  return new Promise((resolve) => {
    const lib = url.protocol === 'https:' ? https : http;
    const sentAt = Date.now();
    const up = lib.request(url, { method, headers, signal }, (res) => resolve({ status: res.statusCode, headers: res.headers, res, sentAt }));
    up.on('error', (error) => resolve({ error }));
    up.end(body);
  });
}

async function collect(res, max) {
  const chunks = [];
  let size = 0;
  for await (const c of res) {
    size += c.length;
    if (size <= max) chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Build the router's HTTP server. `log(line)` gets one line per routed request. */
export function createRouter({ key = routerAddress().key, log = () => {}, version = '' } = {}) {
  const prefix = `/${key}`;
  const preran = new Set();
  const sessions = routerSessions();
  let sessionsDirty = false;
  let inflight = 0;
  const usageSeen = new Map();
  const speed = routerSpeed();
  let speedDirty = false;
  const noteAnswer = (profile, sample) => {
    speed[profile.name] = noteSpeed(speed[profile.name], sample);
    speedDirty = true;
  };

  // A profile's PRERUN (for example "start my proxy") runs once per router life, before its first use.
  async function prerun(profile, force = false) {
    if (!profile.prerun || (preran.has(profile.name) && !force)) return;
    preran.add(profile.name);
    await new Promise((resolve) => {
      const child = spawn(profile.prerun, { shell: true, stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 30_000);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
      child.on('error', () => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * Why a provider served by a gateway of the owner's own may not be passed a request now, or null: another program
   * answers on that gateway's port (one Hoprig did not start, localgateway.mjs), and the provider's key would go to it.
   * Its PRERUN failing says the same, but a PRERUN runs once per router life.
   */
  async function foreignGateway(profile) {
    const g = profile.prerun ? gatewayOfPrerun(profile.prerun) : null;
    if (!g || !g.defined || typeof g.answering !== 'function') return null;
    const now = await g.answering();
    return now.up && !now.mine ? `another program answers on the port of ${g.title}: Hoprig did not start it, so nothing is passed on to it` : null;
  }

  function noteUsage(profile, headers) {
    const u = usageFromHeaders(headers);
    if (!u) return;
    const sig = JSON.stringify([u.fiveHour, u.week, u.status]);
    const prev = usageSeen.get(profile.name);
    if (prev && prev.sig === sig && u.at - prev.at < 60_000) return; // nothing new: spare the disk
    usageSeen.set(profile.name, { sig, at: u.at });
    saveProfileUsage(profile.name, u);
  }

  function noteSession(req, profile) {
    const id = req.headers['x-claude-code-session-id'];
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return;
    if (sessions[id]?.profile !== profile.name) sessionsDirty = true;
    sessions[id] = { profile: profile.name, at: Date.now() };
  }
  const flush = setInterval(() => {
    if (speedDirty) {
      speedDirty = false;
      try { saveRouterSpeed(speed); } catch { /* next time */ }
    }
    if (!sessionsDirty) return;
    sessionsDirty = false;
    const now = Date.now();
    for (const [id, s] of Object.entries(sessions)) if (now - s.at > 24 * 3600 * 1000) delete sessions[id];
    try { saveRouterSessions(sessions); } catch { /* next time */ }
  }, 2000);
  flush.unref();

  async function handle(req, res) {
    if (req.url === `${prefix}/__router`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version, pid: process.pid, inflight }));
    }
    if (!req.url.startsWith(`${prefix}/`)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
    }
    // "/as/<profile>/..." names the account this session's Claude Code runs as (the launcher puts it in the URL).
    let rest = req.url.slice(prefix.length);
    const as = /^\/as\/([a-z0-9_-]{1,32})(\/.*)$/.exec(rest);
    if (as) rest = as[2];
    const body = await readBody(req, BODY_MAX);
    const profiles = listProfiles();
    const order = usableOrder(); // pay-per-use keys only when the owner allows them
    const identity = (as && profiles.find((p) => p.name === as[1])) || autoIdentity(order, profiles, limitedProfiles());
    if (!identity) {
      // An order whose every provider is left out (gone, not serving Claude Code, billed by use) is there, it may not
      // be used: say why, each provider with its own reason.
      const message = nothingUsableLine(order.length ? [] : leftOutOfOrder())
        || 'hoprig: Auto mode has no providers in its order. Run: hoprig auto order <provider> <provider>';
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
    }
    // Only model requests are spread over the accounts; everything else belongs to the account Claude Code runs as.
    const routed = req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(rest);
    const timed = routed && /^\/v1\/messages(\?|$)/.test(rest); // a model's answer; counting tokens says nothing of its speed
    // A running session whose identity is billed by use while "Also use pay-per-use providers" is off (started before
    // the switch went off, or before its sign-in became a Console account's): its model requests are not passed on,
    // as Auto mode passes nothing through such a provider. Its identity cannot be moved from here (the launcher moves a
    // session only at a limit), so the answer says so and nothing is spent.
    if (routed && as && billedOutOfOrder([identity.name]).length) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `hoprig: this session runs as ${providerName(identity.name, identity.label)}, which is billed by use, and "Also use pay-per-use providers" is off, so Auto mode does not use it: turn that switch on on the Providers page, or start the session again under Auto mode.` } }));
    }
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const tried = [];
    const refusedBy = new Set();
    let held = null; // the first refusal, kept in case no account can serve the request
    let handoff = null;
    let first = true;
    for (;;) {
      let profile;
      if (!routed) {
        if (!first) break;
        profile = identity;
      } else {
        const choice = pick(order, profiles, identity, limitedProfiles(), refusedBy);
        handoff = choice.handoff;
        profile = choice.next;
        // Every account is at its limit: ask the identity anyway, so Claude Code shows its real limit message.
        if (!profile && !handoff && first) profile = identity;
        if (!profile) break;
      }
      first = false;
      refusedBy.add(profile.name);
      const request = upstreamRequest(profile, { isIdentity: profile.name === identity.name, rest, headers: req.headers, body });
      if (!request) continue;
      await prerun(profile);
      let foreign = await foreignGateway(profile);
      let answer = foreign ? null : await send(request, req.method, abort.signal);
      if (answer?.error && answer.error.code === 'ECONNREFUSED' && profile.prerun) {
        await prerun(profile, true); // its proxy was stopped meanwhile: start it again and try once more
        foreign = await foreignGateway(profile);
        if (!foreign) answer = await send(request, req.method, abort.signal);
      }
      if (abort.signal.aborted) return;
      if (foreign) {
        tried.push(`${profile.name}:another program`);
        held = held || { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `hoprig router: ${providerName(profile.name, profile.label)}: ${foreign}` } })) };
        continue;
      }
      if (answer.error) {
        tried.push(`${profile.name}:${answer.error.code || 'error'}`);
        held = held || { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `hoprig router: ${providerName(profile.name, profile.label)} cannot be reached (${answer.error.code || answer.error.message})` } })) };
        continue;
      }
      const verdict = routed ? judge(answer.status, answer.headers) : { next: false, mark: null };
      if (routed) noteUsage(profile, answer.headers);
      tried.push(`${profile.name}:${answer.status}`);
      if (verdict.mark) markLimited(profile.name, verdict.mark);
      if (timed && (answer.status === 429 || answer.status === 529)) noteAnswer(profile, { refused: true });
      if (verdict.next) {
        // Keep the refusal: if nobody else can answer, Claude Code gets the first one (the preferred account's).
        const refused = { status: answer.status, headers: answer.headers, body: await collect(answer.res, ERROR_BODY_MAX) };
        held = held || refused;
        continue;
      }
      if (routed) noteSession(req, profile);
      if (routed) log(`${new Date().toISOString()} ${String(req.headers['x-claude-code-session-id'] || '-').slice(0, 8)} ${tried.join(' > ')}`);
      const headers = { ...answer.headers };
      delete headers.connection;
      delete headers['keep-alive'];
      res.writeHead(answer.status, headers);
      answer.res.pipe(res);
      // Only a streamed answer (the session's own turns) is timed: one that is not (a title, a suggestion) sends its
      // first byte only when the whole answer is made, which says nothing of how soon work starts.
      const streamed = /event-stream/i.test(String(answer.headers['content-type'] || ''));
      if (timed && streamed && answer.status < 400) answer.res.once('data', () => noteAnswer(profile, { ms: Date.now() - answer.sentAt }));
      return;
    }
    if (routed) log(`${new Date().toISOString()} ${String(req.headers['x-claude-code-session-id'] || '-').slice(0, 8)} ${tried.join(' > ') || '-'} (${handoff ? `continue as ${handoff}` : 'no account could answer'})`);
    if (!held && handoff) {
      // The identity was already known to be at its limit, so it was not even asked. Claude Code must still hear
      // "limit reached": that is what makes the launcher restart it as the next subscription. Not to be retried.
      const text = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `This provider is at its usage limit. Hoprig continues the session on ${providerName(handoff, profiles.find((p) => p.name === handoff)?.label)}.` } });
      res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false', 'content-length': String(Buffer.byteLength(text)) });
      return res.end(text);
    }
    if (!held) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"type":"error","error":{"type":"api_error","message":"hoprig router: no provider in the Auto order can be used from here. Check: hoprig auto status"}}');
    }
    const headers = { ...held.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];
    headers['content-length'] = String(held.body.length);
    res.writeHead(held.status, headers);
    res.end(held.body);
  }

  const server = http.createServer((req, res) => {
    inflight++;
    res.on('close', () => { inflight--; });
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(e.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `hoprig router: ${e.message}` } }));
    });
  });
  server.requestTimeout = 0; // a model answer may stream for many minutes
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 120_000;
  return server;
}

// ---- running it ----

const routerLog = () => path.join(stateDir(), 'router.log');

async function ping(address, timeoutMs = 800) {
  try {
    const r = await fetch(`${address.url}/__router`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** `hoprig router`: run the router in the foreground (the launcher starts it in the background by itself). */
export async function routerMain(version) {
  const address = routerAddress();
  if (await ping(address)) {
    console.log(`The router is already running on port ${address.port}.`);
    return 0;
  }
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const out = fs.createWriteStream(routerLog(), { flags: 'a', mode: 0o600 });
  const server = createRouter({ key: address.key, version, log: (line) => out.write(line + '\n') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.port, '127.0.0.1', resolve);
  });
  console.log(`hoprig router: listening on 127.0.0.1:${address.port}`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return null; // keep running
}

/**
 * Make sure the router runs; returns its URL for ANTHROPIC_BASE_URL. Started detached, so it outlives the
 * launcher that started it: other sessions use it too.
 */
export async function ensureRouter() {
  const address = routerAddress();
  if (await ping(address)) return address.url;
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const log = fs.openSync(routerLog(), 'a', 0o600);
  const child = spawn(process.execPath, [binFile(), 'router'], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await ping(address, 400)) return address.url;
  }
  throw new Error(`the router did not start (port ${address.port} may be in use; see ${routerLog()})`);
}
