// One gateway for every computer: the AI gateways the add-ons know (TRouteAI first; any local service with Claude's
// API that an add-on describes with `gateway: { port }`), found on this computer and on every computer this dashboard
// knows, and used from any of them. A server feature: { name, handle, routes, states }.
//
// Sharing. The computer that runs a gateway shares it through its own dashboard, so it works on every network the
// dashboard is reached on (the same network, Tailscale, the public link):
//   /gateway/<id>/v1/…          passed on to 127.0.0.1:<its port>/v1/…, streaming. Allowed only with a gateway key
//                               this dashboard made (keys.mjs: hop_gw_…, kept hashed, one per computer that uses it),
//                               only while the owner has sharing on for that gateway, and rate limited. The key is
//                               dropped and the gateway's own key added (from the provider file of that gateway here),
//                               so the gateway's key never leaves this computer. Only /v1/ is reachable: the gateway's
//                               own dashboard and settings on the same port are not.
//   /gateway/<id>/__status      with the key: { hoprig: 'gateway', title, computer, running, model… } (a check)
//   POST /gateway/<id>/__revoke with the key: the key gives itself up (its provider was removed on the other side)
// Using a linked computer's gateway. A provider here points at this dashboard:
//   /gateway/m/<computer>/<id>/…  passed on to that computer's /gateway/<id>/… over the existing link (SSH tunnel,
//                               relay or address), with the gateway key and nothing else. Only a key that a provider
//                               file on this computer holds for that computer and gateway passes. The address stays
//                               the same whatever the link is (an SSH tunnel's port changes), and when the computer is
//                               offline Claude Code reads that in plain words.
//
// Routes (behind the login; "token" = another dashboard's machine token may call it too):
//   GET  /api/gateways                     token  this computer's gateways: { computer, gateways }
//   GET  /api/gateways/all                        this computer's and every linked computer's, and the providers here
//                                                 that use another computer's gateway, with their state
//   POST /api/gateways/<id>/share { on }   token  sharing on or off (on: with the key of its provider here)
//   POST /api/gateways/<id>/keys { name }  token  a new key: { key, … } shown once. Only while sharing is on.
//   POST /api/gateways/keys/<keyId>/remove token
//   POST /api/gateways/use { machine, gateway, share? }  one click: ask that computer for a key (turning its sharing
//                                                 on first with share: true), write the provider here
// "token" on share and remove: the owner works from the hub, and a machine token can already run a terminal on this
// computer, so it adds no power. Writing a provider (use, add) and the list of every computer need the login here.
//   POST /api/gateways/add { url, key, label? }   a gateway shared by a computer that is not linked
import crypto from 'node:crypto';
import { listening } from '../addons/trouteai.mjs';
import { ADDONS } from '../addons/index.mjs';
import { loadConfig } from '../config.mjs';
import { callJson } from '../machines/relay.mjs';
import { dashboardUrl, slug } from '../machines/names.mjs';
import { getMachine, loadMachines } from '../machines/store.mjs';
import { listProfiles, readProfile, writeProfile } from '../profiles.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { cleanLabel, cleanModel, freeName } from '../server/accounts.mjs';
import { RateLimiter } from '../server/auth.mjs';
import { apiError, forward, unreachable } from './forward.mjs';
import { GATEWAY_ID_RE, createKey, listKeys, looksLikeKey, removeKey, setShared, sharedProvider, verifyKey } from './keys.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const VIA_RE = /\/gateway\/m\/([a-z0-9][a-z0-9_-]{0,31})\/([a-z][a-z0-9-]{0,30})$/;
const DIRECT_RE = /^(.*)\/gateway\/([a-z][a-z0-9-]{0,30})$/;
const MODELS_RE = /^\*=[A-Za-z0-9._:/@+\-[\]]{1,120}$/;

/** The gateway key an API client sends: as a bearer token (ANTHROPIC_AUTH_TOKEN) or as x-api-key (ANTHROPIC_API_KEY). */
export function presentedKey(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  if (m) return m[1];
  const x = req.headers['x-api-key'];
  return typeof x === 'string' && x ? x.trim() : null;
}

