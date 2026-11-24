// Is this computer "a server" for the question who may open the dashboard? On a server "devices on my network" is the
// internet over plain http, so set-up never offers it there, `--access network` is refused, and doctor fails a
// dashboard that is open to the network. A computer counts as a server when one of these holds (no network call):
//   public   it has a public address on its network card
//   ssh      set-up runs in an ssh session on Linux and the computer has no display of its own (no X or Wayland
//            socket: an ssh session never carries the desktop's DISPLAY, so the environment alone cannot tell); macOS
//            and Windows are taken to have a desktop
//   cloud    its hardware names a cloud: the DMI files and Xen's /sys/hypervisor/uuid (a cloud server's network card
//            has a private address behind the provider's NAT, so the first rule does not see it)
// The dashboard service and its terminals have no ssh session, so set-up saves the reason it found when it does not change
// with the network (ssh, cloud: stateDir/server.json), and every later caller (the page, doctor, set-up run again) uses
// it while the computer still shows no display of this user. A public address is always the live one.
// Everything is read through `sys` (env, platform, publicIps, dmi, localDisplay, savedServer), so tests decide each fact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { isPublicIp, publicAddresses } from './https.mjs';

// What the hardware files say on each cloud, as data (the providers' own documentation of their DMI values, and what
// cloud-init's ds-identify matches on: https://github.com/canonical/cloud-init/blob/main/tools/ds-identify).
export const CLOUDS = [
  { name: 'Google Compute Engine', match: /^google/i },
  { name: 'Amazon EC2', match: /^amazon ec2|^amazon\b/i },
  { name: 'DigitalOcean', match: /^digitalocean/i },
  { name: 'Hetzner', match: /^hetzner/i },
  { name: 'OpenStack', match: /openstack/i },
  { name: 'Linode (Akamai)', match: /^linode|^akamai/i },
  { name: 'Vultr', match: /^vultr/i },
  { name: 'Oracle Cloud', match: /^oraclecloud|^oracle cloud/i },
  { name: 'Alibaba Cloud', match: /^alibaba cloud/i },
  { name: 'Scaleway', match: /^scaleway/i },
];
// Azure is told by its chassis asset tag (ds-identify's is_azure_chassis): Hyper-V on a home PC reports the same vendor
// and product ("Microsoft Corporation", "Virtual Machine").
const AZURE_TAG = '7783-7084-3265-9085-8269-3286-77';

const DMI = { vendor: 'sys_vendor', product: 'product_name', biosVendor: 'bios_vendor', biosVersion: 'bios_version', assetTag: 'chassis_asset_tag', uuid: 'product_uuid' };

function readDmi() {
  const out = {};
  const read = (k, f) => {
    try {
      out[k] = fs.readFileSync(f, 'utf8');
    } catch {
      /* a container, not Linux, or root only (product_uuid): nothing to say */
    }
  };
  for (const [k, f] of Object.entries(DMI)) read(k, `/sys/class/dmi/id/${f}`);
  read('hvUuid', '/sys/hypervisor/uuid'); // Xen: readable by every user, where product_uuid is root's only
  return out;
}

/** An Amazon EC2 instance as ds-identify tells it, also an older Xen one ("Xen", "HVM domU"). */
function ec2(d) {
  if (/^ec2/i.test(d.hvUuid) || /amazon/i.test(d.biosVendor) || /amazon/i.test(d.biosVersion)) return true;
  const first = d.uuid.split('-')[0];
  return /^ec2/i.test(first) || /2[0-9a-f]ec$/i.test(first); // the second: the same id written little-endian
}

/**
 * The cloud the hardware files name, or null. `dmi`: { vendor, product, biosVendor, biosVersion, assetTag, uuid,
 * hvUuid } as read from the files.
 */
