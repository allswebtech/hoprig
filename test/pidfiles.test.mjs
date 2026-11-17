// State files that name a process by its pid, which outlive the process and a restart of the computer: the second
// temporary address (publiclink.mjs), the gateway's pid file (trouteai.mjs), dashboard.json, the coding tools' holds
// and the switch's record as reach.mjs and `hoprig public` read it. A pid handed out again belongs to another program:
// it must never get a signal, nor be said to run. Real processes in an isolated state folder: a "stranger" (a child
// of this test that is none of ours) under a recorded pid, and stand-ins started the way the product starts its own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { earlierIdentity, sandbox } from './server/helpers.mjs';

const box = sandbox('pidfiles');
const bin = path.join(box.root, 'bin');
fs.mkdirSync(bin);
// A stand-in cloudflared: the lines the real one prints, then it waits. A node script, so its command line stays
// "… cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>", as the real one's. Started by this Node itself,
// not through /usr/bin/env: while env starts node, the command line reads empty for a moment, and a check that falls
// into that moment takes the tunnel for another program (seen once in a whole suite).
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!${process.execPath}
console.error('INF |  https://pid-' + process.pid + '-words.trycloudflare.com  |');
console.error('INF Registered tunnel connection connIndex=0');
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
// A stand-in gateway: listens on the port it is given.
fs.writeFileSync(path.join(bin, 'trouteai'), `#!/usr/bin/env node
const i = process.argv.indexOf('--port');
require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[i + 1]), '127.0.0.1');
`, { mode: 0o755 });
// A wrapper that starts the gateway and stays (as a .cmd shim or a shell would): the gateway's parent.
fs.writeFileSync(path.join(box.root, 'wrapper.cjs'), `require('node:child_process').spawn(process.argv[2], process.argv.slice(3), { stdio: 'ignore' });
setInterval(() => {}, 1 << 30);
`);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const GATEWAY_PORT = 7972;
// The stand-ins are scripts started by their "#!" line, and a tunnel's command line, the fact that shows an older file's
// tunnel is ours, is not read on Windows (linkmigrate.mjs): those tests run elsewhere.
const POSIX = { skip: process.platform === 'win32' };
const SERVICE_PORT = 7975;

const { saveConfig } = await import('../src/config.mjs');
saveConfig({ addons: { trouteai: { port: GATEWAY_PORT } }, server: { port: 7971 } });
const { alive, sameProcess, system } = await import('../src/procid.mjs');
const P = await import('../src/addons/publiclink.mjs');
const { findAddon } = await import('../src/addons/index.mjs');
const { linkRecordFile, writeAtomic } = await import('../src/addons/cloudflared.mjs');
const { dashboardFile, runningDashboard, writeDashboardFile, removeDashboardFile } = await import('../src/server/dashboardfile.mjs');
const { serverDir, serverUsers } = await import('../src/codetools/servers.mjs');
const { reachable } = await import('../src/addons/reach.mjs');
const { ours } = await import('../src/addons/linkmigrate.mjs');
const cli = await import('../src/addons/publiccli.mjs');
const T = findAddon('trouteai');

const started = [];
test.after(() => {
  for (const c of started) try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ }
  box.cleanup();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true; return !!(await fn()); };
const dead = (pid) => until(() => !alive(pid));

/** A child of this test that is none of ours: a plain node process. */
function stranger() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  started.push(c);
  return c.pid;
}
/** A stand-in cloudflared started as Hoprig starts it (tunnelArgv), once its command line is the tunnel's (until the
 * "#!" line has run, it is still this test's). */
async function tunnel(port = SERVICE_PORT) {
  const c = spawn(path.join(bin, 'cloudflared'), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: 'ignore' });
  started.push(c);
  assert.ok(await until(() => ours(c.pid)), 'the stand-in cloudflared runs');
  return c.pid;
}
function spawned(argv) {
  const c = spawn(argv[0], argv.slice(1), { stdio: 'ignore' });
  started.push(c);
  return c.pid;
}
const identity = (pid) => system.of([pid]).get(pid);
/** The identity of a process that had `pid` before: the same pid, another start. */
function earlier(pid) {
  const id = identity(pid);
  assert.ok(id, 'this system tells a process\'s identity');
  return earlierIdentity(id);
}
/** Make `file` look written before this boot (and before the 10 minutes a clock may be corrected by). */
function beforeBoot(file) {
  const t = new Date(Date.now() - os.uptime() * 1000 - 3_600_000);
  fs.utimesSync(file, t, t);
}
const write = (file, data) => writeAtomic(file, typeof data === 'string' ? data : JSON.stringify(data));

