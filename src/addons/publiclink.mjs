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
//
// Because the address is new at each start, it is sent through the owner's notifications (Settings → Notifications,
// the event "link"), so his phone gets the new link. One more local service (such as TRouteAI's own dashboard) can
// get a temporary address of its own the same way.
//
// The same add-on also gives the dashboard a fixed address, through a Cloudflare named tunnel: fixedlink.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { sendNotification } from '../server/notify.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { capture, showCommand, stream, which } from '../setup/system.mjs';
import { addonsDir, alive, binDir, dashboardPort, findBin, fixedRestore, hasPassword, patchFor, quickStateFile, restoreFor, writeAtomic } from './cloudflared.mjs';
import { attach, detach, fixedActions, fixedCloseOpenedBy, fixedStatus } from './fixedlink.mjs';
import { checkPort, exposureQuestion, serviceLogin } from './localservice.mjs';

export { findBin, patchFor, restoreFor };

export const ID = 'public-link';
/** The release we install: a few weeks old, so it is not a fresh, unproven one. */
export const CLOUDFLARED_VERSION = '2026.10.1';
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/download';

const dir = addonsDir;
const stateFile = quickStateFile;
const logFile = () => path.join(dir(), 'public-link.log');
// The second temporary address, for one more local service.
const serviceFile = () => path.join(dir(), 'public-link-service.json');
const serviceLog = () => path.join(dir(), 'public-link-service.log');

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

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const readState = () => readJson(stateFile());
const port = dashboardPort;

/** Put the config back as it was before start, once. While the fixed address is on, trustProxy stays on for it. */
function undoConfig(st) {
  if (!st || !st.restore || st.restored) return;
  saveConfig(restoreFor(loadConfig().server, st.restore, { keepTrust: !!fixedRestore() }));
  writeAtomic(stateFile(), JSON.stringify({ ...st, restored: true }));
}

/** The push for a new temporary address: the address itself, so tapping it opens the page there. */
export function newAddressEvent(url, what = 'this dashboard') {
  return { status: 'link', force: true, session: '', title: `New public link for ${what}`, message: url, url };
}

/** Send it through the owner's notifications when he chose them (and the event "link"). Never throws. */
export function notifyNewAddress(url, what, { send = sendNotification, config = loadConfig } = {}) {
  try {
    const n = config().server.notify;
    if (!n || !n.url) return Promise.resolve({ sent: false });
    return Promise.resolve(send(n, newAddressEvent(url, what))).catch(() => ({ sent: false }));
  } catch {
    return Promise.resolve({ sent: false });
  }
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
  const sv = readJson(serviceFile());
  return {
    installed: Boolean(bin),
    version,
    running,
    url: running ? st.url : null,
    account: false, // nothing to "set up as an account": it is not an AI provider
    notes: NOTES,
    // The second temporary address, for one more local service: { port, url } while it runs.
    service: sv && alive(sv.pid) && sv.url ? { port: sv.port, url: sv.url } : null,
    fixed: fixedStatus(),
  };
}

export const NOTES = [
  'The address changes every time it starts, and stops working when it stops.',
  'Anyone who has the address reaches the sign-in page: use a long random password (hoprig passwd --generate FILE).',
  'Your traffic passes through Cloudflare.',
  'For a while, not for every day: for that, use the fixed address, a hub (docs/HUB.md) or Tailscale.',
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

/**
 * Start `cloudflared tunnel --url http://127.0.0.1:<port>` in the background, its output in `log`, and wait until it
 * is connected. { ok, pid, url } or { ok: false, error }.
 */
async function quickTunnel(bin, toPort, log, waitMs) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(log, 'w', 0o600);
  const argv = tunnelArgv(bin, toPort);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  let seen = { url: null, registered: false, errors: [] };
  for (let waited = 0; waited < waitMs && !seen.registered; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    seen = tunnelState(fs.readFileSync(log, 'utf8'));
    if (!alive(child.pid)) break;
  }
  if (seen.url && seen.registered) return { ok: true, pid: child.pid, url: seen.url };
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  const text = fs.readFileSync(log, 'utf8');
  let why = seen.errors.length ? seen.errors.join(' ') : text.trim().split('\n').slice(-1).join('');
  if (/x509: certificate signed by unknown authority/.test(text)) why = 'this system has no root certificates: install its "ca-certificates" package, then start again';
  return { ok: false, error: `${seen.url ? 'cloudflared got an address but could not connect to Cloudflare' : 'cloudflared gave no address'}${why ? `: ${why}` : ''} (its log: ${log})` };
}

/**
 * Start the tunnel in the background and wait for its address. Never called by itself: only by the owner, or by a
 * linked hub with its token (`by`: that token's id, kept so that its revoke stops it; never the token itself).
 */
