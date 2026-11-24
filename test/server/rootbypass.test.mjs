// As root, bypass permissions mode is never offered and never started: Claude Code refuses it for root (and also the
// flag that only allows it), so such a start would end at once. The rule sits where every start meets (the deck), so
// the route, Settings' defaults, a schedule, a restore and a hand-off all get it. Root is a fact handed in (`root`):
// nothing here runs as root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { launched, sandbox } from './helpers.mjs';

const box = sandbox('rootbypass');
const work = path.join(box.root, 'work');
fs.mkdirSync(work);

const G = await import('../../src/bypassgate.mjs');
const { CLAUDE_ROOT_REFUSAL } = await import('../../src/setup/rootfacts.mjs');
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { writeProfile, readProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { Deck } = await import('../../src/server/deck.mjs');

saveConfig({ launcher: ['L'], allowBypass: true, server: { roots: [box.root], passwordHash: await hashPassword('right-password') } });
writeProfile('gw', { label: 'Gateway', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'gw-key-0123456789' } });

const created = [];
const backend = {
  kind: 'pty', capabilities: {},
  list: async () => [],
  capture: async () => '',
  create: async ({ name, dir, argv }) => {
    created.push({ name, dir, argv });
    return { name, id: `pty-${created.length}` };
  },
  respawn: async () => {},
};

test('the gate: as root bypass is not allowed even with the switch on, and the one line quotes the tool', () => {
  const cfg = { allowBypass: true };
  assert.equal(G.bypassAllowed(cfg, false), true);
  assert.equal(G.bypassAllowed(cfg, true), false);
  assert.deepEqual(G.gateModes(['manual', 'bypassPermissions'], cfg, true), ['manual']);
  assert.deepEqual(G.gateCarry(['--permission-mode', 'bypassPermissions', '--effort', 'high'], cfg, true), ['--effort', 'high']);
  assert.ok(G.ROOT_BYPASS_LINE.includes(CLAUDE_ROOT_REFUSAL));
  assert.match(G.ROOT_BYPASS_LINE, /hoprig move-to-user/);
  assert.equal(G.rootRefusal({ args: ['--permission-mode', 'manual'], cfg, root: true }), null);
  assert.equal(G.rootRefusal({ args: ['--dangerously-skip-permissions'], cfg, root: true }), G.ROOT_BYPASS_LINE);
  assert.equal(G.rootRefusal({ cfg: { sessionDefaults: { permissionMode: 'bypassPermissions' } }, root: true }), G.ROOT_BYPASS_LINE);
  assert.equal(G.rootRefusal({ cfg: { sessionDefaults: { permissionMode: 'bypassPermissions' } }, root: false }), null);
});

test('the deck as root: no start in bypass, by its own flags, by the defaults, by every launch\'s arguments; a move neither', async () => {
  const profile = readProfile('gw');
  let cfg = { launcher: ['L'], allowBypass: true, sessionDefaults: {}, claudeArgs: [] };
  const deck = new Deck({ backend, config: () => cfg, profiles: () => [], root: true });
  const before = created.length;
  // the API's start with the mode named
  await assert.rejects(deck.start({ dir: work, profile, mode: 'new', flags: ['--permission-mode', 'bypassPermissions'] }), (e) => e.status === 409 && e.message === G.ROOT_BYPASS_LINE);
  // a schedule starts with the defaults (schedules.mjs: no flags of its own); a restore and a hand-off go through here too
  cfg = { ...cfg, sessionDefaults: { permissionMode: 'bypassPermissions' } };
  await assert.rejects(deck.start({ dir: work, profile, mode: 'new' }), /refuses bypass permissions mode as root/);
  await assert.rejects(deck.create({ base: 'shop', dir: work, argv: ['L', 'gw', '--resume', '11111111-1111-4111-8111-111111111111'] }), /refuses bypass/);
  // the config's own arguments for every launch
  cfg = { ...cfg, sessionDefaults: {}, claudeArgs: ['--dangerously-skip-permissions'] };
  await assert.rejects(deck.start({ dir: work, profile, mode: 'new' }), /refuses bypass/);
  cfg = { ...cfg, claudeArgs: [] };
  assert.equal(created.length, before, 'no terminal was made for any of them');
  // a later flag wins, as in the launcher: the defaults name bypass, this start asks
  cfg = { ...cfg, sessionDefaults: { permissionMode: 'bypassPermissions' } };
  await deck.start({ dir: work, profile, mode: 'new', flags: ['--permission-mode', 'manual'] });
  // a first message that names the flag is text, not a flag
  cfg = { ...cfg, sessionDefaults: {} };
  await deck.start({ dir: work, profile, mode: 'new', prompt: 'what does --dangerously-skip-permissions do?' });
  assert.equal(created.length, before + 2);
  // the session's defaults are left as the owner set them
  assert.deepEqual(cfg.sessionDefaults, {});
  // a move carries no bypass as root (gateCarry), so it starts
  const run = { sessionId: '22222222-2222-4222-8222-222222222222', cwd: work, carryArgs: ['--permission-mode', 'bypassPermissions'] };
  assert.ok(!deck.moveArgv(profile, run).includes('bypassPermissions'));
  // not root: the same start goes ahead
  const plain = new Deck({ backend, config: () => ({ ...cfg, sessionDefaults: { permissionMode: 'bypassPermissions' } }), profiles: () => [], root: false });
  await plain.start({ dir: work, profile, mode: 'new' });
  assert.equal(created.length, before + 3);
});

