// An ordinary command starts no node process for the wall while nobody has Hands-off on. The
// PreToolUse hook Hoprig hands a session is gated by a cheap shell test on one marker in the state folder; the node
// hook starts only while that marker exists. server/handsoff.mjs writes the marker while any switch is on and clears
// it otherwise, so a session in a project whose switch is on is still held (the marker is present), while with no
// switch on anywhere the node hook never starts. The hook stays the authority — the marker only decides whether to
// start it, so a line that cannot be read with certainty still reaches the wall whenever any switch is on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Its real path: the dashboard stores a project's switch under the real path (macOS: /var is a link to /private/var).
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallgate-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered: the wall's hold is a POSIX shell test), so a
// test that switches it on and expects an answer or a hold has nothing to see there.
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };

const { hookSettings } = await import('../src/launch.mjs');
const { handsOffFeature } = await import('../src/server/handsoff.mjs');
const { hoprigVersion } = await import('../src/handsoff.mjs');
const { configFile, hookSettingsDir, stateDir } = await import('../src/paths.mjs');
const R = await import('../src/runs.mjs');

const V = hoprigVersion();
const SHOP = path.join(tmp, 'shop');
fs.mkdirSync(SHOP, { recursive: true });
const mark = path.join(stateDir(), 'handsoff-active');
fs.mkdirSync(stateDir(), { recursive: true });

const preCmd = () => hookSettings({ offered: true, version: '2.1.328' }).hooks.PreToolUse[0].hooks[0].command;

test('the PreToolUse hook is gated by a cheap shell test on the state-folder marker', OFFERED, () => {
  const cmd = preCmd();
  assert.ok(cmd.startsWith('if [ -e "${HOPRIG_RUN_FILE%/runs/*}/handsoff-active" ]; then '), cmd);
  assert.ok(cmd.trimEnd().endsWith('; fi'), cmd);
  assert.ok(cmd.includes('hoprig-hook'), 'the node hook still runs inside the gate');
});

const giveHold = (file) => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), path.basename(file)), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
};
const writeCfg = (cfg) => { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(cfg)); };
const runGate = (file, command) => {
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: SHOP, permission_mode: 'bypassPermissions' };
  const r = spawnSync('sh', ['-c', preCmd()], { input: JSON.stringify(ev), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });
  const o = r.stdout.trim();
  return o ? JSON.parse(o).hookSpecificOutput.permissionDecision : '';
};

test('marker present: a held command runs the hook and is held; marker absent: the hook never starts', OFFERED, () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  writeCfg({ handsOff: { offered: true, projects: { [SHOP]: { on: true, version: V } } } });
  fs.writeFileSync(mark, '');
  assert.equal(runGate(file, 'sudo true'), 'ask', 'held while the marker is present');
  assert.equal(runGate(file, 'npm test'), '', 'an ordinary command is not held');
  fs.rmSync(mark, { force: true });
  assert.equal(runGate(file, 'sudo true'), '', 'with no marker the node hook does not start (the cheap gate)');
  R.removeRun(file);
});

test('the project switch route writes the marker when on and clears it when off', OFFERED, async () => {
  let cfg = { server: { roots: [tmp] }, handsOff: { offered: true } };
  const ctx = {
    config: () => cfg,
    saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
    readJson: async () => ctx._body,
    HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } },
    poke: () => {},
  };
  const feat = handsOffFeature(ctx, { version: V });
  const route = feat.routes.find((r) => String(r[1]).includes('/project'))[2];
  fs.rmSync(mark, { force: true });
  ctx._body = { dir: SHOP, on: true };
  await route({});
  assert.equal(fs.existsSync(mark), true, 'marker written when the project switch is turned on');
  ctx._body = { dir: SHOP, on: false };
  await route({});
  assert.equal(fs.existsSync(mark), false, 'marker cleared when the project switch is turned off');
});
