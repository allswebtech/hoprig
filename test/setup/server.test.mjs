// What counts as a server for the access question (src/setup/server.mjs), and set-up's access step on one: no
// "devices on my network", --access network refused with the reason, an earlier open dashboard closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);

const SV = await import('../../src/setup/server.mjs');
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { which } = await import('../../src/setup/system.mjs');

const PATH = pathWith(s.tmp, fakeBin(path.join(s.tmp, 'bin'), {}));
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SSH_|DISPLAY$|WAYLAND_DISPLAY$)/.test(k)));
function sys({ env = {}, ...over } = {}) {
  const e = { ...CLEAN, PATH, ...env }; // seal: only the test's own folders, in an environment that keeps the runner's variables
  return K.sysInfo({ env: e, platform: 'linux', has: (c) => !!which(c, e, 'linux'), pm: null, root: false, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, user: 'alex', ...over });
}
const SSH = { SSH_CONNECTION: '192.168.1.20 50000 10.0.0.5 22' };

test('a server: a public address, ssh with no desktop, or a cloud named by the hardware; a desktop is not one', () => {
  assert.deepEqual(SV.serverReason(sys({ publicIps: ['203.0.114.7'] })), { kind: 'public', address: '203.0.114.7' });
  assert.deepEqual(SV.serverReason(sys({ env: SSH })), { kind: 'ssh' });
  assert.deepEqual(SV.serverReason(sys({ env: { SSH_TTY: '/dev/pts/0' } })), { kind: 'ssh' });
  assert.deepEqual(SV.serverReason(sys({ env: { ...SSH, DISPLAY: 'localhost:10.0' } })), { kind: 'ssh' }, 'a display ssh forwards is no desktop');
  assert.equal(SV.serverReason(sys({ env: { ...SSH, DISPLAY: ':0' } })), null, 'ssh into a computer with a desktop session');
  assert.equal(SV.serverReason(sys({ env: { ...SSH, WAYLAND_DISPLAY: 'wayland-0' } })), null);
  // An ssh login never carries the desktop's DISPLAY: a desktop of the computer's own (an X or Wayland socket) is seen
  // on the computer itself.
  assert.equal(SV.serverReason(sys({ env: SSH, localDisplay: true })), null, 'ssh into a home desktop with a graphical session');
  assert.equal(SV.serverReason(sys()), null, 'a desktop at home, private addresses only');
  for (const platform of ['darwin', 'win32']) assert.equal(SV.serverReason(sys({ env: SSH, platform })), null, `${platform}: a desktop is assumed`);
  const clouds = [
    [{ vendor: 'Google\n', product: 'Google Compute Engine\n' }, 'Google Compute Engine'],
    [{ vendor: 'Amazon EC2', product: 'm7i.large' }, 'Amazon EC2'],
    [{ vendor: 'Microsoft Corporation', product: 'Virtual Machine', assetTag: '7783-7084-3265-9085-8269-3286-77\n' }, 'Microsoft Azure'],
    // An older EC2 instance on Xen: its uuid, BIOS or hypervisor file says so, its vendor and product do not.
    [{ vendor: 'Xen', product: 'HVM domU', uuid: 'EC2E1916-9099-7CAF-FD21-012345ABCDEF' }, 'Amazon EC2'],
    [{ vendor: 'Xen', product: 'HVM domU', uuid: '45E12AEC-DCD1-B213-94ED-012345ABCDEF' }, 'Amazon EC2'],
    [{ vendor: 'Xen', product: 'HVM domU', biosVersion: '4.11.amazon' }, 'Amazon EC2'],
    [{ vendor: 'Xen', product: 'HVM domU', hvUuid: 'ec2a1b2c-0000-0000-0000-000000000000\n' }, 'Amazon EC2'],
    [{ vendor: 'Amazon EC2', product: 'm7i.large', biosVendor: 'Amazon EC2' }, 'Amazon EC2'],
    [{ vendor: 'DigitalOcean', product: 'Droplet' }, 'DigitalOcean'],
    [{ vendor: 'Hetzner', product: 'vServer' }, 'Hetzner'],
    [{ vendor: 'OpenStack Foundation', product: 'OpenStack Nova' }, 'OpenStack'],
    [{ vendor: 'Linode', product: 'Compute Instance' }, 'Linode (Akamai)'],
    [{ vendor: 'Vultr', product: 'VC2' }, 'Vultr'],
    [{ vendor: 'QEMU', product: 'OracleCloud.com' }, 'Oracle Cloud'],
    [{ vendor: 'Alibaba Cloud', product: 'Alibaba Cloud ECS' }, 'Alibaba Cloud'],
    [{ vendor: 'Scaleway', product: 'SCW-DEV1-S' }, 'Scaleway'],
    [{ vendor: '  google  ', product: '' }, 'Google Compute Engine'],
  ];
  for (const [dmi, name] of clouds) assert.deepEqual(SV.serverReason(sys({ dmi })), { kind: 'cloud', name }, JSON.stringify(dmi));
  // Hyper-V on a home PC says exactly what Azure says, without Azure's asset tag; a Xen or QEMU guest at home has no
  // cloud's uuid or BIOS; a laptop's vendor is no cloud; a container has no files.
  for (const dmi of [
    { vendor: 'Microsoft Corporation', product: 'Virtual Machine', assetTag: '1234-5678-9012' },
    { vendor: 'Microsoft Corporation', product: 'Virtual Machine' },
    { vendor: 'Xen', product: 'HVM domU', uuid: '4C4C4544-0042-3510-8058-B4C04F395A31', biosVersion: '4.2' },
    { vendor: 'QEMU', product: 'Standard PC (Q35 + ICH9, 2009)', biosVendor: 'SeaBIOS' },
    { vendor: 'Dell Inc.', product: 'Virtual Machine' }, { vendor: 'LENOVO', product: '20XW' }, {},
  ]) assert.equal(SV.serverReason(sys({ dmi })), null, JSON.stringify(dmi));
  assert.equal(SV.serverReason(sys({ dmi: { vendor: 'Google' }, platform: 'darwin' })), null);
});

