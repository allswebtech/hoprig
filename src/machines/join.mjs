// `hoprig join`: the other direction, for a computer the hub cannot reach (a home PC behind a router). That
// computer dials OUT over SSH to the hub's machine and keeps a reverse tunnel open:
//
//     ssh -N -R 127.0.0.1:<port on the hub>:127.0.0.1:<this dashboard's port> <hub>
//
// so the hub reaches it on its own 127.0.0.1:<port>, like a machine it added by SSH. Joining is three steps over
// that same SSH login, each one `hoprig machines accept --json` on the hub with a JSON request on stdin (never on
// the command line, where `ps` would show the token):
//   1. reserve   the hub picks a free port and a registration id (kept 10 minutes)
//   2. the joining computer opens the reverse tunnel to that port
//   3. confirm   it hands over a fresh token for itself; the hub checks the tunnel answers with that token, checks
//                that the port is NOT reachable from the network, and stores the machine (via "join")
// Leaving (`join --leave`, or Remove on either side) revokes the token and forgets the port on both sides.
//
// Control goes one way: the hub gets a token for the joined computer, never the other way round. The reverse port
// is bound to the hub's loopback because sshd's GatewayPorts is "no" by default; with "yes" sshd opens it on every
// address, which confirm detects (exposedOnNetwork) and refuses.
//
// The joining side keeps its hubs in <configDir>/joined.json (mode 600). Its dashboard service keeps the tunnels
// (JoinKeeper, started with the service), so the connection survives reboots; the command only sets it up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { configDir, stateDir, hostName } from '../paths.mjs';
import { defaultHubLabel, workspaceOf } from './hub.mjs';
import { label as cleanLabel, dashboardUrl, slug, sshTarget, tokenName, uniqueSlug } from './names.mjs';
import { dashboardAddress, answers, machineInfo, API_VERSION } from './pairing.mjs';
import { callJson } from './relay.mjs';
import { findJson, reverseArgs, runHoprig } from './ssh.mjs';
import { loadMachines, putMachine, removeMachine } from './store.mjs';
import { createToken, revokeToken, storedTokens } from './tokens.mjs';
import { Tunnel } from './tunnels.mjs';
import { LinkClient, claimLink, leaveLink } from './link.mjs';
import { parsePin, pinMatches } from './hubcert.mjs';

const ID_RE = /^[0-9a-f]{12}$/;
const TOKEN_RE = /^hop_[A-Za-z0-9_-]{43}$/;
const RESERVE_MS = 10 * 60_000;

const writeJson = (file, data, mode = 0o600) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
};
const readJson = (file, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
};

// ======================= the hub's side: `hoprig machines accept --json` =======================

const reservationsFile = () => path.join(stateDir(), 'join-reservations.json');
const loadReservations = (now) => (readJson(reservationsFile(), { list: [] }).list || []).filter((r) => r && ID_RE.test(r.id) && r.expires > now);
const saveReservations = (list) => writeJson(reservationsFile(), { list });

/** A port on 127.0.0.1 that is free now and not promised to another joined computer. */
async function pickPort(used) {
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

/** This computer's addresses other than loopback (link-local IPv6 needs a scope and is skipped). */
export function networkAddresses(ifaces = os.networkInterfaces()) {
  return Object.values(ifaces).flat().filter((a) => a && !a.internal && !(a.family === 'IPv6' && /^fe80:/i.test(a.address))).map((a) => a.address);
}

/**
 * The first network address on which `port` accepts connections, or null. A reverse tunnel bound as asked
 * (127.0.0.1) answers only on loopback; with sshd's GatewayPorts=yes it also answers here.
 */
export async function exposedOnNetwork(port, addrs = networkAddresses(), timeoutMs = 400) {
  const tries = await Promise.all(addrs.map((host) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v ? host : null);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  })));
  return tries.find(Boolean) || null;
}

const fail = (code, message) => ({ hoprig: 'accept', ok: false, code, message });