export function cloudOf(dmi = {}) {
  const d = Object.fromEntries(['vendor', 'product', 'biosVendor', 'biosVersion', 'assetTag', 'uuid', 'hvUuid'].map((k) => [k, String(dmi[k] || '').trim().replace(/\s+/g, ' ')]));
  if (d.assetTag === AZURE_TAG) return 'Microsoft Azure';
  if (ec2(d)) return 'Amazon EC2';
  for (const c of CLOUDS) if (c.match.test(d.vendor) || c.match.test(d.product)) return c.name;
  return null;
}

/**
 * Does this user have a desktop on this computer: a local graphical login session of this user (x11, wayland or mir,
 * not remote, of class "user"), as logind keeps it in /run/systemd/sessions (the facts `loginctl show-session` shows,
 * read without starting a program)? A display socket alone is not one: a headless browser's Xvfb or the user's own
 * VNC server makes an X socket of this user on a server too. Not known (no logind): no desktop. `at` is for tests:
 * { sessionsDir, uid }.
 */
export function localDisplay(env = process.env, at = {}) {
  const uid = at.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const dir = at.sessionsDir || '/run/systemd/sessions';
  if (uid === null) return false;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^[A-Za-z0-9]+$/.test(n));
  } catch {
    return false;
  }
  return names.some((n) => {
    try {
      const f = Object.fromEntries(fs.readFileSync(path.join(dir, n), 'utf8').split('\n').map((l) => l.split('=')).filter((kv) => kv.length >= 2).map(([k, ...v]) => [k, v.join('=')]));
      return f.UID === String(uid) && /^(x11|wayland|mir)$/.test(f.TYPE || '') && f.REMOTE !== '1' && (f.CLASS || 'user') === 'user';
    } catch {
      return false;
    }
  });
}

/** An ssh session with no desktop: SSH_CONNECTION or SSH_TTY, no Wayland, no X display except a forwarded one, and
 * (`display`) no display of the computer's own. */
export function sshWithoutDesktop(env = {}, platform = process.platform, display = false) {
  if (platform !== 'linux') return false;
  if (!env.SSH_CONNECTION && !env.SSH_TTY) return false;
  if (env.WAYLAND_DISPLAY || display) return false;
  const d = String(env.DISPLAY || '');
  // ":0" is a desktop on this computer; "localhost:10.0" is the display ssh forwards from the other one.
  return !d || /^[^:]+:/.test(d);
}

const savedFile = () => path.join(stateDir(), 'server.json');
const hasDisplay = (sys, env) => (typeof sys.localDisplay === 'boolean' ? sys.localDisplay : localDisplay(env));
// The ssh port of this process's ssh session, 22 included, or null when it has no ssh session it can tell.
const sessionPort = (env) => {
  const p = String(env.SSH_CONNECTION || '').trim().split(/\s+/)[3];
  return p && /^\d{1,5}$/.test(p) ? p : null;
};
// The same when it is not the usual 22 (the forward line names it only then).
const sshPortOf = (env) => {
  const p = sessionPort(env);
  return p && p !== '22' ? p : null;
};

/** What this computer itself shows now (no saved reason): the reason, or null. */
export function liveReason(sys = {}) {
  const env = sys.env || process.env;
  const platform = sys.platform || process.platform;
  const port = sshPortOf(env);
  const with_ = (r) => (port ? { ...r, sshPort: port } : r);
  const ips = sys.publicIps ?? publicAddresses();
  if (ips.length) return with_({ kind: 'public', address: ips[0] });
  if (sshWithoutDesktop(env, platform, platform === 'linux' && hasDisplay(sys, env))) return with_({ kind: 'ssh' });
  if (platform === 'linux') {
    const name = cloudOf(sys.dmi ?? readDmi());
    if (name) return with_({ kind: 'cloud', name });
  }
  return null;
}

// The cloud names cloudOf can give: a saved name is one of these, never free text.
const CLOUD_NAMES = new Set(['Microsoft Azure', 'Amazon EC2', ...CLOUDS.map((c) => c.name)]);

