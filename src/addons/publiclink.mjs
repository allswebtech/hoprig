// Public link: reach this dashboard from anywhere without a server of your own, through Cloudflare's free quick
// tunnel. `cloudflared tunnel --url http://127.0.0.1:<port>` connects OUT to Cloudflare and gets a temporary
// https://<words>.trycloudflare.com address that leads here. No account, no router change.
//
// What Cloudflare's documentation says (https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/, "Last
// updated Sep 30, 2026", read 14 Nov 2026), and so what this add-on promises:
//   - "You do not need a Cloudflare account or domain."
//   - "The hostname changes each time you create a Quick Tunnel."  "The URL stops working when you stop the
//     cloudflared process."  So the address is new at every start, and it is shown each time.
//   - "Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel."  So: for a
//     while, never started by itself; for every day, a hub or Tailscale (docs/HUB.md).
//   - "Anyone with the URL can access your local service."  Here that means the sign-in page: the password matters.
//   - "up to 200 in-flight requests", "no uptime guarantee", "do not support Server-Sent Events" (the dashboard uses
//     WebSockets and plain requests, no SSE).
// WebSockets are not named on that page; they were tested end to end (login, a terminal typed into and read back
// through a trycloudflare address) with cloudflared 2026.10.1 on 14 Nov 2026.
//
// Install: the official release files at https://github.com/cloudflare/cloudflared/releases (listed on
// https://developers.cloudflare.com/tunnel/downloads/), saved into hoprig's own folder: no administrator rights,
// nothing system-wide. On macOS with Homebrew: `brew install cloudflared` (the same page). A cloudflared already on
// PATH is used as it is.
//
// While it runs: server.trustProxy is on (cloudflared passes the visitor's https as X-Forwarded-Proto, so the login
// cookie is marked secure) and its address is an allowed origin. Stop puts both back as they were.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { capture, showCommand, stream, which } from '../setup/system.mjs';

export const ID = 'public-link';
/** The release we install: a few weeks old, so it is not a fresh, unproven one. */
export const CLOUDFLARED_VERSION = '2026.10.1';
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/download';

const dir = () => path.join(stateDir(), 'addons');
const binDir = () => path.join(dir(), 'bin');
const stateFile = () => path.join(dir(), 'public-link.json');
const logFile = () => path.join(dir(), 'public-link.log');
const DEFAULT_PORT = 7433;

/** The address in a cloudflared output line, or null. "api.trycloudflare.com" (the service it asks) is not one. */
export function parseTunnelUrl(text) {
  for (const m of String(text).matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/g)) {
    if (m[1] !== 'api') return `https://${m[1]}.trycloudflare.com`;
  }
  return null;
}

/**
 * What cloudflared's output says so far: { url, registered, errors }. The address is printed BEFORE the tunnel is
 * connected; only "Registered tunnel connection" means visitors can arrive. `errors`: its connectivity check's
 * "ERROR:" lines (for example outbound port 7844 blocked), each once.
 */
export function tunnelState(text) {
  const t = String(text);
  const errors = [...new Set([...t.matchAll(/\|\s*ERROR:\s*(.+?)\s*\|/g)].map((m) => m[1]))];
  return { url: parseTunnelUrl(t), registered: /Registered tunnel connection/.test(t), errors };
}

/** The release file for this OS and processor (names as on the releases page), or null when there is none. */
export function releaseAsset(platform = process.platform, arch = process.arch) {
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch];
  if (platform === 'linux' && a) return `cloudflared-linux-${a}`;
  if (platform === 'darwin' && (a === 'amd64' || a === 'arm64')) return `cloudflared-darwin-${a}.tgz`;
  // Windows on ARM runs the x64 build.
  if (platform === 'win32') return `cloudflared-windows-${a === '386' ? '386' : 'amd64'}.exe`;
  return null;
}

/**
 * How to install it here: { kind: 'brew', argv } | { kind: 'download', url, file, tgz } | { kind: 'none', reason }.
 * `hasBrew`: Homebrew is installed (macOS).
 */
export function installPlan({ platform = process.platform, arch = process.arch, hasBrew = false, into = binDir(), version = CLOUDFLARED_VERSION } = {}) {
  if (platform === 'darwin' && hasBrew) return { kind: 'brew', argv: ['brew', 'install', 'cloudflared'] };
  const asset = releaseAsset(platform, arch);
  if (!asset) return { kind: 'none', reason: `Cloudflare publishes no cloudflared for ${platform}/${arch}` };
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return { kind: 'download', url: `${RELEASES}/${version}/${asset}`, file: path.join(into, exe), tgz: asset.endsWith('.tgz') };
}

