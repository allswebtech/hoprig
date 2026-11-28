// The hub's providers on the owner's other computers.
//
// On the hub (the computer whose page the owner opens):
//   a linked computer opens a stream to the hub over the link it already has (src/machines/mux.mjs, a reverse OPEN). That
//   stream ends in one place: this relay (relay.mjs), which knows the caller by the stream, never by anything it says.
//   GET /hubp/list and /hubp/<name>/v1/... are served to those streams only. On the dashboard's own listener they are 404,
//   except for a request on loopback with no proxy header and a relay secret the hub gave that computer (a computer reached
//   over SSH), which is checked by its hash.
//   POST /api/hubprov/switch {on}, POST /api/hubprov/<name>/keep {on}, GET /api/hubprov/state: the owner's own page only
//   (a token, Tia, a session or a linked computer: 403).
//   The list is pushed to each computer the hub marks as the owner's own when it changes (POST /api/hubprov/push, the
//   hub's token), so nobody asks again and again.
//
// On a linked computer:
//   its list of the hub's providers (names, kinds, models, limit marks; never a key) is kept here and shows in the one
//   provider list (profiles.mjs setHubSource) as rows named hub-<name>. A session on one gets only this dashboard's loopback
//   address /hub/p/<name> and a key hop_hl_ made for it (localkeys.mjs, profileEnv). A request there is carried over the
//   link to the hub's relay and answered from it.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { apiError, forward } from '../gateway/forward.mjs';
import { unsafePath } from '../gateway/index.mjs';
import { loadJoined } from '../machines/join.mjs';
import { tokenIdOf } from '../machines/index.mjs';
import { loadMachines } from '../machines/store.mjs';
import { recordHubActivity } from '../machines/tokenaudit.mjs';
import { storedTokens } from '../machines/tokens.mjs';
import { tcpProbe } from '../machines/tunnels.mjs';
import { ownProfiles } from '../profiles.mjs';
import { duplexPair } from './duplex.mjs';
import { RELAY_SECRET_RE, SUBSCRIPTION_ROW, buildList, issueRelaySecret, keptNames, machineOfSecret, revokeRelaySecret, setKept, setSharing, sharing } from './list.mjs';
import { fromLoopback, keyRow, presentedKey } from './localkeys.mjs';
import { createRelay } from './relay.mjs';
import { hubRowName, rowsFile, saveRows } from './rows.mjs';
import { cleanRelay, loadSshHubs, saveSshHubs } from './sshhubs.mjs';

const ROW_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const OFFLINE_MS = 30_000;
/** What a computer answers (a code, never its words) when the token of the hub that pushes holds no hub mark. */
export const HUB_MARK_MISSING = 'hub-mark-missing';
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

const cleanRow = (r) => {
  if (!r || typeof r !== 'object' || !ROW_RE.test(String(r.name))) return null;
  const kind = r.kind === 'openai' ? 'openai' : r.kind === 'subscription' ? 'subscription' : 'api';
  const text = (v, n) => String(v ?? '').replace(/[\r\n]/g, ' ').slice(0, n);
  return {
    name: r.name, label: text(r.label || r.name, 60), kind, paid: r.paid === true, signin: r.signin === true,
    tools: Array.isArray(r.tools) ? r.tools.filter((t) => ['claude', 'codex', 'opencode'].includes(t)) : [],
    models: Array.isArray(r.models) ? r.models.map((m) => text(m, 120)).filter(Boolean).slice(0, 8) : [],
    ...(typeof r.map === 'string' && /^[A-Za-z0-9*][A-Za-z0-9._:/@+\-[\]*=,]{0,500}$/.test(r.map) ? { map: r.map } : {}),
    place: Number.isInteger(r.place) && r.place >= 0 && r.place < 100 ? r.place : null,
    limited: r.limited && Number.isFinite(r.limited.until) ? { until: r.limited.until, reason: text(r.limited.reason, 40) } : null,
  };
};
/** What B accepts from the hub as a list: only these fields, nothing else, whatever else was sent. */
export const cleanList = (j) => ({
  hub: String((j && j.hub) || '').replace(/[\r\n]/g, ' ').slice(0, 40),
  sharing: !!(j && j.sharing !== false),
  providers: (Array.isArray(j && j.providers) ? j.providers : []).map(cleanRow).filter(Boolean).slice(0, 40),
});

