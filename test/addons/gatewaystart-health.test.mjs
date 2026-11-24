// A gateway started from Health (src/addons/gatewayhost.mjs startHere, localgateway.mjs start): it gets what keeps it
// on this computer (HOST=127.0.0.1, as the service gets it), and a start that fails at once is answered at once with
// the gateway's own last words, never a path on that computer and never a line that may hold a password. The gateway
// is a made-up program of the owner's own, pinned as the product pins one; nothing of the real system is reached.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const skip = process.platform === 'win32' && 'POSIX scripts';
const box = sandbox('gateway-start');
const { saveConfig } = await import('../../src/config.mjs');
const { gatewayAddons } = await import('../../src/addons/gateways.mjs');
const { startHere } = await import('../../src/addons/gatewayhost.mjs');
const { addonsFeature } = await import('../../src/addons/feature.mjs');
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
const { servicePlan } = await import('../../src/addons/gatewayservice.mjs');
const { loadConfig } = await import('../../src/config.mjs');
const { definedGateways } = await import('../../src/addons/gateways.mjs');
const { localGateway } = await import('../../src/addons/localgateway.mjs');
const { traps } = await import('../machines/traps.mjs');
const { knock } = await import('../../src/knock.mjs');

const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const seen = path.join(box.root, 'seen.json');
const script = path.join(box.root, 'relay.mjs');
fs.writeFileSync(script, `import fs from 'node:fs';
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), HOST: process.env.HOST || null }));
if (process.env.RELAY_FAIL || fs.existsSync(${JSON.stringify(path.join(box.root, 'fail'))})) {
  console.log('Relay first password: L7made-up-pw');
  console.error('Relay: cannot open its database');
  process.exit(3);
}
http.createServer((q, s) => s.end('relay')).listen(port, '127.0.0.1');
`);
const program = path.join(box.root, 'relay');
fs.writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
const port = await freePort();
// A gateway of an npm package, as npm installs one globally (lib/node_modules/<package>, its program linked from bin),
// and a stand-in npm that changes nothing; the real npm, sudo and systemctl are traps behind it.
const prefix = path.join(box.root, 'npm-global');
const pkg = path.join(prefix, 'lib', 'node_modules', 'relaypkg');
fs.mkdirSync(pkg, { recursive: true });
fs.mkdirSync(path.join(prefix, 'bin'));
fs.writeFileSync(path.join(pkg, 'cli.sh'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
fs.symlinkSync(path.join(pkg, 'cli.sh'), path.join(prefix, 'bin', 'relaypkg'));
const standins = path.join(box.root, 'standins');
fs.mkdirSync(standins);
fs.writeFileSync(path.join(standins, 'npm'), `#!/bin/sh\necho "npm $*" >> '${path.join(box.root, 'npm.log')}'\n`, { mode: 0o755 });
// systemd as far as a service of a gateway needs it: the process it runs is the pid in main.pid (0: none runs).
const mainPid = path.join(box.root, 'main.pid');
fs.writeFileSync(mainPid, '0\n');
fs.writeFileSync(path.join(standins, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> '${path.join(box.root, 'systemctl.log')}'\ncase "$*" in *show*MainPID*) cat '${mainPid}' ;; *is-active*) echo active ;; esac\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(standins, 'loginctl'), '#!/bin/sh\necho Linger=yes\n', { mode: 0o755 });
process.env.XDG_CONFIG_HOME = path.join(box.home, '.config');
const trap = traps(box.root);
process.env.PATH = trap.path(standins, path.join(prefix, 'bin'));
const npmPort = await freePort();
saveConfig({ gateways: { defined: [
  { id: 'relay', title: 'Relay', bin: program, sha256: crypto.createHash('sha256').update(fs.readFileSync(program)).digest('hex'), port, args: ['--port', 'PORT'] },
  { id: 'relaypkg', title: 'Relay package', npm: 'relaypkg', port: npmPort, args: ['--port', 'PORT'] },
] } });
const relay = () => gatewayAddons().find((a) => a.id === 'relay');
const relayPkg = () => gatewayAddons().find((a) => a.id === 'relaypkg');
const seenHost = () => JSON.parse(fs.readFileSync(seen, 'utf8')).HOST;
test.after(async () => {
  await relay().stop().catch(() => {});
  await relayPkg().stop().catch(() => {});
  box.cleanup();
});

test('a gateway started from Health gets HOST=127.0.0.1, as its service does', { skip }, async () => {
  try {
    const r = await startHere(relay());
    assert.equal(r.ok, true, r.error);
    assert.equal(JSON.parse(fs.readFileSync(seen, 'utf8')).HOST, '127.0.0.1');
  } finally {
    assert.equal((await relay().stop()).ok, true);
  }
});

test('a gateway started from Settings → Add-ons or Tia (the add-ons route) gets HOST=127.0.0.1 too', { skip }, async () => {
  fs.rmSync(seen, { force: true });
  class HttpError extends Error {}
  const f = addonsFeature({ HttpError, readJson: async () => ({}) }, { addons: [relay()] });
  const [, re, fn] = f.routes.find(([m, r]) => m === 'POST' && r.test('/api/addons/relay/start'));
  try {
    assert.deepEqual(await fn({ headers: {} }, re.exec('/api/addons/relay/start')), { started: true });
    for (let i = 0; i < 100 && !(await relay().status()).running; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await relay().status()).running, true);
    assert.equal(seenHost(), '127.0.0.1');
  } finally {
    assert.equal((await relay().stop()).ok, true);
  }
});

