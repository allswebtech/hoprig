// The public address route of the shipped gateway (src/addons/gatewayhost.mjs → trouteaipublic.mjs): only the owner's own
// browser may press it (a linked computer's token, Tia and a coding session are refused), it asks for this computer's name,
// it turns on only after every refusal, it writes the name, the service file's environment and restarts the gateway, and
// off takes all three out again. The Password press now also removes the first-password file. Stand-ins for the tunnel
// steps, the sign-in state and the programs: nothing of the real system is reached.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewayhost-public');
test.after(() => box.cleanup());
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
const { servicePlan } = await import('../../src/addons/gatewayservice.mjs');
const { listenRule } = await import('../../src/addons/localgateway.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { fixedStateFile } = await import('../../src/addons/cloudflared.mjs');
const { gatewayPort } = await import('../../src/addons/trouteaipublic.mjs');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const FOLDER = path.join(box.root, 'tdata');
fs.mkdirSync(FOLDER);
const PWFILE = path.join(FOLDER, 'initial-admin-password.txt');
const PORT = gatewayPort();
const NAME = 'tai-pc.example.com';
const env = { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: path.join(box.home, '.config') }; // seal: read by the service plan only; the stand-in run starts no program
const unitFile = path.join(env.XDG_CONFIG_HOME, 'systemd', 'user', 'hoprig-gateway-trouteai.service');
const writeFixed = (extra = []) => {
  fs.mkdirSync(path.dirname(fixedStateFile()), { recursive: true });
  fs.writeFileSync(fixedStateFile(), JSON.stringify({ mode: 'named', hostname: 'pc.example.com', tunnelId: 'id', extra }));
};
const readFixed = () => JSON.parse(fs.readFileSync(fixedStateFile(), 'utf8'));

let running = true;
let gwVersion = '1.0.13';
const log = [];
const def = { id: 'trouteai', localOnly: ['--host', '127.0.0.1'] };
const addon = {
  id: 'trouteai', title: 'TRouteAI', defined: false, gateway: { port: () => PORT },
  command: () => ['/opt/trouteai/bin/trouteai.mjs', '--port', String(PORT)],
  listen: () => listenRule(def, { host: '127.0.0.1', reason: null, tailscale: false, shipped: true }),
  status: async () => ({ installed: true, running, version: gwVersion }),
  start: async () => (log.push('start'), (running = true), { ok: true }),
  stop: async () => (log.push('stop'), (running = false), { ok: true }),
};
let linkOn = true;
let signIn = { requireLogin: true, signInSet: true, oidcEnabled: false };
let mayRefuse = null;
const steps = [];
const told = [];
const feature = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: (req) => req.caller || 'page' }, {
  addons: () => [addon],
  computer: () => 'box2',
  plan: (a) => servicePlan(a, { platform: 'linux', env, home: box.home }),
  run: async (argv) => ({ ok: true, stdout: '', stderr: '', argv }),
  base: { dataFolder: () => FOLDER },
  tokenOf: (req) => req.token || null,
  linkBusy: () => mayRefuse === 'busy',
  markTold: () => told.push('told'),
  runInput: async () => ({ ok: true, stdout: '', stderr: '' }),
  answerWaitMs: 0,
  public: {
    link: async () => ({ on: linkOn, kind: 'custom' }),
    signIn: async () => signIn,
    openApi: async () => null,
    look: async () => true,
    step: async (n, b, o) => {
      steps.push([n, b, o.internal]);
      const st = readFixed();
      if (n === 'add-service') writeFixed([...st.extra, { hostname: b.hostname, port: b.port, ...(o.internal === 'trouteai' ? { gateway: 'trouteai' } : {}) }]);
      else {
        writeFixed(st.extra.filter((x) => x.hostname !== b.hostname));
        o.onLine?.(`${b.hostname} no longer leads here. Its DNS record stays in Cloudflare (cloudflared cannot remove it): delete it under your domain.`);
      }
      return { ok: true, changed: true };
    },
  },
});
const route = (method, p) => {
  for (const [m, re, fn] of feature.routes) {
    const hit = re.exec(p);
    if (hit && m === method) return (body, req = {}) => fn({ body, headers: { cookie: 'hoprig=1' }, ...req }, hit);
  }
  throw new Error(`no route ${method} ${p}`);
};
const P = '/api/gatewayhost/trouteai/public';
const refused = (status, need) => (e) => e.status === status && (need === undefined || e.details?.need === need);

