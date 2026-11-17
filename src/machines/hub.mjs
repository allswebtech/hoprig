// What the hub does with the machines added to it: reach them (tunnel or address), ask how they are, collect
// their sessions, add them by SSH or by code, remove them, install hoprig on one. Used by the dashboard's
// routes (index.mjs) and by the CLI (cli.mjs), so both behave the same.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { dashboardUrl, label as cleanLabel, machineName, slug, sshHost, sshTarget, tokenName, uniqueSlug } from './names.mjs';
import { API_VERSION, normalizeCode } from './pairing.mjs';
import { RelayError, callJson } from './relay.mjs';
import { installHint, installOverSsh, installSource, pairOverSsh, revokeOverSsh } from './ssh.mjs';
import { getMachine, loadMachines, publicMachine, putMachine, removeMachine, renameMachine, saveMachines } from './store.mjs';
import { Tunnels } from './tunnels.mjs';
import { legEncrypted } from './legs.mjs';
import { hostName } from '../paths.mjs';

export class HubError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** How this computer names itself to the others (the name shown in their "Who may control this computer"). */
/** How this computer is labelled next to the others: server.machineLabel, else its host name. */
export function defaultHubLabel() {
  let l = null;
  try {
    l = cleanLabel(loadConfig().server.machineLabel);
  } catch {
    /* unreadable config: the host name */
  }
  return l || hostName().split('.')[0] || 'This computer';
}

export const defaultHubName = () => tokenName(hostName().split('.')[0].replace(/[^A-Za-z0-9 ._@()-]/g, '-').slice(0, 60)) || 'dashboard';

/**
 * The installer used by "install it there for me": config server.installScript (an https URL or a file on this
 * computer), else the install.sh shipped next to this hoprig when there is one. Null: the step is skipped.
 */
/** install.sh next to this hoprig (a git checkout has it). */
export const BUNDLED_INSTALLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'install.sh');

export function configuredInstaller(bundled = BUNDLED_INSTALLER) {
  let v = null;
  try {
    v = loadConfig().server.installScript || null;
  } catch {
    /* unreadable config: no installer */
  }
  return installSource(v) || installSource(bundled);
}

const settle = (p, ms, onTimeout) =>
  Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(onTimeout()), ms).unref?.())]);

/**
 * @param {object} o
 * @param {Tunnels} [o.tunnels]     the tunnels (one set per running dashboard)
 * @param {object}  [o.ssh]         passed to every ssh run: { sshBin, spawnImpl, env }
 * @param {string}  [o.hubName]     this computer's name as the others see it
 * @param {() => object|null} [o.installer]   the installer source (configuredInstaller)
 * @param {number}  [o.probeTimeoutMs]  per machine, for the list and the sessions of all machines
 * @param {number}  [o.tunnelWaitMs]    how long a request waits for a tunnel to come up
 */
