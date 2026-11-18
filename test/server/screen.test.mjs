// What Claude Code's screen shows it doing (src/server/screen.mjs) and how the deck uses it to correct a card.
// The screens are as Claude Code 2.1.325 drew them in a terminal (tmux capture), with made-up folders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-screen-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { IDLE_MS, interrupted, screenLook, shownStatus } = await import('../../src/server/screen.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { transitions } = await import('../../src/server/watcher.mjs');
const R = await import('../../src/runs.mjs');
const { applyHook } = await import('../../src/hook.mjs');

const RULE = '─'.repeat(100);
const real = (name) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-screens', `${name}.txt`), 'utf8');
const pad = (l) => l.padEnd(100); // a terminal's lines come with their trailing blanks

const WORKING = [
  '❯ run the long check',
  '',
  '  A test command · 5s',
  '  ⎿  $ node -e "setTimeout(()=>{},40000)"',
  '',
  '✻ Cogitating… (3s · ↓ 20 tokens)',
  '  ⎿  Tip: Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏸ manual mode on · esc to interrupt',
].map(pad).join('\n');

// The owner types while Claude works: the footer loses its hint, the star line stays.
const WORKING_TYPED = [
  '  ⎿  $ node -e "setTimeout(()=>{},40000)" (3s)',
  '     (ctrl+b to run in background)',
  '',
  '✢ Cogitating… (4s · ↓ 20 tokens)',
  '  ⎿  Tip: Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.',
  '',
  RULE,
  '❯ also check the readme',
  RULE,
  '  ⏸ manual mode on',
].map(pad).join('\n');

const WORKING_NARROW = [
  '· Cogitating… (6s · ↓ 20 tokens)',
  '  ⎿  Tip: Running multiple Claude',
  '     sessions? Use /color and /rename',
  '     to tell them apart at a glance.',
  '        Ctrl+Y to paste deleted text',
  '─'.repeat(38),
  '❯ ',
  '─'.repeat(38),
  '  ⏸ manual mode on · esc to interru…',
].join('\n');