// ---- 1. the second temporary address (publiclink.mjs) ----
const serviceFile = () => path.join(box.state, 'addons', 'public-link-service.json');
const look = async () => ({ status: 401, headers: new Headers(), text: async () => '<form>password</form>' });
const addService = () => P.temporarySteps['add-service']({ port: SERVICE_PORT, confirmed: true }, { notify: async () => ({ sent: false }), fetchImpl: look, waitMs: 10_000 });

test('the second temporary address: a pid of another program now is not said to run and gets no signal', POSIX, async () => {
  for (const rec of [
    (pid) => ({ pid, proc: earlier(pid) }), // written with an identity: another process has its pid now
    (pid) => ({ pid }), // written before identities, in this boot: its command line is not a tunnel of ours
  ]) {
    const pid = stranger();
    write(serviceFile(), { ...rec(pid), url: 'https://old-words.trycloudflare.com', port: SERVICE_PORT, openedBy: 'tok' });
    assert.equal(P.serviceStatus(), null, 'not running');
    assert.deepEqual(await P.closeServiceOpenedBy(() => true), [], 'nothing of the revoked token runs');
    assert.equal((await P.stopService()).ok, true);
    assert.ok(alive(pid), 'the other program got no signal');
    assert.ok(!fs.existsSync(serviceFile()), 'the stale file is gone');
  }
  // A refused start because of a stale file would leave the owner stuck.
  const pid = stranger();
  write(serviceFile(), { pid, proc: earlier(pid), url: 'https://old-words.trycloudflare.com', port: SERVICE_PORT });
  const r = await addService();
  assert.equal(r.ok, true, r.error);
  assert.ok(alive(pid));
  await P.stopService();
});

test('the second temporary address of ours: found running and stopped; a file from before identities still works in this boot, not after a restart', POSIX, async () => {
  const r = await addService();
  assert.equal(r.ok, true, r.error);
  const rec = JSON.parse(fs.readFileSync(serviceFile(), 'utf8'));
  started.push({ pid: rec.pid });
  assert.equal(rec.proc, identity(rec.pid), 'the file carries the identity read when it was started');
  assert.deepEqual(P.serviceStatus(), { port: SERVICE_PORT, url: r.url });
  assert.match((await addService()).error, /stop it first/);
  assert.equal((await P.stopService()).ok, true);
  assert.ok(await dead(rec.pid), 'stopped');
  assert.equal(P.serviceStatus(), null);

  // As an older version wrote it (no identity), its tunnel still running: still found, still stopped.
  let pid = await tunnel();
  write(serviceFile(), { pid, url: 'https://kept-words.trycloudflare.com', port: SERVICE_PORT, openedBy: 'tok' });
  assert.deepEqual(P.serviceStatus(), { port: SERVICE_PORT, url: 'https://kept-words.trycloudflare.com' });
  assert.equal((await P.closeServiceOpenedBy((id) => id === 'tok')).length, 1);
  assert.ok(await dead(pid), 'stopped');
  // The same from before this boot: not found, removed, nothing signalled (even a tunnel of ours: not the one it named).
  pid = await tunnel();
  write(serviceFile(), { pid, url: 'https://kept-words.trycloudflare.com', port: SERVICE_PORT });
  beforeBoot(serviceFile());
  assert.equal(P.serviceStatus(), null);
  assert.equal((await P.stopService()).ok, true);
  assert.ok(alive(pid), 'no signal');
  assert.ok(!fs.existsSync(serviceFile()));
});