/**
 * Whether a provider uses another computer's gateway, from its address and key: { kind: 'linked', machine, gateway }
 * (through this dashboard) or { kind: 'address', url, gateway } (straight to that dashboard), else null.
 */
export function remoteUse(profile) {
  const env = (profile && profile.env) || {};
  if (!env.ANTHROPIC_BASE_URL || !looksLikeKey(env.ANTHROPIC_AUTH_TOKEN)) return null;
  let u;
  try {
    u = new URL(env.ANTHROPIC_BASE_URL);
  } catch {
    return null;
  }
  const p = u.pathname.replace(/\/+$/, '');
  let m = VIA_RE.exec(p);
  if (m) return { kind: 'linked', machine: m[1], gateway: m[2] };
  m = DIRECT_RE.exec(p);
  return m ? { kind: 'address', url: `${u.origin}${m[1]}`, gateway: m[2] } : null;
}

/**
 * The credential headers a gateway's provider file holds, for passing a request on to that gateway on `port` — or
 * null when the provider cannot be used for that: it must be an API provider at this computer's own address and
 * port, and never a subscription's sign-in (only Claude Code itself uses one of those).
 */
export function upstreamAuth(profile, port) {
  const env = (profile && profile.env) || {};
  if (!profile || profile.kind !== 'api' || env.CLAUDE_CODE_OAUTH_TOKEN) return null;
  let u;
  try {
    u = new URL(env.ANTHROPIC_BASE_URL || '');
  } catch {
    return null;
  }
  if (!LOCAL_HOSTS.has(u.hostname) || Number(u.port || 80) !== port) return null;
  const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
  if (!key || /^sk-ant-oat/.test(key) || /[\r\n]/.test(key)) return null;
  return env.ANTHROPIC_AUTH_TOKEN ? { authorization: `Bearer ${key}` } : { 'x-api-key': key };
}

/** A sliding window: at most `max` uses per `windowMs` for each id. */
function windowLimit(max, windowMs, now) {
  const seen = new Map();
  return (id) => {
    const t = now();
    const list = (seen.get(id) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) return false;
    list.push(t);
    seen.set(id, list);
    if (seen.size > 1000) seen.clear();
    return true;
  };
}

/**
 * opts: { hub (the machines hub: endpoint, hubLabel, hubName), addons (stand-ins), now, perKeyPerMinute,
 * failuresPerIp } — tests pass small limits and fake add-ons.
 */
