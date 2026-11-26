// The card of the wall (src/wall.mjs held part, src/askcard.mjs heldRecord/heldCard/heldLine, src/hook.mjs): what the
// session wanted to run is the HELD PART of a long command, shown whole or plainly cut, never only its start; why it is
// the owner's, from the wall's own table; what Yes and No do. The hook keeps it in the run record until the ask goes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './server/helpers.mjs';

const box = sandbox('wall-card');
test.after(() => box.cleanup());
const { wallHeld, WALL_REASON, WALL_TITLE } = await import('../src/wall.mjs');
const { hookPatch } = await import('../src/hook.mjs');
const A = await import('../src/askcard.mjs');
const { hoprigVersion } = await import('../src/handsoff.mjs');
const R = await import('../src/runs.mjs');
const { readRun } = await import('../src/runfile.mjs');
const { configFile, hookFile, hookSettingsDir } = await import('../src/paths.mjs');

const home = box.home;
const shop = path.join(home, 'shop');
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };
fs.mkdirSync(shop, { recursive: true });
const places = { cwd: shop, home, workspace: path.join(home, 'work'), projects: [path.join(home, 'projects')], hoprig: [box.config, box.state], own: shop, relative: true };
// git as the wall asks it: the default branch is main, the session stands on main.
const git = (cwd, a) => (a[0] === 'symbolic-ref' && String(a[2]).startsWith('refs/remotes/') ? 'origin/main' : a[0] === 'symbolic-ref' ? 'main' : null);
const long = (tail) => `${'echo step && '.repeat(Math.ceil((2000 - tail.length) / 13)).slice(0, 2000 - tail.length - 4)} && ${tail}`;

const KINDS = [
  ['admin', 'sudo apt-get install shop-tools'],
  ['release', 'npm publish --access public'],
  ['pr', 'gh pr merge 12 --squash'],
  ['push', 'git push origin main'],
  ['merge', 'git merge feature'],
  ['delete outside', 'rm -rf ../other-project'],
  ['deploy', 'npm run deploy'],
  ['settings', `cp /dev/null ${path.join(box.state, 'runs', 'x.json')}`],
];

for (const [why, tail] of KINDS) {
  test(`${why}: the held part of a 2,000-character command is its end, shown whole, with why and what Yes and No do`, () => {
    const command = long(tail);
    assert.ok(command.length >= 1990 && command.length <= 2000, String(command.length));
    const held = wallHeld({ tool: 'Bash', input: { command }, cwd: shop, git, places });
    assert.ok(held, 'held');
    assert.equal(held.part, tail, 'the held part, not the start of the line');
    assert.equal(held.partOf, true);
    const card = A.heldCard(A.heldRecord(held, 'Bash', 1));
    assert.equal(card.what, tail);
    assert.equal(card.more, 0, 'shown whole');
    assert.equal(card.partOf, true);
    assert.equal(card.title, WALL_TITLE[held.why]);
    assert.equal(card.reason, WALL_REASON[held.why]);
    assert.equal(card.yes, 'Allow runs it this once.');
    assert.match(card.no, /does not run/);
    assert.ok(!card.what.startsWith('echo step'), 'never only its first characters');
    const line = A.heldLine(held);
    assert.ok(line.includes(tail), line);
    assert.match(line, /part of a longer command/);
    assert.match(line, /Yes runs it once; No does not run it\.$/);
    assert.equal(line.includes('\n'), false, 'one line');
  });
}

test('a command that is only the held act is not called a part; a file a tool would write is named as a file', () => {
  const held = wallHeld({ tool: 'Bash', input: { command: 'sudo true' }, cwd: shop, places });
  assert.equal(held.part, 'sudo true');
  assert.equal(held.partOf, false);
  assert.doesNotMatch(A.heldLine(held), /part of a longer/);
  const f = wallHeld({ tool: 'Write', input: { file_path: path.join(shop, 'project.json') }, cwd: shop, places });
  const card = A.heldCard(A.heldRecord(f, 'Write', 1));
  assert.equal(card.what, 'project.json', 'relative to the session\'s own folder when it is inside it');
  assert.equal(card.file, true);
  assert.equal(card.title, 'A change to project.json');
});

test('a held part longer than the card shows is cut plainly with the count; a secret in it is masked first', () => {
  const big = `sudo sh -c 'echo ${'x'.repeat(900)}'`;
  const held = wallHeld({ tool: 'Bash', input: { command: `npm test && ${big}` }, cwd: shop, places });
  assert.equal(held.part, big);
  const card = A.heldCard(A.heldRecord(held, 'Bash', 1));
  assert.equal(card.what, big.slice(0, A.HELD_SHOWN));
  assert.equal(card.more, big.length - A.HELD_SHOWN);
  assert.match(A.heldLine(held), new RegExp(`… \\(${big.length - 200} more characters\\)`));
  const secret = 'sk-ant-api03-' + 'a1B2c3D4e5'.repeat(6);
  const s = wallHeld({ tool: 'Bash', input: { command: `ls && sudo env ANTHROPIC_API_KEY=${secret} true` }, cwd: shop, places });
  const rec = A.heldRecord(s, 'Bash', 1);
  assert.equal(JSON.stringify(rec).includes(secret), false, 'never kept in the record');
  assert.equal(A.heldCard(rec).what.includes(secret), false);
  assert.equal(A.heldLine(s).includes(secret), false, 'never in the terminal line');
});