/** Run `fn` as on a system where a process's command line cannot be read (Windows: linkmigrate.mjs reads none). */
async function commandLineUnread(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

test('the second temporary address that cannot be told from another program: no signal, the file kept, the caller told', POSIX, async () => {
  // A file of an older version (no identity) of this boot, where the command line cannot be read: it may be our
  // tunnel, open to everyone, or another program under its pid.
  const pid = stranger();
  write(serviceFile(), { pid, url: 'https://unsure-words.trycloudflare.com', port: SERVICE_PORT, openedBy: 'tok' });
  await commandLineUnread(async () => {
    assert.deepEqual(P.serviceStatus(), { port: SERVICE_PORT, url: 'https://unsure-words.trycloudflare.com' }, 'it may run');
    const r = await P.stopService();
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot tell .* end that cloudflared by hand/);
    assert.ok(fs.existsSync(serviceFile()), 'the file stays while it may be ours');
    const said = await P.closeServiceOpenedBy((id) => id === 'tok');
    assert.equal(said.length, 1, 'a revoked token: the owner is told');
    assert.match(said[0].say('the phone'), /could not be stopped/);
    assert.deepEqual(P.serviceStatus(), { port: SERVICE_PORT, url: 'https://unsure-words.trycloudflare.com' }, 'status and stop agree');
  });
  assert.ok(alive(pid), 'no signal');
  // Once that process has ended, the file goes.
  process.kill(pid, 'SIGKILL');
  assert.ok(await dead(pid));
  assert.equal((await commandLineUnread(() => P.stopService())).ok, true);
  assert.ok(!fs.existsSync(serviceFile()));
});

test('the second temporary address of an older file: a tunnel of ours to another port (the switch\'s own) is not it', POSIX, async () => {
  const pid = await tunnel(7971); // the main Temporary address leads to the dashboard's port
  write(serviceFile(), { pid, url: 'https://old-words.trycloudflare.com', port: SERVICE_PORT, openedBy: 'tok' });
  assert.equal(P.serviceStatus(), null);
  assert.equal((await P.stopService()).ok, true);
  await sleep(300);
  assert.ok(alive(pid), 'the main public link got no signal');
  assert.ok(!fs.existsSync(serviceFile()));
});

