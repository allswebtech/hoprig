// TRouteAI's public address (src/addons/trouteaipublic.mjs): the name it gets, every refusal by its code, what the tunnel
// program is given (its argv and config file, with a stand-in for the program), what the gateway is told, and that no
// other way can make or remove the name: the generic add-service of Settings, the second temporary address, and
// remove-service all refuse the gateway's port or entry. A stand-in cloudflared, no real Cloudflare account, tunnel or record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';

const STANDIN = { skip: process.platform === 'win32' && 'the stand-in is started through its #! line' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-taipub-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
const LOG = path.join(tmp, 'calls.jsonl');
const ID = '00000000-0000-4000-8000-00000000c0de';
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(a) + '\\n');
if (a.includes('route')) {
  const host = a[a.length - 1];
  if (host.startsWith('tai-taken.')) { process.stderr.write('ERR Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.\\n'); process.exit(1); }
  process.stderr.write('INF Added CNAME ' + host + ' which will route to this tunnel tunnelID=${ID}\\n');
}
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

// The gateway stand-in: a sign-in page and nothing else, on a port of its own (the default port is never asked).
const gw = http.createServer((req, res) => {
  res.writeHead(req.url === '/' ? 200 : 401, { 'content-type': 'text/html' });
  res.end('<input type=password>');
});
await new Promise((r) => gw.listen(0, '127.0.0.1', r));
const GWPORT = gw.address().port;
fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ addons: { trouteai: { port: GWPORT } }, server: { port: 17433 } }));

const P = await import('../../src/addons/trouteaipublic.mjs');
const F = await import('../../src/addons/fixedlink.mjs');
const C = await import('../../src/addons/cloudflared.mjs');
const L = await import('../../src/addons/localservice.mjs');
const Pub = await import('../../src/addons/publiclink.mjs');
const { listenRule } = await import('../../src/addons/localgateway.mjs');

