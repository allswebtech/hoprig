// What the two kinds of public link share (publiclink.mjs: the temporary address; fixedlink.mjs: the fixed one):
// where cloudflared is, the dashboard's port and password, and the settings change while a link is in use.
//
// Both links can be on at once. Each records the owner's own trustProxy value before it changes it; when the other
// link is already on, that value is taken from the other's record (the current one is the other link's change), and
// a link that ends while the other one is still on leaves trustProxy on. So the last one to end puts back exactly
// what the owner had.
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
const DEFAULT_PORT = 7433;

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
 * The config change while a link is in use: { server: { trustProxy, allowedOrigins } } plus what to put back.
 * `inherit`: the other link's record when it is on (see the header).
 */
export function patchFor(server, origin, { inherit = null } = {}) {
  const origins = Array.isArray(server.allowedOrigins) ? server.allowedOrigins : [];
  const own = inherit ? { hadTrustProxy: inherit.hadTrustProxy, trustProxy: inherit.trustProxy } : { hadTrustProxy: Object.hasOwn(server, 'trustProxy'), trustProxy: server.trustProxy };
  return {
    patch: { server: { trustProxy: true, allowedOrigins: origins.includes(origin) ? origins : [...origins, origin] } },
    restore: { ...own, hadOrigin: origins.includes(origin), origin },
  };
}

/**
 * The config change when a link ends: trustProxy as it was (absent stays absent), the origin removed unless it was
 * there. `keepTrust`: the other link is still on, so trustProxy stays as it is.
 */
export function restoreFor(server, restore, { keepTrust = false } = {}) {
  const origins = (Array.isArray(server.allowedOrigins) ? server.allowedOrigins : []).filter((o) => restore.hadOrigin || o !== restore.origin);
  const out = { server: { allowedOrigins: origins.length ? origins : undefined } };
  if (!keepTrust) out.server.trustProxy = restore.hadTrustProxy ? restore.trustProxy : undefined;
  return out;
}

export function readQuick() {
  try {
    return JSON.parse(fs.readFileSync(quickStateFile(), 'utf8'));
  } catch {
    return null;
  }
}

/** The temporary link's settings record while it runs, else null. */
export function quickRestore() {
  const st = readQuick();
  return st && alive(st.pid) && st.url && !st.restored && st.restore ? st.restore : null;
}

export function readFixed() {
  try {
    return JSON.parse(fs.readFileSync(fixedStateFile(), 'utf8'));
  } catch {
    return null;
  }
}

/** The fixed link's settings record while it is turned on, else null. */
export function fixedRestore() {
  const st = readFixed();
  return st && st.enabled && st.restore && !st.restored ? st.restore : null;
}
