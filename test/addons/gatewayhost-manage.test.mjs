// The gateway's own acts on Health (src/addons/gatewayhost.mjs): Set up as a background job, Restart, the log, the
// first password and a new one. Only the owner's page and a linked main computer may press them (Tia's request, caller
// "self", is refused on every GET and POST), every change names this computer, a second Set up is refused while one
// runs, and nothing that comes back holds a key, a token or a password.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gatewayhost-manage');
test.after(() => box.cleanup());
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const FOLDER = path.join(box.root, 'tdata');
fs.mkdirSync(FOLDER);
const PWFILE = path.join(FOLDER, 'initial-admin-password.txt');
fs.writeFileSync(PWFILE, 'FIRSTPASSWORD-abcdef\n');
const LOG = path.join(box.root, 'gw.log');
fs.writeFileSync(LOG, `${Array.from({ length: 130 }, (_, i) => `started ${i}`).join('\n')}\ninitial password: FIRSTPASSWORD-abcdef\nready\n`);

let running = true;
const calls = [];
const mk = (over = {}) => ({
  id: 'trouteai', title: 'TRouteAI', defined: false, gateway: { port: () => 20999 },
  command: () => ['/opt/trouteai/bin/trouteai.mjs', '--port', '20999'],
  listen: () => ({ args: ['--host', '127.0.0.1'], env: { HOST: '127.0.0.1' } }),
  status: async () => ({ installed: true, running }),
  start: async () => (calls.push('start'), (running = true), { ok: true }),
  stop: async () => (calls.push('stop'), (running = false), { ok: true }),
  ...over,
});
let addon = mk();
let release;
const slow = new Promise((r) => (release = r));
const setups = [];
const inputs = [];
const feature = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: (req) => req.caller || 'page' }, {
  addons: () => [addon, { id: 'mine', title: 'Mine', defined: true, gateway: { port: () => 20998 }, status: async () => ({ installed: true, running: false }) }],
  computer: () => 'box2',
  plan: () => ({ kind: 'none', sentence: 'no service here' }),
  run: async () => ({ ok: true, stdout: '', stderr: '' }),
  setup: async ({ onLine, computer }) => {
    setups.push(computer);
    onLine('Installing TRouteAI…');
    await slow;
    return { ok: true, kept: false, name: 'api' };
  },
  base: { dataFolder: () => FOLDER },
  logFile: () => LOG,
  runInput: async (argv, text) => (inputs.push({ argv, text }), { ok: true, stdout: '', stderr: '' }),
});
const route = (method, p) => {
  for (const [m, re, fn] of feature.routes) {
    const hit = re.exec(p);
    if (hit && m === method) return (body, caller, q) => fn({ body, caller }, hit, q);
  }
  throw new Error(`no route ${method} ${p}`);
};
const refused = (e) => e.status === 403;

test('Set up: needs the computer\'s name, refuses Tia, runs as one job, a second press is refused while it runs', async () => {
  const go = route('POST', '/api/gatewayhost/trouteai/setup');
  await assert.rejects(go({}), (e) => e.status === 400 && /confirm/.test(e.message));
  await assert.rejects(go({ confirm: 'box2' }, 'self'), refused);
  await assert.rejects(route('GET', '/api/gatewayhost/trouteai/setup/job')({}, 'self'), refused);
  assert.deepEqual(await go({ confirm: 'box2' }), { started: true });
  await assert.rejects(go({ confirm: 'box2' }), (e) => e.status === 409 && /busy/.test(e.message));
  const during = await route('GET', '/api/gatewayhost/trouteai/setup/job')({});
  assert.equal(during.running, true);
  assert.deepEqual(during.lines, ['Installing TRouteAI…']);
  release();
  for (let i = 0; i < 50 && (await route('GET', '/api/gatewayhost/trouteai/setup/job')({})).running; i++) await new Promise((r) => setTimeout(r, 20));
  const done = await route('GET', '/api/gatewayhost/trouteai/setup/job')({}, undefined, new URLSearchParams('from=1'));
  assert.equal(done.running, false);
  assert.equal(done.result.ok, true);
  assert.deepEqual(setups, ['box2']);
  assert.equal(done.lines.at(-1), 'TRouteAI is set up.');
  await assert.rejects(route('POST', '/api/gatewayhost/mine/setup')({ confirm: 'box2' }), (e) => e.status === 404, 'a gateway the owner defined has no set-up');
});

