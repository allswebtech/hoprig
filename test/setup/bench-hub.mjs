#!/usr/bin/env node
// The small-server proof for a hub: how much memory and CPU one hub needs while it relays other computers.
// Not a unit test (node --test does not pick it up): run it by hand on a Linux box, it reads /proc.
//
//   node test/setup/bench-hub.mjs --root /tmp/bench [--pcs 20] [--heaps 0,64,48,32,24,16] [--window 20]
//
// What it does, all with the real `hoprig serve` and the real direct link, in scratch folders under --root:
//   1. one hub (HOPRIG_HUB=1: no terminals, no terminal module) on its own port; measures it idle
//   2. --pcs dashboards ("PCs", pty backend, /bin/sh) on their own ports, joined to the hub one by one with a
//      one-time code (POST /api/links/code on the hub, POST /api/joins { url, code, insecure } on the PC);
//      measures the hub at 1, 5 and all PCs linked
//   3. on every PC a shell that prints one 80-byte line every 50 ms (a steady ~1.6 KB/s at most), then M = 1, 5, 20
//      browser terminals opened THROUGH THE HUB (/m/<machine>/ws/term), counting the bytes that arrive
//   4. for each --heaps value (MB, 0 = Node's default): the hub restarted with --max-old-space-size, the PCs
//      reconnect by themselves, all terminals reattached; it "works" when every terminal keeps receiving data,
//      /healthz answers 200 and the process is alive for the whole window
//   5. the same dashboard NOT in hub mode, idle, for comparison
// Measured: the hub process only. RSS = VmRSS, peak = VmHWM (/proc/<pid>/status); CPU % = (utime+stime) ticks over
// the window (/proc/<pid>/stat), as a share of one core.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(APP, 'bin', 'hoprig.mjs');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ROOT = path.resolve(arg('root', '/tmp/hoprig-bench'));
const PCS = Number(arg('pcs', '20'));
const HEAPS = arg('heaps', '0,64,48,32,24,16').split(',').map(Number);
const WINDOW_S = Number(arg('window', '20'));
const BASE_PORT = Number(arg('port', '17610'));
const PASSWORD = 'bench-password-1234';
const TICKS = 100; // USER_HZ on Linux
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const procs = [];

// ---------------------------------------------------------------- processes
function dirsFor(name, server, extra = {}) {
  const d = path.join(ROOT, name);
  const cfg = path.join(d, 'config');
  fs.mkdirSync(cfg, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(d, 'state'), { recursive: true });
  fs.mkdirSync(path.join(d, 'work'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ ...extra, server: { roots: [path.join(d, 'work')], ...server } }));
  fs.writeFileSync(path.join(d, 'pw.txt'), PASSWORD + '\n', { mode: 0o600 });
  return d;
}

function start(name, { port, hub = false, heapMb = 0, server = {}, extra = {} }) {
  const d = fs.existsSync(path.join(ROOT, name)) ? path.join(ROOT, name) : dirsFor(name, { port, ...server }, extra);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    SHELL: '/bin/sh',
    HOPRIG_CONFIG_DIR: path.join(d, 'config'),
    HOPRIG_STATE_DIR: path.join(d, 'state'),
    CLAUDE_CONFIG_DIR: path.join(d, 'claude'),
    HOPRIG_PASSWORD_FILE: path.join(d, 'pw.txt'),
    PORT: String(port),
    ...(hub ? { HOPRIG_HUB: '1' } : {}),
  };
  const node = heapMb ? [`--max-old-space-size=${heapMb}`] : [];
  const out = fs.openSync(path.join(d, 'serve.log'), 'a');
  const child = spawn(process.execPath, [...node, BIN, 'serve'], { env, cwd: d, stdio: ['ignore', out, out] });
  const p = { name, port, child, pid: child.pid, exited: null };
  child.on('exit', (code, sig) => (p.exited = sig || code));
  procs.push(p);
  return p;
}

const kill = async (p) => {
  if (p.exited !== null) return;
  try {
    process.kill(p.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 50 && p.exited === null; i++) await sleep(100);
  if (p.exited === null) process.kill(p.pid, 'SIGKILL');
};

// ---------------------------------------------------------------- http
function req(port, method, p, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, timeout: 20_000, headers: {
      Origin: `http://127.0.0.1:${port}`,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: 0, json: null, text: e.message, headers: {} }));
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealthy(port, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await req(port, 'GET', '/healthz')).status === 200) return true;
    await sleep(250);
  }
  return false;
}

