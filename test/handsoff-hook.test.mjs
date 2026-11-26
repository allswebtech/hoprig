// Hands-off in a terminal session, through the hook (src/hook.mjs handsOffFor and the hook program): the answer goes
// as Claude Code 2.1.327 takes it (the question's input with `answers`), it is shown and logged, a sign or a missing
// mark waits, a plan in a terminal waits, three answers with no work between them stop it, the owner's stop holds
// at the moment of the answer, and with the switch off nothing of it runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Its real path: the dashboard stores a project's switch under the real path (macOS: /var is a link to /private/var).
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-handsoff-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered: the wall's hold is a POSIX shell test), so a
// test that switches it on and expects an answer or a hold has nothing to see there.
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };

const { cardFor, handsOffFor, handsOffKeys, hookPatch, preToolHold } = await import('../src/hook.mjs');
const { decide, hoprigVersion } = await import('../src/handsoff.mjs');
const { cardOf } = await import('../src/askcard.mjs');
const { readRun, writeRun } = await import('../src/runfile.mjs');
const R = await import('../src/runs.mjs');
const { configFile, hookFile, hookSettingsDir, stateDir } = await import('../src/paths.mjs');
// A launched Hands-off session always carries the wall's PreToolUse hold in its handed settings (launch.mjs). These
// synthetic runs are not launched, so give them that precondition: without it the hook answers nothing (a session
// with no hold could answer a question but never hold an act, so Hands-off must not answer for it).
const giveHold = (file) => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), path.basename(file)), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
};

