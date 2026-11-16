// setup --hub's HTTPS step against fake web servers, a fake DNS and a scratch /etc/caddy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, pathWith, recorder, scratch, snapshot } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const K = await import('../../src/setup/checks.mjs');
const HS = await import('../../src/setup/hubsetup.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { loadConfig } = await import('../../src/config.mjs');
const { which } = await import('../../src/setup/system.mjs');

const IP = '95.216.1.2';
const resolver = (a) => ({ resolve4: async () => a, resolve6: async () => { throw new Error('ENODATA'); } });
const web = (kind, extra = {}) => async () => ({ kind, busy: kind !== 'none', ...extra });

function sys(dir, programs = {}) {
  const bin = fakeBin(path.join(s.tmp, dir), programs);
  const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
  return K.sysInfo({ env, has: (c) => !!which(c, env, 'linux'), platform: 'linux', pm: 'apt', root: true, publicIps: [IP], serviceSupported: false });
}
const ui = (o = {}) => {
  const rec = recorder();
  return { rec, ui: makeUi({ interactive: false, write: rec.write, askLine: async () => { throw new Error('no questions'); }, ...o }) };
};
const cfgFiles = () => snapshot(process.env.HOPRIG_CONFIG_DIR);

test('the address: a domain, --ip, this server\'s public IP, or none (a hub at home)', () => {
  assert.deepEqual(HS.hubAddress({ domain: 'Hub.Example.com' }, [IP]), { address: 'hub.example.com', ip: false });
  assert.deepEqual(HS.hubAddress({ ip: '8.8.8.8' }, []), { address: '8.8.8.8', ip: true });
  assert.deepEqual(HS.hubAddress({}, [IP]), { address: IP, ip: true });
  assert.equal(HS.hubAddress({}, []), null);
  assert.equal(HS.hubAddress({ ip: '192.168.1.5' }, []), null);
});

test('DNS not pointing here: says which record to create, changes nothing, stops', async () => {
  const before = cfgFiles();
  const { ui: u, rec } = ui({ yes: true });
  const r = await HS.stepHttps(u, sys('dns'), { domain: 'hub.example.com' }, {}, { resolver: resolver(['1.2.3.4']), detect: web('none') });
  assert.equal(r, false);
  assert.match(rec.text, /hub\.example\.com does not point to this server yet \(it points to 1\.2\.3\.4\)/);
  assert.match(rec.text, /A record {3}hub\.example\.com {3}→ {3}95\.216\.1\.2/);
  assert.match(rec.text, /setup --hub --domain hub\.example\.com/);
  assert.deepEqual(cfgFiles(), before);
});

test('nginx owns 80/443: the block is printed, nginx untouched, the hub\'s own settings set', async () => {
  const { ui: u, rec } = ui({ yes: true });
  const state = {};
  assert.equal(await HS.stepHttps(u, sys('nginx'), { domain: 'hub.example.com' }, state, { resolver: resolver([IP]), detect: web('nginx') }), true);
  assert.match(rec.text, /nginx already serves ports 80\/443; hoprig does not change it/);
  assert.match(rec.text, /proxy_set_header Upgrade \$http_upgrade;/);
  const srv = loadConfig().server;
  assert.deepEqual([srv.host, srv.trustProxy, srv.allowedOrigins, srv.publicUrl], ['127.0.0.1', true, ['https://hub.example.com'], 'https://hub.example.com/']);
  assert.equal(state.phoneUrl, 'https://hub.example.com/');
});

test('Apache and a control panel: printed, never written', async () => {
  const a = ui({ yes: true });
  await HS.stepHttps(a.ui, sys('apache'), { domain: 'hub.example.com' }, {}, { resolver: resolver([IP]), detect: web('apache') });
  assert.match(a.rec.text, /ProxyPass \/ http:\/\/127\.0\.0\.1:7433\/ upgrade=websocket/);
  const p = ui({ yes: true });
  await HS.stepHttps(p.ui, sys('panel'), { domain: 'hub.example.com' }, {}, { resolver: resolver([IP]), detect: web('panel', { panel: 'cPanel' }) });
  assert.match(p.rec.text, /cPanel manages the web server here/);
});

test('an IP certificate needs 80/443 for Caddy: something else there stops it with the reason', async () => {
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await HS.stepHttps(u, sys('ipblocked'), {}, {}, { detect: web('nginx') }), false);
  assert.match(rec.text, /nginx already uses ports 80\/443/);
});

