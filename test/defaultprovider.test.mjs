// The provider a new session starts on when nobody chooses one (src/defaultprovider.mjs): "auto" while Auto mode
// is on; otherwise the one used last in that folder, else the first not at its limit in the Providers page's order
// (the Auto order, then the rest, subscriptions before API keys), pay-per-use keys only when allowed or when
// nothing else can work. The launcher keeps each folder's provider when a session starts there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-defprov-')));
Object.assign(process.env, {
  HOME: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'config'), HOPRIG_STATE_DIR: path.join(tmp, 'state'),
  HOPRIG_PROFILES_DIR: path.join(tmp, 'profiles'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), HOPRIG_WORKSPACE_DIR: path.join(tmp, 'workspace'),
});
fs.mkdirSync(process.env.HOME);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const D = await import('../src/defaultprovider.mjs');
const BIN = fileURLToPath(new URL('../bin/hoprig.mjs', import.meta.url));

const P = (name, o = {}) => ({ name, kind: 'subscription', paid: false, limited: null, ...o });
const profiles = [P('key', { kind: 'api', paid: true }), P('sub'), P('team'), P('gw', { kind: 'gateway' })];

test('Auto mode on: "auto", whatever the folder used last', () => {
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: true, order: ['team'] }, last: 'sub' }), 'auto');
});

test('Auto mode off: the provider used last in the folder comes first', () => {
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: false, order: ['sub', 'team'] }, last: 'team' }), 'team');
});

test('a pay-per-use key used last in the folder is not the default while it is not allowed and another can work', () => {
  // One session continued on the paid key at a limit must not keep every later session there after the reset.
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: false, order: ['sub'] }, last: 'key' }), 'sub');
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: false, order: ['sub'], payPerUse: true }, last: 'key' }), 'key', 'allowed: the folder\'s own');
  const onlyKey = profiles.map((p) => (p.paid ? p : { ...p, limited: { until: null } }));
  assert.equal(D.chooseDefault({ profiles: onlyKey, auto: { enabled: false, order: ['sub'] }, last: 'key' }), 'key', 'nothing else can work');
  // Everything at its limit: the folder's own one is shown first.
  assert.equal(D.chooseDefault({ profiles: profiles.map((p) => ({ ...p, limited: {} })), auto: { enabled: false, order: ['gw'] }, last: 'team' }), 'team');
});

test('Auto mode off, nothing used in the folder (or it is gone, or at its limit): the Providers page\'s order', () => {
  const auto = { enabled: false, order: ['team', 'sub'] };
  assert.equal(D.chooseDefault({ profiles, auto }), 'team');
  assert.equal(D.chooseDefault({ profiles, auto, last: 'removed' }), 'team');
  const limited = profiles.map((p) => (p.name === 'team' ? { ...p, limited: { until: null } } : p));
  assert.equal(D.chooseDefault({ profiles: limited, auto, last: 'team' }), 'sub', 'the folder\'s own provider is at its limit');
  // No Auto order: the page shows subscriptions and gateways before API keys, in the list's order.
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: false, order: [] } }), 'sub');
  // A paid key placed first in the order is passed over unless the owner allows pay-per-use keys.
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: false, order: ['key', 'gw'] } }), 'gw');
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: false, order: ['key', 'gw'], payPerUse: true } }), 'key');
  // Only a paid key can work: it is the default. Everything at its limit: the first shown.
  const onlyKey = profiles.map((p) => (p.paid ? p : { ...p, limited: { until: null } }));
  assert.equal(D.chooseDefault({ profiles: onlyKey, auto: { enabled: false, order: [] } }), 'key');
  assert.equal(D.chooseDefault({ profiles: profiles.map((p) => ({ ...p, limited: {} })), auto: { enabled: false, order: ['gw'] } }), 'gw');
  assert.equal(D.chooseDefault({ profiles: [], auto: { enabled: false } }), null);
  assert.equal(D.chooseDefault({ profiles: [{ name: 'auto', virtual: true }, P('sub')], auto: { enabled: false } }), 'sub', 'never the virtual one');
  assert.equal(D.chooseDefault({ profiles: [P('openai', { kind: 'api', tools: ['codex'] }), P('sub', { tools: ['claude'] })], auto: { enabled: false } }), 'sub', 'only a provider Claude Code can use');
  assert.equal(D.chooseDefault({ profiles: [P('openai', { kind: 'api', tools: ['codex'] }), P('sub')], auto: { enabled: false }, last: 'openai' }), 'sub');
});