const V = hoprigVersion();
const SHOP = path.join(tmp, 'shop');
fs.mkdirSync(SHOP, { recursive: true });
const ask = (questions, o = {}) => ({ hook_event_name: 'PermissionRequest', session_id: '77777777-7777-4777-8777-777777777777', permission_mode: 'default', cwd: SHOP, tool_name: 'AskUserQuestion', tool_input: { questions }, ...o });
const q = (question, labels, multi = false) => ({ question, header: 'Choice', multiSelect: multi, options: labels.map((label) => ({ label, description: `About ${label}` })) });
const REC = ask([q('Which test runner should this project use?', ['node:test (Recommended)', 'vitest', 'jest'])]);
const on = (o = {}) => ({ handsOff: { offered: true, projects: { [SHOP]: { on: true, version: V, ...o } } } });
const writeCfg = (cfg) => {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg));
};
const hook = (file, ev) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(ev), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });
const activity = () => {
  try {
    return fs.readFileSync(path.join(stateDir(), 'automation.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

test('off (the default): no answer, the card is the tool\'s own data, nothing of Hands-off is written', () => {
  const run = { cwd: SHOP, status: 'working' };
  assert.equal(handsOffFor(REC, run, { cfg: {}, version: V }), null);
  const p = hookPatch(run, REC, 1000);
  assert.equal(p.status, 'attention');
  assert.deepEqual(p.askCard.questions[0].options.map((o) => o.label), ['node:test (Recommended)', 'vitest', 'jest']);
  assert.equal(p.askCard.questions[0].recommended, 0);
  assert.equal(p.handsWait, null);
  for (const k of ['handsOffDone', 'handsOffRow', 'handsOffStop']) assert.equal(k in p, false, k);
});

test('offered:false (the owner hid the feature): every switch on but no answer is ever given, the card is still exact', () => {
  // The project switch and the session's own switch are both on; handsOff.offered is the exact boolean false.
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  const { runId } = readRun(file);
  writeCfg({ handsOff: { offered: false, projects: { [SHOP]: { on: true, version: V } }, sessions: { [runId]: { on: true, version: V, at: Date.now() } } } });
  const before = activity().length;
  assert.equal(hook(file, REC).stdout, '', 'no answer while Hands-off is hidden');
  const run = readRun(file);
  assert.equal(run.status, 'attention');
  for (const k of ['handsOffDone', 'handsOffRow', 'handsOffStop']) assert.equal(k in run, false, k);
  assert.equal(activity().length, before, 'nothing in Activity');
  // Part 1 does not depend on the switch: the card is still the tool's own data.
  assert.deepEqual(run.askCard.questions[0].options.map((o) => o.label), ['node:test (Recommended)', 'vitest', 'jest']);
  assert.equal(handsOffFor(REC, run, { cfg: JSON.parse(fs.readFileSync(configFile(), 'utf8')), version: V, runId, project: SHOP }), null);
  R.removeRun(file);
});

test('on: the recommended option is given the way Claude Code takes it, shown on the session and one line in Activity', OFFERED, () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  const before = activity().length;
  const r = hook(file, REC);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(out.hookSpecificOutput.decision.updatedInput.answers, { 'Which test runner should this project use?': 'node:test (Recommended)' });
  assert.deepEqual(out.hookSpecificOutput.decision.updatedInput.questions, REC.tool_input.questions, 'the questions go back as the tool gave them');
  const run = readRun(file);
  assert.notEqual(run.status, 'attention', 'nobody is asked');
  assert.equal(run.handsOffDone.length, 1);
  assert.deepEqual([run.handsOffDone[0].text, run.handsOffDone[0].because], ['node:test (Recommended)', 'recommended']);
  const log = activity().slice(before);
  assert.equal(log.length, 1);
  assert.equal(log[0].automation, 'handsoff');
  assert.match(log[0].did, /answered "Which test runner should this project use\?" with "node:test \(Recommended\)" for you, because the tool recommended it/);
  R.removeRun(file);
});

test('on: no mark waits; the note is the free-text answer; a sign waits even with the mark; a permission is untouched', OFFERED, () => {
  writeCfg(on({ note: 'Choose the option with the fewest dependencies.' }));
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  let r = hook(file, ask([q('Which checks should run before each commit?', ['Lint', 'Tests'], true)]));
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.decision.updatedInput.answers, { 'Which checks should run before each commit?': 'Choose the option with the fewest dependencies.' });
  assert.equal(readRun(file).handsOffDone.at(-1).because, 'note');
  r = hook(file, ask([q('Should I push the branch to origin now?', ['Yes (Recommended)', 'No'])]));
  assert.equal(r.stdout, '', 'the owner\'s alone: no answer');
  assert.deepEqual([readRun(file).status, readRun(file).handsWait], ['attention', 'owner:push or merge']);
  // A permission in the default mode: the mode's own rules, nothing from Hands-off.
  r = hook(file, { ...REC, tool_name: 'Bash', tool_input: { command: 'touch b.txt' } });
  assert.equal(r.stdout, '');
  assert.equal(readRun(file).handsWait, null);
  writeCfg(on());
  r = hook(file, ask([q('Which name do you prefer?', ['alpha', 'beta'])]));
  assert.equal(r.stdout, '');
  assert.equal(readRun(file).handsWait, 'no-mark');
  R.removeRun(file);
});

test('a plan in a terminal waits: Claude Code 2.1.327 draws its plan dialog although the hook allowed it', OFFERED, () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  const r = hook(file, { ...REC, permission_mode: 'plan', tool_name: 'ExitPlanMode', tool_input: { plan: 'Plan: add NOTES.md' } });
  assert.equal(r.stdout, '');
  assert.deepEqual([readRun(file).askType, readRun(file).askCard.plan, readRun(file).handsWait], ['plan', 'Plan: add NOTES.md', 'plan-terminal']);
  R.removeRun(file);
});

test('three answers with no work between them: a loop, the session becomes the owner\'s and says so', OFFERED, () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  for (let i = 0; i < 3; i++) {
    assert.notEqual(hook(file, REC).stdout, '', `answer ${i + 1}`);
    hook(file, { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'AskUserQuestion', tool_input: {} }] });
  }
  assert.equal(hook(file, REC).stdout, '', 'the fourth waits');
  assert.deepEqual([readRun(file).handsOffStop, readRun(file).handsWait], ['loop', 'loop']);
  // The stop holds after work, until the owner turns it on again for the session.
  hook(file, { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'ls' } }] });
  assert.equal(hook(file, REC).stdout, '');
  R.removeRun(file);
});

