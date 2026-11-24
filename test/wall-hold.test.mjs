// The hold itself. While Hands-off is on for a session, the PreToolUse hook answers "ask" for a command
// that is the owner's alone (wall.mjs), so the coding tool draws his card in every permission mode. The hold is
// installed only while Hands-off is offered, and the hook reads the switch itself (no mark gates it). A session
// whose handed settings hold no PreToolUse cannot have Hands-off turned on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Its real path: the dashboard stores a project's switch under the real path (macOS: /var is a link to /private/var).
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallhold-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { preToolHold } = await import('../src/hook.mjs');
const { hookSettings } = await import('../src/launch.mjs');
const { sessionHasHold } = await import('../src/server/handsoff.mjs');
const { hoprigVersion } = await import('../src/handsoff.mjs');
const R = await import('../src/runs.mjs');
const { readRun } = await import('../src/runfile.mjs');
const { configFile, hookFile, hookSettingsDir } = await import('../src/paths.mjs');

const V = hoprigVersion();
const SHOP = path.join(tmp, 'shop');
fs.mkdirSync(SHOP, { recursive: true });
const writeCfg = (cfg) => {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg));
};
const onCfg = { handsOff: { offered: true, projects: { [SHOP]: { on: true, version: V } } } };
const pre = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: SHOP });

test('hookSettings installs the PreToolUse hold only when Hands-off is offered', () => {
  if (process.platform === 'win32') return;
  assert.equal('PreToolUse' in hookSettings({ version: '2.1.328' }).hooks, false);
  const h = hookSettings({ version: '2.1.328', offered: true }).hooks.PreToolUse;
  assert.ok(Array.isArray(h) && h.length);
  // No mark gate: the hook reads the switch itself, so a file the session can reach never decides whether it runs.
  assert.doesNotMatch(h[0].hooks[0].command, /\.handsoff/);
  // Matched to the shell and the file-writing tools, so a read, a search or a question never starts the hook.
  assert.equal(h[0].matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit');
});

test('preToolHold: ask for a held command when on; nothing when off, not offered, or ordinary', () => {
  const run = { cwd: SHOP, status: 'working' };
  const keys = { runId: 'run-x', project: SHOP };
  const held = preToolHold(pre('sudo true'), run, { cfg: onCfg, version: V, ...keys });
  assert.equal(held.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(held.output.hookSpecificOutput.permissionDecisionReason, /administrator/i);
  // An ordinary command goes through.
  assert.equal(preToolHold(pre('npm test'), run, { cfg: onCfg, version: V, ...keys }), null);
  // Off for the session (no switch on): no hold, although offered is the default.
  assert.equal(preToolHold(pre('sudo true'), run, { cfg: { handsOff: { offered: true } }, version: V, ...keys }), null);
  // The owner hid the feature (offered:false): no hold even with the project switch on.
  assert.equal(preToolHold(pre('sudo true'), run, { cfg: { handsOff: { offered: false, projects: { [SHOP]: { on: true, version: V } } } }, version: V, ...keys }), null);
  // Not a PreToolUse event: not this hold's business.
  assert.equal(preToolHold({ ...pre('sudo true'), hook_event_name: 'PermissionRequest' }, run, { cfg: onCfg, version: V, ...keys }), null);
});

test('the wall holds by the switch, never the stop: a loop, hour or reset stop ends the answers, not the hold', () => {
  const keys = { runId: 'run-x', project: SHOP };
  // A stop Hoprig made itself (a loop, the hour, or the reset of a resumed run) must not lift the hold: the owner
  // left with Hands-off on, so what is his keeps waiting for him until he turns the switch off.
  for (const handsOffStop of ['loop', 'hour', 'reset']) {
    const held = preToolHold(pre('sudo true'), { cwd: SHOP, handsOffStop }, { cfg: onCfg, version: V, ...keys });
    assert.ok(held && held.held, `held with a ${handsOffStop} stop`);
    assert.equal(held.output.hookSpecificOutput.permissionDecision, 'ask');
  }
  // With no switch on, a stop still holds nothing: nothing was his to wait for.
  assert.equal(preToolHold(pre('sudo true'), { cwd: SHOP, handsOffStop: 'loop' }, { cfg: { handsOff: { offered: true } }, version: V, ...keys }), null);
});

test('sessionHasHold reads the handed settings for a PreToolUse hold', () => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), 'with.json'), JSON.stringify(hookSettings({ version: '2.1.328', offered: true })));
  fs.writeFileSync(path.join(hookSettingsDir(), 'without.json'), JSON.stringify(hookSettings({ version: '2.1.328' })));
  if (process.platform !== 'win32') assert.equal(sessionHasHold('with'), true);
  assert.equal(sessionHasHold('without'), false);
  assert.equal(sessionHasHold('absent'), false);
});

test('the real hook program answers "ask" for a held command, and is silent for an ordinary one', () => {
  if (process.platform === 'win32') return;
  writeCfg(onCfg);
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const run = (ev) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(ev), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });
  const held = run(pre('gh pr create --fill'));
  assert.equal(held.status, 0);
  const out = JSON.parse(held.stdout.trim());
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  // An ordinary command: the hook says nothing, so Claude Code runs it as the mode allows.
  assert.equal(run(pre('npm test')).stdout.trim(), '');
  readRun(file); // the record is readable; the hold wrote no answer line to it (the following PermissionRequest does)
});

test('offered:false (the owner hid the feature), the hook holds nothing even for a held command', () => {
  if (process.platform === 'win32') return;
  writeCfg({ handsOff: { offered: false, projects: { [SHOP]: { on: true, version: V } } } });
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const r = spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(pre('sudo true')), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '');
  R.removeRun(file);
});

test('offered by default (slice 9): with the switch on, the hook holds a held command although offered is absent', () => {
  if (process.platform === 'win32') return;
  writeCfg({ handsOff: { projects: { [SHOP]: { on: true, version: V } } } }); // offered absent: reads as offered
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const r = spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(pre('sudo true')), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask', 'held by the switch, offered being the default');
  R.removeRun(file);
});
