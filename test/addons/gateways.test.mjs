// Gateways are data (src/addons/gateways.mjs): every rule of a definition the owner writes, his definitions next to
// what the configuration keeps about sharing, and a second gateway ("Relay", a stand-in program in this test's own
// folder) that is an add-on like the shipped one: found, nothing to install, started with exactly its arguments and
// a pid file of its own, a profile that starts it, stopped, removed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('gateways');
const POSIX = { skip: process.platform === 'win32' }; // the stand-in is a script started by its "#!" line
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// The tests use RELAY_PORT and some ports after it (+1 to +21), and the product refuses a port on which something
// answers. A port the system hands out is followed by the ports it hands to the next askers (macOS gives them out one
// after another), and another test file's server then answers on RELAY_PORT + 11. So the block is taken BELOW the
// ranges the systems hand out from (Linux from 32768, macOS and Windows from 49152), at random, and looked at once:
// every port of it is free. (Not 7433 and 20017, which the product names as the dashboard's and the shipped gateway's.)
const isFree = (port) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
const freeBlock = async (n) => {
  for (let i = 0; i < 100; i++) {
    const base = 21000 + Math.floor(Math.random() * 8000);
    if ((await Promise.all(Array.from({ length: n }, (_, k) => isFree(base + k)))).every(Boolean)) return base;
  }
  throw new Error('no free block of ports for the test');
};
const RELAY_PORT = await freeBlock(25);

