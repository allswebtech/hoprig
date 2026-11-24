// The wall does not depend on a file the session can take away. When the hook cannot
// READ the settings it needs (the config file is gone) and the session was started with the wall hold, preToolHold
// still holds the kinds the wall reads, rather than reading "not offered" from a config that is missing. A config
// that reads cleanly with offered:false is the owner's own choice and is honoured (nothing held).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Its real path: the dashboard stores a project's switch under the real path (macOS: /var is a link to /private/var).
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallgone-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { preToolHold } = await import('../src/hook.mjs');
const { hoprigVersion } = await import('../src/handsoff.mjs');
const { configFile, hookFile, hookSettingsDir } = await import('../src/paths.mjs');
const R = await import('../src/runs.mjs');

const V = hoprigVersion();
const SHOP = path.join(tmp, 'shop');
fs.mkdirSync(SHOP, { recursive: true });
const ev = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: SHOP, permission_mode: 'bypassPermissions' });
const decision = (r) => (r && r.output ? r.output.hookSpecificOutput.permissionDecision : null);

test('config gone + session carries the hold: a held kind is still held', () => {
  assert.equal(decision(preToolHold(ev('sudo true'), null, { cfg: {}, cfgReadFailed: true, handed: true, version: V })), 'ask');
  assert.equal(decision(preToolHold(ev('npm publish'), null, { cfg: {}, cfgReadFailed: true, handed: true, version: V })), 'ask');
});

test('config gone + session carries the hold: an ordinary command still goes through', () => {
  assert.equal(preToolHold(ev('npm test'), null, { cfg: {}, cfgReadFailed: true, handed: true, version: V }), null);
  assert.equal(preToolHold(ev('git status'), null, { cfg: {}, cfgReadFailed: true, handed: true, version: V }), null);
});

test('config gone but the session never carried the hold: nothing is held (cannot conclude it was offered)', () => {
  assert.equal(preToolHold(ev('sudo true'), null, { cfg: {}, cfgReadFailed: true, handed: false, version: V }), null);
});

test('a config that reads cleanly with offered:false is honoured, not held', () => {
  assert.equal(preToolHold(ev('sudo true'), null, { cfg: { handsOff: { offered: false } }, cfgReadFailed: false, handed: true, version: V }), null);
});

const giveHold = (file) => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), path.basename(file)), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
};
const writeCfg = (cfg) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(cfg)); };
const hook = (file, event) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(event), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });

test('end to end: with the config file removed, the hook program still holds a held kind', () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  writeCfg({ handsOff: { offered: true, projects: { [SHOP]: { on: true, version: V } } } });
  const held = (c) => { const o = hook(file, ev(c)).stdout; return o ? JSON.parse(o).hookSpecificOutput.permissionDecision : ''; };
  assert.equal(held('sudo true'), 'ask', 'held while the config is present');
  fs.rmSync(configFile(), { force: true });
  assert.equal(held('sudo true'), 'ask', 'still held with the config gone');
  assert.equal(held('npm test'), '', 'an ordinary command still goes through with the config gone');
  R.removeRun(file);
});
