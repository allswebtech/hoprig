// The hook: which Claude Code event sets which status (src/hook.mjs), that it writes only when something changes,
// what it answers Claude Code, and what the launcher hands Claude Code. The event orders below are the ones a hook
// that logged every event recorded on Claude Code 2.1.325 and 2.1.326.
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

const { applyHook, askedWhat, hookAnswer, hookPatch, sessionFacts, wantsToolNews } = await import('../src/hook.mjs');
const { SHELL_TOOL, askRules, askType, bypassAllows, ruleNames } = await import('../src/asking.mjs');
const { readRun, watchFile } = await import('../src/runfile.mjs');
const R = await import('../src/runs.mjs');
const L = await import('../src/launch.mjs');
const C = await import('../src/claudecode.mjs');
const { configFile, hookFile } = await import('../src/paths.mjs');

const ID = '77777777-7777-4777-8777-777777777777';
const SUB = 'a0000000000000001';

// What the hook knows about a session beyond the event (hook.mjs sessionFacts), for the tests: no ask rules, the
// command runs in a project.
const PROJECT = '/home/alex/Workspace/p';
const FACTS = { rules: () => [], places: () => ({ home: '/home/alex', workspace: '/home/alex/Workspace', cwd: PROJECT, relative: true }) };

/** Run the events through the hook's rules, with its own answer as hookMain gives it; returns the record after each, as "status|note". */
function play(events, run = { status: 'starting', note: '' }, facts = FACTS) {
  const seen = [];
  for (const one of events) {
    const ev = { session_id: ID, ...one };
    run = { ...run, ...hookPatch(run, ev, 1000, { allowed: !!hookAnswer(ev, facts) }) };
    seen.push(`${run.status}|${run.note}`);
  }
  return { run, seen };
}
const e = (hook_event_name, more = {}) => ({ hook_event_name, ...more });
const bash = { tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer s3cret" https://example.com' } };
const NOTE = 'Claude needs your permission to use Bash: curl -H "Authorization: Bearer ***" https://example.com';

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
    `attention|${NOTE}`,
    `attention|${NOTE}`,
    'working|', 'waiting|',
  ]);
  assert.deepEqual([run.asks, run.attentionKind, run.sessionId], [[], null, ID]);
});