test('a gateway that ran before an update is started again with HOST=127.0.0.1', { skip }, async () => {
  const a = relayPkg();
  try {
    assert.equal((await a.start()).ok, true);
    fs.rmSync(seen, { force: true });
    assert.equal((await a.update({ onLine: () => {} })).ok, true);
    assert.match(fs.readFileSync(path.join(box.root, 'npm.log'), 'utf8'), /^npm install -g relaypkg@latest$/m, 'the stand-in npm, never the real one');
    assert.equal((await a.status()).running, true, 'it runs again after the update');
    assert.equal(seenHost(), '127.0.0.1');
  } finally {
    assert.equal((await a.stop()).ok, true);
    trap.check();
  }
});

test('a gateway of the owner\'s own run by its service is shown running, is not stopped beside it, and a stranger on its port still is not it', { skip: process.platform !== 'linux' && 'systemd' }, async () => {
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const plan = (a) => servicePlan(a, { platform: 'linux', env: { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }, home: box.home }); // seal: servicePlan's input, written into the unit's text only
  const f = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { addons: () => [relay()], computer: () => 'box2', plan });
  const route = (m0, p) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === m0 && r.test(p));
    return (body) => fn({ body, headers: {} }, re.exec(p));
  };
  const row = async () => (await route('GET', '/api/gatewayhost')()).gateways.find((g) => g.id === 'relay');
  let svc = null;
  try {
    assert.equal((await route('POST', '/api/gatewayhost/relay/service')({ on: true, confirm: 'box2' })).ok, true);
    // What systemd does with the unit: it runs the program written into it. The stand-in cannot, so the test does.
    svc = spawn(program, ['--port', String(port)], { stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1' } });
    fs.writeFileSync(mainPid, `${svc.pid}\n`);
    for (let i = 0; i < 50 && (await knock({ port, host: '127.0.0.1' })) !== 'open'; i++) await new Promise((r) => setTimeout(r, 100));
    const g = await row();
    assert.deepEqual([g.running, g.service.made, g.service.active], [true, true, true], 'Health shows it running, so Open its page is offered and a forward is allowed');
    assert.equal((await relay().status()).foreign, undefined);
    const s1 = await route('POST', '/api/gatewayhost/relay/start')({ confirm: 'box2' });
    assert.deepEqual([s1.ok, s1.already, s1.service, s1.lines], [true, false, true, ['Relay\'s service runs already']]);
    const st = await relay().stop();
    assert.equal(st.ok, false, 'Settings → Add-ons does not signal what its service runs');
    assert.match(st.error, /runs as a service/);
    assert.equal(svc.exitCode, null, 'still running');
    // Its service runs nothing: the program on its port is another, as before.
    fs.writeFileSync(mainPid, '0\n');
    assert.deepEqual([(await relay().status()).running, (await relay().status()).foreign], [false, true]);
  } finally {
    if (svc) svc.kill('SIGKILL');
    await route('POST', '/api/gatewayhost/relay/service')({ on: false, confirm: 'box2' });
    trap.check();
  }
});