test('the ssh forward line: the real user, the ssh port, a host only when it is public', () => {
  // The local end is not the dashboard's own port: the person's own dashboard most likely listens there.
  assert.equal(SV.forwardLine(7433, sys({ env: SSH })), 'ssh -N -L 17433:127.0.0.1:7433 alex@<the address you use for ssh>', 'a private server address is never written');
  assert.equal(SV.forwardLine(7433, sys({ env: { SSH_CONNECTION: '192.168.1.20 50000 203.0.114.7 2222' } })), 'ssh -N -L 17433:127.0.0.1:7433 -p 2222 alex@203.0.114.7');
  assert.equal(SV.forwardLine(7500, sys({ publicIps: ['203.0.114.9'] })), 'ssh -N -L 17500:127.0.0.1:7500 alex@203.0.114.9');
  assert.equal(SV.localPortFor(60000), 59000, 'still a port');
});

test('a desktop is a local graphical session of this user; a display socket alone (Xvfb, VNC) is not one', { skip: process.platform === 'win32' && "Linux's login sessions, by the uid Windows does not have" }, async () => {
  const dir = fs.mkdtempSync(path.join(s.tmp, 'sessions-'));
  const me = process.getuid();
  const session = (name, f) => fs.writeFileSync(path.join(dir, name), Object.entries(f).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  assert.equal(SV.localDisplay({}, { sessionsDir: dir, uid: me }), false, 'no session at all');
  session('3', { UID: me, TYPE: 'tty', REMOTE: 1, CLASS: 'user' }); // the ssh login itself
  session('c1', { UID: me, TYPE: 'unspecified', REMOTE: 0, CLASS: 'manager' }); // the user's service manager
  assert.equal(SV.localDisplay({}, { sessionsDir: dir, uid: me }), false, 'an ssh login and the service manager are no desktop');
  // A headless browser's Xvfb and the user's own VNC server leave X and Wayland sockets, never a session like this.
  const xDir = fs.mkdtempSync(path.join(s.tmp, 'x11-'));
  fs.writeFileSync(path.join(xDir, 'X99'), '');
  assert.equal(SV.localDisplay({ DISPLAY: ':99' }, { sessionsDir: dir, uid: me, xDir }), false, 'an X socket of this user alone');
  session('5', { UID: me + 1, TYPE: 'x11', REMOTE: 0, CLASS: 'user' });
  assert.equal(SV.localDisplay({}, { sessionsDir: dir, uid: me }), false, 'another user\'s desktop');
  session('6', { UID: me, TYPE: 'x11', REMOTE: 1, CLASS: 'user' });
  assert.equal(SV.localDisplay({}, { sessionsDir: dir, uid: me }), false, 'a remote graphical session (xrdp)');
  session('7', { UID: me, TYPE: 'wayland', REMOTE: 0, CLASS: 'user' });
  assert.equal(SV.localDisplay({}, { sessionsDir: dir, uid: me }), true, 'a local Wayland login of this user');
});

test('a saved server reason is never deleted because a display appeared', () => {
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'server.json');
  SV.rememberServer({ kind: 'cloud', name: 'Amazon EC2' }, sys({ localDisplay: false }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).kind, 'cloud');
  SV.rememberServer(null, sys({ localDisplay: true })); // a run that sees a desktop (a VNC session counted once)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).kind, 'cloud', 'still saved');
  assert.equal(SV.serverReason(sys({ localDisplay: false, savedServer: undefined })).kind, 'cloud', 'and used again once no desktop is seen');
  fs.rmSync(file, { force: true });
});

const ui = (o = {}) => {
  const rec = recorder();
  return { rec, ui: makeUi({ interactive: false, write: rec.write, askLine: async () => '', ...o }) };
};
const fresh = () => fs.rmSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), { force: true });