test('the note says what is asked, on one line, shortened, with what looks like a secret masked; a question shows its own words', () => {
  const asked = play([e('PermissionRequest', bash)]).run;
  assert.equal(asked.note, NOTE);
  assert.equal(asked.note.includes('s3cret'), false);
  assert.equal(asked.attentionKind, 'permission_prompt');
  // Two questions read apart by what they ask.
  assert.equal(play([e('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/w/app.js', old_string: 'a', new_string: 'b' } })]).run.note, 'Claude needs your permission to use Edit: /w/app.js');
  assert.equal(play([e('PermissionRequest', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/?token=abcdef123456', prompt: 'x' } })]).run.note, 'Claude needs your permission to use WebFetch: https://example.com/?token=***');
  const long = askedWhat({ tool_input: { command: `echo ${'x'.repeat(300)} && export API_KEY=sk-ant-abcdefghijklmnop` } });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
  assert.equal(askedWhat({ tool_input: { command: `export GH=ghp_${'a'.repeat(30)}\n  ls` } }), 'export GH=*** ls', 'masked before it is shortened, one line');
  assert.equal(askedWhat({ tool_input: { command: 'x'.repeat(130) + 'sk-ant-' + 'abcdefghijklmnopqrstu' } }).includes('sk-ant'), false);
  const q = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which  database\nshould I use?', options: [] }] } };
  assert.equal(play([e('PermissionRequest', q)]).run.note, 'Claude asks: Which database should I use?');
  assert.equal(play([e('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: {} })]).run.note, 'Claude has a question for you');
  assert.equal(play([e('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } })]).run.note, 'Claude needs your approval for the plan');
  assert.equal(play([e('PermissionRequest', {})]).run.note, 'Claude needs your permission');
});

// What 2.1.326 sends for its own stop before a delete in bypass mode ("Dangerous rm operation on critical path", and
// "… on statically-unresolvable target" for rm -rf dir/*/*): the tool, its input, the mode, no suggestions, no reason.
const bypass = { permission_mode: 'bypassPermissions' };
const stopped = { ...bypass, tool_name: 'Bash', tool_input: { command: 'rm -rf build/*/*', description: 'Remove what is under build' }, permission_suggestions: [] };
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
const answer = (ev, facts = FACTS) => hookAnswer(e('PermissionRequest', ev), facts);

test('bypass mode: the hook allows a plain delete inside the folder the command runs in, and nobody is asked', () => {
  assert.deepEqual(answer(stopped), ALLOW);
  for (const command of ['rm -rf t1/*/*', 'rm -rf build', 'rm -rf build && rm -rf dist/*', `rm -rf ${PROJECT}/old`]) {
    assert.deepEqual(answer({ ...stopped, tool_input: { command } }), ALLOW, command);
  }
  assert.deepEqual(answer({ ...stopped, agent_id: SUB }), ALLOW, 'a subagent\'s too');
  const { seen, run } = play([
    e('UserPromptSubmit', bypass),
    e('PermissionRequest', stopped),
    e('Stop', { ...bypass, background_tasks: [] }),
  ]);
  assert.deepEqual(seen, ['working|', 'working|', 'waiting|'], 'no "needs your OK": no question is on the screen');
  assert.deepEqual([run.asks ?? [], run.askType ?? null], [[], null]);
  // Every other mode asks the owner, and so does every other event.
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', undefined, 'BypassPermissions']) {
    assert.equal(answer({ ...stopped, permission_mode: mode }), null, String(mode));
  }
  for (const name of ['PreToolUse', 'Notification', 'Stop', 'UserPromptSubmit', undefined]) assert.equal(hookAnswer(e(name, stopped), FACTS), null, String(name));
  for (const ev of [null, undefined, 'x', 7]) assert.equal(hookAnswer(ev, FACTS), null);
});

test('bypass mode: every other command keeps Claude Code\'s question, and so does a delete that is not plainly inside the folder', () => {
  for (const command of ['npm test', 'rm -rf ~', 'rm -rf .', 'rm -rf ..', 'cd .. && rm -rf *', 'rm -rf *', 'rm -rf "$DIR"/*', "r''m -rf ~", 'timeout 5 rm -rf ~', 'git rm -r x']) {
    assert.equal(answer({ ...stopped, tool_input: { command } }), null, command);
  }
  // Where the command runs decides: the same delete from the home folder, the workspace, / or an unknown folder is asked.
  for (const cwd of ['/home/alex', '/home/alex/Workspace', '/', '/home', null]) {
    assert.equal(answer(stopped, { ...FACTS, places: () => ({ ...FACTS.places(), cwd }) }), null, String(cwd));
  }
});

test('bypass mode: only Bash is answered; the file tools, PowerShell and every other tool are asked as Claude Code would', () => {
  assert.equal(SHELL_TOOL, 'Bash');
  for (const tool_name of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit']) assert.equal(answer({ ...bypass, tool_name, tool_input: { file_path: `${PROJECT}/a` } }), null, tool_name);
  for (const tool_name of ['PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'Monitor', 'Workflow', 'Skill', 'MultiEdit', 'mcp__github__create_issue', 'SendMessage', 'SomethingNew', 'bash', '', undefined]) {
    assert.equal(answer({ ...bypass, tool_name, tool_input: { command: 'rm -rf build' } }), null, String(tool_name));
  }
  // A shell call without a command to look at is not answered either.
  assert.equal(answer({ ...bypass, tool_name: 'Bash', tool_input: {} }), null);
});

test('bypass mode: a question to the owner and a plan are not permissions; they are still shown', () => {
  const q = { ...bypass, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which toppings?', multiSelect: true }] } };
  // Claude Code reports "plan" as the mode once Claude itself entered plan mode in a bypass session.
  for (const ev of [q, { ...bypass, tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } }, { permission_mode: 'plan', tool_name: 'ExitPlanMode' }]) {
    assert.equal(answer(ev), null, ev.tool_name);
  }
  const asked = play([e('UserPromptSubmit', bypass), e('PermissionRequest', q)]).run;
  assert.deepEqual([asked.status, asked.note, asked.askType], ['attention', 'Claude asks: Which toppings?', 'question']);
  assert.equal(play([e('PermissionRequest', { ...bypass, tool_name: 'ExitPlanMode' })]).run.askType, 'plan');
});

test('bypass mode: a tool an "ask" rule of the owner\'s settings names is asked, whatever the rule\'s pattern', () => {
  const rules = (list) => ({ ...FACTS, rules: () => list });
  assert.equal(answer(stopped, rules(['Bash(echo hoprigask*)'])), null, 'a rule for another Bash command: Bash is asked');
  assert.equal(answer(stopped, rules(['Bash'])), null);
  assert.deepEqual(answer(stopped, rules(['Edit(docs/**)', 'WebFetch', 'Read'])), ALLOW, 'rules for other tools');
  assert.equal(answer(stopped, rules(['*'])), null, 'a settings file that could not be read');
  assert.deepEqual([ruleNames('Bash(npm *)', 'Bash'), ruleNames(' Bash ', 'Bash'), ruleNames('Bashful', 'Bash'), ruleNames(7, 'Bash')], [true, true, false, false]);
});

test('the ask rules are read from every settings file Claude Code reads for the session, at the moment of the ask', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'rules-'));
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const ask = (rule) => ({ permissions: { ask: [rule], allow: ['Bash(ls)'] } });
  write('claude/settings.json', ask('Bash(user)'));
  write('repo/.git/HEAD', 'ref: refs/heads/main\n');
  write('repo/.claude/settings.local.json', ask('Bash(repo-local)'));
  write('repo/app/.claude/settings.json', ask('Bash(project)'));
  write('repo/app/.claude/settings.local.json', ask('Bash(local)'));
  write('managed/managed-settings.json', ask('Bash(managed)'));
  write('managed/managed-settings.d/20-team.json', ask('Bash(drop-in)'));
  write('managed/managed-settings.d/.hidden.json', ask('Bash(hidden)'));
  write('hook-settings/run.json', ask('Bash(hoprig)'));
  const read = () => askRules({ project: path.join(root, 'repo', 'app'), configDir: path.join(root, 'claude'), extra: path.join(root, 'hook-settings', 'run.json'), managed: path.join(root, 'managed') });
  assert.deepEqual(read(), ['Bash(user)', 'Bash(project)', 'Bash(local)', 'Bash(repo-local)', 'Bash(managed)', 'Bash(drop-in)', 'Bash(hoprig)']);
  // A worktree's local settings are the main checkout's.
  write('repo/.git/worktrees/wt/HEAD', 'ref: refs/heads/x\n');
  write('wt/.git', `gitdir: ${path.join(root, 'repo', '.git', 'worktrees', 'wt')}\n`);
  assert.deepEqual(askRules({ project: path.join(root, 'wt'), configDir: path.join(root, 'none'), managed: null }), ['Bash(repo-local)']);
  // Read again at every ask: a rule added a moment ago counts.
  write('repo/app/.claude/settings.json', ask('Edit'));
  assert.ok(read().includes('Edit'));
  // A file that is there but cannot be read as settings: what it says cannot be known, so everything is asked.
  write('repo/app/.claude/settings.json', '{ not json');
  assert.ok(read().includes('*'));
  // The same for a file that is there and cannot be read at all (here a folder in its place, so it holds as root too).
  write('repo/app/.claude/settings.json', ask('Bash(project)'));
  assert.ok(!read().includes('*'));
  fs.rmSync(path.join(root, 'repo/app/.claude/settings.json'));
  fs.mkdirSync(path.join(root, 'repo/app/.claude/settings.json'));
  assert.deepEqual(read().filter((r) => r === '*'), ['*']);
  fs.rmdirSync(path.join(root, 'repo/app/.claude/settings.json'));
  write('repo/app/.claude/settings.json', '{ not json');
  assert.deepEqual(askRules({ project: path.join(root, 'nowhere'), configDir: path.join(root, 'none'), managed: path.join(root, 'none') }), []);
  // The hook finds them for its session: the project from Claude Code's CLAUDE_PROJECT_DIR, Hoprig's own settings file
  // next to the run records.
  write('state/runs/x.json', '{}');
  write('state/hook-settings/x.json', ask('Bash(handed)'));
  const facts = sessionFacts({ cwd: '/elsewhere' }, { HOPRIG_RUN_FILE: path.join(root, 'state', 'runs', 'x.json'), CLAUDE_PROJECT_DIR: path.join(root, 'repo', 'app'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), HOPRIG_WORKSPACE_DIR: '/srv/ws' });
  const got = facts.rules();
  for (const r of ['Bash(user)', 'Bash(handed)', '*']) assert.ok(got.includes(r), r);
  assert.equal(facts.places().workspace, '/srv/ws');
  assert.equal(facts.places().home, os.homedir());
  assert.equal(facts.places().cwd, '/elsewhere', 'where the command runs: the event\'s cwd');
  assert.equal(facts.places().relative, true, 'the event\'s cwd is the shell\'s folder at that moment, so a relative target can be read');
  assert.equal(sessionFacts({}, {}).places().cwd, null);
  // The folders that hold projects: the one chosen in Hoprig's settings, the default and the earlier one.
  assert.deepEqual(facts.places().projects, ['/srv/ws/projects', path.join(os.homedir(), 'projects')]);
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ projectsDir: '/srv/code' }));
  try {
    assert.deepEqual(facts.places().projects, ['/srv/code', '/srv/ws/projects', path.join(os.homedir(), 'projects')]);
    // The hook answers nothing for a delete run in one, and as before inside a project.
    for (const [cwd, yes] of [['/srv/code', false], ['/srv/ws/projects', false], ['/srv/code/shop', true]]) {
      const ev = e('PermissionRequest', { ...stopped, cwd, tool_input: { command: 'rm -rf shop/*/*' } });
      assert.equal(!!hookAnswer(ev, { rules: () => [], places: sessionFacts(ev, { HOPRIG_WORKSPACE_DIR: '/srv/ws' }).places }), yes, cwd);
    }
  } finally {
    fs.rmSync(configFile(), { force: true });
  }
});

test('one rule says what bypass allows, for a terminal and for a chat', () => {
  assert.deepEqual(['Bash', 'Write', 'mcp__x__y', undefined, 'AskUserQuestion', 'ExitPlanMode'].map(askType), ['permission', 'permission', 'permission', 'permission', 'question', 'plan']);
  const mode = 'bypassPermissions';
  const input = { command: 'rm -rf build' };
  const places = FACTS.places();
  assert.equal(bypassAllows({ mode, tool: 'Bash', input, places }), true);
  assert.equal(bypassAllows({ mode, tool: 'Bash', input }), false, 'no folder known');
  assert.equal(bypassAllows({ mode, tool: 'Bash', input, places: { ...places, relative: false } }), false, 'a relative target where the shell\'s folder is not known');
  assert.equal(bypassAllows({ mode, tool: 'Bash', input: { command: `rm -rf ${PROJECT}/build` }, places: { ...places, relative: false } }), true);
  for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'mcp__x__y', 'WebFetch', 'Write', 'PowerShell', undefined]) assert.equal(bypassAllows({ mode, tool, input, places }), false, String(tool));
  for (const why of ['question', 'rule', 'hook', 'unknown']) assert.equal(bypassAllows({ mode, tool: 'Bash', input, why, places }), false, why);
  for (const m of ['default', 'manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', null, undefined, '']) assert.equal(bypassAllows({ mode: m, tool: 'Bash', input, places }), false, String(m));
  assert.equal(bypassAllows({ mode, tool: 'Bash', input, rules: ['Bash(x)'], places }), false);
  assert.equal(bypassAllows({ mode, tool: 'Bash', input: { command: 'npm test' }, places }), false);
});

test('what still waits shows: a subagent\'s permission settled while the main agent\'s plan waits leaves "the plan"', () => {
  const plan = { tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } };
  let r = play([e('UserPromptSubmit'), e('PermissionRequest', plan), e('PermissionRequest', { ...bash, agent_id: SUB })]).run;
  // Two wait, one of them a plan: the card shows the plan (no Allow: its answer is in the terminal).
  assert.deepEqual([r.status, r.askType, r.note, r.asks], ['attention', 'plan', 'Claude needs your approval for the plan', ['main', SUB]]);
  r = { ...r, ...hookPatch(r, e('PostToolBatch', { agent_id: SUB }), 2000) };
  assert.deepEqual([r.status, r.askType, r.note, r.asks, r.askAt], ['attention', 'plan', 'Claude needs your approval for the plan', ['main'], 2000]);
  // The other way round: a subagent's question waits, the main agent asks a permission.
  r = play([e('PermissionRequest', { tool_name: 'AskUserQuestion', agent_id: SUB, tool_input: { questions: [{ question: 'Red?' }] } }), e('PermissionRequest', bash)]).run;
  assert.deepEqual([r.askType, r.note], ['question', 'Claude asks: Red?']);
  r = { ...r, ...hookPatch(r, e('SubagentStop', { agent_id: SUB }), 3000) };
  assert.deepEqual([r.askType, r.note, r.asks], ['permission', NOTE, ['main']]);
  // Two permissions: the newest shows; when it is answered the other one is offered again (its own kind, a new time).
  r = play([e('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/w/a' } }), e('PermissionRequest', { ...bash, agent_id: SUB })]).run;
  assert.deepEqual([r.askType, r.note], ['permission', NOTE]);
  r = { ...r, ...hookPatch(r, e('PostToolBatch', { agent_id: SUB }), 4000) };
  assert.deepEqual([r.askType, r.note, r.askAt], ['permission', 'Claude needs your permission to use Write: /w/a', 4000]);
  // A record an older hook wrote (one kind for the session) keeps its kind for the asker it had.
  r = play([e('PermissionRequest', { ...bash, agent_id: SUB })], { status: 'attention', asks: ['main'], askType: 'plan', note: 'Claude needs your approval for the plan', askAt: 5 }).run;
  assert.deepEqual([r.askType, r.note], ['plan', 'Claude needs your approval for the plan']);
});

