// The Temporary kind of the public link: Cloudflare's free quick tunnel. `cloudflared tunnel --url
// http://127.0.0.1:<port>` connects OUT to Cloudflare and gets a temporary https://<words>.trycloudflare.com address
// that leads here. No account, no router change. The one switch that runs it (or the Custom kind, never both) is
// linkswitch.mjs; this file holds what is particular to it: reading its address, installing cloudflared, the push
// with a new address, and a second temporary address for one more local service.
//
// What Cloudflare's documentation says (https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/, "Last
// updated Sep 30, 2026", read 14 Nov 2026), and so what the page promises:
//   - "You do not need a Cloudflare account or domain."
//   - "The hostname changes each time you create a Quick Tunnel."  "The URL stops working when you stop the
//     cloudflared process."  So the address is new at every start, and it is shown and sent each time.
//   - "Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel."  That is the
//     Custom kind; the page says which to pick for computers that should stay linked.
//   - "Anyone with the URL can access your local service."  Here that means the sign-in page: the password must be
//     strong (strength.mjs), and the switch checks it.
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
// Because the address is new at each start, it is sent through the owner's notifications (Settings → Notifications,
// the event "link"), so his phone gets the new link. One more local service (such as TRouteAI's own dashboard) can
// get a temporary address of its own the same way.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { filedProcess, system } from '../procid.mjs';
import { sendNotification } from '../server/notify.mjs';
import { showCommand, stream, which } from '../setup/system.mjs';
import { addonsDir, alive, binDir, dashboardPort, findBin, patchFor, readJsonFile, restoreFor, writeAtomic } from './cloudflared.mjs';
import { tunnelFact } from './linkmigrate.mjs';
import { checkPort, exposureQuestion, serviceLogin } from './localservice.mjs';
import { withoutSecrets } from '../secretenv.mjs';

export { findBin, patchFor, restoreFor };

/** The release we install: a few weeks old, so it is not a fresh, unproven one. */
export const CLOUDFLARED_VERSION = '2026.10.1';
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/download';

const dir = addonsDir;
// The second temporary address, for one more local service: { pid, proc, url, port, openedBy } (proc: its cloudflared's
// identity, procid.mjs; none in a file of an older version).
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

const readJson = readJsonFile;
const port = dashboardPort;

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

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  if (res.url && !res.url.startsWith('https://')) throw new Error(`${url} redirected to a non-https address`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
}

/** Install cloudflared into Hoprig's own folder (or with Homebrew on macOS). → { ok, error? } */
export async function install({ onLine = () => {} } = {}) {
  const plan = installPlan({ hasBrew: process.platform === 'darwin' && !!which('brew') });
  if (plan.kind === 'none') {
    onLine(plan.reason);
    return { ok: false, error: plan.reason };
  }
  if (plan.kind === 'brew') {
    onLine(`command: ${showCommand(plan.argv)}`);
    const r = await stream(plan.argv, { env: withoutSecrets(process.env), onLine });
    return { ok: r.ok && !!findBin() };
  }
  onLine(`downloading ${plan.url}`);
  try {
    if (plan.tgz) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-cloudflared-'));
      await download(plan.url, path.join(tmp, 'c.tgz'));
      const r = await stream(['tar', '-xzf', path.join(tmp, 'c.tgz'), '-C', tmp], { env: withoutSecrets(process.env), onLine });
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

export async function update({ onLine = () => {} } = {}) {
  onLine(findBin() === which('cloudflared') && process.platform === 'darwin' ? 'Update it with: brew upgrade cloudflared' : `Hoprig installs cloudflared ${CLOUDFLARED_VERSION}.`);
  return install({ onLine });
}

/**
 * Start `cloudflared tunnel --url http://127.0.0.1:<port>` in the background, its output in `log`, and wait until it
 * is connected. { ok, pid, proc, url } (proc: its identity, read at once) or { ok: false, error }.
 */
async function quickTunnel(bin, toPort, log, waitMs) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(log, 'w', 0o600);
  const argv = tunnelArgv(bin, toPort);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], env: withoutSecrets(process.env), windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  const after = await system.refresh([child.pid]);
  const proc = system.of([child.pid], { after }).get(child.pid) || null;
  let seen = { url: null, registered: false, errors: [] };
  for (let waited = 0; waited < waitMs && !seen.registered; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    seen = tunnelState(fs.readFileSync(log, 'utf8'));
    if (!alive(child.pid)) break;
  }
  if (seen.url && seen.registered) return { ok: true, pid: child.pid, proc, url: seen.url };
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  const text = fs.readFileSync(log, 'utf8');
  let why = seen.errors.length ? seen.errors.join(' ') : text.trim().split('\n').slice(-1).join('');
  if (/x509: certificate signed by unknown authority/.test(text)) why = 'this system has no root certificates: install its "ca-certificates" package, then start again';
  return { ok: false, error: `${seen.url ? 'cloudflared got an address but could not connect to Cloudflare' : 'cloudflared gave no address'}${why ? `: ${why}` : ''} (its log: ${log})` };
}

