// A fixed address for the dashboard: a Cloudflare named tunnel, so the address (such as https://pc.example.com) stays
// the same, unlike the quick tunnel's (publiclink.mjs). It needs a free Cloudflare account with a domain on it.
//
// Set up from the page in three steps: sign in to Cloudflare (`cloudflared tunnel login` prints a link; the owner
// opens it in his browser, picks his domain and approves; cloudflared then fetches its certificate by itself), type
// the name, and Hoprig runs `tunnel create` and `tunnel route dns` (a CNAME record for that name). Advanced: a tunnel
// token pasted from the Cloudflare dashboard instead (`tunnel run --token-file`), for a tunnel made there.
//
// Every cloudflared file stays in Hoprig's state folder (addons/fixed-link/, mode 0700, files 0600), never in
// ~/.cloudflared: cloudflared runs with a HOME of its own there (where `tunnel login` writes cert.pem; checked with
// cloudflared 2026.10.1: it writes $HOME/.cloudflared/cert.pem and refuses when one exists), and every later command
// names its files itself (--origincert, --cred-file, --config), so no file of the computer's (/etc/cloudflared) is read.
//
// Once set up it runs with the dashboard: it starts when the dashboard starts and again when it ends (waiting 2 s,
// then twice as long each time, at most 5 min), until the owner turns it off. While it is on, the settings change as
// for the quick tunnel (cloudflared.mjs: trustProxy, the allowed origin), and like it, it needs the dashboard password.
//
// What Cloudflare's documentation says (read 15 Nov 2026), and so what the page says on "Stop using it":
//   - "If a tunnel stops, the DNS record is not deleted — visitors will see a 1016 error." "The DNS record and the
//     tunnel are independent." (routing-to-tunnel/dns, "Last updated Apr 17, 2026")
//   - cloudflared has `tunnel route dns` to add a record and no command to remove one; `tunnel delete` "will delete
//     tunnels with the given tunnel UUIDs or names" (its --help). So Hoprig deletes the tunnel and says the record
//     stays, to be deleted in Cloudflare.
// One more local service (such as TRouteAI's own dashboard) can be reached through the same tunnel under a second
// name: one more ingress rule and DNS record.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { hostName } from '../paths.mjs';
import { capture } from '../setup/system.mjs';
import { alive, cloudflaredEnv, dashboardPort, findBin, fixedDir, fixedStateFile, hasPassword, patchFor, quickRestore, readFixed, restoreFor, writeAtomic } from './cloudflared.mjs';
import { checkPort, exposureQuestion, serviceLogin } from './localservice.mjs';

const homeDir = () => path.join(fixedDir(), 'home');
const emptyDir = () => path.join(fixedDir(), 'empty');
export const certFile = () => path.join(homeDir(), '.cloudflared', 'cert.pem');
const credsFile = () => path.join(fixedDir(), 'tunnel.json');
const configFile = () => path.join(fixedDir(), 'config.yml');
const tokenFile = () => path.join(fixedDir(), 'token');
const baseFile = () => path.join(fixedDir(), 'base.yml');
const files = () => ({ cert: certFile(), base: baseFile() });
const LOGIN_MAX_MS = 15 * 60_000;

// ---------- pure parts (tested) ----------

/**
 * The command lines. Names and addresses come validated; every one is an array. `f`: our files { cert, base } (base:
 * a config of ours with nothing in it, so no config.yml of the computer's, such as /etc/cloudflared's, is read).
 */
export const loginArgv = (bin, f) => [bin, 'tunnel', '--config', f.base, 'login'];
const withCert = (bin, f) => [bin, 'tunnel', '--config', f.base, '--origincert', f.cert];
export const createArgv = (bin, f, creds, name) => [...withCert(bin, f), 'create', '--cred-file', creds, name];
/** For a tunnel of that name made before: writes its credentials file (cloudflared's own advice in `token --help`). */
export const credsOfArgv = (bin, f, creds, name) => [...withCert(bin, f), 'token', '--cred-file', creds, name];
export const routeArgv = (bin, f, id, hostname) => [...withCert(bin, f), 'route', 'dns', id, hostname];
export const deleteArgv = (bin, f, id) => [...withCert(bin, f), 'delete', '-f', id];
export const runArgv = (bin, config, id) => [bin, 'tunnel', '--no-autoupdate', '--config', config, 'run', id];
export const runTokenArgv = (bin, config, token) => [bin, 'tunnel', '--no-autoupdate', '--config', config, 'run', '--token-file', token];
/** The base config: cloudflared refuses an empty file, so it holds one harmless line. */
export const BASE_CONFIG = '# Written by Hoprig: so that cloudflared reads no other config file.\nno-autoupdate: true\n';