test('every allow the hook gives is written down for the owner: time, tool, what, masked; the newest 20', () => {
  let r = play([e('UserPromptSubmit', bypass), e('PermissionRequest', { ...bypass, tool_name: 'Bash', tool_input: { command: 'rm -rf "cache/Bearer s3cret1" && rm -rf t1/*/*' } })]).run;
  assert.deepEqual(r.allowed, [{ n: 1, at: 1000, tool: 'Bash', what: 'rm -rf "cache/Bearer ***" && rm -rf t1/*/*' }]);
  for (let i = 0; i < 25; i++) r = play([e('PermissionRequest', { ...stopped, tool_input: { command: `rm -rf build${i}` } })], r).run;
  assert.equal(r.allowed.length, 20);
  assert.equal(r.allowed.at(-1).what, 'rm -rf build24');
  assert.equal(r.allowed.at(-1).n, 26, 'numbered on, also past the newest 20');
  // What is not allowed by the hook is not written there.
  r = play([e('PermissionRequest', { ...stopped, tool_input: { command: 'rm -rf ~' } })], r).run;
  assert.deepEqual([r.allowed.at(-1).what, r.status, r.note], ['rm -rf build24', 'attention', 'Claude needs your permission to use Bash: rm -rf ~']);
});

test('what is asked goes with the ask: a permission, a question, a plan; every ask has its own time', () => {
  let run = { status: 'working', note: '' };
  const step = (ev, now) => (run = { ...run, ...hookPatch(run, { session_id: ID, ...ev }, now) });
  step(e('PermissionRequest', bash), 1000);
  assert.deepEqual([run.askType, run.askAt], ['permission', 1000]);
  // The six-second reminder is the same question: neither its kind nor its time changes.
  step(e('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }), 7000);
  assert.deepEqual([run.askType, run.askAt], ['permission', 1000]);
  // Two calls of one batch that both ask: no event between the first answer and the second question but the question.
  step(e('PermissionRequest', bash), 9000);
  assert.deepEqual([run.status, run.askType, run.askAt], ['attention', 'permission', 9000]);
  step(e('PostToolBatch'), 9500);
  assert.deepEqual([run.status, run.askType, run.note], ['working', null, '']);
  step(e('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Red or blue?' }] } }), 10_000);
  assert.deepEqual([run.askType, run.askAt], ['question', 10_000]);
  step(e('Stop', {}), 11_000);
  assert.equal(run.askType, null);
  // A notification alone (a session whose settings name no PermissionRequest; a form of an MCP server): the kind is not known.
  step(e('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }), 12_000);
  assert.deepEqual([run.status, run.askType, run.askAt], ['attention', null, 12_000]);
  step(e('StopFailure', { error: 'server_error' }), 13_000);
  assert.equal(run.askType, null);
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
  assert.deepEqual(seen, ['working|', `attention|${NOTE}`, 'working|']);
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
    `attention|${NOTE}`, `attention|${NOTE}`,
    `attention|${NOTE}`, `attention|${NOTE}`, 'working|',
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

test('a subagent the owner stopped while it asked: its question goes with the next reply\'s end, and later turns are plain', () => {
  // As recorded on 2.1.325: the agent asks, the owner presses ctrl+x ctrl+k twice; no PostToolBatch and no
  // SubagentStop come for it, only a turn that tells about it and that turn's Stop, which no longer lists it.
  const { seen, run } = play([
    e('UserPromptSubmit', { prompt: 'zz-agent' }),
    e('Stop', { background_tasks: [{ id: SUB, type: 'subagent', status: 'running' }] }),
    e('PermissionRequest', { ...bash, agent_id: SUB }),
    e('UserPromptSubmit', { prompt: 'Background agent "a sub task" was stopped by the user.' }),
    e('Stop', { background_tasks: [] }),
    e('UserPromptSubmit', { prompt: 'hello there' }),
    e('Stop', { background_tasks: [] }),
  ]);
  assert.deepEqual(seen, [
    'working|', 'working|', `attention|${NOTE}`, `attention|${NOTE}`,
    'waiting|', 'working|', 'waiting|',
  ]);
  assert.deepEqual([run.asks, run.background, run.attentionKind], [[], [], null]);
  // The same when the agent asked before the main reply ended, and when Stop still lists it as stopped.
  const early = play([e('UserPromptSubmit'), e('PermissionRequest', { ...bash, agent_id: SUB }), e('Stop', { background_tasks: [] })]);
  assert.deepEqual(early.seen.at(-1), 'waiting|');
  for (const status of ['killed', 'stopped', 'completed', 'failed']) {
    const listed = play([e('PermissionRequest', { ...bash, agent_id: SUB }), e('Stop', { background_tasks: [{ id: SUB, type: 'subagent', status }] })]).run;
    assert.deepEqual([listed.status, listed.asks, listed.background], ['waiting', [], []], status);
  }
  // Only the stopped one goes: another subagent that still runs keeps its question.
  const two = play([
    e('PermissionRequest', { ...bash, agent_id: SUB }),
    e('PermissionRequest', { tool_name: 'Write', agent_id: 'other' }),
    e('Stop', { background_tasks: [{ id: 'other', type: 'subagent', status: 'running' }] }),
  ]).run;
  assert.deepEqual([two.status, two.asks, two.note], ['attention', ['other'], 'Claude needs your permission to use Write']);
  // A workflow's agents are not listed by id: while a workflow runs, a question from one of them stays.
  const flow = play([e('PermissionRequest', { ...bash, agent_id: SUB }), e('Stop', { background_tasks: [{ id: 'w1', type: 'workflow', status: 'running' }] })]).run;
  assert.deepEqual([flow.status, flow.asks, flow.background], ['attention', [SUB], ['w1']]);
  assert.deepEqual(play([e('Stop', { background_tasks: [] })], flow).run.status, 'waiting', 'it goes when the workflow is over');
  // A new prompt does not drop a subagent's question: after a Stop every question left belongs to an agent that
  // Stop listed as running, and one asked since (the turn ended by Esc, so no Stop came) may still really wait.
  // The next Stop's list decides.
  const esc = play([e('UserPromptSubmit'), e('PermissionRequest', { ...bash, agent_id: SUB }), e('UserPromptSubmit', { prompt: 'next' })]);
  assert.deepEqual(esc.seen.at(-1), `attention|${NOTE}`);
  assert.deepEqual(play([e('Stop', { background_tasks: [{ id: SUB, type: 'subagent', status: 'running' }] })], esc.run).run.asks, [SUB]);
  assert.deepEqual(play([e('Stop', { background_tasks: [] })], esc.run).run.status, 'waiting');
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

test('after a stopped subagent\'s question the mark for tool news goes with the next plain turn', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const ev = (hook_event_name, more = {}) => applyHook(file, { hook_event_name, session_id: ID, ...more }, 5000);
  ev('UserPromptSubmit');
  ev('Stop', { background_tasks: [{ id: SUB, type: 'subagent', status: 'running' }] });
  ev('PermissionRequest', { ...bash, agent_id: SUB });
  ev('UserPromptSubmit', { prompt: 'Background agent "a sub task" was stopped by the user.' });
  ev('Stop', { background_tasks: [] });
  assert.deepEqual([readRun(file).status, readRun(file).note, readRun(file).asks], ['waiting', '', []]);
  ev('UserPromptSubmit', { prompt: 'hello there' });
  assert.deepEqual([readRun(file).status, fs.existsSync(watchFile(file))], ['working', false]);
  R.removeRun(file);
});

test('a record written before these fields existed is read as it is', () => {
  const old = { status: 'attention', note: 'Claude needs your permission to use Bash', attentionKind: 'permission_prompt' };
  assert.equal(play([e('Stop', {})], old).run.status, 'waiting');
  assert.equal(play([e('UserPromptSubmit')], old).run.status, 'working');
});

test('the small hook program: silent, never fails, does the same as `hoprig hook`', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const run = (input) => spawnSync(process.execPath, [hookFile()], { input, env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: tmp }, encoding: 'utf8' });
  let r = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: ID }));
  assert.deepEqual([r.status, r.stdout + r.stderr], [0, '']);
  assert.deepEqual([readRun(file).status, readRun(file).sessionId], ['working', ID]);
  r = run('not json');
  assert.deepEqual([r.status, r.stdout + r.stderr], [0, '']);
  r = spawnSync(process.execPath, [hookFile()], { input: '{}', env: { ...process.env, HOPRIG_RUN_FILE: '' }, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout + r.stderr], [0, '']);
  // A permission in another mode: the owner is asked, the program says nothing.
  r = run(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: ID, permission_mode: 'default', ...bash }));
  assert.deepEqual([r.status, r.stdout + r.stderr, readRun(file).status], [0, '', 'attention']);
  R.removeRun(file);
});

