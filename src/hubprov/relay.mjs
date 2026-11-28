// The hub's relay: a linked computer's request for one of the hub's providers, answered here with the hub's own key.
//
//   GET  /hubp/list            the list of providers this computer may use (list.mjs): names, kinds, models, marks
//   ANY  /hubp/<name>/v1/...   the request, passed on to that provider's endpoint with its key added, answered byte for byte
//
// Who is calling is never in the request: it is the stream the request came on (a linked computer's own link, see
// feature.mjs) or a relay secret the hub gave that computer. Every refusal is the HUB's: the switch, the owner's keep
// mark, the "not his own" mark, the paths of the provider's kind, the limit per computer. The key is added here and goes
// no further than the provider's endpoint; the answer comes back without it.
import { markLimited } from '../autoswitch.mjs';
import { apiError, forward, unreachable } from '../gateway/forward.mjs';
import { unsafePath, upstreamAuth } from '../gateway/index.mjs';
import { defaultHubLabel } from '../machines/hub.mjs';
import { getMachine } from '../machines/store.mjs';
import { readOwnProfile, validName } from '../profiles.mjs';
import { judge } from '../router.mjs';
import { buildList, isKept, pathAllowed, relayable, sharing } from './list.mjs';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const NAME_RE = /^\/hubp\/([a-z0-9][a-z0-9_-]{0,31})(\/v1\/[A-Za-z0-9_./-]*)$/;

/** Where a provider's request goes and how it is signed: { target, auth } or null (not relayable). */
export function upstreamOf(p, rest, search) {
  if (!relayable(p)) return null;
  const env = p.env;
  let base;
  let auth;
  if (p.kind === 'openai') {
    base = env.OPENAI_BASE_URL || process.env.HOPRIG_OPENAI_URL || 'https://api.openai.com';
    auth = { authorization: `Bearer ${env.OPENAI_API_KEY}` };
  } else {
    base = env.ANTHROPIC_BASE_URL || process.env.HOPRIG_ANTHROPIC_URL || 'https://api.anthropic.com';
    const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
    let u0;
    try {
      u0 = new URL(base);
    } catch {
      return null;
    }
    // A gateway of this computer: the same credential headers its own pass-through uses.
    auth = (LOCAL_HOSTS.has(u0.hostname) && upstreamAuth(p, Number(u0.port || 80))) || (env.ANTHROPIC_AUTH_TOKEN ? { authorization: `Bearer ${key}` } : { 'x-api-key': key });
  }
  let u;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  const prefix = u.pathname.replace(/\/+$/, '');
  // A base that already ends in /v1 (OpenAI's own convention) is not given /v1 twice.
  const tail = prefix.endsWith('/v1') && rest.startsWith('/v1/') ? rest.slice(3) : rest;
  return { target: { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: prefix + tail + search }, auth };
}

/** A sliding window: at most `max` per `ms` for each id. */
function windowed(max, ms, now) {
  const seen = new Map();
  return (id) => {
    const t = now();
    const list = (seen.get(id) || []).filter((x) => t - x < ms);
    if (list.length >= max) return false;
    list.push(t);
    seen.set(id, list);
    return true;
  };
}

/**
 * `opts`: now, perMinute (300), machineOf(name) (a stand-in for the store), profileOf(name), listOf(), label(), mark(name, mark)
 * (what a refused or limited answer is remembered with), failedOf(who) (the words of a connection error).
 */
export function createRelay({ now = Date.now, perMinute = 300, machineOf = getMachine, profileOf = readOwnProfile, listOf = () => buildList(), label = () => defaultHubLabel(), mark = markLimited, forwardImpl = forward, idleMs = 10 * 60_000 } = {}) {
  const allowed = windowed(perMinute, 60_000, now);
  const usage = new Map(); // computer name -> { requests, since }
  const count = (machine) => {
    const u = usage.get(machine) || { requests: 0, since: now() };
    u.requests += 1;
    usage.set(machine, u);
  };

  /** Pass `req` on if everything the hub decides allows it. `caller`: { machine } (never taken from the request). */
  async function handle(req, res, caller) {
    const deny = (status, type, message, headers = {}) => {
      req.resume();
      apiError(res, status, type, message, headers);
      return true;
    };
    if (!caller || typeof caller.machine !== 'string') return deny(404, 'not_found_error', 'not found');
    const path = String(req.url || '').split(/[?#]/)[0];
    if (unsafePath(String(req.url || '')) || unsafePath(path)) return deny(404, 'not_found_error', 'This path is not allowed.');
    const m = machineOf(caller.machine);
    const hub = label();
    // The computer is known and the owner's own: decided here, never by the computer that asks.
    if (!m || m.own === false) return deny(403, 'permission_error', `${hub} does not share its providers with this computer.`);
    if (!sharing()) return deny(403, 'permission_error', `${hub} no longer shares its providers with this computer.`);
    if (!allowed(caller.machine)) return deny(429, 'rate_limit_error', `Too many requests from this computer through ${hub} right now.`, { 'Retry-After': '20' });
    if (path === '/hubp/list') {
      if (req.method !== 'GET') return deny(404, 'not_found_error', 'not found');
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ hub: hub, ...listOf() }));
      return true;
    }
    const hit = NAME_RE.exec(path);
    if (!hit || !validName(hit[1])) return deny(404, 'not_found_error', 'not found');
    const [, name, rest] = hit;
    if (isKept(name)) return deny(403, 'permission_error', `${hub} keeps this provider to itself.`);
    const p = profileOf(name);
    if (!p || !relayable(p)) return deny(404, 'not_found_error', 'There is no such provider on the hub.');
    if (!pathAllowed(p.kind, req.method, rest)) return deny(404, 'not_found_error', 'Only the API of this provider passes.');
    const search = (String(req.url).match(/\?[^#]*/) || [''])[0];
    const up = upstreamOf(p, rest, search);
    if (!up) return deny(404, 'not_found_error', 'There is no such provider on the hub.');
    count(caller.machine);
    // What the answer says about this provider's limit is kept here too, so every computer sees one mark.
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...a) => {
      try {
        const j = judge(status, Object.fromEntries(Object.entries(a.find((x) => x && typeof x === 'object') || {}).map(([k, v]) => [k.toLowerCase(), v])), now());
        if (j.mark) mark(name, j.mark, now());
      } catch {
        /* a mark that cannot be kept must not break the answer */
      }
      return writeHead(status, ...a);
    };
    await forwardImpl(req, res, { target: up.target, auth: up.auth, idleMs, failed: unreachable(`The provider ${p.label || name} on ${hub}`) });
    return true;
  }

  return { handle, usage: () => Object.fromEntries(usage) };
}
