// "Allow everything" lifts the whole wall in a session the owner himself put in it (the decision of 27 Nov): with
// Hands-off on, nothing of Hoprig's wall is held and nothing asks (a command Hoprig cannot read, a delete outside the
// folder, a push to a main branch, a publish, sudo): each runs and leaves one quiet line. What still holds: the floor
// (a delete read for certain as the whole home, workspace, projects folder or disk), checked BEFORE a shell command runs
// whether or not anything asks, in a terminal session and in a chat; a question and a plan; and every session that is
// not his own choice (Tia's, a schedule, ...). Bypass alone holds exactly what it held. Through the real hook program,
// the real shell gate and the real settings the launcher writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-alldec-')));
const root = path.join(tmp, 'made-up');
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const proj = path.join(ws, 'projects', 'shop');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
process.env.HOME = home;
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.HOPRIG_WORKSPACE_DIR = ws;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const POSIX = { skip: process.platform === 'win32' && 'POSIX shell and folders' };

const { binFile, configFile, hookSettingsDir, runsDir, stateDir } = await import('../src/paths.mjs');
const { hoprigVersion } = await import('../src/handsoff.mjs');
const { hookSettings, chatHooks, wallGate } = await import('../src/launch.mjs');
const { readRun } = await import('../src/runfile.mjs');
const { markAll, allMarkFile } = await import('../src/allmark.mjs');
const { floorLine } = await import('../src/wall.mjs');
const { hookAnswer } = await import('../src/hook.mjs');
const { plainDelete } = await import('../src/asking.mjs');

const V = hoprigVersion();
const writeCfg = (o) => {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(o));
};
const ON = { allowBypass: true, allowEverythingAt: 5 };
const HANDS = { handsOff: { offered: true, projects: { [proj]: { on: true, version: V } } } };
const handsMark = path.join(stateDir(), 'handsoff-active');
let n = 0;
function newRun(extra = {}) {
  n += 1;
  const id = `3333333${n}-3333-4333-8333-333333333333`.slice(0, 36);
  const file = path.join(runsDir(), `${id}.json`);
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ status: 'working', cwd: proj, ...extra }));
  return file;
}
const pre = (command, tool = 'Bash') => ({ hook_event_name: 'PreToolUse', permission_mode: 'bypassPermissions', cwd: proj, tool_name: tool, tool_input: tool === 'Bash' ? { command } : { file_path: command } });
// The real hook program, as Claude Code starts it.
function hook(event, file, env = {}) {
  const r = spawnSync(process.execPath, [binFile(), 'hook'], { input: JSON.stringify(event), env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: proj, ...env }, encoding: 'utf8' });
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const decision = (o) => (o ? o.hookSpecificOutput.permissionDecision : null);
const ALLVAR = { HOPRIG_ALLOW_EVERYTHING: '1' };

// Point 1: his picture's command, a delete outside the folder, a push to a main branch, a publish: with Hands-off ON.
const HELD = {
  'a command Hoprig cannot read (a here-document line)': `cd ${proj} && python3 - <<'PY'\nprint(1)\nPY`,
  'a delete outside the folder': `rm -rf ${tmp}/elsewhere/old`,
  'a publish': 'npm publish',
  'a command with sudo': 'sudo apt-get update',
  'a release': 'gh release create v1',
};

test('Hands-off ON: Bypass holds each of them as before; Allow everything lets each run and leaves one quiet line', POSIX, () => {
  writeCfg({ ...ON, ...HANDS });
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(handsMark, '');
  for (const [what, command] of Object.entries(HELD)) {
    const bypass = newRun();
    assert.equal(decision(hook(pre(command), bypass)), 'ask', `Bypass holds ${what}`);
    const all = newRun();
    assert.equal(hook(pre(command), all, ALLVAR), null, `Allow everything holds nothing: ${what}`);
    const line = readRun(all).allowed;
    assert.equal(line.length, 1, `one quiet line for ${what}`);
    assert.equal(line[0].by, 'all');
    assert.equal(line[0].tool, 'Bash');
  }
});