/** A saved reason as set-up writes it ({ kind: 'ssh' | 'cloud', name, sshPort }), or null for anything else. */
export function savedReason(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.sshPort !== undefined && !(typeof r.sshPort === 'string' && /^\d{1,5}$/.test(r.sshPort))) return null;
  const port = r.sshPort ? { sshPort: r.sshPort } : {};
  if (r.kind === 'ssh') return { kind: 'ssh', ...port };
  if (r.kind === 'cloud' && CLOUD_NAMES.has(r.name)) return { kind: 'cloud', name: r.name, ...port };
  return null; // a public address is not kept (an older version's file): the live check sees it, also in the service
}

function readSaved() {
  try {
    return savedReason(JSON.parse(fs.readFileSync(savedFile(), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Why this computer is a server, or null: { kind: 'public', address } | { kind: 'ssh', sshPort } | { kind: 'cloud',
 * name }. What it shows now comes first; else the reason set-up saved, while the computer still has no display of its
 * own (the dashboard service, a terminal of it, `su -`: no ssh session to see).
 */
export function serverReason(sys = {}) {
  const live = liveReason(sys);
  const saved = sys.savedServer !== undefined ? sys.savedServer : readSaved();
  // The ssh port set-up saw stays known only where this process has no ssh session of its own (a cloud found by its
  // hardware); a live session's port, 22 included, is the one that holds.
  const env = sys.env || process.env;
  if (live) return !live.sshPort && !sessionPort(env) && saved && saved.sshPort ? { ...live, sshPort: saved.sshPort } : live;
  const platform = sys.platform || process.platform;
  return saved && platform === 'linux' && !hasDisplay(sys, env) ? saved : null;
}

/**
 * The reason an earlier set-up saved that is not used now, only because this user has a desktop session here (Linux):
 * whenever nobody is logged in at it (the dashboard service after a restart) the computer counts as a server again.
 * Null when there is none, or when it is in use.
 */
export function dormantReason(sys = {}) {
  const env = sys.env || process.env;
  if ((sys.platform || process.platform) !== 'linux' || liveReason(sys) || !hasDisplay(sys, env)) return null;
  return sys.savedServer !== undefined ? savedReason(sys.savedServer) : readSaved();
}

/** The one line set-up and doctor say about a dormant reason: what was saved, when it counts, and the way out. */
export function dormantWords(r) {
  const what = r.kind === 'cloud' ? `a cloud server (${r.name})` : 'a server (it was reached over ssh, with no desktop)';
  return `An earlier set-up saved this computer as ${what}. That is not used while you are at this desktop, but with nobody logged in here (the background service after a restart) it counts as a server again. If this is your own computer: hoprig setup --access network`;
}

/**
 * Set-up keeps what it found (`live`, from liveReason) that does not change with the network: ssh with no desktop, or a
 * cloud's hardware. A public address is left to the live check (the dashboard service reads the network card too), so
 * one seen once is never named after it is gone. A desktop this run sees never deletes the saved reason.
 */
export function rememberServer(live, sys = {}) {
  if (live && live.kind === 'public') live = liveReason({ ...sys, publicIps: [] });
  if (!live) return; // only a public address, or a desktop: the saved reason stays as it is
  try {
    if (live) {
      const keep = readSaved();
      // The ssh port is kept from an earlier ssh run only when this run has no ssh session (a terminal of the
      // dashboard); a session on port 22 replaces an older port.
      const sshPort = sessionPort(sys.env || process.env) ? live.sshPort : live.sshPort || (keep && keep.sshPort);
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(savedFile(), `${JSON.stringify(sshPort ? { ...live, sshPort } : live)}\n`);
    }
    // A desktop seen now never deletes a saved reason: serverReason leaves it unused while the desktop is there.
  } catch {
    /* not kept: the next run finds it again */
  }
}

/**
 * Forget the saved reason: only when the owner chose "devices on my network" himself, in this run, at a local graphical
 * session of this user, and nothing live says server (no public address, no ssh session, no cloud hardware). A display
 * that only appeared never does this (rememberServer). → true when a saved reason was removed.
 */
export function forgetServer(sys = {}) {
  const env = sys.env || process.env;
  if (liveReason(sys) || !hasDisplay(sys, env)) return false;
  try {
    fs.rmSync(savedFile());
    return true;
  } catch {
    return false; // none was saved
  }
}

/** The reason in plain words, for the start of a sentence; the same for set-up, doctor and the page. */
export function reasonWords(r) {
  if (!r) return '';
  if (r.kind === 'public') return `this computer has a public address (${r.address})`;
  if (r.kind === 'ssh') return 'this is a server (reached over ssh, with no desktop of its own)';
  return `this is a cloud server (its hardware says ${r.name})`;
}

/**
 * The one line that brings the dashboard to the person's own computer over ssh. The user is the real one (the work user
 * when Hoprig runs as root and has made one), the ssh port
 * comes from SSH_CONNECTION, and the host is written only when it is a public address (on the card, or the server end
 * of SSH_CONNECTION): on a cloud the server's own address is private, so a placeholder stands there.
 */
export function forwardLine(port, sys = {}) {
  const env = sys.env || process.env;
  // As root with a work user Hoprig made (`sys.workUser`, rootfacts.mjs findWorkUser): that user, never root@.
  const work = sys.workUser && typeof sys.workUser.name === 'string' ? sys.workUser.name : null;
  const user = work || sys.user || safeUser(env, sys.userInfo) || '<you>';
  const serverIp = String(env.SSH_CONNECTION || '').trim().split(/\s+/)[2];
  // From this ssh session (22 included), else the one set-up saved (`sys.sshPort`: the service has no ssh session).
  const sshPort = sessionPort(env) || (sys.sshPort ? String(sys.sshPort) : null);
  const ips = sys.publicIps ?? publicAddresses();
  const host = ips[0] || (isPublicIp(serverIp) ? serverIp : null);
  const p = sshPort && /^\d{1,5}$/.test(sshPort) && sshPort !== '22' ? ` -p ${sshPort}` : '';
  return `ssh -N -L ${localPortFor(port)}:127.0.0.1:${port}${p} ${user}@${host || '<the address you use for ssh>'}`;
}

/**
 * The port on the person's own computer: not the dashboard's own, which their own dashboard most likely uses there
 * (ssh could not bind it, and localhost would open their own dashboard).
 */
export const localPortFor = (port) => (Number(port) + 10000 <= 65535 ? Number(port) + 10000 : Number(port) - 1000);

function safeUser(env, info = os.userInfo) {
  try {
    const u = info();
    // In a made-up home (the demo runs in its own temporary HOME) the login is this computer's real one: never shown.
    if (env.HOME && u.homedir && path.resolve(env.HOME) !== path.resolve(u.homedir)) return null;
    return u.username;
  } catch {
    return null;
  }
}

/**
 * The ways to reach a dashboard on a server, one line each (the same words in set-up, doctor and the page). The last one
 * ends with a colon: forwardLine() is its command, shown on a line of its own where it can be copied alone.
 */
export function serverWays(port) {
  return [
    'add this server to your main dashboard: Computers → Add a computer → "I can reach it by SSH"',
    'the public link: hoprig public on (or Settings → Public link)',
    'Tailscale: hoprig setup --access tailscale',
    `one ssh forward from your own computer, then open http://localhost:${localPortFor(port)}/ there:`,
  ];
}

/** Is `host` (server.host) open beyond this computer? */
export const openHost = (host) => !!host && !['127.0.0.1', '::1', 'localhost'].includes(host) && !/^127\./.test(host);

/**
 * The refusal of "devices on my network" on a server, in one sentence with what to use instead. It ends with the forward
 * command and no period after it: a period copied with the command would end up in the host name.
 */
export function notOnServer(reason, port, sys = {}) {
  return `Not over plain http: ${reasonWords(reason)}, so "devices on the network" would be the internet, and anyone could read the password on the way. Use one of these instead: ${serverWays(port).join('; ')} ${forwardLine(port, { sshPort: reason && reason.sshPort, ...sys })}`;
}