test('a start that fails at once is answered at once with its own words, no path and no password line', { skip }, async () => {
  fs.writeFileSync(path.join(box.root, 'fail'), '');
  const t0 = Date.now();
  const r = await startHere(relay());
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 10_000, `answered after ${Date.now() - t0} ms`);
  assert.match(r.error, /Relay stopped at once/);
  assert.match(r.error, /cannot open its database/);
  assert.ok(!r.error.includes(box.root), `no path of that computer: ${r.error}`);
  assert.ok(!r.error.includes('L7made-up-pw'), 'the first password is never part of an answer');
});

test('Health\'s start and its service follow the rule of every start: as before where the dashboard is open to the network', { skip }, async () => {
  const was = loadConfig().server || {};
  fs.rmSync(path.join(box.root, 'fail'), { force: true }); // left by the test of a start that fails at once
  // Not a server, whatever this computer is (reached over ssh it counts as one): only the dashboard's host decides.
  const home = localGateway(definedGateways().list.find((d) => d.id === 'relay'), { shipped: false, reason: () => null });
  const unit = () => servicePlan(home, { platform: 'linux', env: { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }, home: box.home }).text; // seal: servicePlan's input, written into the unit's text only
  try {
    // The dashboard on this computer only (this home's default): HOST for Health's start and in the unit.
    assert.match(unit(), /^Environment="HOST=127\.0\.0\.1"$/m);
    // The owner opened the dashboard to his network: a start from Health adds nothing, as every other start.
    saveConfig({ server: { ...was, host: '0.0.0.0' } });
    fs.rmSync(seen, { force: true });
    const r = await startHere(home);
    assert.equal(r.ok, true, r.error);
    assert.equal(seenHost(), null, 'no HOST where the dashboard itself is open to the network');
    assert.doesNotMatch(unit(), /HOST=/, 'its service the same');
  } finally {
    await home.stop();
    saveConfig({ server: was });
    trap.check();
  }
});

// Each press acts on what really runs: the copy on the port, whoever started it, and the service where it is made.
const hostRoutes = () => {
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const plan = (a) => servicePlan(a, { platform: 'linux', env: { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }, home: box.home }); // seal: servicePlan's input, written into the unit's text only
  const f = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { addons: () => gatewayAddons(), computer: () => 'box2', plan });
  return (m0, p) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === m0 && r.test(p));
    return (body) => fn({ body, headers: {} }, re.exec(p));
  };
};

test('Health\'s Stop of a gateway made a service stops the copy started outside it too, and says so; Start leaves such a copy and says so', { skip: process.platform !== 'linux' && 'systemd' }, async () => {
  const route = hostRoutes();
  fs.rmSync(path.join(box.root, 'fail'), { force: true });
  fs.writeFileSync(mainPid, '0\n');
  try {
    assert.equal((await route('POST', '/api/gatewayhost/relay/service')({ on: true, confirm: 'box2' })).ok, true);
    // The service runs nothing; Settings → Add-ons (or Tia, a session) starts a copy of its own.
    assert.equal((await relay().start()).ok, true);
    assert.equal((await relay().status()).byService, undefined, 'that copy is not its service\'s');
    const st = await route('POST', '/api/gatewayhost/relay/start')({ confirm: 'box2' });
    assert.equal(st.outside, true);
    assert.match(st.lines[0], /started outside its service, and was left as it is/);
    const sp = await route('POST', '/api/gatewayhost/relay/stop')({ confirm: 'box2' });
    assert.deepEqual(sp.lines, ['Stopped Relay\'s service', 'Stopped the copy of Relay that was started outside its service']);
    assert.equal((await relay().status()).running, false, 'nothing of it runs after Stop');
  } finally {
    await relay().stop().catch(() => {});
    await route('POST', '/api/gatewayhost/relay/service')({ on: false, confirm: 'box2' });
    trap.check();
  }
});