test('work between the answers (a tool call, a message of the owner) starts the count again', OFFERED, () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  for (let i = 0; i < 5; i++) {
    assert.notEqual(hook(file, REC).stdout, '', `answer ${i + 1}`);
    hook(file, { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'AskUserQuestion' }, { tool_name: 'Write', tool_input: { file_path: 'a' } }] });
  }
  assert.equal(readRun(file).handsOffRow, 0);
  for (let i = 0; i < 2; i++) hook(file, REC);
  hook(file, { hook_event_name: 'UserPromptSubmit' });
  assert.equal(readRun(file).handsOffRow, 0);
  R.removeRun(file);
});

test('the stop: the session\'s own switch off wins over the project\'s, and is read again at the moment of the answer', () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  const { runId } = readRun(file);
  const own = (o) => ({ handsOff: { ...on().handsOff, sessions: { [runId]: { version: V, at: 1, ...o } } } });
  // The session's own switch off (Hoprig's config, under its run id) wins over the project's on.
  writeCfg(own({ on: false }));
  assert.equal(hook(file, REC).stdout, '');
  assert.equal(readRun(file).status, 'attention');
  // A switch turned on under another version is off.
  writeCfg(own({ on: true, version: '0.0.1' }));
  assert.equal(hook(file, REC).stdout, '');
  writeCfg({ handsOff: { offered: true, projects: { [SHOP]: { on: true, version: '0.0.1' } } } });
  assert.equal(hook(file, REC).stdout, '', 'turned off by the update');
  R.removeRun(file);
});

test('a coding chat\'s record is never answered by the hook: the chat answers through its own channel', () => {
  assert.equal(handsOffFor(REC, { kind: 'chat', cwd: SHOP }, { cfg: on(), version: V }), null);
});

