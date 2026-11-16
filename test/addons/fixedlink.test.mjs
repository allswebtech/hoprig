// The Custom address (src/addons/fixedlink.mjs): its pure parts (names, argv, cloudflared's output, the token, the
// config file, the backoff), the supervisor that starts it again, and the whole flow through the one switch
// (linkswitch.mjs) against a stand-in cloudflared that prints what the real 2026.10.1 prints: sign in, make, run,
// start again after a crash, another service, off, on, stop using it. No real Cloudflare account, tunnel or DNS
// record is touched.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-fixedlink-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_HOSTNAME = 'Dev-Office.home.example';

// Things a test does to the stand-in: approve the sign-in, make the next run crash, say a tunnel name is taken.
const mark = (name) => path.join(tmp, name);
const LOG = mark('calls.jsonl');
const ID = '6ff42ae2-765d-4adf-8112-31c55c1551ef';
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
const val = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
const has = (f) => fs.existsSync(${JSON.stringify(tmp)} + '/' + f);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ a, home: process.env.HOME, path: process.env.PATH, keys: Object.keys(process.env) }) + '\\n');
if (a[0] === '--version') { console.log('cloudflared version 2026.10.1 (built 2026-10-15-17:08 UTC)'); process.exit(0); }
const cmd = ['login', 'create', 'token', 'route', 'delete', 'run'].find((c) => a.includes(c));
const err = (t) => { process.stderr.write('2026-11-15T17:42:59Z ERR ' + t + '\\n'); process.exit(1); };
const certOk = () => { if (!fs.existsSync(val('--origincert') || '')) err('Error locating origin cert: cannot find a valid certificate at the path ' + val('--origincert')); };
if (cmd === 'login') {
  const cert = path.join(process.env.HOME, '.cloudflared', 'cert.pem');
  if (fs.existsSync(cert)) err('You have an existing certificate at ' + cert + ' which login would overwrite.');
  fs.mkdirSync(path.dirname(cert), { recursive: true, mode: 0o700 });
  process.stdout.write('Please open the following URL and log in with your Cloudflare account:\\n\\nhttps://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fstand-in\\n\\nLeave cloudflared running to download the cert automatically.\\n');
  setInterval(() => {
    if (!has('approve')) return;
    fs.writeFileSync(cert, '-----BEGIN ARGO TUNNEL TOKEN-----\\nstand-in\\n-----END ARGO TUNNEL TOKEN-----\\n');
    process.stdout.write('You have successfully logged in.\\nIf you wish to copy your credentials to a server, they have been saved to:\\n' + cert + '\\n');
    process.exit(0);
  }, 100);
} else if (cmd === 'create') {
  certOk();
  if (has('taken-name')) err('failed to create tunnel: Create Tunnel API call failed: tunnel with name already exists');
  fs.writeFileSync(val('--cred-file'), JSON.stringify({ AccountTag: 'acc', TunnelSecret: 'c2VjcmV0LXNlY3JldA==', TunnelID: '${ID}' }));
  process.stderr.write('Tunnel credentials written to ' + val('--cred-file') + '. cloudflared chose this file based on where your origin certificate was found. Keep this file secret. To revoke these credentials, delete the tunnel.\\n');
  process.stdout.write('\\nCreated tunnel ' + a[a.length - 1] + ' with id ${ID}\\n');
} else if (cmd === 'token') {
  certOk();
  fs.writeFileSync(val('--cred-file'), JSON.stringify({ AccountTag: 'acc', TunnelSecret: 'c2VjcmV0LXNlY3JldA==', TunnelID: '${ID}' }));
  process.stdout.write('eyJTOKEN-THAT-MUST-NOT-SHOW\\n');
} else if (cmd === 'route') {
  certOk();
  const host = a[a.length - 1];
  if (host.startsWith('taken.')) err('Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.');
  const made = host.endsWith('.example.com') ? host : host + '.example.com';
  process.stderr.write('2026-11-15T17:43:10Z INF Added CNAME ' + made + ' which will route to this tunnel tunnelID=${ID}\\n');
} else if (cmd === 'delete') {
  certOk();
} else if (cmd === 'run') {
  fs.copyFileSync(val('--config'), ${JSON.stringify(mark('last-config.yml'))});
  if (has('crash')) err('Couldn\\'t start tunnel: stand-in crash');
  process.stderr.write('2026-11-15T17:44:00Z INF Starting tunnel tunnelID=${ID}\\n');
  setTimeout(() => process.stderr.write('2026-11-15T17:44:01Z INF Registered tunnel connection connIndex=0 connection=d5695230 event=0 ip=198.41.200.233 location=del06 protocol=quic\\n'), 150);
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
}
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.TUNNEL_TOKEN = 'must-not-reach-cloudflared';
process.env.ANTHROPIC_AUTH_TOKEN = 'must-not-reach-cloudflared';

const F = await import('../../src/addons/fixedlink.mjs');
const C = await import('../../src/addons/cloudflared.mjs');
const L = await import('../../src/addons/localservice.mjs');
const S = await import('../../src/addons/linkswitch.mjs');
const { publicLink } = await import('../../src/addons/linkaddon.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const choice = () => { const { on, kind } = loadConfig().publicLink || {}; return { on, kind }; };
const { hashTag } = await import('../../src/server/strength.mjs');
// A password judged strong (strength.mjs): the switch turns nothing on without one.
const strongPassword = () => saveConfig({ server: { passwordHash: 'scrypt$x', passwordCheck: { tag: hashTag('scrypt$x'), strong: true } } });
const on = () => S.status().state === 'on';
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
const act = async (name, body = {}, opts = {}) => {
  const lines = [];
  const r = await publicLink.actions[name](body, { onLine: (l) => lines.push(l), ...opts });
  return { ...r, lines };
};
const fixedDir = path.join(tmp, 'state', 'addons', 'fixed-link');
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

test.after(async () => {
  F.resetForTests();
  await S.resetForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('names: what the owner types becomes a clean address; the suggestion comes from the computer\'s name', () => {
  assert.equal(F.cleanHostname(' https://Office.Example.com/ '), 'office.example.com');
  assert.equal(F.cleanHostname('trouteai-office.example.com.'), 'trouteai-office.example.com');
  for (const bad of ['', 'office', 'office .example.com', '-a.example.com', 'a_b.example.com', '1.2.3.4', 'a.example.com;rm', `${'a'.repeat(64)}.example.com`]) {
    assert.throws(() => F.cleanHostname(bad), Error, bad);
  }
  assert.throws(() => F.cleanHostname('x.trycloudflare.com'), /your own domain/);
  assert.equal(F.suggestName('Dev-Office.home.example'), 'dev-office');
  assert.equal(F.suggestName('my_mac (2)'), 'my-mac-2');
  assert.equal(F.suggestName('...'), 'my-computer');
  assert.equal(F.tunnelName('office.example.com'), 'hoprig-office-example-com');
});

test('cloudflared\'s output: the sign-in link, the tunnel made, the DNS record, a name already taken', () => {
  const login = 'Please open the following URL and log in with your Cloudflare account:\n\nhttps://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc\n\nLeave cloudflared running to download the cert automatically.';
  assert.equal(F.parseLoginUrl(login), 'https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc');
  assert.equal(F.parseLoginUrl('see https://evil.example.com/dash.cloudflare.com'), null, 'only a cloudflare.com address');
  assert.deepEqual(F.parseCreated(`Tunnel credentials written to /x.json.\n\nCreated tunnel hoprig-office with id ${ID.toUpperCase()}`), { name: 'hoprig-office', id: ID });
  assert.equal(F.parseCreated('failed to create tunnel'), null);
  assert.deepEqual(F.parseRoute(`2026-11-15T17:43:10Z INF Added CNAME office.example.com which will route to this tunnel tunnelID=${ID}`), { added: 'office.example.com' });
  assert.deepEqual(F.parseRoute('INF office.example.com is already configured to route to your tunnel tunnelID=x'), { already: 'office.example.com' });
  assert.deepEqual(F.parseRoute('ERR Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.'), { taken: true });
  assert.equal(F.parseRoute('something else'), null);
});

test('a tunnel token: alone or inside the install command the Cloudflare dashboard shows', () => {
  const token = Buffer.from(JSON.stringify({ a: 'acc', t: ID, s: 'c2VjcmV0' })).toString('base64');
  assert.deepEqual(F.parseToken(token), { token, tunnelId: ID });
  assert.deepEqual(F.parseToken(`sudo cloudflared service install ${token}`), { token, tunnelId: ID });
  for (const bad of ['', 'hello', `eyJ${'x'.repeat(30)}`, Buffer.from(JSON.stringify({ a: 1 })).toString('base64')]) assert.throws(() => F.parseToken(bad), /not a tunnel token/);
});

test('the command lines: arrays, our own files, never ~/.cloudflared or the computer\'s config', () => {
  const f = { cert: '/s/fixed-link/home/.cloudflared/cert.pem', base: '/s/fixed-link/base.yml' };
  assert.deepEqual(F.loginArgv('/b/cf', f), ['/b/cf', 'tunnel', '--config', f.base, 'login']);
  assert.deepEqual(F.createArgv('/b/cf', f, '/s/t.json', 'hoprig-office'), ['/b/cf', 'tunnel', '--config', f.base, '--origincert', f.cert, 'create', '--cred-file', '/s/t.json', 'hoprig-office']);
  assert.deepEqual(F.routeArgv('/b/cf', f, ID, 'office.example.com'), ['/b/cf', 'tunnel', '--config', f.base, '--origincert', f.cert, 'route', 'dns', ID, 'office.example.com']);
  assert.deepEqual(F.deleteArgv('/b/cf', f, ID), ['/b/cf', 'tunnel', '--config', f.base, '--origincert', f.cert, 'delete', '-f', ID]);
  assert.deepEqual(F.runArgv('/b/cf', '/s/config.yml', ID), ['/b/cf', 'tunnel', '--no-autoupdate', '--config', '/s/config.yml', 'run', ID]);
  assert.deepEqual(F.runTokenArgv('/b/cf', '/s/config.yml', '/s/token'), ['/b/cf', 'tunnel', '--no-autoupdate', '--config', '/s/config.yml', 'run', '--token-file', '/s/token']);
  assert.ok(F.certFile().startsWith(fixedDir + path.sep), F.certFile());
  const env = C.cloudflaredEnv('/s/home', '/s/empty', { HOME: '/home/someone', PATH: '/usr/bin', TUNNEL_TOKEN: 'x', ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'http://proxy.example.com:3128' });
  assert.deepEqual(env, { HOME: '/s/home', USERPROFILE: '/s/home', PATH: '/s/empty', HTTPS_PROXY: 'http://proxy.example.com:3128' });
});

test('the config file: the dashboard first, each other service, then nothing', () => {
  const y = F.configYaml({ tunnelId: ID, creds: '/s/tunnel.json', hostname: 'office.example.com', port: 7433, extra: [{ hostname: 'trouteai-office.example.com', port: 20017 }] });
  assert.equal(y, `# Written by Hoprig for the fixed address; it is written again at each start.\ntunnel: "${ID}"\ncredentials-file: "/s/tunnel.json"\ningress:\n`
    + '  - hostname: "office.example.com"\n    service: "http://127.0.0.1:7433"\n'
    + '  - hostname: "trouteai-office.example.com"\n    service: "http://127.0.0.1:20017"\n'
    + '  - service: "http_status:404"\n');
});

test('starting again: 2 s, then twice as long each time up to 5 min; a run of a minute starts the count again; off means off', () => {
  assert.deepEqual([0, 1, 2, 3, 7, 8, 20].map(F.backoffMs), [2000, 4000, 8000, 16000, 256000, 300000, 300000]);
  let clock = 0;
  const timers = [];
  const kids = [];
  const sup = F.makeSupervisor({
    now: () => clock,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: (id) => (timers[id - 1].cleared = true),
    spawnFn: (cmd, args, o) => {
      const c = Object.assign(new EventEmitter(), { pid: 100 + kids.length, cmd, args, env: o.env, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
      c.kill = () => { c.signalCode = 'SIGTERM'; c.emit('exit', null, 'SIGTERM'); };
      kids.push(c);
      return c;
    },
  });
  sup.run(['/b/cf', 'tunnel', 'run', ID], { HOME: '/s' });
  assert.deepEqual([kids.length, kids[0].cmd, kids[0].args, kids[0].env], [1, '/b/cf', ['tunnel', 'run', ID], { HOME: '/s' }]);
  kids[0].stderr.emit('data', '2026-11-15T17:44:01Z INF Registered tunnel connection connIndex=0\n');
  assert.equal(sup.state().connected, true);
  const crash = (i) => {
    kids[i].stderr.emit('data', '2026-11-15T17:44:02Z ERR Couldn\'t start tunnel: no network\n');
    kids[i].emit('exit', 1, null);
  };
  crash(0);
  assert.deepEqual([sup.state().running, sup.state().connected, sup.state().error, timers.at(-1).ms], [false, false, 'Couldn\'t start tunnel: no network', 2000]);
  timers.at(-1).fn();
  crash(1);
  assert.equal(timers.at(-1).ms, 4000);
  timers.at(-1).fn();
  crash(2);
  assert.equal(timers.at(-1).ms, 8000);
  timers.at(-1).fn();
  clock += F.STABLE_MS; // this one ran for a minute
  crash(3);
  assert.equal(timers.at(-1).ms, 2000, 'after a good run, the short wait again');
  assert.equal(sup.state().restarts, 4);
  sup.stop();
  assert.equal(timers.at(-1).cleared, true, 'off: no start is waiting');
  assert.equal(kids.length, 4);
  sup.run(['/b/cf'], {});
  kids[4].kill(); // ended from outside while it should run: started again
  assert.equal(timers.length, 5);
  timers.at(-1).fn();
  assert.equal(kids.length, 6);
  sup.stop(); // stopped by its owner: never started again
  assert.equal(timers.length, 5, 'a program it stopped itself is not started again');
  assert.equal(sup.state().running, false);
});

test('another service: its port, and whether it has a sign-in of its own', async () => {
  assert.deepEqual(L.checkPort('20017', 7433), { port: 20017 });
  assert.match(L.checkPort(7433, 7433).error, /dashboard itself/);
  for (const bad of [0, 70000, 'x', 1.5]) assert.ok(L.checkPort(bad, 7433).error);
  const site = (pages) => async (url) => {
    const p = new URL(url).pathname;
    const [status, location, body = ''] = pages[p] || [404];
    if (status === 'down') throw new Error('ECONNREFUSED');
    return { status, headers: new Headers(location ? { location } : {}), text: async () => body };
  };
  // TRouteAI: / → /dashboard → /login, and /v1/models answers 401 without a key, as it answered on this computer.
  const trouteai = { '/': [307, 'http://127.0.0.1:20017/dashboard'], '/dashboard': [307, '/login'], '/v1/models': [401], '/api/v1/models': [401] };
  const look = await L.serviceLogin(20017, { fetchImpl: site(trouteai) });
  assert.deepEqual(look, { answers: true, login: true, openApi: null });
  assert.equal(L.exposureQuestion(20017, look), null, 'a sign-in page and a closed API: no question');
  assert.deepEqual(await L.serviceLogin(1, { fetchImpl: site({ '/': [200, null, '<form><input type="password" name="p"></form>'] }) }), { answers: true, login: true, openApi: null });
  assert.deepEqual(await L.serviceLogin(1, { fetchImpl: site({ '/': [401] }) }), { answers: true, login: true, openApi: null });
  assert.deepEqual(await L.serviceLogin(1, { fetchImpl: site({ '/': [200, null, '<h1>Files</h1>'] }) }), { answers: true, login: false, openApi: null });
  assert.deepEqual(await L.serviceLogin(1, { fetchImpl: site({ '/': ['down'] }) }), { answers: false, login: false, openApi: null });
  // A login page at / but an API that answers without a key: always a question, saying so.
  for (const p of L.API_PATHS) {
    const open = await L.serviceLogin(20017, { fetchImpl: site({ ...trouteai, [p]: [200, null, '{"data":[]}'] }) });
    assert.deepEqual(open, { answers: true, login: true, openApi: p }, p);
    assert.equal(L.exposureQuestion(20017, open), `Port 20017 answers its API (${p}) without a key: anyone who has its address can use it, with whatever keys the service holds.`);
  }
  // An API that sends a stranger to its login is not open (redirects are not followed).
  assert.equal((await L.serviceLogin(1, { fetchImpl: site({ ...trouteai, '/v1/models': [302, '/login'] }) })).openApi, null);
  // No key is ever sent: the requests carry no headers.
  const sent = [];
  await L.serviceLogin(1, { fetchImpl: async (url, o) => (sent.push([new URL(url).pathname, o.headers]), { status: 401, headers: new Headers(), text: async () => '' }) });
  assert.deepEqual(sent, [['/', undefined], ['/v1/models', undefined], ['/api/v1/models', undefined], ['/api/models', undefined]]);
  assert.match(L.exposureQuestion(1, { login: false, openApi: '/v1/models' }), /^Port 1 shows no sign-in page of its own and answers its API \(\/v1\/models\) without a key/);
});

// ---------- the whole flow, against the stand-in ----------

/** A local service on a free port: with a sign-in page (redirects to /login) or without; `openApi`: /v1/models answers without a key. */
function service(withLogin, { openApi = false } = {}) {
  const s = http.createServer((req, res) => {
    if (openApi && req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
    if (withLogin && req.url !== '/login') return res.writeHead(302, { Location: '/login' }).end();
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(withLogin ? '<input type="password">' : '<h1>Open</h1>');
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

test('set up from the page: sign in, make it, it runs and comes back after a crash; another service; off and on; stop using it', async () => {
  saveConfig({ server: { port: 7433, allowedOrigins: ['https://deck.example.net'] } });
  const before = raw().server;
  assert.equal((await publicLink.status()).fixed.state, 'none');
  assert.equal(S.status().kinds.find((k) => k.id === 'custom').ready, false);

  // 1. Sign in: the link comes back; cloudflared waits until Cloudflare is approved, then the certificate is ours.
  const s1 = await act('fixed-sign-in');
  assert.equal(s1.ok, true, s1.error);
  assert.match(s1.url, /^https:\/\/dash\.cloudflare\.com\/argotunnel\?/);
  let st = F.fixedStatus();
  assert.deepEqual([st.state, st.loginUrl, st.suggested], ['signing-in', s1.url, 'dev-office']);
  assert.equal((await act('fixed-sign-in')).url, s1.url, 'a second press shows the same link');
  fs.writeFileSync(mark('approve'), '');
  assert.ok(await until(() => F.fixedStatus().state === 'signed-in'), 'the certificate arrived');
  assert.equal(mode(F.certFile()), '600');
  const login = calls().find((c) => c.a.includes('login'));
  assert.equal(login.home, path.join(fixedDir, 'home'), 'its own HOME: never the owner\'s ~/.cloudflared');
  assert.equal(login.path, path.join(fixedDir, 'empty'), 'a PATH with nothing to open a browser with');
  assert.ok(!login.keys.some((k) => /^(TUNNEL_|ANTHROPIC_)/.test(k)), login.keys.join(' '));

  // 2. Make it: without a password, no.
  assert.match((await act('fixed-create', { hostname: 'office.example.com' })).error, /password/);
  strongPassword();
  const beforeOn = raw().server;
  assert.match((await act('fixed-create', { hostname: 'office' })).error, /not an address/);
  const made = await act('fixed-create', { hostname: 'Office.example.com' });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.url, 'https://office.example.com');
  assert.ok(made.lines.some((l) => /Created tunnel hoprig-office-example-com with id/.test(l)), made.lines.join('\n'));
  assert.deepEqual(choice(), { on: true, kind: 'custom' }, 'made: the switch is on as Custom');
  const create = calls().find((c) => c.a.includes('create'));
  assert.deepEqual(create.a.slice(-3), ['--cred-file', path.join(fixedDir, 'tunnel.json'), 'hoprig-office-example-com']);
  assert.deepEqual(calls().find((c) => c.a.includes('route')).a.slice(-3), ['dns', ID, 'office.example.com']);

  // 3. It runs, connects, and the settings are as for any public link.
  assert.ok(await until(on), 'connected');
  for (const f of ['tunnel.json', 'config.yml', 'fixed.json', 'base.yml']) assert.equal(mode(path.join(fixedDir, f)), '600', f);
  assert.equal(mode(fixedDir), '700');
  st = F.fixedStatus();
  assert.deepEqual([st.state, st.mode, st.url], ['ready', 'named', 'https://office.example.com']);
  const sw = S.status();
  assert.deepEqual([sw.on, sw.kind, sw.url, sw.error], [true, 'custom', 'https://office.example.com', null]);
  assert.equal(loadConfig().server.trustProxy, true);
  assert.deepEqual(loadConfig().server.allowedOrigins, ['https://deck.example.net', 'https://office.example.com']);
  assert.match(fs.readFileSync(mark('last-config.yml'), 'utf8'), /hostname: "office\.example\.com"\n {4}service: "http:\/\/127\.0\.0\.1:7433"/);
  assert.ok(!JSON.stringify(await publicLink.status()).includes('c2VjcmV0'), 'no secret in the status');
  assert.ok(!JSON.stringify(S.status()).includes('c2VjcmV0'), 'no secret in the switch\'s state');

  // 4. cloudflared dies: it is started again by itself.
  const pid = S.readRecord().pid;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  assert.ok(await until(() => S.status().state === 'retrying', 3000));
  assert.ok(S.status().nextTryAt > Date.now(), 'waits before the next start');
  assert.ok(await until(on, 6000), 'started again and connected');
  assert.equal(S.status().restarts, 1);

  // 5. Another service: with a sign-in of its own it is added; without, only after a confirm.
  const withLogin = await service(true);
  const open = await service(false);
  const leaky = await service(true, { openApi: true }); // a login page at /, but its API answers without a key
  try {
    const p3 = leaky.address().port;
    const q = await act('fixed-add-service', { port: p3, hostname: 'leaky-office.example.com' });
    assert.equal(q.ok, false);
    assert.equal(q.confirm, `Port ${p3} answers its API (/v1/models) without a key: anyone who has its address can use it, with whatever keys the service holds.`);
    assert.equal(F.fixedStatus().extra.length, 0, 'nothing made before the confirm');
    const p1 = withLogin.address().port;
    assert.match((await act('fixed-add-service', { port: 7433, hostname: 'x.example.com' })).error, /dashboard itself/);
    assert.match((await act('fixed-add-service', { port: p1, hostname: 'office.example.com' })).error, /in use already/);
    const added = await act('fixed-add-service', { port: p1, hostname: 'trouteai-office.example.com' });
    assert.equal(added.ok, true, added.error);
    assert.deepEqual(F.fixedStatus().extra, [{ hostname: 'trouteai-office.example.com', port: p1, url: 'https://trouteai-office.example.com' }]);
    assert.ok(await until(() => on() && /trouteai-office/.test(fs.readFileSync(mark('last-config.yml'), 'utf8'))), 'runs again with the new rule');
    const p2 = open.address().port;
    const ask = await act('fixed-add-service', { port: p2, hostname: 'files-office.example.com' });
    assert.deepEqual([ask.ok, /no sign-in page of its own/.test(ask.confirm)], [false, true]);
    assert.equal(F.fixedStatus().extra.length, 1, 'nothing made before the confirm');
    assert.equal((await act('fixed-add-service', { port: p2, hostname: 'files-office.example.com', confirmed: true })).ok, true);
    assert.match((await act('fixed-add-service', { port: p2, hostname: 'taken.example.com', confirmed: true })).error, /already a DNS record/);
    const gone = await act('fixed-remove-service', { hostname: 'files-office.example.com' });
    assert.match(gone.lines.join(' '), /DNS record stays in Cloudflare/);
    assert.equal(F.fixedStatus().extra.length, 1);
  } finally {
    withLogin.close();
    open.close();
    leaky.close();
  }

  // 6. Off: it stops and the settings go back; on again: the same address.
  assert.equal((await act('fixed-off')).ok, true);
  assert.deepEqual([S.status().on, S.status().state, F.fixedStatus().url], [false, 'off', 'https://office.example.com']);
  assert.deepEqual(raw().server, beforeOn);
  assert.equal((await act('fixed-on')).ok, true);
  assert.ok(await until(on));

  // 7. When the dashboard stops it stops too, and when it starts it runs again.
  await S.detach();
  assert.equal(S.readRecord().pid, null);
  assert.deepEqual(raw().server, beforeOn, 'the settings go back while the dashboard is stopped');
  await S.attach({ everyMs: 60_000 });
  assert.ok(await until(on), 'back with the dashboard');

  // 8. Stop using it: the switch goes off, the tunnel is deleted in Cloudflare, the DNS records are named, every file here goes.
  const forget = await act('fixed-forget');
  assert.equal(forget.ok, true);
  assert.deepEqual(calls().filter((c) => c.a.includes('delete')).at(-1).a.slice(-3), ['delete', '-f', ID]);
  const said = forget.lines.join('\n');
  assert.match(said, /Deleted the tunnel "hoprig-office-example-com" in your Cloudflare account/);
  assert.match(said, /DNS records for office\.example\.com, trouteai-office\.example\.com stay in Cloudflare/);
  assert.equal(fs.existsSync(fixedDir), false);
  assert.equal(F.fixedStatus().state, 'none');
  assert.deepEqual(loadConfig().publicLink, { on: false, kind: 'temporary' });
  assert.deepEqual(raw().server, beforeOn, 'settings exactly as before');
  assert.notDeepEqual(before, beforeOn); // (only the password was added in between)
});

test('state files are written whole or not at all: a temporary file in the same folder, then a rename', () => {
  const dir = path.join(tmp, 'atomic');
  const file = path.join(dir, 'fixed.json');
  C.writeAtomic(file, '{"mode":"named"}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mode":"named"}');
  assert.equal(mode(file), '600');
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (from, to) => (renames.push([path.dirname(from), to]), orig(from, to));
  try {
    C.writeAtomic(file, '{"mode":"token"}');
  } finally {
    fs.renameSync = orig;
  }
  assert.deepEqual(renames, [[dir, file]], 'renamed from the same folder');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mode":"token"}');
  // A write that fails half way leaves the old file as it was and no temporary file behind.
  const write = fs.writeFileSync;
  fs.writeFileSync = (f, d, o) => { write(f, String(d).slice(0, 3), o); throw new Error('disk full'); };
  try {
    assert.throws(() => C.writeAtomic(file, '{"mode":"broken"}'), /disk full/);
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mode":"token"}');
  assert.deepEqual(fs.readdirSync(dir), ['fixed.json']);
  // The add-on's own state goes through it (no plain write of a tunnel's details is left).
  const src = ['fixedlink.mjs', 'publiclink.mjs'].map((f) => fs.readFileSync(new URL(`../../src/addons/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.deepEqual([...src.matchAll(/fs\.writeFileSync\(([^,]+),/g)].map((m) => m[1]), ['file'], 'only the downloaded program itself');
});

test('a name outside the domain picked at sign-in: nothing is left half-made', async () => {
  fs.mkdirSync(path.dirname(F.certFile()), { recursive: true });
  fs.writeFileSync(F.certFile(), 'stand-in', { mode: 0o600 });
  const n = calls().length;
  const r = await act('fixed-create', { hostname: 'office.other.net' });
  assert.equal(r.ok, false);
  assert.match(r.error, /made the record office\.other\.net\.example\.com instead/);
  assert.ok(calls().slice(n).some((c) => c.a.includes('delete')), 'the tunnel made a moment ago is deleted again');
  assert.equal(F.fixedStatus().state, 'signed-in');
  assert.equal(fs.existsSync(path.join(fixedDir, 'tunnel.json')), false);
});

test('a tunnel of that name made before is used; the token cloudflared prints never shows', async () => {
  fs.writeFileSync(mark('taken-name'), '');
  try {
    const r = await act('fixed-create', { hostname: 'pc3.example.com' });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.lines.some((l) => /is there already/.test(l)));
    assert.ok(!r.lines.join('\n').includes('MUST-NOT-SHOW'), r.lines.join('\n'));
    assert.ok(await until(on));
  } finally {
    fs.rmSync(mark('taken-name'));
  }
  assert.equal((await act('fixed-forget')).ok, true);
});

test('when cloudflared keeps failing, the page says why and when it tries again', async () => {
  fs.mkdirSync(path.dirname(F.certFile()), { recursive: true });
  fs.writeFileSync(F.certFile(), 'stand-in', { mode: 0o600 });
  fs.writeFileSync(mark('crash'), '');
  try {
    assert.equal((await act('fixed-create', { hostname: 'pc4.example.com' })).ok, true);
    assert.ok(await until(() => S.status().error && S.status().nextTryAt), 'an error and a next try');
    assert.equal(S.status().state, 'retrying');
    assert.match(S.status().error, /stand-in crash/);
  } finally {
    fs.rmSync(mark('crash'));
  }
  assert.ok(await until(on, 8000), 'it recovers by itself once cloudflared works');
  assert.equal((await act('fixed-forget')).ok, true);
});

test('Advanced: a tunnel token from the Cloudflare dashboard; it is kept in a file and never shown', async () => {
  const token = Buffer.from(JSON.stringify({ a: 'acc', t: ID, s: 'c2VjcmV0LXNlY3JldA==' })).toString('base64');
  assert.match((await act('fixed-token', { token: 'nope', hostname: 'office.example.com' })).error, /not a tunnel token/);
  const r = await act('fixed-token', { token: `cloudflared service install ${token}`, hostname: 'office.example.com' });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(fixedDir, 'token'), 'utf8'), token);
  assert.equal(mode(path.join(fixedDir, 'token')), '600');
  assert.ok(await until(on));
  const run = calls().filter((c) => c.a.includes('run')).at(-1);
  assert.deepEqual(run.a.slice(-3), ['run', '--token-file', path.join(fixedDir, 'token')]);
  assert.ok(!run.a.includes(token), 'the token is not on the command line');
  const all = JSON.stringify([await publicLink.status(), S.status()]);
  assert.ok(!all.includes(token) && !all.includes('c2VjcmV0'), 'never in the status');
  assert.equal(F.fixedStatus().mode, 'token');
  assert.match((await act('fixed-add-service', { port: 20017, hostname: 'x.example.com' })).error, /Cloudflare dashboard/);
  const f = await act('fixed-forget');
  assert.match(f.lines.join(' '), /stay in your Cloudflare dashboard/);
  assert.equal(fs.existsSync(fixedDir), false);
});
