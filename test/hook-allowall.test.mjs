// "Allow everything" in a terminal session (src/hook.mjs hookAnswer, sessionFacts allOn): the PermissionRequest hook of a
// session whose process carries HOPRIG_ALLOW_EVERYTHING=1 (set by the launcher from the dashboard's launch file) and
// whose permission mode is bypassPermissions allows every permission at once, also what Bypass would leave to the owner;
// not a question, not a plan, not the one removal of the whole home, workspace, projects folder or disk, and not a
// session of Tia's (her level holds). Hands-off holds nothing in it. The mode is read from the process's own environment and the config now.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-hookall-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { hookAnswer, hookPatch, sessionFacts } = await import('../src/hook.mjs');
const { configFile } = await import('../src/paths.mjs');

const home = path.join(tmp, 'home');
const proj = path.join(home, 'Workspace', 'projects', 'shop');
fs.mkdirSync(proj, { recursive: true });
const places = () => ({ home, workspace: path.join(home, 'Workspace'), projects: [path.join(home, 'Workspace', 'projects')], hoprig: [], own: proj, cwd: proj, relative: true });
const FACTS = (o = {}) => ({ rules: () => [], places, allOn: () => true, hers: () => false, ...o });
const ev = (more) => ({ hook_event_name: 'PermissionRequest', permission_mode: 'bypassPermissions', cwd: proj, ...more });
const bash = (command) => ev({ tool_name: 'Bash', tool_input: { command } });
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
const POSIX = { skip: process.platform === 'win32' && 'the floor reads POSIX folders only' };

// The line of the owner's picture: it changes folder and feeds a script to an interpreter through a here-document.
const PICTURE = `cd ${proj} && python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY`;

test('his picture: a command Bypass leaves to him is allowed in Allow everything, and still left to him in Bypass', () => {
  assert.deepEqual(hookAnswer(bash(PICTURE), FACTS()), ALLOW);
  assert.equal(hookAnswer(bash(PICTURE), FACTS({ allOn: () => false })), null, 'Bypass alone: the hook stays silent');
  assert.equal(hookAnswer(bash(PICTURE), { rules: () => [], places }), null, 'a facts object without the mode behaves as before');
});

test('every other permission is allowed: a file tool, a fetch, an MCP tool, an ask rule', () => {
  for (const e of [ev({ tool_name: 'Write', tool_input: { file_path: '/x/y' } }), ev({ tool_name: 'Edit', tool_input: {} }), ev({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }), ev({ tool_name: 'mcp__srv__do', tool_input: {} }), ev({ tool_name: 'Bash', tool_input: { command: 'npm test' } })]) {
    assert.deepEqual(hookAnswer(e, FACTS({ rules: () => ['Bash'] })), ALLOW, e.tool_name);
  }
});

test('the floor: a delete read for certain as the whole home, workspace, projects folder or disk gets no answer', POSIX, () => {
  for (const c of ['rm -rf ~', 'rm -rf $HOME', 'rm -rf /', 'sudo rm -rf /', `rm -rf ${home}/Workspace`, `rm -rf ${home}/Workspace/projects/*`, `cd ${home}/Workspace && rm -rf projects`, 'rm -rf ..']) {
    assert.equal(hookAnswer(bash(c), FACTS()), null, c);
  }
  for (const c of ['rm -rf node_modules', 'rm -rf ~/.cache/x', 'rm -rf "$DIR"', 'find ~ -delete']) assert.deepEqual(hookAnswer(bash(c), FACTS()), ALLOW, c);
});

test('a question and a plan are never answered', () => {
  assert.equal(hookAnswer(ev({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }), FACTS()), null);
  assert.equal(hookAnswer(ev({ tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } }), FACTS()), null);
});

test('only in bypassPermissions: another mode, or none, gets nothing (left inside Claude Code with Shift+Tab)', () => {
  for (const m of ['default', 'plan', 'acceptEdits', undefined]) assert.equal(hookAnswer(bash('npm test') && { ...bash('npm test'), permission_mode: m }, FACTS()), null, String(m));
});

test('a session of Tia gets no answer; what Hands-off would hold is allowed (the decision of 27 Nov: the mode lifts the wall)', () => {
  assert.equal(hookAnswer(bash('npm publish'), FACTS({ hers: () => true })), null);
  assert.deepEqual(hookAnswer(bash('npm publish'), FACTS()), ALLOW);
});