test('status of an older file on macOS: the dashboard does not wait for ps to read a command line', POSIX, async () => {
  // A stand-in ps that only notes it was run; the identities on this system come from /proc, so ps is asked only
  // for a command line (linkmigrate.mjs).
  const psDir = path.join(box.root, 'ps-bin');
  const asked = path.join(box.root, 'ps-asked');
  fs.mkdirSync(psDir, { recursive: true });
  fs.writeFileSync(path.join(psDir, 'ps'), `#!/bin/sh\necho "$@" >> '${asked}'\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  saveConfig({ publicLink: { on: true, kind: 'temporary' } });
  const svc = await tunnel();
  const sw = await tunnel(7971);
  write(serviceFile(), { pid: svc, url: 'https://kept-words.trycloudflare.com', port: SERVICE_PORT });
  write(linkRecordFile(), { kind: 'temporary', url: 'https://live-words.trycloudflare.com', connected: true, pid: sw });
  process.env.PATH = `${psDir}${path.delimiter}${saved}`;
  Object.defineProperty(process, 'platform', { ...real, value: 'darwin' });
  try {
    assert.ok(P.serviceStatus(), 'cannot be told without ps: it may run');
    assert.equal(reachable().via, 'temporary');
  } finally {
    Object.defineProperty(process, 'platform', real);
    process.env.PATH = saved;
  }
  assert.ok(!fs.existsSync(asked), 'ps was not run on the way of a request');
  fs.rmSync(serviceFile());
  saveConfig({ publicLink: { on: false, kind: 'temporary' } });
});

// ---- 2. the gateway's pid file (trouteai.mjs) ----
const gatewayPidFile = () => path.join(box.state, 'addons', 'trouteai.pid');
const listening = () => T.status().then((s) => s.running);

test('the gateway: stop ends what listens on its port, never another program under the file\'s pid', POSIX, async () => {
  for (const content of [(pid) => String(pid), (pid) => JSON.stringify({ pid, proc: earlier(pid) })]) {
    const gw = spawned([path.join(bin, 'trouteai'), '--port', String(GATEWAY_PORT)]);
    assert.ok(await until(listening), 'the stand-in gateway listens');
    const pid = stranger();
    write(gatewayPidFile(), content(pid));
    assert.equal((await T.stop()).ok, true);
    assert.ok(await dead(gw), 'the gateway stopped');
    assert.ok(alive(pid), 'the other program got no signal');
    assert.ok(!fs.existsSync(gatewayPidFile()));
  }
});

test('the gateway: where the process on its port cannot be found, a file without an identity shows nothing and gets no signal', POSIX, async () => {
  const none = path.join(box.root, 'nothing');
  fs.mkdirSync(none, { recursive: true });
  for (const content of [(pid) => String(pid), (pid) => JSON.stringify({ pid, proc: null })]) {
    const gw = spawned([path.join(bin, 'trouteai'), '--port', String(GATEWAY_PORT)]);
    assert.ok(await until(listening), 'the stand-in gateway listens');
    const pid = stranger();
    write(gatewayPidFile(), content(pid));
    const saved = process.env.PATH;
    process.env.PATH = none; // neither lsof nor ss: what listens on the port is not known
    let r;
    try {
      r = await T.stop();
    } finally {
      process.env.PATH = saved;
    }
    assert.equal(r.ok, false, 'the gateway still runs, and the caller is told');
    assert.ok(alive(pid), 'the other program got no signal');
    assert.ok(await listening(), 'nothing of ours was found to stop');
    process.kill(gw, 'SIGKILL');
    assert.ok(await dead(gw));
    assert.ok(await until(async () => !(await listening())));
  }
});

test('the gateway of ours: started, its identity in the file, stopped; an old file of its parent still works in this boot, not after a restart', POSIX, async () => {
  const s = await T.start();
  assert.equal(s.ok, true, s.error);
  const rec = JSON.parse(fs.readFileSync(gatewayPidFile(), 'utf8'));
  started.push({ pid: rec.pid });
  assert.equal(rec.proc, identity(rec.pid));
  assert.equal((await T.stop()).ok, true);
  assert.ok(await dead(rec.pid));

  // A file from before identities that names a wrapper whose child listens (a .cmd shim, a shell): both end.
  let wrapper = spawned([process.execPath, path.join(box.root, 'wrapper.cjs'), path.join(bin, 'trouteai'), '--port', String(GATEWAY_PORT)]);
  assert.ok(await until(listening));
  write(gatewayPidFile(), String(wrapper));
  assert.equal((await T.stop()).ok, true);
  assert.ok(await dead(wrapper), 'the wrapper, shown to be the gateway\'s parent, got the signal too');
  // The same file from before this boot: only what listens ends.
  wrapper = spawned([process.execPath, path.join(box.root, 'wrapper.cjs'), path.join(bin, 'trouteai'), '--port', String(GATEWAY_PORT)]);
  assert.ok(await until(listening));
  write(gatewayPidFile(), String(wrapper));
  beforeBoot(gatewayPidFile());
  assert.equal((await T.stop()).ok, true);
  assert.equal(await listening(), false);
  await sleep(300);
  assert.ok(alive(wrapper), 'no signal through a file from before this boot');
});

// ---- 3. dashboard.json ----
test('dashboard.json: another program under its pid is no running dashboard; this one is', () => {
  const pid = stranger();
  write(dashboardFile(), { pid, proc: earlier(pid), host: '127.0.0.1', port: 7979, at: Date.now() });
  assert.equal(runningDashboard(), null, 'written with an identity: another process has its pid now');
  write(dashboardFile(), { pid, host: '127.0.0.1', port: 7979, at: Date.now() });
  beforeBoot(dashboardFile());
  assert.equal(runningDashboard(), null, 'written before identities and before this boot');
  // Before identities, in this boot: nothing can tell (no fact about a dashboard can be read here), so it counts.
  write(dashboardFile(), { pid, host: '127.0.0.1', port: 7979, at: Date.now() });
  assert.deepEqual(runningDashboard(), { pid, host: '127.0.0.1', port: 7979 });
  writeDashboardFile({ host: '127.0.0.1', port: 7978 });
  assert.equal(JSON.parse(fs.readFileSync(dashboardFile(), 'utf8')).proc, system.self());
  assert.deepEqual(runningDashboard(), { pid: process.pid, host: '127.0.0.1', port: 7978 });
  removeDashboardFile();
});

// ---- 4. the holds on a coding tool's server ----
const holdOf = (pid) => path.join(serverDir(), `opencode-held-${pid}`);
const users = () => serverUsers('opencode', { runs: [] }).map((u) => u.runId);

test('a hold whose pid is another program now is no user of the server, and is removed', () => {
  fs.mkdirSync(serverDir(), { recursive: true });
  const pid = stranger();
  write(holdOf(pid), { pid, proc: earlier(pid) });
  assert.deepEqual(users(), []);
  assert.ok(!fs.existsSync(holdOf(pid)));
  write(holdOf(pid), String(pid)); // as before identities
  beforeBoot(holdOf(pid));
  assert.deepEqual(users(), []);
  assert.ok(!fs.existsSync(holdOf(pid)));
  write(holdOf(pid), String(pid)); // the same of this boot: kept, as nothing can tell (a server kept is safe)
  assert.deepEqual(users(), [`chat-${pid}`]);
  fs.rmSync(holdOf(pid));
});

test('a hold of another dashboard process of ours counts while it lives', async () => {
  const servers = new URL('../src/codetools/servers.mjs', import.meta.url).href;
  const c = spawn(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(servers)}); m.holdServer('opencode'); console.log('held'); setInterval(() => {}, 1 << 30);`], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  started.push(c);
  await new Promise((r) => c.stdout.once('data', r));
  // What the process wrote about itself and what the system says of its pid: one process (the same text only where
  // both read the kernel's own number).
  const own = JSON.parse(fs.readFileSync(holdOf(c.pid), 'utf8')).proc;
  assert.equal(sameProcess(own, identity(c.pid)), true, `${own} and ${identity(c.pid)}`);
  if (own.startsWith('L:')) assert.equal(own, identity(c.pid));
  assert.deepEqual(users(), [`chat-${c.pid}`]);
  c.kill('SIGKILL');
  assert.ok(await dead(c.pid));
  assert.deepEqual(users(), [], 'a dashboard that died hard holds nothing');
});

