// A gateway on any computer (src/addons/gatewayhost.mjs, gatewayservice.mjs): its service's file and commands shown
// first and made only on a press that names this computer; a second press changes nothing; removed the same way;
// lingering off is said with its administrator command, run only with sudo -n and given to the owner when sudo would
// ask; Tia's door is refused. Every program runs through a stand-in `run` that writes down what it was asked: nothing
// of the real system is reached.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewayhost');
test.after(() => box.cleanup());
const { gatewayHostFeature, startHere } = await import('../../src/addons/gatewayhost.mjs');
const { servicePlan, listenHere } = await import('../../src/addons/gatewayservice.mjs');
const { listenRule } = await import('../../src/addons/localgateway.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const program = path.join(box.root, 'relay');
fs.writeFileSync(program, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
let running = false;
const relay = { id: 'relay', title: 'Relay', defined: true, command: () => [program, '--port', '8197'], gateway: { port: () => 8197 },
  status: async () => ({ installed: true, running }), start: async () => ((running = true), { ok: true }), stop: async () => ((running = false), { ok: true }) };
const env = { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: path.join(box.home, '.config') }; // seal: only servicePlan's input: written into the unit's text, no program is started with it (run is a stand-in)
const calls = [];
let answers = {};
const run = async (argv) => {
  calls.push(argv.join(' '));
  return answers[argv.join(' ')] || { ok: true, stdout: '', stderr: '' };
};
const feature = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: (req) => req.caller || 'page' }, { run, addons: () => [relay], computer: () => 'box2', plan: (a) => servicePlan(a, { platform: 'linux', env, home: box.home }) });
const route = (method, p) => {
  for (const [m, re, fn] of feature.routes) {
    const hit = re.exec(p);
    if (hit && m === method) return (body, caller) => fn({ body, caller }, hit);
  }
  throw new Error(`no route ${method} ${p}`);
};
const unitFile = path.join(env.XDG_CONFIG_HOME, 'systemd', 'user', 'hoprig-gateway-relay.service');

test('the lines it would add are shown first, and nothing is written or run for that', async () => {
  const shown = await route('GET', '/api/gatewayhost/relay/service')();
  assert.equal(shown.kind, 'systemd');
  assert.equal(shown.file, unitFile);
  assert.match(shown.text, new RegExp(`^ExecStart="${program}" "--port" "8197"$`, 'm'), 'the program and arguments in full');
  assert.match(shown.text, /^Environment="HOST=127\.0\.0\.1"$/m, 'for this computer only');
  assert.match(shown.text, /^WantedBy=default\.target$/m);
  assert.match(shown.text, /^StandardOutput=null$/m, 'what it prints (a first password) is not kept in the journal');
  assert.deepEqual(shown.commands, ['systemctl --user daemon-reload', 'systemctl --user enable --now hoprig-gateway-relay.service']);
  assert.equal(fs.existsSync(unitFile), false);
  assert.ok(!calls.some((c) => /enable|daemon-reload/.test(c)), 'only looked at, nothing run');
  // The shipped gateway's own words (localOnly) where the rule keeps it on this computer; nothing where it does not.
  const shippedDef = { localOnly: ['--host', '127.0.0.1'] };
  assert.deepEqual(listenRule(shippedDef, { host: '127.0.0.1', reason: null, tailscale: false }), { args: ['--host', '127.0.0.1'], env: { HOST: '127.0.0.1' } });
  assert.deepEqual(listenRule(shippedDef, { host: '0.0.0.0', reason: null, tailscale: false }), { args: [], env: {} }, 'a home open to its network: as before');
  assert.deepEqual(listenHere({ listen: () => ({ args: ['--x'], env: { HOST: '127.0.0.1' } }) }), { args: ['--x'], env: { HOST: '127.0.0.1' } }, 'the service takes what every start takes');
});

test('a press without the computer\'s name, with another name, or from Tia\'s door changes nothing', async () => {
  for (const body of [{ on: true }, { on: true, confirm: 'box3' }]) {
    await assert.rejects(route('POST', '/api/gatewayhost/relay/service')(body), (e) => e.status === 400 && /confirm/.test(e.message));
  }
  await assert.rejects(route('POST', '/api/gatewayhost/relay/service')({ on: true, confirm: 'box2' }, 'self'), (e) => e.status === 403);
  await assert.rejects(route('POST', '/api/gatewayhost/relay/start')({ confirm: 'box2' }, 'self'), (e) => e.status === 403);
  await assert.rejects(route('POST', '/api/gatewayhost/linger')({}), (e) => e.status === 400);
  assert.equal(fs.existsSync(unitFile), false);
  assert.equal(running, false);
  for (const p of ['/api/gatewayhost/relay/service', '/api/gatewayhost/relay/start', '/api/gatewayhost/linger', '/m/box2/api/gatewayhost/relay/stop']) {
    assert.throws(() => checkRoute('POST', p, { confirm: 'box2' }), (e) => e.status === 403, `Tia's door: ${p}`);
  }
});