test('set-up on a server: only this computer by default, "devices on my network" not offered', async () => {
  for (const S of [sys({ env: SSH }), sys({ dmi: { vendor: 'Google', product: 'Google Compute Engine' } })]) {
    fresh();
    const asked = [];
    const u = makeUi({ interactive: true, write: (t) => asked.push(t), askLine: async () => '' });
    assert.equal(await SU.stepAccess(u, S, {}, {}), true);
    const text = asked.join('');
    assert.doesNotMatch(text, /devices on my network/);
    assert.match(text, /1 {2}only this computer.*\(default\)\n {4}2 {2}from anywhere\n/);
    assert.doesNotMatch(text, / {4}3 {2}/, 'no number is missing');
    assert.equal(loadConfig().server.host, '127.0.0.1');
    fresh();
    const y = ui({ yes: true });
    await SU.stepAccess(y.ui, S, {}, {});
    assert.equal(loadConfig().server.host, '127.0.0.1', '--yes takes "only this computer"');
    // "2" is "from anywhere" there: its own question follows.
    fresh();
    const answers = ['2', 'b'];
    const two = [];
    await SU.stepAccess(makeUi({ interactive: true, write: (t) => two.push(t), askLine: async () => answers.shift() }), S, {}, {});
    assert.match(two.join(''), /How\?(?:.*\n)*.*hoprig public on/);
  }
});

test('--access network on a server is refused, naming the reason and what to use instead', async () => {
  for (const [S, why] of [
    [sys({ env: SSH }), /this is a server \(reached over ssh, with no desktop of its own\)/],
    [sys({ dmi: { vendor: 'Amazon EC2' } }), /a cloud server \(its hardware says Amazon EC2\)/],
    [sys({ publicIps: ['203.0.114.7'] }), /a public address \(203\.0\.114\.7\)/],
  ]) {
    fresh();
    for (const yes of [false, true]) {
      const { ui: u, rec } = ui({ yes });
      assert.equal(await SU.stepAccess(u, S, { access: 'network' }, {}), false);
      assert.match(rec.text, /✗ Not over plain http: /);
      assert.match(rec.text, why);
      assert.match(rec.text, /Computers → Add a computer → "I can reach it by SSH"/);
      assert.match(rec.text, /hoprig public on/);
      assert.match(rec.text, /Tailscale/);
      assert.match(rec.text, /ssh -N -L 17433:127\.0\.0\.1:7433/);
      assert.doesNotMatch(rec.text, /10\.0\.0\.5|192\.168/, 'never a private address');
      assert.equal(loadConfig().server.host, undefined, 'nothing written');
    }
  }
  // Already open (an earlier version, or by hand): refused, and closed to this computer, saying so.
  for (const host of ['0.0.0.0', '10.0.0.5']) {
    fresh();
    saveConfig({ server: { host } });
    const dry = ui({ dryRun: true });
    assert.equal(await SU.stepAccess(dry.ui, sys({ env: SSH }), { access: 'network' }, {}), false);
    assert.match(dry.rec.text, /Would close it to this computer only/);
    assert.equal(loadConfig().server.host, host, 'a dry run changes nothing');
    const { ui: u, rec } = ui({ yes: true });
    const state = {};
    assert.equal(await SU.stepAccess(u, sys({ env: SSH }), { access: 'network' }, state), false);
    assert.match(rec.text, /✗ Not over plain http: (?:.*\n)*.*✓ Closed it to this computer only \(it was open to the network\)/);
    assert.equal(loadConfig().server.host, '127.0.0.1', host);
    assert.equal(state.changed, true, 'the service is restarted with the new host');
  }
  // A desktop at home still may.
  fresh();
  await SU.stepAccess(ui().ui, sys(), { access: 'network' }, {});
  assert.equal(loadConfig().server.host, '0.0.0.0');
});

test('set-up again on a server whose dashboard is open to the network: said, and closed after a yes', async () => {
  for (const host of ['0.0.0.0', '::']) {
    fresh();
    saveConfig({ server: { host } });
    const dry = ui({ dryRun: true });
    await SU.stepAccess(dry.ui, sys({ env: SSH }), {}, {});
    assert.match(dry.rec.text, /! The dashboard is open to the network\. Not over plain http/);
    assert.match(dry.rec.text, /Would open it to: only this computer/);
    assert.equal(loadConfig().server.host, host, 'a dry run changes nothing');
    const no = ui();
    await SU.stepAccess(no.ui, sys({ env: SSH }), {}, {});
    assert.match(no.rec.text, /Kept open to the network\. To close it: hoprig setup --access local/);
    assert.equal(loadConfig().server.host, host, 'no terminal and no --yes: not closed');
    const yes = ui({ yes: true });
    const state = {};
    await SU.stepAccess(yes.ui, sys({ env: SSH }), {}, state);
    assert.match(yes.rec.text, /Close it to this computer only\? yes/);
    assert.match(yes.rec.text, /✓ Open to: only this computer/);
    assert.equal(loadConfig().server.host, '127.0.0.1');
    assert.equal(state.changed, true);
  }
});