/** Step 1: a port and a registration id. A computer that joined before (joinId) keeps its port. */
export async function acceptReserve(b, { now = Date.now() } = {}) {
  const name = tokenName(b.name) || 'computer';
  const lbl = cleanLabel(b.label) || name;
  const machines = loadMachines();
  const list = loadReservations(now);
  const before = ID_RE.test(String(b.joinId)) ? machines.find((m) => m.via === 'join' && m.joinId === b.joinId) : null;
  const used = new Set([...machines.filter((m) => m.via === 'join').map((m) => m.port), ...list.map((r) => r.port)]);
  const id = before ? before.joinId : crypto.randomBytes(6).toString('hex');
  const port = before ? before.port : await pickPort(used);
  saveReservations([...list.filter((r) => r.id !== id), { id, port, name, label: lbl, expires: now + RESERVE_MS }]);
  return { hoprig: 'accept', ok: true, step: 'reserve', id, port, hub: { label: defaultHubLabel(), hostname: hostName(), version: machineInfo().version } };
}

/**
 * Step 3: the tunnel must answer on 127.0.0.1:<port> with the token, and only there. Then the machine is stored.
 * `exposed` and `waitMs` are test seams.
 */
export async function acceptConfirm(b, { now = Date.now, waitMs = 15_000, exposed = exposedOnNetwork } = {}) {
  if (!ID_RE.test(String(b.id))) return fail('bad-request', 'no registration id');
  if (!TOKEN_RE.test(String(b.token))) return fail('bad-request', 'no token');
  const list = loadReservations(now());
  const r = list.find((x) => x.id === b.id);
  const before = loadMachines().find((m) => m.via === 'join' && m.joinId === b.id) || null;
  if (!r && !before) return fail('expired', 'The registration expired. Join again.');
  const port = r ? r.port : before.port;
  const ep = { protocol: 'http:', hostname: '127.0.0.1', port, basePath: '' };
  // The tunnel was just opened: give it a moment to arrive.
  let info = null;
  let last = '';
  const end = now() + waitMs;
  while (!info && now() < end) {
    try {
      const res = await callJson(ep, { machine: 'that computer', path: '/api/machine', token: b.token, timeoutMs: 2000 });
      if (res.status === 200 && res.json && res.json.api >= API_VERSION) info = res.json;
      else last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
      if (e.code === 'computer-not-allowed' || e.code === 'too-old') break;
    }
    if (!info) await new Promise((res) => setTimeout(res, 300));
  }
  if (!info) return fail('not-reachable', `The connection did not arrive on port ${port} of this computer (${last || 'no answer'}).`);
  const open = await exposed(port);
  if (open) {
    saveReservations(list.filter((x) => x.id !== b.id));
    return fail('exposed', `sshd here opens forwarded ports to the network (port ${port} answers on ${open}). Set "GatewayPorts no" (the default) or "clientspecified" in sshd_config, restart sshd, then join again.`);
  }
  const taken = loadMachines().filter((m) => !before || m.name !== before.name).map((m) => m.name);
  const m = {
    name: before ? before.name : uniqueSlug(slug(info.hostname || (r && r.name)), taken),
    label: (before && before.label) || (r && r.label) || cleanLabel(String(info.hostname || '').split('.')[0]) || 'computer',
    via: 'join',
    port,
    joinId: b.id,
    token: b.token,
    tokenId: ID_RE.test(String(b.tokenId)) ? b.tokenId : null,
    added: before ? before.added : now(),
    info: { hostname: info.hostname || null, platform: info.platform || null, version: info.version || null, ...workspaceOf(info) },
  };
  putMachine(m);
  saveReservations(list.filter((x) => x.id !== b.id));
  return { hoprig: 'accept', ok: true, step: 'confirm', name: m.name, label: m.label };
}

/** Leaving: forget the machine and its port. */
export function acceptLeave(b, { now = Date.now() } = {}) {
  if (!ID_RE.test(String(b.id))) return fail('bad-request', 'no registration id');
  const m = loadMachines().find((x) => x.via === 'join' && x.joinId === b.id);
  if (m) removeMachine(m.name);
  saveReservations(loadReservations(now).filter((x) => x.id !== b.id));
  return { hoprig: 'accept', ok: true, step: 'leave', removed: !!m };
}