test('the small hook program in bypass mode: one line that allows, written down, and the record never says "needs your OK"', () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  const project = fs.mkdtempSync(path.join(tmp, 'project-'));
  const base = { HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: project };
  const run = (ev, env = base) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify({ session_id: ID, ...ev }), env: { ...process.env, ...env }, encoding: 'utf8' });
  // Claude Code's event carries the folder the shell is in: the delete is read from there.
  const here = { ...stopped, cwd: project };
  run(e('UserPromptSubmit', bypass));
  let r = run(e('PermissionRequest', here));
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.equal(r.stdout, `${JSON.stringify(ALLOW)}\n`, 'exactly what Claude Code 2.1.326 takes as "allow"');
  assert.deepEqual([readRun(file).status, readRun(file).asks ?? [], readRun(file).allowed.map((a) => [a.tool, a.what])], ['working', [], [['Bash', 'rm -rf build/*/*']]]);
  // A question in the same session is put to the owner: nothing is printed.
  r = run(e('PermissionRequest', { ...bypass, cwd: project, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?' }] } }));
  assert.deepEqual([r.stdout + r.stderr, readRun(file).status, readRun(file).askType], ['', 'attention', 'question']);
  run(e('PostToolBatch', bypass));
  // A delete of the home folder: Claude Code's own stop stands.
  r = run(e('PermissionRequest', { ...here, tool_input: { command: 'rm -rf ~' } }));
  assert.deepEqual([r.stdout + r.stderr, readRun(file).status, readRun(file).note], ['', 'attention', 'Claude needs your permission to use Bash: rm -rf ~']);
  run(e('PostToolBatch', bypass));
  // The same delete from the home folder, or with no folder in the event: Claude Code's stop stands.
  for (const cwd of [os.homedir(), undefined]) {
    r = run(e('PermissionRequest', { ...stopped, cwd }));
    assert.deepEqual([r.stdout + r.stderr, readRun(file).status], ['', 'attention'], String(cwd));
    run(e('PostToolBatch', bypass));
  }
  // An ask rule of the project's settings, added while the session runs: Bash is asked from the next ask on.
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(echo hoprigask*)'] } }));
  r = run(e('PermissionRequest', here));
  assert.deepEqual([r.stdout + r.stderr, readRun(file).status], ['', 'attention']);
  fs.rmSync(path.join(project, '.claude'), { recursive: true });
  // The answer does not depend on the record: the launcher's record is gone, the question still must not stay.
  R.removeRun(file);
  r = run(e('PermissionRequest', here));
  assert.equal(r.stdout, `${JSON.stringify(ALLOW)}\n`);
  // Not a session Hoprig started: the program answers nothing.
  r = run(e('PermissionRequest', here), { HOPRIG_RUN_FILE: '' });
  assert.deepEqual([r.status, r.stdout + r.stderr], [0, '']);
});

test('twenty hook programs of one session at the same moment: none of their changes is lost', async () => {
  const { file } = R.createRun({ profile: 'sub', cwd: '/w' });
  applyHook(file, { hook_event_name: 'UserPromptSubmit', session_id: ID });
  const { spawn } = await import('node:child_process');
  const one = (i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [hookFile()], { env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: tmp }, stdio: ['pipe', 'ignore', 'inherit'] });
    p.on('error', reject);
    p.on('exit', resolve);
    // Each a subagent's question in a mode that asks: twenty askers to keep.
    p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: ID, permission_mode: 'default', agent_id: `agent-${i}`, tool_name: 'Bash', tool_input: { command: `echo ${i}` } }));
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) => one(i)));
  const run = readRun(file);
  assert.deepEqual([...run.asks].sort(), Array.from({ length: 20 }, (_, i) => `agent-${i}`).sort());
  assert.equal(Object.keys(run.askers).length, 20);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is gone');
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