test('an API error after a question: the old question\'s card and its Hands-off words go, the error is what shows', () => {
  let run = { cwd: SHOP, status: 'working' };
  run = { ...run, ...hookPatch(run, { ...REC, agent_id: 'agent-1' }, 1000) };
  assert.equal(run.askCard.kind, 'question');
  run = { ...run, handsWait: 'no-mark' };
  const p = hookPatch(run, { hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: 500 Internal server error' }, 2000);
  assert.deepEqual([p.status, p.asks, p.askCard, p.handsWait, p.note], ['attention', [], null, null, 'API Error: 500 Internal server error']);
  const end = hookPatch(run, { hook_event_name: 'SessionEnd', reason: 'other' }, 3000);
  assert.deepEqual([end.askCard, end.handsWait], [null, null]);
});

test('a secret in a question\'s words never reaches the card, the record or Activity, and Hands-off leaves it to the owner', OFFERED, () => {
  writeCfg(on());
  const KEY = `ghp_${'a1B2c3D4e5'.repeat(3)}`; // made up, in the shape of a GitHub token
  const ev = ask([{ question: `Use ${KEY} for the CI job?`, header: 'Key', multiSelect: false, options: [{ label: 'Use it (Recommended)', description: `Writes ${KEY} into the settings.` }, { label: 'Make a new one', description: '' }] }]);
  const c = cardFor(ev);
  assert.equal(JSON.stringify(c).includes(KEY), false, 'the card holds no secret');
  assert.match(c.questions[0].question, /\*\*\*/);
  assert.equal(c.masked, true);
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  const before = activity().length;
  assert.equal(hook(file, ev).stdout, '', 'no answer for an ask that holds a secret');
  const run = readRun(file);
  assert.equal(run.handsWait, 'secret');
  assert.equal(JSON.stringify(run).includes(KEY), false, 'the record holds no secret');
  assert.equal(JSON.stringify(activity().slice(before)).includes(KEY), false);
  // The same for a plan, and for a chat's card (the App's channel).
  const p = cardOf({ tool: 'ExitPlanMode', input: { plan: `1. Export TOKEN=${KEY}` } });
  assert.deepEqual([p.plan.includes(KEY), decide(p).wait], [false, 'secret']);
  R.removeRun(file);
});

test('a command of the session that writes its own run record cannot turn Hands-off on or off', () => {
  // Any Bash call of the session finds its record through $HOPRIG_RUN_FILE and the version in package.json.
  writeCfg({ handsOff: { offered: true } }); // offered, but no switch anywhere: the record's own switch must not count
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  writeRun(file, { ...readRun(file), handsOff: { on: true, version: V, at: Date.now() } });
  const before = activity().length;
  assert.equal(hook(file, REC).stdout, '', 'no answer: the switch in the record is not read');
  assert.equal(readRun(file).status, 'attention');
  assert.equal(activity().length, before, 'nothing in Activity');
  // Nor can it keep answering after the owner's stop on its page, which is not kept in the record.
  const { runId } = readRun(file);
  writeCfg({ handsOff: { ...on().handsOff, sessions: { [runId]: { on: false, version: V, at: Date.now() } } } });
  writeRun(file, { ...readRun(file), handsOff: { on: true, version: V, at: Date.now() + 1000 } });
  assert.equal(hook(file, REC).stdout, '');
  R.removeRun(file);
});

test('a command of the session that writes another run id or folder into its record borrows no other switch', () => {
  const OTHER = path.join(tmp, 'other');
  fs.mkdirSync(OTHER, { recursive: true });
  // The project the session runs in has no switch; another project's is on.
  writeCfg({ handsOff: { offered: true, projects: { [OTHER]: { on: true, version: V, at: 1 } } } });
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  assert.equal(hook(file, REC).stdout, '');
  writeRun(file, { ...readRun(file), cwd: OTHER });
  assert.equal(hook(file, REC).stdout, '', 'the folder Claude Code runs for counts, not the cwd in the record');
  // The owner stopped this session while another session's own switch is on.
  const other = R.createRun({ profile: 'api', cwd: SHOP });
  const mine = readRun(file).runId;
  writeCfg({ handsOff: { offered: true, sessions: { [other.run.runId]: { on: true, version: V, at: Date.now() }, [mine]: { on: false, version: V, at: Date.now() } } } });
  assert.equal(hook(file, REC).stdout, '');
  writeRun(file, { ...readRun(file), runId: other.run.runId });
  assert.equal(hook(file, REC).stdout, '', 'the run id is the record\'s file name, not what the record says');
  // The keys come from what Claude Code hands the hook; without its project folder only the session's own switch counts.
  assert.deepEqual(handsOffKeys(file, { CLAUDE_PROJECT_DIR: SHOP }), { runId: mine, project: fs.realpathSync(SHOP) });
  assert.deepEqual(handsOffKeys(file, {}), { runId: mine, project: null });
  R.removeRun(file);
  R.removeRun(other.file);
});

test('a relaunch on the same run record (a move to another provider) keeps the session\'s own stop and the loop\'s stop', () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  const { runId } = readRun(file);
  // The owner stopped Hands-off on this session while the project's switch is on; a loop stop and count in the record.
  writeCfg({ handsOff: { ...on().handsOff, sessions: { [runId]: { on: false, version: V, at: Date.now() } } } });
  writeRun(file, { ...readRun(file), handsOffStop: 'loop', handsOffRow: 2 });
  R.createRun({ profile: 'other', cwd: SHOP, file });
  const again = readRun(file);
  assert.deepEqual([again.runId, again.profile, again.handsOffStop, again.handsOffRow], [runId, 'other', 'loop', 2]);
  assert.equal(handsOffFor(REC, again, { cfg: JSON.parse(fs.readFileSync(configFile(), 'utf8')), version: V, runId, project: SHOP }), null, 'still stopped');
  writeCfg(on());
  assert.equal(handsOffFor(REC, again, { cfg: on(), version: V, runId, project: SHOP }), null, 'the loop stop holds after the move');
  R.removeRun(file);
});

test('a move to another provider after the hour\'s stop keeps the stop and the answers the hour is counted from', OFFERED, () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  const now = Date.now();
  const done = Array.from({ length: 10 }, (_, i) => ({ at: now - 60_000 + i, kind: 'question', question: 'Which colour?', text: 'A (Recommended)', because: 'recommended' }));
  writeRun(file, { ...readRun(file), handsOffStop: 'hour', handsOffDone: done });
  R.createRun({ profile: 'other', cwd: SHOP, file });
  const again = readRun(file);
  assert.deepEqual([again.profile, again.handsOffStop, again.handsOffDone], ['other', 'hour', done]);
  assert.equal(hook(file, REC).stdout, '', 'no answer after the move');
  // Without the stop the answers alone still fill the hour.
  writeRun(file, { ...readRun(file), handsOffStop: null });
  R.createRun({ profile: 'api', cwd: SHOP, file });
  assert.equal(readRun(file).handsOffDone.length, 10);
  assert.equal(hook(file, REC).stdout, '');
  assert.equal(readRun(file).handsOffStop, 'hour');
  R.removeRun(file);
});

