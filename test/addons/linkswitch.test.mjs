// The one Public link switch (src/addons/linkswitch.mjs) against a stand-in cloudflared that prints what the real
// 2026.10.1 prints: Temporary on (its address from the output, the settings while it runs, the push), a crash and a
// new address, off with the settings exactly back, a restart of the dashboard that brings it back, the switch to
// Custom (the other kind stops first), and what refuses a turn-on (no strong password, Custom not set up).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-linkswitch-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
const LOG = path.join(tmp, 'calls.jsonl');
const COUNT = path.join(tmp, 'count');
const ID = '00000000-0000-4000-8000-00000000c0de';
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
// Each quick tunnel run gets a new address (run-1-…, run-2-…), as Cloudflare gives a new one at each start.
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ a, home: process.env.HOME, path: process.env.PATH, keys: Object.keys(process.env) }) + '\\n');
if (a[0] === '--version') { console.log('cloudflared version 2026.10.1 (built 2026-10-15-1724 UTC)'); process.exit(0); }
process.on('SIGTERM', () => process.exit(0));
if (a.includes('--url')) {
  const n = (Number(fs.existsSync(${JSON.stringify(COUNT)}) ? fs.readFileSync(${JSON.stringify(COUNT)}, 'utf8') : 0) || 0) + 1;
  fs.writeFileSync(${JSON.stringify(COUNT)}, String(n));
  process.stderr.write('2026-11-14T04:52:38Z INF Requesting new quick Tunnel on trycloudflare.com...\\n');
  process.stderr.write('2026-11-14T04:52:43Z INF |  https://run-' + n + '-wonder-lucky.trycloudflare.com                                          |\\n');
  setTimeout(() => process.stderr.write('2026-11-14T04:52:45Z INF Registered tunnel connection connIndex=0 connection=0000aaaa event=0 ip=198.51.100.7 location=example01 protocol=quic\\n'), 100);
} else if (a.includes('run')) {
  process.stderr.write('2026-11-15T17:44:00Z INF Starting tunnel tunnelID=${ID}\\n');
  setTimeout(() => process.stderr.write('2026-11-15T17:44:01Z INF Registered tunnel connection connIndex=0\\n'), 100);
}
setInterval(() => {}, 1000);
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.ANTHROPIC_AUTH_TOKEN = 'must-not-reach-cloudflared';

const S = await import('../../src/addons/linkswitch.mjs');
const { install, installPlan } = await import('../../src/addons/publiclink.mjs');
// A missing cloudflared is downloaded (fetch is the test's): never Homebrew, which would install on the computer itself.
const installFn = (o) => install({ ...o, plan: installPlan({ hasBrew: false }) });
const { reachableUrl } = await import('../../src/addons/reach.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const choice = () => { const { on, kind } = loadConfig().publicLink || {}; return { on, kind }; };
const { hashTag } = await import('../../src/server/strength.mjs');
const raw = () => JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'config.json'), 'utf8'));
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  for (let t = 0; t < ms; t += 50) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}
const sent = [];
const notifyFn = async (url, what) => (sent.push([url, what]), { sent: true });
const HASH = 'scrypt$32768$8$1$c2FsdA$aGFzaA';
const strong = () => saveConfig({ server: { passwordHash: HASH, passwordCheck: { tag: hashTag(HASH), strong: true } } });

test.after(async () => {
  await S.resetForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a turn-on is refused in plain words without a strong password, and for Custom before it is set up', async () => {
  saveConfig({ server: { port: 7655, allowedOrigins: ['https://deck.example.net'] } });
  await S.attach({ installFn, notifyFn, everyMs: 60_000 });
  assert.deepEqual(S.status().state, 'off');
  assert.deepEqual([S.status().on, S.status().kind], [false, 'temporary'], 'off and Temporary by default');
  let r = await S.turnOn('temporary');
  assert.deepEqual([r.ok, r.need], [false, 'password']);
  saveConfig({ server: { passwordHash: HASH } });
  r = await S.turnOn('temporary');
  assert.deepEqual([r.ok, r.need], [false, 'check-password'], 'a password never judged is typed once');
  saveConfig({ server: { passwordCheck: { tag: hashTag(HASH), strong: false, why: 'it has fewer than 12 characters' } } });
  r = await S.turnOn('temporary');
  assert.deepEqual([r.ok, r.need], [false, 'stronger-password']);
  assert.match(r.error, /too weak for a public link: it has fewer than 12 characters/);
  saveConfig({ server: { passwordCheck: { tag: hashTag('scrypt$another'), strong: true } } });
  assert.equal((await S.turnOn('temporary')).need, 'check-password', 'a check of another password does not count');
  strong();
  r = await S.turnOn('custom');
  assert.deepEqual([r.ok, r.need], [false, 'custom-setup']);
  assert.equal((await S.turnOn('both')).ok, false);
  assert.equal(loadConfig().publicLink, undefined, 'nothing was switched');
  assert.equal(calls().length, 0, 'and nothing ran');
});

