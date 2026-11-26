// A linked hub runs this computer's add-ons with its machine token (one dashboard runs every computer). What it
// changes is in this computer's Activity log under its name; what it opened to the network ends when its token is
// revoked, by every way of revoking (the page, self-revoke, `hoprig tokens revoke`, Remove on the hub). What the owner
// opened with his own login stays. A Setup job started with a token is logged without any part of its body: the
// administrator password is nowhere. A real dashboard, a stand-in cloudflared; no Cloudflare is touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { REPO } from '../machines/harness.mjs';
import { sandbox } from '../server/helpers.mjs';
import { sealed } from '../seal.mjs';

// The stand-in cloudflared is a Node script with no extension, started by name through its #! line: Windows starts
// only an .exe or .com by name, so a test that runs it is skipped there.
const STANDIN = { skip: process.platform === 'win32' && 'the stand-in is started through its #! line' };

const box = sandbox('tokenopened');
const PIDS = path.join(box.root, 'pids.txt');
test.after(() => {
  // Every stand-in cloudflared that is still running, whatever happened above.
  for (const pid of (fs.existsSync(PIDS) ? fs.readFileSync(PIDS, 'utf8') : '').split('\n').filter(Boolean)) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
  box.cleanup();
});

// The stand-in: a quick tunnel (`tunnel --url`), a DNS record (`route dns`) and the fixed address's `run`.
const bin = path.join(box.root, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('cloudflared version 2026.10.1 (built 2026-10-15-1724 UTC)'); process.exit(0); }
const say = (t) => process.stderr.write('2026-11-16T03:00:00Z INF ' + t + '\\n');
if (a.includes('route')) { say('Added CNAME ' + a[a.length - 1] + ' which will route to this tunnel'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(PIDS)}, process.pid + '\\n');
if (a.includes('--url')) say('|  https://stand-in-' + process.pid + '.trycloudflare.com   |');
say('Registered tunnel connection connIndex=0 connection=0000aaaa event=0 ip=198.51.100.7 location=example01 protocol=quic');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { fixedDir, fixedStateFile, quickStateFile, readFixed, alive, writeAtomic, linkRecordFile } = await import('../../src/addons/cloudflared.mjs');
const { createServer } = await import('../../src/server/server.mjs');

// A local service with a sign-in of its own (401): it may get an address without a question.
const service = http.createServer((req, res) => res.writeHead(401, { 'WWW-Authenticate': 'Basic' }).end());
await new Promise((r) => service.listen(0, '127.0.0.1', r));
const servicePort = service.address().port;
test.after(() => new Promise((r) => service.close(r)));

const PASSWORD = 'fake-sudo-pw-90551';
const said = [];
const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
for (const k of Object.keys(keep)) console[k] = (...x) => { said.push(x.join(' ')); keep[k](...x); };
test.after(() => Object.assign(console, keep));

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const sys = { platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: box.root, home: box.home, env: sealed({ PATH: '/usr/bin:/bin', HOME: box.home }), has: (b) => b === 'sudo', exists: () => false, clt: true, run: async () => ({ ok: false, stdout: '', stderr: '' }) };
const app = createServer({
  backend, watch: false, accounts: { gateways: [] },
  addons: { sweepMs: 200 },
  pcsetup: {
    sys, projectsDir: () => path.join(box.root, 'projects'),
    sudoNeedsPassword: async () => true,
    stream: async () => ({ ok: true, code: 0, output: '' }), // the password check: right
    runPcSetup: async () => ({ ok: true, missing: [], changed: false }),
  },
});
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const owner = async (p, body) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
// `headers`: e.g. the hub's word that the leg is encrypted (src/machines/legs.mjs: believed only from this computer).
const asHub = async (token, p, body = {}, headers = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const until = async (what, fn, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await fn()) return;
  assert.fail(`waited in vain: ${what}`);
};
/** A job of the public link, started by `go`, to its end: its result. */
const job = async (go) => {
  const r = await go();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let j;
  await until('the job ends', async () => !(j = (await owner('/api/addons/public-link/job')).json).running);
  return j.result;
};
const LOG = path.join(box.state, 'automation.log');
const activity = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const hubLines = () => activity().filter((e) => e.automation === 'hub').map((e) => e.did);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const record = () => readJson(linkRecordFile()) || {};
const isOn = () => loadConfig().publicLink?.on === true;
const linkState = async () => (await owner('/api/public-link')).json;
const serviceState = () => readJson(path.join(path.dirname(quickStateFile()), 'public-link-service.json'));

