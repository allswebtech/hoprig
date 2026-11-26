// Every caller of the dashboard's move (src/server/deck.mjs move) carries Hands-off's stops: a session with an hour
// stop, a loop count, the hour's answers and the owner's own Off is moved by each of them, and the new run record
// carries the three while the owner's entry sits under the new run id unchanged. The stand-in backend's respawn plays
// the old launcher's end (its record goes) and then the new launcher's first record from the launch file, as
// bin/hoprig.mjs does (applyLaunch → launch → createRun; test/server/movecarry-launcher.test.mjs runs the real one).
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

const box = sandbox('movecarry-callers');
test.after(() => box.cleanup());
process.env.HOPRIG_TERM_ID = 'pty-1'; // the records name the built-in terminal the stand-in backend lists
const SHOP = path.join(box.home, 'shop');
fs.mkdirSync(SHOP, { recursive: true });

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { clearLimited } = await import('../../src/autoswitch.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { conversationOf } = await import('../../src/launch.mjs');
const L = await import('../../src/launchfile.mjs');
const R = await import('../../src/runs.mjs');
const { readRun } = await import('../../src/runfile.mjs');
const { hookFile, hookSettingsDir, runsDir } = await import('../../src/paths.mjs');
const V = hoprigVersion();
const CONV = crypto.randomUUID();
const DONE = Array.from({ length: 3 }, (_, i) => ({ at: Date.now() - (i + 1) * 60_000, kind: 'question', question: `Which runner ${i}?`, text: 'node:test (Recommended)', because: 'recommended' }));

const BASE = { launcher: ['launcher'], usage: false, server: { roots: [box.home], passwordHash: await hashPassword('right-password') } };
saveConfig(BASE);
writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });

let screenNow = '';
let failNext = false;
const launches = []; // what each respawn was given: { argv, file, body }
// The respawn of the real backends: the old programs end first (the old launcher removes its record), then the new
// launcher starts from its launch file and writes its first record.
let beforeEnd = null; // a test's look at the moment the old tool still runs
const backend = {
  list: async () => [{ id: 'pty-1', session: 'shop', cwd: SHOP, pid: process.pid, active: true, activity: Date.now(), created: Date.now(), command: 'claude' }],
  capture: async () => screenNow, kind: 'pty', capabilities: {},
  respawn: async (id, dir, argv) => {
    if (failNext) {
      failNext = false;
      throw new Error('the terminal could not be restarted');
    }
    const i = argv.indexOf(L.LAUNCH_FLAG);
    const file = argv[i + 1];
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    launches.push({ argv, file, body });
    const old = R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1');
    if (beforeEnd) await beforeEnd(old);
    if (old) R.removeRun(path.join(runsDir(), `${old.runId}.json`)); // the old launcher ended
    const l = L.takeLaunch(file);
    const [profile, ...rest] = l.argv;
    R.createRun({ profile, cwd: l.cwd, carryArgs: [], conversation: conversationOf(rest), hand: l.hand || null });
    const now = R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1');
    fs.writeFileSync(path.join(runsDir(), `${now.runId}.json`), JSON.stringify({ ...readRun(path.join(runsDir(), `${now.runId}.json`)), sessionId: CONV, status: 'waiting' }));
  },
};
const app = createServer({ backend, watch: false, dashboardFile: false, autoSwitchGraceMs: 0 });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const operator = () => app.features.find((f) => f.name === 'operator');

const giveHold = (runId) => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), `${runId}.json`), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
};
const current = () => R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1') || null;
// The session as it stands before a move: the live record of terminal pty-1 on `profile`, with the stops given.
function session(profile, { stops = true, limit = null, entry = { on: false } } = {}) {
  for (const r of R.listRuns({ usage: false })) R.removeRun(path.join(runsDir(), `${r.runId}.json`));
  for (const p of ['work', 'backup']) clearLimited(p); // Auto mode marks the provider it left (an earlier case)
  const { file, run } = R.createRun({ profile, cwd: SHOP, conversation: CONV });
  fs.writeFileSync(file, JSON.stringify({ ...run, sessionId: CONV, status: 'waiting', ...(stops ? { handsOffStop: 'hour', handsOffRow: 2, handsOffDone: DONE } : {}), ...(limit ? { limit } : {}) }));
  giveHold(run.runId);
  const own = entry ? { ...entry, version: V, at: 1_700_000_000_000 } : null;
  return { runId: run.runId, own };
}
function config(extra, runId, own) {
  saveConfig({ ...BASE, autoSwitch: undefined, operator: undefined, assistant: undefined, ...extra, handsOff: { offered: true, ...(own ? { sessions: { [runId]: own } } : {}) } });
}
// The new record carries the three, the owner's entry is under the new id unchanged, the old id's is gone.
function carried(t, before, { to, own }) {
  const now = current();
  assert.ok(now, `${t}: the new launcher wrote its record`);
  assert.notEqual(now.runId, before, `${t}: a new run`);
  assert.equal(now.profile, to, `${t}: on the new provider`);
  assert.equal(now.handsOffStop, 'hour', `${t}: the hour stop`);
  assert.equal(now.handsOffRow, 2, `${t}: the count`);
  assert.deepEqual(now.handsOffDone, DONE, `${t}: the hour's answers`);
  const ho = loadConfig().handsOff;
  assert.deepEqual(ho.sessions?.[now.runId], own, `${t}: the owner's entry under the new id, exactly`);
  assert.equal(before in (ho.sessions || {}), false, `${t}: nothing left under the old id`);
  assert.equal('moving' in ho, false, `${t}: the moving mark is gone`);
  return now;
}