test('a host set by hand to a card\'s own address (private, Tailscale, public) is open: closed on a server, as doctor says', async () => {
  for (const host of ['10.0.0.5', '100.101.102.103', '203.0.114.7']) {
    for (const opts of [{}, { access: 'local' }]) {
      fresh();
      saveConfig({ server: { host } });
      const { ui: u, rec } = ui({ yes: true });
      assert.equal(await SU.stepAccess(u, sys({ env: SSH }), opts, {}), true);
      assert.equal(loadConfig().server.host, '127.0.0.1', `${host} ${JSON.stringify(opts)}: ${rec.text}`);
      assert.match(rec.text, /✓ Open to: only this computer/);
      assert.equal(K.accessCheck(loadConfig(), { running: false }, SV.serverReason(sys({ env: SSH })), sys({ env: SSH })).status, 'info', 'doctor agrees afterwards');
    }
  }
});

test('doctor: a dashboard open to the network on a server is a failing line with the same words and the fix', () => {
  const server = SV.serverReason(sys({ env: SSH }));
  for (const host of ['0.0.0.0', '::', '10.0.0.5']) {
    const r = K.accessCheck({ server: { host, port: 7433 } }, { running: false }, server, sys({ env: SSH }));
    assert.equal(r.status, 'fail', host);
    assert.match(r.detail, /open to the network \(http, port 7433\)\. Not over plain http: this is a server/);
    assert.equal(r.fix, 'hoprig setup --access local');
  }
  assert.equal(K.accessCheck({ server: { host: '127.0.0.1' } }, { running: false }, server, sys({ env: SSH })).status, 'info', 'only this computer: fine');
  assert.equal(K.accessCheck({ server: { host: '0.0.0.0' } }, { running: false }, null, sys()).status, 'info', 'a desktop at home: information as before');
});

test('the end on a server: how to open it, no QR code and no private address', async () => {
  fresh();
  saveConfig({ server: { host: '127.0.0.1', port: 7433 } });
  const S = sys({ env: SSH });
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepSummary(u, { server: SV.serverReason(S), passwordFile: '/x/pw.txt' }, S);
  assert.match(rec.text, /How to open the dashboard:/);
  assert.match(rec.text, /Computers → Add a computer → "I can reach it by SSH"/);
  assert.match(rec.text, /hoprig public on/);
  // The command alone on its own line (copied whole into a shell), the address to open in the words above it.
  assert.match(rec.text, /· one ssh forward from your own computer, then open http:\/\/localhost:17433\/ there:\n {8}ssh -N -L 17433:127\.0\.0\.1:7433 alex@<the address you use for ssh>\n/);
  assert.doesNotMatch(rec.text, /[▀▄█]|Scan with|login#link|10\.0\.0\.5|192\.168/);
  const dry = ui({ dryRun: true });
  await SU.stepSummary(dry.ui, { server: SV.serverReason(S) }, S);
  assert.doesNotMatch(dry.rec.text, /QR/);
});

test('set-up with a refused --access network ends with a failing exit code and says it at the end', async () => {
  fresh();
  saveConfig({ server: { host: '0.0.0.0' } });
  const S = sys({ env: SSH, serviceSupported: false });
  S.probe = async () => 0;
  const { ui: u, rec } = ui({ yes: true });
  const code = await SU.setup(['--yes', '--access', 'network', '--no-service', '--only', 'base'], { ui: u, sys: S });
  assert.equal(code, 1, rec.text);
  assert.match(rec.text, /hoprig is ready, for this computer only: not opened to the network \(the ✗ above says why\)\./);
  assert.equal(loadConfig().server.host, '127.0.0.1');
});

test('the reason set-up saw is kept for the dashboard service and its terminals, which have no ssh session', async () => {
  fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'server.json'), { force: true });
  fresh();
  const overSsh = sys({ env: { SSH_CONNECTION: '192.168.1.20 50000 10.0.0.5 2222' }, savedServer: undefined });
  await SU.stepAccess(ui({ yes: true }).ui, overSsh, {}, {});
  // The service's environment: PATH and HOME only, no SSH_* (what a systemd user service gets).
  const service = (o = {}) => sys({ savedServer: undefined, ...o });
  assert.deepEqual(SV.serverReason(service()), { kind: 'ssh', sshPort: '2222' });
  assert.match(SV.notOnServer(SV.serverReason(service()), 7433, service()), /-p 2222 alex@/, 'the same forward line as set-up');
  const r = K.accessCheck({ server: { host: '0.0.0.0', port: 7433 } }, { running: false }, SV.serverReason(service()), service());
  assert.equal(r.status, 'fail', 'doctor typed in a terminal of the dashboard');
  assert.doesNotMatch(r.detail, /set-up runs/, 'words that fit doctor too');
  assert.equal(SV.serverReason(service({ localDisplay: true })), null, 'a computer with a display of its own is no server by the saved reason');
  // A dry run keeps nothing.
  fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'server.json'), { force: true });
  await SU.stepAccess(ui({ dryRun: true }).ui, overSsh, {}, {});
  assert.equal(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'server.json')), false);
});

