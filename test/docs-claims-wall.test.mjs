// docs/HANDS-OFF.md, the three parts that were checked by reading only: "What it leaves to you" (the net's word list
// against src/handsoff.mjs SIGNS), "Seen and stopped" beyond its numbers and labels, and "A move to another provider,
// and what it does not carry". Each sentence is asked of the code it describes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-claimswall-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const H = await import('../src/handsoff.mjs');
const { handsOffFor, preToolHold, handsOffActivity } = await import('../src/hook.mjs');
const R = await import('../src/runs.mjs');
const WEB = await import('../web/handsoff.js').catch(() => null);

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const page = () => read('docs/HANDS-OFF.md').replace(/\s+/g, ' ');
const says = (words) => assert.ok(page().includes(words), `the page says: ${words}`);

const V = H.hoprigVersion();
const SHOP = path.join(tmp, 'shop');
fs.mkdirSync(SHOP, { recursive: true });
const onCfg = { handsOff: { offered: true, projects: { [SHOP]: { on: true, version: V, at: 1 } } } };
const keys = { runId: 'run-x', project: SHOP };
const ask = (q) => ({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q, header: 'Pick', multiSelect: false, options: [{ label: 'node:test (Recommended)', description: '' }, { label: 'vitest', description: '' }] }] } });
const pre = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: SHOP });

// ---------- What it leaves to you: the net ----------

test('the net: the page names each kind of the list, and the code holds exactly those kinds', () => {
  says('A question whose words or options look like they are about money or a paid plan, a sign-in, a push or a merge, a release or publishing, sending something out, a delete outside the session\'s folder, admin rights, switching a safety rule or a check off, or giving the session more freedom');
  const kinds = [...new Set(H.SIGNS.map(([k]) => k))];
  assert.deepEqual(kinds, ['money', 'sign-in', 'push or merge', 'release', 'send out', 'delete outside', 'admin rights', 'safety off', 'wider mode'], 'nine kinds, each one the page names');
  const one = {
    money: 'Should I buy the pro plan?',
    'sign-in': 'Should I log in again?',
    'push or merge': 'Shall I merge it now?',
    release: 'Shall I publish the package?',
    'send out': 'Shall I send the report to the team?',
    'delete outside': 'Shall I delete the files in ~/old?',
    'admin rights': 'Shall I run it with sudo?',
    'safety off': 'Shall I disable the tests for now?',
    'wider mode': 'Shall I switch to bypass permissions?',
  };
  for (const [k, q] of Object.entries(one)) assert.equal(H.ownersAlone(q), k, q);
  assert.equal(H.ownersAlone('Which test runner should the project use?'), null, 'an ordinary question is no sign');
});

test('the net: English, Hindi and Hinglish; letters that draw nothing or only look like Latin ones hide no word', () => {
  says('Hoprig reads the question\'s words for a fixed list of signs (English, Hindi and Hinglish; `src/handsoff.mjs`)');
  says('Letters that draw nothing or only look like Latin ones do not hide a word from it.');
  assert.equal(H.ownersAlone('क्या मैं पैसे दूँ?'), 'money', 'Hindi');
  assert.equal(H.ownersAlone('bina puche kar do'), 'wider mode', 'Hinglish');
  assert.equal(H.ownersAlone('Should I lоg in again?'), 'sign-in', 'a Cyrillic o');
  assert.equal(H.ownersAlone('Shall I pub​lish the package?'), 'release', 'a zero-width space');
});

test('the net leaves the question to you also when an option is marked as recommended', () => {
  says('when it finds one, leaves the question to you, also when an option is marked as recommended.');
  const card = { kind: 'question', questions: [{ question: 'Shall I merge it now?', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }], recommended: 0, freeText: true }] };
  assert.deepEqual(H.decide(card), { wait: 'owner:push or merge' });
});

test('an ask that looks like it holds a secret, or is longer than its card shows, is left to you', () => {
  says('It also leaves to you an ask whose words hold something that looks like a secret, and one longer than its card shows');
  const q = { kind: 'question', questions: [{ question: 'Which?', options: [{ label: 'a (Recommended)' }], recommended: 0, freeText: true }] };
  assert.deepEqual(H.decide({ ...q, masked: true }), { wait: 'secret' });
  assert.deepEqual(H.decide({ ...q, cut: true }), { wait: 'too-long' });
});

// ---------- Seen and stopped ----------