test('a read or a search between asks is no work, and ten answers within an hour stop it whatever comes between', OFFERED, () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  // An ask, then a batch with one Read: the count goes on, the fourth ask is the loop's.
  for (let i = 0; i < 3; i++) {
    assert.notEqual(hook(file, REC).stdout, '', `answer ${i + 1}`);
    hook(file, { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'AskUserQuestion' }, { tool_name: 'Read', tool_input: { file_path: 'a' }, tool_response: 'x' }] });
  }
  assert.equal(hook(file, REC).stdout, '', 'a Read between them is no work');
  assert.equal(readRun(file).handsOffStop, 'loop');
  // A command that failed is no work either.
  let run = { cwd: SHOP, status: 'working', handsOffRow: 2 };
  const failed = hookPatch(run, { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { is_error: true } }] }, 1000);
  assert.equal(failed.handsOffRow, undefined);
  assert.equal(hookPatch(run, { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'Edit', tool_response: { filePath: 'a' } }] }, 1000).handsOffRow, 0);
  // Real work after every answer: still at most ten within an hour.
  const t0 = 10_000_000;
  run = { cwd: SHOP, status: 'working', asks: [], askers: {} };
  let answered = 0;
  for (let i = 0; i < 15; i++) {
    const h = handsOffFor(REC, run, { cfg: on(), version: V, now: t0 + i * 60_000, project: SHOP });
    if (h && h.output) answered++;
    run = { ...run, ...hookPatch(run, REC, t0 + i * 60_000, { hands: h }) };
    run = { ...run, ...hookPatch(run, { hook_event_name: 'PostToolBatch', tool_calls: [{ tool_name: 'Write', tool_response: { type: 'create' } }] }, t0 + i * 60_000 + 1) };
  }
  assert.equal(answered, 10);
  assert.equal(run.handsOffStop, 'hour');
  R.removeRun(file);
});

test('handsOffKeys resolves CLAUDE_PROJECT_DIR through a symlink to the real path the switch is stored under', () => {
  const real = fs.realpathSync(SHOP);
  const link = path.join(tmp, 'shop-via-link');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(real, link);
  // The switch is stored under the folder's real path (server insideRoots → realpathSync); a linked spelling must find it.
  assert.equal(handsOffKeys('r.json', { CLAUDE_PROJECT_DIR: link }).project, real);
  // A path that cannot be resolved falls back to a normalised one, never null.
  assert.equal(handsOffKeys('r.json', { CLAUDE_PROJECT_DIR: '/no/such/dir/./here' }).project, path.normalize('/no/such/dir/./here'));
});