test('a dashboard open to the network that also keeps a Tailscale origin is open: closed on a server, with or without --access network', async () => {
  // Tailscale set up first, then an older version's --access network wrote 0.0.0.0 and kept the origin.
  const tsBin = fakeBin(path.join(s.tmp, 'bin-ts'), {
    tailscale: 'case "$1" in status) echo \'{"BackendState":"Running","Self":{"DNSName":"box.tail1234.ts.net."}}\' ;; serve) echo "serving $3" ;; esac',
  });
  const S = sys({ env: { ...SSH, PATH: pathWith(s.tmp, tsBin) } }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  const open = { host: '0.0.0.0', allowedOrigins: ['https://box.tail1234.ts.net'] };
  assert.equal(SU.currentAccess({ server: open }, 'https://box.tail1234.ts.net'), 'network', 'the host decides first');
  for (const [opts, ok, said] of [[{}, true, /! The dashboard is open to the network\. Not over plain http/], [{ access: 'network' }, false, /✗ Not over plain http: (?:.*\n)*.*✓ Closed it to this computer only \(it was open to the network\)/]]) {
    fresh();
    saveConfig({ server: open });
    const { ui: u, rec } = ui({ yes: true });
    const state = {};
    assert.equal(await SU.stepAccess(u, S, opts, state), ok, rec.text);
    assert.match(rec.text, said);
    assert.equal(loadConfig().server.host, '127.0.0.1', JSON.stringify(opts));
    // What is left is Tailscale (its origin is kept): said so, as the next run reads it.
    assert.equal(state.access, 'tailscale');
    assert.equal(state.changed, true, 'the service is restarted with the new host');
    assert.notEqual(K.accessCheck(loadConfig(), { running: true, dnsName: 'box.tail1234.ts.net' }, SV.serverReason(S), S).status, 'fail', 'doctor agrees afterwards');
  }
});

test('a later ssh session on port 22 replaces the ssh port an earlier run saved', async () => {
  const saved = path.join(process.env.HOPRIG_STATE_DIR, 'server.json');
  fs.rmSync(saved, { force: true });
  fresh();
  const on = (port) => sys({ env: { SSH_CONNECTION: `192.168.1.20 50000 10.0.0.5 ${port}` }, savedServer: undefined });
  await SU.stepAccess(ui({ yes: true }).ui, on('2222'), {}, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, 'utf8')), { kind: 'ssh', sshPort: '2222' });
  const state = {};
  await SU.stepAccess(ui({ yes: true }).ui, on('22'), {}, state);
  assert.deepEqual(state.server, { kind: 'ssh' }, 'the live port 22 holds');
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, 'utf8')), { kind: 'ssh' }, 'and is what is kept');
  assert.equal(SV.forwardLine(7433, { ...on('22'), sshPort: '2222' }), 'ssh -N -L 17433:127.0.0.1:7433 alex@<the address you use for ssh>', 'a live session wins over a saved port');
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepSummary(u, { server: state.server }, on('22'));
  assert.doesNotMatch(rec.text, / -p /);
  // The service (no ssh session) still uses the port of the last ssh run.
  await SU.stepAccess(ui({ yes: true }).ui, on('2200'), {}, {});
  assert.deepEqual(SV.serverReason(sys({ savedServer: undefined, dmi: { vendor: 'Google' } })), { kind: 'cloud', name: 'Google Compute Engine', sshPort: '2200' });
  assert.match(SV.notOnServer(SV.serverReason(sys({ savedServer: undefined })), 7433, sys({ savedServer: undefined })), /-p 2200 alex@/);
});

test('a dashboard set-up closes but does not restart is not said to be done: it keeps its old setting until it restarts', async () => {
  for (const [args, over] of [[['--no-service'], {}], [[], { serviceSupported: false }]]) {
    fresh();
    saveConfig({ server: { host: '0.0.0.0', port: 7972 } });
    const S = sys({ env: SSH, ...over });
    S.probe = async () => 200; // a dashboard already answers, started with 0.0.0.0
    const { ui: u, rec } = ui({ yes: true });
    assert.equal(await SU.setup(['--yes', '--access', 'network', ...args, '--only', 'base'], { ui: u, sys: S }), 1, rec.text);
    assert.match(rec.text, /✓ Closed it to this computer only/);
    assert.doesNotMatch(rec.text, /✓ Dashboard running/, JSON.stringify(args));
    // Nothing here says where the running one listens (no dashboard file in this home): said so, with the restart.
    assert.match(rec.text, /! Dashboard running, but set-up cannot read where it listens \(it says nothing about itself here\), and this computer is a server: restart it so it runs with its settings \(.*hoprig serve.*\)/);
    assert.equal(loadConfig().server.host, '127.0.0.1');
  }
  // Nothing changed in this run, and still nothing says where it listens: on a server never "✓ running" either.
  const S = sys({ env: SSH });
  S.probe = async () => 200;
  const { ui: u, rec } = ui({ yes: true });
  await SU.setup(['--yes', '--no-service', '--only', 'base'], { ui: u, sys: S });
  assert.doesNotMatch(rec.text, /✓ Dashboard running/);
  assert.match(rec.text, /! Dashboard running, but set-up cannot read where it listens/);
  // A dashboard that says where it listens (this computer only, as its settings): simply running, as before.
  const T = sys({ env: SSH });
  T.probe = async () => 200;
  T.running = async () => ({ version: K.appVersion(), pid: 7, host: '127.0.0.1', port: 7972, backend: 'tmux', terminals: [] });
  const t2 = ui({ yes: true });
  await SU.setup(['--yes', '--no-service', '--only', 'base'], { ui: t2.ui, sys: T });
  assert.match(t2.rec.text, /✓ Dashboard running\n/);
});