/** `hoprig machines accept --json`: one request (JSON on stdin), one answer (one JSON line). */
export async function accept(text, opts = {}) {
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    return fail('bad-request', 'send one JSON object on stdin');
  }
  if (!b || typeof b !== 'object') return fail('bad-request', 'send one JSON object on stdin');
  if (b.step === 'reserve') return acceptReserve(b, opts);
  if (b.step === 'confirm') return acceptConfirm(b, opts);
  if (b.step === 'leave') return acceptLeave(b, opts);
  return fail('bad-request', 'step must be reserve, confirm or leave');
}

// ======================= the joining computer's side =======================

export const joinedFile = () => path.join(configDir(), 'joined.json');
// An entry is either an SSH join (target, port on the hub) or a direct link (url, secret: link.mjs). A link to a hub
// joined with a fingerprint also keeps it (pin) and, for a hub with its own authority, that authority's certificate
// (ca, public material); both must agree, or the entry is dropped rather than used without its check.
const validTrust = (h) => (h.pin === undefined && h.ca === undefined) || (!!parsePin(h.pin) && /^https:\/\//.test(h.url) && (h.ca === undefined || pinMatches(h.pin, h.ca)));
const validJoined = (h) =>
  h && ID_RE.test(h.id) && ID_RE.test(String(h.tokenId)) &&
  (h.via === 'link' ? /^https?:\/\//.test(String(h.url)) && /^ccl_[A-Za-z0-9_-]{43}$/.test(String(h.secret)) && validTrust(h) : !!sshTarget(h.target) && Number.isInteger(h.port));
export const loadJoined = () => (readJson(joinedFile(), { hubs: [] }).hubs || []).filter(validJoined);
export const saveJoined = (hubs) => writeJson(joinedFile(), { hubs });

/** What the page and the CLI show: never the link secret (the token itself lives only on the hub). */
export const publicJoined = (h, status = null) => ({
  id: h.id, via: h.via === 'link' ? 'link' : 'ssh', target: h.target || null, url: h.url || null, hub: h.hubLabel || h.target || h.url,
  name: h.name || null, port: h.port || null, joined: h.joined || null, fingerprint: h.pin || null,
  state: status ? status.state : 'idle', upSince: status ? status.upSince : null, error: status ? status.error : null,
});

/**
 * Keeps one reverse tunnel per joined hub, with the tunnels module's backoff. The dashboard service runs one
 * (start() with the service); `hoprig join` uses a short-lived one to set things up. Every few seconds it reads
 * joined.json again, and forgets a hub whose token is gone (removed on the hub, or revoked here).
 */
export class JoinKeeper {
  constructor({ ssh = {}, settleMs = 2500, syncMs = 5000, tunnel = {}, link = {}, local = () => dashboardAddress(), now = Date.now } = {}) {
    Object.assign(this, { ssh, settleMs, syncMs, tunnelOpts: tunnel, linkOpts: link, local, now });
    this.map = new Map(); // id -> { key, tunnel }
    this.busy = new Set(); // ids being joined right now: not saved yet, not to be closed by sync()
    this.timer = null;
  }

  /** The direct link to a hub (link.mjs), kept like a tunnel. */
  linkFor(h) {
    const key = `link|${h.url}|${h.secret}|${h.pin || ''}|${h.ca || ''}`;
    const cur = this.map.get(h.id);
    if (cur && cur.key === key) return cur.tunnel;
    if (cur) cur.tunnel.close();
    const c = new LinkClient({ entry: h, local: this.local, ...this.linkOpts });
    this.map.set(h.id, { key, tunnel: c });
    return c;
  }

  tunnelFor(h) {
    if (h.via === 'link') return this.linkFor(h);
    const key = `${h.target}|${h.port}`;
    const cur = this.map.get(h.id);
    if (cur && cur.key === key) return cur.tunnel;
    if (cur) cur.tunnel.close();
    const t = new Tunnel({
      machine: { target: h.target },
      ...Object.fromEntries(Object.entries({ sshBin: this.ssh.sshBin, spawnImpl: this.ssh.spawnImpl, env: this.ssh.env }).filter(([, v]) => v !== undefined)),
      // Read the dashboard's address on every try: it may have been restarted on another port.
      buildArgs: () => {
        const a = this.local();
        return reverseArgs({ target: h.target, hubPort: h.port, localHost: a.host, localPort: a.port });
      },
      freePort: async () => h.port,
      // Nothing to probe from this side: with ExitOnForwardFailure, ssh still running after a moment means the hub
      // gave the port. (The hub checks the tunnel for real when the computer joins.)
      probe: async (port, { startedAt }) => this.now() - startedAt >= this.settleMs,
      ...this.tunnelOpts,
    });
    this.map.set(h.id, { key, tunnel: t });
    return t;
  }

  /** Bring the tunnels in line with joined.json; forget hubs whose token no longer exists. */
  sync() {
    const hubs = loadJoined();
    const live = new Set(storedTokens().map((t) => t.id));
    const kept = hubs.filter((h) => live.has(h.tokenId));
    if (kept.length !== hubs.length) saveJoined(kept);
    for (const h of kept) {
      const t = this.tunnelFor(h);
      if (t.state === 'idle') (h.via === 'link' ? Promise.resolve(t.start()) : t.ensure(60_000)).catch(() => {});
    }
    for (const [id, { tunnel }] of this.map) {
      if (!kept.some((h) => h.id === id) && !this.busy.has(id)) {
        // A direct link is retired, not cut: the token may have been revoked by the hub's own request (Remove there),
        // whose answer is still on its way over this link; cut, the hub would say it could not revoke it.
        if (tunnel.retire) tunnel.retire();
        else tunnel.close();
        this.map.delete(id);
      }
    }
    return kept;
  }

  start() {
    try {
      this.sync();
    } catch {
      /* a bad file must not stop the dashboard */
    }
    this.timer = setInterval(() => {
      try {
        this.sync();
      } catch {
        /* next time */
      }
    }, this.syncMs);
    this.timer.unref?.();
  }

  status(id) {
    const cur = this.map.get(id);
    return cur ? cur.tunnel.status() : null;
  }

  closeId(id) {
    const cur = this.map.get(id);
    if (cur) cur.tunnel.close();
    this.map.delete(id);
  }

  close() {
    clearInterval(this.timer);
    for (const { tunnel } of this.map.values()) tunnel.close();
    this.map.clear();
  }
}

export class JoinError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Run one accept step on the hub over SSH (plain, then the login shell), the request on stdin. */
async function onHub(target, body, ssh) {
  const r = await runHoprig(target, ['machines', 'accept', '--json'], { ...ssh, stdin: JSON.stringify(body) });
  if (!r.ok) {
    if (r.code === 'not-installed') throw new JoinError('not-installed', `${target} has no Hoprig. Install it there first: it is the computer that shows the others.`);
    if (r.code === 'too-old' || /unknown machines command/.test(r.message)) throw new JoinError('too-old', `The Hoprig on ${target} is too old to accept computers. Update it there: hoprig update`);
    throw new JoinError(r.code, r.message, r.code === 'timeout' ? 504 : 422);
  }
  const a = findJson(r.result.stdout, 'accept');
  if (!a) throw new JoinError('too-old', `The Hoprig on ${target} does not understand joining. Update it there: hoprig update`);
  if (!a.ok) throw new JoinError(a.code, a.message);
  return a;
}

/**
 * Join the hub reachable as `rawTarget`. `keeper` keeps the tunnel (the service's own, or a short-lived one).
 * Joining the same hub again reuses the registration and the port, with a new token. Resolves the joined entry.
 */
export async function joinHub(rawTarget, { keeper, ssh = {}, now = Date.now } = {}) {
  const target = sshTarget(rawTarget);
  if (!target) throw new JoinError('bad-target', 'type the main computer\'s SSH address as user@host, a host name, or a name from ~/.ssh/config', 400);
  const addr = dashboardAddress();
  const said = await answers(addr);
  if (said === 'closed') throw new JoinError('not-running', `This computer's dashboard is not running (nothing on ${addr.host}:${addr.port}). Start it first: hoprig service install`);
  if (said === 'silent') throw new JoinError('no-answer', `This computer's dashboard did not answer on ${addr.host}:${addr.port} in time. Try again in a moment.`);
  const before = loadJoined().find((h) => h.target === target) || null;
  const me = machineInfo();
  const reserve = await onHub(target, { step: 'reserve', name: hostName().split('.')[0], label: defaultHubLabel(), joinId: before ? before.id : undefined }, ssh);
  const id = reserve.id;
  const tname = tokenName(String(reserve.hub && reserve.hub.label || target).replace(/[^A-Za-z0-9 ._@()-]/g, '-').slice(0, 60)) || 'hub';
  const { id: tokenId, token } = createToken(tname);
  const entry = { id, target, port: reserve.port, hubLabel: (reserve.hub && reserve.hub.label) || target, hubHostname: (reserve.hub && reserve.hub.hostname) || null, tokenId, joined: now() };
  keeper.busy.add(id);
  try {
    const t = keeper.tunnelFor(entry);
    try {
      await t.ensure(30_000);
    } catch (e) {
      throw new JoinError(e.code === 'timeout' ? 'timeout' : 'tunnel', `The connection to ${target} did not stay up: ${e.message}`);
    }
    const ok = await onHub(target, { step: 'confirm', id, token, tokenId, info: { hostname: me.hostname, platform: me.platform, version: me.version } }, ssh);
    entry.name = ok.name;
    saveJoined([...loadJoined().filter((h) => h.id !== id && h.target !== target), entry]);
    // Joined again: the token handed over before is not used any more.
    if (before && before.tokenId !== tokenId) revokeToken(before.tokenId);
    return entry;
  } catch (e) {
    revokeToken(tokenId, { log: false }); // never in use
    if (!before) keeper.closeId(id);
    throw e;
  } finally {
    keeper.busy.delete(id);
  }
}

/**
 * Join a hub by its address and the one-time code it shows (the direct link, link.mjs): no SSH needed. Joining the
 * same address again replaces the old link. Resolves the joined entry once the link is up.
 */
export async function joinByAddress(url, code, { keeper, insecure = false, fingerprint = null, waitMs = 20_000 } = {}) {
  // Joined this address before: its secret proves to the hub that this is the same computer, so the hub replaces that
  // entry instead of listing a second one. Sent only to the same address it came from.
  const norm = dashboardUrl(String(url || ''));
  const prior = loadJoined().filter((h) => h.via === 'link' && h.url === norm);
  const entry = await claimLink(url, code, { insecure, fingerprint, replaces: prior.length ? prior[prior.length - 1].secret : null });
  const replaced = entry.replaced === true;
  delete entry.replaced; // said once, not kept
  const before = loadJoined().filter((h) => h.via === 'link' && h.url === entry.url);
  saveJoined([...loadJoined().filter((h) => !before.includes(h)), entry]);
  for (const b of before) {
    revokeToken(b.tokenId);
    keeper.closeId(b.id);
  }
  keeper.sync();
  try {
    await keeper.linkFor(entry).waitUp(waitMs);
  } catch (e) {
    throw new JoinError('link', `Joined, but the link to ${entry.hubLabel} is not up yet: ${e.message}. It keeps trying by itself.`, 502);
  }
  return replaced ? { ...entry, replaced } : entry;
}

/**
 * Leave a hub (by its SSH target, its address or the registration id): the hub forgets this computer, the token is
 * revoked here.
 */
export async function leaveHub(idOrTarget, { keeper, ssh = {} } = {}) {
  const hubs = loadJoined();
  const norm = String(idOrTarget).replace(/\/+$/, '');
  const h = hubs.find((x) => x.id === idOrTarget || x.target === idOrTarget || x.url === norm);
  if (!h) throw new JoinError('unknown', `This computer has not joined "${idOrTarget}".`, 404);
  let hubForgot = false;
  try {
    if (h.via === 'link') hubForgot = await leaveLink(h);
    else hubForgot = (await onHub(h.target, { step: 'leave', id: h.id }, { ...ssh, timeoutMs: 20_000 })).removed === true;
  } catch {
    /* the hub is unreachable: the revoked token below locks it out anyway */
  }
  revokeToken(h.tokenId);
  saveJoined(hubs.filter((x) => x !== h));
  keeper?.closeId(h.id);
  return { left: true, hub: h.hubLabel || h.target, hubForgot };
}
