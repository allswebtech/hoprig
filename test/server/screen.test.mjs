// What Claude Code's screen shows it doing (src/server/screen.mjs) and how the deck uses it to correct a card.
// The screens are as Claude Code 2.1.325 drew them in a terminal (tmux capture), with made-up folders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-screen-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { IDLE_MS, screenLook, shownStatus } = await import('../../src/server/screen.mjs');
const { Deck } = await import('../../src/server/deck.mjs');
const { transitions } = await import('../../src/server/watcher.mjs');
const R = await import('../../src/runs.mjs');
const { applyHook } = await import('../../src/hook.mjs');

const RULE = '─'.repeat(100);
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

const PERMISSION = [
  '  A test command',
  '  ⎿  $ node -e "setTimeout(()=>{},40000)"',
  RULE,
  ' Bash command',
  '',
  ' node -e "setTimeout(()=>{},40000)"',
  ' This command requires approval',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don’t ask again for: node *',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   4. No',
  '',
  ' Esc to cancel · Tab to amend',
].map(pad).join('\n');

const QUESTION = [
  '❯ which one',
  RULE,
  ' ☐ Pick',
  '',
  'Which one?',
  '',
  '❯ 1. Alpha',
  '     the first',
  '  2. Beta',
  '     the second',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].map(pad).join('\n');

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

// After "No" to the question, or Esc: the turn is over and no hook event said so.
const INTERRUPTED = [
  '❯ run the long check',
  '',
  '  No result recorded for 1 call',
  '  ⎿  $ node -e "setTimeout(()=>{},40000)"',
  '  ⎿  Interrupted · What should Claude do instead?',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏸ manual mode on · ? for shortcuts',
].map(pad).join('\n');

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
  return { file, hook, card, state };
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
  assert.deepEqual([c.status, c.note, c.always && c.always.key], ['attention', 'Claude needs your permission to use Bash', '2']);
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
  assert.equal((await card(INTERRUPTED, 1000)).status, 'attention', 'first look at the idle screen');
  assert.equal((await card(INTERRUPTED, IDLE_MS - 1)).status, 'attention');
  let c = await card(INTERRUPTED, 1);
  assert.deepEqual([c.status, c.note], ['waiting', '']);
  // Esc while Claude thinks: the run says working, the screen sits at the message box.
  hook({ hook_event_name: 'UserPromptSubmit' });
  assert.equal((await card(WORKING, 1000)).status, 'working');
  assert.equal((await card(INTERRUPTED, 2000)).status, 'working');
  assert.equal((await card(WORKING, 3000)).status, 'working', 'it works again: the idle look was a moment');
  assert.equal((await card(INTERRUPTED, 3000)).status, 'working', 'the clock starts over');
  assert.equal((await card(INTERRUPTED, IDLE_MS)).status, 'waiting');
  // The owner writes again: the run said "working" all along, so the card's time is when it began to work again.
  const stopped = (await card()).statusAt;
  hook({ hook_event_name: 'UserPromptSubmit' });
  c = await card(WORKING, 5000);
  assert.deepEqual([c.status, c.statusAt], ['working', stopped + 5000]);
  assert.equal((await card(WORKING, 5000)).statusAt, stopped + 5000);
  // Two looks far apart are not "idle all the time between them".
  assert.equal((await card(INTERRUPTED, 1000)).status, 'working');
  assert.equal((await card(INTERRUPTED, 60_000)).status, 'working');
  assert.equal((await card(INTERRUPTED, IDLE_MS)).status, 'waiting');
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