// Relay: writes down what it was started with, then answers on the port it is given.
const bin = path.join(box.root, 'bin');
fs.mkdirSync(bin);
const relay = path.join(bin, 'relay');
fs.writeFileSync(relay, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(path.join(box.root, 'relay-args.txt'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
const at = process.argv.find((a) => a.startsWith('--listen=127.0.0.1:'));
require('node:http').createServer((q, s) => s.end('relay')).listen(Number(at.split(':').pop()), '127.0.0.1');
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
test.after(() => {
  try { process.kill(JSON.parse(fs.readFileSync(path.join(box.state, 'addons', 'relay.pid'), 'utf8')).pid, 'SIGKILL'); } catch { /* none left */ }
  box.cleanup();
});

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
saveConfig({ server: { port: 7433 }, gateways: { shared: { trouteai: { provider: 'api' } }, keys: [] } });
const G = await import('../../src/addons/gateways.mjs');
const { allAddons, findAddon } = await import('../../src/addons/index.mjs');
const { binFile } = await import('../../src/paths.mjs');
const { fileSha256 } = await import('../../src/addons/localgateway.mjs');

const RELAY = { id: 'relay', title: 'Relay', bin: relay, port: RELAY_PORT, args: ['--listen=127.0.0.1:PORT'] };
const check = (raw, opts = {}) => G.checkDefinition(raw, { forAdd: true, ...opts });

test('a definition is checked strictly: each rule refuses what breaks it', () => {
  assert.ok(check(RELAY).def, 'the good one passes');
  const bad = [
    [{ ...RELAY, id: 'Relay' }, /the id is lower-case/],
    [{ ...RELAY, id: '1relay' }, /starting with a letter/],
    [{ ...RELAY, id: 'trouteai' }, /a gateway Hoprig ships/],
    ...G.NOT_IDS.map((id) => [{ ...RELAY, id }, /taken/]),
    [{ ...RELAY, title: '' }, /the title/],
    [{ ...RELAY, title: '<b>Relay</b>' }, /the title/],
    [{ ...RELAY, title: 'trouteai' }, /the name TRouteAI is another gateway's: choose another/],
    [{ ...RELAY, port: 80 }, /1024 to 65535/],
    [{ ...RELAY, port: 70000 }, /1024 to 65535/],
    [{ ...RELAY, port: '20100' }, /1024 to 65535/],
    [{ ...RELAY, port: 7433 }, /this dashboard's/],
    [{ ...RELAY, port: 20017 }, /TRouteAI's/],
    [{ ...RELAY, extra: 1 }, /"extra" is not part of a gateway/],
    [{ id: 'relay', title: 'Relay', port: RELAY_PORT }, /say the package \(npm\) or the program/],
    [{ ...RELAY, bin: path.join(box.root, 'missing') }, /^there is no file .* on this computer$/],
    [{ ...RELAY, bin: 'no-such-program-here' }, /^no program named no-such-program-here was found on PATH$/],
    [{ ...RELAY, bin: 'relay; rm -rf ~' }, /an absolute path or a plain name/],
    [{ ...RELAY, bin: './relay' }, /an absolute path or a plain name/],
    [{ ...RELAY, args: ['--port', '$(PORT)'] }, /the arguments use only/],
    [{ ...RELAY, args: ['--port PORT'] }, /the arguments use only/],
    [{ ...RELAY, args: ['--port', 'PORT', 'a;b'] }, /the arguments use only/],
    [{ ...RELAY, args: ['--port', 'PORT', '"x"'] }, /the arguments use only/],
    [{ ...RELAY, args: ['--port', '8080'] }, /PORT/],
    [{ ...RELAY, args: [] }, /1 to 16 words/],
    [{ ...RELAY, args: Array(17).fill('PORT') }, /1 to 16 words/],
    [{ ...RELAY, dashboard: 'javascript:alert(1)' }, /dashboard is the path/],
    [{ ...RELAY, homepage: 'http://relay.example' }, /https address/],
    [{ ...RELAY, profile: { token: 'OPENAI_API_KEY' } }, /the token is/],
    [{ ...RELAY, profile: { name: 'Bad Name' } }, /profile name/],
    [{ ...RELAY, words: { what: 'one\nline' } }, /one line/],
    [{ ...RELAY, words: { other: 'x' } }, /words is/],
  ];
  for (const [raw, why] of bad) assert.match(check(raw).error || '', why, JSON.stringify(raw));
  // Another definition's id and port are taken.
  assert.match(check({ ...RELAY, port: RELAY_PORT + 1 }, { others: [RELAY] }).error, /a gateway "relay" already/);
  assert.match(check({ ...RELAY, id: 'relay-two', title: 'Relay Two' }, { others: [{ ...RELAY, args: ['PORT'] }] }).error, /is Relay's/);
  // The shipped one's port as the configuration moved it.
  assert.match(check({ ...RELAY, port: 20555 }, { cfg: { addons: { trouteai: { port: 20555 } } } }).error, /TRouteAI's/);
});

test('an npm package name is checked as npm checks one, and never reads as an option', () => {
  for (const ok of ['relay', 'relay-gateway', 'relay.js', '@example/relay', 'a1_b']) assert.equal(G.npmNameProblem(ok), null, ok);
  for (const no of ['', 'Relay', '-g', '--prefix=/tmp', '.hidden', '_x', 'http://x/y.tgz', 'git+ssh://x', '../relay', 'a b', 'relay@1.0.0', 'fs', 'node_modules', '@example/', '@/x', 'x'.repeat(215)]) {
    assert.ok(G.npmNameProblem(no), no);
  }
  const d = check({ id: 'relay', title: 'Relay', npm: '@example/relay', port: RELAY_PORT }).def;
  assert.deepEqual([d.npm, d.bin], ['@example/relay', 'relay'], 'the program is the package\'s own name');
  assert.match(check({ id: 'relay', title: 'Relay', npm: 'relay', bin: '/abs/relay', port: RELAY_PORT }).error, /plain name/);
});

test('the words an id may not take include every other add-on', () => {
  for (const a of allAddons().filter((x) => !x.gateway)) assert.ok(G.NOT_IDS.includes(a.id), a.id);
});

test('definitions live next to the sharing state and leave it as it was; a broken one is skipped with its reason', async () => {
  assert.deepEqual(await G.addDefinition({ ...RELAY, bin: 'relay' }), { ok: true, def: { ...check({ ...RELAY, bin: 'relay' }).def } });
  const g = loadConfig().gateways;
  assert.deepEqual([g.shared, g.keys], [{ trouteai: { provider: 'api' } }, []]);
  // The name is pinned to the file it stands for now, with its fingerprint.
  assert.deepEqual(g.defined, [{ id: 'relay', title: 'Relay', port: RELAY_PORT, bin: relay, sha256: fileSha256(relay), typed: 'relay', args: ['--listen=127.0.0.1:PORT'] }]);
  assert.match((await G.addDefinition({ ...RELAY, port: RELAY_PORT + 1 })).error, /already/, 'not twice');
  saveConfig({ gateways: { ...g, defined: [...g.defined, { id: 'evil', title: 'Evil', bin: relay, port: RELAY_PORT + 2, args: ['$(touch x)', 'PORT'] }, 'not an object'] } });
  const { list, skipped } = G.definedGateways();
  assert.deepEqual(list.map((d) => d.id), ['relay']);
  assert.deepEqual(skipped.map((s) => [s.at, s.id]), [[1, 'evil'], [2, null]]);
  assert.match(skipped[0].error, /the arguments use only/);
  assert.equal(findAddon('evil'), null, 'a skipped one is no add-on');
  assert.deepEqual(G.removeDefinition('trouteai').ok, false, 'a shipped gateway is never removed');
  saveConfig({ gateways: { ...g } });
  assert.deepEqual(loadConfig().gateways.shared, { trouteai: { provider: 'api' } });
});

test('Relay is an add-on like the shipped one: nothing to install, started with exactly its arguments, a profile, stopped', POSIX, async () => {
  const a = findAddon('relay');
  assert.ok(a && a.gateway && a.defined && a.installable === false);
  assert.deepEqual(allAddons().map((x) => x.id), ['trouteai', 'relay', 'public-link']);
  let st = await a.status();
  assert.deepEqual([st.installed, st.version, st.running, st.url], [true, null, false, `http://localhost:${RELAY_PORT}`], 'a program is never asked for a version');
  const lines = [];
  assert.deepEqual(await a.install({ onLine: (l) => lines.push(l) }), { ok: true });
  assert.match(lines.join('\n'), /Relay is a program on this computer .*: there is nothing to install/);
  assert.equal((await a.update({ onLine: () => {} })).ok, true);
  assert.deepEqual(a.command(), [relay, `--listen=127.0.0.1:${RELAY_PORT}`]);
  const started = await a.start();
  assert.deepEqual([started.ok, started.already], [true, false], JSON.stringify(started));
  assert.deepEqual(fs.readFileSync(path.join(box.root, 'relay-args.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [[`--listen=127.0.0.1:${RELAY_PORT}`]]);
  assert.ok(fs.existsSync(path.join(box.state, 'addons', 'relay.pid')) && fs.existsSync(path.join(box.state, 'addons', 'relay.log')));
  st = await a.status();
  assert.equal(st.running, true);
  const p = a.profile();
  assert.deepEqual([p.name, p.label, p.env, p.tokenVar], ['relay', 'API via Relay', { ANTHROPIC_BASE_URL: `http://localhost:${RELAY_PORT}` }, 'ANTHROPIC_AUTH_TOKEN']);
  assert.ok(p.prerun.includes(binFile()) && p.prerun.endsWith(' addons start relay'));
  assert.equal(G.gatewayOfPrerun(p.prerun).id, 'relay');
  assert.equal((await a.stop()).ok, true);
  assert.equal((await a.status()).running, false);
  assert.equal(fs.existsSync(path.join(box.state, 'addons', 'relay.pid')), false);
  assert.deepEqual(G.removeDefinition('relay'), { ok: true });
  assert.equal(findAddon('relay'), null);
});

test('the page\'s sentences come from the definition, plain ones where it says none', () => {
  const shipped = findAddon('trouteai');
  assert.deepEqual(shipped.words, G.SHIPPED[0].words);
  const own = G.gatewayAddons({ gateways: { defined: [{ id: 'relay', title: 'Relay', bin: relay, port: RELAY_PORT }] } }).find((x) => x.id === 'relay');
  assert.deepEqual(Object.keys(own.words), ['what', 'choice', 'add', 'key']);
  for (const w of Object.values(own.words)) assert.match(w, /Relay/);
  assert.equal(own.page(), null, 'no page of its own: no address to open');
  assert.match(own.profile().tokenHint, /In Relay, create an API key/);
});

test('remove forgets everything kept about the gateway: a program added later under its id is not shared', async () => {
  const keys = await import('../../src/gateway/keys.mjs');
  assert.equal((await G.addDefinition(RELAY)).ok, true);
  keys.setShared('relay', 'api');
  const made = keys.createKey('relay', 'laptop');
  saveConfig({ addons: { ...loadConfig().addons, relay: { port: RELAY_PORT + 5 } } });
  assert.deepEqual(G.removeDefinition('relay'), { ok: true });
  const cfg = loadConfig();
  assert.equal(cfg.gateways.shared.relay, undefined, 'its sharing is gone');
  assert.deepEqual(cfg.gateways.keys.filter((k) => k.gateway === 'relay'), [], 'the keys other computers had are gone');
  assert.equal(cfg.addons?.relay, undefined, 'its port setting is gone');
  assert.deepEqual(cfg.gateways.shared.trouteai, { provider: 'api' }, 'another gateway\'s sharing stays');
  assert.equal((await G.addDefinition({ ...RELAY, title: 'Relay again' })).ok, true);
  assert.equal(keys.sharedProvider('relay'), null, 'a new program under the id starts with sharing off');
  assert.equal(keys.verifyKey(made.key, 'relay'), null, 'and with no key that works');
  assert.equal(findAddon('relay').gateway.port(), RELAY_PORT, 'and on the port its definition says');
  assert.deepEqual(G.removeDefinition('relay'), { ok: true });
});

test('adds at the same time (two tabs, the command and the page) keep each other, and a key removed meanwhile stays removed', async () => {
  const keys = await import('../../src/gateway/keys.mjs');
  const [a, b, twin] = await Promise.all([
    G.addDefinition({ ...RELAY, id: 'relay-a', title: 'Relay A', port: RELAY_PORT + 11 }),
    G.addDefinition({ ...RELAY, id: 'relay-b', title: 'Relay B', port: RELAY_PORT + 12 }),
    G.addDefinition({ ...RELAY, id: 'relay-a', title: 'Relay A2', port: RELAY_PORT + 13 }),
  ]);
  try {
    assert.deepEqual([a.ok, b.ok, twin.ok], [true, true, false], JSON.stringify([a, b, twin]));
    assert.match(twin.error, /there is a gateway "relay-a" already/);
    assert.deepEqual(G.definedGateways().list.map((d) => d.id), ['relay-a', 'relay-b']);
    const made = keys.createKey('trouteai', 'laptop');
    const adding = G.addDefinition({ ...RELAY, id: 'relay-c', title: 'Relay C', port: RELAY_PORT + 14 });
    keys.removeKey(made.id); // while the add knocks on its port
    assert.equal((await adding).ok, true);
    assert.equal(keys.verifyKey(made.key, 'trouteai'), null, 'the removed key does not come back');
    assert.deepEqual(G.definedGateways().list.map((d) => d.id), ['relay-a', 'relay-b', 'relay-c']);
  } finally {
    for (const id of ['relay-a', 'relay-b', 'relay-c']) G.removeDefinition(id);
  }
});

test('a definition that was not loaded keeps its id: a second one under it is refused, not written beside it', async () => {
  assert.equal((await G.addDefinition(RELAY)).ok, true);
  const keep = loadConfig().addons;
  saveConfig({ addons: { ...keep, trouteai: { port: RELAY_PORT } } }); // its port is now the shipped gateway's
  try {
    assert.deepEqual(G.definedGateways().skipped.map((x) => x.id), ['relay']);
    assert.equal(G.notLoadedReason('relay'), `port ${RELAY_PORT} is TRouteAI's`);
    const r = await G.addDefinition({ ...RELAY, port: RELAY_PORT + 21 });
    assert.equal(r.ok, false);
    assert.match(r.error, /there is a gateway "relay" in config\.json already that was not loaded/);
    assert.equal(r.field, 'id');
    assert.equal(loadConfig().gateways.defined.filter((d) => d.id === 'relay').length, 1);
  } finally {
    saveConfig({ addons: keep });
    G.removeDefinition('relay');
  }
});

test('a port config.json already keeps for the id is the one checked and shown: what is confirmed is what runs', async () => {
  const { runsLines } = await import('../../src/addons/gatewaycli.mjs');
  const keep = loadConfig().addons;
  try {
    saveConfig({ addons: { ...keep, relay: { port: 7433 } } });
    assert.match(check(RELAY).error || '', /port 7433 is this dashboard's/, 'a left-over setting on the dashboard\'s port is refused');
    saveConfig({ addons: { ...keep, relay: { port: RELAY_PORT + 7 } } });
    const lines = runsLines(check(RELAY).def).join('\n');
    assert.match(lines, new RegExp(`--listen=127\\.0\\.0\\.1:${RELAY_PORT + 7}\\b`), 'the question shows the port it will use');
    assert.doesNotMatch(lines, new RegExp(`:${RELAY_PORT}\\b`));
  } finally {
    saveConfig({ addons: keep });
  }
});

test('a program Hoprig did not start on a gateway\'s port is refused at add, and never used, reported or stopped as it', POSIX, async () => {
  const { spawn } = await import('node:child_process');
  const idle = await import('../../src/automation/idle.mjs');
  const { main } = await import('../../src/addons/gatewaycli.mjs');
  const port = await freePort();
  // The owner's own server, started outside Hoprig.
  const other = spawn(process.execPath, ['-e', `require('node:http').createServer((q, s) => s.end('mine')).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
  const alive = () => { try { process.kill(other.pid, 0); return true; } catch { return false; } };
  try {
    for (let i = 0; i < 100 && (await new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(false); }); c.on('error', () => r(true)); })); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match((await G.checkNew({ ...RELAY, port })).error || '', new RegExp(`answers on port ${port} already`), 'refused at add');
    assert.match(check({ ...RELAY, port: 7434 }).error || '', /the router's/, 'and the router\'s port');
    // Defined anyway (written by hand, or the other program came later).
    const keep = loadConfig().gateways;
    saveConfig({ gateways: { ...keep, defined: [{ ...RELAY, port }] } });
    const a = findAddon('relay');
    const st = await a.status();
    assert.deepEqual([st.running, st.foreign], [false, true], 'not reported as running');
    const started = await a.start();
    assert.equal(started.ok, false, 'not taken for the gateway');
    assert.match(started.error, /Another program answers on port \d+: Hoprig did not start it/);
    const stopped = await a.stop();
    assert.deepEqual([stopped.ok, stopped.already, stopped.foreign], [true, true, true]);
    const rec = { lines: [], record: (e) => rec.lines.push(e) };
    await idle.apply([{ type: 'stop-gateway', addon: 'relay', idleMs: 60 * 60_000 }], { deck: {}, addons: [{ id: a.id, title: a.title, status: a.status, stop: a.stop }], record: rec.record });
    assert.deepEqual(rec.lines, [], 'idle care leaves it alone');
    const said = [];
    assert.equal(await main(['remove', 'relay'], { out: (s) => said.push(s), err: (s) => said.push(s), ask: async () => 'y', tty: true, env: {} }), 0, said.join('\n'));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(), 'the owner\'s server survives Remove');
    assert.equal(findAddon('relay'), null);
  } finally {
    other.kill('SIGKILL');
  }
});

test('two gateways never share a title, whatever its case', () => {
  const others = [check(RELAY).def];
  assert.match(check({ ...RELAY, id: 'relay-two', port: RELAY_PORT + 9, title: 'RELAY' }, { others }).error || '', /the name Relay is another gateway's/);
  assert.equal(check({ ...RELAY, id: 'relay-two', port: RELAY_PORT + 9, title: 'Relay Two' }, { others }).error, undefined);
});

test('a title may hold letters of any script, as the rule says', () => {
  for (const title of ['Relé', 'Ретранслятор', 'रिले गेटवे', 'Relay 2 (local)']) assert.equal(check({ ...RELAY, title }).error, undefined, title);
  for (const title of ['<Relay>', ' Relay', 'Relay\n', '-Relay']) assert.match(check({ ...RELAY, title }).error || '', /the title/, JSON.stringify(title));
});

test('a message the page shows never begins with a value it would change (it capitalises the first letter)', () => {
  const errors = [
    check({ ...RELAY, bin: 'relay-nowhere' }).error,
    check({ ...RELAY, bin: path.join(box.root, 'nowhere') }).error,
    check({ ...RELAY, title: 'relay', id: 'relay-x' }, { others: [check(RELAY).def] }).error,
    G.removeDefinition('trouteai').error,
  ];
  for (const e of errors) assert.match(e, /^(no|there|the) /, e);
});