test('Claude Code started in a folder (the launcher) makes its provider that folder\'s; the newest 100 are kept', { skip: process.platform === 'win32' && 'a POSIX stand-in for claude' }, async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'work-')));
  const link = path.join(tmp, 'work-link');
  fs.symlinkSync(work, link);
  const fake = path.join(tmp, 'fake-claude.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  const { saveConfig } = await import('../src/config.mjs');
  const { writeProfile } = await import('../src/profiles.mjs');
  saveConfig({ claudeBin: fake });
  writeProfile('team', { label: 'Team' });
  const r = spawnSync(process.execPath, [BIN, 'team'], { cwd: work, env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(D.lastProviderIn(work), 'team');
  assert.equal(D.lastProviderIn(link), 'team', 'the same folder by another path');
  assert.equal(D.lastProviderIn(path.join(tmp, 'elsewhere')), null);
  // Carrying a conversation on (a resume, a move, a restore, a limit's fallback: all name the session) leaves the
  // folder's provider as it was.
  writeProfile('other', { label: 'Other' });
  for (const args of [['--resume', '0b6a1c1e-5d3f-4f43-9d8e-1f7f0e7a2b11'], ['--session-id', '0b6a1c1e-5d3f-4f43-9d8e-1f7f0e7a2b12'], ['-c']]) {
    const m = spawnSync(process.execPath, [BIN, 'other', ...args], { cwd: work, env: process.env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(m.status, 0, m.stderr);
    assert.equal(D.lastProviderIn(work), 'team', args.join(' '));
  }
  D.rememberFolderProvider(work, 'sub');
  assert.equal(D.lastProviderIn(work), 'sub', 'the last one wins');
  for (let i = 0; i < 105; i++) D.rememberFolderProvider(`/f/${i}`, 'gw');
  const all = D.folderProviders();
  assert.equal(Object.keys(all).length, 100);
  assert.equal(all['/f/104'].profile, 'gw');
  assert.equal(all[work], undefined, 'the oldest went first');
});

// The terminal menu's Enter default, from real provider files: the same rule as the dashboard's (the profiles go in
// as publicProfile shows them, so which coding tools a provider serves counts there too).
test('the start menu: Enter takes the folder\'s provider, never a paid key or a provider Claude Code cannot use while another works', async () => {
  const pdir = process.env.HOPRIG_PROFILES_DIR;
  fs.rmSync(pdir, { recursive: true, force: true });
  const P2 = await import('../src/profiles.mjs');
  const { enterDefault } = await import('../src/menu.mjs');
  const { setAutoSwitch, markLimited, clearLimited } = await import('../src/autoswitch.mjs');
  const here = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'menu-')));
  P2.writeProfile('api', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test' } }); // pay per use, first by name
  P2.writeProfile('sub', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' } });
  P2.writeProfile('team', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-team' } });
  setAutoSwitch({ enabled: false, order: ['sub'], payPerUse: false });
  const enter = () => (enterDefault(undefined, undefined, here) || {}).name;
  assert.equal(enter(), 'sub', 'the Auto order, not the paid key that sorts first');
  D.rememberFolderProvider(here, 'team');
  assert.equal(enter(), 'team', 'the folder\'s own provider');
  D.rememberFolderProvider(here, 'api');
  assert.equal(enter(), 'sub', 'a paid key used here before is passed over');
  markLimited('sub', { until: Date.now() + 3600_000 });
  assert.equal(enter(), 'team');
  clearLimited('sub');
  setAutoSwitch({ enabled: true });
  assert.equal(enter(), 'auto');
  setAutoSwitch({ enabled: true, order: [] });
  assert.equal(enter(), 'sub', 'Auto mode on with no order to run: no "auto" in the menu');
  setAutoSwitch({ enabled: false, order: [] });
  // A Codex sign-in sorts first by name and serves Codex only: once the profiles know the coding tools they serve
  // (profiles.mjs servesTools), Enter never offers it for Claude Code, even where it was used last.
  if (typeof P2.servesTools === 'function') {
    fs.writeFileSync(path.join(pdir, 'chatgpt.env'), 'LABEL="Codex sign-in"\nSIGNIN=codex\n', { mode: 0o600 });
    D.rememberFolderProvider(here, 'chatgpt');
    assert.equal(enter(), 'sub');
    fs.rmSync(path.join(pdir, 'chatgpt.env'));
  }
});
