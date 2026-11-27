// The seams between the three parts of "the gateway built into Hoprig" (set up and lifecycle, accounts and limits, own-
// folder install): each was open when the parts were joined and is closed by one rule. One data folder everywhere; the
// key and password commands are the add-on's real command; Health's Remove is the add-on's one route; status carries
// copy, note and problem to the page; Set up refuses a gateway of another user.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gateway-seams');
test.after(() => box.cleanup());
const DATA = path.join(box.root, 'seam-data');
process.env.DATA_DIR = DATA;
const { localGateway } = await import('../../src/addons/localgateway.mjs');
const { SHIPPED } = await import('../../src/addons/gateways.mjs');
const { ownProgramCommand, setupShippedGateway } = await import('../../src/gateway/trouteai.mjs');
const { dataFolder } = await import('../../src/gateway/trouteaibase.mjs');
const { gatewayManageFeature } = await import('../../src/addons/gatewaymanage.mjs');
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
const { addonsFeature } = await import('../../src/addons/feature.mjs');
const { toolsDir } = await import('../../src/paths.mjs');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
// npm's run() as a stand-in: writes a made-up package where --prefix says.
const fakeNpm = () => async (argv) => {
  const prefix = argv[argv.indexOf('--prefix') + 1];
  const pkg = path.join(prefix, 'node_modules', 'trouteai');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'trouteai', version: '1.0.11', bin: { trouteai: 'bin/trouteai.mjs' } }));
  fs.writeFileSync(path.join(pkg, 'bin', 'trouteai.mjs'), '// stand-in\n');
  fs.mkdirSync(path.join(prefix, 'node_modules', '.bin'), { recursive: true });
  fs.rmSync(path.join(prefix, 'node_modules', '.bin', 'trouteai'), { force: true });
  fs.symlinkSync(path.join('..', 'trouteai', 'bin', 'trouteai.mjs'), path.join(prefix, 'node_modules', '.bin', 'trouteai'));
  return { ok: true, code: 0 };
};
const check = async () => ({ ok: true, stdout: 'TRouteAI 1.0.11\n', stderr: '' });

test('one data folder: the start line, the key and password commands and the management client all use the folder of dataFolder()', async () => {
  fs.rmSync(path.join(toolsDir(), 'trouteai'), { recursive: true, force: true });
  const g = localGateway(SHIPPED[0], { shipped: true, reason: () => null, tools: { run: fakeNpm(), check }, sameUser: async () => 'own' });
  const lines = [];
  assert.equal((await g.install({ onLine: (l) => lines.push(l) })).ok, true, lines.join(' / '));
  assert.equal(dataFolder(), DATA);
  const line = g.command();
  assert.deepEqual(line.slice(-2), ['--data-dir', DATA], 'the start line');
  const key = ownProgramCommand(g, ['key', 'create', 'k', '--port', '1'], dataFolder());
  assert.deepEqual(key.args.slice(-2), ['--data-dir', DATA], 'the key command');
  const pw = ownProgramCommand(g, ['reset-password', '--password-stdin'], dataFolder());
  assert.deepEqual(pw.args.slice(-2), ['--data-dir', DATA], 'the password command');
  // the management client: the folder the routes hand to it when nothing is wired
  const seen = [];
  const feature = gatewayManageFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page' }, {
    addons: () => [{ id: 'trouteai', title: 'TRouteAI', gateway: { port: () => 20999 } }],
    computer: () => 'box2',
    call: async (method, p, o) => (seen.push(o.folder), { providers: [] }),
  });
  const [, re, fn] = feature.routes.find(([m, r]) => m === 'GET' && r.test('/api/gatewayhost/trouteai/accounts'));
  await fn({ body: {} }, re.exec('/api/gatewayhost/trouteai/accounts'), new URLSearchParams()).catch(() => {});
  assert.ok(seen.length && seen.every((f) => f === DATA), `the client got ${JSON.stringify(seen)}`);
});

test('the key command is built from the add-on\'s real command: node plus the entry for an own copy, the program for a global one', () => {
  const own = { command: () => ['/usr/bin/node', '/t/node_modules/trouteai/bin/trouteai.mjs', '--port', '20017', '--data-dir', '/d'] };
  const a = ownProgramCommand(own, ['key', 'create', 'k'], '/d');
  assert.equal(a.command, '/usr/bin/node');
  assert.deepEqual(a.args, ['/t/node_modules/trouteai/bin/trouteai.mjs', 'key', 'create', 'k', '--data-dir', '/d']);
  const global = { command: () => ['/opt/bin/trouteai', '--port', '20017'] };
  const b = ownProgramCommand(global, ['key', 'create', 'k'], '/d');
  assert.equal(b.command, '/opt/bin/trouteai');
  assert.deepEqual(b.args, ['key', 'create', 'k', '--data-dir', '/d']);
  assert.equal(ownProgramCommand({ command: () => [] }, ['key'], '/d'), null);
});