test('the Operator\'s "Restart the gateway" of one its service runs says it was not restarted, never "restarted"', { skip: process.platform !== 'linux' && 'systemd' }, async () => {
  const { defaultActs } = await import('../../src/operator/sources.mjs');
  const route = hostRoutes();
  let svc = null;
  try {
    assert.equal((await route('POST', '/api/gatewayhost/relay/service')({ on: true, confirm: 'box2' })).ok, true);
    svc = spawn(program, ['--port', String(port)], { stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1' } });
    fs.writeFileSync(mainPid, `${svc.pid}\n`);
    for (let i = 0; i < 50 && (await knock({ port, host: '127.0.0.1' })) !== 'open'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await relay().status()).byService, true);
    await assert.rejects(defaultActs().restartGateway({ addon: 'relay' }), (e) => e.status === 409 && /Relay was not restarted: Relay runs as a service/.test(e.message));
    assert.equal(svc.exitCode, null, 'its service\'s copy still runs');
  } finally {
    if (svc) svc.kill('SIGKILL');
    fs.writeFileSync(mainPid, '0\n');
    await route('POST', '/api/gatewayhost/relay/service')({ on: false, confirm: 'box2' });
    trap.check();
  }
});

test('Remove of a gateway made a service takes its service away first: the unit file is gone and it was disabled', { skip: process.platform !== 'linux' && 'systemd' }, async () => {
  const { gatewayRoutes } = await import('../../src/addons/gatewayroutes.mjs');
  const gonePort = await freePort();
  const was = loadConfig().gateways;
  saveConfig({ gateways: { defined: [...was.defined, { id: 'relaygone', title: 'Relay gone', bin: program, sha256: crypto.createHash('sha256').update(fs.readFileSync(program)).digest('hex'), port: gonePort, args: ['--port', 'PORT'] }] } });
  const route = hostRoutes();
  const unit = path.join(process.env.XDG_CONFIG_HOME, 'systemd', 'user', 'hoprig-gateway-relaygone.service');
  try {
    assert.equal((await route('POST', '/api/gatewayhost/relaygone/service')({ on: true, confirm: 'box2' })).ok, true);
    assert.equal(fs.existsSync(unit), true);
    class HttpError extends Error {
      constructor(status, message) {
        super(message);
        this.status = status;
      }
    }
    let body = null;
    const [, re, fn] = gatewayRoutes({ HttpError, readJson: async () => body }).find(([m, r]) => m === 'POST' && r.test('/api/gateways/defined/remove'));
    const req = { headers: { cookie: 'hoprig_session=x' } };
    body = { id: 'relaygone' };
    assert.match((await fn(req, re.exec('/api/gateways/defined/remove'))).confirm, /its service is removed/, 'the question says so first');
    body = { id: 'relaygone', confirmed: true };
    const r = await fn(req, re.exec('/api/gateways/defined/remove'));
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(unit), false, 'the unit file is gone');
    assert.match(fs.readFileSync(path.join(box.root, 'systemctl.log'), 'utf8'), /^systemctl --user disable --now hoprig-gateway-relaygone\.service$/m);
    assert.ok(r.lines.some((l) => /Removed .*hoprig-gateway-relaygone\.service/.test(l)), r.lines.join(' | '));
    assert.equal(gatewayAddons().some((a) => a.id === 'relaygone'), false, 'and the gateway is forgotten');
  } finally {
    saveConfig({ gateways: was });
    fs.rmSync(unit, { force: true });
    trap.check();
  }
});