const fixedDir = path.join(tmp, 'state', 'addons', 'fixed-link');
const writeFixed = (st) => {
  fs.mkdirSync(path.join(fixedDir, 'home', '.cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(fixedDir, 'home', '.cloudflared', 'cert.pem'), 'stand-in');
  fs.writeFileSync(C.fixedStateFile(), JSON.stringify(st));
};
const NAMED = { mode: 'named', hostname: 'pc.example.com', tunnelId: ID, tunnelName: 'hoprig-pc-example-com', extra: [] };
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const answers = async () => 'yes';
test.after(() => {
  gw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// What the page's switch looks at, all fine; each test breaks one thing.
const fine = (over = {}) => ({
  fixed: () => (fs.existsSync(C.fixedStateFile()) ? JSON.parse(fs.readFileSync(C.fixedStateFile(), 'utf8')) : null),
  link: async () => ({ on: true, kind: 'custom' }),
  gateway: async () => ({ installed: true, running: true }),
  firstFile: () => path.join(tmp, 'no-such-first-password.txt'),
  signIn: async () => ({ requireLogin: true, signInSet: true, oidcEnabled: false }),
  openApi: async () => null,
  step: (n, b, o) => F.customSteps[n](b, o),
  ...over,
});

test('the name: tai- and the first label under the same domain; an apex gets tai.; one level only; long labels give none', () => {
  assert.equal(P.tailName('box.example.com'), 'tai-box.example.com');
  assert.equal(P.tailName('example.com'), 'tai.example.com');
  assert.equal(P.tailName('PC.Sub.Example.com'), 'tai-pc.sub.example.com');
  assert.equal(P.tailName(`${'a'.repeat(60)}.example.com`), null, 'tai- would make the label longer than 63');
  assert.equal(P.tailName(`${'a'.repeat(59)}.example.com`)?.split('.')[0].length, 63);
  assert.equal(P.tailName('localhost'), null);
  assert.equal(P.tailName('bad_name.example.com'), null);
  assert.equal(P.tailName(''), null);
});

test('the gateway is told its public base only while its name is in the list, and never another gateway', () => {
  assert.deepEqual(P.baseEnv(null), {});
  assert.deepEqual(P.baseEnv({ mode: 'named', hostname: 'pc.example.com', extra: [{ hostname: 'files.example.com', port: 9000 }] }), {});
  assert.deepEqual(P.baseEnv({ mode: 'named', hostname: 'pc.example.com', extra: [{ hostname: 'tai-pc.example.com', port: GWPORT, gateway: 'trouteai' }] }), { TROUTEAI_PUBLIC_BASE_URL: 'https://tai-pc.example.com' });
  assert.deepEqual(P.baseEnv({ mode: 'named', hostname: 'pc.example.com', extra: [{ hostname: 'tai-pc.example.com', port: GWPORT }] }), { TROUTEAI_PUBLIC_BASE_URL: 'https://tai-pc.example.com' }, 'a name added by hand to its port is the same name');
  assert.deepEqual(P.baseEnv({ mode: 'token', hostname: 'pc.example.com', extra: [{ hostname: 'x.example.com', port: GWPORT }] }), {}, 'a tunnel token keeps its names in Cloudflare');
});

test('the listen rule gives only the shipped gateway its public base, and only while the name exists', () => {
  const def = { id: 'trouteai', localOnly: ['--host', '127.0.0.1'] };
  const o = { host: '127.0.0.1', reason: null, tailscale: false };
  fs.rmSync(C.fixedStateFile(), { force: true });
  assert.deepEqual(listenRule(def, { ...o, shipped: true }).env, { HOST: '127.0.0.1' });
  writeFixed({ ...NAMED, extra: [{ hostname: 'tai-pc.example.com', port: GWPORT, gateway: 'trouteai' }] });
  assert.deepEqual(listenRule(def, { ...o, shipped: true }).env, { HOST: '127.0.0.1', TROUTEAI_PUBLIC_BASE_URL: 'https://tai-pc.example.com' });
  assert.deepEqual(listenRule(def, { ...o, shipped: false }).env, { HOST: '127.0.0.1' }, 'a gateway of his own never');
  assert.deepEqual(listenRule({ ...def, id: 'mine' }, { ...o, shipped: true }).env, { HOST: '127.0.0.1' });
  assert.deepEqual(listenRule(def, { ...o, shipped: true }).args, ['--host', '127.0.0.1']);
});

test('every refusal has its own code, in the order of the design', async () => {
  writeFixed(NAMED);
  assert.equal(await P.cannotTurnOn(fine()), null, 'all fine: nothing refuses');
  const need = async (over) => (await P.cannotTurnOn(fine(over))).need;
  writeFixed({ ...NAMED, mode: 'token' });
  assert.equal(await need({}), 'link-custom');
  fs.rmSync(C.fixedStateFile());
  assert.equal(await need({}), 'link-custom');
  writeFixed(NAMED);
  assert.equal(await need({ link: async () => ({ on: false, kind: 'custom' }) }), 'link-off');
  assert.equal(await need({ link: async () => ({ on: true, kind: 'temporary' }) }), 'link-off');
  assert.equal(await need({ gateway: async () => ({ installed: true, running: false }) }), 'not-running');
  assert.equal(await need({ gateway: async () => ({ installed: false, running: false }) }), 'not-running');
  const first = path.join(tmp, 'initial-admin-password.txt');
  fs.writeFileSync(first, 'x');
  assert.equal(await need({ firstFile: () => first }), 'first-password');
  fs.rmSync(first);
  assert.equal(await need({ signIn: async () => ({ requireLogin: false, signInSet: true, oidcEnabled: false }) }), 'no-password');
  assert.equal(await need({ signIn: async () => ({ requireLogin: true, signInSet: false, oidcEnabled: false }) }), 'no-password');
  assert.equal(await need({ signIn: async () => null }), 'no-password', 'a sign-in state that cannot be read keeps it off');
  assert.equal(await P.cannotTurnOn(fine({ signIn: async () => ({ requireLogin: true, signInSet: false, oidcEnabled: true }) })), null, 'a single sign-in provider counts');
  assert.equal(await need({ openApi: async () => '/v1/models' }), 'open-api');
  writeFixed({ ...NAMED, hostname: `${'a'.repeat(62)}.example.com` });
  assert.equal(await need({}), 'name-long');
  writeFixed({ ...NAMED, extra: [{ hostname: 'tai-pc.example.com', port: 9000 }] });
  assert.equal(await need({}), 'name-taken');
  writeFixed(NAMED);
});

test('the state the page reads: off, unavailable with its words, on (also a name added by hand, shown and left alone)', async () => {
  writeFixed(NAMED);
  const off = await P.stateOf(fine());
  assert.deepEqual({ s: off.state, h: off.hostname, u: off.url }, { s: 'off', h: 'tai-pc.example.com', u: 'https://tai-pc.example.com' });
  const un = await P.stateOf(fine({ signIn: async () => ({ requireLogin: false }) }));
  assert.deepEqual({ s: un.state, n: un.need, w: un.why }, { s: 'unavailable', n: 'no-password', w: 'TRouteAI has no password. Set one first.' });
  const hand = { ...NAMED, extra: [{ hostname: 'tai-pc.example.com', port: GWPORT }] };
  writeFixed(hand);
  const on = await P.stateOf(fine());
  assert.deepEqual({ s: on.state, u: on.url, t: on.told, l: on.linkOn }, { s: 'on', u: 'https://tai-pc.example.com', t: false, l: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(C.fixedStateFile(), 'utf8')), hand, 'looking changes nothing');
  assert.equal((await P.stateOf(fine({ link: async () => ({ on: false }) }))).linkOn, false, 'Hoprig\'s own link off later: still on, and says it does not answer');
});

test('on then off: the name, the tunnel config and the cloudflared lines, then back to what it was', STANDIN, async () => {
  writeFixed(NAMED);
  const before = fs.readFileSync(C.fixedStateFile(), 'utf8');
  fs.rmSync(LOG, { force: true });
  const lookedAt = [];
  const r = await P.turnOn(fine({ step: (n, b, o) => (lookedAt.push([n, b, o.internal]), F.customSteps[n](b, o)) }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.url, 'https://tai-pc.example.com');
  assert.deepEqual(lookedAt[0].slice(0, 2), ['add-service', { port: GWPORT, hostname: 'tai-pc.example.com', confirmed: true }]);
  // Cloudflare is asked for one CNAME, for that name, to Hoprig's own tunnel.
  const route = calls().find((c) => c.includes('route'));
  assert.deepEqual(route.slice(-4), ['route', 'dns', ID, 'tai-pc.example.com']);
  // fixed.json holds the one record of this switch.
  const st = JSON.parse(fs.readFileSync(C.fixedStateFile(), 'utf8'));
  assert.deepEqual(st.extra, [{ hostname: 'tai-pc.example.com', port: GWPORT, gateway: 'trouteai' }]);
  // What the tunnel program is given: its config has the rule, after the dashboard and before the 404.
  const run = F.customRun();
  assert.deepEqual(run.argv.slice(1, 4), ['tunnel', '--no-autoupdate', '--config']);
  assert.equal(run.argv.at(-1), ID);
  const yml = fs.readFileSync(run.argv[4], 'utf8');
  const rules = [...yml.matchAll(/hostname: "([^"]+)"\n\s+service: "([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rules, [['pc.example.com', `http://127.0.0.1:${C.dashboardPort()}`], ['tai-pc.example.com', `http://127.0.0.1:${GWPORT}`]]);
  assert.match(yml.trimEnd(), /- service: "http_status:404"$/);
  // The gateway is told its public base from now on.
  assert.deepEqual(P.baseEnv(), { TROUTEAI_PUBLIC_BASE_URL: 'https://tai-pc.example.com' });
  // A second press changes nothing.
  assert.equal((await P.turnOn(fine())).already, true);
  // Told: the entry says the gateway was started with it.
  assert.equal(F.fixedMarkTold(), true);
  assert.equal(F.fixedMarkTold(), false);
  assert.equal(JSON.parse(fs.readFileSync(C.fixedStateFile(), 'utf8')).extra[0].told, true);
  // Off: the name leaves the config, the gateway is told nothing, fixed.json is as before; the record stays in Cloudflare.
  const off = await P.turnOff(fine());
  assert.equal(off.ok, true);
  assert.match(off.lines.join(' '), /DNS record stays in Cloudflare/);
  assert.equal(fs.readFileSync(C.fixedStateFile(), 'utf8'), before);
  F.customRun();
  assert.doesNotMatch(fs.readFileSync(run.argv[4], 'utf8'), /tai-pc/);
  assert.deepEqual(P.baseEnv(), {});
  assert.equal((await P.turnOff(fine())).already, true);
});

test('a DNS record of that name already there is refused with its own code, and nothing is written', STANDIN, async () => {
  writeFixed({ ...NAMED, hostname: 'taken.example.com' });
  const r = await P.turnOn(fine());
  assert.equal(r.ok, false);
  assert.equal(r.need, 'dns-taken');
  assert.match(r.error, /There is already a DNS record for tai-taken\.example\.com in Cloudflare/);
  assert.deepEqual(JSON.parse(fs.readFileSync(C.fixedStateFile(), 'utf8')).extra, []);
});

test('no other way makes or removes the name: the generic step, the second temporary address and remove-service all refuse it', STANDIN, async () => {
  writeFixed(NAMED);
  const look = { fetchImpl: async () => ({ status: 401, headers: new Map(), text: async () => '' }) };
  const generic = await F.customSteps['add-service']({ port: GWPORT, hostname: 'tai-pc.example.com', confirmed: true }, look);
  assert.equal(generic.ok, false);
  assert.equal(generic.error, 'TRouteAI\'s public address is turned on and off on its own page.');
  const lying = await F.customSteps['add-service']({ port: GWPORT, hostname: 'tai-pc.example.com', confirmed: true, internal: 'trouteai', gateway: 'trouteai' }, look);
  assert.equal(lying.ok, false, 'a body cannot say it is internal');
  const wrong = await F.customSteps['add-service']({ port: GWPORT, hostname: 'tai-pc.example.com', confirmed: true }, { ...look, internal: 'other' });
  assert.equal(wrong.ok, false);
  assert.deepEqual(L.checkPort(GWPORT, 7433), { error: 'TRouteAI\'s public address is turned on and off on its own page.' }, 'the temporary address asks the same check');
  assert.deepEqual(L.checkPort(9000, 7433), { port: 9000 });
  assert.deepEqual(L.checkPort(GWPORT, 7433, { own: true }), { port: GWPORT });
  assert.ok(Pub.temporarySteps['add-service'], 'it is the same check at the temporary step');
  // The entry made by the page cannot be removed by the generic step; an old one added by hand can.
  writeFixed({ ...NAMED, extra: [{ hostname: 'tai-pc.example.com', port: GWPORT, gateway: 'trouteai' }, { hostname: 'files.example.com', port: 9000 }] });
  const rm = await F.customSteps['remove-service']({ hostname: 'tai-pc.example.com' });
  assert.equal(rm.error, 'TRouteAI\'s public address is turned on and off on its own page.');
  assert.equal((await F.customSteps['remove-service']({ hostname: 'files.example.com' })).ok, true);
  const shown = F.fixedStatus().extra.find((x) => x.hostname === 'tai-pc.example.com');
  assert.equal(shown.gateway, 'trouteai', 'Settings shows it as TRouteAI\'s, with no Remove');
});

test('the temporary address refuses the shipped gateway\'s port too', async () => {
  const r = await Pub.temporarySteps['add-service']({ port: GWPORT }, { notify: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TRouteAI\'s public address is turned on and off on its own page.');
});
