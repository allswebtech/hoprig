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
  assert.equal(D.chooseDefault({ profiles, auto: { enabled: false, order: ['sub'] }, last: 'key' }), 'key', 'chosen there before: a paid key too');
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
  D.rememberFolderProvider(work, 'sub');
  assert.equal(D.lastProviderIn(work), 'sub', 'the last one wins');
  for (let i = 0; i < 105; i++) D.rememberFolderProvider(`/f/${i}`, 'gw');
  const all = D.folderProviders();
  assert.equal(Object.keys(all).length, 100);
  assert.equal(all['/f/104'].profile, 'gw');
  assert.equal(all[work], undefined, 'the oldest went first');
});