test('the refusal ends with the forward command and no period: copied, the host stays the host', async () => {
  const S = sys({ env: { SSH_CONNECTION: '192.168.1.20 50000 203.0.114.7 22' } });
  const reason = SV.serverReason(S);
  assert.match(SV.notOnServer(reason, 7972, S), /: ssh -N -L 17972:127\.0\.0\.1:7972 alex@203\.0\.114\.7$/);
  const doctor = K.accessCheck({ server: { host: '0.0.0.0', port: 7972 } }, { running: false }, reason, S);
  assert.match(doctor.detail, /alex@203\.0\.114\.7$/, 'doctor says the same');
  fresh();
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepAccess(u, S, { access: 'network' }, {});
  assert.match(rec.text, /alex@203\.0\.114\.7\n/, 'set-up\'s ✗ line too');
});

test('a public address is not kept: one seen once is not named after it is gone; a saved reason is checked before use', async () => {
  const saved = path.join(process.env.HOPRIG_STATE_DIR, 'server.json');
  fs.rmSync(saved, { force: true });
  fresh();
  const service = (o = {}) => sys({ savedServer: undefined, ...o });
  // A run that sees a public address: the live check names it, nothing of it is saved.
  await SU.stepAccess(ui({ yes: true }).ui, service({ publicIps: ['203.0.114.7'] }), {}, {});
  assert.equal(fs.existsSync(saved), false);
  assert.equal(SV.serverReason(service()), null, 'the address is gone: no longer named');
  // Over ssh with a public address: the ssh reason is what is kept.
  await SU.stepAccess(ui({ yes: true }).ui, service({ env: SSH, publicIps: ['203.0.114.7'] }), {}, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, 'utf8')), { kind: 'ssh' });
  // An older version's file with a public address, or fields that are not what set-up writes, are not used.
  for (const bad of [
    { kind: 'public', address: '203.0.114.7' },
    { kind: 'ssh', sshPort: '22; echo' },
    { kind: 'ssh', sshPort: 2222 },
    { kind: 'cloud', name: 'anything <b>' },
    { kind: 'cloud' },
  ]) {
    fs.writeFileSync(saved, JSON.stringify(bad));
    assert.equal(SV.serverReason(service()), null, JSON.stringify(bad));
  }
  fs.writeFileSync(saved, JSON.stringify({ kind: 'cloud', name: 'Hetzner', sshPort: '2222', extra: 'x' }));
  assert.deepEqual(SV.serverReason(service()), { kind: 'cloud', name: 'Hetzner', sshPort: '2222' }, 'only the known fields');
  fs.rmSync(saved, { force: true });
});