/** The command line that starts the quick tunnel to the dashboard on `port`. */
export const tunnelArgv = (bin, port) => [bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];

/** The config change while it runs: { server: { trustProxy, allowedOrigins } } plus what to put back on stop. */
export function patchFor(server, origin) {
  const origins = Array.isArray(server.allowedOrigins) ? server.allowedOrigins : [];
  return {
    patch: { server: { trustProxy: true, allowedOrigins: origins.includes(origin) ? origins : [...origins, origin] } },
    restore: { hadTrustProxy: Object.hasOwn(server, 'trustProxy'), trustProxy: server.trustProxy, hadOrigin: origins.includes(origin), origin },
  };
}

/** The config change on stop: trustProxy as it was (absent stays absent), the origin removed unless it was there. */
export function restoreFor(server, restore) {
  const origins = (Array.isArray(server.allowedOrigins) ? server.allowedOrigins : []).filter((o) => restore.hadOrigin || o !== restore.origin);
  return { server: { trustProxy: restore.hadTrustProxy ? restore.trustProxy : undefined, allowedOrigins: origins.length ? origins : undefined } };
}

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
// The port of the dashboard that runs now (it may have been started with --port or PORT), else the configured one.
const port = () => runningDashboard()?.port || Number(loadConfig().server.port) || DEFAULT_PORT;

/** cloudflared on PATH, else the one this add-on downloaded. */
export function findBin(env = process.env, platform = process.platform) {
  return which('cloudflared', env, platform) || which(path.join(binDir(), platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), env, platform);
}

/** Put the config back as it was before start, once. */
function undoConfig(st) {
  if (!st || !st.restore || st.restored) return;
  saveConfig(restoreFor(loadConfig().server, st.restore));
  fs.writeFileSync(stateFile(), JSON.stringify({ ...st, restored: true }), { mode: 0o600 });
}

async function status() {
  const bin = findBin();
  let version = null;
  if (bin) {
    const m = /(\d{4}\.\d+\.\d+)/.exec((await capture([bin, '--version'], { timeout: 10_000 })).stdout || '');
    version = m ? m[1] : null;
  }
  const st = readState();
  const running = !!(st && alive(st.pid) && st.url);
  // It ended by itself (crash, reboot): its settings go back now, so they never outlive the tunnel.
  if (st && !running && !st.restored) undoConfig(st);
  return {
    installed: Boolean(bin),
    version,
    running,
    url: running ? st.url : null,
    account: false, // nothing to "set up as an account": it is not an AI provider
    notes: NOTES,
  };
}

export const NOTES = [
  'The address changes every time it starts, and stops working when it stops.',
  'Anyone who has the address reaches the sign-in page: use a long random password (hoprig passwd --generate FILE).',
  'Your traffic passes through Cloudflare.',
  'For a while, not for every day: for that, use a hub (docs/HUB.md) or Tailscale.',
];

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  if (res.url && !res.url.startsWith('https://')) throw new Error(`${url} redirected to a non-https address`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
}

async function install({ onLine = () => {} } = {}) {
  const plan = installPlan({ hasBrew: process.platform === 'darwin' && !!which('brew') });
  if (plan.kind === 'none') {
    onLine(plan.reason);
    return { ok: false, error: plan.reason };
  }
  if (plan.kind === 'brew') {
    onLine(`command: ${showCommand(plan.argv)}`);
    const r = await stream(plan.argv, { onLine });
    return { ok: r.ok && !!findBin() };
  }
  onLine(`downloading ${plan.url}`);
  try {
    if (plan.tgz) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-cloudflared-'));
      await download(plan.url, path.join(tmp, 'c.tgz'));
      const r = await stream(['tar', '-xzf', path.join(tmp, 'c.tgz'), '-C', tmp], { onLine });
      if (!r.ok) throw new Error('could not unpack it');
      fs.mkdirSync(path.dirname(plan.file), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(tmp, 'cloudflared'), plan.file);
      fs.chmodSync(plan.file, 0o755);
      fs.rmSync(tmp, { recursive: true, force: true });
    } else await download(plan.url, plan.file);
  } catch (e) {
    onLine(e.message);
    return { ok: false, error: e.message };
  }
  onLine(`installed: ${plan.file}`);
  return { ok: !!findBin() };
}

async function update({ onLine = () => {} } = {}) {
  onLine(findBin() === which('cloudflared') && process.platform === 'darwin' ? 'Update it with: brew upgrade cloudflared' : `This add-on installs cloudflared ${CLOUDFLARED_VERSION}.`);
  return install({ onLine });
}