const addonOf = (over = {}) => {
  const calls = [];
  return {
    calls,
    addon: {
      id: 'trouteai', title: 'TRouteAI', installHint: () => 'hoprig addons install trouteai', gateway: { port: () => 20999 },
      status: async () => ({ installed: true, running: false }),
      install: async () => (calls.push('install'), { ok: true }),
      start: async () => (calls.push('start'), { ok: true }),
      command: () => ['/o/bin/t', '--port', '20999'],
      profile: () => ({ name: 'api', label: 'API', env: {}, prerun: 'p', tokenVar: 'ANTHROPIC_AUTH_TOKEN' }),
      ...over,
    },
  };
};

test('Set up on a computer where the gateway is another user\'s program: it refuses with the next step and installs and starts nothing', async () => {
  const { addon, calls } = addonOf({ status: async () => ({ installed: true, running: false, foreign: true, note: 'TRouteAI answers on port 20999, but that program belongs to another user: Hoprig leaves it alone and sends it no key.' }) });
  const r = await setupShippedGateway({ addon, computer: 'box9', deps: { waitMs: 50, pollMs: 10 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /belongs to another user/);
  assert.match(r.error, /Next step: stop that program/);
  assert.deepEqual(calls, []);
  const other = addonOf({ status: async () => ({ installed: true, running: false, foreign: true }) });
  const r2 = await setupShippedGateway({ addon: other.addon, computer: 'box9', deps: { waitMs: 50, pollMs: 10 } });
  assert.match(r2.error, /Another program answers on port 20999/);
  assert.deepEqual(other.calls, []);
});

test('Set up on a damaged own copy installs it again before it starts', async () => {
  const { addon, calls } = addonOf({ status: async () => ({ installed: true, running: false, copy: 'own', problem: 'the copy is damaged' }), start: async () => (calls.push('start'), { ok: false, error: 'stop here.' }) });
  const r = await setupShippedGateway({ addon, computer: 'box9', deps: { waitMs: 50, pollMs: 10 } });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, ['install', 'start']);
});

test('Health\'s list carries copy, note, problem and foreign; Remove is the add-on\'s one route, not a second one', async () => {
  const { addon } = addonOf({ status: async () => ({ installed: true, running: false, copy: 'global', note: 'another user answers', problem: 'damaged', foreign: true }) });
  const host = gatewayHostFeature({ HttpError, readJson: async (req) => req.body, caller: () => 'page', signedInHosts: () => [] }, { addons: () => [addon], computer: () => 'box2', plan: () => ({ kind: 'none', sentence: 'none' }), run: async () => ({ ok: true, stdout: '', stderr: '' }) });
  const [, re, fn] = host.routes.find(([m, r]) => m === 'GET' && r.test('/api/gatewayhost'));
  const list = await fn({ body: {} }, re.exec('/api/gatewayhost'));
  const g = list.gateways[0];
  assert.deepEqual([g.copy, g.note, g.problem, g.foreign], ['global', 'another user answers', 'damaged', true]);
  const removes = (routes, p) => routes.filter(([m, r]) => m === 'POST' && r.test(p));
  assert.equal(removes(host.routes, '/api/gatewayhost/trouteai/remove').length, 0);
  const add = addonsFeature({ readJson: async (req) => req.body, HttpError }, { addons: [addon] });
  assert.equal(removes(add.routes, '/api/addons/trouteai/remove').length, 1);
});

test('the page: Health\'s Remove and Update are the add-on\'s jobs, and the row says the copy, the note and the problem', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web', 'health.js'), 'utf8');
  assert.ok(!/gatewayhost\/\$\{g\.id\}\/remove/.test(src), 'no second Remove route');
  assert.match(src, /addonJob\('remove'/);
  assert.match(src, /addonJob\('update'/);
  assert.match(src, /g\.note \?/);
  assert.match(src, /g\.problem \?/);
  assert.match(src, /g\.copy === 'global'/);
});

test('hoprig help addons names remove', async () => {
  const { helpText } = await import('../../src/helptext.mjs');
  const text = await helpText('addons');
  assert.match(String(text), /hoprig addons remove <id>/);
});