// The first second of a turn: no timer yet.
const WORKING_EARLY = ['❯ which one', '', '✽ Skedaddling…', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');

// Claude Code's permission dialog (real, 2.1.326, 80 columns: test/server/fixtures/claude-screens).
const PERMISSION = real('perm-bash-80');

// The question tool (real, 2.1.326).
const QUESTION = real('ask-80');

const WAITING = [
  '❯ run the short check',
  '',
  '  Ran 1 shell command',
  '',
  '● perm done',
  '',
  '✻ Brewed for 12s · done 11:22 AM',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].map(pad).join('\n');

// After Esc at the permission dialog (real, 2.1.326): the turn is over and no hook event says so; Claude Code
// writes its note right above the message box.
const INTERRUPTED = real('after-esc-80');

// The main reply ended, a subagent goes on in the background: the message box, and the agents under the footer.
const BACKGROUND = [
  '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
  '',
  '● agent done',
  '',
  '✻ Waiting for 1 background agent to finish',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏸ manual mode on · ? for shortcuts · ↓ to manage',
  '  ● main',
  '  ◯ general-purpose  a sub task',
].map(pad).join('\n');

test('the screen: working, idle, or no answer', () => {
  for (const [name, screen] of Object.entries({ WORKING, WORKING_TYPED, WORKING_NARROW, WORKING_EARLY })) assert.equal(screenLook(screen), 'working', name);
  for (const [name, screen] of Object.entries({ WAITING, INTERRUPTED, BACKGROUND })) assert.equal(screenLook(screen), 'idle', name);
  // A question takes the message box's place; a shell, a menu and nothing at all are not Claude at its box.
  for (const [name, screen] of Object.entries({ PERMISSION, QUESTION, shell: 'user@host:~/projects/app$ ls\nREADME.md\nuser@host:~/projects/app$ ', empty: '', nothing: null })) {
    assert.equal(screenLook(screen), null, name);
  }
});

test('the screen: what Claude or the owner wrote is not taken for the working line', () => {
  // A reply that quotes a working line, far above the box, and one that ends in "…" without the star.
  const quoted = ['● It printed:', '✻ Cogitating… (3s)', ...Array(14).fill('  more of the reply'), '', '✻ Brewed for 2s', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
  assert.equal(screenLook(quoted), 'idle');
  assert.equal(screenLook(['● Still thinking about it…', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n')), 'idle');
  // The owner's own message starts with the arrow too, but stands under no rule.
  assert.equal(screenLook(['❯ 1. fix the build', '● ok', 'Esc to cancel'].join('\n')), null);
  // The older rounded box.
  const boxed = ['● done', '', '╭────────────────────╮', '│ >                  │', '╰────────────────────╯', '  ? for shortcuts'].join('\n');
  assert.equal(screenLook(boxed), 'idle');
});

test('the status to show: the screen corrects only what the hooks cannot see', () => {
  const asking = { status: 'attention', note: 'Claude needs your permission to use Bash', asks: ['main'] };
  // Allowed, the tool runs: no event until it ends, but Claude plainly works.
  assert.equal(shownStatus(asking, 'working'), 'working');
  // The question is on the screen (no answer from the screen), or the screen is not readable: as the run says.
  assert.equal(shownStatus(asking, null), 'attention');
  // "No" or Esc: the message box is back and stays; a moment of it proves nothing.
  assert.equal(shownStatus(asking, 'idle', IDLE_MS - 1), 'attention');
  assert.equal(shownStatus(asking, 'idle', IDLE_MS), 'waiting');
  // Esc in the middle of a turn.
  assert.equal(shownStatus({ status: 'working' }, 'idle', IDLE_MS - 1), 'working');
  assert.equal(shownStatus({ status: 'working' }, 'idle', IDLE_MS), 'waiting');
  // Subagents run in the background: the main screen is idle and that is "working" all the same.
  assert.equal(shownStatus({ status: 'working', background: ['a1'] }, 'idle', 60_000), 'working');
  assert.equal(shownStatus({ ...asking, background: ['a1'] }, 'idle', IDLE_MS), 'working');
  // An API error is not a question: it stays until the owner acts, whatever the screen shows.
  const failed = { status: 'attention', note: 'API Error: Overloaded', failure: { at: 1, error: 'overloaded' } };
  assert.equal(shownStatus(failed, 'working'), 'attention');
  assert.equal(shownStatus(failed, 'idle', 60_000), 'attention');
  // Waiting, starting and ended are never second-guessed.
  for (const status of ['waiting', 'starting', 'ended']) for (const look of ['working', 'idle', null]) assert.equal(shownStatus({ status }, look, 60_000), status);
});

// ---------- the deck: one session in a terminal, its run record kept by the hook, its screen by the test ----------
const TERM = 'pty-aaaaaaaaaaaa';
function deckWith() {
  const { file } = R.createRun({ profile: 'sub', cwd: path.join(tmp, 'app') });
  R.updateRun(file, { termId: TERM });
  const state = { screen: WAITING, now: 1_000_000 };
  const backend = {
    list: async () => [{ id: TERM, session: 'app', pid: process.pid, cwd: path.join(tmp, 'app'), attached: false, created: 1, activity: 1, command: 'node', active: true }],
    capture: async () => state.screen,
  };
  const deck = new Deck({ backend, config: () => ({}), profiles: () => [], now: () => state.now });
  const hook = (ev) => applyHook(file, { session_id: '88888888-8888-4888-8888-888888888888', ...ev }, state.now);
  const card = async (screen, ms = 0) => {
    if (screen !== undefined) state.screen = screen;
    state.now += ms;
    return (await deck.list()).find((c) => c.name === 'app');
  };
  return { file, hook, card, state, deck };
}

test('the deck: what it knew of a start ends at the first record written in that terminal, or with the terminal', async () => {
  const CONV = '77777777-7777-4777-8777-777777777777';
  const terms = [{ id: TERM, session: 'app', pid: process.pid, cwd: path.join(tmp, 'app'), attached: false, created: 1, activity: 1, command: 'bash', active: true }];
  const deck = new Deck({ backend: { list: async () => terms.slice(), capture: async () => WAITING }, config: () => ({}), profiles: () => [], now: () => Date.now() });
  const run = () => {
    const { file } = R.createRun({ profile: 'sub', cwd: path.join(tmp, 'app'), conversation: CONV });
    R.updateRun(file, { termId: TERM });
    return file;
  };
  // A move restarts the terminal in place: the old launcher's record, written before the note, does not end it.
  const old = run();
  deck.noteLaunch('app', CONV, 'claude', Date.now() + 1000);
  await deck.list();
  assert.ok(deck.launchOf(CONV), 'no record since: the note holds');
  R.removeRun(old);
  // The new launcher writes its record: from then on records alone say what runs, also after that launcher ended
  // and left a plain shell in the terminal (a look in between is enough, as the watcher's tick).
  deck.noteLaunch('app', CONV, 'claude', Date.now() - 1);
  const file = run();
  await deck.list();
  R.removeRun(file);
  await deck.list();
  assert.equal(deck.launchOf(CONV), null, 'a record was written there: the note is over');
  deck.noteLaunch('app', CONV);
  terms.length = 0;
  await deck.list();
  assert.equal(deck.launchOf(CONV), null, 'its terminal is gone: the note is over');
});

test('a card: needs your OK only while the question waits; the note goes with it', async () => {
  const { file, hook, card } = deckWith();
  hook({ hook_event_name: 'SessionStart', source: 'startup' });
  hook({ hook_event_name: 'UserPromptSubmit' });
  assert.deepEqual([(await card(WORKING)).status, (await card()).note], ['working', '']);
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'node -e 1' } });
  let c = await card(PERMISSION, 500);
  assert.deepEqual([c.status, c.note, c.always && c.always.key], ['attention', 'Claude needs your permission to use Bash: node -e 1', '2']);
  const asked = c.statusAt;
  // The owner allows. Claude Code says nothing until the command ends; the screen shows it working.
  c = await card(WORKING, 3000);
  assert.deepEqual([c.status, c.note, 'always' in c], ['working', '', false]);
  assert.equal(c.statusAt, asked + 3500, 'working since the look that saw it');
  assert.equal((await card(WORKING, 5000)).statusAt, asked + 3500, 'and not later with every look');
  assert.equal(R.readRun(file).status, 'attention', 'the run file is the hooks\' alone');
  // The command ended: the hook says working itself, the card follows the run again.
  hook({ hook_event_name: 'PostToolBatch' });
  c = await card(WORKING, 100);
  assert.deepEqual([c.status, c.note, c.statusAt], ['working', '', R.readRun(file).statusAt]);
  hook({ hook_event_name: 'Stop', last_assistant_message: 'done', background_tasks: [] });
  assert.equal((await card(WAITING, 100)).status, 'waiting');
  R.removeRun(file);
});

test('a card: "No" to the question or Esc ends the turn without an event; the card waits after a few seconds', async () => {
  const { file, hook, card } = deckWith();
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal((await card(PERMISSION)).status, 'attention');
  // A plain message box (no note of Claude Code's above it): believed only once it sat there for a while.
  assert.equal((await card(WAITING, 1000)).status, 'attention', 'first look at the idle screen');
  assert.equal((await card(WAITING, IDLE_MS - 1)).status, 'attention');
  let c = await card(WAITING, 1);
  assert.deepEqual([c.status, c.note], ['waiting', '']);
  // Esc while Claude thinks: the run says working, the screen sits at the message box.
  hook({ hook_event_name: 'UserPromptSubmit' });
  assert.equal((await card(WORKING, 1000)).status, 'working');
  assert.equal((await card(WAITING, 2000)).status, 'working');
  assert.equal((await card(WORKING, 3000)).status, 'working', 'it works again: the idle look was a moment');
  assert.equal((await card(WAITING, 3000)).status, 'working', 'the clock starts over');
  assert.equal((await card(WAITING, IDLE_MS)).status, 'waiting');
  // The owner writes again: the run said "working" all along, so the card's time is when it began to work again.
  const stopped = (await card()).statusAt;
  hook({ hook_event_name: 'UserPromptSubmit' });
  c = await card(WORKING, 5000);
  assert.deepEqual([c.status, c.statusAt], ['working', stopped + 5000]);
  assert.equal((await card(WORKING, 5000)).statusAt, stopped + 5000);
  // Two looks far apart are not "idle all the time between them".
  assert.equal((await card(WAITING, 1000)).status, 'working');
  assert.equal((await card(WAITING, 60_000)).status, 'working');
  assert.equal((await card(WAITING, IDLE_MS)).status, 'waiting');
  R.removeRun(file);
});

test('a card: Esc typed in the terminal at a question is known at the first look, by Claude Code\'s own note', async () => {
  assert.equal(interrupted(INTERRUPTED), true);
  // Esc at the plan's approval (real) and at the question tool (its real note, under the message box).
  assert.equal(interrupted(real('after-plan-esc-80')), true);
  assert.equal(screenLook(real('after-plan-esc-80')), 'idle');
  const declined = ['● Declined to answer Claude\'s questions:', '  ⎿  · Proceed? (Yes, go on / No, stop)', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
  assert.equal(interrupted(declined), true);
  assert.equal(interrupted(declined.replace('Declined to answer', 'Answered')), false);
  assert.equal(interrupted(real('after-plan-esc-80').replace("Rejected Claude's plan:", 'Approved the plan:')), false);
  for (const [name, screen] of Object.entries({ WAITING, PERMISSION, QUESTION, WORKING, empty: '', nothing: null })) assert.equal(interrupted(screen), false, name);
  // A narrow terminal wraps the note.
  assert.equal(interrupted(['  ⎿  Interrupted · What should', '     Claude do instead?', '', '─'.repeat(30), '❯ ', '─'.repeat(30), '  ? for shortcuts'].join('\n')), true);
  // The note further up, with a message after it, is an old turn's.
  assert.equal(interrupted(['  ⎿  Interrupted · What should Claude do instead?', '', '❯ go on', '', '● ok', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n')), false);
  const { file, hook, card } = deckWith();
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'touch b.txt' } });
  assert.equal((await card(PERMISSION, 500)).status, 'attention');
  const c = await card(INTERRUPTED, 200);
  assert.deepEqual([c.status, c.note, R.readRun(file).status], ['waiting', '', 'attention']);
  R.removeRun(file);
});

test('a card: subagents in the background keep it working, and say so', async () => {
  const { file, hook, card } = deckWith();
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'Stop', last_assistant_message: 'Two agents started.', background_tasks: [{ id: 'a1', type: 'subagent' }, { id: 'a2', type: 'subagent' }] });
  let c = await card(BACKGROUND, 1000);
  assert.deepEqual([c.status, c.background], ['working', 2]);
  c = await card(BACKGROUND, 60_000);
  assert.deepEqual([c.status, c.background], ['working', 2], 'an idle main screen is what background work looks like');
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1' });
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a2' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>…' });
  hook({ hook_event_name: 'Stop', background_tasks: [] });
  c = await card(WAITING, 1000);
  assert.deepEqual([c.status, 'background' in c], ['waiting', false]);
  R.removeRun(file);
});

