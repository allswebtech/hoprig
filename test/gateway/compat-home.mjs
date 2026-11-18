// A home as Hoprig 0.2.6 leaves it, with its gateway add-on set up, and everything a user of that gateway does with
// it: the add-on commands, the dashboard's routes, and what ends up on disk. Not a test itself: it prints one JSON
// answer for the Hoprig at <root>, so the same steps can be run on 0.2.6 (the answer is kept in
// test/fixtures/gateway-0.2.6.json) and on this version (test/gateway/compat.test.mjs compares the two).
//
//   node test/gateway/compat-home.mjs <root of a Hoprig checkout>
//
// The gateway is a stand-in program in the home's own folder; npm is a stand-in that only writes down what it was
// asked. Everything that differs between two runs (folders, ports, process ids, keys, times) is replaced by a name.
// Pid files of every kind 0.2.6 may leave are met on the way: an old plain number naming an unrelated process, a
// JSON one whose process has ended and whose pid another process has now, and one 0.2.6 wrote when it started the
// gateway (written here in 0.2.6's own form, so a stop by this version after an update is the case). A second computer
// (a stand-in that answers as a linked one) is joined for the list of every computer's gateways.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-compat-')));
const dirs = Object.fromEntries(['config', 'state', 'profiles', 'claude', 'workspace', 'gh', 'bin'].map((d) => [d, path.join(home, d)]));
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const ID = 'trouteai'; // today's gateway, by its id: the one this home was set up with

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = await freePort();
const KEY = 'gw-key-0123456789';

// The stand-in gateway: its version, Claude's model list for its own key, a page at /.
fs.writeFileSync(path.join(dirs.bin, ID), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('Gateway 9.8.7'); process.exit(0); }
require('node:fs').appendFileSync(${JSON.stringify(path.join(home, 'gateway-args.txt'))}, process.argv.slice(2).join(' ') + '\\n');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:http').createServer((q, s) => {
  if (q.url.startsWith('/v1/models')) {
    const ok = q.headers.authorization === 'Bearer ${KEY}' || q.headers['x-api-key'] === '${KEY}';
    s.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    return s.end(ok ? JSON.stringify({ data: [{ id: 'combo-best', type: 'model' }] }) : '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}');
  }
  s.end('ok');
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });
// The stand-in npm: writes down its arguments.
fs.writeFileSync(path.join(dirs.bin, 'npm'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(path.join(home, 'npm-calls.txt'))}, process.argv.slice(2).join(' ') + '\\n');
console.log('added 1 package');
`, { mode: 0o755 });

const env = {
  ...process.env,
  PATH: [dirs.bin, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  HOME: home,
  HOPRIG_CONFIG_DIR: dirs.config,
  HOPRIG_STATE_DIR: dirs.state,
  HOPRIG_PROFILES_DIR: dirs.profiles,
  CLAUDE_CONFIG_DIR: dirs.claude,
  HOPRIG_WORKSPACE_DIR: dirs.workspace,
  GH_CONFIG_DIR: dirs.gh,
};
for (const k of ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID', 'CLAUDECODE', 'OPENCODE']) delete env[k];
Object.assign(process.env, env);
for (const k of ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID', 'CLAUDECODE', 'OPENCODE']) delete process.env[k];

const bin = path.join(root, 'bin', 'hoprig.mjs');
const started = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pids = new Map();
/** One text with every value of this run replaced by a name. */
function plain(text) {
  let s = String(text).split(home).join('<HOME>').split(root).join('<ROOT>').split(process.execPath).join('<NODE>');
  s = s.replaceAll(String(PORT), '<PORT>').replaceAll(String(DASH), '<DASH>');
  if (otherPort) s = s.replaceAll(String(otherPort), '<OTHER>');
  s = s.replace(/hop_gw_[A-Za-z0-9_-]{43}/g, '<GWKEY>').split(os.hostname()).join('<HOST>');
  for (const [pid, name] of pids) s = s.replace(new RegExp(`\\b${pid}\\b`, 'g'), name);
  return s;
}
const plainJson = (v) => JSON.parse(plain(JSON.stringify(v)));
const DASH = await freePort();
let otherPort = null;

async function run(...args) {
  const c = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  c.stdout.on('data', (d) => (stdout += d));
  c.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => c.on('close', r));
  return plainJson({ args: args.join(' '), code, stdout, stderr });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidFile = path.join(dirs.state, 'addons', `${ID}.pid`);
const { system } = await import(pathToFileURL(path.join(root, 'src/procid.mjs')).href);
/** The pid file as 0.2.6 writes it: { pid, proc }, proc the process's identity (src/procid.mjs, as in 0.2.6). */
const pid026 = async (pid, proc) => {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const after = await system.refresh([pid]);
  fs.writeFileSync(pidFile, JSON.stringify({ pid, proc: proc === undefined ? system.of([pid], { after }).get(pid) || null : proc }), { mode: 0o600 });
};
/** A process that has nothing to do with the gateway: a pid file that names it must never end it. */
const unrelated = (name) => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
  started.push(c.pid);
  pids.set(c.pid, name);
  return c.pid;
};
const listening = (p) => new Promise((r) => { const s = net.connect(p, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
const until = async (fn, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true; return false; };

// ---- the home as 0.2.6 leaves it ----
const { hashPassword } = await import(pathToFileURL(path.join(root, 'src/server/auth.mjs')).href);
fs.writeFileSync(path.join(dirs.config, 'config.json'), JSON.stringify({
  addons: { [ID]: { port: PORT } },
  server: { passwordHash: await hashPassword('right-password'), port: DASH, backend: 'pty' },
}, null, 2), { mode: 0o600 });
// The provider `hoprig addons setup` wrote (its PRERUN starts the gateway on demand).
fs.writeFileSync(path.join(dirs.profiles, 'api.env'), [
  'LABEL="API via TRouteAI"',
  `PRERUN="${process.execPath} ${bin} addons start ${ID}"`,
  `ANTHROPIC_BASE_URL=http://localhost:${PORT}`,
  `ANTHROPIC_AUTH_TOKEN=${KEY}`,
  '',
].join('\n'), { mode: 0o600 });
// A gateway that runs on the port, started outside Hoprig (no pid file).
const outside = spawn(path.join(dirs.bin, ID), ['--port', String(PORT)], { env, stdio: 'ignore', detached: true });
started.push(outside.pid);
pids.set(outside.pid, '<PID-OUTSIDE>');
await until(() => listening(PORT));

