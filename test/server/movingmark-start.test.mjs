// A moving mark (handsOff.moving) left by a dashboard that died mid-move silences the session it names
// (handsoff.mjs movingAway). No move survives a restart (Deck.handed lives in memory), so a new Deck clears every
// moving mark at start (src/server/deck.mjs #clearStaleMoving); the session it silenced is answered again.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered): a test that switches it on or reads its
// answer gets 409 or nothing there.
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };

const box = sandbox('movingmark-start');
test.after(() => box.cleanup());
const SHOP = path.join(box.home, 'shop');
fs.mkdirSync(SHOP, { recursive: true });

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const R = await import('../../src/runs.mjs');
const { readRun } = await import('../../src/runfile.mjs');
const { hookFile, hookSettingsDir, runsDir } = await import('../../src/paths.mjs');
const V = hoprigVersion();
const CONV = '11111111-2222-3333-4444-555555555555';

const QUESTION = { hook_event_name: 'PermissionRequest', session_id: CONV, permission_mode: 'default', cwd: SHOP, tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which test runner should this project use?', header: 'Runner', multiSelect: false, options: [{ label: 'node:test (Recommended)', description: 'Built in.' }, { label: 'vitest', description: 'Fast.' }] }] } };
const asks = (id) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(QUESTION), env: { ...process.env, HOPRIG_RUN_FILE: path.join(runsDir(), `${id}.json`), CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' }).stdout;

test('a Deck clears a stale moving mark at start, and the session it silenced is answered again', OFFERED, () => {
  const { file, run } = R.createRun({ profile: 'work', cwd: SHOP, conversation: CONV });
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), sessionId: CONV, status: 'waiting' }));
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), `${run.runId}.json`), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
  // The dashboard died mid-move: the mark for this live, unmoved session was left behind; its own switch is on.
  saveConfig({ launcher: ['launcher'], usage: false, handsOff: { offered: true, sessions: { [run.runId]: { on: true, version: V, at: 1_700_000_000_000 } }, moving: { [run.runId]: Date.now() } } });
  assert.equal(asks(run.runId), '', 'the stale mark silences it before a restart');

  // A new Deck (a restart) clears the mark.
  // eslint-disable-next-line no-new
  new Deck({ backend: { list: async () => [] }, config: loadConfig, profiles: () => [], saveConfig });
  const ho = loadConfig().handsOff;
  assert.equal('moving' in ho, false, 'the stale mark is gone');
  assert.equal(ho.sessions[run.runId].on, true, 'the owner\'s own switch is untouched');
  assert.match(asks(run.runId), /"behavior":"allow"/, 'its recommended question is answered again');
  R.removeRun(file);
});