async function login(port) {
  const r = await req(port, 'POST', '/api/login', { body: { password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login on ${port}: ${r.status} ${r.text}`);
  return String(r.headers['set-cookie'][0]).split(';')[0];
}

// ---------------------------------------------------------------- measuring
function sample(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(status) || [])[1] || 0);
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { rss: kb('VmRSS') / 1024, hwm: kb('VmHWM') / 1024, ticks: Number(f[11]) + Number(f[12]) };
}

/** Measure the hub over the window; `check` runs every second (healthz, terminals). */
async function measure(hub, label, { terms = [], check } = {}) {
  const a = sample(hub.pid);
  const t0 = Date.now();
  const bytes0 = terms.reduce((s, t) => s + t.bytes, 0);
  let healthOk = true;
  let rssMax = a.rss;
  for (let i = 0; i < WINDOW_S; i++) {
    await sleep(1000);
    if (hub.exited !== null) break;
    const s = sample(hub.pid);
    rssMax = Math.max(rssMax, s.rss);
    if (i % 5 === 4 && (await req(hub.port, 'GET', '/healthz')).status !== 200) healthOk = false;
    if (check) await check(i);
  }
  const alive = hub.exited === null;
  const b = alive ? sample(hub.pid) : a;
  const secs = (Date.now() - t0) / 1000;
  const bytes = terms.reduce((s, t) => s + t.bytes, 0) - bytes0;
  const row = {
    case: label,
    rssMB: b.rss.toFixed(1),
    peakMB: b.hwm.toFixed(1),
    cpuPct: ((100 * (b.ticks - a.ticks)) / TICKS / secs).toFixed(1),
    termKBs: terms.length ? (bytes / 1024 / secs).toFixed(1) : '',
    perTermKBs: terms.length ? (bytes / 1024 / secs / terms.length).toFixed(2) : '',
    allTermsFlowing: terms.length ? terms.every((t) => t.lastAt > Date.now() - 5000) : '',
    healthz: healthOk,
    alive,
  };
  log(JSON.stringify(row));
  return row;
}

// ---------------------------------------------------------------- terminals through the hub
function openTerm(hubPort, cookie, machine, session) {
  const t = { bytes: 0, lastAt: 0, open: false, closed: false, ws: null };
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/m/${machine}/ws/term?name=${encodeURIComponent(session)}&cols=120&rows=40`, {
    headers: { Cookie: cookie, Origin: `http://127.0.0.1:${hubPort}` },
  });
  t.ws = ws;
  ws.on('open', () => (t.open = true));
  ws.on('message', (d) => {
    t.bytes += d.length;
    t.lastAt = Date.now();
  });
  ws.on('close', () => (t.closed = true));
  ws.on('error', () => (t.closed = true));
  return t;
}

async function machinesOnline(hubPort, cookie) {
  const r = await req(hubPort, 'GET', '/api/machines?fresh=1', { cookie });
  return (r.json && r.json.machines) || [];
}

async function waitAllOnline(hubPort, cookie, n, ms = 90_000) {
  const end = Date.now() + ms;
  let list = [];
  while (Date.now() < end) {
    list = await machinesOnline(hubPort, cookie);
    if (list.filter((m) => m.state === 'online').length >= n) return list;
    await sleep(1000);
  }
  throw new Error(`only ${list.filter((m) => m.state === 'online').length}/${n} computers online`);
}

// The steady output: one 80-byte line every 50 ms.
const LOOP = `while :; do echo "$(date +%H:%M:%S.%N) hoprig hub bench: the quick brown fox jumps over"; sleep 0.05; done`;

// ---------------------------------------------------------------- main
async function main() {
  if (process.platform !== 'linux') throw new Error('this measures through /proc: run it on Linux');
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const rows = [];
  const HUB_PORT = BASE_PORT;

  log(`hub on ${HUB_PORT}, ${PCS} PCs from ${HUB_PORT + 1}, window ${WINDOW_S}s, root ${ROOT}`);
  let hub = start('hub', { port: HUB_PORT, hub: true, heapMb: 0, extra: { hubOnly: true } });
  if (!(await waitHealthy(HUB_PORT))) throw new Error('hub did not start');
  await sleep(3000);
  rows.push(await measure(hub, 'idle (no PCs)'));
  let hubCookie = await login(HUB_PORT);

  // PCs, all started at once.
  const pcs = [];
  for (let i = 1; i <= PCS; i++) pcs.push(start(`pc${i}`, { port: HUB_PORT + i, server: { backend: 'pty', machineLabel: `pc${i}` } }));
  for (const pc of pcs) if (!(await waitHealthy(pc.port, 60_000))) throw new Error(`${pc.name} did not start`);
  for (const pc of pcs) pc.cookie = await login(pc.port);
  log(`${PCS} PCs up`);

  for (let i = 0; i < pcs.length; i++) {
    const code = await req(HUB_PORT, 'POST', '/api/links/code', { body: {}, cookie: hubCookie });
    if (code.status !== 200) throw new Error(`code: ${code.status} ${code.text}`);
    const j = await req(pcs[i].port, 'POST', '/api/joins', { body: { url: `http://127.0.0.1:${HUB_PORT}`, code: code.json.code, insecure: true }, cookie: pcs[i].cookie });
    if (j.status !== 200) throw new Error(`join ${pcs[i].name}: ${j.status} ${j.text}`);
    const n = i + 1;
    if (n === 1 || n === 5 || n === PCS) {
      await waitAllOnline(HUB_PORT, hubCookie, n);
      await sleep(3000);
      rows.push(await measure(hub, `N=${n} linked PCs, no terminal`));
    }
  }

  // A busy shell on every PC (nothing reaches the hub until a terminal is opened through it).
  for (const pc of pcs) {
    const s = await req(pc.port, 'POST', '/api/shells', { body: {}, cookie: pc.cookie });
    if (s.status !== 200) throw new Error(`shell on ${pc.name}: ${s.status} ${s.text}`);
    pc.session = s.json.name;
  }
  await sleep(1500);
  for (const pc of pcs) {
    const r = await req(pc.port, 'POST', `/api/sessions/${encodeURIComponent(pc.session)}/send`, { body: { text: LOOP }, cookie: pc.cookie });
    if (r.status !== 200) throw new Error(`send on ${pc.name}: ${r.status} ${r.text}`);
  }
  const byLabel = async () => Object.fromEntries((await machinesOnline(HUB_PORT, hubCookie)).map((m) => [m.label, m.name]));
  let names = await byLabel();

  let terms = [];
  const openFor = (k) => {
    for (let i = terms.length; i < k; i++) terms.push(openTerm(HUB_PORT, hubCookie, names[pcs[i % pcs.length].name], pcs[i % pcs.length].session));
  };
  for (const m of [1, 5, 20]) {
    openFor(m);
    await sleep(3000);
    rows.push(await measure(hub, `N=${PCS}, M=${m} terminals with output`, { terms }));
  }

  // The lowest heap that still works: the hub restarted with each cap; PCs reconnect by themselves.
  const heapRows = [];
  for (const heap of HEAPS) {
    for (const t of terms) t.ws.terminate();
    terms = [];
    await kill(hub);
    hub = start('hub', { port: HUB_PORT, hub: true, heapMb: heap });
    const up = await waitHealthy(HUB_PORT, 30_000);
    if (!up) {
      heapRows.push({ case: `heap ${heap || 'default'} MB`, alive: false, note: 'did not start' });
      log(`heap ${heap}: did not start`);
      continue;
    }
    try {
      hubCookie = await login(HUB_PORT);
      await waitAllOnline(HUB_PORT, hubCookie, PCS);
      names = await byLabel();
      openFor(20);
      await sleep(4000);
      const row = await measure(hub, `heap ${heap || 'default'} MB, N=${PCS}, M=20`, { terms });
      row.works = row.alive && row.healthz && row.allTermsFlowing === true && terms.every((t) => !t.closed);
      heapRows.push(row);
    } catch (e) {
      heapRows.push({ case: `heap ${heap || 'default'} MB`, alive: hub.exited === null, works: false, note: e.message });
      log(`heap ${heap}: ${e.message}`);
    }
  }
  for (const t of terms) t.ws.terminate();
  await kill(hub);

  // The same dashboard in normal mode (terminal module loaded), idle.
  const normal = start('normal', { port: HUB_PORT + 100, server: { backend: 'pty', tmuxSocket: 'hoprig-bench' } });
  if (await waitHealthy(normal.port)) {
    await sleep(3000);
    rows.push(await measure(normal, 'normal mode (not a hub), idle'));
  }
  await kill(normal);

  console.log('\n=== hub measurements ===');
  console.table(rows);
  console.log('\n=== heap caps (N=20, M=20) ===');
  console.table(heapRows);
  fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify({ rows, heapRows }, null, 2));
}

const cleanup = async () => {
  for (const p of procs) await kill(p);
};
process.on('SIGINT', () => cleanup().then(() => process.exit(130)));
main().then(cleanup, async (e) => {
  console.error('bench failed:', e.message);
  await cleanup();
  process.exitCode = 1;
});