test('Temporary: on, its address from the output, the settings while it runs, the push; a crash brings a new address; off puts everything back', async () => {
  strong();
  const before = raw().server;
  const r = await S.turnOn('temporary');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(choice(), { on: true, kind: 'temporary' }, 'the choice is remembered');
  let s = await S.settled({ timeoutMs: 8000 });
  assert.deepEqual([s.state, s.url, s.error], ['on', 'https://run-1-wonder-lucky.trycloudflare.com', null]);
  assert.equal(s.installed, true);
  const run = calls().find((c) => c.a.includes('--url'));
  assert.deepEqual(run.a, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7655']);
  assert.equal(run.home, path.join(tmp, 'state', 'addons', 'quick', 'home'), 'a home of its own, never the owner\'s ~/.cloudflared');
  assert.ok(!run.keys.some((k) => /^ANTHROPIC_/.test(k)), 'no provider key reaches it');
  assert.equal(loadConfig().server.trustProxy, true);
  assert.deepEqual(loadConfig().server.allowedOrigins, ['https://deck.example.net', s.url]);
  assert.deepEqual(sent, [[s.url, 'this dashboard']], 'the new address is sent to the owner');
  assert.equal(reachableUrl(), s.url);
  assert.ok(!JSON.stringify(s).includes(HASH), 'no password hash in the state');

  // Turning on what is on changes nothing.
  assert.equal((await S.turnOn('temporary')).ok, true);
  await S.settled();
  assert.equal(calls().filter((c) => c.a.includes('--url')).length, 1);

  // cloudflared dies: it is started again by itself, gets a new address, and that one is taken and sent.
  process.kill(S.readRecord().pid, 'SIGKILL');
  assert.ok(await until(() => S.status().url === 'https://run-2-wonder-lucky.trycloudflare.com', 8000), JSON.stringify(S.status()));
  assert.deepEqual(loadConfig().server.allowedOrigins, ['https://deck.example.net', 'https://run-2-wonder-lucky.trycloudflare.com'], 'the old address is no longer allowed');
  assert.deepEqual(sent.at(-1), ['https://run-2-wonder-lucky.trycloudflare.com', 'this dashboard']);

  const off = await S.turnOff();
  assert.equal(off.state, 'off');
  assert.deepEqual(loadConfig().publicLink, { on: false, kind: 'temporary' });
  assert.deepEqual(raw().server, before, 'settings exactly as before');
  assert.equal(reachableUrl(), null);
});

test('the choice is remembered: a restart of the dashboard brings the link back with a new address, shown and sent', async () => {
  strong();
  const before = raw().server;
  assert.equal((await S.turnOn('temporary')).ok, true);
  const first = (await S.settled()).url;
  // The dashboard stops: the link stops with it and the settings go back, but it stays chosen.
  await S.detach();
  assert.deepEqual(raw().server, before);
  assert.deepEqual(choice(), { on: true, kind: 'temporary' });
  sent.length = 0;
  await S.attach({ installFn, notifyFn, everyMs: 60_000 });
  const s = await S.settled();
  assert.equal(s.state, 'on');
  assert.notEqual(s.url, first, 'a new address after the restart');
  assert.deepEqual(sent, [[s.url, 'this dashboard']]);
  await S.turnOff();
  assert.deepEqual(raw().server, before);
});

test('after a crash of the dashboard, its settings are put back before they are taken again: the owner\'s own stay his', async () => {
  strong();
  await S.detach();
  const before = raw().server;
  // What a dashboard that died while the link ran leaves: the settings changed, the owner's own in the record.
  const old = 'https://old-gone-words.trycloudflare.com';
  saveConfig({ publicLink: { on: true, kind: 'temporary' }, server: { trustProxy: true, allowedOrigins: [...before.allowedOrigins, old] } });
  fs.writeFileSync(S.recordFile(), JSON.stringify({ kind: 'temporary', url: old, pid: null, restore: { hadTrustProxy: false, hadOrigin: false, origin: old } }));
  assert.equal(reachableUrl(), null, 'an address whose cloudflared is gone is not offered');
  await S.attach({ installFn, notifyFn, everyMs: 60_000 });
  const s = await S.settled();
  assert.equal(s.state, 'on');
  assert.deepEqual(loadConfig().server.allowedOrigins, [...before.allowedOrigins, s.url], 'the old address is gone');
  await S.turnOff();
  assert.deepEqual(raw().server, before, 'exactly what the owner had, trustProxy absent as before');
});

test('the command line\'s choice is seen by the running dashboard', async () => {
  strong();
  await S.detach();
  await S.attach({ installFn, notifyFn, everyMs: 100 });
  saveConfig({ publicLink: { on: true, kind: 'temporary' } }); // what `hoprig public on` writes
  assert.ok(await until(() => S.status().state === 'on'), JSON.stringify(S.status()));
  saveConfig({ publicLink: { on: false, kind: 'temporary' } });
  assert.ok(await until(() => S.status().state === 'off' && !loadConfig().server.trustProxy));
  await S.detach();
  await S.attach({ installFn, notifyFn, everyMs: 60_000 });
});

test('Custom set up: turning it on stops the Temporary link first, so never both run', async () => {
  strong();
  const before = raw().server;
  const dir = path.join(tmp, 'state', 'addons', 'fixed-link');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixed.json'), JSON.stringify({ mode: 'named', hostname: 'office.example.com', tunnelId: ID, tunnelName: 'hoprig-office-example-com', extra: [] }));
  fs.writeFileSync(path.join(dir, 'tunnel.json'), '{}');
  assert.equal((await S.turnOn('temporary')).ok, true);
  const t = await S.settled();
  assert.equal(t.state, 'on');
  const tempPid = S.readRecord().pid;
  // Its identity beside its pid (procid.mjs), so that a pid handed out again is never taken for it (reach.mjs).
  const { system } = await import('../../src/procid.mjs');
  assert.ok(await until(() => S.readRecord().proc), 'the record carries its identity');
  assert.equal(S.readRecord().proc, system.of([tempPid]).get(tempPid));
  assert.equal((await S.turnOn('custom')).ok, true);
  const c = await S.settled();
  assert.deepEqual([c.kind, c.state, c.url], ['custom', 'on', 'https://office.example.com']);
  assert.ok(await until(() => { try { process.kill(tempPid, 0); return false; } catch { return true; } }), 'the Temporary cloudflared ended');
  assert.deepEqual(loadConfig().server.allowedOrigins, ['https://deck.example.net', 'https://office.example.com'], 'only the Custom address is allowed now');
  assert.equal(reachableUrl(), 'https://office.example.com');
  assert.equal(c.kinds.find((k) => k.id === 'custom').ready, true);
  await S.turnOff();
  assert.deepEqual(raw().server, before);
});

const runs = () => calls().filter((c) => c.a.includes('--url')).length;
const dead = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test('a link that is on never runs with a weak or unjudged password: held back with what it needs, and it starts by itself once it is strong', async () => {
  await S.detach();
  const before = raw().server;
  const n = runs();
  saveConfig({ publicLink: { on: true, kind: 'temporary' }, server: { passwordHash: HASH, passwordCheck: { tag: hashTag(HASH), strong: false, why: 'it has fewer than 12 characters' } } });
  await S.attach({ installFn, notifyFn, everyMs: 100 });
  await sleep(400);
  let s = S.status();
  assert.deepEqual([s.on, s.state, s.need, s.url], [true, 'blocked', 'stronger-password', null]);
  assert.match(s.error, /too weak for a public link/);
  assert.equal(S.status({ why: false }).password.why, null, 'what makes it weak is said only to the owner\'s own page');
  assert.equal(runs(), n, 'no cloudflared ran');
  assert.equal(raw().server.trustProxy, undefined, 'nothing was opened');
  // Never judged (an older install): held back too, asking for it to be typed once.
  saveConfig({ server: { passwordCheck: undefined } });
  assert.ok(await until(() => S.status().need === 'check-password'), JSON.stringify(S.status()));
  assert.equal(runs(), n);
  // Judged strong (a sign-in, or the password typed in place): the chosen link starts with no other step.
  strong();
  assert.ok(await until(() => S.status().state === 'on'), JSON.stringify(S.status()));
  assert.equal(runs(), n + 1);
  // And a password judged weak later stops a running link at the next look.
  const pid = S.readRecord().pid;
  saveConfig({ server: { passwordCheck: { tag: hashTag(HASH), strong: false, why: 'it is one of the passwords people try first' } } });
  assert.ok(await until(() => S.status().state === 'blocked' && dead(pid)), JSON.stringify(S.status()));
  assert.equal(raw().server.trustProxy, undefined, 'its settings went back');
  strong();
  await S.turnOff();
  assert.deepEqual(raw().server, { ...before, passwordCheck: raw().server.passwordCheck });
  await S.detach();
  await S.attach({ installFn, notifyFn, everyMs: 60_000 });
});

test('turning off while cloudflared installs answers at once, and nothing starts when the install ends', async () => {
  strong();
  const hidden = `${bin}-hidden`;
  fs.renameSync(bin, hidden);
  const realFetch = globalThis.fetch;
  let release;
  globalThis.fetch = () => new Promise((resolve, reject) => { release = () => reject(new Error('the download stopped')); });
  const n = runs();
  try {
    assert.equal((await S.turnOn('temporary')).ok, true);
    assert.ok(await until(() => S.status().state === 'installing'), JSON.stringify(S.status()));
    const t0 = Date.now();
    const off = await S.turnOff();
    assert.ok(Date.now() - t0 < 1000, `answered in ${Date.now() - t0} ms`);
    assert.equal(off.state, 'off');
  } finally {
    fs.renameSync(hidden, bin);
    release?.();
    globalThis.fetch = realFetch;
  }
  await S.settled();
  await sleep(200);
  assert.deepEqual([S.status().on, S.status().state], [false, 'off']);
  assert.equal(runs(), n, 'nothing started after the install');
});

test('the owner\'s own turn-on of what a hub turned on makes it his; a second temporary address stops with the switch', async () => {
  strong();
  assert.equal((await S.turnOn('temporary', { by: 'tok-hub' })).ok, true);
  await S.settled();
  assert.equal(S.readRecord().openedBy, 'tok-hub');
  assert.equal((await S.turnOn('temporary', { by: 'tok-other' })).ok, true);
  assert.equal(S.readRecord().openedBy, 'tok-hub', 'another hub\'s turn-on of what runs takes nothing over');
  assert.equal((await S.turnOn('temporary')).ok, true);
  assert.equal(S.readRecord().openedBy, null, 'the owner\'s own: a revoke of the hub no longer ends it');

  // Another local service gets a temporary address while the link is on as Temporary, and only then.
  const look = async () => ({ status: 401, headers: new Headers(), text: async () => '<form>password</form>' });
  const add = () => S.temporaryStep('add-service', { port: 20017 }, { fetchImpl: look, waitMs: 8000 });
  const r = await add();
  assert.equal(r.ok, true, r.error);
  const svc = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'addons', 'public-link-service.json'), 'utf8')).pid;
  assert.deepEqual(S.status().service, { port: 20017, url: r.url });
  await S.turnOff();
  assert.ok(await until(() => dead(svc)), 'off: the second address stops too, nothing stays open');
  assert.equal(S.status().service, null);
  assert.match((await add()).error, /Turn the public link on as Temporary first/, 'refused while off');
  // Moving to Custom stops it as well (it belongs to Temporary).
  assert.equal((await S.turnOn('temporary')).ok, true);
  await S.settled();
  assert.equal((await add()).ok, true);
  const svc2 = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'addons', 'public-link-service.json'), 'utf8')).pid;
  assert.equal((await S.turnOn('custom')).ok, true);
  await S.settled();
  assert.ok(await until(() => dead(svc2)), 'to Custom: the second temporary address stops');
  assert.match((await add()).error, /Turn the public link on as Temporary first/, 'refused while Custom');
  await S.turnOff();
});