export function createHub({ ssh = {}, tunnels = new Tunnels(Object.fromEntries(Object.entries({ sshBin: ssh.sshBin, spawnImpl: ssh.spawnImpl, env: ssh.env }).filter(([, v]) => v !== undefined))), hubName = defaultHubName(), hubLabel = defaultHubLabel, onRemove = () => {}, linkEncrypted = () => false, installer = () => configuredInstaller(), probeTimeoutMs = 4000, tunnelWaitMs = 15_000, now = Date.now } = {}) {
  const probeCache = new Map(); // name -> { at, result }

  /** Where machine `m`'s dashboard answers. Starts its tunnel when needed. */
  async function endpoint(m, waitMs = tunnelWaitMs) {
    // A computer that joined keeps its own reverse tunnel open to this one's 127.0.0.1:<port>.
    // So does one linked directly (link.mjs): the hub listens on that port while the link is up.
    if (m.via === 'join' || m.via === 'link') return { protocol: 'http:', hostname: '127.0.0.1', port: m.port, basePath: '' };
    if (m.via === 'url') {
      const u = new URL(m.url);
      return { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), basePath: u.pathname === '/' ? '' : u.pathname };
    }
    try {
      const port = await tunnels.get(m).ensure(waitMs);
      return { protocol: 'http:', hostname: '127.0.0.1', port, basePath: '' };
    } catch (e) {
      throw new RelayError(e.code === 'timeout' ? 'timeout' : 'offline', `${m.label || m.name} cannot be reached by SSH: ${e.message}`);
    }
  }

  const stateOf = (e) => (e.code === 'not-authorised' ? 'unauthorised' : e.code === 'too-old' ? 'too-old' : 'offline');
  // A computer that joined is offline when its own connection is down; say that, not "its dashboard is not running".
  const why = (m, e) => ((m.via === 'join' || m.via === 'link') && stateOf(e) === 'offline' ? `${m.label || m.name} is not connected right now. It connects again by itself once it is on and online.` : e.message);

  /** How machine `m` is: online (with its host name, OS and versions), offline, unauthorised or too-old. */
  async function probe(m, { fresh = false, timeoutMs = probeTimeoutMs } = {}) {
    const hit = probeCache.get(m.name);
    if (!fresh && hit && now() - hit.at < 5000) return hit.result;
    // encrypted: whether a Setup job's password may be typed for it on this page (legs.mjs).
    const out = { ...publicMachine(m), encrypted: legEncrypted(m, linkEncrypted), state: 'offline', error: null, hostname: null, platform: null, version: null, claude: null };
    try {
      const ep = await endpoint(m, timeoutMs);
      const r = await callJson(ep, { machine: m.label || m.name, path: '/api/machine', token: m.token, timeoutMs });
      if (r.status === 404) throw new RelayError('too-old', `${m.label || m.name} runs a Hoprig too old for this dashboard. Update it there: hoprig update`);
      if (r.status !== 200 || !r.json || !(r.json.api >= API_VERSION)) throw new RelayError('bad-answer', `${m.label || m.name} gave an answer this dashboard does not understand (HTTP ${r.status}).`);
      const j = r.json;
      Object.assign(out, { state: 'online', hostname: j.hostname || null, platform: j.platform || null, version: j.version || null, claude: j.claude || null });
      // Keep what it told us, so the list shows it while the machine is offline later.
      const info = { hostname: out.hostname, platform: out.platform, version: out.version };
      if (JSON.stringify(info) !== JSON.stringify(m.info || null)) {
        const list = loadMachines();
        const cur = list.find((x) => x.name === m.name && x.token === m.token);
        if (cur) {
          cur.info = info;
          saveMachines(list);
        }
      }
    } catch (e) {
      Object.assign(out, { state: stateOf(e), error: why(m, e) });
      if (m.info) Object.assign(out, { hostname: m.info.hostname || null, platform: m.info.platform || null, version: m.info.version || null });
    }
    if (m.via === 'ssh') out.tunnel = tunnels.peek(m.name)?.status() || null;
    probeCache.set(m.name, { at: now(), result: out });
    return out;
  }

  /** Every machine with its state, probed in parallel; a dead one costs at most the probe timeout. */
  const list = async ({ fresh = false } = {}) => Promise.all(loadMachines().map((m) => probe(m, { fresh })));

  /** One machine's /api/state, or why it is not there. Never rejects and never takes longer than `timeoutMs`. */
  async function stateOfMachine(m, timeoutMs = probeTimeoutMs) {
    const base = { machine: m.name, label: m.label || m.name };
    const work = (async () => {
      try {
        const ep = await endpoint(m, timeoutMs);
        const r = await callJson(ep, { machine: m.label || m.name, path: '/api/state', token: m.token, timeoutMs });
        if (r.status !== 200 || !r.json) throw new RelayError('bad-answer', r.json && r.json.error ? r.json.error : `HTTP ${r.status}`);
        return { ...base, status: 'online', error: null, ...r.json };
      } catch (e) {
        return { ...base, status: stateOf(e), error: why(m, e), sessions: [] };
      }
    })();
    return settle(work, timeoutMs + 500, () => ({ ...base, status: 'offline', error: `${m.label || m.name} did not answer in time.`, sessions: [] }));
  }

  /** The sessions of every machine, in parallel. `local` gives this computer's own state (first in the list). */
  async function sessions(local) {
    const ms = loadMachines();
    const [mine, ...others] = await Promise.all([
      local ? local().then((s) => ({ machine: null, label: hubLabel(), status: 'online', error: null, ...s }), (e) => ({ machine: null, status: 'offline', error: e.message, sessions: [] })) : null,
      ...ms.map((m) => stateOfMachine(m)),
    ]);
    return { machines: [mine, ...others].filter(Boolean) };
  }

  /** The name a new machine gets: the one asked for (must be free), or one made from its host name. */
  function chooseName(asked, fromHost, keep) {
    const taken = loadMachines().filter((m) => !keep || m.name !== keep.name).map((m) => m.name);
    if (asked !== undefined && asked !== null && asked !== '') {
      const n = machineName(asked);
      if (!n) throw new HubError(400, 'use 1-32 lower-case letters, digits, - and _ for the name');
      if (taken.includes(n)) throw new HubError(409, `there is already a computer called ${n}`);
      return n;
    }
    if (keep) return keep.name;
    return uniqueSlug(slug(fromHost), taken);
  }

  /**
   * Add (or pair again) a machine by SSH: one step for the user. Runs `hoprig pair --json` there, stores the
   * token, starts the tunnel and returns how the machine is. Failures carry `code` (ssh-auth, ssh-hostkey,
   * not-installed, too-old, ...) and, when hoprig is missing, the install command.
   */
  async function addBySsh({ target: rawTarget, name, label } = {}) {
    const target = sshTarget(rawTarget);
    if (!target) throw new HubError(400, 'type the SSH target as user@host, a host name, or a name from ~/.ssh/config');
    if (label !== undefined && label !== '' && !cleanLabel(label)) throw new HubError(400, 'the label must be 1 to 40 characters on one line');
    const existing = loadMachines().find((m) => m.via === 'ssh' && m.target === target) || null;
    const r = await pairOverSsh(target, hubName, ssh);
    if (!r.ok) {
      const extra = { code: r.code };
      if (r.code === 'not-installed') {
        const src = installer();
        Object.assign(extra, { installCommand: installHint(src), canInstall: !!src });
      }
      throw new HubError(r.code === 'timeout' ? 504 : 422, r.message, extra);
    }
    const info = r.info;
    const m = {
      name: chooseName(name, info.hostname || sshHost(target), existing),
      label: cleanLabel(label) || (existing && existing.label) || cleanLabel(String(info.hostname || '').split('.')[0]) || sshHost(target),
      via: 'ssh',
      target,
      remoteHost: String(info.host || '127.0.0.1'),
      remotePort: info.port,
      token: info.token,
      tokenId: info.tokenId || null,
      added: now(),
      info: { hostname: info.hostname || null, platform: info.platform || null, version: info.version || null },
    };
    putMachine(m);
    // Paired again: the old token there is no longer used. Revoked (best effort) before the answer: left running in
    // the background, it went on changing that computer's settings after the dashboard had answered, or had stopped.
    if (existing && existing.tokenId && existing.tokenId !== m.tokenId) await revokeOverSsh(target, existing.tokenId, ssh).catch(() => {});
    if (existing && existing.name !== m.name) tunnels.close(existing.name);
    probeCache.delete(m.name);
    const state = await probe(m, { fresh: true, timeoutMs: tunnelWaitMs });
    return {
      machine: state,
      hint: info.running ? null : `Hoprig is installed on ${target}, but its dashboard is not running. Start it there: hoprig service install`,
    };
  }

  /** Add a machine by its address and the code `hoprig pair` shows there. */
  async function addByUrl({ url: rawUrl, code: rawCode, name, label } = {}) {
    const url = dashboardUrl(rawUrl);
    if (!url) throw new HubError(400, 'type the address as http://host:port or https://host');
    const code = normalizeCode(rawCode);
    if (!code) throw new HubError(400, 'the code has 8 letters and digits, like K7QM-4XP2');
    if (label !== undefined && label !== '' && !cleanLabel(label)) throw new HubError(400, 'the label must be 1 to 40 characters on one line');
    const host = new URL(url).hostname;
    const existing = loadMachines().find((m) => m.via === 'url' && m.url === url) || null;
    const ep = await endpoint({ via: 'url', url });
    let r;
    try {
      r = await callJson(ep, { machine: host, method: 'POST', path: '/api/pair/claim', body: { code, name: hubName }, timeoutMs: 10_000, raw: true });
    } catch (e) {
      throw new HubError(e.code === 'timeout' ? 504 : 502, e.message, { code: e.code });
    }
    if (r.status === 429) throw new HubError(429, (r.json && r.json.error) || 'too many tries; wait a few minutes', { code: 'rate-limited' });
    if (r.status === 403 && r.json && r.json.code === 'bad-code') throw new HubError(400, 'that code is wrong or has expired. Make a new one there: hoprig pair', { code: 'bad-code' });
    if (r.status !== 200 || !r.json || typeof r.json.token !== 'string') {
      throw new HubError(502, `${host} does not answer like a Hoprig dashboard that can pair (HTTP ${r.status}). Update Hoprig there, and check the address.`, { code: 'too-old' });
    }
    const info = r.json;
    const m = {
      name: chooseName(name, info.hostname || host, existing),
      label: cleanLabel(label) || (existing && existing.label) || cleanLabel(String(info.hostname || '').split('.')[0]) || host,
      via: 'url',
      url,
      token: info.token,
      tokenId: info.tokenId || null,
      added: now(),
      info: { hostname: info.hostname || null, platform: info.platform || null, version: info.version || null },
    };
    putMachine(m);
    probeCache.delete(m.name);
    return { machine: await probe(m, { fresh: true }), hint: url.startsWith('http://') && !/^http:\/\/(127\.|localhost|\[::1\])/.test(url) ? 'This address is not encrypted: the token travels in the clear. Prefer SSH, or an https:// address such as the other computer\'s public link.' : null };
  }

  /** Remove a machine. By SSH its token there is revoked as well; by address that has to be done there. */
  async function remove(name) {
    const m = getMachine(name);
    if (!m) throw new HubError(404, 'no such computer');
    let revoked = false;
    // The token gives itself up over the API; by SSH the command there is the fallback (an older dashboard, or
    // one that is not running).
    try {
      const r = await callJson(await endpoint(m, probeTimeoutMs), { machine: m.label || m.name, method: 'POST', path: '/api/tokens/self/revoke', body: {}, token: m.token, timeoutMs: probeTimeoutMs });
      revoked = r.status === 200;
    } catch {
      /* offline, or already revoked */
    }
    if (!revoked && m.via === 'ssh' && m.tokenId) revoked = !!(await revokeOverSsh(m.target, m.tokenId, ssh)).ok;
    removeMachine(name);
    onRemove(m);
    tunnels.close(name);
    probeCache.delete(name);
    return {
      removed: true,
      revoked,
      note: revoked
        ? m.via === 'join' || m.via === 'link' ? `${m.label || m.name} stops connecting by itself.` : null
        : `To be sure, also remove "${hubName}" under "Who may control this computer" on ${m.label || m.name} (hoprig tokens there).`,
    };
  }

  function rename(name, patch) {
    try {
      const m = renameMachine(name, patch);
      if (m.name !== name) {
        tunnels.close(name);
        probeCache.delete(name);
      }
      return publicMachine(m);
    } catch (e) {
      throw new HubError(e.status || 400, e.message);
    }
  }

  // ---- "install it there for me": one at a time, the page polls the output ----
  const job = { running: false, target: null, lines: [], result: null };
  function install(rawTarget) {
    const target = sshTarget(rawTarget);
    if (!target) throw new HubError(400, 'type the SSH target as user@host or a host name');
    const src = installer();
    if (!src) throw new HubError(409, 'no installer is set up on this dashboard (server.installScript)', { code: 'no-installer' });
    if (job.running) throw new HubError(409, `an install on ${job.target} is still running`);
    Object.assign(job, { running: true, target, lines: [], result: null });
    installOverSsh(target, src, { ...ssh, onLine: (l) => job.lines.length < 5000 && job.lines.push(String(l).slice(0, 500)) })
      .then((r) => (job.result = { ok: r.code === 0, code: r.code, timedOut: r.timedOut }))
      .catch((e) => (job.result = { ok: false, error: e.message }))
      .finally(() => (job.running = false));
    return { started: true, target };
  }
  const installStatus = (from = 0) => ({ running: job.running, target: job.target, lines: job.lines.slice(from), next: job.lines.length, result: job.result });

  return { tunnels, hubName, hubLabel, endpoint, probe, list, sessions, stateOfMachine, addBySsh, addByUrl, remove, rename, install, installStatus, close: () => tunnels.closeAll() };
}