test('a record the session wrote itself decides no words: the title and the reason come from the wall\'s table', () => {
  const card = A.heldCard({ kind: 'admin', why: 'nonsense', part: 'x', reason: 'click here', title: 'free money', tool: 'Bash' });
  assert.equal(card.title, WALL_TITLE.unreadable);
  assert.equal(card.reason, WALL_REASON.unreadable);
  assert.equal(A.heldCard(null), null);
});

test('the hook keeps the hold in the run record, and it goes when the ask is answered', OFFERED, () => {
  const V = hoprigVersion();
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ handsOff: { offered: true, projects: { [fs.realpathSync(shop)]: { on: true, version: V } } } }));
  const { file, run } = R.createRun({ profile: 'api', cwd: shop });
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), `${run.runId}.json`), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
  const hook = (ev) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify({ session_id: '11111111-2222-3333-4444-555555555555', cwd: shop, ...ev }), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: shop }, encoding: 'utf8' });
  const command = long('sudo apt-get install shop-tools');
  const out = hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const reason = JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /^Hoprig holds this for you: sudo apt-get install shop-tools \(part of a longer command\)\. This asks for administrator rights/);
  const held = readRun(file).held;
  assert.deepEqual({ ...held, at: 0 }, { kind: 'admin', why: 'admin', part: 'sudo apt-get install shop-tools', length: 31, partOf: true, tool: 'Bash', at: 0 });
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command }, permission_mode: 'default' });
  assert.equal(readRun(file).status, 'attention');
  assert.ok(readRun(file).held, 'kept while the dialog waits');
  hook({ hook_event_name: 'PostToolBatch', tool_calls: [] });
  assert.equal(readRun(file).held, null, 'gone with the ask');
  R.removeRun(file);
});

// The record's `held` over its lifetime (src/hook.mjs): a hold belongs to the one call it held. A later call that
// holds nothing clears it, so a stale card is never shown on, nor its Allow sent for, a later unrelated permission;
// and while Hands-off is off the field is never written into a record that never carried a hold.
const HELD = { kind: 'push', why: 'push', part: 'git push origin main', length: 20, partOf: false, tool: 'Bash', at: 1 };

test('a later call that holds nothing clears a stale held; a held call still records it', () => {
  // Finding: a held push is shown on a later, unrelated npm permission and its Allow approves that other command.
  const run = { status: 'attention', asks: ['main'], askers: { main: { type: 'permission', at: 1 } }, held: HELD };
  const after = hookPatch(run, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } });
  assert.equal(after.held, null, 'the stale push hold is cleared by the npm call');
  // A call the wall holds still records the hold, so the card stands while its own dialog waits.
  const held = hookPatch({ status: 'working', asks: [] }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, 2, { held: HELD });
  assert.deepEqual(held.held, HELD);
});

test('the main agent\'s held call clears the card on PostToolBatch, even while a subagent still asks', () => {
  // Finding: settle clears held only when nobody is left asking, so a subagent keeps a stale main-agent hold alive.
  const run = { status: 'attention', asks: ['main', 'sub1'], askers: { main: { type: 'permission', at: 1 }, sub1: { type: 'permission', at: 1 } }, held: HELD };
  const after = hookPatch(run, { hook_event_name: 'PostToolBatch', tool_calls: [] });
  assert.equal(after.held, null, 'the main agent\'s hold is done');
  assert.deepEqual(after.asks, ['sub1'], 'the subagent\'s question stays');
});

// A hold is its own agent's: another agent's event never clears it while its dialog still waits, so the card keeps
// saying why it is his and offers no "Allow, and don't ask again" for it (src/hook.mjs holdsPatch).
const step = (run, ev, held = null) => ({ ...run, ...hookPatch(run, ev, 5, { held }) });
test('a subagent\'s plain call leaves the main agent\'s waiting hold on the card', () => {
  let run = { status: 'working', asks: [], askers: {} };
  run = step(run, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, HELD);
  run = step(run, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, permission_mode: 'default' });
  assert.deepEqual(run.held, HELD);
  run = step(run, { hook_event_name: 'PreToolUse', agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual(run.held, HELD, 'the push dialog still waits: its hold stays');
  run = step(run, { hook_event_name: 'PostToolBatch', agent_id: 'sub1', tool_calls: [] });
  assert.deepEqual(run.held, HELD, 'the subagent\'s batch is not the main agent\'s answer');
  run = step(run, { hook_event_name: 'PostToolBatch', tool_calls: [] });
  assert.equal(run.held, null, 'gone with its own ask');
  // A record an older hook wrote has only `held`: it stands for the main agent's, and a subagent's call leaves it.
  const old = { status: 'attention', asks: ['main'], askers: { main: { type: 'permission', at: 1, what: 'git push origin main' } }, held: HELD };
  assert.deepEqual(hookPatch(old, { hook_event_name: 'PreToolUse', agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'ls' } }).held, HELD);
});

