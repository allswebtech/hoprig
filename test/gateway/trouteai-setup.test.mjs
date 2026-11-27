// Set up the shipped gateway with one press (src/gateway/trouteai.mjs): installed when missing, started, waited for,
// the session key made with the gateway's own command, the profile written; a profile whose key is accepted is left
// alone; a refused one gets a new key and the old key of that name is removed; a program of another user gets no token;
// every failure is one plain sentence with the next step; the key is never in a line or an answer. The gateway is the
// fake one (fakegateway.mjs) and the key command a stand-in that asks it the way the real command does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeGateway } from './fakegateway.mjs';

const box = sandbox('trouteai-setup');
test.after(() => box.cleanup());
const { setupShippedGateway, sessionKeyName, lastLines, listensSentence, programWords, scrub } = await import('../../src/gateway/trouteai.mjs');
const { readProfile, writeProfile } = await import('../../src/profiles.mjs');

const TOKEN = 'a'.repeat(64);
const OWNER_KEY = ['sk-', 'ant-owner-0123456789'].join('');
const FAKE_KEY = ['sk-', 'fake-1-0123456789abcdef0123456789abcdef'].join('');
const FOLDER = path.join(box.root, 'trouteai-data');
const goodBase = { dataFolder: () => FOLDER, sameUserListener: async () => 'own', commandToken: () => TOKEN };

/** The gateway's own command, as a stand-in: the same request the real one makes, with the token of the folder. */
const keyCommand = (gw, calls) => async (argv) => {
  calls.push(argv);
  const i = argv.indexOf('key');
  const r = await fetch(`http://127.0.0.1:${gw.port}/api/keys`, { method: 'POST', headers: { 'x-trouteai-cli-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ name: argv[i + 2] }) });
  const b = await r.json();
  return r.status === 201 ? { ok: true, stdout: `${b.key}\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'refused\n' };
};

function addonOf(gw, over = {}) {
  const log = [];
  const a = {
    id: 'trouteai', title: 'TRouteAI', installHint: () => 'npm install -g trouteai', gateway: { port: () => gw.port },
    installed: true,
    status: async () => ({ installed: a.installed, running: true }),
    install: async () => (log.push('install'), a.installed = true, { ok: true }),
    start: async () => (log.push('start'), { ok: true, url: `http://localhost:${gw.port}` }),
    command: () => ['/opt/trouteai/bin/trouteai.mjs', '--port', String(gw.port)],
    profile: () => ({ name: 'api', label: 'API via TRouteAI', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}` }, prerun: 'hoprig addons start trouteai', tokenVar: 'ANTHROPIC_AUTH_TOKEN' }),
    log,
    ...over,
  };
  return a;
}
const setup = (gw, addon, extra = {}) => {
  const lines = [];
  const keyCalls = [];
  const checks = [];
  return setupShippedGateway({ addon, computer: 'box9', onLine: (l) => lines.push(l), deps: { base: goodBase, run: keyCommand(gw, keyCalls), firstCheck: (p) => checks.push(p.name), pollMs: 10, waitMs: 300, ...extra } })
    .then((r) => ({ r, lines, keyCalls, checks }));
};
const reset = () => fs.rmSync(path.join(box.profiles, 'api.env'), { force: true });
const fileOf = () => fs.readdirSync(box.profiles).find((f) => f.startsWith('api'));

test('a fresh computer: installed, started, the key made by the gateway\'s own command, the profile written', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    const addon = addonOf(gw, { installed: false });
    const { r, lines, keyCalls, checks } = await setup(gw, addon);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(addon.log, ['install', 'start']);
    const argv = keyCalls[0];
    assert.deepEqual(argv.slice(-7), ['key', 'create', sessionKeyName('box9'), '--port', String(gw.port), '--data-dir', FOLDER]);
    const p = readProfile('api');
    assert.equal(p.label, 'API via TRouteAI');
    assert.equal(p.prerun, 'hoprig addons start trouteai');
    assert.match(p.env.ANTHROPIC_AUTH_TOKEN, /^sk-fake-/);
    assert.equal(gw.keys.length, 1);
    assert.equal(gw.keys[0].name, 'Hoprig sessions (box9)');
    assert.deepEqual(checks, ['api'], 'the existing first check runs');
    const everything = JSON.stringify([r, lines]);
    assert.ok(!everything.includes(p.env.ANTHROPIC_AUTH_TOKEN), 'the key is in no line and no answer');
    assert.ok(!everything.includes(TOKEN), 'the token is in no line and no answer');
  } finally {
    await gw.close();
  }
});

test('the token goes only in its own header to 127.0.0.1, with no forwarding header', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    await setup(gw, addonOf(gw));
    const withToken = gw.seen.filter((s) => s.headers['x-trouteai-cli-token']);
    assert.ok(withToken.length >= 1);
    for (const s of withToken) {
      assert.equal(s.headers['x-forwarded-for'], undefined);
      assert.match(s.headers.host, /^127\.0\.0\.1:/);
    }
  } finally {
    await gw.close();
  }
});

test('a profile whose key the gateway accepts is left untouched; no key is made', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    const mine = await fetch(`http://127.0.0.1:${gw.port}/api/keys`, { method: 'POST', headers: { 'x-trouteai-cli-token': TOKEN }, body: '{"name":"mine"}' }).then((x) => x.json());
    writeProfile('api', { label: 'My own label', prerun: 'x', models: '*=combo', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: mine.key } });
    const before = fs.readFileSync(path.join(box.profiles, fileOf()), 'utf8');
    const { r, keyCalls, checks } = await setup(gw, addonOf(gw));
    assert.equal(r.ok, true);
    assert.equal(r.kept, true);
    assert.equal(keyCalls.length, 0);
    assert.equal(fs.readFileSync(path.join(box.profiles, fileOf()), 'utf8'), before);
    assert.deepEqual(checks, ['api']);
  } finally {
    await gw.close();
  }
});

test('a refused key: a new one is made, the old key of that name is removed, the profile keeps its name, label, models and start line; a second press piles up nothing', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    await fetch(`http://127.0.0.1:${gw.port}/api/keys`, { method: 'POST', headers: { 'x-trouteai-cli-token': TOKEN }, body: JSON.stringify({ name: 'Hoprig sessions (box9)' }) });
    await fetch(`http://127.0.0.1:${gw.port}/api/keys`, { method: 'POST', headers: { 'x-trouteai-cli-token': TOKEN }, body: JSON.stringify({ name: 'Hoprig sessions (other)' }) });
    writeProfile('api', { label: 'My own label', prerun: 'my start line', models: '*=combo-best', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: 'refused-key-0123456789' } });
    for (let i = 0; i < 2; i++) {
      writeProfile('api', { ...(({ label, prerun, models }) => ({ label, prerun, models }))(readProfile('api')), env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: 'refused-key-0123456789' } });
      const { r } = await setup(gw, addonOf(gw));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const p = readProfile('api');
    assert.equal(p.label, 'My own label');
    assert.equal(p.prerun, 'my start line');
    assert.equal(p.models, '*=combo-best');
    assert.equal(p.env.ANTHROPIC_BASE_URL, `http://localhost:${gw.port}`);
    assert.match(p.env.ANTHROPIC_AUTH_TOKEN, /^sk-fake-/);
    assert.deepEqual(gw.keys.map((k) => k.name).sort(), ['Hoprig sessions (box9)', 'Hoprig sessions (other)'], 'one key of this name, the other computer\'s untouched');
  } finally {
    await gw.close();
  }
});