test('seen: each answer says why in the page\'s words, and is one line in Work → Activity', () => {
  says('because the tool recommended it" or "… from your note for this project", and it is one line in Work → Activity.');
  assert.equal(H.BECAUSE.recommended, 'because the tool recommended it');
  assert.equal(H.BECAUSE.note, 'from your note for this project');
  if (WEB) assert.deepEqual({ ...WEB.BECAUSE }, { ...H.BECAUSE }, 'the page of the dashboard says the same');
  const log = path.join(tmp, 'activity.log');
  handsOffActivity({ termName: 'shop' }, { kind: 'question', question: 'Which runner?', text: 'node:test (Recommended)', because: 'recommended' }, log);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'one line');
  assert.match(lines[0], /handsoff/);
  assert.match(lines[0], /because the tool recommended it/);
});

test('stopped: the session\'s button is "Stop Hands-off", and turning a switch off answers nothing more', () => {
  says('One press on "Stop Hands-off" on the session, or turning the project\'s switch off, stops it at once');
  assert.match(read('web/handsoff.js'), /'Stop Hands-off'/);
  const run = { cwd: SHOP, status: 'attention' };
  assert.ok(handsOffFor(ask('Which runner?'), run, { cfg: onCfg, version: V, ...keys }).output, 'on: answered');
  const off = { handsOff: { offered: true, projects: { [SHOP]: { on: false, version: V, at: 2 } } } };
  assert.equal(handsOffFor(ask('Which runner?'), run, { cfg: off, version: V, ...keys }), null, 'off: nothing');
});

test('stopped: three answers with no work between, or ten within an hour; a read or a search is no work; on again starts the hour again', () => {
  says('Three answers in a row with no work between them (no edit, write or command that went through, no message of yours; a read or a search is no work) stop it for that session until you turn it on again. So do ten answers within an hour, whatever came between. Turning it on again starts the hour again.');
  assert.equal(H.LOOP_MAX, 3);
  assert.equal(H.HOUR_MAX, 10);
  const run = (o) => ({ cwd: SHOP, status: 'attention', ...o });
  assert.ok(handsOffFor(ask('Which?'), run({ handsOffRow: 2 }), { cfg: onCfg, version: V, ...keys }).output, 'the third answer is given');
  assert.deepEqual(handsOffFor(ask('Which?'), run({ handsOffRow: 3 }), { cfg: onCfg, version: V, ...keys }), { wait: 'loop', loop: true }, 'after three, it stops');
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(H.WORK_TOOLS.has(t), `${t} is work`);
  for (const t of ['Read', 'Grep', 'Glob']) assert.ok(!H.WORK_TOOLS.has(t), `${t} is no work`);
  const now = 10_000_000;
  const ten = Array.from({ length: 10 }, (_, i) => now - (i + 1) * 60_000);
  assert.equal(H.hourFull(ten, now), true, 'ten within the hour');
  assert.equal(H.hourFull(ten.slice(1), now), false, 'nine is not');
  assert.equal(H.hourFull(ten, now, now - 5 * 60_000), false, 'on again: only the answers since then count');
});

test('a stop ends the answers, not the wall: what is yours still waits until you turn the switch off', () => {
  says('A stop ends the **answers**, not the **wall**.');
  says('(Only turning the switch off, on the session or the project, lets those commands run by the session\'s own permission mode again.)');
  for (const stop of ['loop', 'hour', 'reset']) {
    const run = { cwd: SHOP, status: 'working', handsOffStop: stop };
    assert.equal(handsOffFor(ask('Which?'), { ...run, status: 'attention' }, { cfg: onCfg, version: V, ...keys }), null, `${stop}: no answer`);
    assert.equal(preToolHold(pre('sudo true'), run, { cfg: onCfg, version: V, ...keys }).output.hookSpecificOutput.permissionDecision, 'ask', `${stop}: still held`);
  }
  const off = { handsOff: { offered: true, projects: { [SHOP]: { on: false, version: V, at: 2 } } } };
  assert.equal(preToolHold(pre('sudo true'), { cwd: SHOP }, { cfg: off, version: V, ...keys }), null, 'off: the mode decides');
});

test('the switch and whose switch counts are never taken from the record handed to the session', () => {
  says('Hoprig does not take the switch, or which session\'s and project\'s switch counts, from the record it hands the session.');
  const cfg = { handsOff: { offered: true } };
  const forged = { cwd: SHOP, status: 'attention', runId: 'other', handsOff: { on: true, version: V }, project: SHOP };
  assert.equal(handsOffFor(ask('Which?'), forged, { cfg, version: V, ...keys }), null, 'a switch written into the record turns nothing on');
  const sessions = { handsOff: { offered: true, sessions: { other: { on: true, version: V, at: 1 } } } };
  assert.equal(handsOffFor(ask('Which?'), forged, { cfg: sessions, version: V, ...keys }), null, 'another run id in the record does not pick its switch');
});

// ---------- A move to another provider ----------

const CONV = '11111111-2222-4333-8444-555555555555';