test('a token\'s changes are logged with its name; its revoke closes what it opened, and the owner\'s own stays', STANDIN, async () => {
  // The Custom address set up before (as Make it leaves it), turned on by the owner.
  fs.mkdirSync(path.join(fixedDir(), 'home', '.cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(fixedDir(), 'home', '.cloudflared', 'cert.pem'), 'stand-in');
  writeAtomic(fixedStateFile(), JSON.stringify({ mode: 'named', hostname: 'office.example.com', tunnelId: '00000000-0000-4000-8000-00000000c0de', tunnelName: 'hoprig-office', extra: [] }));
  const on = await owner('/api/public-link', { on: true, kind: 'custom' });
  assert.equal(on.json.ok, true, JSON.stringify(on.json));
  await until('Custom is on', async () => (await linkState()).state === 'on');
  assert.equal(record().openedBy, null, 'the owner\'s: no opener');
  // A second temporary address belongs to the Temporary kind: refused while the switch is on as Custom.
  const temp = await job(() => owner('/api/public-link/temporary/add-service', { port: servicePort }));
  assert.equal(temp.ok, false);
  assert.match(temp.error, /Turn the public link on as Temporary first/);
  assert.equal(serviceState(), null);
  assert.equal(hubLines().length, 0, 'what the owner does is not logged as a hub');

  const office = { name: 'office-pc', ...createToken('office-pc') };
  await new Promise((r) => setTimeout(r, 400)); // a sweep has seen it (its name for the revoke line)
  // The token adds a service to the Custom address.
  const added = await job(() => asHub(office.token, '/api/public-link/custom/add-service', { port: servicePort, hostname: 'trouteai-office.example.com' }));
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual(readFixed().extra, [{ hostname: 'trouteai-office.example.com', port: servicePort, openedBy: office.id }]);
  assert.equal(JSON.stringify(readFixed()).includes(office.token), false, 'never the token itself');
  // A second "on" with the token does not make the owner's link the token's.
  assert.equal((await asHub(office.token, '/api/public-link', { on: true, kind: 'custom' })).json.ok, true);
  assert.equal(record().openedBy, null);
  assert.deepEqual(hubLines(), [
    'The main computer office-pc added a service to the Custom public link',
    'The main computer office-pc switched the public link on or off',
  ]);

  // Revoked on the page ("Who may control this computer"): what it added ends, and that is logged.
  assert.equal((await owner(`/api/tokens/${office.id}/revoke`, {})).status, 200);
  await until('its service is removed', () => readFixed().extra.length === 0);
  await until('the log says so', () => hubLines().length >= 4);
  assert.deepEqual(hubLines().slice(2).sort(), [
    'The service trouteai-office.example.com that the main computer office-pc added to the Custom address was removed: its token was revoked',
    'The token of the main computer office-pc was revoked',
  ].sort());
  // What stays: the owner's link (on, and running again without the service) and his temporary address.
  assert.equal(isOn(), true);
  await until('running again without it', () => !fs.readFileSync(path.join(fixedDir(), 'config.yml'), 'utf8').includes('trouteai-office'));
  await new Promise((r) => setTimeout(r, 500)); // more sweeps: nothing said twice
  assert.equal(hubLines().length, 4);
});

test('every way of revoking turns off the link that token turned on; one the owner turned on survives a revoke', STANDIN, async () => {
  const start = async (t) => {
    // The route an older hub uses: it maps onto the one switch (Temporary).
    assert.equal((await job(() => asHub(t.token, '/api/addons/public-link/start'))).ok, true);
    assert.equal(record().openedBy, t.id);
    assert.equal((await linkState()).kind, 'temporary');
  };
  const stopped = async (t) => {
    await until(`${t.name}: its public link is off`, () => !isOn());
    await until(`${t.name}: logged`, () => hubLines().includes(`The public link the main computer ${t.name} turned on was turned off: its token was revoked`));
    // The revoke itself, with the token's name, whichever process revoked it (the CLI too).
    await until(`${t.name}: its revoke logged`, () => hubLines().includes(`The token of the main computer ${t.name} was revoked`));
  };
  const [self, cli, removed, other] = ['hub self', 'hub cli', 'hub removed', 'hub other'].map((n) => ({ name: n, ...createToken(n) }));
  await new Promise((r) => setTimeout(r, 400));

  // The token gives itself up. (Its Temporary link replaced the owner's Custom one: never both.)
  await start(self);
  assert.equal(readFixed().mode, 'named', 'Custom stays set up for the next time');
  assert.equal((await asHub(self.token, '/api/tokens/self/revoke')).status, 200);
  await stopped(self);

  // `hoprig tokens revoke <id>`: another process; the dashboard sees the token gone at its next look.
  await start(cli);
  execFileSync(process.execPath, [path.join(REPO, 'bin', 'hoprig.mjs'), 'tokens', 'revoke', cli.id, '--yes'], { env: process.env, encoding: 'utf8' });
  await stopped(cli);

  // Remove on the hub: the hub asks this computer to revoke its token (here the hub is this dashboard itself).
  await start(removed);
  putMachine({ name: 'hubself', label: 'Hub', via: 'url', url: base, token: removed.token, added: Date.now() });
  const r = await owner('/api/machines/hubself/remove', { confirm: 'hubself' });
  assert.equal(r.json.revoked, true, JSON.stringify(r.json));
  await stopped(removed);

  // The owner turns it on himself: a revoke of another token leaves it on, and nothing is logged as a hub.
  const before = hubLines().length;
  assert.equal((await owner('/api/public-link', { on: true, kind: 'temporary' })).json.ok, true);
  await until('on', async () => (await linkState()).state === 'on');
  assert.equal(record().openedBy, null);
  assert.equal(hubLines().length, before);
  assert.equal((await owner(`/api/tokens/${other.id}/revoke`, {})).status, 200);
  await until('the revoke is logged', () => hubLines().includes('The token of the main computer hub other was revoked'));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(isOn() && (await linkState()).state === 'on', 'the owner\'s public link still runs');

  assert.equal((await owner('/api/public-link', { on: false })).json.state, 'off');
  assert.equal((await job(() => owner('/api/public-link/temporary/remove-service', {}))).ok, true);

  // Custom turned on by a token (it was off): its revoke turns it off again.
  const fixedHub = { name: 'hub fixed', ...createToken('hub fixed') };
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await asHub(fixedHub.token, '/api/public-link', { on: true, kind: 'custom' })).json.ok, true);
  assert.equal(record().openedBy, fixedHub.id);
  assert.equal((await owner(`/api/tokens/${fixedHub.id}/revoke`, {})).status, 200);
  await until('turned off', () => !isOn());
  await until('logged', () => hubLines().includes('The public link the main computer hub fixed turned on was turned off: its token was revoked'));
  assert.equal(record().openedBy, null);

  // A hub never checks the password here, over any leg: a guess checked through a token would outlive its revoke.
  // Nor does it learn what makes the password weak.
  const pw = { name: 'hub pw', ...createToken('hub pw') };
  const plain = await asHub(pw.token, '/api/public-link', { on: true, kind: 'temporary', password: 'right-password' });
  assert.equal(plain.status, 403);
  assert.match(plain.json.error, /only on this computer's own page/);
  assert.equal(isOn(), false);
  const seen = await asHub(pw.token, '/api/public-link', { on: false });
  assert.equal(seen.json.password.why, null, 'no hint about the password for a hub');
});

test('Setup started with a token is logged, and its password is nowhere: not the log, the console, any file', async () => {
  const t = { name: 'setup-hub', ...createToken('setup-hub') };
  const before = hubLines().length;
  // Over a plain leg the password is refused unread: nothing ran, so nothing is logged.
  assert.deepEqual((await asHub(t.token, '/api/pcsetup/setup', { kits: ['extras'], password: PASSWORD })).json, { needsPassword: true, plainLeg: true });
  assert.equal(hubLines().length, before, 'a refused password is not a change');
  // Over an encrypted leg (ssh or a tunnel to this computer: the hub says so, from loopback).
  const leg = { 'X-Hoprig-Leg': 'encrypted' };
  assert.deepEqual((await asHub(t.token, '/api/pcsetup/setup', { kits: ['extras'] }, leg)).json, { needsPassword: true });
  assert.equal(hubLines().length, before, 'asking for the password is not a change');
  const r = await asHub(t.token, '/api/pcsetup/setup', { kits: ['extras'], password: PASSWORD }, leg);
  assert.deepEqual(r.json, { started: true });
  await until('logged', () => hubLines().length === before + 1);
  assert.equal(hubLines().at(-1), 'The main computer setup-hub ran Set up this computer');
  await until('the job ends', async () => !(await owner('/api/pcsetup/job')).json.running);

  assert.equal(fs.readFileSync(LOG, 'utf8').includes(PASSWORD), false, 'not in the Activity log');
  assert.equal(said.join('\n').includes(PASSWORD), false, 'not on the console');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(box.root)) assert.equal(fs.readFileSync(f).includes(PASSWORD), false, `not in ${path.relative(box.root, f)}`);
});