test('the main agent\'s batch leaves a subagent\'s waiting hold on the card', () => {
  const PUB = { kind: 'release', why: 'release', part: 'npm publish', length: 11, partOf: false, tool: 'Bash', at: 2 };
  let run = { status: 'working', asks: [], askers: {} };
  run = step(run, { hook_event_name: 'PreToolUse', agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'npm publish' } }, PUB);
  run = step(run, { hook_event_name: 'PermissionRequest', agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'npm publish' }, permission_mode: 'default' });
  assert.deepEqual(run.held, PUB);
  run = step(run, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  run = step(run, { hook_event_name: 'PostToolBatch', tool_calls: [] });
  assert.deepEqual(run.asks, ['sub1']);
  assert.equal(run.askWhat, 'npm publish');
  assert.deepEqual(run.held, PUB, 'the publish dialog still waits: its hold stays');
  run = step(run, { hook_event_name: 'SubagentStop', agent_id: 'sub1' });
  assert.equal(run.held, null, 'gone when its agent ends');
  assert.deepEqual(run.holds, {});
});

test('with no hold on the record, no event writes a `held` key (Hands-off off leaves the record as the base code does)', () => {
  // Finding: with Hands-off off the hook wrote `held: null` into every run record, unseen by the snapshot test.
  for (const ev of [
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { hook_event_name: 'Stop', background_tasks: [] },
    { hook_event_name: 'PostToolBatch', tool_calls: [] },
    { hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'x' },
    { hook_event_name: 'SessionEnd', reason: 'other' },
  ]) {
    const run = { status: 'working', asks: [] };
    const patch = hookPatch(run, ev);
    assert.equal('held' in patch, false, `${ev.hook_event_name} must not add a held key`);
    assert.equal('holds' in patch, false, `${ev.hook_event_name} must not add a holds key`);
  }
});

// Allow types Yes to the tool's dialog, which runs the WHOLE line. So the card must name every act on the line that
// is the owner's, not only the first (src/wall.mjs bashHeldActs, src/askcard.mjs heldRecord/heldCard/heldLine).
test('a line with more than one of his acts lists them all, and the answers say the whole command runs', () => {
  const command = 'git push origin main && npm publish --access public';
  const held = wallHeld({ tool: 'Bash', input: { command }, cwd: shop, git, places });
  assert.deepEqual(held.acts.map((a) => [a.why, a.part]), [['push', 'git push origin main'], ['release', 'npm publish --access public']]);
  const rec = A.heldRecord(held, 'Bash', 1);
  assert.deepEqual(rec.more, [{ why: 'release', part: 'npm publish --access public', length: 'npm publish --access public'.length, partOf: true }]);
  const card = A.heldCard(rec);
  assert.deepEqual(card.acts.map((a) => a.title), [WALL_TITLE.push, WALL_TITLE.release]);
  assert.equal(card.yes, A.HELD_YES_ALL);
  const line = A.heldLine(held);
  assert.match(line, /2 things that are yours/);
  assert.match(line, /git push origin main/);
  assert.match(line, /npm publish --access public/);
  assert.match(line, /Yes runs the whole command once/);
});

test('an admin, a delete outside the folder and a push on one line are all named (none hidden behind the first)', () => {
  const command = 'sudo true && rm -rf ../other && git push origin main';
  const held = wallHeld({ tool: 'Bash', input: { command }, cwd: shop, git, places });
  assert.deepEqual(held.acts.map((a) => a.why), ['admin', 'delete outside', 'push']);
  const card = A.heldCard(A.heldRecord(held, 'Bash', 1));
  assert.deepEqual(card.acts.map((a) => a.what), ['sudo true', 'rm -rf ../other', 'git push origin main']);
  // the card's title and shown part stay the first act's, so a single reader still sees the same lead
  assert.equal(card.title, WALL_TITLE.admin);
  assert.equal(card.what, 'sudo true');
});