/**
 * A temporary address for one more local service. Without a sign-in of its own it starts only after a confirm.
 * `fetchImpl`: for tests (the look at the service).
 */
async function startService({ port: p, confirmed } = {}, { waitMs = 60_000, notify = notifyNewAddress, fetchImpl, by = null } = {}) {
  const want = checkPort(p, port());
  if (want.error) return { ok: false, error: want.error };
  const sv = readJson(serviceFile());
  if (sv && sv.url && seen(sv) !== false) return { ok: false, error: `Port ${sv.port} has a temporary address already: stop it first.` };
  const bin = findBin();
  if (!bin) return { ok: false, error: 'cloudflared is not installed yet: turn the public link on once, and Hoprig installs it.' };
  const look = await serviceLogin(want.port, { fetchImpl });
  if (!look.answers) return { ok: false, error: `Nothing answers on port ${want.port} on this computer. Start that service first.` };
  const question = exposureQuestion(want.port, look);
  if (question && confirmed !== true) return { ok: false, confirm: question };
  const t = await quickTunnel(bin, want.port, serviceLog(), waitMs);
  if (!t.ok) return t;
  writeAtomic(serviceFile(), JSON.stringify({ pid: t.pid, proc: t.proc, url: t.url, port: want.port, openedBy: by || null }));
  await notify(t.url, `port ${want.port}`);
  return { ok: true, url: t.url };
}

/**
 * Whether the file's cloudflared is ours (procid.mjs filedProcess; its pid may belong to another program after a
 * restart of the computer): true, null (cannot be told: it may be said to run, never signalled) or false. The fact for
 * a file without an identity: a quick tunnel to its port. `wait` false for a status, which never waits for ps.
 */
const mine = (sv, { after = 0, wait = true } = {}) => filedProcess(serviceFile(), sv, { fact: (p) => tunnelFact(p, { port: sv.port, wait }), after });
const seen = (sv) => mine(sv, { wait: false });
/** mine() with what the system says now: for the moment before a signal. */
const mineNow = async (sv) => mine(sv, { after: (await system.refresh([sv.pid])) || 0 });

/**
 * Stop the file's cloudflared when it is shown to be ours; the file goes once nothing of ours runs. When it cannot be
 * told (Windows, a file of an older version), it gets no signal and the file stays: it may still be our tunnel, open to
 * everyone. → { ok, stopped, error }
 */
async function stopIt(sv) {
  const now = sv ? await mineNow(sv) : false;
  if (now === null) return { ok: false, stopped: false, error: `Hoprig cannot tell whether process ${sv.pid} is the cloudflared of port ${sv.port}'s temporary address: end that cloudflared by hand.` };
  if (now !== true) {
    fs.rmSync(serviceFile(), { force: true });
    return { ok: true, stopped: false };
  }
  try { process.kill(sv.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 20 && alive(sv.pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive(sv.pid) && (await mineNow(sv)) === true) try { process.kill(sv.pid, 'SIGKILL'); } catch { /* gone */ }
  const ok = mine(sv) !== true;
  if (ok) fs.rmSync(serviceFile(), { force: true });
  return { ok, stopped: ok };
}

export async function stopService() {
  const { ok, error } = await stopIt(readJson(serviceFile()));
  return error ? { ok, error } : { ok };
}

/** The second temporary address while it runs: { port, url }, else null. */
export function serviceStatus() {
  const sv = readJson(serviceFile());
  return sv && sv.url && seen(sv) !== false ? { port: sv.port, url: sv.url } : null;
}

/** A machine token was revoked (`gone(id)`): stop the second temporary address when that token started it. */
export async function closeServiceOpenedBy(gone) {
  const sv = readJson(serviceFile());
  if (!(sv && seen(sv) !== false && gone(sv.openedBy))) return [];
  const r = await stopIt(sv);
  if (r.error) return [{ by: sv.openedBy, say: (who) => `The temporary address of port ${sv.port} that ${who} started could not be stopped after its token was revoked. ${r.error}` }];
  if (!r.stopped) return [];
  return [{ by: sv.openedBy, say: (who) => `The temporary address of port ${sv.port} that ${who} started was stopped: its token was revoked` }];
}

/** The Temporary kind's extra steps (POST /api/public-link/temporary/<name>). */
export const temporarySteps = {
  'add-service': (b, o) => startService(b, o),
  'remove-service': () => stopService(),
};