async function start({ waitMs = 60_000, notify = notifyNewAddress, by = null } = {}) {
  const st = readState();
  if (st && alive(st.pid) && st.url) return { ok: true, url: st.url, already: true };
  if (st && !st.restored) undoConfig(st);
  const bin = findBin();
  if (!bin) return { ok: false, error: 'cloudflared is not installed (hoprig addons install public-link)' };
  if (!hasPassword()) {
    return { ok: false, error: 'Set a dashboard password first (hoprig passwd --generate FILE): the address leads to the sign-in page.' };
  }
  if (!runningDashboard()) return { ok: false, error: 'The dashboard is not running: start it first (hoprig serve, or hoprig service install).' };
  const t = await quickTunnel(bin, port(), logFile(), waitMs);
  if (!t.ok) return t;
  // The fixed address may be on: then the owner's own trustProxy is in its record, not in the config.
  const { patch, restore } = patchFor(loadConfig().server, t.url, { inherit: fixedRestore() });
  saveConfig(patch);
  writeAtomic(stateFile(), JSON.stringify({ pid: t.pid, url: t.url, restore, restored: false, started: Date.now(), openedBy: by || null }));
  await notify(t.url, 'this dashboard');
  return { ok: true, url: t.url, already: false };
}

/**
 * A temporary address for one more local service. Without a sign-in of its own it starts only after a confirm.
 * `fetchImpl`: for tests (the look at the service).
 */
async function startService({ port: p, confirmed } = {}, { waitMs = 60_000, notify = notifyNewAddress, fetchImpl, by = null } = {}) {
  const want = checkPort(p, port());
  if (want.error) return { ok: false, error: want.error };
  const sv = readJson(serviceFile());
  if (sv && alive(sv.pid) && sv.url) return { ok: false, error: `Port ${sv.port} has a temporary address already: stop it first.` };
  const bin = findBin();
  if (!bin) return { ok: false, error: 'cloudflared is not installed: press Install first.' };
  const look = await serviceLogin(want.port, { fetchImpl });
  if (!look.answers) return { ok: false, error: `Nothing answers on port ${want.port} on this computer. Start that service first.` };
  const question = exposureQuestion(want.port, look);
  if (question && confirmed !== true) return { ok: false, confirm: question };
  const t = await quickTunnel(bin, want.port, serviceLog(), waitMs);
  if (!t.ok) return t;
  writeAtomic(serviceFile(), JSON.stringify({ pid: t.pid, url: t.url, port: want.port, openedBy: by || null }));
  await notify(t.url, `port ${want.port}`);
  return { ok: true, url: t.url };
}

async function stopPid(pid) {
  if (!alive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  return !alive(pid);
}

async function stopService() {
  const sv = readJson(serviceFile());
  const ok = sv ? await stopPid(sv.pid) : true;
  if (ok) fs.rmSync(serviceFile(), { force: true });
  return { ok };
}

async function stop() {
  const st = readState();
  if (!st || !alive(st.pid)) {
    if (st) undoConfig(st);
    return { ok: true, already: true };
  }
  const ok = await stopPid(st.pid);
  undoConfig(st);
  return { ok };
}

/**
 * A machine token was revoked (`gone(id)`: that token no longer exists): stop each temporary address it started and
 * what it opened on the fixed address. What the owner started is never touched. → [{ by, say(who) }] (feature.mjs).
 */
async function closeOpenedBy(gone) {
  const out = [];
  const st = readState();
  if (st && alive(st.pid) && gone(st.openedBy)) {
    await stop();
    out.push({ by: st.openedBy, say: (who) => `The public link ${who} started was stopped: its token was revoked` });
  }
  const sv = readJson(serviceFile());
  if (sv && alive(sv.pid) && gone(sv.openedBy)) {
    await stopService();
    out.push({ by: sv.openedBy, say: (who) => `The temporary address of port ${sv.port} that ${who} started was stopped: its token was revoked` });
  }
  return [...out, ...(await fixedCloseOpenedBy(gone))];
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
  summary: 'Open this dashboard from anywhere, without a server of your own, through Cloudflare: a fixed address on your own domain, or a temporary one that changes at every start.',
  homepage: 'https://github.com/allswebtech/hoprig/blob/main/docs/COMPUTERS.md#a-public-link-through-cloudflare',
  status,
  install,
  update,
  start,
  stop,
  beforeStart,
  afterStart,
  // The page's other actions: POST /api/addons/public-link/do/<name> (feature.mjs).
  actions: {
    ...fixedActions,
    'quick-service-start': (b, o) => startService(b, o),
    'quick-service-stop': () => stopService(),
  },
  // The fixed address runs with the dashboard (feature.mjs calls these when it starts and stops).
  attach,
  detach,
  closeOpenedBy,
  profile: null,
};
