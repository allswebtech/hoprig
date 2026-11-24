// The hook's hot path (src/hookrecord.mjs): Claude Code starts the hook program for every event and waits for it, so
// a status event loads only the record's code. The wall, Hands-off's answers, the bypass rule and Auto mode are
// loaded only for the events that can be answered (PreToolUse, PermissionRequest). Seen in a child run of the real
// hook program with a preload that lists every module it loaded (fixtures/loadlist.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-hotpath-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const R = await import('../src/runs.mjs');
const { readRun } = await import('../src/runfile.mjs');
const { hookFile } = await import('../src/paths.mjs');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PRELOAD = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'loadlist.mjs')).href;
const ID = '55555555-5555-4555-8555-555555555555';
// The modules of the wall and the answers: none of them is loaded for a status event.
const ANSWER_MODULES = ['hook.mjs', 'wall.mjs', 'asking.mjs', 'askcard.mjs', 'handsoff.mjs', 'autoswitch.mjs', 'shellwords.mjs', 'plaindisk.mjs', 'assistant/adminrefused.mjs', 'assistant/herrights.mjs', 'automation/store.mjs'];

let n = 0;
// One run of the hook program for `ev` → { status, out, loaded: the product modules it loaded, relative to src/ }.
function hook(file, ev) {
  const list = path.join(tmp, `loaded-${++n}.txt`);
  const r = spawnSync(process.execPath, ['--import', PRELOAD, hookFile()], { input: JSON.stringify({ session_id: ID, ...ev }), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: tmp, LOADLIST_FILE: list }, encoding: 'utf8' });
  const urls = fs.existsSync(list) ? fs.readFileSync(list, 'utf8').split('\n').filter(Boolean) : [];
  const loaded = urls.map((u) => fileURLToPath(u)).filter((f) => f.startsWith(SRC + path.sep)).map((f) => path.relative(SRC, f).split(path.sep).join('/'));
  return { status: r.status, out: r.stdout + r.stderr, loaded };
}

const STATUS_EVENTS = [
  { hook_event_name: 'SessionStart', source: 'startup' },
  { hook_event_name: 'UserPromptSubmit', prompt: 'Make the shop page load faster' },
  { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
  { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'Bash', tool_response: { stdout: '' } }] },
  { hook_event_name: 'SubagentStop', agent_id: 'a1' },
  { hook_event_name: 'Stop', background_tasks: [] },
  { hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: 500' },
  { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
];

test('a status event loads only the record\'s code, and still writes the record', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: tmp });
  for (const ev of STATUS_EVENTS) {
    const r = hook(file, ev);
    assert.deepEqual([r.status, r.out], [0, ''], ev.hook_event_name);
    assert.ok(r.loaded.includes('runfile.mjs'), `${ev.hook_event_name}: the list of loaded modules works (${r.loaded.join(', ')})`);
    const extra = r.loaded.filter((m) => ANSWER_MODULES.includes(m));
    assert.deepEqual(extra, [], `${ev.hook_event_name} loaded the answers' modules`);
  }
  // What the events wrote is in the record: the last one ended the session, the first gave it its id.
  assert.deepEqual([readRun(file).status, readRun(file).sessionId, readRun(file).endReason], ['ended', ID, 'prompt_input_exit']);
  R.removeRun(file);
});

test('an event that can be answered loads the wall and the answers', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: tmp });
  const pre = hook(file, { hook_event_name: 'PreToolUse', cwd: tmp, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual([pre.status, pre.out], [0, '']);
  for (const m of ['hook.mjs', 'wall.mjs']) assert.ok(pre.loaded.includes(m), `PreToolUse loads ${m}`);
  const ask = hook(file, { hook_event_name: 'PermissionRequest', permission_mode: 'default', cwd: tmp, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual([ask.status, ask.out], [0, '']);
  for (const m of ['hook.mjs', 'askcard.mjs', 'handsoff.mjs']) assert.ok(ask.loaded.includes(m), `PermissionRequest loads ${m}`);
  assert.equal(readRun(file).status, 'attention');
  assert.equal(readRun(file).askCard.kind, 'permission');
  R.removeRun(file);
});

test('the hot path\'s copies are the same as the modules it does not load', async () => {
  const hot = await import('../src/hookrecord.mjs');
  const { DEFAULTS } = await import('../src/autoswitch.mjs');
  const { WORK_TOOLS } = await import('../src/handsoff.mjs');
  assert.equal(hot.CONTINUE_PROMPT, DEFAULTS.prompt);
  assert.deepEqual([...hot.WORK_TOOLS].sort(), [...WORK_TOOLS].sort());
});