test('a coding chat\'s hook: only PermissionRequest, for the same versions, the same program as a terminal\'s', () => {
  for (const version of [null, '', '2.1.318']) assert.equal(L.permissionHook(version), null, String(version));
  for (const version of [L.EXACT_SINCE, '2.1.326']) {
    assert.deepEqual(L.permissionHook(version), { PermissionRequest: L.hookSettings({ version }).hooks.PermissionRequest }, version);
  }
});

test('a coding chat\'s record keeps only what the hook allowed: the chat follows the rest, the cards included, through its own channel', () => {
  const { file } = R.createChatRun({ chat: 'c1', conversation: ID, cwd: '/w/p', profile: 'sub' });
  const before = readRun(file);
  const project = fs.mkdtempSync(path.join(tmp, 'chatproject-'));
  // What the hook does not answer (the home folder, a question) changes nothing in the record.
  for (const ev of [e('PermissionRequest', { ...stopped, cwd: project, tool_input: { command: 'rm -rf ~' } }), e('PermissionRequest', { ...bypass, tool_name: 'AskUserQuestion', tool_input: {} }), e('Stop', {}), e('SessionEnd', {}), e('UserPromptSubmit', {})]) {
    applyHook(file, { session_id: ID, ...ev }, 5, hookAnswer(ev, sessionFacts(ev, { HOPRIG_RUN_FILE: file })));
  }
  assert.deepEqual(readRun(file), before);
  assert.deepEqual(hookPatch(before, e('PermissionRequest', stopped), 5), {});
  // A plain delete in the shell's folder: allowed, and written down for the chat to show.
  const ev = { session_id: ID, ...e('PermissionRequest', { ...stopped, cwd: project }) };
  const answer = hookAnswer(ev, sessionFacts(ev, { HOPRIG_RUN_FILE: file }));
  assert.deepEqual(answer, ALLOW);
  applyHook(file, ev, 7, answer);
  assert.deepEqual(readRun(file), { ...before, allowed: [{ n: 1, at: 7, tool: 'Bash', what: 'rm -rf build/*/*', folder: project }] });
  // Two allows of the same moment are told apart by their number, given under the record's lock.
  applyHook(file, ev, 7, answer);
  assert.deepEqual(readRun(file).allowed.map((a) => [a.n, a.at]), [[1, 7], [2, 7]]);
  // Where the command ran, when that is not the session's own folder: relative to it inside it.
  assert.equal(hookPatch({ cwd: '/w/p' }, e('PermissionRequest', { ...stopped, cwd: '/w/p/sub/x' }), 9, { allowed: true }).allowed[0].folder, 'sub/x');
  assert.equal(hookPatch({ cwd: '/w/p' }, e('PermissionRequest', { ...stopped, cwd: '/w/p' }), 9, { allowed: true }).allowed[0].folder, undefined);
  assert.equal(hookPatch({ cwd: '/w/p' }, e('PermissionRequest', { ...stopped, cwd: '/srv/q' }), 9, { allowed: true }).allowed[0].folder, '/srv/q');
  assert.ok(!fs.existsSync(watchFile(file)), 'a chat starts no hook after tool calls');
  R.removeRun(file);
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