test('Hands-off ON: a push to a main branch of a scratch repository runs in Allow everything, held in Bypass', POSIX, () => {
  const repo = path.join(tmp, 'scratch-repo');
  const bare = path.join(tmp, 'scratch-remote.git');
  const sh = (c, cwd) => spawnSync('sh', ['-c', c], { cwd, encoding: 'utf8' });
  fs.mkdirSync(repo);
  sh(`git init -q -b main ${bare} --bare`, tmp);
  sh(`git init -q -b main . && git config user.email a@b.c && git config user.name x && git commit -q --allow-empty -m one && git remote add origin ${bare} && git push -q -u origin main`, repo);
  writeCfg({ ...ON, handsOff: { offered: true, projects: { [repo]: { on: true, version: V } } } });
  fs.writeFileSync(handsMark, '');
  const push = { ...pre('git push origin main'), cwd: repo };
  const env = { CLAUDE_PROJECT_DIR: repo };
  assert.equal(decision(hook(push, newRun({ cwd: repo }), env)), 'ask', 'Bypass: held as before');
  const all = newRun({ cwd: repo });
  assert.equal(hook(push, all, { ...env, ...ALLVAR }), null, 'Allow everything: runs');
  assert.equal(readRun(all).allowed[0].by, 'all');
});

test('the same with Hands-off OFF: nothing held, so no line (Bypass runs it too)', POSIX, () => {
  writeCfg(ON);
  fs.rmSync(handsMark, { force: true });
  const f = newRun();
  assert.equal(hook(pre('npm publish'), f, ALLVAR), null);
  assert.equal(readRun(f).allowed, undefined);
});

test('the terminal answer: Hands-off does not hold a permission in Allow everything; a session of Tia still does', POSIX, () => {
  writeCfg({ ...ON, ...HANDS });
  fs.writeFileSync(handsMark, '');
  const ev = { hook_event_name: 'PermissionRequest', permission_mode: 'bypassPermissions', cwd: proj, tool_name: 'Bash', tool_input: { command: 'npm publish' } };
  const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  const f = newRun();
  assert.deepEqual(hook(ev, f, ALLVAR), allow);
  assert.equal(readRun(f).allowed.at(-1).by, 'all');
  const tia = newRun();
  fs.writeFileSync(path.join(hookSettingsDir(), `${path.basename(tia)}.tia`), JSON.stringify({ byTia: true }));
  assert.equal(hook(ev, tia, ALLVAR), null, 'hers: the mode is never hers');
  assert.equal(hookAnswer(ev, { rules: () => [], places: () => ({ home, workspace: ws, projects: [], hoprig: [], own: proj, cwd: proj, relative: true }), allOn: () => true, hers: () => true }), null);
});

// Point 3: the floor holds when nobody asks: the hook is called on PreToolUse, before the shell command runs.
const WHOLE = { 'the whole workspace': `rm -rf ${ws}`, 'the projects folder': `rm -rf ${ws}/projects`, 'the whole home': 'rm -rf ~', 'the disk': 'sudo rm -rf /' };

test('the floor, Hands-off OFF and nothing asking: held with the floor line before the command runs (variable and mark)', POSIX, () => {
  writeCfg(ON);
  fs.rmSync(handsMark, { force: true });
  for (const [what, command] of Object.entries(WHOLE)) {
    const viaVar = hook(pre(command), newRun(), ALLVAR);
    assert.equal(decision(viaVar), 'ask', what);
    assert.match(viaVar.hookSpecificOutput.permissionDecisionReason, /^Held even in Allow everything: this would delete your whole /, what);
    const f = newRun();
    markAll(f); // a chat in the mode: the dashboard's mark, no variable
    assert.equal(decision(hook(pre(command), f)), 'ask', `${what}, by the chat's mark`);
  }
  assert.equal(hook(pre(`rm -rf ${proj}/dist`), newRun(), ALLVAR), null, 'a delete inside the project is not the floor');
  assert.equal(hook(pre(`rm -rf ${ws}`), newRun()), null, 'Bypass alone: no mode, no pre-check (as before)');
});

test('the floor, Hands-off ON: held by the floor line, not by the wall', POSIX, () => {
  writeCfg({ ...ON, ...HANDS });
  fs.writeFileSync(handsMark, '');
  const o = hook(pre(`rm -rf ${ws}`), newRun(), ALLVAR);
  assert.equal(decision(o), 'ask');
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, floorLine('workspace'));
});