export function gatewayFeature(ctx, { hub = null, addons = null, now = Date.now, perKeyPerMinute = 300, failuresPerIp = 10 } = {}) {
  const label = () => (hub ? hub.hubLabel() : 'this computer');
  const gateways = () => (addons || ADDONS)
    .filter((a) => a.gateway && typeof a.gateway.port === 'function' && GATEWAY_ID_RE.test(a.id) && a.id !== 'm')
    .map((a) => ({ id: a.id, title: a.title, port: Number(a.gateway.port()), addon: a }));
  const gatewayOr404 = (id) => {
    const g = gateways().find((x) => x.id === id);
    if (!g) throw fail(404, 'There is no such gateway on this computer');
    return g;
  };
  const failures = new RateLimiter({ perIp: failuresPerIp, global: failuresPerIp * 20, windowMs: 15 * 60_000, now });
  const perKey = windowLimit(perKeyPerMinute, 60_000, now);
  const checks = windowLimit(30, 10 * 60_000, now); // "add by address" reaches out with a key
  const ownerOnly = (req) => {
    if (!ctx.authed(req)) throw fail(403, `Only ${label()}'s own page can change this`);
  };

  // ---------- this computer's gateways ----------

  const statusCache = new Map(); // id → { at, st }: status() runs the gateway's command for its version
  async function addonStatus(g) {
    const hit = statusCache.get(g.id);
    if (hit && now() - hit.at < 30_000) return hit.st;
    const st = await Promise.resolve(g.addon.status()).catch(() => ({ installed: false, version: null }));
    statusCache.set(g.id, { at: now(), st });
    return st;
  }

  /** The provider here that uses gateway `g` directly: the one sharing names first, else the first that fits. */
  function localProvider(g) {
    const shared = sharedProvider(g.id);
    const all = listProfiles().filter((p) => upstreamAuth(p, g.port));
    return all.find((p) => p.name === shared) || all[0] || null;
  }

  async function localView(g, owner) {
    const [st, running] = await Promise.all([addonStatus(g), listening(g.port)]);
    const p = localProvider(g);
    const shared = Boolean(p && sharedProvider(g.id) === p.name);
    return {
      id: g.id, title: g.title, installed: Boolean(st.installed) || running, version: st.version || null, running,
      address: `http://127.0.0.1:${g.port}`, shared, ready: Boolean(p), // ready: a provider here holds its key
      ...(owner ? { provider: p ? { name: p.name, label: p.label } : null, keys: listKeys(g.id) } : {}),
    };
  }

  // ---------- providers here that use another computer's gateway ----------

  /** Where a provider's requests go first, for a check: { ep, path, who } or a reason it cannot. */
  async function targetOf(use, timeoutMs) {
    if (use.kind === 'linked') {
      const m = getMachine(use.machine);
      if (!m) return { gone: `${use.machine} is no longer one of your computers` };
      const ep = await hub.endpoint(m, timeoutMs);
      return { ep, path: `/gateway/${use.gateway}`, who: m.label || m.name };
    }
    const u = new URL(use.url);
    return { ep: epOf(u), path: `${u.pathname.replace(/\/+$/, '')}/gateway/${use.gateway}`, who: u.host };
  }

  let stateCache = { at: 0, map: null };
  let asking = null;
  /**
   * provider name → { gateway, computer, state: online | offline | refused, text }. Asked again after 10 s; until then,
   * and while a new answer is on its way, the last one is used, so a list never waits on a computer that is off.
   */
  function states({ fresh = false } = {}) {
    if (!fresh && stateCache.map && now() - stateCache.at < 10_000) return Promise.resolve(stateCache.map);
    asking ||= ask().finally(() => (asking = null));
    return fresh || !stateCache.map ? asking : Promise.resolve(stateCache.map);
  }
  async function ask() {
    const map = new Map();
    await Promise.all(listProfiles().map(async (p) => {
      const use = remoteUse(p);
      if (!use) return;
      const base = { gateway: use.gateway, kind: use.kind, machine: use.kind === 'linked' ? use.machine : null, computer: use.kind === 'linked' ? use.machine : new URL(use.url).host };
      try {
        if (use.kind === 'linked' && !hub) throw new Error('no hub');
        const t = await targetOf(use, 2500);
        if (t.gone) return void map.set(p.name, { ...base, state: 'offline', text: t.gone });
        base.computer = t.who;
        const r = await callJson(t.ep, { machine: t.who, path: `${t.path}/__status`, headers: { Authorization: `Bearer ${p.env.ANTHROPIC_AUTH_TOKEN}` }, timeoutMs: 2500 });
        if (r.status === 200 && r.json && r.json.hoprig === 'gateway') return void map.set(p.name, { ...base, title: String(r.json.title || use.gateway).slice(0, 60), state: 'online', text: `On ${t.who}` });
        const said = r.json && r.json.error && r.json.error.message;
        map.set(p.name, { ...base, state: 'refused', text: typeof said === 'string' ? said.slice(0, 200) : `${t.who} refused it (HTTP ${r.status})` });
      } catch {
        map.set(p.name, { ...base, state: 'offline', text: `${base.computer} is offline` });
      }
    }));
    stateCache = { at: now(), map };
    return map;
  }
  // A provider was added or removed here: the next list asks again and waits for that answer (the old one lacks it).
  const changed = () => (stateCache = { at: 0, map: null });

  // ---------- passing requests on ----------

  /** /gateway/<id>/…: this computer's gateway, for a computer that holds a key. */
  async function share(req, res, id, rest, search) {
    const deny = (status, type, message, headers) => {
      req.resume();
      apiError(res, status, type, message, headers);
    };
    const g = gateways().find((x) => x.id === id);
    if (!g) return deny(404, 'not_found_error', `There is no gateway "${id}" on ${label()}.`);
    const ip = ctx.clientIp(req);
    const wait = failures.retryAfter(ip);
    if (wait > 0) return deny(429, 'rate_limit_error', 'Too many wrong gateway keys. Wait a few minutes.', { 'Retry-After': String(Math.ceil(wait / 1000)) });
    const key = presentedKey(req);
    const entry = key ? verifyKey(key, g.id) : null;
    if (!entry) {
      failures.fail(ip);
      return deny(401, 'authentication_error', key
        ? `This gateway key is not valid on ${label()}: it was removed or belongs to another gateway.`
        : `${g.title} on ${label()} needs a gateway key from its dashboard.`);
    }
    if (rest === '/__revoke' && req.method === 'POST') {
      req.resume();
      removeKey(entry.id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end('{"removed":true}');
    }
    if (!perKey(entry.id)) return deny(429, 'rate_limit_error', `Too many requests through ${g.title} on ${label()} right now.`, { 'Retry-After': '20' });
    const provider = sharedProvider(g.id);
    if (!provider) return deny(403, 'permission_error', `Sharing of ${g.title} is turned off on ${label()}.`);
    const p = readProfile(provider);
    const auth = upstreamAuth(p, g.port);
    if (!auth) return deny(503, 'api_error', `${g.title} on ${label()} has no provider to share any more. Turn sharing on again there.`);
    if (rest === '/__status' && req.method === 'GET') {
      req.resume();
      const env = p.env;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify({
        hoprig: 'gateway', gateway: g.id, title: g.title, computer: label(), running: await listening(g.port),
        model: env.ANTHROPIC_MODEL || '', smallModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '', models: MODELS_RE.test(p.models) ? p.models : '',
      }));
    }
    if (!/^\/v1\//.test(rest)) return deny(404, 'not_found_error', 'Only Claude\'s API (/v1/…) is shared through this address.');
    // Started on demand, as for a provider on this computer itself.
    if (!(await listening(g.port)) && typeof g.addon.start === 'function') await Promise.resolve(g.addon.start()).catch(() => null);
    await forward(req, res, { target: { protocol: 'http:', hostname: '127.0.0.1', port: g.port, path: rest + search }, auth, failed: unreachable(`${g.title} on ${label()}`) });
  }

  /** The provider here that holds `key` for computer `name` and gateway `id` (the pass-through's only credential). */
  function heldBy(key, name, id) {
    if (!looksLikeKey(key)) return null;
    let found = null;
    for (const p of listProfiles()) {
      const use = remoteUse(p);
      if (use && use.kind === 'linked' && use.machine === name && use.gateway === id && sameSecret(p.env.ANTHROPIC_AUTH_TOKEN, key) && !found) found = p;
    }
    return found;
  }

  /** /gateway/m/<computer>/<id>/…: a linked computer's gateway, for the providers of this computer. */
  async function via(req, res, name, id, rest, search) {
    const deny = (status, type, message) => {
      req.resume();
      apiError(res, status, type, message);
    };
    const ip = ctx.clientIp(req);
    if (failures.retryAfter(ip) > 0) return deny(429, 'rate_limit_error', 'Too many wrong gateway keys. Wait a few minutes.');
    const key = presentedKey(req);
    if (!heldBy(key, name, id)) {
      failures.fail(ip);
      return deny(401, 'authentication_error', 'This address is only for the providers of this computer.');
    }
    const m = hub ? getMachine(name) : null;
    if (!m) return deny(404, 'not_found_error', `${name} is no longer one of your computers. Use its gateway again from the Providers page.`);
    const who = m.label || m.name;
    let ep;
    try {
      ep = await hub.endpoint(m);
    } catch {
      return deny(502, 'api_error', `${who} is offline or its dashboard is not running. This provider works again once it is on.`);
    }
    await forward(req, res, {
      target: { protocol: ep.protocol, hostname: ep.hostname, port: ep.port, path: `${ep.basePath || ''}/gateway/${id}${rest}${search}` },
      auth: { authorization: `Bearer ${key}` },
      failed: (e) => (e && e.code === 'timeout'
        ? { status: 504, type: 'api_error', message: `${who} did not answer in time.` }
        : { status: 502, type: 'api_error', message: `${who} is offline or its dashboard is not running. This provider works again once it is on.` }),
    });
  }

  async function handle(req, res) {
    if (!req.url.startsWith('/gateway/')) return false;
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return false;
    }
    const p = url.pathname;
    const linked = /^\/gateway\/m\/([a-z0-9][a-z0-9_-]{0,31})\/([a-z][a-z0-9-]{0,30})(\/.*)?$/.exec(p);
    if (linked) {
      await via(req, res, linked[1], linked[2], linked[3] || '/', url.search);
      return true;
    }
    const own = /^\/gateway\/([a-z][a-z0-9-]{0,30})(\/.*)?$/.exec(p);
    if (own) await share(req, res, own[1], own[2] || '/', url.search);
    else apiError(res, 404, 'not_found_error', 'not found');
    return true;
  }

  // ---------- writing a provider for another computer's gateway ----------

  /** This dashboard's own address, for a provider on this computer that goes through it. */
  function localBase(req) {
    const d = runningDashboard();
    let host = d ? d.host : String((req.socket && req.socket.localAddress) || '');
    const port = d ? d.port : req.socket && req.socket.localPort;
    if (!port) throw fail(500, 'This dashboard does not know its own address');
    host = host.replace(/^::ffff:/, '');
    if (!host || host === '0.0.0.0' || host === '::') host = '127.0.0.1';
    if (host.includes(':')) host = `[${host}]`;
    return `http://${host}:${port}`;
  }

  /** The model fields another computer sent: kept only when they are plain model names. */
  function modelsFrom(j) {
    const ok = (v) => {
      try {
        return cleanModel(v, { optional: true });
      } catch {
        return '';
      }
    };
    return { model: ok(j.model), smallModel: ok(j.smallModel), models: typeof j.models === 'string' && MODELS_RE.test(j.models) ? j.models : '' };
  }

  function writeRemote({ base, key, title, computer, models: { model, smallModel, models }, label: wanted }) {
    const name = freeName(`gw-${slug(computer, 'computer')}`.slice(0, 28).replace(/-+$/, ''));
    const lbl = cleanLabel(wanted, `${title} on ${computer}`.slice(0, 60));
    const env = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key };
    if (model) env.ANTHROPIC_MODEL = model;
    if (smallModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
    // No PRERUN: the gateway runs on the other computer, so nothing is started here.
    writeProfile(name, { label: lbl, models: models || (model ? `*=${model}` : ''), env });
    changed();
    return { ok: true, name, label: lbl };
  }

  // ---------- routes ----------

  const routes = [
    ['GET', /^\/api\/gateways$/, async (req) => {
      const owner = ctx.authed(req);
      return { computer: label(), gateways: await Promise.all(gateways().map((g) => localView(g, owner))) };
    }],
    ['GET', /^\/api\/gateways\/all$/, async (req) => {
      ownerOnly(req);
      const used = await states({ fresh: true });
      const usedAs = (machine, gateway) => {
        for (const [n, s] of used) if (s.kind === 'linked' && s.machine === machine && s.gateway === gateway) return { name: n, label: readProfile(n)?.label || n };
        return null;
      };
      const here = { machine: null, label: label(), state: 'online', gateways: await Promise.all(gateways().map((g) => localView(g, true))) };
      const others = hub ? await Promise.all(loadMachines().map(async (m) => {
        const out = { machine: m.name, label: m.label || m.name, state: 'offline', gateways: [] };
        try {
          const ep = await hub.endpoint(m, 3000);
          const r = await callJson(ep, { machine: out.label, path: '/api/gateways', token: m.token, timeoutMs: 3000 });
          if (r.status === 404) return { ...out, state: 'too-old' };
          if (r.status !== 200 || !r.json || !Array.isArray(r.json.gateways)) return out;
          const list = r.json.gateways.filter((g) => g && GATEWAY_ID_RE.test(g.id)).slice(0, 20).map((g) => ({
            id: g.id, title: cleanLabel(String(g.title || g.id).slice(0, 60), g.id), installed: g.installed === true, running: g.running === true,
            version: typeof g.version === 'string' ? g.version.slice(0, 40) : null, shared: g.shared === true, ready: g.ready === true, usedAs: usedAs(m.name, g.id),
          }));
          return { ...out, state: 'online', gateways: list };
        } catch (e) {
          return { ...out, state: e.code === 'not-authorised' ? 'unauthorised' : 'offline' };
        }
      })) : [];
      for (const g of here.gateways) g.usedAs = g.provider;
      const providers = [...used].map(([n, s]) => ({ name: n, label: readProfile(n)?.label || n, ...s }));
      return { computers: [here, ...others], used: providers };
    }],
    ['POST', /^\/api\/gateways\/([^/]+)\/share$/, async (req, m) => {
      const b = await ctx.readJson(req);
      const g = gatewayOr404(m[1]);
      if (b.on === true) {
        const p = localProvider(g);
        if (!p) throw fail(409, `First add ${g.title} as a provider on ${label()} (Providers → Gateways on your computers → Use here): sharing passes on the key of that provider.`);
        setShared(g.id, p.name);
      } else setShared(g.id, null);
      return localView(g, true);
    }],
    ['POST', /^\/api\/gateways\/([^/]+)\/keys$/, async (req, m) => {
      const b = await ctx.readJson(req);
      const g = gatewayOr404(m[1]);
      const provider = sharedProvider(g.id);
      const p = provider ? readProfile(provider) : null;
      if (!p || !upstreamAuth(p, g.port)) throw fail(409, `Sharing of ${g.title} is turned off on ${label()}. Turn it on there first: Providers → Gateways on your computers.`);
      const { id, key } = createKey(g.id, typeof b.name === 'string' ? b.name : '');
      const cfg = loadConfig().server;
      return {
        key, keyId: id, gateway: g.id, title: g.title, computer: label(), path: `/gateway/${g.id}`,
        publicUrl: dashboardUrl(String(cfg.publicUrl || '')) || null,
        ...modelsFrom({ model: p.env.ANTHROPIC_MODEL, smallModel: p.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, models: p.models }),
      };
    }],
    ['POST', /^\/api\/gateways\/keys\/([0-9a-f]{12})\/remove$/, async (req, m) => {
      await ctx.readJson(req);
      const gone = removeKey(m[1]);
      if (!gone) throw fail(404, 'There is no such key');
      return { removed: gone };
    }],
    ['POST', /^\/api\/gateways\/use$/, async (req) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      const mm = typeof b.machine === 'string' ? getMachine(b.machine) : null;
      if (!mm || !hub) throw fail(404, 'There is no such computer');
      if (typeof b.gateway !== 'string' || !GATEWAY_ID_RE.test(b.gateway)) throw fail(400, 'Say which gateway: { machine, gateway }');
      const taken = [...(await states())].find(([, s]) => s.kind === 'linked' && s.machine === mm.name && s.gateway === b.gateway);
      if (taken) throw fail(409, `This gateway is already used here as "${readProfile(taken[0])?.label || taken[0]}"`);
      const who = mm.label || mm.name;
      const ep = await hub.endpoint(mm, 8000).catch(() => {
        throw fail(502, `${who} is offline or its dashboard is not running`);
      });
      if (b.share === true) {
        const s = await callJson(ep, { machine: who, method: 'POST', path: `/api/gateways/${b.gateway}/share`, body: { on: true }, token: mm.token, timeoutMs: 8000 })
          .catch((e) => {
            throw fail(502, e.message);
          });
        if (s.status !== 200) throw fail(s.status === 409 ? 409 : 502, (s.json && s.json.error) || `${who} did not turn sharing on (HTTP ${s.status})`);
      }
      const r = await callJson(ep, { machine: who, method: 'POST', path: `/api/gateways/${b.gateway}/keys`, body: { name: hub.hubName }, token: mm.token, timeoutMs: 8000 })
        .catch((e) => {
          throw fail(502, e.message);
        });
      if (r.status === 404 && !(r.json && r.json.error)) throw fail(502, `${who} runs a Hoprig too old to share a gateway. Update it there: hoprig update`);
      if (r.status !== 200 || !r.json || !looksLikeKey(r.json.key)) throw fail(r.status === 409 ? 409 : 502, (r.json && r.json.error) || `${who} did not give a key (HTTP ${r.status})`);
      const title = cleanLabel(String(r.json.title || b.gateway).slice(0, 40), b.gateway);
      return writeRemote({ base: `${localBase(req)}/gateway/m/${mm.name}/${b.gateway}`, key: r.json.key, title, computer: who, models: modelsFrom(r.json), label: b.label });
    }],
    ['POST', /^\/api\/gateways\/add$/, async (req) => {
      ownerOnly(req);
      const b = await ctx.readJson(req);
      if (!checks(ctx.clientIp(req))) throw fail(429, 'Too many checks in a short time. Wait a few minutes.');
      const full = dashboardUrl(typeof b.url === 'string' ? b.url : '');
      const m = full ? DIRECT_RE.exec(new URL(full).pathname.replace(/\/+$/, '')) : null;
      if (!m) throw fail(400, 'Paste the whole address the other computer shows, ending in /gateway/<name>');
      const key = typeof b.key === 'string' ? b.key.trim() : '';
      if (!looksLikeKey(key)) throw fail(400, 'Paste the whole gateway key: it starts with hop_gw_');
      const u = new URL(full);
      const r = await callJson(epOf(u), { machine: u.host, path: `${u.pathname.replace(/\/+$/, '')}/__status`, headers: { Authorization: `Bearer ${key}` }, timeoutMs: 8000 })
        .catch((e) => {
          throw fail(502, e.message);
        });
      if (r.status !== 200 || !r.json || r.json.hoprig !== 'gateway') {
        const said = r.json && r.json.error && (r.json.error.message || r.json.error);
        throw fail(400, typeof said === 'string' ? said : `${u.host} did not answer as a shared gateway (HTTP ${r.status})`);
      }
      const title = cleanLabel(String(r.json.title || m[2]).slice(0, 40), m[2]);
      const computer = cleanLabel(String(r.json.computer || u.hostname).slice(0, 40), u.hostname);
      return writeRemote({ base: full, key, title, computer, models: modelsFrom(r.json), label: b.label });
    }],
  ];

  /** A provider here is being removed: when it used another computer's gateway, its key there is given up. */
  async function forget(profile) {
    const use = remoteUse(profile);
    if (!use || (use.kind === 'linked' && !hub)) return;
    try {
      const t = await targetOf(use, 3000);
      if (!t.gone) await callJson(t.ep, { machine: t.who, method: 'POST', path: `${t.path}/__revoke`, body: {}, headers: { Authorization: `Bearer ${profile.env.ANTHROPIC_AUTH_TOKEN}` }, timeoutMs: 3000 });
    } catch {
      /* offline: the key stays listed there, with "remove" */
    }
    changed();
  }

  return { name: 'gateway', handle, routes, states, forget };
}

/** Where an address is reached, in the shape of the machines relay: { protocol, hostname, port, basePath }. */
function epOf(u) {
  return { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), basePath: '' };
}