test('the dashboard as root: bypass is not offered, an API start in it is refused with the line, Settings keeps no new bypass default', async () => {
  const app = createServer({ backend, watch: false, root: true, workUser: null });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (p, body) => {
      const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: JSON.parse((await r.text()) || '{}') };
    };
    let r = await call('/api/settings');
    assert.equal(r.status, 200);
    assert.ok(!r.json.sessionChoices.permissionModes.includes('bypassPermissions'), 'not offered on the sheet or in Settings');
    assert.equal(r.json.rootBypass, G.ROOT_BYPASS_LINE);
    const before = created.length;
    r = await call('/api/sessions', { dir: work, profile: 'gw', mode: 'new', permissionMode: 'bypassPermissions', prompt: 'hi' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, G.ROOT_BYPASS_LINE);
    assert.equal(r.json.code, 'root-bypass');
    assert.equal(created.length, before, 'nothing started');
    // Settings: a new default in bypass is refused with the line
    r = await call('/api/settings', { sessionDefaults: { permissionMode: 'bypassPermissions' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, G.ROOT_BYPASS_LINE);
    // A default that names bypass already (set before, under an ordinary user) is not changed silently...
    saveConfig({ sessionDefaults: { permissionMode: 'bypassPermissions' } });
    r = await call('/api/settings', { sessionDefaults: { permissionMode: 'bypassPermissions', effort: 'high' } });
    assert.equal(r.status, 200);
    assert.equal(loadConfig().sessionDefaults.permissionMode, 'bypassPermissions');
    // ...and a start that nobody chose a mode for (the API, Tia) does not start in it: the answer says why
    r = await call('/api/sessions', { dir: work, profile: 'gw', mode: 'new' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, G.ROOT_BYPASS_LINE);
    // a start in a mode that asks goes ahead
    r = await call('/api/sessions', { dir: work, profile: 'gw', mode: 'new', permissionMode: 'manual' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(created.length, before + 1);
    assert.ok(launched(created.at(-1).argv).join(' ').includes('--permission-mode manual'));
    saveConfig({ sessionDefaults: {} });
  } finally {
    await app.close();
  }
});

test('the dashboard not as root: bypass stays offered where the owner allowed it', async () => {
  const app = createServer({ backend, watch: false, root: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base}/api/settings`, { headers: { Origin: base, Cookie: cookie } });
    const j = await r.json();
    assert.ok(j.sessionChoices.permissionModes.includes('bypassPermissions'));
    assert.equal(j.rootBypass, null);
  } finally {
    await app.close();
  }
});

test('the dashboard as root with a work user: the page\'s ssh line names that user, never root@', async () => {
  const facts = { env: { SSH_CONNECTION: '192.168.1.20 50000 203.0.114.7 22' }, platform: 'linux', publicIps: [], dmi: {}, localDisplay: false, savedServer: null };
  const app = createServer({ backend, watch: false, root: true, workUser: { name: 'hoprig', uid: 1001, home: '/home/hoprig' }, serverFacts: facts });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const j = await (await fetch(`${base}/api/settings`, { headers: { Origin: base, Cookie: cookie } })).json();
    assert.ok(j.network.server, JSON.stringify(j.network));
    assert.match(j.network.server.forward, / hoprig@203\.0\.114\.7$/);
    assert.doesNotMatch(j.network.server.forward, /root@/);
  } finally {
    await app.close();
  }
});

test.after(() => box.cleanup());