test('Restart: stops what runs and starts it again; a request without the name or from Tia changes nothing', async () => {
  calls.length = 0;
  const go = route('POST', '/api/gatewayhost/trouteai/restart');
  await assert.rejects(go({}), (e) => e.status === 400);
  await assert.rejects(go({ confirm: 'box2' }, 'self'), refused);
  assert.deepEqual(calls, []);
  const r = await go({ confirm: 'box2' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['stop', 'start']);
  assert.deepEqual(r.lines, ['Stopped TRouteAI', 'Started TRouteAI']);
  running = false;
  calls.length = 0;
  await go({ confirm: 'box2' });
  assert.deepEqual(calls, ['start'], 'one that was not running is only started');
  addon = mk({ stop: async () => ({ ok: false, error: 'it would not stop' }) });
  running = true;
  await assert.rejects(go({ confirm: 'box2' }), (e) => e.status === 409 && /would not stop/.test(e.message));
  addon = mk();
});

test('the log: the last 100 lines, the line with the first password left out and counted, how it listens in one line', async () => {
  await assert.rejects(route('GET', '/api/gatewayhost/trouteai/log')({}, 'self'), refused);
  const r = await route('GET', '/api/gatewayhost/trouteai/log')({});
  assert.ok(r.lines.length <= 100 && r.lines.at(-1) === 'ready');
  assert.equal(r.left, 1);
  assert.ok(!JSON.stringify(r).includes('FIRSTPASSWORD'));
  assert.match(r.listens, /this computer only/);
  fs.rmSync(LOG);
  assert.deepEqual((await route('GET', '/api/gatewayhost/trouteai/log')({})).lines, [], 'no file yet is an empty log');
  fs.writeFileSync(LOG, 'x\n');
});

test('Remove has no route here: it is the add-on\'s own job (/api/addons/<id>/remove), so it exists once', () => {
  assert.throws(() => route('POST', '/api/gatewayhost/trouteai/remove'), /no route/);
});

test('the first password: its file is named and never read; a new one goes by standard input, never by argument or answer', async () => {
  await assert.rejects(route('GET', '/api/gatewayhost/trouteai/password')({}, 'self'), refused);
  const where = await route('GET', '/api/gatewayhost/trouteai/password')({});
  assert.deepEqual(where, { file: PWFILE, exists: true });
  const go = route('POST', '/api/gatewayhost/trouteai/password');
  await assert.rejects(go({ password: 'longenough1' }), (e) => e.status === 400 && /confirm/.test(e.message));
  await assert.rejects(go({ confirm: 'box2', password: 'longenough1' }, 'self'), refused);
  await assert.rejects(go({ confirm: 'box2', password: 'short' }), (e) => e.status === 400);
  await assert.rejects(go({ confirm: 'box2', password: 'two\nlines-here' }), (e) => e.status === 400);
  assert.equal(inputs.length, 0);
  const r = await go({ confirm: 'box2', password: 'new-password-123' });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes('new-password-123'));
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].text, 'new-password-123');
  assert.deepEqual(inputs[0].argv.slice(-4), ['reset-password', '--password-stdin', '--data-dir', FOLDER]);
  assert.ok(!inputs[0].argv.join(' ').includes('new-password-123'), 'not in the command line');
});

test('Tia\'s door refuses every one of these routes', () => {
  for (const [m, p] of [['POST', '/api/gatewayhost/trouteai/setup'], ['GET', '/api/gatewayhost/trouteai/setup/job'], ['POST', '/api/gatewayhost/trouteai/restart'], ['GET', '/api/gatewayhost/trouteai/log'], ['GET', '/api/gatewayhost/trouteai/password'], ['POST', '/api/gatewayhost/trouteai/password'], ['POST', '/m/box2/api/gatewayhost/trouteai/setup']]) {
    assert.throws(() => checkRoute(m, p, { confirm: 'box2' }), (e) => e.status === 403, `${m} ${p}`);
  }
});
