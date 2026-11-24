// The one thing the dashboard does when it starts a session of Tia's, on every path that starts one (src/assistant/
// hersignin.mjs startAsHers / endAsHers): it MARKS the run hers — the mark
// src/hook.mjs sessionByTia reads to hold her administrator commands below Full (hermark.mjs) — AND signs the session
// in to the git server with the token the owner chose in place of his own (herSignedEnv). One function, so a start
// path of hers cannot get the mark without the sign-in or the sign-in without the mark. The real route is proven
// below: the production startAsHers writes the mark, the real hook program reads it and holds; a run not started
// through startAsHers (his own) is not held; the mark goes when the run ends.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-startashers-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { startAsHers, endAsHers } = await import('../../src/assistant/hersignin.mjs');
const { herMarkFile } = await import('../../src/hermark.mjs');
const { configFile, hookFile, hookSettingsDir } = await import('../../src/paths.mjs');
const R = await import('../../src/runs.mjs');

const CWD = path.join(tmp, 'proj');
fs.mkdirSync(CWD, { recursive: true });
const credsDir = path.join(tmp, 'credentials');
fs.mkdirSync(credsDir, { recursive: true });
fs.writeFileSync(path.join(credsDir, 'token'), 'ghp_herMadeUpToken_0001\n');

const markOf = (file) => herMarkFile(file);
const isMarked = (file) => fs.existsSync(markOf(file)) && JSON.parse(fs.readFileSync(markOf(file), 'utf8')).byTia === true;

test('startAsHers marks the run hers where the hook reads it; with no file chosen the sign-in stays his (as today)', () => {
  const { file } = R.createRun({ profile: 'api', cwd: CWD });
  const his = { HOME: '/home/alex', GH_TOKEN: 'ghp_HIS_own' };
  const out = startAsHers(file, his, { cfg: {}, credsDir });
  assert.ok(isMarked(file), 'the dashboard marked the run hers');
  assert.deepEqual(out, his, 'no file chosen: her session uses his own sign-in, unchanged');
  R.removeRun(file);
});

test('startAsHers signs the session in with the chosen token in place of his, and marks it', () => {
  const { file } = R.createRun({ profile: 'api', cwd: CWD });
  const his = { HOME: '/home/alex', GH_TOKEN: 'ghp_HIS_own', GITHUB_TOKEN: 'ghp_HIS_own' };
  const cfg = { server: { herGitSignin: { file: 'token' } } };
  const out = startAsHers(file, his, { cfg, credsDir });
  assert.ok(isMarked(file), 'marked hers');
  assert.equal(out.GH_TOKEN, 'ghp_herMadeUpToken_0001');
  assert.equal(out.GITHUB_TOKEN, 'ghp_herMadeUpToken_0001');
  assert.ok(!JSON.stringify(out).includes('ghp_HIS_own'), 'his own token is gone from her session');
  R.removeRun(file);
});

test('startAsHers with an unreadable chosen file takes his git tokens out (never his full rights) and still marks', () => {
  const { file } = R.createRun({ profile: 'api', cwd: CWD });
  const his = { HOME: '/home/alex', GH_TOKEN: 'ghp_HIS_own', GITHUB_TOKEN: 'ghp_HIS_own' };
  let why = null;
  const out = startAsHers(file, his, { cfg: { server: { herGitSignin: { file: 'gone' } } }, credsDir, onProblem: (m) => { why = m; } });
  assert.ok(isMarked(file), 'the mark is written even when the sign-in file cannot be read');
  // His git tokens are taken out; each token variable gh reads holds the placeholder, so gh fails, never asks the keyring.
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) assert.equal(out[k], 'none', `${k} holds the placeholder`);
  assert.ok(!JSON.stringify(out).includes('ghp_HIS_own'), 'his git token is taken out, not kept');
  assert.match(why, /not in the credentials folder/);
  R.removeRun(file);
});

test('endAsHers removes the mark, and is safe when it is already gone', () => {
  const { file } = R.createRun({ profile: 'api', cwd: CWD });
  startAsHers(file, {}, { cfg: {}, credsDir });
  assert.ok(isMarked(file));
  endAsHers(file);
  assert.ok(!fs.existsSync(markOf(file)), 'the mark is gone when the session ends');
  endAsHers(file); // no throw the second time
  R.removeRun(file);
});

test('a move keeps the mark; a restart on a new record re-marks (the mark is keyed to the record that lives)', () => {
  const { file } = R.createRun({ profile: 'api', cwd: CWD });
  startAsHers(file, {}, { cfg: {}, credsDir });
  assert.ok(isMarked(file));
  // A conversation move keeps the same record file (chat/run.mjs moved(): updateRun, not removeRun) — so the mark,
  // keyed to the record's basename, stays. A provider move keeps the record the same way.
  R.updateRun(file, { sessionId: 'moved-conversation-id' });
  assert.ok(isMarked(file), 'the mark survives a move (the record stays)');
  // A restart starts a fresh record; its start goes through startAsHers again and marks the new record.
  R.removeRun(file);
  assert.ok(!fs.existsSync(markOf(file)), 'the old record and its mark are gone');
  const restarted = R.createRun({ profile: 'api', cwd: CWD }).file;
  startAsHers(restarted, {}, { cfg: {}, credsDir });
  assert.ok(isMarked(restarted), 'a restart on a new record re-marks');
  R.removeRun(restarted);
});

// The real route: the production startAsHers writes the mark, the real hook program (hookFile) reads it and decides.
const ev = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: CWD });
const runHook = (file, event) =>
  spawnSync(process.execPath, [hookFile()], {
    input: JSON.stringify(event),
    env: { ...process.env, HOPRIG_RUN_FILE: file, HOPRIG_WORKSPACE_DIR: path.join(tmp, 'ws') },
    encoding: 'utf8',
  });
const writeConfig = (cfg) => {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg));
};

test('real route: a run startAsHers marked is held by the real hook; a run not started through it (his) is not; the mark goes with the run', () => {
  writeConfig({}); // default level off, no Hands-off: only the session-hold can hold
  // Hers: started through the production startAsHers.
  const hers = R.createRun({ profile: 'api', cwd: CWD }).file;
  startAsHers(hers, {}, { cfg: {}, credsDir });
  const held = runHook(hers, ev('sudo true'));
  assert.notEqual(held.stdout.trim(), '', 'the hook answered for her session');
  assert.equal(JSON.parse(held.stdout).hookSpecificOutput.permissionDecision, 'ask', 'her administrator command is held as his card');
  // His: the same start WITHOUT startAsHers (no mark) — the hook holds nothing.
  const his = R.createRun({ profile: 'api', cwd: CWD }).file;
  const free = runHook(his, ev('sudo true'));
  assert.equal(free.stdout.trim(), '', 'a session not started as hers is untouched');
  // The mark goes when the run ends.
  assert.ok(fs.existsSync(path.join(hookSettingsDir(), `${path.basename(hers)}.tia`)), 'marked while the run lives');
  R.removeRun(hers);
  assert.ok(!fs.existsSync(path.join(hookSettingsDir(), `${path.basename(hers)}.tia`)), 'mark gone with the run');
  R.removeRun(his);
});