test('made on his press, once; a second press changes nothing; removed the same way', async () => {
  calls.length = 0;
  answers = { 'loginctl show-user': null };
  const made = await route('POST', '/api/gatewayhost/relay/service')({ on: true, confirm: 'box2' });
  assert.equal(made.ok, true);
  assert.equal(fs.statSync(unitFile).mode & 0o777, 0o644);
  assert.ok(calls.includes('systemctl --user enable --now hoprig-gateway-relay.service'));
  answers['systemctl --user is-active hoprig-gateway-relay.service'] = { ok: true, stdout: 'active\n' };
  const n = calls.filter((c) => /enable/.test(c)).length;
  const again = await route('POST', '/api/gatewayhost/relay/service')({ on: true, confirm: 'box2' });
  assert.equal(again.already, true);
  assert.equal(calls.filter((c) => /enable/.test(c)).length, n, 'twice: not enabled again');
  const list = await route('GET', '/api/gatewayhost')();
  assert.equal(list.computer, 'box2');
  assert.deepEqual(list.gateways[0].service, { kind: 'systemd', made: true, active: true });
  const gone = await route('POST', '/api/gatewayhost/relay/service')({ on: false, confirm: 'box2' });
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(unitFile), false);
  assert.ok(calls.includes('systemctl --user disable --now hoprig-gateway-relay.service'));
});

test('start and stop it now, for this computer only, behind the same confirmation', async () => {
  assert.equal(startHere, startHere, 'one function starts a gateway here');
  assert.equal((await route('POST', '/api/gatewayhost/relay/start')({ confirm: 'box2' })).ok, true);
  assert.equal(running, true);
  assert.equal((await route('POST', '/api/gatewayhost/relay/stop')({ confirm: 'box2' })).ok, true);
  assert.equal(running, false);
  await assert.rejects(route('POST', '/api/gatewayhost/nope/start')({ confirm: 'box2' }), (e) => e.status === 404);
});

test('lingering off: said with its command; run only as sudo -n; when sudo would ask, the command goes to the owner', async () => {
  const user = (await import('node:os')).userInfo().username;
  answers = { [`loginctl show-user ${user} -p Linger`]: { ok: true, stdout: 'Linger=no\n' }, [`sudo -n loginctl enable-linger ${user}`]: { ok: false, stdout: '', stderr: 'sudo: a password is required\n' } };
  const list = await route('GET', '/api/gatewayhost')();
  if (process.platform === 'linux') {
    assert.equal(list.linger, 'off');
    assert.equal(list.lingerCommand, `sudo loginctl enable-linger ${user}`);
  }
  calls.length = 0;
  const r = await route('POST', '/api/gatewayhost/linger')({ confirm: 'box2' });
  assert.deepEqual(calls, [`sudo -n loginctl enable-linger ${user}`], 'never a sudo that could ask');
  assert.equal(r.needsPassword, true);
  assert.equal(r.command, `sudo loginctl enable-linger ${user}`);
});

test('two presses at once: the program is started once, and the second is told it is busy', async () => {
  let starts = 0;
  const slow = { ...relay, start: async () => {
    starts += 1;
    await new Promise((r) => setTimeout(r, 200));
    running = true;
    return { ok: true };
  } };
  const f = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { run, addons: () => [slow], computer: () => 'box2', plan: (a) => servicePlan(a, { platform: 'linux', env, home: box.home }) });
  const [, re, fn] = f.routes.find(([m, r]) => m === 'POST' && r.test('/api/gatewayhost/relay/start'));
  const press = () => fn({ body: { confirm: 'box2' } }, re.exec('/api/gatewayhost/relay/start'));
  const rs = await Promise.allSettled([press(), press()]);
  assert.equal(starts, 1, 'started once');
  assert.deepEqual(rs.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const no = rs.find((r) => r.status === 'rejected').reason;
  assert.equal(no.status, 409);
  assert.match(no.message, /busy/);
  assert.equal((await press()).ok, true, 'after it, a press goes through again');
  running = false;
});

