// Adding a computer by SSH with a key file (Computers → Add a computer → by SSH → a key file), in two steps:
//
//   1. begin({ host, user, port, key, name?, label? })  the key is checked (keys.mjs) and held in this process's memory
//      only, the host key is read (hostkeys.mjs scanHostKey) and its print answered: { pending, name, target, print }.
//      Nothing logs in yet, nothing is written.
//   2. finish({ pending, print, confirm })  the owner saw that print and confirmed it for that computer: the key and
//      the host key are written beside each other (mode 600) and the computer is paired as by any SSH add, with
//      `-i <key> -o IdentitiesOnly=yes` and the kept host key as the only one ssh accepts. An add that fails removes
//      both files again. A pending add ends after ten minutes or when it is used.
//
// The key's text is never part of an answer, an error, a log line or machines.json (it records `key: true`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HubError } from './hub.mjs';
import { keepHostKey, keptHostKey, scanHostKey } from './hostkeys.mjs';
import { checkKey, dropKey, hasKey, keepKey, keysDir, knownHostsFile, sshExtraOf } from './keys.mjs';
import { label as cleanLabel, machineName, slug, uniqueSlug } from './names.mjs';
import { getMachine, loadMachines } from './store.mjs';

const PENDING_MS = 10 * 60_000;
const HOST_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,252}|\[?[0-9A-Fa-f:.]{2,45}\]?)$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._+-]{0,63}$/;

/** The address, user and port as typed, checked: { host, user, port } or a 400 in plain words. */
export function checkAddress({ host, user, port } = {}) {
  const h = typeof host === 'string' ? host.trim().replace(/^\[|\]$/g, '') : '';
  if (!h || !HOST_RE.test(h) || h.startsWith('-')) throw new HubError(400, 'type the computer\'s address: a name such as box2.example.com or an IP address such as 203.0.113.7');
  const u = typeof user === 'string' ? user.trim() : '';
  if (!USER_RE.test(u)) throw new HubError(400, 'type the user name you log in with there, such as alex (letters, digits, . _ + -)');
  const p = port === undefined || port === null || port === '' ? 22 : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HubError(400, 'the SSH port is a number from 1 to 65535 (usually 22)');
  return { host: h, user: u, port: p };
}

/** The user of a stored ssh target (user@host or ssh://user@[host]:port), or null. */
const userOf = (target) => /^(?:ssh:\/\/)?([^@/]+)@/.exec(String(target || ''))?.[1] || null;

/** The ssh target for that address: user@host, or ssh://user@[host]:port for another port. */
export const targetOf = ({ host, user, port }) => {
  const hh = host.includes(':') ? `[${host}]` : host;
  return port === 22 ? `${user}@${hh}` : `ssh://${user}@${hh}:${port}`;
};

/** The address in an ssh target as targetOf writes it: { host, port }, or null. */
export function addressOf(target) {
  const m = /^(?:ssh:\/\/)?[^@\s]+@(\[[^\]]+\]|[^:\s/]+)(?::(\d+))?$/.exec(String(target || ''));
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : 22 } : null;
}

/**
 * @param {object} o
 * @param {(o) => Promise<object>} o.addBySsh   the hub's SSH add, given { target, name, label, sshExtra, key: true }
 * @param {object} [o.ssh]                     { env, spawnImpl, keyscanBin } for ssh-keyscan
 */