test('the owner\'s own browser only: a linked computer\'s token, Tia and a request with no sign-in cookie are refused, and so is a missing confirmation', async () => {
  writeFixed();
  const body = { confirm: 'box2', on: true };
  await assert.rejects(route('POST', P)(body, { token: 'tok-hub' }), refused(403));
  await assert.rejects(route('POST', P)(body, { caller: 'self' }), refused(403));
  await assert.rejects(route('POST', P)(body, { headers: {} }), refused(403));
  await assert.rejects(route('POST', P)({ on: true }), refused(400));
  await assert.rejects(route('POST', P)({ confirm: 'box3', on: true }), refused(400));
  await assert.rejects(route('POST', P)({ confirm: 'box2' }), refused(400));
  assert.deepEqual(steps, [], 'nothing was made by any of them');
  assert.deepEqual(readFixed().extra, []);
  await assert.rejects(route('GET', P)({}, { caller: 'self' }), refused(403), 'Tia cannot even read it');
  assert.equal((await route('GET', P)({}, { token: 'tok-hub' })).state, 'off', 'a linked computer may read it');
  // Tia's door refuses the routes before they run.
  for (const [m, p] of [['POST', P], ['GET', P]]) assert.throws(() => checkRoute(m, p), (e) => e.status === 403 && e.code === 'tia-route', `${m} ${p}`);
});

test('turned on only after its refusals: each gives 409 with its code and writes nothing', async () => {
  writeFixed();
  const on = () => route('POST', P)({ confirm: 'box2', on: true });
  fs.writeFileSync(PWFILE, 'FIRST\n');
  await assert.rejects(on(), refused(409, 'first-password'));
  fs.rmSync(PWFILE);
  signIn = { requireLogin: false, signInSet: true, oidcEnabled: false };
  await assert.rejects(on(), refused(409, 'no-password'));
  signIn = { requireLogin: true, signInSet: true, oidcEnabled: false };
  linkOn = false;
  await assert.rejects(on(), refused(409, 'link-off'));
  linkOn = true;
  mayRefuse = 'busy';
  await assert.rejects(on(), refused(409, 'busy'));
  mayRefuse = null;
  running = false;
  await assert.rejects(on(), refused(409, 'not-running'));
  running = true;
  // A gateway older than 1.0.13 does not treat a request for a public host name as from outside: refused, nothing written.
  for (const v of ['1.0.11', null]) {
    gwVersion = v;
    await assert.rejects(on(), refused(409, 'gateway-old'), `version ${v}`);
    assert.equal((await route('GET', P)({})).need, 'gateway-old');
  }
  gwVersion = '1.0.13';
  assert.deepEqual(steps, []);
  assert.deepEqual(readFixed().extra, []);
  assert.deepEqual(told, []);
});

test('on: the name is added by the internal step, the gateway restarts with its public base; a second press changes nothing', async () => {
  writeFixed();
  log.length = 0;
  const r = await route('POST', P)({ confirm: 'box2', on: true });
  assert.equal(r.ok, true);
  assert.deepEqual(steps.at(-1), ['add-service', { port: PORT, hostname: NAME, confirmed: true }, 'trouteai']);
  assert.deepEqual(readFixed().extra, [{ hostname: NAME, port: PORT, gateway: 'trouteai' }]);
  assert.deepEqual(log, ['stop', 'start'], 'TRouteAI restarted once');
  assert.deepEqual(told, ['told']);
  assert.equal(r.answers, true);
  assert.match(r.lines.join(' '), /answers/);
  assert.deepEqual(addon.listen().env, { HOST: '127.0.0.1', TROUTEAI_PUBLIC_BASE_URL: `https://${NAME}` }, 'every start now carries it');
  const again = await route('POST', P)({ confirm: 'box2', on: true });
  assert.equal(again.ok, true);
  assert.equal(steps.filter((s) => s[0] === 'add-service').length, 1, 'no second name');
  const st = await route('GET', P)({});
  assert.deepEqual({ s: st.state, u: st.url, t: st.told }, { s: 'on', u: `https://${NAME}`, t: false });
});