test('the pre-check is never for a session of Tia, without the acknowledgement, or with the switch off', POSIX, () => {
  writeCfg(ON);
  const tia = newRun();
  fs.writeFileSync(path.join(hookSettingsDir(), `${path.basename(tia)}.tia`), JSON.stringify({ byTia: true }));
  const hers = hook(pre(`rm -rf ${ws}`), tia, ALLVAR);
  assert.match(hers && hers.hookSpecificOutput.permissionDecisionReason, /^Hoprig holds this for you/, 'her own hold, never the mode floor line');
  for (const cfg of [{ allowBypass: true }, { allowBypass: false, allowEverythingAt: 5 }, {}]) {
    writeCfg(cfg);
    assert.equal(hook(pre(`rm -rf ${ws}`), newRun(), ALLVAR), null, JSON.stringify(cfg));
  }
});

// The shell gate: a cheap test first, node only when it must.
test('the shell gate: a command without rm starts no hook, one with rm does, and Hands-off ON starts it for every call', POSIX, () => {
  writeCfg(ON);
  fs.rmSync(handsMark, { force: true });
  const record = path.join(tmp, 'gate-seen');
  const gate = wallGate(`cat >> ${record}; echo >> ${record}`, { offered: true, floor: true });
  const run = (file, command) => {
    fs.rmSync(record, { force: true });
    spawnSync('sh', ['-c', gate], { input: JSON.stringify(pre(command)), env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
    return fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8').trim()).tool_input.command : null;
  };
  const plain = newRun();
  assert.equal(run(plain, 'rm -rf x'), null, 'no mark: nothing starts');
  markAll(plain);
  for (const c of ['npm test', 'echo permission_mode platforms', 'git status && ls -la', 'cd /tmp/work && make']) assert.equal(run(plain, c), null, c);
  for (const c of ['rm -rf x', 'sudo rm -rf /', 'cd a && rm -f b', 'rm\n-rf /', '"rm" -rf /']) assert.equal(run(plain, c), c, c);
  fs.writeFileSync(handsMark, '');
  assert.equal(run(plain, 'npm test'), 'npm test', 'Hands-off ON: every call reaches the hook, as it does without the mode');
  fs.rmSync(handsMark, { force: true });
  assert.equal(run(newRun(), 'npm test'), null);
  assert.equal(wallGate('x', { offered: false, floor: false }), null);
  assert.equal(wallGate('x', { offered: true, floor: false }), 'if [ -e "${HOPRIG_RUN_FILE%/runs/*}/handsoff-active" ]; then x; fi', 'without the mode: the gate of Hands-off, exactly as before');
  assert.equal(wallGate('x', { floor: true, win: true }), 'x');
  assert.equal(wallGate('x', { offered: true, floor: false, win: true }), null);
});

test('the settings the launcher writes carry the gate for a session started in the mode, and the chat hooks for his chats only', POSIX, () => {
  const mine = hookSettings({ offered: true, version: '2.1.328', floor: true }).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(mine.includes('.all"') && mine.includes("*'rm '*"), mine);
  assert.ok(!hookSettings({ offered: true, version: '2.1.328' }).hooks.PreToolUse[0].hooks[0].command.includes('.all'), 'a session not in the mode: the old gate');
  const hers = hookSettings({ offered: true, version: '2.1.328', floor: true, hers: true }).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(!hers.includes('.all'), 'hers: her own hold with no gate');
  assert.ok(chatHooks('2.1.328', true, false, true).PreToolUse[0].hooks[0].command.includes('.all"'));
  assert.ok(chatHooks('2.1.328', false, false, true).PreToolUse[0].hooks[0].command.includes('.all"'), 'also with Hands-off not offered');
  assert.ok(!chatHooks('2.1.328', true, true, true).PreToolUse[0].hooks[0].command.includes('.all'));
  assert.equal(allMarkFile('/x/runs/a.json').endsWith('hook-settings/a.json.all'), true, 'the gate and the mark name one file');
});

// Point 4: the reading of "inside the session's folder".
test('a delete in the project is plain; one in a folder directly beside the home is not (another account) - the earlier try laid its project there', POSIX, () => {
  const places = { home, workspace: ws, projects: [path.join(ws, 'projects')], hoprig: [], relative: true };
  fs.writeFileSync(path.join(proj, 'a.txt'), 'x');
  assert.equal(plainDelete('rm a.txt', { ...places, cwd: proj, own: proj }), true);
  const beside = path.join(root, 'beside');
  fs.mkdirSync(beside, { recursive: true });
  fs.writeFileSync(path.join(beside, 'a.txt'), 'x');
  assert.equal(plainDelete('rm a.txt', { ...places, cwd: beside, own: beside }), false);
});
