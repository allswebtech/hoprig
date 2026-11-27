// Hands-off on the dashboard (src/server/handsoff.mjs, deck.mjs): the project's switch and note are kept in Hoprig's
// config with the version they were turned on under, a folder outside the roots is refused, a session's own switch
// is kept in that config under its run id (never in its run record) and reaches the card. And with the switch off (the default) nothing of Hands-off
// runs, writes or answers: a whole-home snapshot over a start, a waiting question and three ticks.
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

const box = sandbox('handsoff');
test.after(() => box.cleanup());
process.env.HOPRIG_TERM_ID = 'pty-1'; // the run record names the built-in terminal the stand-in backend lists
const SHOP = path.join(box.home, 'shop');
fs.mkdirSync(SHOP, { recursive: true });

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { hoprigVersion, settingsHoldWall } = await import('../../src/handsoff.mjs');
const { hookSettings } = await import('../../src/launch.mjs');
const R = await import('../../src/runs.mjs');
const { readRun } = await import('../../src/runfile.mjs');
const { hookFile, hookSettingsDir, runsDir } = await import('../../src/paths.mjs');
const V = hoprigVersion();

saveConfig({ launcher: ['launcher'], server: { roots: [box.home], passwordHash: await hashPassword('right-password') } });
const backend = {
  list: async () => [{ id: 'pty-1', session: 'shop', cwd: SHOP, pid: process.pid, active: true, activity: Date.now(), created: Date.now(), command: 'claude' }],
  capture: async () => screenNow, kind: 'pty', capabilities: {},
};
let screenNow = '';
const app = createServer({ backend, watch: false, dashboardFile: false });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const QUESTION = { hook_event_name: 'PermissionRequest', session_id: crypto.randomUUID(), permission_mode: 'default', cwd: SHOP, tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which test runner should this project use?', header: 'Runner', multiSelect: false, options: [{ label: 'node:test (Recommended)', description: 'Built in.' }, { label: 'vitest', description: 'Fast.' }] }] } };
const hook = (file, ev) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(ev), env: { ...process.env, HOPRIG_RUN_FILE: file, CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });
// A session started while Hands-off is offered carries the wall's PreToolUse hold in its handed settings
// (launch.mjs hookSettings). These synthetic runs are not launched, so give them that precondition: without it the
// session route refuses to turn Hands-off on (server/handsoff.mjs sessionHasHold).
const giveHold = (file) => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), path.basename(file)), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
};