const LIMIT_SCREEN = "You've hit your usage limit · resets 5pm\n";

const CALLERS = [
  ['the session route (the page, Tia\'s switch_account)', async () => {
    const r = await call('POST', '/api/sessions/shop/switch', { profile: 'backup' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }, {}],
  ['the continue route\'s restart in place', async () => {
    const r = await call('POST', '/api/sessions/shop/continue', { restart: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }, { to: 'work' }],
  ['Auto mode at a limit (the watcher)', async () => {
    screenNow = LIMIT_SCREEN;
    await app.watcher.tick();
    screenNow = '';
  }, { extra: { autoSwitch: { enabled: true, order: ['work', 'backup'] } } }],
  ['the Operator\'s tap "Continue on the next provider"', async () => {
    screenNow = LIMIT_SCREEN;
    const l = await call('GET', '/api/operator/attention');
    const it = l.json.items.find((i) => i.kind === 'limit');
    assert.ok(it, JSON.stringify(l.json.items));
    const r = await call('POST', '/api/operator/act', { item: it.id, act: 'switch', seen: it.rev });
    screenNow = '';
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }, { extra: { autoSwitch: { enabled: false, order: ['work', 'backup'] } } }],
  // backup has an API key: the rule moves a session onto it only at Hands off and inside her daily cap.
  ['Tia\'s rule "limit", and its Undo', async () => {
    for (const f of ['moves.json', 'runs-ended.jsonl']) fs.rmSync(path.join(box.state, f), { force: true });
    fs.rmSync(path.join(box.state, 'operator'), { recursive: true, force: true });
    const r = await operator().reflex.round();
    assert.equal(r.acted, 1, JSON.stringify(r));
  }, { limit: true, extra: { autoSwitch: { enabled: false, order: ['work', 'backup'] }, assistant: { enabled: true, level: 'handsoff', accounts: ['work', 'backup'], dailyCapUsd: 5 }, operator: { acts: true, rules: { limit: true } } } }],
];

for (const [name, move, o] of CALLERS) {
  test(`a move by ${name} carries the hour stop, the count, the hour's answers and the owner's Off`, OFFERED, async () => {
    const from = 'work';
    const to = o.to || 'backup';
    const { runId, own } = session(from, { limit: o.limit ? { at: Date.now() - 60_000, error: 'rate_limit', text: "You've hit your usage limit" } : null });
    config(o.extra || {}, runId, own);
    launches.length = 0;
    await move();
    assert.equal(launches.length, 1, 'one restart');
    assert.equal(launches[0].body.hand.from, runId);
    const now = carried(name, runId, { to, own });
    assert.equal(now.runId, launches[0].body.hand.runId, 'the run id the dashboard chose');
    assert.equal(own.on, false, 'the owner\'s Off stays Off');
    if (name.startsWith('Tia')) {
      // Undo moves it back: a second move in a row, from the record the first one wrote.
      const act = JSON.parse(fs.readFileSync(path.join(box.state, 'operator', 'reflexes.json'), 'utf8')).acts?.find?.((a) => a.move);
      const id = act ? act.id : (await call('GET', '/api/operator/attention')).json.byTia.find((l) => l.undo)?.undo;
      assert.ok(id, 'an act to undo');
      await operator().reflex.undo(id);
      carried('the Undo of Tia\'s move', now.runId, { to: 'work', own });
    }
  });
}

test('the owner\'s On is carried as On; two moves in a row keep everything; no entry and no stops: nothing is written', OFFERED, async () => {
  const { runId, own } = session('work', { entry: { on: true } });
  config({}, runId, own);
  assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  const one = carried('first move', runId, { to: 'backup', own });
  assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'work' })).status, 200);
  carried('second move', one.runId, { to: 'work', own });
  // A session whose owner never turned the switch, with nothing to carry: the launch file is the old shape, no config.
  const plain = session('work', { stops: false, entry: null });
  config({}, plain.runId, null);
  const before = fs.readFileSync(path.join(box.config, 'config.json'), 'utf8');
  launches.length = 0;
  assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  assert.deepEqual(Object.keys(launches[0].body).sort(), ['argv', 'at', 'cwd', 'v']);
  assert.equal(fs.readFileSync(path.join(box.config, 'config.json'), 'utf8'), before, 'the config is not written');
  // No entry but its stops: carried, and still no entry is made.
  const stops = session('work', { entry: null });
  config({}, stops.runId, null);
  assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  const now = current();
  assert.equal(now.handsOffStop, 'hour');
  assert.equal(now.handsOffRow, 2);
  assert.deepEqual(loadConfig().handsOff, { offered: true }, 'no entry made, and the old id\'s and the mark are gone');
});