test('the wall holds even when the run record is gone: deleting its own record cannot switch the wall off', OFFERED, () => {
  // A session that moves or deletes $HOPRIG_RUN_FILE leaves `run` null. The switch is read from the config, not the
  // record, so a held act is still held and only an ordinary command goes through.
  const cfg = on();
  const pre = (command, run = null) => preToolHold({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: SHOP }, run, { cfg, version: V, project: SHOP });
  assert.equal(pre('sudo true').output.hookSpecificOutput.permissionDecision, 'ask', 'held with no record');
  assert.equal(pre('npm test'), null, 'an ordinary command goes through with no record');
});

test('a session with no wall hold is not answered by Hands-off, though the project switch is on (finding 4)', () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP }); // no giveHold: started before Hands-off could hold
  const { runId } = readRun(file);
  // Directly: handsOffFor refuses when the session carries no hold.
  assert.equal(handsOffFor(REC, readRun(file), { cfg: on(), version: V, runId, project: SHOP, hasHold: false }), null);
  // And the hook program, reading the handed settings itself, answers nothing: the question is left to the owner.
  assert.equal(hook(file, REC).stdout, '', 'no answer for a session with no hold');
  assert.equal(readRun(file).status, 'attention', 'the question is shown so the owner answers it');
  R.removeRun(file);
});

test('the dashboard\'s own continue prompt does not reset the loop count a move carried; the owner\'s message does', () => {
  // A move carries the loop count to the new run (src/server/deck.mjs). The dashboard then types its continue prompt
  // (Auto mode's move, the continue route's restart): that UserPromptSubmit is not the owner's message, so the count
  // the move carried must survive (src/hook.mjs reads the configured prompt and skips the reset for it).
  writeCfg(on()); // no autoSwitch set: the continue prompt is the default
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), handsOffRow: 2 }));
  hook(file, { hook_event_name: 'UserPromptSubmit', prompt: 'Continue from where you stopped.' });
  assert.equal(readRun(file).handsOffRow, 2, 'the continue prompt is not counted as the owner\'s message');
  hook(file, { hook_event_name: 'UserPromptSubmit', prompt: 'please fix the failing test' });
  assert.equal(readRun(file).handsOffRow, 0, 'the owner\'s own message starts the count again');
  R.removeRun(file);
});

test('a custom continue prompt is read from the config, not the record', () => {
  writeCfg({ handsOff: on().handsOff, autoSwitch: { prompt: 'Carry on, please.' } });
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  giveHold(file);
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), handsOffRow: 3 }));
  hook(file, { hook_event_name: 'UserPromptSubmit', prompt: 'Carry on, please.' });
  assert.equal(readRun(file).handsOffRow, 3, 'the configured custom prompt is recognised');
  R.removeRun(file);
});

test('a session whose only PreToolUse hook is the Lead model\'s (Agent|Task), not the wall\'s, is uncovered: the hook answers nothing', () => {
  writeCfg(on());
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  // A Lead model session carries the Agent|Task hook (launch.mjs leadHook) but not the wall's Bash|Write|… hold. Its
  // acts are not held, so Hands-off must not answer its questions either (sessionCanHold → handsOffFor hasHold).
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), path.basename(file)), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
  const before = activity().length;
  assert.equal(hook(file, REC).stdout, '', 'no answer for a session the wall does not hold');
  const run = readRun(file);
  assert.equal(run.status, 'attention', 'the question is left to the owner');
  for (const k of ['handsOffDone', 'handsOffRow', 'handsOffStop']) assert.equal(k in run, false, k);
  assert.equal(activity().length, before, 'nothing in Activity');
  R.removeRun(file);
});