/** Start the tunnel in the background and wait for its address. Never called by itself: only by the owner. */
async function start({ waitMs = 60_000 } = {}) {
  const st = readState();
  if (st && alive(st.pid) && st.url) return { ok: true, url: st.url, already: true };
  if (st && !st.restored) undoConfig(st);
  const bin = findBin();
  if (!bin) return { ok: false, error: 'cloudflared is not installed (hoprig addons install public-link)' };
  const server = loadConfig().server;
  if (typeof server.passwordHash !== 'string' || !server.passwordHash.startsWith('scrypt$')) {
    return { ok: false, error: 'Set a dashboard password first (hoprig passwd --generate FILE): the address leads to the sign-in page.' };
  }
  if (!runningDashboard()) return { ok: false, error: 'The dashboard is not running: start it first (hoprig serve, or hoprig service install).' };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logFile(), 'w', 0o600);
  const child = spawn(tunnelArgv(bin, port())[0], tunnelArgv(bin, port()).slice(1), { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(stateFile(), JSON.stringify({ pid: child.pid, url: null, restored: true }), { mode: 0o600 });
  let seen = { url: null, registered: false, errors: [] };
  for (let waited = 0; waited < waitMs && !seen.registered; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    seen = tunnelState(fs.readFileSync(logFile(), 'utf8'));
    if (!alive(child.pid)) break;
  }
  const url = seen.url;
  if (!url || !seen.registered) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
    const log = fs.readFileSync(logFile(), 'utf8');
    let why = seen.errors.length ? seen.errors.join(' ') : log.trim().split('\n').slice(-1).join('');
    if (/x509: certificate signed by unknown authority/.test(log)) why = 'this system has no root certificates: install its "ca-certificates" package, then start again';
    return { ok: false, error: `${url ? 'cloudflared got an address but could not connect to Cloudflare' : 'cloudflared gave no address'}${why ? `: ${why}` : ''} (its log: ${logFile()})` };
  }
  const { patch, restore } = patchFor(loadConfig().server, url);
  saveConfig(patch);
  fs.writeFileSync(stateFile(), JSON.stringify({ pid: child.pid, url, restore, restored: false, started: Date.now() }), { mode: 0o600 });
  return { ok: true, url, already: false };
}

async function stop() {
  const st = readState();
  if (!st || !alive(st.pid)) {
    if (st) undoConfig(st);
    return { ok: true, already: true };
  }
  try { process.kill(st.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 20 && alive(st.pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive(st.pid)) try { process.kill(st.pid, 'SIGKILL'); } catch { /* gone */ }
  undoConfig(st);
  return { ok: !alive(st.pid) };
}

/** For `hoprig addons start public-link`: say what it means, and ask, before anything starts. */
async function beforeStart({ args = [], ask, out = (s) => console.log(s) } = {}) {
  out('A public link makes this dashboard reachable from anywhere through Cloudflare, until you stop it.');
  for (const n of NOTES) out(`  - ${n}`);
  const i = args.indexOf('--new-password');
  if (i >= 0) {
    const file = args[i + 1];
    if (!file) {
      out('usage: hoprig addons start public-link [--yes] [--new-password FILE]');
      return false;
    }
    const cli = await import('../server/cli.mjs');
    if ((await cli.main('passwd', ['--generate', file])) !== 0) return false;
  }
  if (args.includes('--yes')) return true;
  if (!process.stdin.isTTY) {
    out('Add --yes to start it without a question.');
    return false;
  }
  const a = await ask('Start it? (y/N) ');
  return !!a && /^y/i.test(a);
}

/** After a start from the command line: the address, and a QR code that signs a phone in once. */
async function afterStart(r, { out = (s) => console.log(s) } = {}) {
  out(`\nYour public link (new each start): ${r.url}`);
  try {
    const { createLoginLink } = await import('../server/loginlink.mjs');
    const { qrText } = await import('../setup/qr.mjs');
    const link = createLoginLink({ baseUrl: r.url, minutes: 15 });
    const qr = qrText(link.url);
    out("Scan with your phone's camera to sign in (works once, for 15 minutes):");
    if (qr) out(qr);
    out(link.url);
  } catch {
    /* the plain address is shown above */
  }
  out('Stop it with: hoprig addons stop public-link');
}

export const publicLink = {
  id: ID,
  title: 'Public link',
  summary: 'Open this dashboard from anywhere, without a server: a temporary https address through Cloudflare\'s free quick tunnel. The address changes every time; for testing, not for every day.',
  homepage: 'https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/',
  status,
  install,
  update,
  start,
  stop,
  beforeStart,
  afterStart,
  profile: null,
};