test('a profile of the same name that is not this gateway (an Anthropic key) is left as it was; the new key goes to a free name', async () => {
  reset();
  fs.rmSync(path.join(box.profiles, 'api2.env'), { force: true });
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    writeProfile('api', { env: { ANTHROPIC_API_KEY: OWNER_KEY } });
    const { r } = await setup(gw, addonOf(gw));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(readProfile('api').env.ANTHROPIC_API_KEY, OWNER_KEY);
    assert.notEqual(r.name, 'api');
    assert.equal(readProfile(r.name).env.ANTHROPIC_BASE_URL, `http://localhost:${gw.port}`);
    assert.match(readProfile(r.name).env.ANTHROPIC_AUTH_TOKEN, /^sk-fake-/);
  } finally {
    fs.rmSync(path.join(box.profiles, 'api2.env'), { force: true });
    await gw.close();
  }
});

test('a listener of another user, or one whose owner cannot be told, gets no token and no key request', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    for (const who of ['foreign', 'none']) {
      const { r, keyCalls } = await setup(gw, addonOf(gw), { base: { ...goodBase, sameUserListener: async () => who } });
      assert.equal(r.ok, false);
      assert.match(r.error, /does not run as your user/);
      assert.match(r.error, /Next step/);
      assert.equal(keyCalls.length, 0);
    }
    assert.equal(gw.seen.filter((s) => s.headers['x-trouteai-cli-token']).length, 0, 'no token reached it');
    assert.equal(gw.seen.filter((s) => s.headers.authorization).length, 0, 'no key reached it');
    assert.equal(readProfile('api'), null);
  } finally {
    await gw.close();
  }
});