test('Run as a service while Hoprig\'s copy runs stops that copy first; then Start and Stop go through the service', async () => {
  calls.length = 0;
  answers = {};
  running = true;
  const seen = [];
  const mine = { ...relay, stop: async () => (seen.push('stop'), (running = false), { ok: true }), start: async () => (seen.push('start'), (running = true), { ok: true }) };
  const f = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { run: async (argv) => (seen.push(argv.join(' ')), run(argv)), addons: () => [mine], computer: () => 'box2', plan: (a) => servicePlan(a, { platform: 'linux', env, home: box.home }) });
  const go = (p, body) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === 'POST' && r.test(p));
    return fn({ body }, re.exec(p));
  };
  const made = await go('/api/gatewayhost/relay/service', { on: true, confirm: 'box2' });
  assert.equal(made.stopped, true);
  const enable = seen.indexOf('systemctl --user enable --now hoprig-gateway-relay.service');
  assert.ok(seen.indexOf('stop') >= 0 && seen.indexOf('stop') < enable, seen.join(' | '));
  seen.length = 0;
  assert.equal((await go('/api/gatewayhost/relay/stop', { confirm: 'box2' })).service, true);
  assert.equal((await go('/api/gatewayhost/relay/start', { confirm: 'box2' })).service, true);
  assert.ok(seen.includes('systemctl --user stop hoprig-gateway-relay.service') && seen.includes('systemctl --user start hoprig-gateway-relay.service'), seen.join(' | '));
  assert.ok(!seen.includes('stop') && !seen.includes('start'), 'no second copy beside the service');
  await go('/api/gatewayhost/relay/service', { on: false, confirm: 'box2' });
  assert.equal(fs.existsSync(unitFile), false);
  running = false;
});

test('the add-ons route and Health\'s route share one press per gateway: never two starts beside each other', async () => {
  const { addonsFeature } = await import('../../src/addons/feature.mjs');
  let starts = 0;
  let release;
  const held = new Promise((r) => (release = r));
  const slow = { ...relay, start: async () => ((starts += 1), await held, (running = true), { ok: true }) };
  const health = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { run, addons: () => [slow], computer: () => 'box2', plan: (a) => servicePlan(a, { platform: 'linux', env, home: box.home }) });
  const [, re, fn] = health.routes.find(([m, r]) => m === 'POST' && r.test('/api/gatewayhost/relay/start'));
  const first = fn({ body: { confirm: 'box2' } }, re.exec('/api/gatewayhost/relay/start'));
  const addons = addonsFeature({ HttpError, readJson: async () => ({}) }, { addons: [slow] });
  const [, are, afn] = addons.routes.find(([m, r]) => m === 'POST' && r.test('/api/addons/relay/start'));
  await assert.rejects(Promise.resolve().then(() => afn({ headers: {} }, are.exec('/api/addons/relay/start'))), (e) => e.status === 409 && /busy/.test(e.message));
  release();
  assert.equal((await first).ok, true);
  assert.equal(starts, 1);
  running = false;
});

test('on macOS Stop takes its job out of launchd, so KeepAlive does not start it again; Start puts it back', async () => {
  const seen = [];
  let loaded = true;
  const mac = async (argv) => {
    const c = argv.join(' ');
    seen.push(c);
    if (argv[1] === 'print') return { ok: loaded, stdout: loaded ? 'pid = 4242\n' : '', stderr: loaded ? '' : 'Could not find service' };
    if (argv[1] === 'bootout') loaded = false;
    if (argv[1] === 'bootstrap') loaded = true;
    return { ok: true, stdout: '', stderr: '' };
  };
  const f = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { run: mac, addons: () => [relay], computer: () => 'box2', plan: (a) => servicePlan(a, { platform: 'darwin', env, home: box.home, uid: 501 }) });
  const go = (p, body) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === 'POST' && r.test(p));
    return fn({ body }, re.exec(p));
  };
  const agent = 'gui/501/local.hoprig.gateway.relay';
  assert.equal((await go('/api/gatewayhost/relay/service', { on: true, confirm: 'box2' })).ok, true);
  seen.length = 0;
  assert.equal((await go('/api/gatewayhost/relay/stop', { confirm: 'box2' })).service, true);
  assert.ok(seen.includes(`launchctl bootout ${agent}`), seen.join(' | '));
  assert.ok(!seen.some((c) => / kill /.test(c)), 'not a signal that KeepAlive answers with a new start');
  assert.equal(loaded, false);
  seen.length = 0;
  assert.equal((await go('/api/gatewayhost/relay/start', { confirm: 'box2' })).service, true);
  const boot = seen.indexOf(`launchctl bootstrap gui/501 ${path.join(box.home, 'Library', 'LaunchAgents', 'local.hoprig.gateway.relay.plist')}`);
  assert.ok(boot >= 0 && boot < seen.indexOf(`launchctl kickstart ${agent}`), seen.join(' | '));
  seen.length = 0;
  assert.equal((await go('/api/gatewayhost/relay/start', { confirm: 'box2' })).service, true);
  assert.ok(!seen.some((c) => /bootstrap/.test(c)) && seen.includes(`launchctl kickstart ${agent}`), 'loaded already: only started');
  await go('/api/gatewayhost/relay/service', { on: false, confirm: 'box2' });
});