// ---- 5. the switch's record, as reach.mjs and `hoprig public` read it ----
const URL_NOW = 'https://live-words.trycloudflare.com';
const record = (rec) => write(linkRecordFile(), { kind: 'temporary', url: URL_NOW, connected: true, ...rec });

test('the Temporary address: not shown as live when its pid is another program now', POSIX, async () => {
  saveConfig({ publicLink: { on: true, kind: 'temporary' } });
  const pid = stranger();
  for (const rec of [{ pid, proc: earlier(pid) }, { pid }]) {
    record(rec);
    assert.deepEqual(reachable(), { url: null, via: null });
    assert.equal(cli.statusOf().url, null);
  }
  // `hoprig public off` with a dashboard running waits for the tunnel to end: not for another program.
  writeDashboardFile({ host: '127.0.0.1', port: 7978 });
  const t0 = Date.now();
  assert.equal(await cli.main(['off'], { out: () => {} }), 0);
  assert.ok(Date.now() - t0 < 5000, 'it did not wait for another program');
  removeDashboardFile();
  assert.ok(alive(pid));
});

test('the Temporary address of ours is live; a record from before identities in this boot too, not one from before it', POSIX, async () => {
  saveConfig({ publicLink: { on: true, kind: 'temporary' } });
  const pid = await tunnel(7971);
  record({ pid, proc: identity(pid) });
  assert.deepEqual(reachable(), { url: URL_NOW, via: 'temporary' });
  assert.equal(cli.statusOf().url, URL_NOW);
  record({ pid });
  assert.deepEqual(reachable(), { url: URL_NOW, via: 'temporary' }, 'its command line shows it');
  assert.equal(cli.statusOf().url, URL_NOW);
  beforeBoot(linkRecordFile());
  assert.deepEqual(reachable(), { url: null, via: null });
  assert.equal(cli.statusOf().url, null);
  saveConfig({ publicLink: { on: false, kind: 'temporary' } });
});

test('the switch\'s start ends its own leftover tunnel, never another tunnel of ours under an older record\'s pid', POSIX, async () => {
  saveConfig({ publicLink: { on: false, kind: 'temporary' } });
  fs.rmSync(serviceFile(), { force: true });
  const S = await import('../src/addons/linkswitch.mjs');
  const start = async (rec) => {
    record(rec);
    await S.attach({ notifyFn: async () => ({ sent: false }), everyMs: 60_000 });
    await S.resetForTests();
  };
  // The second temporary address's tunnel has a pid a record once named: another identity, or a record before this boot.
  const other = await tunnel(SERVICE_PORT);
  await start({ pid: other, proc: earlier(other) });
  record({ pid: other });
  beforeBoot(linkRecordFile());
  await S.attach({ notifyFn: async () => ({ sent: false }), everyMs: 60_000 });
  await S.resetForTests();
  await sleep(300);
  assert.ok(alive(other), 'another tunnel of ours got no signal');
  // A leftover of the switch's own: by its identity, and by its command line in a record of this boot (an older version's).
  for (const withId of [true, false]) {
    const own = await tunnel(7971);
    await start(withId ? { pid: own, proc: identity(own) } : { pid: own });
    assert.ok(await dead(own), `its leftover ended (${withId ? 'identity' : 'command line'})`);
  }
  assert.ok(alive(other));
});