// Every path under the test's home with its kind, size, mode, change time and content hash.
function snapshot(root) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      const hash = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '';
      out.set(path.relative(root, p), `${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'} ${st.size} ${st.mode} ${st.mtimeMs} ${hash}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

test('the shipped state (offered, everything off): a start, a held act, a waiting question and three ticks write nothing of Hands-off and answer nothing', OFFERED, async () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const runName = path.relative(box.root, file);
  // The session carries the wall's hold in its handed settings, as a launched session does. So if a switch with no
  // entry were ever read as on (the "on when absent" bug), the hook below would really hold the owner-only act and
  // answer the question. With everything off (the shipped default) it does neither: that is what this snapshot proves.
  // Written before the snapshot so it is a precondition of the session, not a change Hands-off made.
  giveHold(file);
  const before = snapshot(box.root);
  assert.equal(hook(file, { hook_event_name: 'SessionStart', session_id: QUESTION.session_id, source: 'startup' }).stdout, '');
  const held = hook(file, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo true' }, cwd: SHOP });
  assert.equal(held.stdout, '', 'nothing held: the wall holds an owner-only act only while a switch is on');
  const asked = hook(file, QUESTION);
  assert.equal(asked.stdout, '', 'no answer: the owner is asked');
  for (let i = 0; i < 3; i++) await app.watcher.tick();
  const after = snapshot(box.root);
  // What changed: the session's own run record (and its folder, its lock and tool-news mark beside it), nothing else:
  // no config, no Activity line, no other file.
  const changed = changes(before, after).filter((k) => k !== runName && k !== path.dirname(runName) && !k.startsWith(`${runName}.`) && k !== path.dirname(path.dirname(runName)) && !k.split(path.sep).join('/').startsWith('state/operator'));
  // (the Operator's own rounds, which mend with no model and no usage from the first run, keep their record in state/operator)
  assert.deepEqual(changed, [], `changed beside the run record: ${changed.join(', ')}`);
  assert.equal(fs.existsSync(path.join(box.state, 'automation.log')), false, 'no line in Activity');
  const run = readRun(file);
  assert.equal(run.status, 'attention');
  // No answer was given and no act was held, so the record carries none of Hands-off's own fields, and no hold.
  for (const k of ['handsOff', 'handsOffDone', 'handsOffRow', 'handsOffStop', 'held', 'holds']) assert.equal(k in run, false, k);
  assert.equal(run.handsWait, null);
  assert.equal('handsOff' in loadConfig(), false, 'offering wrote nothing to the config: no switch was pressed');
  // The card the page gets is the tool's own data; the switch is offered (the shipped default) and shows as off, and
  // nothing was answered. This is the load-bearing guard that offering the switch does not turn it on: it is seen
  // failing if a switch with no entry is read as on (the held act and the question above would then be acted on).
  const st = await call('GET', '/api/sessions/shop');
  assert.equal(st.status, 200);
  assert.deepEqual(st.json.session.askCard.questions[0].options.map((o) => o.label), ['node:test (Recommended)', 'vitest']);
  assert.equal(st.json.session.handsOff.on, false, 'the switch is offered and shows as off');
  assert.equal('handsOffDone' in st.json.session, false, 'nothing was answered, so no answered-by-Hoprig line');
  assert.equal((await call('GET', '/api/settings')).json.handsOff.offered, true, 'Hands-off is offered by default');
  R.removeRun(file);
});

test('a session started before this slice is not held or answered after the update turns the switch on', OFFERED, async () => {
  saveConfig({ handsOff: { offered: true } }); // the update: offered now defaults on
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  // What a session started on the wall before this slice (4ae007f2) was handed: launch.mjs is unchanged across the
  // update and the old handsOffOffered read a fresh install as NOT offered, so hookSettings({ offered: false }) is
  // byte-for-byte what that session got. It carries no wall PreToolUse entry, so Claude Code never calls the hook for
  // Bash/Write/Edit: the session's owner-only acts cannot be held, whatever a switch later says.
  const before = hookSettings({ version: '2.1.327', offered: false });
  assert.equal(settingsHoldWall(before), false, 'the before-update session carries no wall PreToolUse entry');
  assert.equal(settingsHoldWall(hookSettings({ version: '2.1.327', offered: true })), true, 'a session started after the update does carry it');
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  const handed = path.join(hookSettingsDir(), path.basename(file));
  fs.writeFileSync(handed, JSON.stringify(before));
  const handedBefore = fs.readFileSync(handed, 'utf8');
  // The owner turns the project switch on after the update.
  const turnOn = await call('POST', '/api/handsoff/project', { dir: SHOP, on: true });
  assert.equal(turnOn.json.on, true);
  assert.equal(fs.readFileSync(handed, 'utf8'), handedBefore, 'offering and turning the switch on did not rewrite a running session\'s handed settings');
  // So the hook cannot begin to hold (no wall matcher means Claude Code never calls it for Bash/Write/Edit), and it
  // does not begin to answer either: Hands-off answers only a session that can hold (hasHold), and this one cannot.
  const asked = hook(file, QUESTION);
  assert.equal(asked.stdout, '', 'a before-update session\'s question is left to the owner, not answered');
  for (const k of ['handsOffDone', 'handsOffRow', 'held', 'holds']) assert.equal(k in readRun(file), false, k);
  // The project's page names it back as uncovered: its questions are answered-but-not-held, so start it again.
  assert.ok(Array.isArray(turnOn.json.uncovered) && turnOn.json.uncovered.length >= 1, 'the before-update session is named back as uncovered');
  R.removeRun(file);
  saveConfig({ handsOff: {} });
});

test('offered:false (the owner hid the feature): every switch on but no answer, nothing written, no switch shown', async () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const { runId } = readRun(file);
  // The project switch and the session's own switch are both on; the owner set handsOff.offered to false to hide it.
  saveConfig({ handsOff: { offered: false, projects: { [fs.realpathSync(SHOP)]: { on: true, version: V } }, sessions: { [runId]: { on: true, version: V, at: Date.now() } } } });
  const before = snapshot(box.root);
  const runName = path.relative(box.root, file);
  hook(file, { hook_event_name: 'SessionStart', session_id: QUESTION.session_id, source: 'startup' });
  assert.equal(hook(file, QUESTION).stdout, '', 'no answer while Hands-off is not offered');
  for (let i = 0; i < 3; i++) await app.watcher.tick();
  const after = snapshot(box.root);
  const changed = changes(before, after).filter((k) => k !== runName && k !== path.dirname(runName) && !k.startsWith(`${runName}.`) && k !== path.dirname(path.dirname(runName)) && !k.split(path.sep).join('/').startsWith('state/operator'));
  // (state/operator is the Operator's own note of the conversation ids Hoprig ran: written the first time a tick sees the run's id, and when this test runs first, as on Windows where the tests above are skipped, it is written here)
  assert.deepEqual(changed, [], `changed beside the run record: ${changed.join(', ')}`);
  assert.equal(fs.existsSync(path.join(box.state, 'automation.log')), false, 'no line in Activity');
  const run = readRun(file);
  for (const k of ['handsOffDone', 'handsOffRow', 'handsOffStop']) assert.equal(k in run, false, k);
  // A record left from when Hands-off was offered (handsWait, handsOffDone) shows nothing now either: the exact card
  // stays, but none of Hands-off's own words.
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), handsWait: 'owner:push or merge', handsOffDone: [{ at: Date.now(), kind: 'question', text: 'x', because: 'recommended' }] }));
  const st = await call('GET', '/api/sessions/shop');
  assert.deepEqual(st.json.session.askCard.questions[0].options.map((o) => o.label), ['node:test (Recommended)', 'vitest']);
  assert.equal('handsOff' in st.json.session, false, 'no Hands-off switch shown');
  assert.equal('handsWait' in st.json.session, false, 'no "Hands-off leaves this to you" reason shown');
  assert.equal('handsOffDone' in st.json.session, false, 'no answered-by-Hoprig line shown');
  assert.equal((await call('GET', '/api/settings')).json.handsOff.offered, false);
  saveConfig({ handsOff: {} });
  R.removeRun(file);
});

test('offered:false (hidden): the switch routes answer 409 and write nothing (no config, no run record)', async () => {
  saveConfig({ handsOff: { offered: false } });
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), handsOffStop: 'loop', handsOffRow: 3 }));
  const cfgBefore = fs.readFileSync(path.join(box.config, 'config.json'), 'utf8');
  const runBefore = fs.readFileSync(file, 'utf8');
  for (const [p, body] of [['/api/handsoff/project', { dir: SHOP, on: true }], ['/api/handsoff/project', { dir: SHOP, note: 'n' }], ['/api/handsoff/session', { name: 'shop', on: true }]]) {
    const r = await call('POST', p, body);
    assert.deepEqual([r.status, r.json && r.json.error], [409, 'Hands-off is not offered on this computer'], p);
  }
  assert.equal(fs.readFileSync(path.join(box.config, 'config.json'), 'utf8'), cfgBefore, 'config unchanged');
  assert.equal(fs.readFileSync(file, 'utf8'), runBefore, 'run record unchanged: the stop and the count stay');
  R.removeRun(file);
});

test('the project\'s switch and note: kept with this version, a folder outside the roots refused, read back', OFFERED, async () => {
  saveConfig({ handsOff: { offered: true } });
  assert.equal((await call('POST', '/api/handsoff/project', { dir: '/etc', on: true })).status, 400);
  assert.equal((await call('POST', '/api/handsoff/project', { dir: SHOP, on: 'yes' })).status, 400);
  assert.equal((await call('POST', '/api/handsoff/project', { dir: SHOP, note: 'x'.repeat(2001) })).status, 400);
  const r = await call('POST', '/api/handsoff/project', { dir: SHOP, on: true, note: '  Choose the smaller one.  ' });
  assert.deepEqual(r.json, { dir: fs.realpathSync(SHOP), on: true, stale: false, note: 'Choose the smaller one.' });
  const kept = loadConfig().handsOff.projects[fs.realpathSync(SHOP)];
  assert.deepEqual({ ...kept, at: typeof kept.at }, { on: true, version: V, note: 'Choose the smaller one.', at: 'number' }, 'with when it was pressed');
  assert.deepEqual((await call('GET', `/api/handsoff?dir=${encodeURIComponent(path.join(SHOP))}`)).json.on, true);
  assert.equal((await call('GET', '/api/handsoff')).json.projects.length, 1);
  // Stored under another version: off, and it says so.
  saveConfig({ handsOff: { offered: true, projects: { [fs.realpathSync(SHOP)]: { ...kept, version: '0.0.1' } } } });
  assert.deepEqual((await call('GET', `/api/handsoff?dir=${encodeURIComponent(SHOP)}`)).json, { dir: fs.realpathSync(SHOP), on: false, stale: true, note: 'Choose the smaller one.' });
  // Saving the note alone does not turn a stale switch on again.
  await call('POST', '/api/handsoff/project', { dir: SHOP, note: 'n' });
  assert.equal(loadConfig().handsOff.projects[fs.realpathSync(SHOP)].on, false);
  saveConfig({ handsOff: {} });
});

test('a session\'s own switch: kept in Hoprig\'s config under its run id, read on its card; a session that is not there is 404', OFFERED, async () => {
  saveConfig({ handsOff: { offered: true } }); // offered on this computer; the switches below decide the rest
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  assert.equal((await call('POST', '/api/handsoff/session', { name: 'nope', on: true })).status, 404);
  assert.equal((await call('POST', '/api/handsoff/session', { name: 'shop', on: 'on' })).status, 400);
  // A session with no wall hold in its handed settings cannot be turned on: start it again.
  const refused = await call('POST', '/api/handsoff/session', { name: 'shop', on: true });
  assert.deepEqual([refused.status, refused.json && refused.json.error], [409, 'This session started before Hands-off could hold its commands; start it again to turn Hands-off on.']);
  giveHold(file);
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), handsOffStop: 'loop', handsOffRow: 3 }));
  assert.equal((await call('POST', '/api/handsoff/session', { name: 'shop', on: true })).status, 200);
  const run = readRun(file);
  const own = () => loadConfig().handsOff.sessions[run.runId];
  assert.deepEqual([own().on, own().version, run.handsOffStop, run.handsOffRow], [true, V, null, 0], 'on again ends a loop\'s stop');
  assert.ok(Number.isFinite(own().at), 'when it was pressed');
  assert.equal(run.handsOff, undefined, 'not in the run record, which the session\'s own commands can write');
  assert.deepEqual((await call('GET', '/api/sessions/shop')).json.session.handsOff, { on: true, stale: false, loop: false, own: true, holding: true });
  // The project's switch turned off after it: one press there stops this session too.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call('POST', '/api/handsoff/project', { dir: SHOP, on: false })).status, 200);
  assert.equal((await call('GET', '/api/sessions/shop')).json.session.handsOff.on, false, 'the project off wins over the session\'s earlier on');
  saveConfig({ handsOff: { offered: true, sessions: loadConfig().handsOff.sessions } });
  assert.equal((await call('GET', '/api/sessions/shop')).json.session.handsOff.on, true);
  await call('POST', '/api/handsoff/session', { name: 'shop', on: false });
  assert.deepEqual([own().on, own().version], [false, V]);
  // A switch the session wrote into its own record is not read.
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), handsOff: { on: true, version: V, at: Date.now() + 1000 } }));
  assert.equal((await call('GET', '/api/sessions/shop')).json.session.handsOff.on, false);
  assert.equal((await call('GET', '/api/sessions/shop')).json.session.handsOff.on, false);
  R.removeRun(file);
});

test('after the hour\'s stop the owner\'s Turn on starts the hour again: the next ask is answered', OFFERED, async () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const { runId } = readRun(file);
  giveHold(file); // the session carries the wall's hold, so the owner's Turn on is not refused
  saveConfig({ handsOff: { offered: true, sessions: { [runId]: { on: true, version: V, at: Date.now() - 120_000 } } } });
  const now = Date.now();
  const done = Array.from({ length: 10 }, (_, i) => ({ at: now - 60_000 + i, kind: 'question', question: 'Which colour?', text: 'A (Recommended)', because: 'recommended' }));
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), handsOffDone: done }));
  assert.equal(hook(file, QUESTION).stdout, '', 'ten answers in the hour: it waits');
  assert.deepEqual([readRun(file).handsOffStop, readRun(file).handsWait], ['hour', 'hour']);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call('POST', '/api/handsoff/session', { name: 'shop', on: true })).status, 200);
  assert.deepEqual((await call('GET', '/api/sessions/shop')).json.session.handsOff, { on: true, stale: false, loop: false, own: true, holding: true });
  const r = hook(file, QUESTION);
  assert.notEqual(r.stdout, '', 'answered after the owner turned it on again');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior, 'allow');
  const run = readRun(file);
  assert.equal(run.handsOffStop, null);
  assert.equal(run.handsOffDone.length, 10, 'the earlier answers stay for the page');
  saveConfig({ handsOff: {} });
  R.removeRun(file);
});

test('the owner\'s press lands on the session\'s own switch even when its record names another run id', OFFERED, async () => {
  saveConfig({ handsOff: { offered: true } });
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const mine = path.basename(file, '.json');
  fs.writeFileSync(file, JSON.stringify({ ...readRun(file), runId: 'another-session' }));
  assert.equal((await call('POST', '/api/handsoff/session', { name: 'shop', on: false })).status, 200);
  const sessions = loadConfig().handsOff.sessions;
  assert.deepEqual([Object.hasOwn(sessions, mine), Object.hasOwn(sessions, 'another-session')], [true, false]);
  assert.equal((await call('GET', '/api/sessions/shop')).json.session.handsOff.own, true);
  saveConfig({ handsOff: {} });
  R.removeRun(file);
});

test('a session that stands at Claude Code\'s first-time question needs him, said in plain words, answered in the terminal', async () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  R.updateRun(file, { status: 'starting' });
  screenNow = [' Allow external CLAUDE.md file imports?', ' Only use Claude Code with files you trust.', ' ❯ 1. No, disable external imports',
    '   2. Yes, allow external imports', ' Enter to confirm · Esc to cancel'].join('\n');
  const s = (await call('GET', '/api/sessions/shop')).json.session;
  assert.equal(s.status, 'attention', 'not "starting" with no word');
  assert.deepEqual([s.askCard.kind, s.askCard.notice.type], ['notice', 'imports']);
  assert.match(s.note, /^Claude Code asks you something before it starts: /);
  assert.equal(s.ask, undefined, 'no "Allow": answered in the terminal');
  R.updateRun(file, { status: 'waiting' });
  assert.equal((await call('GET', '/api/sessions/shop')).json.session.status, 'waiting', 'once it has started, the same words are not a question');
  screenNow = '';
  R.removeRun(file);
});

test('a notice of the tool read from the screen: named, said to come from the screen, no answers offered', async () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  screenNow = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude-screens', 'notice-trust-100.txt'), 'utf8');
  const s = (await call('GET', '/api/sessions/shop')).json.session;
  assert.equal(s.status, 'attention');
  assert.deepEqual([s.askCard.kind, s.askCard.notice.type, s.askCard.source], ['notice', 'trust', 'screen']);
  assert.equal(s.ask, undefined, 'no "Allow": answered in the terminal');
  // The tool's own lines from the screen, the question wrapped over three lines joined again; the note is its question.
  assert.equal(s.askCard.notice.folder, '/home/alex/work/shop');
  assert.deepEqual(s.askCard.notice.answers, ['No, exit', 'Yes, I trust this folder']);
  assert.match(s.askCard.notice.text, /^Quick safety check: Is this a project you created or one you trust\? .* review what's in this folder first\.$/);
  assert.equal(s.note, s.askCard.notice.text.slice(0, 300));
  assert.doesNotMatch(s.note, /Answer in the terminal/);
  screenNow = screenNow.replace('Enter to confirm · Esc to cancel', '');
  assert.notEqual((await call('GET', '/api/sessions/shop')).json.session.askCard?.kind, 'notice', 'not certain: no notice card');
  screenNow = '';
  R.removeRun(file);
});

test('two questions wait (two subagents): the card says how many, so the page can say this is one of them', async () => {
  const { file } = R.createRun({ profile: 'api', cwd: SHOP });
  const ask = (agent, question) => hook(file, { ...QUESTION, agent_id: agent, tool_input: { questions: [{ ...QUESTION.tool_input.questions[0], question }] } });
  ask('agent-1', 'First question (subagent 1)?');
  let s = (await call('GET', '/api/sessions/shop')).json.session;
  assert.deepEqual(s.ask, { type: 'question' }, 'one asker: no count');
  ask('agent-2', 'Second question (subagent 2)?');
  s = (await call('GET', '/api/sessions/shop')).json.session;
  assert.deepEqual(s.ask, { type: 'question', waiting: 2 });
  assert.equal(s.askCard.questions[0].question, 'Second question (subagent 2)?');
  R.removeRun(file);
});

test('a project folder written with ~ is the home folder\'s; a relative one is refused with the reason that is true', OFFERED, async () => {
  const home = process.env.HOME;
  process.env.HOME = box.home; // os.homedir() reads it
  saveConfig({ handsOff: { offered: true } });
  try {
    const r = await call('POST', '/api/handsoff/project', { dir: '~/shop', on: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.dir, fs.realpathSync(SHOP));
    const rel = await call('POST', '/api/handsoff/project', { dir: 'shop', on: false });
    assert.deepEqual([rel.status, rel.json.error], [400, 'write the folder\'s full path, or one that starts with ~/']);
  } finally {
    process.env.HOME = home;
    saveConfig({ handsOff: {} });
  }
});

test('the project switch holds acts for a live held session with no mark, and names back one with no hold', OFFERED, async () => {
  saveConfig({ handsOff: { offered: true } });
  // Distinct run files: createRun keys the id on Date.now()+pid, so two made in the same millisecond would collide.
  const held = R.createRun({ profile: 'api', cwd: SHOP, file: path.join(runsDir(), 'proj-held.json') });
  giveHold(held.file);
  const bare = R.createRun({ profile: 'api', cwd: SHOP, file: path.join(runsDir(), 'proj-bare.json') }); // started before Hands-off: no hold
  const r = await call('POST', '/api/handsoff/project', { dir: SHOP, on: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.on, true);
  // No mark is written: the PreToolUse hook reads the switch itself. It answers "ask" for a held act all the same.
  assert.equal(fs.existsSync(`${held.file}.handsoff`), false, 'no mark is written');
  const ask = hook(held.file, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo true' }, cwd: SHOP });
  assert.equal(JSON.parse(ask.stdout.trim()).hookSpecificOutput.permissionDecision, 'ask');
  // The session with no hold would answer questions but never hold an act: it is named back so the owner is told.
  assert.ok(Array.isArray(r.json.uncovered) && r.json.uncovered.length >= 1, 'the uncovered session is named back');
  R.removeRun(held.file);
  R.removeRun(bare.file);
});
