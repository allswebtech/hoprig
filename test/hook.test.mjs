// The hook: which Claude Code event sets which status (src/hook.mjs), that it writes only when something changes,
// and what the launcher hands Claude Code. The event orders below are the ones a hook that logged every event
// recorded on Claude Code 2.1.325.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-hook-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { applyHook, hookPatch, wantsToolNews } = await import('../src/hook.mjs');
const { readRun, watchFile } = await import('../src/runfile.mjs');
const R = await import('../src/runs.mjs');
const L = await import('../src/launch.mjs');
const C = await import('../src/claudecode.mjs');
const { hookFile } = await import('../src/paths.mjs');

const ID = '77777777-7777-4777-8777-777777777777';
const SUB = 'a0000000000000001';

/** Run the events through the hook's rules; returns the record after each, as "status|note". */
function play(events, run = { status: 'starting', note: '' }) {
  const seen = [];
  for (const ev of events) {
    run = { ...run, ...hookPatch(run, { session_id: ID, ...ev }, 1000) };
    seen.push(`${run.status}|${run.note}`);
  }
  return { run, seen };
}
const e = (hook_event_name, more = {}) => ({ hook_event_name, ...more });
const bash = { tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer s3cret" https://example.com' } };

test('a permission that is allowed: needs your OK only until the answer, then working until the reply ends', () => {
  const { seen, run } = play([
    e('SessionStart', { source: 'startup' }),
    e('UserPromptSubmit', { prompt: 'run it' }),
    e('PermissionRequest', bash),
    e('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }), // six seconds later
    e('PostToolBatch'), // the allowed command finished
    e('Stop', { last_assistant_message: 'done', background_tasks: [] }),
  ]);
  assert.deepEqual(seen, [
    'waiting|', 'working|',
    'attention|Claude needs your permission to use Bash',
    'attention|Claude needs your permission to use Bash',
    'working|', 'waiting|',
  ]);
  assert.deepEqual([run.asks, run.attentionKind, run.sessionId], [[], null, ID]);
});

test('the note never carries the tool input (a command may hold a secret); a question shows its own words', () => {
  const asked = play([e('PermissionRequest', bash)]).run;
  assert.equal(asked.note.includes('s3cret'), false);
  assert.equal(asked.attentionKind, 'permission_prompt');
  const q = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which  database\nshould I use?', options: [] }] } };
  assert.equal(play([e('PermissionRequest', q)]).run.note, 'Claude asks: Which database should I use?');
  assert.equal(play([e('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: {} })]).run.note, 'Claude has a question for you');
  assert.equal(play([e('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } })]).run.note, 'Claude needs your approval for the plan');
  assert.equal(play([e('PermissionRequest', {})]).run.note, 'Claude needs your permission');
});

test('a question that was answered: working again with the answer, not at the end of the reply', () => {
  const { seen } = play([
    e('UserPromptSubmit'),
    e('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?' }] } }),
    e('PostToolBatch'),
    e('PostToolBatch'), // Claude goes on with other tools
  ]);
  assert.deepEqual(seen, ['working|', 'attention|Claude asks: Which one?', 'working|', 'working|']);
});

test('a refused question fires nothing; the next message from the owner clears it', () => {
  const { seen, run } = play([e('UserPromptSubmit'), e('PermissionRequest', bash), e('UserPromptSubmit', { prompt: 'do it another way' })]);
  assert.deepEqual(seen, ['working|', 'attention|Claude needs your permission to use Bash', 'working|']);
  assert.deepEqual(run.asks, []);
});

test('a turn that starts without the owner (a background command or subagent ended) is working', () => {
  const { seen } = play([
    e('UserPromptSubmit', { prompt: 'start the build in the background' }),
    e('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'npm run build' }] }),
    e('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>b1</task-id>…' }),
    e('Stop', { background_tasks: [] }),
  ]);
  assert.deepEqual(seen, ['working|', 'waiting|', 'working|', 'waiting|']);
});

test('the reply ended but subagents or a workflow go on: working, until the reply after they finished', () => {
  const tasks = [{ id: SUB, type: 'subagent', status: 'running' }, { id: 'w1', type: 'workflow', status: 'running' }, { id: 'b1', type: 'shell', status: 'running' }];
  const { seen, run } = play([
    e('UserPromptSubmit'),
    e('Stop', { background_tasks: tasks, last_assistant_message: 'Started two agents.' }),
  ]);
  assert.deepEqual(seen, ['working|', 'working|']);
  assert.deepEqual(run.background, [SUB, 'w1'], 'a shell command may never end: it does not count');
  assert.deepEqual([run.stopAt, run.lastMessage], [1000, 'Started two agents.']);
  const later = play([e('SubagentStop', { agent_id: SUB }), e('UserPromptSubmit', { prompt: '<task-notification>…' }), e('Stop', { background_tasks: [] })], run);
  assert.deepEqual(later.seen, ['working|', 'working|', 'waiting|']);
  assert.deepEqual(later.run.background, []);
  // Only a shell command or a monitor in the background: Claude waits for the owner like after any reply.
  assert.equal(play([e('Stop', { background_tasks: [{ id: 'b1', type: 'shell' }, { id: 'm1', type: 'monitor' }] })]).run.status, 'waiting');
});

test('a subagent asks while the main reply is over: needs your OK, then working again; another agent\'s tools change nothing', () => {
  const { seen, run } = play([
    e('UserPromptSubmit'),
    e('Stop', { background_tasks: [{ id: SUB, type: 'subagent' }, { id: 'other', type: 'subagent' }] }),
    e('PermissionRequest', { ...bash, agent_id: SUB }),
    e('PostToolBatch', { agent_id: 'other' }), // the other agent works on: the question still waits
    e('SubagentStop', { agent_id: 'other' }),
    e('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }),
    e('PostToolBatch', { agent_id: SUB }), // answered (allowed or refused): the subagent goes on
  ]);
  assert.deepEqual(seen.slice(2), [
    'attention|Claude needs your permission to use Bash', 'attention|Claude needs your permission to use Bash',
    'attention|Claude needs your permission to use Bash', 'attention|Claude needs your permission to use Bash', 'working|',
  ]);
  assert.deepEqual([run.asks, run.background], [[], [SUB]]);
});

test('a subagent\'s question outlives the main reply\'s end and a new turn; it goes when that subagent ends', () => {
  const { seen } = play([
    e('UserPromptSubmit'),
    e('PermissionRequest', { ...bash, agent_id: SUB }),
    e('Stop', { background_tasks: [{ id: SUB, type: 'subagent' }] }),
    e('UserPromptSubmit', { prompt: '<task-notification>…' }),
    e('PostToolBatch'), // the main agent's tools
    e('SubagentStop', { agent_id: SUB }),
  ]);
  assert.deepEqual(seen.map((s) => s.split('|')[0]), ['working', 'attention', 'attention', 'attention', 'attention', 'working']);
});

test('compaction in the middle of a turn does not end it; a new or resumed session waits', () => {
  const { seen } = play([e('UserPromptSubmit'), e('SessionStart', { source: 'compact' }), e('PostToolBatch')]);
  assert.deepEqual(seen, ['working|', 'working|', 'working|']);
  for (const source of ['startup', 'resume', 'clear', 'fork']) assert.equal(play([e('UserPromptSubmit'), e('SessionStart', { source })]).run.status, 'waiting', source);
});

test('tool calls of the main agent prove a turn is running, however it started', () => {
  // A stop that a goal or a Stop hook turned down: Stop fired, Claude went on, no prompt was submitted.
  assert.deepEqual(play([e('UserPromptSubmit'), e('Stop', {}), e('PostToolBatch')]).seen, ['working|', 'waiting|', 'working|']);
  // Not after an API error, and never for a session that ended.
  const failed = play([e('StopFailure', { error: 'overloaded', last_assistant_message: 'API Error: Overloaded' }), e('PostToolBatch')]).run;
  assert.deepEqual([failed.status, failed.note, failed.failure.error], ['attention', 'API Error: Overloaded', 'overloaded']);
  assert.equal(play([e('SessionEnd'), e('PostToolBatch')]).run.status, 'ended');
  // A subagent's tools say nothing about the main agent.
  assert.equal(play([e('Stop', {}), e('PostToolBatch', { agent_id: SUB })]).run.status, 'waiting');
});

test('notifications: only the ones that ask for the owner are "needs your OK"', () => {
  for (const kind of ['idle_prompt', 'auth_success', 'agent_completed', 'push_notification', 'computer_use_exit']) {
    assert.deepEqual(hookPatch({ status: 'working', note: '' }, e('Notification', { notification_type: kind, message: 'x' })), {}, kind);
  }
  // Without a PermissionRequest before it (an older Claude Code, or a prompt that has none) the notification asks.
  const old = play([e('UserPromptSubmit'), e('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })]).run;
  assert.deepEqual([old.status, old.note, old.attentionKind, old.asks], ['attention', 'Claude needs your permission to use Bash', 'permission_prompt', ['?']]);
  assert.equal(play([e('PostToolBatch', { agent_id: SUB })], old).run.status, 'attention', 'a subagent\'s tools do not answer it');
  assert.equal(play([e('PostToolBatch')], old).run.status, 'working');
  assert.equal(play([e('Stop', {})], old).run.status, 'waiting');
  // An MCP server's form, and its end.
  const form = play([e('UserPromptSubmit'), e('Notification', { notification_type: 'elicitation_dialog', message: 'The server asks for input' })]);
  assert.deepEqual(form.seen[1], 'attention|The server asks for input');
  assert.equal(play([e('Notification', { notification_type: 'elicitation_complete' })], form.run).run.status, 'working');
  // A kind this version does not know is shown rather than lost.
  assert.equal(play([e('Notification', { notification_type: 'something_new', message: 'Look here' })]).run.status, 'attention');
});

test('the hook writes the run file only when the event changes something, and keeps the mark for tool news', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const stamp = () => { const s = fs.statSync(file); return `${s.ino}:${s.mtimeMs}`; };
  applyHook(file, { hook_event_name: 'SessionStart', source: 'startup', session_id: ID }, 5000);
  assert.deepEqual([readRun(file).status, readRun(file).statusAt, fs.existsSync(watchFile(file))], ['waiting', 5000, true]);
  applyHook(file, { hook_event_name: 'UserPromptSubmit', session_id: ID }, 6000);
  assert.deepEqual([readRun(file).statusAt, fs.existsSync(watchFile(file))], [6000, false], 'plainly working: tool calls start nothing');
  const before = stamp();
  // What a working session fires all day: none of it touches the file.
  for (const ev of [
    { hook_event_name: 'PostToolBatch' }, { hook_event_name: 'PostToolBatch', agent_id: SUB }, { hook_event_name: 'SubagentStop', agent_id: SUB },
    { hook_event_name: 'SessionStart', source: 'compact' }, { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
    { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'SomethingNew' },
  ]) applyHook(file, { session_id: ID, ...ev }, 7000);
  assert.equal(stamp(), before);
  assert.equal(readRun(file).statusAt, 6000);
  applyHook(file, { hook_event_name: 'PermissionRequest', session_id: ID, tool_name: 'Bash' }, 8000);
  assert.deepEqual([readRun(file).status, readRun(file).statusAt, fs.existsSync(watchFile(file))], ['attention', 8000, true]);
  const asked = stamp();
  applyHook(file, { hook_event_name: 'Notification', session_id: ID, notification_type: 'permission_prompt', message: 'Claude needs your permission' }, 9000);
  applyHook(file, { hook_event_name: 'PostToolBatch', session_id: ID, agent_id: SUB }, 9000);
  assert.equal(stamp(), asked, 'the reminder and another agent\'s tools change nothing');
  applyHook(file, { hook_event_name: 'PostToolBatch', session_id: ID }, 9500);
  assert.deepEqual([readRun(file).status, readRun(file).note, fs.existsSync(watchFile(file))], ['working', '', false]);
  applyHook(file, { hook_event_name: 'SessionEnd', session_id: ID }, 9900);
  assert.deepEqual([readRun(file).status, fs.existsSync(watchFile(file))], ['ended', false]);
  // The mark goes with the run.
  applyHook(file, { hook_event_name: 'SessionStart', source: 'resume', session_id: ID }, 9950);
  assert.equal(fs.existsSync(watchFile(file)), true);
  R.removeRun(file);
  assert.equal(fs.existsSync(watchFile(file)), false);
  assert.equal(applyHook(file, { hook_event_name: 'Stop' }), null, 'a run that is gone is left alone');
  assert.deepEqual([wantsToolNews({ status: 'working' }), wantsToolNews({ status: 'working', asks: ['x'] }), wantsToolNews({ status: 'waiting' }), wantsToolNews({ status: 'ended' }), wantsToolNews(null)], [false, true, true, false, false]);
});

test('a record written before these fields existed is read as it is', () => {
  const old = { status: 'attention', note: 'Claude needs your permission to use Bash', attentionKind: 'permission_prompt' };
  assert.equal(play([e('Stop', {})], old).run.status, 'waiting');
  assert.equal(play([e('UserPromptSubmit')], old).run.status, 'working');
});

test('the small hook program: silent, never fails, does the same as `hoprig hook`', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const run = (input) => spawnSync(process.execPath, [hookFile()], { input, env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
  let r = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: ID }));
  assert.deepEqual([r.status, r.stdout + r.stderr], [0, '']);
  assert.deepEqual([readRun(file).status, readRun(file).sessionId], ['working', ID]);
  r = run('not json');
  assert.deepEqual([r.status, r.stdout + r.stderr], [0, '']);
  r = spawnSync(process.execPath, [hookFile()], { input: '{}', env: { ...process.env, HOPRIG_RUN_FILE: '' }, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout + r.stderr], [0, '']);
  R.removeRun(file);
});

test('hook settings: the exact events only for a Claude Code that surely knows them', () => {
  const basic = ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'];
  for (const version of [null, '', 'nonsense', '2.1.318', '2.0.76', '1.0.0']) assert.deepEqual(Object.keys(L.hookSettings({ version }).hooks).sort(), basic, String(version));
  for (const version of [L.EXACT_SINCE, '2.1.325', '2.2.0', '3.0.1']) {
    assert.deepEqual(Object.keys(L.hookSettings({ version }).hooks).sort(), [...basic, 'PermissionRequest', 'PostToolBatch', 'SubagentStop'].sort(), version);
  }
  for (const [name, entry] of Object.entries(L.hookSettings({ version: '2.1.325' }).hooks)) {
    assert.equal(entry.length, 1, name);
    assert.deepEqual(Object.keys(entry[0]), ['hooks'], `${name}: no matcher, every occurrence`);
    assert.deepEqual([entry[0].hooks[0].type, entry[0].hooks[0].timeout], ['command', 5], name);
    assert.ok(entry[0].hooks[0].command.includes(hookFile()), name);
  }
});

test('the hook after tool calls starts nothing unless the run asks for tool news', { skip: process.platform === 'win32' }, () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const cmd = L.hookSettings({ version: '2.1.325' }).hooks.PostToolBatch[0].hooks[0].command;
  assert.match(cmd, /^if \[ -e "\$HOPRIG_RUN_FILE\.watch" \]; then .* fi$/);
  const fire = () => spawnSync('sh', ['-c', cmd], { input: JSON.stringify({ hook_event_name: 'PostToolBatch', session_id: ID }), env: { ...process.env, HOPRIG_RUN_FILE: file }, encoding: 'utf8' });
  // "starting" with no mark yet: the test is false, the shell ends with 0 and the record is untouched.
  let r = fire();
  assert.deepEqual([r.status, r.stdout + r.stderr, readRun(file).status], [0, '', 'starting']);
  // Claude finished a reply (waiting, the mark is set), then went on by itself: the next batch reports it.
  applyHook(file, { hook_event_name: 'Stop', session_id: ID });
  assert.equal(readRun(file).status, 'waiting');
  r = fire();
  assert.deepEqual([r.status, r.stdout + r.stderr, readRun(file).status, fs.existsSync(watchFile(file))], [0, '', 'working', false]);
  R.removeRun(file);
});

test('the installed version is read from where Claude Code lives, without starting it', () => {
  assert.equal(C.versionFromPath('/home/u/.local/share/claude/versions/2.1.325'), '2.1.325');
  assert.equal(C.versionFromPath('C:\\Users\\u\\.local\\share\\claude\\versions\\2.1.300.exe'), '2.1.300');
  const pkg = (f) => { assert.equal(f, '/usr/lib/node_modules/@anthropic-ai/claude-code/package.json'); return '{"version":"2.1.400"}'; };
  assert.equal(C.versionFromPath('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', pkg), '2.1.400');
  assert.equal(C.versionFromPath('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', () => { throw new Error('gone'); }), null);
  assert.equal(C.versionFromPath('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', () => '{"version":7}'), null);
  for (const p of ['/usr/local/bin/claude', '', null]) assert.equal(C.versionFromPath(p), null);
  assert.equal(C.claudeVersionQuick({ bin: path.join(tmp, 'no-such-claude'), env: { PATH: tmp } }), null);
});