test('after an update: a Custom link that ran keeps running until the password is judged; judged weak, it stops; a Temporary one waits for a strong password', async () => {
  await S.detach();
  const before = raw().server;
  const dir = path.join(tmp, 'state', 'addons', 'fixed-link');
  // What the older version left: Custom on, its settings taken; the password never judged.
  saveConfig({ publicLink: undefined, server: { passwordCheck: undefined, trustProxy: true, allowedOrigins: [...before.allowedOrigins, 'https://office.example.com'] } });
  fs.writeFileSync(path.join(dir, 'fixed.json'), JSON.stringify({ mode: 'named', hostname: 'office.example.com', tunnelId: ID, tunnelName: 'hoprig-office-example-com', extra: [], enabled: true, restored: false, pid: null, restore: { hadTrustProxy: false, hadOrigin: false, origin: 'https://office.example.com' } }));
  await S.attach({ installFn, notifyFn, everyMs: 100 });
  assert.ok(await until(() => S.status().state === 'on'), JSON.stringify(S.status()));
  assert.deepEqual([S.status().kind, S.status().password.state], ['custom', 'unknown']);
  // It runs, and asks the owner to type the password once, so the check that ends this is made.
  assert.equal(S.status().need, 'check-password', 'the page shows the password form while it runs unchecked');
  // A profile's PRERUN with the old words (no terminal): the session starts, and the link is left as it runs.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const pid = S.readRecord().pid;
  const pre = await promisify(execFile)(process.execPath, [path.join(import.meta.dirname, '..', '..', 'bin', 'hoprig.mjs'), 'addons', 'start', 'public-link'], { env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.match(pre.stderr, /The public link is on \(Custom\): https:\/\/office\.example\.com/);
  assert.match(pre.stderr, /It asks for one thing: Type your dashboard password once/);
  assert.equal(S.readRecord().pid, pid, 'left running');
  // The owner's next sign-in judges it weak: the link stops, and asks for a stronger one.
  saveConfig({ server: { passwordCheck: { tag: hashTag(HASH), strong: false, why: 'it has fewer than 12 characters' } } });
  assert.ok(await until(() => S.status().state === 'blocked'), JSON.stringify(S.status()));
  assert.equal(S.status().need, 'stronger-password');
  assert.deepEqual(raw().server.allowedOrigins, before.allowedOrigins);
  // Turned off, it is a turn-on like any other the next time: the exception for the carried-over link ends.
  assert.equal(S.readRecord().migratedCustom, true);
  await S.turnOff();
  assert.equal(S.readRecord().migratedCustom, null);
  await S.detach();

  // A Temporary link that ran: it would be a new address anyway, so it waits for the password like any turn-on.
  saveConfig({ publicLink: undefined, server: { passwordCheck: undefined } });
  fs.writeFileSync(path.join(dir, 'fixed.json'), JSON.stringify({ mode: 'named', hostname: 'office.example.com', tunnelId: ID, tunnelName: 'hoprig-office-example-com', extra: [] }));
  const { spawn } = await import('node:child_process');
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7655'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(tmp, 'state', 'addons', 'public-link.json'), JSON.stringify({ pid: old.pid, url: 'https://old-words.trycloudflare.com', restored: false, restore: null }));
    const n = runs();
    await S.attach({ installFn, notifyFn, everyMs: 100 });
    assert.ok(await until(() => S.status().state === 'blocked'), JSON.stringify(S.status()));
    assert.deepEqual([S.status().on, S.status().kind, S.status().need], [true, 'temporary', 'check-password']);
    assert.ok(await until(() => dead(old.pid)), 'the old tunnel ended');
    await sleep(300);
    assert.equal(runs(), n, 'no new address was opened');
  } finally {
    old.kill('SIGKILL');
  }
  strong();
  await S.turnOff();
  await S.detach();
});