const out = { commands: [], routes: {}, disk: {} };
// The list of add-ons: the gateway's lines and the ids (the public link's state depends on the computer).
const gatewayLines = (r) => ({ ...r, stdout: r.stdout.split('\n').filter((l, i, all) => all.slice(0, i + 1).reverse().find((x) => !x.startsWith('  ')).startsWith(`${ID} `)).join('\n'), ids: r.stdout.split('\n').filter((l) => l && !l.startsWith('  ')).map((l) => l.split(' ')[0]) });
const step = async (...a) => out.commands.push(a.length === 1 ? gatewayLines(await run(...a)) : await run(...a));
try {
  await step('addons');
  await step('addons', 'status', ID);
  await step('addons', 'start', ID); // runs already: nothing on stdout or stderr
  await step('addons', 'start', 'nope');

  // ---- the dashboard's routes ----
  const { createServer } = await import(pathToFileURL(path.join(root, 'src/server/server.mjs')).href);
  const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
  const app = createServer({ backend, watch: false, dashboardFile: false });
  await app.listen(DASH, '127.0.0.1');
  const base = `http://127.0.0.1:${DASH}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (p, body, headers = { Origin: base, Cookie: cookie }) => {
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text: json ? undefined : text };
  };
  // The gateway's entry and the order of the ids (the public link's own state depends on the computer).
  const addons = await call('/api/addons');
  out.routes.addons = { status: addons.status, ids: addons.json.addons.map((a) => a.id), gateway: addons.json.addons.find((a) => a.id === ID) };
  out.routes.accounts = await call('/api/accounts');
  out.routes.gateways = await call('/api/gateways');
  out.routes.share = await call(`/api/gateways/${ID}/share`, { on: true });
  const made = await call(`/api/gateways/${ID}/keys`, { name: 'laptop' });
  const gwKey = made.json && made.json.key;
  if (made.json && made.json.keyId) pids.set(made.json.keyId, '<KEYID>');
  out.routes.keys = made;
  const bearer = { authorization: `Bearer ${gwKey}` };
  out.routes.status = await call(`/gateway/${ID}/__status`, undefined, bearer);
  out.routes.models = await call(`/gateway/${ID}/v1/models`, undefined, bearer);
  // A second computer, joined: a stand-in that answers as a linked one does, with one gateway of its own.
  const other = net.createServer();
  const OTHER = await new Promise((r) => other.listen(0, '127.0.0.1', () => r(other.address().port)));
  other.close();
  const box2 = (await import('node:http')).createServer((q, s) => {
    s.writeHead(q.url === '/api/gateways' && q.headers.authorization === 'Bearer hop_box2token' ? 200 : 404, { 'content-type': 'application/json' });
    s.end(q.url === '/api/gateways' ? JSON.stringify({ computer: 'box2', gateways: [{ id: 'relay', title: 'Relay', installed: true, running: true, version: '1.0.0', shared: true, ready: true }] }) : '{}');
  });
  await new Promise((r) => box2.listen(OTHER, '127.0.0.1', r));
  otherPort = OTHER;
  fs.writeFileSync(path.join(dirs.config, 'machines.json'), JSON.stringify({ machines: [{ name: 'box2', label: 'Box 2', via: 'url', url: `http://127.0.0.1:${OTHER}`, token: 'hop_box2token', tokenId: 'box2id', added: 1 }] }), { mode: 0o600 });
  out.routes.all = await call('/api/gateways/all');
  fs.rmSync(path.join(dirs.config, 'machines.json'));
  await new Promise((r) => box2.close(r));
  const probe = await call('/api/accounts/probe', { baseUrl: `http://localhost:${PORT}`, key: KEY });
  out.routes.probe = { ...probe, json: probe.json && { ...probe.json, probe: '<PROBE>' } };
  out.routes.save = await call('/api/accounts/save', { probe: probe.json.probe, via: ID, name: '', label: '', model: 'combo-best' });
  out.routes.after = await call('/api/accounts');
  out.routes.job = await call(`/api/addons/${ID}/job`);
  await app.close();

  // ---- start, stop, install, update, setup ----
  // An old pid file (a plain number) that names an unrelated process: the stop ends the gateway, never that process.
  const plainPid = unrelated('<PID-UNRELATED-1>');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${plainPid}\n`);
  await step('addons', 'stop', ID); // the one started outside Hoprig: what listens on the port is the gateway
  await until(async () => !(await listening(PORT)));
  out.disk.plainPidFile = { gatewayStopped: !(await listening(PORT)), unrelatedAlive: alive(plainPid) };
  await step('addons', 'start', ID);
  const rec = JSON.parse(fs.readFileSync(path.join(dirs.state, 'addons', `${ID}.pid`), 'utf8'));
  pids.set(rec.pid, '<PID-STARTED>');
  started.push(rec.pid);
  out.disk.pidFile = Object.keys(rec).sort();
  await step('addons', 'status', ID);
  await step('addons', 'install', ID);
  await step('addons', 'update', ID);
  const again = JSON.parse(fs.readFileSync(path.join(dirs.state, 'addons', `${ID}.pid`), 'utf8'));
  pids.set(again.pid, '<PID-UPDATED>');
  started.push(again.pid);
  await step('addons', 'stop', ID);
  await step('addons', 'stop', ID);
  await step('addons', 'setup', ID); // no terminal: installed, started, and the words for the terminal
  const third = JSON.parse(fs.readFileSync(path.join(dirs.state, 'addons', `${ID}.pid`), 'utf8'));
  pids.set(third.pid, '<PID-SETUP>');
  started.push(third.pid);
  await step('addons', 'stop', ID);

  // A gateway 0.2.6 started (its pid file in 0.2.6's form), then Hoprig updated: this version's status and stop.
  const before026 = spawn(path.join(dirs.bin, ID), ['--port', String(PORT)], { env, stdio: 'ignore', detached: true });
  started.push(before026.pid);
  pids.set(before026.pid, '<PID-026>');
  await until(() => listening(PORT));
  await pid026(before026.pid);
  await step('addons', 'status', ID);
  await step('addons', 'stop', ID);
  await until(async () => !alive(before026.pid) || !(await listening(PORT)));
  out.disk.startedBy026 = { portClosed: !(await listening(PORT)) };
  // A pid file of 0.2.6's form whose process ended and whose pid an unrelated process has now (its identity differs):
  // a start with it on disk, and a stop with it on disk while the gateway runs, leave that process alone.
  const stalePid = unrelated('<PID-UNRELATED-2>');
  const real = (await (async () => { const after = await system.refresh([stalePid]); return system.of([stalePid], { after }).get(stalePid); })()) || 'T:0';
  const stale = () => pid026(stalePid, real.replace(/(\d+)$/, (n) => String(Number(n) - 100000)));
  await stale();
  await step('addons', 'start', ID);
  const fourth = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  pids.set(fourth.pid, '<PID-FOURTH>');
  started.push(fourth.pid);
  await stale();
  await step('addons', 'stop', ID);
  await until(async () => !(await listening(PORT)));
  out.disk.stalePidFile = { unrelatedAlive: alive(stalePid), portClosed: !(await listening(PORT)) };

  // ---- on disk ----
  // What the gateway was started with, each time (the first one by this home's own start, outside Hoprig).
  out.disk.gatewayArgs = fs.readFileSync(path.join(home, 'gateway-args.txt'), 'utf8').trim().split('\n');
  out.disk.npm = fs.readFileSync(path.join(home, 'npm-calls.txt'), 'utf8').trim().split('\n');
  out.disk.addons = fs.readdirSync(path.join(dirs.state, 'addons')).sort();
  out.disk.log = plain(fs.readFileSync(path.join(dirs.state, 'addons', `${ID}.log`), 'utf8'));
  out.disk.profiles = Object.fromEntries(fs.readdirSync(dirs.profiles).sort().map((f) => [f, plain(fs.readFileSync(path.join(dirs.profiles, f), 'utf8'))]));
  const cfg = JSON.parse(fs.readFileSync(path.join(dirs.config, 'config.json'), 'utf8'));
  cfg.server.passwordHash = '<HASH>';
  if (cfg.server.passwordCheck) cfg.server.passwordCheck.tag = '<TAG>';
  for (const k of (cfg.gateways && cfg.gateways.keys) || []) Object.assign(k, { id: '<KEYID>', hash: '<KEYHASH>', created: '<TIME>' });
  out.disk.config = cfg;
} finally {
  for (const pid of started) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(home, { recursive: true, force: true });
}
// Numbers that are ports become text first, so the names stay valid JSON.
const text = plain(JSON.stringify(out, (k, v) => (v === PORT || v === DASH ? String(v) : v), 2)).replace(/"(created|at|updatedAt)": \d{10,}/g, '"$1": "<TIME>"');
process.stdout.write(`${text}\n`);
process.exit(0);