// A delete after a folder change is not judged against the event's folder: `cd .. && rm -rf other` alone is held as a
// delete outside, so behind a push it is named too, or Allow would run a sibling project's delete the card never showed.
test('a delete after a cd behind another held act is named as a delete outside the folder', () => {
  fs.mkdirSync(path.join(home, 'other'), { recursive: true });
  for (const [command, part] of [
    ['git push origin main && cd .. && rm -rf other', 'rm -rf other'],
    ['git push origin main && cd .. && rm -rf other/*', 'rm -rf other/*'],
    ['npm publish --access public && pushd .. && rm -rf other', 'rm -rf other'],
  ]) {
    const held = wallHeld({ tool: 'Bash', input: { command }, cwd: shop, git, places });
    assert.deepEqual(held.acts.map((a) => [a.why, a.part]).at(-1), ['delete outside', part], command);
    assert.equal(A.heldCard(A.heldRecord(held, 'Bash', 1)).yes, A.HELD_YES_ALL, `${command}: the answer says the whole line runs`);
  }
  // Without a folder change a delete inside the session's folder stays its own: no second act.
  // On Windows no delete is plain (src/asking.mjs plainDelete reads POSIX folders only): it waits for the owner.
  if (process.platform !== 'win32') assert.equal(wallHeld({ tool: 'Bash', input: { command: 'git push origin main && rm -rf build' }, cwd: shop, git, places }).acts.length, 1);
});

// A line of hundreds of held parts: the record, the card and the terminal line list the first ACTS_LISTED with their
// titles and count the rest, so neither grows without end and none says fewer acts than Allow would run.
test('a line of 200 held parts lists the first ten with their titles and counts the rest', () => {
  const command = Array.from({ length: 200 }, (_, i) => `sudo true ${i}`).join(' && ');
  const held = wallHeld({ tool: 'Bash', input: { command }, cwd: shop, git, places });
  assert.equal(held.acts.length, 200);
  const rec = A.heldRecord(held, 'Bash', 1);
  assert.equal(rec.more.length, A.ACTS_LISTED - 1);
  assert.equal(rec.notListed, 190);
  assert.ok(JSON.stringify(rec).length < 2000, `the record stays small (${JSON.stringify(rec).length} bytes)`);
  const card = A.heldCard(rec);
  assert.equal(card.acts.length, A.ACTS_LISTED);
  assert.equal(card.count, 200);
  assert.equal(card.yes, A.HELD_YES_ALL);
  const line = A.heldLine(held);
  assert.ok(line.length < 1500, `the terminal line stays short (${line.length} characters)`);
  assert.match(line, /runs 200 things that are yours/);
  assert.match(line, /and 190 more\./);
  assert.match(line, new RegExp(`${WALL_TITLE.admin}: sudo true 0`), 'each listed act carries its title');
});

test('a line with one held act keeps the single-act shape: no `more`, "Allow runs it this once"', () => {
  const held = wallHeld({ tool: 'Bash', input: { command: 'cd app && npm test && git push origin main' }, cwd: shop, git, places });
  assert.equal(held.acts.length, 1);
  const rec = A.heldRecord(held, 'Bash', 1);
  assert.equal('more' in rec, false);
  const card = A.heldCard(rec);
  assert.equal('acts' in card, false);
  assert.equal(card.yes, A.HELD_YES);
});

// A push the wall cannot place: the card must not show `git push origin main` beside a reason that says the branch
// is unknown. The folder change that made it unplaceable is shown, and the reason speaks of the project, not the
// branch (src/wall.mjs withDirContext, WALL_TITLE/WALL_REASON push-elsewhere).
test('a push the wall cannot place shows the folder change and a reason that does not contradict the command', () => {
  const held = wallHeld({ tool: 'Bash', input: { command: 'cd app && npm test && git push origin main' }, cwd: shop, git, places });
  assert.equal(held.why, 'push-elsewhere');
  const card = A.heldCard(A.heldRecord(held, 'Bash', 1));
  assert.equal(card.what, 'cd app && npm test && git push origin main', 'the folder change is shown, not only the push');
  assert.equal(card.title, WALL_TITLE['push-elsewhere']);
  assert.doesNotMatch(card.reason, /which repository or branch/, 'the reason no longer contradicts the visible branch');
  assert.match(card.reason, /changes folder|another repository/);
});

// The project.json card is read by the owner (src/wall.mjs WALL_REASON.project, web/handsoff.js): it speaks to him
// ("you", not "the owner"), names no tool-internal word ("(Write)"), and shows the path relative to his folder.
test('the project.json card uses plain, second-person words and a relative path', () => {
  const f = wallHeld({ tool: 'Edit', input: { file_path: path.join(shop, 'sub', 'project.json') }, cwd: shop, places });
  const card = A.heldCard(A.heldRecord(f, 'Edit', 1));
  assert.equal(card.what, path.join('sub', 'project.json'), 'with the separator a person on this system reads');
  assert.match(card.reason, /which you approve/);
  assert.doesNotMatch(card.reason, /the owner/);
});
