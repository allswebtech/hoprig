// What the two kinds of public link share (publiclink.mjs: the Temporary address; fixedlink.mjs: the Custom one;
// linkswitch.mjs: the one switch that runs either, never both): where cloudflared is, the dashboard's port and
// password, and the settings change while a link is in use.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { which } from '../setup/system.mjs';

export const addonsDir = () => path.join(stateDir(), 'addons');
export const binDir = () => path.join(addonsDir(), 'bin');
export const quickStateFile = () => path.join(addonsDir(), 'public-link.json');
export const fixedDir = () => path.join(addonsDir(), 'fixed-link');
export const fixedStateFile = () => path.join(fixedDir(), 'fixed.json');
/** The switch's record: what runs, its address, the owner's own settings while a link changed them (linkswitch.mjs). */
export const linkRecordFile = () => path.join(addonsDir(), 'link.json');
const DEFAULT_PORT = 7433;

/**
 * Write a state file whole or not at all: a new temporary file (mode 0600) in the same folder, then a rename over the
 * old one. A crash, or a read at the same moment, never sees half a file: readFixed() would take that for "not set
 * up", and the next start of the dashboard would leave the fixed address off.
 */
export function writeAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** cloudflared on PATH, else the one this add-on downloaded. */
export function findBin(env = process.env, platform = process.platform) {
  return which('cloudflared', env, platform) || which(path.join(binDir(), platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), env, platform);
}

export const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** The port of the dashboard that runs now (it may have been started with --port or PORT), else the configured one. */
export const dashboardPort = () => runningDashboard()?.port || Number(loadConfig().server.port) || DEFAULT_PORT;

/** Both links lead to the sign-in page: without a password they must not start. */
export const hasPassword = () => {
  const h = loadConfig().server.passwordHash;
  return typeof h === 'string' && h.startsWith('scrypt$');
};

/**
 * cloudflared's environment for the fixed address: a home of its own, so its certificate and files stay in Hoprig's
 * folder and it never reads or writes the owner's ~/.cloudflared (a config.yml there would change what it runs); a
 * PATH that is an empty folder of ours, so `tunnel login` cannot open a browser on this computer (the owner opens
 * the link in the page, wherever he is); and only what it needs to reach the network. Nothing else is passed: no
 * provider keys, and no TUNNEL_* variable of the owner's.
 */
export function cloudflaredEnv(home, emptyDir, env = process.env) {
  const out = { HOME: home, USERPROFILE: home, PATH: emptyDir };
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (env[k]) out[k] = env[k];
  }
  return out;
}

/**
 * The config change while a link is in use: { server: { trustProxy, allowedOrigins } } plus what to put back (the
 * owner's own trustProxy, and whether the origin was there before).
 */
export function patchFor(server, origin) {
  const origins = Array.isArray(server.allowedOrigins) ? server.allowedOrigins : [];
  return {
    patch: { server: { trustProxy: true, allowedOrigins: origins.includes(origin) ? origins : [...origins, origin] } },
    restore: { hadTrustProxy: Object.hasOwn(server, 'trustProxy'), trustProxy: server.trustProxy, hadOrigin: origins.includes(origin), origin },
  };
}

/** The config change when a link ends: trustProxy as it was (absent stays absent), the origin removed unless it was there. */
export function restoreFor(server, restore) {
  const origins = (Array.isArray(server.allowedOrigins) ? server.allowedOrigins : []).filter((o) => restore.hadOrigin || o !== restore.origin);
  return { server: { allowedOrigins: origins.length ? origins : undefined, trustProxy: restore.hadTrustProxy ? restore.trustProxy : undefined } };
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The record an older version kept for its detached temporary tunnel (read once, when the switch takes over). */
export const readQuick = () => readJsonFile(quickStateFile());

/** The Custom address's set-up: { mode, hostname, tunnelId, extra, … }, or null when it is not set up. */
export const readFixed = () => readJsonFile(fixedStateFile());