test('one question, one "needs your OK" notification: the reminder and the answer do not announce it again', async () => {
  const { file, hook, card } = deckWith();
  hook({ hook_event_name: 'UserPromptSubmit' });
  let prev = new Map();
  const told = [];
  const look = async (screen, ms) => {
    const { events, next } = transitions(prev, [await card(screen, ms)]);
    prev = next;
    told.push(...events.map((x) => x.status));
  };
  await look(WORKING, 1000);
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  await look(PERMISSION, 1000);
  hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  await look(PERMISSION, 5000);
  await look(PERMISSION, 5000);
  await look(WORKING, 5000); // allowed; the command runs
  await look(WORKING, 5000);
  hook({ hook_event_name: 'PostToolBatch' });
  await look(WORKING, 5000);
  hook({ hook_event_name: 'Stop', background_tasks: [] });
  await look(WAITING, 5000);
  assert.deepEqual(told, ['attention', 'waiting']);
  R.removeRun(file);
});

// AskUserQuestion with boxes to tick, as Claude Code 2.1.326 drew it: a menu, and no message box.
// The question tool with boxes to tick (real, 2.1.326).
const TICK_QUESTION = real('multi-80');

test('a card says what is asked: a permission has answers, a question or a plan is answered in the terminal', async () => {
  const { file, hook, card } = deckWith();
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'node -e 1' } });
  let c = await card(PERMISSION, 500);
  // With its command (the page sends it back with an answer) and how many askers wait (with more, no answer on the page).
  assert.deepEqual([c.status, c.ask, c.always && c.always.key], ['attention', { type: 'permission', what: 'node -e 1', waiting: 1 }, '2']);
  const first = c.askAt;
  assert.equal(first, R.readRun(file).askAt);
  // The second call of the same batch asks: no event between the two but the question itself, so only its time tells
  // the page that this is not the question the owner just answered.
  await card(PERMISSION, 2000);
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'node -e 2' } });
  c = await card(PERMISSION, 100);
  assert.deepEqual([c.status, c.note, c.askAt > first, c.ask], ['attention', 'Claude needs your permission to use Bash: node -e 2', true, { type: 'permission', what: 'node -e 2', waiting: 1 }]);
  // A subagent asks too: two askers wait, and the card says so.
  hook({ hook_event_name: 'PermissionRequest', agent_id: 'a0000000000000001', tool_name: 'Bash', tool_input: { command: 'node -e 3' } });
  c = await card(PERMISSION, 100);
  assert.deepEqual(c.ask, { type: 'permission', what: 'node -e 3', waiting: 2 });
  hook({ hook_event_name: 'PostToolBatch', agent_id: 'a0000000000000001' });
  hook({ hook_event_name: 'PostToolBatch' });
  c = await card(WORKING, 100);
  assert.deepEqual(['ask' in c, 'askAt' in c, 'always' in c], [false, false, false], 'nothing is asked any more');
  // A question to the owner: not a permission, so no "always" answer is read from its menu either.
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which toppings?', multiSelect: true }] } });
  c = await card(TICK_QUESTION, 500);
  assert.deepEqual([c.status, c.note, c.ask, c.always], ['attention', 'Claude asks: Which toppings?', { type: 'question' }, null]);
  hook({ hook_event_name: 'PostToolBatch' });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } });
  assert.deepEqual((await card(TICK_QUESTION, 500)).ask, { type: 'plan' });
  // A notification alone (a session started before Claude Code's settings named the question): the kind is not known.
  hook({ hook_event_name: 'Stop', background_tasks: [] });
  hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  c = await card(PERMISSION, 500);
  assert.deepEqual([c.status, 'ask' in c, c.always && c.always.key], ['attention', false, '2']);
  R.removeRun(file);
});

