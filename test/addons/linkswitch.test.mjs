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
const { reachableUrl } = await import('../../src/addons/reach.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
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
  await S.attach({ notifyFn, everyMs: 60_000 });
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
  assert.deepEqual(loadConfig().publicLink, { on: true, kind: 'temporary' }, 'the choice is remembered');
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
  assert.deepEqual(loadConfig().publicLink, { on: true, kind: 'temporary' });
  sent.length = 0;
  await S.attach({ notifyFn, everyMs: 60_000 });
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
  await S.attach({ notifyFn, everyMs: 60_000 });
  const s = await S.settled();
  assert.equal(s.state, 'on');
  assert.deepEqual(loadConfig().server.allowedOrigins, [...before.allowedOrigins, s.url], 'the old address is gone');
  await S.turnOff();
  assert.deepEqual(raw().server, before, 'exactly what the owner had, trustProxy absent as before');
});

test('the command line\'s choice is seen by the running dashboard', async () => {
  strong();
  await S.detach();
  await S.attach({ notifyFn, everyMs: 100 });
  saveConfig({ publicLink: { on: true, kind: 'temporary' } }); // what `hoprig public on` writes
  assert.ok(await until(() => S.status().state === 'on'), JSON.stringify(S.status()));
  saveConfig({ publicLink: { on: false, kind: 'temporary' } });
  assert.ok(await until(() => S.status().state === 'off' && !loadConfig().server.trustProxy));
  await S.detach();
  await S.attach({ notifyFn, everyMs: 60_000 });
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