test('--dry-run: lists every step (install Caddy, our site, the import), writes nothing', async () => {
  const caddyDir = path.join(s.tmp, 'etc-caddy-dry');
  const before = cfgFiles();
  const { ui: u, rec } = ui({ dryRun: true });
  await HS.stepHttps(u, sys('dry', { ufw: 'exit 0', systemctl: '[ "$2" = ufw ] && echo active || echo inactive' }), {}, {}, { detect: web('none'), caddyDir });
  assert.match(rec.text, /HTTPS for https:\/\/95\.216\.1\.2 with Caddy \(a Let's Encrypt certificate for the IP address/);
  assert.match(rec.text, /apt-get install -y caddy/);
  assert.match(rec.text, /write .*hoprig\.caddy \(our site: https:\/\/95\.216\.1\.2 → 127\.0\.0\.1:7433\)/);
  assert.match(rec.text, /ufw allow 80,443\/tcp/);
  assert.match(rec.text, /\(dry run\) would ask: Go ahead\?/);
  assert.equal(fs.existsSync(caddyDir), false);
  assert.deepEqual(cfgFiles(), before);
});

test('Caddy already installed: our site written, imported once, validated, reloaded; a second run changes nothing', async () => {
  const caddyDir = path.join(s.tmp, 'etc-caddy');
  fs.mkdirSync(caddyDir, { recursive: true });
  fs.writeFileSync(path.join(caddyDir, 'Caddyfile'), ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n');
  const log = path.join(s.tmp, 'caddy.log');
  const programs = {
    // install -m 644 -D <tmp> <dest>
    install: '/bin/mkdir -p "$(/usr/bin/dirname "$5")" && /bin/cp "$4" "$5"',
    cp: `/bin/cp "$@"`,
    caddy: `echo "$@" >> "${log}"; exit 0`,
  };
  const state = {};
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await HS.stepHttps(u, sys('caddy', programs), { domain: 'hub.example.com' }, state, { resolver: resolver([IP]), detect: web('caddy'), caddyDir }), true, rec.text);
  assert.equal(fs.readFileSync(path.join(caddyDir, 'hoprig.caddy'), 'utf8').includes('hub.example.com {\n\treverse_proxy 127.0.0.1:7433\n}'), true);
  const caddyfile = fs.readFileSync(path.join(caddyDir, 'Caddyfile'), 'utf8');
  assert.equal(caddyfile.match(/import hoprig\.caddy/g).length, 1);
  assert.match(caddyfile, /file_server/, 'the existing site is kept');
  assert.ok(fs.existsSync(path.join(caddyDir, 'Caddyfile.before-hoprig')), 'a backup of the original');
  assert.match(fs.readFileSync(log, 'utf8'), /validate --config .*Caddyfile\nreload --config/);
  assert.equal(state.httpsOrigin, 'https://hub.example.com');

  const files = snapshot(caddyDir);
  const again = ui({ yes: true });
  await HS.stepHttps(again.ui, sys('caddy', programs), { domain: 'hub.example.com' }, {}, { resolver: resolver([IP]), detect: web('caddy'), caddyDir });
  assert.deepEqual(snapshot(caddyDir), files, 'nothing changed the second time');
  assert.doesNotMatch(again.rec.text, /Go ahead/, 'nothing to confirm');
});

test('a hub on an IP address: Caddy is installed quietly (output in a named log), default_sni is added; moving to a domain takes it out', async () => {
  const caddyDir = path.join(s.tmp, 'etc-caddy-ip');
  const pkgCaddyfile = ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n';
  const calls = path.join(s.tmp, 'ip-calls.log');
  const programs = {
    // the package manager: long output, and "installing caddy" puts the package's own Caddyfile in place
    env: `echo "$@" >> "${calls}"; echo "Reading package lists..."; echo "Setting up something (1.0) ..."; case "$*" in *"install -y caddy"*) /bin/mkdir -p "${caddyDir}"; printf '${pkgCaddyfile.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}' > "${caddyDir}/Caddyfile";; esac`,
    gpg: 'exit 0',
    // install -m 644 -D <tmp> <dest>: only into the scratch folder; the package source list in /etc is not written
    install: `case "$5" in "${caddyDir}"/*) /bin/mkdir -p "$(/usr/bin/dirname "$5")" && /bin/cp "$4" "$5" ;; esac`,
    cp: '/bin/cp "$@"',
    caddy: 'exit 0',
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => 'key or list' });
  test.after(() => { globalThis.fetch = realFetch; });
  const state = {};
  const { ui: u, rec } = ui({ yes: true });
  const fakeSys = sys('caddy-ip', programs);
  assert.equal(await HS.stepHttps(u, fakeSys, { ip: '192.168.1.9', tlsInternal: true }, state, { detect: web('none'), caddyDir }), true, rec.text);
  // said before it is done, with the reason
  assert.match(rec.text, /add "default_sni 192\.168\.1\.9" to the global options of .*Caddyfile \(a browser names no server when it opens an IP address\)/);
  // quiet: none of the package manager's output, and where it went
  assert.doesNotMatch(rec.text, /Reading package lists|Setting up something/);
  assert.match(rec.text, /Installing Caddy… \(the commands' output: .*setup-hub\.log\)/);
  const log = fs.readFileSync(HS.hubLog(), 'utf8');
  assert.match(log, /^\$ env DEBIAN_FRONTEND=noninteractive apt-get update\nReading package lists\.\.\./);
  assert.match(log, /\$ env DEBIAN_FRONTEND=noninteractive apt-get install -y caddy\n/);
  assert.match(fs.readFileSync(calls, 'utf8'), /^DEBIAN_FRONTEND=noninteractive apt-get update\n/, 'apt is told not to ask');
  // the Caddyfile: global options first, the package's own site kept, our import last
  const caddyfile = fs.readFileSync(path.join(caddyDir, 'Caddyfile'), 'utf8');
  assert.match(caddyfile, /^# hoprig hub[^\n]*\n\{\n\tdefault_sni 192\.168\.1\.9 # hoprig hub\n\}\n\n:80 \{/);
  assert.match(caddyfile, /file_server\n\}\n\nimport hoprig\.caddy\n$/);
  assert.match(fs.readFileSync(path.join(caddyDir, 'hoprig.caddy'), 'utf8'), /192\.168\.1\.9 \{\n\ttls internal\n\treverse_proxy 127\.0\.0\.1:7433\n\}/);

  // the same again: nothing to do
  const again = ui({ yes: true });
  await HS.stepHttps(again.ui, fakeSys, { ip: '192.168.1.9', tlsInternal: true }, {}, { detect: web('caddy'), caddyDir });
  assert.doesNotMatch(again.rec.text, /Go ahead/);
  // the hub moves to a domain: its name is always sent, our line goes
  const moved = ui({ yes: true });
  assert.equal(await HS.stepHttps(moved.ui, fakeSys, { domain: 'hub.example.com' }, {}, { resolver: resolver([IP]), detect: web('caddy'), caddyDir }), true, moved.rec.text);
  assert.match(moved.rec.text, /take our "default_sni" line \(from an earlier IP address\) out of/);
  assert.equal(fs.readFileSync(path.join(caddyDir, 'Caddyfile'), 'utf8'), `${pkgCaddyfile}\nimport hoprig.caddy\n`);
});

test('a command of the HTTPS step that fails: its last lines are shown, and where all of it is', async () => {
  const caddyDir = path.join(s.tmp, 'etc-caddy-fail');
  const programs = { env: 'echo "Reading package lists..."; echo "E: Unable to locate package caddy" >&2; exit 100' };
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await HS.stepHttps(u, sys('caddy-fail', programs), {}, {}, { detect: web('none'), caddyDir }), false);
  assert.match(rec.text, /E: Unable to locate package caddy/);
  assert.match(rec.text, /All of its output: .*setup-hub\.log/);
  assert.match(rec.text, /"env DEBIAN_FRONTEND=noninteractive apt-get update" did not succeed/);
});

test('a configuration Caddy refuses: the Caddyfile is put back', async () => {
  const caddyDir = path.join(s.tmp, 'etc-caddy-bad');
  fs.mkdirSync(caddyDir, { recursive: true });
  fs.writeFileSync(path.join(caddyDir, 'Caddyfile'), 'example.org {\n\trespond "hi"\n}\n');
  const programs = { install: '/bin/mkdir -p "$(/usr/bin/dirname "$5")" && /bin/cp "$4" "$5"', cp: '/bin/cp "$@"', caddy: 'echo "Error: adapting config using caddyfile: bad" >&2; exit 1' };
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await HS.stepHttps(u, sys('caddybad', programs), { domain: 'hub.example.com' }, {}, { resolver: resolver([IP]), detect: web('caddy'), caddyDir }), false);
  assert.match(rec.text, /Caddy does not accept the configuration: Error: adapting config/);
  assert.equal(fs.readFileSync(path.join(caddyDir, 'Caddyfile'), 'utf8'), 'example.org {\n\trespond "hi"\n}\n');
});

test('without a terminal and without --yes nothing is installed or written', async () => {
  const caddyDir = path.join(s.tmp, 'etc-caddy-noask');
  const { ui: u } = ui();
  await HS.stepHttps(u, sys('noask'), {}, {}, { detect: web('none'), caddyDir });
  assert.equal(fs.existsSync(caddyDir), false);
});

test('setup: plain http on a public address is refused with the reason', async () => {
  const { ui: u, rec } = ui({ yes: true });
  assert.equal(await SU.stepAccess(u, sys('public'), { access: 'network' }, {}), false);
  assert.match(rec.text, /Not over plain http: this computer has a public address \(95\.216\.1\.2\)/);
});

test('setup: "from anywhere" explains the three ways', async () => {
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), '{}');
  const answers = ['3', 'b'];
  const rec = recorder();
  const u = makeUi({ interactive: true, write: rec.write, askLine: async () => answers.shift() });
  const S = sys('anywhere');
  S.publicIps = [];
  await SU.stepAccess(u, S, {}, {});
  assert.match(rec.text, /3 {2}from anywhere/);
  assert.match(rec.text, /a {2}I have a server: make it the hub/);
  assert.match(rec.text, /b {2}a public link \(free, through Cloudflare, no server: a new address at each start, or your own domain\)/);
  assert.match(rec.text, /hoprig public on/);
  assert.equal(loadConfig().server.host, '127.0.0.1', 'this computer only, until the link is started');
});