test('off: the name leaves the list, the gateway restarts without the base, fixed.json is as before', async () => {
  log.length = 0;
  const r = await route('POST', P)({ confirm: 'box2', on: false });
  assert.equal(r.ok, true);
  assert.deepEqual(steps.at(-1), ['remove-service', { hostname: NAME }, 'trouteai']);
  assert.deepEqual(readFixed().extra, []);
  assert.deepEqual(addon.listen().env, { HOST: '127.0.0.1' });
  assert.deepEqual(log, ['stop', 'start']);
});

test('with Start at boot on, the service file gets the base while the name exists and loses it after off', async () => {
  writeFixed();
  await route('POST', '/api/gatewayhost/trouteai/service')({ confirm: 'box2', on: true });
  assert.doesNotMatch(fs.readFileSync(unitFile, 'utf8'), /TROUTEAI_PUBLIC_BASE_URL/);
  running = true; // its service started it (the stand-in for systemctl does not)
  await route('POST', P)({ confirm: 'box2', on: true });
  assert.match(fs.readFileSync(unitFile, 'utf8'), new RegExp(`^Environment="TROUTEAI_PUBLIC_BASE_URL=https://${NAME}"$`, 'm'));
  assert.match(fs.readFileSync(unitFile, 'utf8'), /^Environment="HOST=127\.0\.0\.1"$/m, 'what was there stays');
  await route('POST', P)({ confirm: 'box2', on: false });
  assert.doesNotMatch(fs.readFileSync(unitFile, 'utf8'), /TROUTEAI_PUBLIC_BASE_URL/);
  await route('POST', '/api/gatewayhost/trouteai/service')({ confirm: 'box2', on: false });
});

test('the Password press needs 12 characters and removes the first-password file only after it worked', async () => {
  fs.writeFileSync(PWFILE, 'FIRST\n');
  const go = route('POST', '/api/gatewayhost/trouteai/password');
  await assert.rejects(go({ confirm: 'box2', password: 'only-eleven' }), refused(400));
  assert.ok(fs.existsSync(PWFILE), 'a refused password leaves the file');
  const r = await go({ confirm: 'box2', password: 'twelve-chars!' });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(PWFILE), false, 'the old first password is no longer valid, so its file is gone');
});

test('a press that changes nothing does not restart TRouteAI: off with no name, on with a name TRouteAI was already told', async () => {
  running = true;
  writeFixed();
  log.length = 0;
  const off = await route('POST', P)({ confirm: 'box2', on: false });
  assert.equal(off.ok, true);
  assert.deepEqual(log, [], 'nothing to take out, nothing restarted');
  writeFixed([{ hostname: NAME, port: PORT, gateway: 'trouteai', told: true }]);
  const on = await route('POST', P)({ confirm: 'box2', on: true });
  assert.equal(on.ok, true);
  assert.deepEqual(log, [], 'the name is there and TRouteAI knows it');
  writeFixed([{ hostname: NAME, port: PORT }]);
  await route('POST', P)({ confirm: 'box2', on: true });
  assert.deepEqual(log, ['stop', 'start'], 'a name made by hand: TRouteAI is told once, by one restart');
  writeFixed();
});

test('off says once that its DNS record stays in Cloudflare', async () => {
  running = true;
  writeFixed();
  await route('POST', P)({ confirm: 'box2', on: true });
  const r = await route('POST', P)({ confirm: 'box2', on: false });
  assert.equal(r.lines.filter((l) => /DNS record/.test(l)).length, 1, r.lines.join(' | '));
});