test('a move keeps the Hands-off state: the stops, the hour\'s count and the hour\'s answers', () => {
  says('Continuing a session on another provider after a usage limit keeps its Hands-off state: the owner\'s own switch for it, the hour stop and the loop stop, the hour\'s count and the hour\'s answers.');
  const done = [{ at: Date.now() - 1000, text: 'node:test' }];
  const { run } = R.createRun({ profile: 'backup', cwd: SHOP, conversation: CONV, hand: { from: 'mabc123-111', runId: 'mabc124-222', conversation: CONV, carry: { stop: 'hour', row: 2, done } } });
  assert.equal(run.runId, 'mabc124-222', 'the run id the dashboard chose, under which its own switch is kept');
  assert.equal(run.handsOffStop, 'hour');
  assert.equal(run.handsOffRow, 2);
  assert.deepEqual(run.handsOffDone, done);
});

test('a start that cannot carry it starts off, whatever the project\'s switch; the wall still holds', () => {
  says('So the new run starts **off**, whatever the project\'s switch says');
  says('The wall still holds on it by the project\'s switch while it is off, so what is yours still waits for you.');
  const { run } = R.createRun({ profile: 'max', cwd: SHOP, conversation: CONV, hand: { reset: true } });
  assert.equal(run.handsOffStop, 'reset');
  assert.equal(H.switchState({ project: onCfg.handsOff.projects[SHOP], version: V, stopped: run.handsOffStop }).on, false, 'off although the project is on');
  assert.equal(preToolHold(pre('sudo true'), run, { cfg: onCfg, version: V, ...keys }).output.hookSpecificOutput.permissionDecision, 'ask', 'held');
  // The starts the page names send that reset: the restore after a reboot, and a chat taken into a terminal or back.
  assert.match(read('src/automation/feature.mjs'), /const reset = \(mode === 'move' \|\| mode === 'resume'\) && !!sessionId/);
  assert.match(read('src/chat/handoff.mjs'), /resetHandsOff: true/);
  assert.match(read('src/chat/handoff.mjs'), /c\.handsOffStop = 'reset'/);
});

// ---------- What the wall does not read ----------

test('what the wall does not read is said to be why it is a help against a mistake, and each point still goes through', async () => {
  says('So this list is why the wall is a help against a mistake, not a fence: a session that sets out to hide a command from it can.');
  const { wallHeld } = await import('../src/wall.mjs');
  const places = { cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
  const git = (cwd, args) => (args.join(' ') === 'symbolic-ref --short HEAD' ? 'feature' : /^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(args.join(' ')) ? 'origin/main' : null);
  // One line of each point that is still true: a script's text, an interpreter's -c/-e text, a git alias, a cd it
  // cannot follow, a variable's value in an argument of a command other than a push.
  for (const line of ['bash fix.sh', 'python3 -c "import os; os.system(\'npm publish\')"', 'node -e "require(\'child_process\').execSync(\'npm publish\')"', 'git p', 'cd $DIR && cat .config/hoprig/config.json', 'cat "$FILE"']) {
    assert.equal(wallHeld({ tool: 'Bash', input: { command: line }, cwd: places.cwd, git, places }), null, line);
  }
});

// ---------- What it reads: a runner in front of a command does not hide it ----------

test('the page says a package runner, an environment loader or a tool\'s own runner does not hide a command either', () => {
  // After the sentence that a known program in front of a command does not hide it, "Nor does" keeps the negative:
  // a runner does not hide it either. "So does" read as the opposite (that a runner does hide it).
  assert.doesNotMatch(page(), /is\. So does a package runner/, 'the old "So does" that read as the opposite is gone');
  says('Nor does a package runner (a program that fetches a tool and runs it, such as `npx`), an environment loader');
  says("or a tool's own runner (a tool's own command that runs another command in the project's setting) hide it:");
});

// ---------- An interpreter running a script that writes release notes ----------

test('the page says an interpreter running a release-notes script goes through, and a deploy script stays held', async () => {
  says('A script that writes release notes is not a deployment, so an interpreter running one goes through');
  const { wallHeld } = await import('../src/wall.mjs');
  const places = { cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
  const git = (cwd, args) => (args.join(' ') === 'symbolic-ref --short HEAD' ? 'feature' : /^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(args.join(' ')) ? 'origin/main' : null);
  const ask = (line) => wallHeld({ tool: 'Bash', input: { command: line }, cwd: places.cwd, git, places });
  for (const line of ['node scripts/release-notes.mjs', 'python3 scripts/release_notes.py']) assert.equal(ask(line), null, line);
  for (const line of ['node scripts/release.mjs', 'node scripts/deploy-site.mjs']) assert.ok(ask(line), line);
});