test('on macOS a second Run as a service press for a gateway its service runs stops nothing and changes nothing', async () => {
  const mac = async (argv) => ({ ok: true, stdout: argv[1] === 'print' ? 'pid = 4242\n' : '', stderr: '' });
  let stops = 0;
  const own = { ...relay, status: async () => ({ installed: true, running: true }), stop: async () => ((stops += 1), { ok: true }) };
  const f = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { run: mac, addons: () => [own], computer: () => 'box2', plan: (a) => servicePlan(a, { platform: 'darwin', env, home: box.home, uid: 501 }) });
  const [, re, fn] = f.routes.find(([m, x]) => m === 'POST' && x.test('/api/gatewayhost/relay/service'));
  const go = (body) => fn({ body }, re.exec('/api/gatewayhost/relay/service'));
  try {
    const first = await go({ on: true, confirm: 'box2' });
    assert.equal(first.ok, true);
    assert.equal(stops, 1, 'the first press stops the copy that ran before its service');
    const again = await go({ on: true, confirm: 'box2' });
    assert.deepEqual([again.ok, again.already, again.stopped], [true, true, false]);
    assert.equal(stops, 1, 'made already: launchd cannot say it runs, so nothing is stopped before it');
  } finally {
    await go({ on: false, confirm: 'box2' });
  }
});

test('idle care leaves a gateway its service runs alone: no stop, no line in Activity', async () => {
  const { apply } = await import('../../src/automation/idle.mjs');
  let stops = 0;
  const lines = [];
  const kept = { id: 'relay', title: 'Relay', status: async () => ({ running: true, byService: true }), stop: async () => ((stops += 1), { ok: false, error: 'Relay runs as a service' }) };
  await apply([{ type: 'stop-gateway', addon: 'relay', idleMs: 3_600_000 }], { addons: [kept], record: (e) => lines.push(e), deck: {} });
  assert.deepEqual([stops, lines], [0, []]);
});

test('Start through the service and Run as a service answer when the gateway answers, or say it does not yet', async () => {
  let up = 0;
  let asked = 0;
  const own = { ...relay, status: async () => ({ installed: true, running: false }), answering: async () => ((asked += 1), { up: asked > up, mine: asked > up }) };
  const make = (waitMs) => gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, { run: async (argv) => ({ ok: true, stdout: /is-active/.test(argv.join(' ')) ? 'inactive\n' : '', stderr: '' }), addons: () => [own], computer: () => 'box2', answerWaitMs: waitMs, plan: (a) => servicePlan(a, { platform: 'linux', env, home: box.home }) });
  const post = (f, p, body) => {
    const [, re, fn] = f.routes.find(([m, x]) => m === 'POST' && x.test(p));
    return fn({ body }, re.exec(p));
  };
  const f = make(5000);
  try {
    up = 3;
    const made = await post(f, '/api/gatewayhost/relay/service', { on: true, confirm: 'box2' });
    assert.ok(asked > 3, `it waited for the port (asked ${asked} times)`);
    assert.ok(!made.lines.some((l) => /does not answer/.test(l)), made.lines.join(' | '));
    asked = 0;
    up = 2;
    const st = await post(f, '/api/gatewayhost/relay/start', { confirm: 'box2' });
    assert.ok(asked > 2, `it waited for the port (asked ${asked} times)`);
    assert.deepEqual(st.lines, ['Started Relay\'s service']);
    asked = 0;
    up = 1e9;
    const late = await post(make(600), '/api/gatewayhost/relay/start', { confirm: 'box2' });
    assert.match(late.lines.at(-1), /^Relay does not answer on port 8197 yet: press Refresh in a moment$/);
  } finally {
    await post(f, '/api/gatewayhost/relay/service', { on: false, confirm: 'box2' });
  }
});
