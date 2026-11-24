// The wall's cheap gate: an ordinary command starts no node process while nobody has Hands-off on.
// The PreToolUse hook Hoprig hands a session is gated by a cheap shell test on one marker in the state folder
// (handsoff-active); the node hook runs only while that marker exists. server/handsoff.mjs writes the marker while
// any switch is on and clears it otherwise, so a session in a project whose switch is on is held — the marker is
// present — while with nothing on the hook never starts. The hook still reads the switch from the config and is the
// authority: a marker present but the switch off holds nothing, and the session cannot reach the marker to switch the
// wall off (it lies in the state folder, which the wall protects). No per-run <run>.json.handsoff mark is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Its real path: the dashboard stores a project's switch under the real path (macOS: /var is a link to /private/var).
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-mark-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const R = await import('../src/runs.mjs');
const { hookSettings } = await import('../src/launch.mjs');
const { hoprigVersion } = await import('../src/handsoff.mjs');
const { wallHeld } = await import('../src/wall.mjs');
const { configDir, configFile, hookSettingsDir, stateDir } = await import('../src/paths.mjs');

const V = hoprigVersion();
const SHOP = path.join(tmp, 'shop');
fs.mkdirSync(SHOP, { recursive: true });
fs.mkdirSync(path.dirname(configFile()), { recursive: true });
fs.mkdirSync(stateDir(), { recursive: true });

const settings = hookSettings({ offered: true, version: '2.1.330' });
const preCmd = settings.hooks.PreToolUse[0].hooks[0].command;
const mark = path.join(stateDir(), 'handsoff-active');
// Run the installed PreToolUse command exactly as Claude Code's shell runs it, with the session's run file in the env.
const decision = (file, command) => {
  const out = spawnSync('sh', ['-c', preCmd], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: SHOP, permission_mode: 'bypassPermissions' }),
    env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8',
  }).stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
};
const switchOn = (on, version = V) => fs.writeFileSync(configFile(), JSON.stringify({ handsOff: { offered: true, projects: { [SHOP]: { on, version, at: Date.now(), note: '' } } } }));
const setMarker = (on) => (on ? fs.writeFileSync(mark, '') : fs.rmSync(mark, { force: true }));
const start = () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), path.basename(file)), JSON.stringify(settings));
  return file;
};

test('the PreToolUse command is gated by a cheap test on the state-folder marker, not a per-run .handsoff mark', () => {
  assert.ok(preCmd.startsWith('if [ -e "${HOPRIG_RUN_FILE%/runs/*}/handsoff-active" ]; then '), preCmd);
  assert.doesNotMatch(preCmd, /\.handsoff/); // no per-run mark that a session could move or delete
});

test('a session started after the project switch is on is held — the marker is present (finding 1)', () => {
  switchOn(true); setMarker(true); // turning the project switch on writes the marker (server/handsoff.mjs)
  const file = start();
  assert.equal(fs.existsSync(`${file}.handsoff`), false, 'no per-run mark is written');
  assert.equal(decision(file, 'sudo true'), 'ask', 'a held act is held for a session started after the switch');
  assert.equal(decision(file, 'npm test'), null, 'an ordinary command still goes through');
  R.removeRun(file);
});

test('the session cannot switch the wall off by removing the marker (findings 3, 7, 14)', () => {
  // The marker lies in the state folder, which the wall protects, so a command that would remove or move it is held;
  // and the gate starts the hook while the marker still exists, so that very command is read and held, not run.
  const places = { hoprig: [configDir(), stateDir()], home: tmp, own: SHOP };
  const held = (command) => wallHeld({ tool: 'Bash', input: { command }, cwd: SHOP, places });
  assert.ok(held(`rm ${mark}`), 'rm of the marker by its path is held');
  assert.ok(held('rm "${HOPRIG_RUN_FILE%/runs/*}/handsoff-active"'), 'rm of the marker via the run-file var is held');
  assert.ok(held(`mv ${mark} /tmp/x`), 'moving the marker away is held');
});

test('the hook is the authority: with the marker present but the switch off (or stale) it holds nothing', () => {
  setMarker(true); // the marker only decides whether to START the hook; the config decides whether to hold
  switchOn(false);
  const file = start();
  assert.equal(decision(file, 'sudo true'), null, 'nothing is held while the switch is off, though the hook ran');
  switchOn(true, 'old-0.0.0'); // a switch turned on under an older version reads as off after an update
  assert.equal(decision(file, 'sudo true'), null, 'a stale switch holds nothing');
  R.removeRun(file);
});