export function hubprovFeature(ctx, { machines = null, relay: relayOpts = {}, now = Date.now, joined = loadJoined, joinsOf = null, pushMs = 5000 } = {}) {
  const fail = (status, message) => new ctx.HttpError(status, message);
  const page = (req, what) => {
    if (ctx.caller(req) !== 'page') throw fail(403, `${what} is the owner's own step, on this computer's page`);
  };

  // ---------------- the hub's side ----------------
  const relay = createRelay({ now, ...relayOpts });
  const callers = new WeakMap(); // a stream's app end -> { machine }
  const relayServer = http.createServer((req, res) => {
    relay.handle(req, res, callers.get(req.socket) || null).catch(() => {
      if (!res.headersSent) apiError(res, 502, 'api_error', 'The relay could not answer.');
      else res.destroy();
    });
  });
  relayServer.on('clientError', (_e, sock) => sock.destroy());
  /** For LinkHub.hubStream: the socket of a new stream that linked computer `name` opened to the hub. */
  function streamFor(name) {
    const [app, wire] = duplexPair();
    callers.set(app, { machine: name });
    relayServer.emit('connection', app);
    return wire;
  }
  if (machines && machines.links) machines.links.hubStream = streamFor;

  // A computer reached over SSH comes in on the one extra forward of its ssh connection (tunnels.mjs): a port of this
  // computer's loopback that nothing but that ssh reaches the other end of. It is not the dashboard's listener: it serves the
  // relay only, and knows the caller by the relay secret made for that one computer (kept here as a hash).
  const secretServer = machines && machines.hub && machines.hub.tunnels && machines.hub.tunnels.opts ? http.createServer((req, res) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
    const machine = m ? machineOfSecret(m[1]) : null;
    if (!machine) {
      req.resume();
      return apiError(res, 404, 'not_found_error', 'not found');
    }
    delete req.headers.authorization;
    relay.handle(req, res, { machine }).catch(() => {
      if (!res.headersSent) apiError(res, 502, 'api_error', 'The relay could not answer.');
      else res.destroy();
    });
  }) : null;
  let relayPort = null;
  if (secretServer) {
    secretServer.on('clientError', (_e, sock) => sock.destroy());
    secretServer.on('listening', () => (relayPort = secretServer.address().port));
    secretServer.listen(0, '127.0.0.1');
    // From now on a tunnel to a computer added by SSH carries the forward back to the relay; its key follows the port.
    machines.hub.tunnels.opts.reverseOf = (m) => (m.via === 'ssh' && m.own !== false && relayPort ? relayPort : null);
    // Remove takes the secret back with the computer.
    const removeOrig = machines.hub.remove;
    machines.hub.remove = async (name, ...a) => {
      const r = await removeOrig(name, ...a);
      revokeRelaySecret(name);
      secrets.delete(name);
      pushed.delete(name);
      blocked.delete(name);
      mendTried.delete(name);
      return r;
    };
  }
  const secrets = new Map(); // machine -> the relay secret made in this run (the hub keeps only its hash)

  // The list B gets is pushed when it changes. Compared locally every few seconds; the network is used only on a change.
  const pushed = new Map(); // machine -> last list hash
  const retryAt = new Map(); // machine -> when to try again after a refusal (an older build has no such route)
  // A computer added by SSH on an early build holds the hub's token without the hub mark and refuses the push with
  // HUB_MARK_MISSING. The hub brings the mark up to date over the same ssh once per start; a refusal that stays is in the
  // state the page reads (blocked), not only in a retry every minute.
  const mendTried = new Set(); // machines asked once in this run
  const blocked = new Map(); // machine -> HUB_MARK_MISSING while its push is refused for that reason
  async function pushTo(m, body) {
    const ep = await machines.hub.endpoint(m, 3000);
    const { callJson } = await import('../machines/relay.mjs');
    return callJson(ep, { machine: m.label || m.name, method: 'POST', path: '/api/hubprov/push', body, token: m.token, timeoutMs: 4000 });
  }
  async function mendMark(m) {
    if (mendTried.has(m.name) || m.via !== 'ssh' || m.own === false || !machines.hub || typeof machines.hub.markHubOverSsh !== 'function') return false;
    mendTried.add(m.name);
    try {
      const r = await machines.hub.markHubOverSsh(m);
      if (!r || !r.ok) return false;
    } catch {
      return false;
    }
    recordHubActivity(`The link to ${m.label || m.name} was brought up to date`);
    return true;
  }
  async function pushAll(force = false) {
    if (!machines || !machines.hub) return;
    const base = { hub: relayLabel(), ...buildList() };
    for (const m of loadMachines()) {
      if (!m.token) continue;
      if (!force && (retryAt.get(m.name) || 0) > now()) continue;
      if (m.own === false) {
        // A computer the owner says is not his own: whatever it was given is taken back once (its rows go, its secret ends).
        if (pushed.get(m.name) === 'not-own') continue;
        revokeRelaySecret(m.name);
        secrets.delete(m.name);
        try {
          const ep = await machines.hub.endpoint(m, 3000);
          const { callJson } = await import('../machines/relay.mjs');
          const r = await callJson(ep, { machine: m.label || m.name, method: 'POST', path: '/api/hubprov/push', body: { hub: relayLabel(), sharing: false, providers: [] }, token: m.token, timeoutMs: 4000 });
          if (r.status === 200) pushed.set(m.name, 'not-own');
          else retryAt.set(m.name, now() + 60_000);
        } catch {
          /* offline: it keeps the rows until it can be told, and the hub refuses its requests anyway */
        }
        continue;
      }
      // A computer reached over SSH also gets where the relay is on it and its own secret (made once per run).
      const port = m.via === 'ssh' && relayPort ? machines.hub.tunnels.peek(m.name)?.reversePort || null : null;
      const h = hash({ base, port });
      if (!force && pushed.get(m.name) === h) continue;
      try {
        let relay = null;
        if (port) {
          if (!secrets.has(m.name)) secrets.set(m.name, issueRelaySecret(m.name));
          relay = { secret: secrets.get(m.name), port };
        }
        const body = relay ? { ...base, relay } : base;
        let r = await pushTo(m, body);
        const noMark = (x) => x.status === 403 && x.json && x.json.code === HUB_MARK_MISSING;
        if (noMark(r) && (await mendMark(m))) r = await pushTo(m, body);
        if (noMark(r)) blocked.set(m.name, HUB_MARK_MISSING);
        else blocked.delete(m.name);
        if (r.status === 200) pushed.set(m.name, h);
        else retryAt.set(m.name, now() + 60_000); // not this build yet: once a minute, now said in the state when it is the mark
      } catch {
        /* offline: it asks for the list itself when its link comes up */
      }
    }
  }
  const relayLabel = () => (machines && machines.hub && machines.hub.hubLabel ? machines.hub.hubLabel() : 'the main computer');

  // ---------------- a linked computer's side ----------------
  const rows = new Map(); // joined id -> { hub, providers, at }
  const offline = new Map(); // joined id -> until
  const asked = new Map(); // joined id -> upSince of the last fetch
  // A hub that reaches this computer over SSH tells where its relay is (sshhubs.mjs): the "client" of such a hub is that port
  // on this computer's own loopback, and it is up while something answers there.
  const relayUp = new Map(); // ssh hub id -> bool
  const clientOf = (h) => {
    if (h.via === 'ssh-relay') {
      return { state: relayUp.get(h.id) === false ? 'down' : 'up', upSince: upAt.get(h.id) || 1, hubStream: () => net.connect({ host: '127.0.0.1', port: h.relay.port }) };
    }
    const keeper = joinsOf ? joinsOf() : machines && machines.joins;
    const cur = keeper && keeper.map.get(h.id);
    return cur && cur.tunnel && typeof cur.tunnel.hubStream === 'function' ? cur.tunnel : null;
  };
  const upAt = new Map();
  const sshHubs = () => {
    const live = new Set(storedTokens().filter((t) => t.hub === true).map((t) => t.id));
    const all = loadSshHubs();
    let changed = false;
    for (const id of Object.keys(all)) if (!live.has(id)) { delete all[id]; changed = true; } // its token was revoked: the hub is gone
    if (changed) saveSshHubs(all);
    return Object.entries(all).map(([id, h]) => ({ id: `relay-${id}`, via: 'ssh-relay', tokenId: id, hubLabel: h.hub, relay: h.relay, list: h.list }));
  };
  const hubs = () => [...joined().filter((h) => h.via === 'link'), ...sshHubs()];

  /** One request to the hub's relay over a link: { status, json }. */
  function overLink(client, path) {
    return new Promise((resolve, reject) => {
      const sock = client.hubStream();
      if (!sock) return reject(new Error('offline'));
      const req = http.request({ method: 'GET', path, createConnection: () => sock, headers: { host: 'hub' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            resolve({ status: res.statusCode, json: null });
          }
        });
        res.on('error', reject);
      });
      req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  async function fetchList(h) {
    const c = clientOf(h);
    if (!c || c.state !== 'up') return;
    try {
      const r = await overLink(c, '/hubp/list');
      if (r.status === 200 && r.json) rows.set(h.id, { ...cleanList(r.json), at: now(), hubName: h.hubLabel || h.url });
      else rows.delete(h.id); // not shared with this computer (or not its own): nothing to show
      writeRows();
    } catch {
      /* the next link-up asks again */
    }
  }
  function look() {
    const live = new Set();
    for (const h of hubs()) {
      live.add(h.id);
      if (h.via === 'ssh-relay') {
        if (!rows.has(h.id) && h.list) rows.set(h.id, { ...cleanList(h.list), at: now(), hubName: h.hubLabel });
        tcpProbe(h.relay.port, 800).then((ok) => {
          if (relayUp.get(h.id) === ok) return;
          relayUp.set(h.id, ok);
          if (ok) {
            upAt.set(h.id, now());
            offline.delete(h.id);
          }
          writeRows();
        }).catch(() => {});
        continue;
      }
      const c = clientOf(h);
      if (c && c.state === 'up' && asked.get(h.id) !== c.upSince) {
        asked.set(h.id, c.upSince);
        fetchList(h);
      }
    }
    for (const id of [...rows.keys()]) if (!live.has(id)) rows.delete(id);
  }

  const own = () => new Set(ownProfiles().map((p) => p.name));
  const shown = () => {
    const ownNames = own();
    const out = [];
    for (const h of hubs()) {
      const entry = rows.get(h.id);
      if (!entry || entry.sharing === false) continue;
      for (const r of entry.providers) {
        const name = hubRowName(r.signin ? SUBSCRIPTION_ROW : r.name);
        if (ownNames.has(name) || out.some((o) => o.name === name) || !ROW_RE.test(name)) continue;
        out.push({ ...r, name, hubRow: r.name, hubId: h.id, hubLabel: entry.hub || entry.hubName });
      }
    }
    return out;
  };
  const port = () => {
    const a = ctx.listening();
    return a ? a.port : null;
  };
  const linkUp = (id) => {
    const h = hubs().find((x) => x.id === id);
    const c = h && clientOf(h);
    return !!c && c.state === 'up';
  };
  const isOffline = (id) => (offline.get(id) || 0) > now();
  // The rows go to a file every process reads (rows.mjs): written when what they show changes.
  let written = '';
  function writeRows() {
    const p = port();
    if (!p) return;
    const data = { port: p, rows: shown().map((r) => ({ name: r.name, hubRow: r.hubRow, label: r.label, kind: r.kind, paid: r.paid, signin: r.signin, place: r.place, ...(r.map ? { map: r.map } : {}), limited: r.limited, hubLabel: r.hubLabel, offline: isOffline(r.hubId) || !linkUp(r.hubId) })) };
    const sig = JSON.stringify(data);
    if (sig === written) return;
    written = sig;
    // A computer with no hub rows and no file of them leaves its state folder as it was.
    if (!data.rows.length && !fs.existsSync(rowsFile())) return;
    saveRows(data);
  }

  /** /hub/p/<row>/v1/...: a session's request on this computer, carried to the hub. */
  async function sessionRequest(req, res, rowName, rest, search) {
    const deny = (status, type, message) => {
      req.resume();
      apiError(res, status, type, message);
      return true;
    };
    if (!fromLoopback(req)) return deny(404, 'not_found_error', 'not found');
    const key = presentedKey(req);
    const row = keyRow(key, now());
    if (!row || row !== rowName) return deny(401, 'authentication_error', 'This key does not work here.');
    if (unsafePath(req.url.split(/[?#]/)[0])) return deny(404, 'not_found_error', 'This path is not allowed.');
    const r = shown().find((x) => x.hubRow === rowName && !x.signin);
    if (!r) return deny(404, 'not_found_error', 'The hub no longer shares this provider with this computer.');
    const h = hubs().find((x) => x.id === r.hubId);
    const c = h && clientOf(h);
    const who = r.hubLabel || 'Your hub';
    if (!c || c.state !== 'up' || isOffline(r.hubId)) return deny(502, 'api_error', `Your hub ${who} is offline: this computer has no provider of its own.`);
    await forward(req, res, {
      target: { protocol: 'http:', hostname: 'hub', port: 80, path: `/hubp/${rowName}${rest}${search}` },
      auth: h.via === 'ssh-relay' ? { authorization: `Bearer ${h.relay.secret}` } : {},
      createConnection: () => c.hubStream() || (() => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); })(),
      failed: () => {
        offline.set(r.hubId, now() + OFFLINE_MS);
        writeRows();
        return { status: 502, type: 'api_error', message: `Your hub ${who} is offline: this computer has no provider of its own.` };
      },
    });
    return true;
  }

  // ---------------- routes ----------------
  const routes = [
    ['GET', /^\/api\/hubprov\/state$/, async (req) => {
      page(req, 'The state of sharing');
      const known = new Map(loadMachines().map((m) => [m.name, m]));
      const held = [...blocked].filter(([n]) => known.has(n)).map(([n, code]) => ({ name: n, label: known.get(n).label || n, code }));
      return { sharing: sharing(), kept: keptNames(), usage: relay.usage(), blocked: held, rows: shown().map((r) => ({ name: r.name, label: r.label, hub: r.hubLabel, kind: r.kind, offline: isOffline(r.hubId) })) };
    }],
    ['POST', /^\/api\/hubprov\/switch$/, async (req) => {
      page(req, 'Sharing the providers');
      const b = await ctx.readJson(req);
      if (typeof b.on !== 'boolean') throw fail(400, 'say on: true or on: false');
      setSharing(b.on);
      pushAll(true);
      return { ok: true, sharing: b.on };
    }],
    ['POST', /^\/api\/hubprov\/([a-z0-9][a-z0-9_-]{0,31})\/keep$/, async (req, m) => {
      page(req, 'Keeping a provider to this computer');
      const b = await ctx.readJson(req);
      if (typeof b.on !== 'boolean') throw fail(400, 'say on: true or on: false');
      const known = m[1] === SUBSCRIPTION_ROW || ownProfiles().some((p) => p.name === m[1]);
      if (!known) throw fail(404, 'There is no such provider');
      setKept(m[1], b.on);
      pushAll(true);
      return { ok: true, kept: b.on };
    }],
    // The hub tells this computer its list changed. Only the token of a hub this computer joined: never a page, Tia or a session.
    ['POST', /^\/api\/hubprov\/push$/, async (req) => {
      if (ctx.caller(req) !== 'computer') throw fail(403, 'only the hub pushes its list');
      const id = tokenIdOf(req);
      const b = await ctx.readJson(req);
      const h = hubs().find((x) => x.via !== 'ssh-relay' && x.tokenId === id);
      if (!h) {
        // A hub that added this computer by SSH: its token here is one a hub holds. Without a relay it has nothing to say yet.
        const relay = cleanRelay(b.relay);
        const mine = storedTokens().some((t) => t.id === id && t.hub === true);
        if (!mine) throw Object.assign(fail(403, 'only the hub this computer joined pushes its list'), { details: { code: HUB_MARK_MISSING } });
        const all = loadSshHubs();
        const next = relay || (all[id] && all[id].relay);
        if (!next) return { ok: true, relay: false };
        all[id] = { hub: cleanList(b).hub, relay: next, list: cleanList(b), at: now() };
        saveSshHubs(all);
        rows.set(`relay-${id}`, { ...cleanList(b), at: now(), hubName: cleanList(b).hub });
        relayUp.delete(`relay-${id}`);
        offline.delete(`relay-${id}`);
        look();
        writeRows();
        return { ok: true, relay: true };
      }
      rows.set(h.id, { ...cleanList(b), at: now(), hubName: h.hubLabel || h.url });
      offline.delete(h.id);
      writeRows();
      return { ok: true };
    }],
  ];

  let timer = null;
  return {
    name: 'hubprov',
    routes,
    relay,
    streamFor,
    relayPort: () => relayPort,
    shown,
    pushAll,
    /** Ask every hub for its list now (a test, and the page's own press if one is ever needed). */
    refresh: async () => {
      await Promise.all(hubs().map(fetchList));
      writeRows();
    },
    /** The hub's relay and a session's address are answered before the server's own routes. */
    async handle(req, res) {
      const p = String(req.url || '').split(/[?#]/)[0];
      if (p.startsWith('/hubp/') || p === '/hubp') {
        // Not a public endpoint: only loopback, no proxy in front, and a relay secret the hub made for that computer.
        const secret = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
        const machine = fromLoopback(req) && secret && RELAY_SECRET_RE.test(secret[1]) ? machineOfSecret(secret[1]) : null;
        if (!machine) {
          req.resume();
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('{"error":"not found"}');
          return true;
        }
        delete req.headers.authorization;
        return relay.handle(req, res, { machine });
      }
      const s = /^\/hub\/p\/([a-z0-9][a-z0-9_-]{0,31})(\/v1\/[A-Za-z0-9_./-]*)$/.exec(p);
      if (s) return sessionRequest(req, res, s[1], s[2], (req.url.match(/\?[^#]*/) || [''])[0]);
      if (p.startsWith('/hub/p/')) {
        req.resume();
        apiError(res, 404, 'not_found_error', 'not found');
        return true;
      }
      return false;
    },
    start() {
      timer = setInterval(() => {
        try {
          look();
          writeRows();
          pushAll();
        } catch {
          /* next time */
        }
      }, pushMs);
      timer.unref?.();
      look();
      writeRows();
    },
    close() {
      clearInterval(timer);
      relayServer.close();
      if (secretServer) secretServer.close();
    },
  };
}