/** "pc.example.com" from what the owner typed, or an Error with a plain message. */
export function cleanHostname(v) {
  const h = String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (!h) throw new Error('Type the address, such as pc.example.com.');
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (h.length > 253 || !new RegExp(`^(?:${label}\\.)+${label}$`).test(h) || /^\d+(\.\d+)*$/.test(h)) {
    throw new Error(`"${h.slice(0, 80)}" is not an address like pc.example.com.`);
  }
  if (/(^|\.)(trycloudflare\.com|cfargotunnel\.com)$/.test(h)) throw new Error('Use a name under your own domain.');
  return h;
}

/** The first part of the computer's name, as a DNS label: the suggested name. */
export function suggestName(host = hostName()) {
  return String(host).split('.')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'my-computer';
}

/** The tunnel's name in the owner's Cloudflare account: says who made it and for what. */
export const tunnelName = (hostname) => `hoprig-${hostname.replace(/[^a-z0-9-]/g, '-')}`.slice(0, 100);

/** The sign-in link `tunnel login` prints, or null. Only an https address at cloudflare.com is taken. */
export function parseLoginUrl(text) {
  for (const m of String(text).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const u = new URL(m[0]);
      if (u.hostname === 'dash.cloudflare.com' || u.hostname.endsWith('.cloudflare.com')) return m[0];
    } catch {
      /* not an address */
    }
  }
  return null;
}

/** `tunnel create` output: "Created tunnel <name> with id <uuid>". */
export function parseCreated(text) {
  const m = /Created tunnel (\S+) with id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(text));
  return m ? { name: m[1], id: m[2].toLowerCase() } : null;
}

/** `tunnel route dns` output: { added } | { already } | { taken } (another record has that name) | null. */
export function parseRoute(text) {
  const t = String(text);
  let m = /Added CNAME (\S+) which will route to this tunnel/.exec(t);
  if (m) return { added: m[1].replace(/\.$/, '').toLowerCase() };
  m = /(\S+) is already configured to route to your tunnel/.exec(t);
  if (m) return { already: m[1].replace(/\.$/, '').toLowerCase() };
  if (/record with that host already exists|already exists/i.test(t)) return { taken: true };
  return null;
}

/**
 * A tunnel token from the Cloudflare dashboard: the token alone, or the whole command shown there
 * ("cloudflared service install eyJ…"). It is base64 JSON { a: account, t: tunnel id, s: secret }.
 */