test('"Do not allow" from the page: the card waits with the next look at the message box, not seconds later', async () => {
  const { file, hook, card, deck } = deckWith();
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal((await card(PERMISSION, 500)).status, 'attention');
  // A plain message box: only the screen tells, so it is believed after it sat idle for a while.
  assert.equal((await card(WAITING, 500)).status, 'attention');
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal((await card(PERMISSION, 500)).status, 'attention');
  // The page's own "Do not allow" (server.mjs: the key route): the refusal is known, the idle screen is its result.
  deck.noteRefused('app', R.readRun(file));
  assert.equal((await card(PERMISSION, 100)).status, 'attention', 'the question is still drawn: nothing to believe yet');
  const c = await card(WAITING, 200);
  assert.deepEqual([c.status, c.note, R.readRun(file).status], ['waiting', '', 'attention']);
  // It holds for that question only: the next one is judged by the screen's own time again.
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal((await card(PERMISSION, 500)).status, 'attention');
  assert.equal((await card(WAITING, 500)).status, 'attention');
  assert.equal((await card(WAITING, IDLE_MS)).status, 'waiting');
  R.removeRun(file);
});

test('a card carries what Hoprig allowed by itself in bypass mode, the newest five; and a plan that still waits after a subagent\'s permission', async () => {
  const { file, hook, card, state } = deckWith();
  const { hookAnswer } = await import('../../src/hook.mjs');
  const facts = { rules: () => [], places: () => ({ home: '/home/alex', workspace: '/home/alex/Workspace', cwd: '/home/alex/Workspace/p', relative: true }) };
  const allow = (command) => {
    const ev = { hook_event_name: 'PermissionRequest', session_id: '88888888-8888-4888-8888-888888888888', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command } };
    applyHook(file, ev, state.now, hookAnswer(ev, facts));
  };
  hook({ hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions' });
  for (let i = 0; i < 7; i++) allow(`rm -rf t${i}/*/*`);
  let c = await card(WORKING, 100);
  assert.deepEqual([c.status, c.allowed.length, c.allowed.at(-1).what, c.allowed[0].what, c.allowed.at(-1).tool], ['working', 5, 'rm -rf t6/*/*', 'rm -rf t2/*/*', 'Bash']);
  // The main agent's plan waits, a subagent asks a permission and gets its answer: the card says "the plan" again.
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } });
  hook({ hook_event_name: 'PermissionRequest', agent_id: 'a1', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } });
  c = await card(real('plan-80'), 100);
  assert.deepEqual([c.status, c.ask, c.always], ['attention', { type: 'plan' }, null]);
  hook({ hook_event_name: 'PostToolBatch', agent_id: 'a1' });
  c = await card(real('plan-80'), 100);
  assert.deepEqual([c.status, c.ask, c.note], ['attention', { type: 'plan' }, 'Claude needs your approval for the plan']);
  R.removeRun(file);
});