test('allOn: the environment of the process, the switch and the acknowledgement in the config read now, never as root', () => {
  const cfg = (o) => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(o));
  };
  const on = (env = { HOPRIG_ALLOW_EVERYTHING: '1' }) => sessionFacts(bash('x'), { ...env }).allOn();
  cfg({ allowBypass: true, allowEverythingAt: 5 });
  assert.equal(on(), true);
  assert.equal(on({}), false, 'no variable');
  assert.equal(on({ HOPRIG_ALLOW_EVERYTHING: 'yes' }), false);
  cfg({ allowBypass: true });
  assert.equal(on(), false, 'not accepted yet');
  cfg({ allowEverythingAt: 5 });
  assert.equal(on(), false, 'the switch is off');
  cfg({ allowBypass: false, allowEverythingAt: 5 });
  assert.equal(on(), false);
  fs.rmSync(configFile());
  assert.equal(on(), false, 'no config');
  cfg({ allowBypass: true, allowEverythingAt: 5 });
  assert.equal(on(), true, 'read again at each event: back on at once');
});

test('the record never decides it, and an allowed answer is noted as by all', () => {
  const run = { status: 'working', note: '', allowed: [] };
  const p = hookPatch(run, bash(PICTURE), 1000, { allowed: true, by: 'all' });
  assert.equal(p.allowed.at(-1).by, 'all');
  assert.equal(hookPatch(run, bash('rm -rf dist'), 1000, { allowed: true }).allowed.at(-1).by, undefined);
});

test('hers: a session of Tia is the one thing that holds; Hands-off no longer does, and an unknown session (no run file) is hers', async () => {
  const { runsDir, hookSettingsDir } = await import('../src/paths.mjs');
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const file = path.join(runsDir(), `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ status: 'working', cwd: proj }));
  fs.writeFileSync(configFile(), JSON.stringify({ allowBypass: true, allowEverythingAt: 5, handsOff: { offered: true, projects: { [proj]: { on: true, version: '99.0.0' } } } }));
  const env = { HOPRIG_RUN_FILE: file, HOPRIG_ALLOW_EVERYTHING: '1', CLAUDE_PROJECT_DIR: proj };
  const publish = bash('npm publish');
  assert.equal(sessionFacts(publish, env).hers(), false);
  assert.deepEqual(hookAnswer(publish, sessionFacts(publish, env)), ALLOW, 'Hands-off on, his own session in the mode: allowed');
  fs.writeFileSync(path.join(hookSettingsDir(), `${id}.json.tia`), JSON.stringify({ byTia: true }));
  assert.equal(sessionFacts(publish, env).hers(), true, 'a session of Tia: her level holds it');
  assert.equal(hookAnswer(publish, sessionFacts(publish, env)), null);
  assert.equal(sessionFacts(publish, { HOPRIG_ALLOW_EVERYTHING: '1' }).hers(), true, 'no run file: unknown, so held');
});

test('through the real hook program: the picture is allowed and noted as by all; the same call without the variable, or with a record that claims it, is not', async () => {
  const { spawnSync } = await import('node:child_process');
  const { binFile, runsDir } = await import('../src/paths.mjs');
  const { readRun } = await import('../src/runfile.mjs');
  const id = '22222222-2222-4222-8222-222222222222';
  const file = path.join(runsDir(), `${id}.json`);
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ status: 'working', cwd: proj, all: true, allowEverything: true, mode: 'allowEverything' }));
  fs.writeFileSync(configFile(), JSON.stringify({ allowBypass: true, allowEverythingAt: 5 }));
  const event = { session_id: id, hook_event_name: 'PermissionRequest', permission_mode: 'bypassPermissions', cwd: proj, tool_name: 'Bash', tool_input: { command: PICTURE } };
  const run = (extra) => spawnSync(process.execPath, [binFile(), 'hook'], { input: JSON.stringify(event), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: proj, ...extra }, encoding: 'utf8' });
  const without = run({});
  assert.equal(without.stdout, '', 'a record that claims the mode decides nothing');
  const on = run({ HOPRIG_ALLOW_EVERYTHING: '1' });
  assert.deepEqual(JSON.parse(on.stdout), ALLOW);
  assert.equal(readRun(file).allowed.at(-1).by, 'all');
  assert.equal(readRun(file).allowed.at(-1).what.startsWith('cd '), true);
  fs.writeFileSync(configFile(), JSON.stringify({ allowBypass: true }));
  assert.equal(run({ HOPRIG_ALLOW_EVERYTHING: '1' }).stdout, '', 'not accepted: the variable alone is not enough');
});