test('a failed restart puts everything back as it was', async () => {
  for (const entry of [{ on: false }, null]) {
    const { runId, own } = session('work', { entry });
    config({}, runId, own);
    const before = loadConfig().handsOff;
    failNext = true;
    const r = await call('POST', '/api/sessions/shop/switch', { profile: 'backup' });
    assert.notEqual(r.status, 200);
    assert.deepEqual(loadConfig().handsOff, before, `config as before (${JSON.stringify(entry)})`);
    assert.equal(current().runId, runId, 'the old run goes on');
    assert.equal(readRun(path.join(runsDir(), `${runId}.json`)).handsOffRow, 2, 'its count as it was');
  }
});

test('offered:false (hidden): a move writes no config and the launch file is the old shape', async () => {
  const { runId, own } = session('work');
  saveConfig({ ...BASE, handsOff: { offered: false, sessions: { [runId]: own } } });
  const before = fs.readFileSync(path.join(box.config, 'config.json'), 'utf8');
  launches.length = 0;
  assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  assert.deepEqual(Object.keys(launches[0].body).sort(), ['argv', 'at', 'cwd', 'v']);
  assert.equal(fs.readFileSync(path.join(box.config, 'config.json'), 'utf8'), before);
  for (const k of ['handsOffStop', 'handsOffRow', 'handsOffDone']) assert.equal(k in current(), false, k);
});

// The edge: the old launcher is held until its coding tool ends, and its record is gone before the new launcher
// starts. While it still runs, its tool's question is not answered (its count was read for the new run already); the
// stops arrive all the same.
test('the old tool, still running while the move waits for it, gets no answer; the stops arrive', OFFERED, async () => {
  const { runId, own } = session('work', { stops: false, entry: { on: true } });
  fs.writeFileSync(path.join(runsDir(), `${runId}.json`), JSON.stringify({ ...readRun(path.join(runsDir(), `${runId}.json`)), handsOffRow: 1, handsOffDone: DONE.slice(0, 1) }));
  config({}, runId, own);
  const QUESTION = { hook_event_name: 'PermissionRequest', session_id: CONV, permission_mode: 'default', cwd: SHOP, tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which test runner should this project use?', header: 'Runner', multiSelect: false, options: [{ label: 'node:test (Recommended)', description: 'Built in.' }, { label: 'vitest', description: 'Fast.' }] }] } };
  const hook = (id) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(QUESTION), env: { ...process.env, HOPRIG_RUN_FILE: path.join(runsDir(), `${id}.json`), CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' });
  // Before the move the same question is answered: the switch is on and nothing has stopped it.
  assert.match(hook(runId).stdout, /"behavior":"allow"/);
  const seen = {};
  beforeEnd = async (old) => {
    seen.record = !!old && old.runId === runId;
    seen.answer = hook(runId).stdout;
    seen.row = readRun(path.join(runsDir(), `${runId}.json`)).handsOffRow;
  };
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally {
    beforeEnd = null;
  }
  assert.equal(seen.record, true, 'the old record is still there while its tool ends');
  assert.equal(seen.answer, '', 'no answer from the old tool after its count was read');
  assert.equal(seen.row, 2, 'its own record took the asked question in');
  const now = current();
  assert.equal(now.handsOffRow, 2, 'the count read for the new run: the answer before the move and nothing after');
  assert.equal(now.handsOffDone.length, 2);
  assert.deepEqual(loadConfig().handsOff.sessions[now.runId], own, 'the owner\'s On, carried');
});
