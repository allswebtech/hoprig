// "Lead model": a helper's model and effort are the product's, by construction. A Lead session's settings file holds a
// PreToolUse hook on Claude Code's agent tool; the real hook program (bin/hoprig-hook.mjs, started by the command the
// settings file names) answers a call that names a model or an effort with the same call without them, so the helper's
// own definition (its kind's model and effort) decides. A session without Lead gets no such hook.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('leadhook');
test.after(() => box.cleanup());
const { Chat } = await import('../../src/chat/chat.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { leadAnswer } = await import('../../src/hook.mjs');
const FAKE = path.join(import.meta.dirname, '..', 'chat', 'fixtures', 'fake-claude.mjs');
writeProfile('team', { label: 'Team', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });

/** A chat's first start: its arguments and its settings file (null without one). */
async function startOf(t, rec, name) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(box.root, `${name}.args`);
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'team', ...rec, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }) });
  t.after(() => c.stopAndWait());
  const done = new Promise((r) => c.once('turn', r));
  await c.send('hello');
  await done;
  const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray)[0];
  const at = args.indexOf('--settings');
  const settings = at >= 0 && fs.existsSync(args[at + 1]) ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8')) : null;
  return { args, settings };
}

/** Run the hook command a settings file names, as Claude Code does, with one event on its input. */
function fire(command, ev) {
  const r = spawnSync('sh', ['-c', command], { input: JSON.stringify(ev), env: { ...process.env, HOPRIG_RUN_FILE: path.join(box.root, 'no-record.json') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null;
}

const call = (input) => ({ hook_event_name: 'PreToolUse', session_id: 'S1', tool_name: 'Agent', tool_input: input });

test('Lead on: the start\'s settings hold the hook, and the real hook program takes the lead\'s model and effort out of a helper call', { skip: process.platform === 'win32' && 'POSIX stand-in' }, async (t) => {
  const on = await startOf(t, { lead: true }, 'on');
  assert.ok(on.args.includes('--agents'), 'it leads');
  const entry = on.settings && on.settings.hooks && on.settings.hooks.PreToolUse;
  assert.ok(Array.isArray(entry) && entry.length === 1, `a PreToolUse hook: ${JSON.stringify(on.settings)}`);
  assert.equal(entry[0].matcher, 'Agent|Task', 'only Claude Code\'s agent tool');
  const command = entry[0].hooks[0].command;
  // The lead names another model and the highest effort for a helper: the call runs without them.
  const out = fire(command, call({ subagent_type: 'hoprig-runner', description: 'search', prompt: 'find the TODOs', model: 'opus', effort: 'max' }));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { subagent_type: 'hoprig-runner', description: 'search', prompt: 'find the TODOs' } } });
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'no permission decision: what asks still asks');
  // A call that names neither: nothing to change, no answer.
  assert.equal(fire(command, call({ subagent_type: 'hoprig-coder', description: 'code', prompt: 'add it' })), null);
  // Another tool is never touched, whatever its input holds.
  assert.equal(fire(command, { ...call({ model: 'opus' }), tool_name: 'Bash' }), null);
});

test('Lead off, and an old record without the switch: no such hook in the start\'s settings', { skip: process.platform === 'win32' && 'POSIX stand-in' }, async (t) => {
  const off = await startOf(t, {}, 'off');
  assert.ok(!off.args.includes('--agents'));
  assert.equal(!!(off.settings && off.settings.hooks && off.settings.hooks.PreToolUse), false, JSON.stringify(off.settings));
});

test('the rule itself: only the agent tool, only model and effort, the rest of the call as it was', () => {
  assert.equal(leadAnswer(null), null);
  assert.equal(leadAnswer({ hook_event_name: 'PermissionRequest', tool_name: 'Agent', tool_input: { model: 'opus' } }), null);
  assert.deepEqual(leadAnswer({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { prompt: 'p', effort: 'high' } }).hookSpecificOutput.updatedInput, { prompt: 'p' });
  assert.equal(leadAnswer({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: ['model'] }), null);
});