test('a command token that cannot be used (wrong mode, wrong owner, missing) ends in a sentence and nothing is sent', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    const { r, keyCalls } = await setup(gw, addonOf(gw), { base: { ...goodBase, commandToken: () => null } });
    assert.equal(r.ok, false);
    assert.match(r.error, /command token could not be used/);
    assert.match(r.error, /Next step/);
    assert.equal(keyCalls.length, 0);
    assert.equal(gw.seen.filter((s) => s.headers['x-trouteai-cli-token']).length, 0);
  } finally {
    await gw.close();
  }
});

test('the gateway refuses the token: one plain sentence, no profile', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: 'b'.repeat(64) } });
  try {
    const { r } = await setup(gw, addonOf(gw));
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 401/);
    assert.match(r.error, /Next step/);
    assert.ok(!r.error.includes(TOKEN));
    assert.equal(readProfile('api'), null);
  } finally {
    await gw.close();
  }
});

test('it never says ready: a sentence with the next step; a failed install and a failed start too', async () => {
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN, ready: false } });
  try {
    const slow = await setup(gw, addonOf(gw), { waitMs: 150 });
    assert.equal(slow.r.ok, false);
    assert.match(slow.r.error, /did not say ready/);
    assert.match(slow.r.error, /Next step/);
    const noInstall = await setup(gw, addonOf(gw, { installed: false, install: async () => ({ ok: false }) }));
    assert.match(noInstall.r.error, /could not be installed\. Next step: npm install -g trouteai/);
    const noStart = await setup(gw, addonOf(gw, { start: async () => ({ ok: false, error: 'TRouteAI stopped at once (exit code -2).' }) }));
    assert.match(noStart.r.error, /stopped at once \(exit code -2\)\. Next step/);
  } finally {
    await gw.close();
  }
});

test('the words of the key command: the program up to its first option; a failed command says a sentence without secrets', async () => {
  assert.deepEqual(programWords({ command: () => ['/opt/x/trouteai', '--port', '1'] }), ['/opt/x/trouteai']);
  assert.deepEqual(programWords({ command: () => ['/usr/bin/node', '/opt/x/bin/trouteai.mjs', '--port', '1', '--data-dir', '/d'] }), ['/usr/bin/node', '/opt/x/bin/trouteai.mjs']);
  assert.equal(scrub(`refused ${FAKE_KEY} now`), 'refused … now');
  reset();
  const gw = await fakeGateway({ managed: { token: TOKEN } });
  try {
    const { r } = await setup(gw, addonOf(gw), { run: async () => ({ ok: false, stdout: '', stderr: `oops ${FAKE_KEY}\n` }) });
    assert.equal(r.ok, false);
    assert.ok(!/sk-fake/.test(r.error), r.error);
    assert.match(r.error, /Next step/);
  } finally {
    await gw.close();
  }
});

test('the log: the last 100 lines, a line that may hold a secret is left out and counted', () => {
  const text = [...Array.from({ length: 150 }, (_, i) => `line ${i}`), 'Authorization: Bearer abc', 'initial password: hunter22', 'GET /v1/models 200', 'x-api-key sk-live-123456'].join('\n');
  const { lines, left } = lastLines(text);
  assert.equal(lines.length + left, 100);
  assert.equal(left, 3);
  assert.ok(lines.includes('GET /v1/models 200'));
  assert.ok(!lines.join('\n').match(/hunter22|Bearer|sk-live/));
  assert.deepEqual(lastLines('\u001b[32mgreen\u001b[0m').lines, ['green']);
});

test('the log: a line that repeats one after another is one line with a count; the left-out count stays', () => {
  const err = 'Error: connect ECONNREFUSED 127.0.0.1:5432';
  const text = ['banner', ...Array(13).fill(err), 'banner', 'banner', 'banner', 'initial password: hunter22', 'ok', 'ok again', err, err].join('\n');
  const { lines, left } = lastLines(text);
  assert.deepEqual(lines, ['banner', err, 'the line above came 12 more times', 'banner', 'the line above came 2 more times', 'ok', 'ok again', err, 'the line above came 1 more time']);
  assert.equal(left, 1);
});

test('how it listens, in one line: this computer only, or the network', () => {
  const only = listensSentence({ title: 'TRouteAI', listen: () => ({ args: ['--host', '127.0.0.1'], env: { HOST: '127.0.0.1' } }) });
  assert.match(only, /this computer only/);
  const wide = listensSentence({ title: 'TRouteAI', listen: () => ({ args: [], env: {} }) });
  assert.match(wide, /own HOST setting/);
  assert.doesNotMatch(wide, /other computers that can reach this one can use it/);
  assert.equal(listensSentence({ title: 'X' }), null);
});