export function keyAdder({ addBySsh, ssh = {}, now = Date.now } = {}) {
  // id -> { at, name, label, target, host, port, text, key, written }. `written`: the key and host key are on disk,
  // waiting for an install there; an entry that expires then takes its files with it.
  const pending = new Map();
  const sweep = () => {
    for (const [id, p] of pending) {
      if (now() - p.at <= PENDING_MS) continue;
      pending.delete(id);
      if (p.written && !loadMachines().some((m) => m.name === p.name)) dropKey(p.name);
    }
  };

  /**
   * The files of an add that never finished in an earlier run of this dashboard (it was restarted or updated while an
   * add waited for its install): a key or host key in ssh-keys/ with no computer in the list and no step here. They
   * would make every later add of that name refused. Run on the owner's own press only (begin, finish), never by itself.
   */
  const dropOrphans = () => {
    let files;
    try {
      files = fs.readdirSync(keysDir());
    } catch {
      return;
    }
    const kept = new Set([...loadMachines().map((m) => m.name), ...[...pending.values()].map((p) => p.name)]);
    for (const f of files) {
      const n = f.replace(/\.known_hosts$/, '');
      if (machineName(n) === n && !kept.has(n)) dropKey(n);
    }
  };

  async function begin(b = {}) {
    sweep();
    dropOrphans();
    const addr = checkAddress(b);
    let text;
    try {
      text = checkKey(b.key);
    } catch (e) {
      throw new HubError(400, e.message, { code: e.code });
    }
    if (b.label !== undefined && b.label !== '' && !cleanLabel(b.label)) throw new HubError(400, 'the label must be 1 to 40 characters on one line');
    // The same server twice would be two computers of one name on the page, each with its own key and token there.
    const same = loadMachines().find((m) => m.via === 'ssh' && m.target === targetOf(addr));
    if (same) throw new HubError(409, `${same.label || same.name} (${same.target}) is already under Computers. To give it another key, remove it there and add it again.`, { code: 'already-added' });
    const taken = loadMachines().map((m) => m.name);
    let name;
    if (b.name !== undefined && b.name !== null && b.name !== '') {
      name = machineName(b.name);
      if (!name) throw new HubError(400, 'use 1-32 lower-case letters, digits, - and _ for the name');
      if (taken.includes(name)) throw new HubError(409, `there is already a computer called ${name}`);
    } else name = uniqueSlug(slug(addr.host.includes(':') || /^[0-9.]+$/.test(addr.host) ? 'server' : addr.host), taken);
    const scan = await scanHostKey(addr.host, addr.port, { env: ssh.env, spawnImpl: ssh.spawnImpl, bin: ssh.keyscanBin });
    if (!scan.ok) throw new HubError(422, scan.message, { code: 'no-hostkey' });
    // The same server under another address (its name and its IP, another port forwarded to it): the same host key and
    // the same user as a computer added with a kept key. Another user there is another computer (a home and a dashboard
    // of its own). Only kept host keys are compared; one added by a name ssh knows keeps ssh's own.
    const twin = loadMachines().find((m) => m.key === true && userOf(m.target) === addr.user && keptHostKey(knownHostsFile(m.name))?.b64 === scan.key.b64);
    if (twin) throw new HubError(409, `${twin.label || twin.name} (${twin.target}) has the same host key (${scan.key.print}): it is this server, already under Computers. To give it another key, remove it there and add it again.`, { code: 'already-added' });
    const id = crypto.randomBytes(12).toString('hex');
    pending.set(id, { at: now(), name, label: cleanLabel(b.label) || null, target: targetOf(addr), host: addr.host, user: addr.user, port: addr.port, text, key: scan.key });
    return { pending: id, name, target: targetOf(addr), print: scan.key.print, kind: scan.key.kind };
  }

  async function finish(b = {}) {
    sweep();
    dropOrphans();
    const p = typeof b.pending === 'string' ? pending.get(b.pending) : null;
    if (!p) throw new HubError(410, 'this step expired (ten minutes) or was used: start again with Add', { code: 'expired' });
    if (b.confirm !== p.name) throw new HubError(400, `confirm the computer by its name (${p.name})`, { code: 'confirm' });
    if (b.print !== p.key.print) throw new HubError(400, 'that is not the print this step showed: start again with Add', { code: 'print' });
    // One press at a time: a second one while the first logs in would pair again, and its failure would take the
    // files of the computer the first one just added.
    if (p.busy) throw new HubError(409, `${p.name} is being added already: wait for that`, { code: 'busy' });
    if (loadMachines().some((m) => m.name === p.name) || (!p.written && hasKey(p.name))) {
      pending.delete(b.pending);
      throw new HubError(409, `there is already a computer called ${p.name}`);
    }
    if (!p.written) {
      keepKey(p.name, p.text);
      keepHostKey(knownHostsFile(p.name), p.key);
      p.written = true;
    }
    p.busy = true;
    try {
      const r = await addBySsh({ target: p.target, name: p.name, label: p.label || undefined, key: true, sshExtra: sshExtraOf({ name: p.name, key: true }) });
      pending.delete(b.pending);
      return r;
    } catch (e) {
      // Hoprig is not there yet and can be installed: the key stays (for the install) as long as this step does.
      if (e.code === 'not-installed' && e.canInstall) {
        p.at = now();
        e.pending = b.pending;
        throw e;
      }
      pending.delete(b.pending);
      // ssh's own words for a refused login send the owner to ssh-copy-id: wrong for an add that gave a key.
      if (e.code === 'ssh-auth') e.message = `${p.name} did not accept this key for the user ${p.user}. Check the user name and that this key is the one the company you rent it from gave you, then paste it again and press Next.`;
      // Its files go, unless a computer of that name stands in the list now: they are its files.
      if (!loadMachines().some((m) => m.name === p.name)) dropKey(p.name);
      throw e;
    } finally {
      p.busy = false;
    }
  }

  /** Install Hoprig there with the kept key, for an add that found none: { started, target } (the hub's install job). */
  function install(b = {}, run) {
    sweep();
    const p = typeof b.pending === 'string' ? pending.get(b.pending) : null;
    if (!p || !p.written) throw new HubError(410, 'this step expired (ten minutes) or was used: start again with Add', { code: 'expired' });
    if (b.confirm !== p.name) throw new HubError(400, `confirm the computer by its name (${p.name})`, { code: 'confirm' });
    p.at = now();
    // A root login that made the work user: the add that follows logs in as that user (its login worked already).
    const onUser = (user, target) => Object.assign(p, { user, target });
    return run(p.target, { sshExtra: sshExtraOf({ name: p.name, key: true }), onUser });
  }

  /** A computer added with a key file, and its address: { m, host, port }, or a 404/409 in plain words. */
  const keyed = (name) => {
    const m = typeof name === 'string' ? getMachine(name) : null;
    if (!m) throw new HubError(404, 'no such computer');
    const a = m.key === true ? addressOf(m.target) : null;
    if (!a) throw new HubError(409, `${m.label || m.name} was not added with a key file: its host key is the one ssh itself keeps (~/.ssh/known_hosts).`, { code: 'not-keyed' });
    return { m, ...a };
  };
  const scan = async (host, port) => {
    const r = await scanHostKey(host, port, { env: ssh.env, spawnImpl: ssh.spawnImpl, bin: ssh.keyscanBin });
    if (!r.ok) throw new HubError(422, r.message, { code: 'no-hostkey' });
    return r.key;
  };

  /** The kept host key's print and the one the computer shows now: { kept, now, same }. Changes nothing. */
  async function hostKey(name) {
    const { m, host, port } = keyed(name);
    const kept = keptHostKey(knownHostsFile(m.name));
    const now = await scan(host, port);
    return { machine: m.name, kept: kept ? kept.print : null, now: now.print, kind: now.kind, same: !!kept && kept.b64 === now.b64 };
  }

  /**
   * Keep the host key the computer shows now in place of the kept one: only for { print } equal to a fresh scan's,
   * the print his confirmation showed. Anything else changes nothing.
   */
  async function replaceHostKey(name, b = {}) {
    const { m, host, port } = keyed(name);
    const now = await scan(host, port);
    if (b.print !== now.print) throw new HubError(400, `that is not the print ${m.label || m.name} shows now: compare again`, { code: 'print' });
    keepHostKey(knownHostsFile(m.name), now);
    return { machine: m.name, kept: now.print };
  }

  return { begin, finish, install, hostKey, replaceHostKey, pendingCount: () => (sweep(), pending.size) };
}
