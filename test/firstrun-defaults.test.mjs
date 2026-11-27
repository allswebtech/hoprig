// The defaults of a fresh install (the first-run design): each has a test that a fresh configuration has it and that a
// configuration that already says something else is not changed by the update.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-frdef-')));
Object.assign(process.env, {
  HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'config'), HOPRIG_STATE_DIR: path.join(tmp, 'state'),
  HOPRIG_PROFILES_DIR: path.join(tmp, 'profiles'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), HOPRIG_WORKSPACE_DIR: path.join(tmp, 'workspace'),
});
fs.mkdirSync(process.env.HOME);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { readSettings, restoreOn } = await import('../src/automation/settings.mjs');
const { DEFAULT_QUICK_ACTIONS, cleanQuickActions } = await import('../src/server/settings.mjs');
const { middleModel } = await import('../web/modelpicker.js');

test('reopen after a restart: on for a fresh configuration, with tmux or without; a saved choice is kept', () => {
  const fresh = readSettings(null);
  assert.equal(restoreOn(fresh, { capabilities: { persistent: true } }), true, 'tmux too: a restart of the computer ends it');
  assert.equal(restoreOn(fresh, { capabilities: { persistent: false } }), true);
  assert.equal(restoreOn(fresh, null), true);
  // An older configuration that chose off (or on) keeps it.
  assert.equal(restoreOn(readSettings({ restore: { enabled: false } }), { capabilities: { persistent: true } }), false);
  assert.equal(restoreOn(readSettings({ restore: { enabled: true } }), { capabilities: { persistent: true } }), true);
});

test('quick messages: continue only on a fresh install; a saved list (even the old pair) is kept as it is', () => {
  assert.deepEqual(DEFAULT_QUICK_ACTIONS.map((q) => q.label), ['continue']);
  const old = [{ label: 'continue', text: 'continue' }, { label: '/clear', text: '/clear' }];
  assert.deepEqual(cleanQuickActions(old), old, 'what a person saved passes through unchanged');
});

test('the first provider is called Claude account, an older label stays what it is', async () => {
  const { ensureFirstProfile } = await import('../src/menu.mjs');
  const { listProfiles, writeProfile } = await import('../src/profiles.mjs');
  assert.equal(ensureFirstProfile({ quiet: true }), true);
  assert.equal(listProfiles().find((p) => p.name === 'sub').label, 'Claude account');
  writeProfile('sub', { label: 'Claude account (stored login)' });
  assert.equal(ensureFirstProfile({ quiet: true }), false, 'an existing profile is not touched');
  assert.equal(listProfiles().find((p) => p.name === 'sub').label, 'Claude account (stored login)');
});

test('Windows: Python, ripgrep and jq are not on by themselves; Linux and macOS keep them', async () => {
  const { KITS, kitById } = await import('../src/pcsetup/kits.mjs');
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  const at = (p) => Object.defineProperty(process, 'platform', { ...real, value: p });
  try {
    at('win32');
    assert.equal(kitById('python').defaultOn, false);
    assert.equal(kitById('extras').defaultOn, false);
    assert.equal(KITS.find((k) => k.id === 'basics').defaultOn, true, 'git stays: Claude Code needs it on Windows');
    at('linux');
    assert.equal(kitById('python').defaultOn, true);
    assert.equal(kitById('extras').defaultOn, true);
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

test('a key added to a provider starts on a middle model when the list has one', () => {
  const list = [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5' }];
  assert.equal(middleModel(list), 'claude-sonnet-5-5');
  assert.equal(middleModel([{ id: 'relay-1' }, { id: 'relay-2' }]), 'relay-1', 'no sonnet name: the first');
  assert.equal(middleModel([]), '');
});