export function parseToken(text) {
  const m = /eyJ[A-Za-z0-9+/_=-]{20,}/.exec(String(text ?? ''));
  const bad = new Error('That is not a tunnel token. In the Cloudflare dashboard, open your tunnel and copy the install command: it holds the token (it starts with "eyJ").');
  if (!m) throw bad;
  let j;
  try {
    j = JSON.parse(Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    throw bad;
  }
  if (!j || typeof j.a !== 'string' || typeof j.t !== 'string' || typeof j.s !== 'string') throw bad;
  return { token: m[0], tunnelId: j.t };
}

/** The tunnel's config: the dashboard first, then each other service, then nothing (404). Values as JSON strings. */
export function configYaml({ tunnelId, creds, hostname, port, extra = [] }) {
  const q = JSON.stringify;
  const rules = [{ hostname, port }, ...extra].map((r) => `  - hostname: ${q(r.hostname)}\n    service: ${q(`http://127.0.0.1:${r.port}`)}\n`).join('');
  return `# Written by Hoprig for the fixed address; it is written again at each start.\ntunnel: ${q(tunnelId)}\ncredentials-file: ${q(creds)}\ningress:\n${rules}  - service: "http_status:404"\n`;
}

/** How long to wait before start number `failures + 1`: 2 s, then twice as long, at most 5 minutes. */
export const backoffMs = (failures) => Math.min(2000 * 2 ** Math.max(0, failures), 5 * 60_000);
/** A run this long counts as working: the next end starts the waiting from 2 s again. */
export const STABLE_MS = 60_000;

/**
 * Keeps one program running: started again when it ends, with backoff, until stop(). Its output says whether the
 * tunnel is connected and the last error. spawnFn / timers / now: for tests.
 */
export function makeSupervisor({ spawnFn = spawn, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, onPid = () => {} } = {}) {
  let want = null;
  let child = null;
  let timer = null;
  let failures = 0;
  let startedAt = 0;
  const s = { running: false, connected: false, restarts: 0, nextTryAt: null, error: null, lines: [] };

  const line = (l) => {
    s.lines.push(l);
    if (s.lines.length > 40) s.lines.shift();
    if (/Registered tunnel connection/.test(l)) {
      s.connected = true;
      s.error = null;
    } else if (/\s(ERR|FTL)\s/.test(l)) s.error = l.replace(/^\S+\s+(ERR|FTL)\s+/, '').slice(0, 300);
  };
  const feed = (stream) => {
    if (!stream) return;
    let rest = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (d) => {
      rest += d;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop();
      parts.forEach(line);
    });
  };
  function retry() {
    const wait = backoffMs(failures++);
    s.restarts++;
    s.nextTryAt = now() + wait;
    timer = setTimer(launch, wait);
    timer?.unref?.();
  }
  function ended(c) {
    if (child !== c) return;
    child = null;
    s.running = false;
    s.connected = false;
    if (!want) return;
    if (now() - startedAt >= STABLE_MS) failures = 0;
    retry();
  }
  function launch() {
    timer = null;
    s.nextTryAt = null;
    let c;
    try {
      c = spawnFn(want.argv[0], want.argv.slice(1), { env: want.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      s.error = e.message;
      retry();
      return;
    }
    child = c;
    startedAt = now();
    s.running = true;
    onPid(c.pid);
    feed(c.stdout);
    feed(c.stderr);
    c.on('error', (e) => {
      s.error = e.message;
      ended(c); // a program that could not start may never send 'exit'
    });
    c.on('exit', () => ended(c));
  }
  function stop() {
    want = null;
    if (timer) clearTimer(timer);
    timer = null;
    s.nextTryAt = null;
    s.running = false;
    s.connected = false;
    const c = child;
    child = null;
    if (!c) return Promise.resolve();
    return new Promise((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve();
      const hard = setTimeout(() => {
        try { c.kill('SIGKILL'); } catch { /* gone */ }
        resolve();
      }, 5000);
      hard.unref?.();
      c.once('exit', () => {
        clearTimeout(hard);
        resolve();
      });
      try { c.kill('SIGTERM'); } catch { resolve(); }
    });
  }
  return {
    run(argv, env) {
      stop();
      want = { argv, env };
      failures = 0;
      s.restarts = 0;
      s.error = null;
      s.lines = [];
      launch();
    },
    stop,
    state: () => ({ ...s, lines: [...s.lines] }),
  };
}

// ---------- the add-on's part ----------

const writeState = (st) => writeAtomic(fixedStateFile(), JSON.stringify(st));
const fail = (error) => ({ ok: false, error });
const env = () => cloudflaredEnv(homeDir(), emptyDir());

function prepare() {
  for (const d of [fixedDir(), homeDir(), emptyDir()]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  writeAtomic(baseFile(), BASE_CONFIG);
}

/**
 * A cloudflared command with a time limit. Its log lines (stderr) go to onLine; stdout only with `show`, because
 * `tunnel token` prints a secret there.
 */
async function cf(argv, onLine, { show = true } = {}) {
  const r = await capture(argv, { env: env(), timeout: 90_000, cwd: fixedDir() });
  const text = `${show ? r.stdout : ''}\n${r.stderr}`;
  for (const l of text.split('\n')) if (l.trim()) onLine(l);
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || r.error || '';
  return { ok: r.ok, text, last: last.replace(/^\S+\s+(ERR|INF|WRN)\s+/, '') };
}

const credsTunnelId = () => {
  try {
    const id = JSON.parse(fs.readFileSync(credsFile(), 'utf8')).TunnelID;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
};

// The sign-in in progress (one at a time) and the last one that failed.
let login = null;
let loginError = null;
let sup = null;
let runnerError = null;
const supervisor = () => (sup ||= makeSupervisor({ onPid: (pid) => writeState({ ...(readFixed() || {}), pid }) }));

/** Step 1: start `tunnel login` and answer with the link the owner opens. cloudflared waits for the approval. */
async function signIn({ again = false } = {}, { waitMs = 30_000 } = {}) {
  const bin = findBin();
  if (!bin) return fail('cloudflared is not installed: press Install first.');
  if (readFixed()?.mode) return fail('The fixed address is set up already.');
  if (login && login.child && login.url) return { ok: true, url: login.url };
  if (again) fs.rmSync(certFile(), { force: true });
  if (fs.existsSync(certFile())) return { ok: true, already: true };
  prepare();
  loginError = null;
  const child = spawn(bin, loginArgv(bin, files()).slice(1), { env: env(), cwd: fixedDir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const cur = { child, url: null, text: '' };
  login = cur;
  const take = (d) => {
    cur.text = (cur.text + d).slice(-20_000);
    cur.url ||= parseLoginUrl(cur.text);
  };
  child.stdout.setEncoding('utf8').on('data', take);
  child.stderr.setEncoding('utf8').on('data', take);
  const limit = setTimeout(() => child.kill('SIGTERM'), LOGIN_MAX_MS);
  limit.unref();
  const done = (why) => {
    clearTimeout(limit);
    if (login === cur) login = null;
    if (fs.existsSync(certFile())) {
      fs.chmodSync(certFile(), 0o600);
      loginError = null;
    } else if (why !== 'cancel') {
      const last = cur.text.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('https://')).pop();
      loginError = why === 'error' ? 'cloudflared did not start.' : `The sign-in did not finish${last ? `: ${last.replace(/^\S+\s+(ERR|INF)\s+/, '')}` : '.'} Try again.`;
    }
  };
  child.on('error', () => done('error'));
  child.on('exit', () => done(cur.cancelled ? 'cancel' : 'exit'));
  for (let t = 0; t < waitMs && !cur.url && login === cur; t += 250) await new Promise((r) => setTimeout(r, 250));
  if (cur.url) return { ok: true, url: cur.url };
  if (login === cur) {
    cur.cancelled = true;
    child.kill('SIGTERM');
  }
  return fail(loginError || 'cloudflared printed no sign-in link. Try again.');
}

function cancelSignIn() {
  if (login && login.child) {
    login.cancelled = true;
    login.child.kill('SIGTERM');
  }
  login = null;
  return { ok: true };
}

/** Step 2: make the tunnel and its DNS record for `hostname`, then turn it on. */
async function create({ hostname } = {}, { onLine = () => {}, by = null } = {}) {
  let host;
  try {
    host = cleanHostname(hostname);
  } catch (e) {
    return fail(e.message);
  }
  const bin = findBin();
  if (!bin) return fail('cloudflared is not installed: press Install first.');
  if (!hasPassword()) return fail('Set a dashboard password first (Settings → Security): the address leads to the sign-in page.');
  if (!fs.existsSync(certFile())) return fail('Sign in to Cloudflare first.');
  if (readFixed()?.mode) return fail('The fixed address is set up already.');
  const name = tunnelName(host);
  prepare();
  fs.rmSync(credsFile(), { force: true });
  onLine(`Making the tunnel "${name}" in your Cloudflare account…`);
  let r = await cf(createArgv(bin, files(), credsFile(), name), onLine);
  if (!r.ok && /already exists/i.test(r.text)) {
    onLine(`A tunnel named "${name}" is there already (made before): using it.`);
    r = await cf(credsOfArgv(bin, files(), credsFile(), name), onLine, { show: false });
  }
  const id = credsTunnelId() || (parseCreated(r.text) || {}).id;
  if (!r.ok || !id || !fs.existsSync(credsFile())) return fail(`cloudflared could not make the tunnel: ${r.last}`);
  fs.chmodSync(credsFile(), 0o600);
  onLine(`Pointing ${host} to it…`);
  const d = await cf(routeArgv(bin, files(), id, host), onLine);
  const route = parseRoute(d.text);
  const made = route && (route.added || route.already);
  if (!d.ok || !made || made !== host) {
    // Nothing half-made stays behind: the tunnel made a moment ago goes again.
    await cf(deleteArgv(bin, files(), id), () => {});
    fs.rmSync(credsFile(), { force: true });
    if (route && route.taken) return fail(`There is already a DNS record for ${host} in Cloudflare. Pick another name, or delete that record in Cloudflare first.`);
    if (made && made !== host) return fail(`Cloudflare made the record ${made} instead: ${host} is not under the domain you picked when you signed in. Delete ${made} in Cloudflare (DNS → Records), then use a name under that domain, or sign in again for the other domain.`);
    return fail(`cloudflared could not point ${host} to the tunnel: ${d.last}`);
  }
  writeState({ mode: 'named', hostname: host, tunnelId: id, tunnelName: name, extra: [], enabled: false });
  onLine(`Done: https://${host}`);
  return turnOn(by);
}

/** Advanced: a tunnel made in the Cloudflare dashboard, run with its token. Its names are set there. */
function useToken({ token, hostname } = {}, { by = null } = {}) {
  let t;
  let host;
  try {
    t = parseToken(token);
    host = cleanHostname(hostname);
  } catch (e) {
    return fail(e.message);
  }
  if (!findBin()) return fail('cloudflared is not installed: press Install first.');
  if (!hasPassword()) return fail('Set a dashboard password first (Settings → Security): the address leads to the sign-in page.');
  if (readFixed()?.mode) return fail('The fixed address is set up already.');
  prepare();
  writeAtomic(tokenFile(), t.token);
  writeState({ mode: 'token', hostname: host, tunnelId: t.tunnelId, extra: [], enabled: false });
  return turnOn(by);
}

/** The config file for this start (the dashboard's port as it is now), then the run. */
function startRunner() {
  const st = readFixed();
  const bin = findBin();
  runnerError = null;
  if (!st || !st.mode) return;
  if (!bin) {
    runnerError = 'cloudflared is not installed: press Install.';
    return;
  }
  if (!hasPassword()) {
    runnerError = 'The dashboard has no password, so the fixed address does not start.';
    return;
  }
  const yml = st.mode === 'token'
    ? '# Written by Hoprig: a tunnel run by its token; its names are set in the Cloudflare dashboard.\nno-autoupdate: true\n'
    : configYaml({ tunnelId: st.tunnelId, creds: credsFile(), hostname: st.hostname, port: dashboardPort(), extra: st.extra || [] });
  writeAtomic(configFile(), yml);
  supervisor().run(st.mode === 'token' ? runTokenArgv(bin, configFile(), tokenFile()) : runArgv(bin, configFile(), st.tunnelId), env());
}

/**
 * Turn it on: the settings change, then it runs (now and at each start of the dashboard). `by`: the id of the
 * machine token that turned it on (a linked hub), null for the owner; one that is on already keeps its opener.
 */
function turnOn(by = null) {
  const st = readFixed();
  if (!st || !st.mode) return fail('The fixed address is not set up.');
  if (!hasPassword()) return fail('Set a dashboard password first (Settings → Security): the address leads to the sign-in page.');
  if (!st.enabled) {
    const { patch, restore } = patchFor(loadConfig().server, `https://${st.hostname}`, { inherit: quickRestore() });
    saveConfig(patch);
    writeState({ ...st, enabled: true, restore, restored: false, openedBy: by || null });
  }
  startRunner();
  return runnerError ? fail(runnerError) : { ok: true, url: `https://${st.hostname}` };
}

/** Turn it off: it stops, the settings go back. The tunnel and its address stay for the next time. */
async function turnOff() {
  if (sup) await sup.stop();
  killLeftover();
  const st = readFixed();
  if (st && st.enabled) {
    if (st.restore && !st.restored) saveConfig(restoreFor(loadConfig().server, st.restore, { keepTrust: !!quickRestore() }));
    writeState({ ...st, enabled: false, restored: true, pid: null, openedBy: null });
  }
  return { ok: true };
}

/** "Stop using it": off, the tunnel deleted in Cloudflare when cloudflared can, and every file of it removed here. */
async function forget(_body, { onLine = () => {} } = {}) {
  cancelSignIn();
  await turnOff();
  const st = readFixed() || {};
  const bin = findBin();
  if (st.mode === 'named' && st.tunnelId && bin && fs.existsSync(certFile())) {
    prepare();
    const r = await cf(deleteArgv(bin, files(), st.tunnelId), onLine);
    onLine(r.ok ? `Deleted the tunnel "${st.tunnelName || st.tunnelId}" in your Cloudflare account.`
      : `Cloudflare could not delete the tunnel "${st.tunnelName || st.tunnelId}" (${r.last}). Delete it in the Cloudflare dashboard under Tunnels.`);
  }
  const hosts = [st.hostname, ...(st.extra || []).map((x) => x.hostname)].filter(Boolean);
  if (st.mode === 'named' && hosts.length) {
    onLine(`The DNS record${hosts.length > 1 ? 's' : ''} for ${hosts.join(', ')} stay${hosts.length > 1 ? '' : 's'} in Cloudflare: cloudflared cannot remove DNS records. Delete ${hosts.length > 1 ? 'them' : 'it'} under your domain → DNS → Records; until then the address shows a Cloudflare error page.`);
  }
  if (st.mode === 'token') onLine('The tunnel and its address stay in your Cloudflare dashboard: delete them there under Tunnels if you no longer need them.');
  fs.rmSync(fixedDir(), { recursive: true, force: true });
  onLine('The sign-in to Cloudflare and every file of the fixed address are removed from this computer.');
  return { ok: true };
}

/** One more local service under its own name on the same tunnel. Without its own sign-in, only after a confirm. */
async function addService({ port, hostname, confirmed } = {}, { onLine = () => {}, fetchImpl, by = null } = {}) {
  const st = readFixed();
  if (!st || st.mode !== 'named') return fail(st && st.mode === 'token' ? 'With a tunnel token, add the name in the Cloudflare dashboard (your tunnel → Public hostnames).' : 'Set up the fixed address first.');
  const p = checkPort(port, dashboardPort());
  if (p.error) return fail(p.error);
  let host;
  try {
    host = cleanHostname(hostname);
  } catch (e) {
    return fail(e.message);
  }
  if (host === st.hostname || (st.extra || []).some((x) => x.hostname === host)) return fail(`${host} is in use already.`);
  if ((st.extra || []).length >= 5) return fail('At most 5 other services.');
  const look = await serviceLogin(p.port, { fetchImpl });
  if (!look.answers) return fail(`Nothing answers on port ${p.port} on this computer. Start that service first.`);
  const question = exposureQuestion(p.port, look);
  if (question && confirmed !== true) return { ok: false, confirm: question };
  const bin = findBin();
  if (!bin || !fs.existsSync(certFile())) return fail('cloudflared or its sign-in is missing: stop using the fixed address and set it up again.');
  prepare();
  onLine(`Pointing ${host} to the tunnel…`);
  const d = await cf(routeArgv(bin, files(), st.tunnelId, host), onLine);
  const route = parseRoute(d.text);
  const made = route && (route.added || route.already);
  if (route && route.taken) return fail(`There is already a DNS record for ${host} in Cloudflare. Pick another name, or delete that record in Cloudflare first.`);
  if (!d.ok || !made) return fail(`cloudflared could not point ${host} to the tunnel: ${d.last}`);
  if (made !== host) return fail(`Cloudflare made the record ${made} instead: use a name under the same domain as ${st.hostname}. Delete ${made} in Cloudflare (DNS → Records).`);
  writeState({ ...readFixed(), extra: [...(st.extra || []), { hostname: host, port: p.port, ...(by ? { openedBy: by } : {}) }] });
  if (readFixed().enabled) startRunner();
  return { ok: true, url: `https://${host}` };
}

async function removeService({ hostname } = {}, { onLine = () => {} } = {}) {
  const st = readFixed();
  if (!st || !(st.extra || []).some((x) => x.hostname === hostname)) return fail('There is no such service.');
  writeState({ ...st, extra: st.extra.filter((x) => x.hostname !== hostname) });
  if (st.enabled) startRunner();
  onLine(`${hostname} no longer leads here. Its DNS record stays in Cloudflare (cloudflared cannot remove it): delete it under your domain → DNS → Records.`);
  return { ok: true };
}

// A cloudflared of ours still running from before (the dashboard ended without stopping it): only a process whose
// command line names our folder is ended, never another program that got the same number.
function killLeftover() {
  const st = readFixed();
  if (!st || !st.pid || !alive(st.pid) || process.platform !== 'linux') return;
  try {
    if (!fs.readFileSync(`/proc/${st.pid}/cmdline`, 'utf8').includes(fixedDir())) return;
    process.kill(st.pid, 'SIGTERM');
  } catch {
    /* gone, or not ours to read */
  }
}

/**
 * A machine token was revoked: `gone(id)` is true for the id of a token that no longer exists. Turns off the fixed
 * address when such a token turned it on, and removes each service such a token added. What the owner turned on or
 * added is never touched. → [{ by, say(who) }], one per thing closed.
 */
export async function fixedCloseOpenedBy(gone) {
  const out = [];
  let st = readFixed();
  if (!st || !st.mode) return out;
  const extra = st.extra || [];
  const dropped = extra.filter((x) => gone(x.openedBy));
  if (dropped.length) {
    writeState({ ...st, extra: extra.filter((x) => !dropped.includes(x)) });
    for (const x of dropped) out.push({ by: x.openedBy, say: (who) => `The service ${x.hostname} that ${who} added to the fixed address was removed: its token was revoked` });
    st = readFixed();
    if (st.enabled && !gone(st.openedBy)) startRunner();
  }
  if (st.enabled && gone(st.openedBy)) {
    const by = st.openedBy;
    await turnOff();
    out.push({ by, say: (who) => `The fixed address ${who} turned on was turned off: its token was revoked` });
  }
  return out;
}

/** When the dashboard starts: run it if it is on. */
export function attach() {
  killLeftover();
  if (readFixed()?.enabled) startRunner();
}

/** When the dashboard stops. */
export async function detach() {
  cancelSignIn();
  if (sup) await sup.stop();
}

/** What the page shows. Never a token, a certificate or a file path. */
export function fixedStatus() {
  const st = readFixed() || {};
  const r = sup ? sup.state() : null;
  return {
    state: st.mode ? 'ready' : login ? 'signing-in' : fs.existsSync(certFile()) ? 'signed-in' : 'none',
    loginUrl: !st.mode && login ? login.url : null,
    loginError: st.mode ? null : loginError,
    mode: st.mode || null,
    hostname: st.hostname || null,
    url: st.hostname ? `https://${st.hostname}` : null,
    enabled: !!st.enabled,
    running: !!(r && r.running),
    connected: !!(r && r.connected),
    nextTryAt: (r && r.nextTryAt) || null,
    restarts: (r && r.restarts) || 0,
    error: st.enabled ? runnerError || (r && r.error) || null : null,
    extra: (st.extra || []).map((x) => ({ hostname: x.hostname, port: x.port, url: `https://${x.hostname}` })),
    suggested: suggestName(),
    port: dashboardPort(),
  };
}

/** The page's actions (Settings → Add-ons → Public link): POST /api/addons/public-link/do/<name>. */
export const fixedActions = {
  'fixed-sign-in': (b) => signIn(b),
  'fixed-cancel': () => cancelSignIn(),
  'fixed-create': (b, o) => create(b, o),
  'fixed-token': (b, o) => useToken(b, o),
  'fixed-on': (b, o) => turnOn(o && o.by),
  'fixed-off': () => turnOff(),
  'fixed-forget': (b, o) => forget(b, o),
  'fixed-add-service': (b, o) => addService(b, o),
  'fixed-remove-service': (b, o) => removeService(b, o),
};

/** For tests: forget the in-process state (the supervisor, a sign-in). */
export async function resetForTests() {
  await detach();
  sup = null;
  loginError = null;
  runnerError = null;
}