test('a saved ssh reason is forgotten when the owner chooses "devices on my network" at this computer\'s desktop, and only then', async () => {
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'server.json');
  const save = () => SV.rememberServer({ kind: 'ssh' }, sys({ env: SSH, localDisplay: false }));
  const run = async (args, over) => {
    fresh();
    const { ui: u } = ui({ yes: args.includes('--yes') });
    await SU.stepAccess(u, sys({ savedServer: undefined, ...over }), SU.parseSetupArgs(args), {});
  };
  // A desktop, but the default (--yes) is no choice of his: kept.
  save();
  await run(['--yes'], { localDisplay: true });
  assert.ok(fs.existsSync(file), 'kept: a default is not his choice');
  // His choice, but over ssh with no desktop: refused anyway, and kept.
  await run(['--access', 'network'], { env: SSH, localDisplay: false });
  assert.ok(fs.existsSync(file), 'kept: no desktop here');
  // His choice at his own desktop: forgotten, and the logged-out service no longer counts it as a server.
  await run(['--access', 'network'], { localDisplay: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal(SV.serverReason(sys({ localDisplay: false, savedServer: undefined })), null);
  fresh();
});

test('doctor says where the running dashboard really listens, as set-up does: restart to apply, and a failing line on a server', () => {
  const cfg = { server: { host: '127.0.0.1', port: 7433 } };
  const wide = { version: '0.0.1', pid: 9, host: '0.0.0.0', port: 7433 };
  const home = K.accessCheck(cfg, { running: false }, null, sys(), wide);
  assert.equal(home.status, 'warn');
  assert.match(home.detail, /^the dashboard running now listens on every address \(open to the network\); its settings say on this computer only: that changes when it restarts$/);
  assert.match(home.fix, /^hoprig service install/);
  const server = K.accessCheck(cfg, { running: false }, { kind: 'ssh' }, sys({ env: SSH }), wide);
  assert.equal(server.status, 'fail');
  assert.match(server.detail, /listens on every address.*Not over plain http/);
  // Settings that open a server are a failure whatever runs now: a restart with them would open it to the internet.
  const opening = { server: { host: '0.0.0.0', port: 7433 } };
  for (const now of [{ ...wide, host: '127.0.0.1' }, wide, null]) {
    const r = K.accessCheck(opening, { running: false }, { kind: 'ssh' }, sys({ env: SSH }), now);
    assert.equal(r.status, 'fail', JSON.stringify(now));
    assert.equal(r.fix, 'hoprig setup --access local', JSON.stringify(now));
    assert.match(r.detail, /Not over plain http/);
  }
  assert.match(K.accessCheck(opening, { running: false }, { kind: 'ssh' }, sys({ env: SSH }), { ...wide, host: '127.0.0.1' }).detail, /^the dashboard running now listens on this computer only; its settings say on every address \(open to the network\): that changes when it restarts\. Not over plain http/);
  // The same place as the settings, or none running: the settings' words, as before.
  assert.match(K.accessCheck(cfg, { running: false }, null, sys(), { ...wide, host: '127.0.0.1' }).detail, /^this computer only \(127\.0\.0\.1:7433\)$/);
  assert.match(K.accessCheck(cfg, { running: false }, null, sys(), null).detail, /^this computer only/);
});

test('at the desktop after an earlier set-up over ssh: set-up names the saved reason and the way out, once; not on a server, not after forgetting it', async () => {
  const atDesk = (o = {}) => sys({ localDisplay: true, savedServer: { kind: 'ssh' }, ...o });
  const WORDS = /^ {2}· An earlier set-up saved this computer as a server \(it was reached over ssh, with no desktop\)\. That is not used while you are at this desktop, but with nobody logged in here \(the background service after a restart\) it counts as a server again\. If this is your own computer: hoprig setup --access network$/m;
  for (const args of [['--yes'], ['--access', 'local']]) {
    fresh();
    saveConfig({ server: { host: '127.0.0.1' } });
    const { ui: u, rec } = ui({ yes: true });
    await SU.stepAccess(u, atDesk(), SU.parseSetupArgs(args), {});
    assert.match(rec.text, WORDS, `${args}\n${rec.text}`);
    assert.equal(rec.text.split('An earlier set-up saved').length, 2, 'said once');
    assert.match(rec.text, /✓ Open to: only this computer/);
  }
  // A cloud's saved name is named as such.
  fresh();
  const c = ui({ yes: true });
  await SU.stepAccess(c.ui, atDesk({ savedServer: { kind: 'cloud', name: 'Hetzner' } }), SU.parseSetupArgs(['--yes']), {});
  assert.match(c.rec.text, /saved this computer as a cloud server \(Hetzner\)\./);
  // Over ssh with no desktop it IS a server: the server's own words, no such line.
  fresh();
  const srv = ui({ yes: true });
  await SU.stepAccess(srv.ui, sys({ env: SSH, savedServer: { kind: 'ssh' } }), SU.parseSetupArgs(['--yes']), {});
  assert.doesNotMatch(srv.rec.text, /An earlier set-up saved/);
  // Nothing saved: nothing said.
  fresh();
  const none = ui({ yes: true });
  await SU.stepAccess(none.ui, sys({ localDisplay: true }), SU.parseSetupArgs(['--yes']), {});
  assert.doesNotMatch(none.rec.text, /An earlier set-up saved/);
  // The way out, taken at the desktop: forgotten, and the line is not said after it.
  fresh();
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'server.json');
  SV.rememberServer({ kind: 'ssh' }, sys({ env: SSH }));
  assert.ok(fs.existsSync(file));
  const out = ui({ yes: true });
  await SU.stepAccess(out.ui, sys({ localDisplay: true, savedServer: undefined }), SU.parseSetupArgs(['--access', 'network']), {});
  assert.equal(fs.existsSync(file), false);
  assert.match(out.rec.text, /This computer no longer counts as a server/);
  assert.doesNotMatch(out.rec.text, /An earlier set-up saved/);
  fresh();
});

test('doctor at the desktop after an earlier set-up over ssh: its access line names the saved reason, with the way out as the fix', () => {
  const cfg = { server: { host: '127.0.0.1', port: 7433 } };
  const r = K.accessCheck(cfg, { running: false }, null, sys({ localDisplay: true, savedServer: { kind: 'ssh' } }), null);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /^this computer only \(127\.0\.0\.1:7433\)\. An earlier set-up saved this computer as a server \(it was reached over ssh, with no desktop\)\. .* it counts as a server again\. If this is your own computer: hoprig setup --access network$/);
  assert.equal(r.fix, 'hoprig setup --access network   (only if this is not a server)');
  // Nothing saved, or no desktop (then it is a server and doctor says so its own way): as before.
  assert.equal(K.accessCheck(cfg, { running: false }, null, sys({ localDisplay: true }), null).status, 'info');
  assert.doesNotMatch(K.accessCheck(cfg, { running: false }, { kind: 'ssh' }, sys({ localDisplay: false, savedServer: { kind: 'ssh' } }), null).detail, /An earlier set-up saved/);
});

test('closing a dashboard open to the network that keeps a Tailscale origin: the run and the next one say the same (your Tailscale devices)', async () => {
  const tsBin = fakeBin(path.join(s.tmp, 'bin-ts5'), {
    tailscale: `case "$1" in status) echo '{"BackendState":"Running","Self":{"DNSName":"box.tail1234.ts.net."}}' ;; serve) echo "serve $*" >> '${path.join(s.tmp, 'ts5.log')}' ;; esac`,
  });
  const S = sys({ env: { ...SSH, PATH: pathWith(s.tmp, tsBin) } }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  for (const opts of [{}, { access: 'network' }]) {
    fresh();
    fs.rmSync(path.join(s.tmp, 'ts5.log'), { force: true });
    saveConfig({ server: { host: '0.0.0.0', allowedOrigins: ['https://box.tail1234.ts.net'] } });
    const first = ui({ yes: true });
    const st1 = {};
    await SU.stepAccess(first.ui, S, opts, st1);
    const second = ui({ yes: true });
    const st2 = {};
    await SU.stepAccess(second.ui, S, {}, st2);
    const at = JSON.stringify(opts);
    assert.equal(loadConfig().server.host, '127.0.0.1', at);
    assert.deepEqual([st1.access, st2.access], ['tailscale', 'tailscale'], `${at}\n${first.rec.text}\n${second.rec.text}`);
    assert.equal(st1.phoneUrl, 'https://box.tail1234.ts.net/', at);
    assert.doesNotMatch(first.rec.text, /Open to: only this computer/, at);
    assert.match(first.rec.text, opts.access ? /✓ Closed it to this computer only \(it was open to the network\); your Tailscale devices still reach it \(https:\/\/box\.tail1234\.ts\.net\/\)/ : /✓ Open to: your Tailscale devices \(https:\/\/box\.tail1234\.ts\.net\/\)/, at);
    assert.match(second.rec.text, /✓ Open to: your Tailscale devices \(https:\/\/box\.tail1234\.ts\.net\/\)/, at);
    assert.equal(fs.existsSync(path.join(s.tmp, 'ts5.log')), false, `${at}: no second "tailscale serve" (it is set up already)`);
  }
  // No Tailscale origin kept: "only this computer", as before.
  fresh();
  saveConfig({ server: { host: '0.0.0.0' } });
  const plain = ui({ yes: true });
  const st = {};
  await SU.stepAccess(plain.ui, S, {}, st);
  assert.equal(st.access, 'local');
  assert.match(plain.rec.text, /✓ Open to: only this computer/);
  fresh();
});

test('a refused --access network that leaves Tailscale says so at the end; --access tailscale by name sets Tailscale up again', async () => {
  const log = path.join(s.tmp, 'ts6.log');
  const tsBin = fakeBin(path.join(s.tmp, 'bin-ts6'), {
    tailscale: `case "$1" in status) echo '{"BackendState":"Running","Self":{"DNSName":"box.tail1234.ts.net."}}' ;; serve) echo "serve $*" >> '${log}' ;; esac`,
  });
  const S = sys({ env: { ...SSH, PATH: pathWith(s.tmp, tsBin) } }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  const open = { host: '0.0.0.0', allowedOrigins: ['https://box.tail1234.ts.net'] };
  fresh();
  saveConfig({ server: open });
  const r = ui({ yes: true });
  const st = {};
  await SU.stepAccess(r.ui, S, { access: 'network' }, st);
  await SU.stepSummary(r.ui, st, S);
  assert.match(r.rec.text, /hoprig is ready, for this computer and your Tailscale devices: not opened to the network/);
  assert.doesNotMatch(r.rec.text, /for this computer only/);
  // Asked for by name: `tailscale serve` runs again (it may have been reset since), the host closes.
  for (const over of [{ env: SSH }, { localDisplay: true }]) {
    fresh();
    fs.rmSync(log, { force: true });
    saveConfig({ server: open });
    const t = ui({ yes: true });
    await SU.stepAccess(t.ui, sys({ ...over, env: { ...(over.env || {}), PATH: pathWith(s.tmp, tsBin) } }), { access: 'tailscale' }, {}); // seal: only the test's own folders, in an environment that keeps the runner's variables
    assert.match(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', /^serve serve --bg \d+$/m, JSON.stringify(over));
    assert.equal(loadConfig().server.host, '127.0.0.1');
  }
  fresh();
});
