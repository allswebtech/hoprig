// A press on the session's own switch while a move waits for the old tool, and the old tool outliving the move
// (src/server/deck.mjs #handOver done): the press must reach the new run, and the old id's entry and the moving mark
// must stay while the old launcher's record is still there, so a dying tool with the owner's Off does not start
// following the project's On. The stand-in backend plays the old launcher's end and the new launcher's first record
// from the launch file, as bin/hoprig.mjs does; `oldOutlives` keeps the old record for a test.
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

const box = sandbox('movecarry-press');
test.after(() => box.cleanup());
process.env.HOPRIG_TERM_ID = 'pty-1';
const SHOP = path.join(box.home, 'shop');
fs.mkdirSync(SHOP, { recursive: true });

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { conversationOf } = await import('../../src/launch.mjs');
const L = await import('../../src/launchfile.mjs');
const R = await import('../../src/runs.mjs');
const { readRun } = await import('../../src/runfile.mjs');
const { hookFile, hookSettingsDir, runsDir } = await import('../../src/paths.mjs');
const V = hoprigVersion();
const CONV = crypto.randomUUID();
const BASE = { launcher: ['launcher'], usage: false, server: { roots: [box.home], passwordHash: await hashPassword('right-password') } };
saveConfig(BASE);
writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });

let oldOutlives = false; // the old launcher's record stays (its coding tool outlives the respawn)
let gapMs = 0; // the new launcher's record lands this many ms after respawn returns (a window with no record)
let duringAfterNew = null; // runs while the new record exists and the move is not yet done (respawn has not resolved)
let duringWindow = null; // runs while the window is open (old record gone, new not written): the test lands the new record itself
let during = null; // runs while the old tool is still ending (the move is waiting for it)
let lastLaunch = null; // the launch file of the last move, for a test that plays the new launcher's start itself
const backend = {
  list: async () => [{ id: 'pty-1', session: 'shop', cwd: SHOP, pid: process.pid, active: true, activity: Date.now(), created: Date.now(), command: 'claude' }],
  capture: async () => '', kind: 'pty', capabilities: {},
  respawn: async (id, dir, argv) => {
    const file = argv[argv.indexOf(L.LAUNCH_FLAG) + 1];
    lastLaunch = file;
    const old = R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1');
    if (during) await during(old);
    if (oldOutlives) return; // the old tool is still running; the new launcher has not started
    if (old) R.removeRun(path.join(runsDir(), `${old.runId}.json`));
    if (duringWindow) { await duringWindow(); return; } // the window is open (old gone, new not written); the test lands it
    if (gapMs) { setTimeout(() => landNew(file), gapMs); return; } // the new launcher's record lands later: a window
    landNew(file);
    // The real launcher resolves the respawn only once the new process is up, so the new record already exists when
    // the move's done() runs: a press here (the window has closed, the new record is present) races with done().
    if (duringAfterNew) await duringAfterNew();
  },
};
function landNew(file) {
  const l = L.takeLaunch(file);
  const [profile, ...rest] = l.argv;
  const { file: f, run } = R.createRun({ profile, cwd: l.cwd, carryArgs: [], conversation: conversationOf(rest), hand: l.hand || null });
  fs.writeFileSync(f, JSON.stringify({ ...readRun(f), sessionId: CONV, status: 'waiting' }));
  giveHold(run.runId);
}
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
const current = () => R.listRuns({ usage: false }).find((r) => r.termId === 'pty-1') || null;
function giveHold(runId) {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(path.join(hookSettingsDir(), `${runId}.json`), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'hoprig-hook' }] }] } }));
}
function session(entry, project) {
  for (const r of R.listRuns({ usage: false })) R.removeRun(path.join(runsDir(), `${r.runId}.json`));
  const { file, run } = R.createRun({ profile: 'work', cwd: SHOP, conversation: CONV });
  fs.writeFileSync(file, JSON.stringify({ ...run, sessionId: CONV, status: 'waiting', termName: 'shop', handsOffRow: 2 }));
  giveHold(run.runId);
  saveConfig({ ...BASE, handsOff: { offered: true, sessions: { [run.runId]: { ...entry, version: V, at: 1_700_000_000_000 } }, ...(project !== undefined ? { projects: { [SHOP]: { on: project, version: V, at: 1_600_000_000_000, note: '' } } } : {}) } });
  return run.runId;
}
const QUESTION = { hook_event_name: 'PermissionRequest', session_id: CONV, permission_mode: 'default', cwd: SHOP, tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which test runner should this project use?', header: 'Runner', multiSelect: false, options: [{ label: 'node:test (Recommended)', description: 'Built in.' }, { label: 'vitest', description: 'Fast.' }] }] } };
const asks = (id) => spawnSync(process.execPath, [hookFile()], { input: JSON.stringify(QUESTION), env: { ...process.env, HOPRIG_RUN_FILE: path.join(runsDir(), `${id}.json`), CLAUDE_PROJECT_DIR: SHOP }, encoding: 'utf8' }).stdout;

test('Off pressed while the move waits reaches the new run, which then answers nothing', OFFERED, async () => {
  const from = session({ on: true });
  let pressed = null;
  during = async () => {
    const r = await call('POST', '/api/handsoff/session', { name: 'shop', on: false });
    pressed = r.status;
  };
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { during = null; }
  assert.equal(pressed, 200, 'the press was accepted during the move');
  const now = current();
  assert.notEqual(now.runId, from, 'a new run');
  const ho = loadConfig().handsOff;
  assert.equal(ho.sessions[now.runId].on, false, 'the new run carries the owner\'s Off, pressed during the move');
  assert.equal(from in ho.sessions, false, 'nothing left under the old id');
  assert.equal('moving' in ho, false, 'the moving mark is gone');
  // The new run, set Off by the owner during the move, answers nothing.
  assert.equal(asks(now.runId), '', 'the moved session answers nothing after the owner pressed Off');
});

test('while the old launcher\'s record is still there, its entry and the moving mark stay; a sweep is left to clear them', OFFERED, async () => {
  const from = session({ on: false }, true); // own Off under a project that is On: the old tool must stay unanswered
  assert.equal(asks(from), '', 'before the move its own Off keeps it unanswered');
  oldOutlives = true;
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { oldOutlives = false; }
  const ho = loadConfig().handsOff;
  assert.equal(ho.sessions[from].on, false, 'the old id\'s Off entry is kept while its record is still there');
  assert.ok(ho.moving && from in ho.moving, 'the moving mark is kept while the old record is there');
  // The old tool, still running with the owner's Off, answers nothing (its entry is kept and the mark silences it).
  assert.equal(asks(from), '', 'the dying tool does not start following the project\'s On');
});

// The move has returned (done() ran) but the old launcher's record is still there, so the page still finds the old
// run: an Off pressed now must reach the run the move handed the session to, which then answers nothing.
test('Off pressed after the move returned, while the old record is still there, reaches the new run', OFFERED, async () => {
  const from = session({ on: true });
  oldOutlives = true;
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { oldOutlives = false; }
  assert.equal(current().runId, from, 'the page still finds the old record');
  const press = await call('POST', '/api/handsoff/session', { name: 'shop', on: false });
  assert.equal(press.status, 200);
  // The old launcher ends now, and the new one writes its record from the launch file.
  R.removeRun(path.join(runsDir(), `${from}.json`));
  const l = L.takeLaunch(lastLaunch);
  const [profile, ...rest] = l.argv;
  const { file: f, run } = R.createRun({ profile, cwd: l.cwd, carryArgs: [], conversation: conversationOf(rest), hand: l.hand || null });
  fs.writeFileSync(f, JSON.stringify({ ...readRun(f), sessionId: CONV, status: 'waiting' }));
  giveHold(run.runId);
  assert.notEqual(run.runId, from, 'a new run');
  assert.equal(loadConfig().handsOff.sessions[run.runId].on, false, 'the new run carries the Off pressed after the move');
  assert.equal(asks(run.runId), '', 'the moved session answers nothing after the owner pressed Off');
});

// A moving mark is kept while the old record is there (above). Once that record has gone the mark silences nothing,
// so the next press on a session's switch drops it, not only the next dashboard start.
test('a moving mark whose old record has gone is dropped at the next press on a session\'s switch', OFFERED, async () => {
  const from = session({ on: false }, true);
  oldOutlives = true;
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { oldOutlives = false; }
  assert.ok(from in loadConfig().handsOff.moving, 'kept while the old record is there');
  R.removeRun(path.join(runsDir(), `${from}.json`));
  const l = L.takeLaunch(lastLaunch);
  const [profile, ...rest] = l.argv;
  const { file: f, run } = R.createRun({ profile, cwd: l.cwd, carryArgs: [], conversation: conversationOf(rest), hand: l.hand || null });
  fs.writeFileSync(f, JSON.stringify({ ...readRun(f), sessionId: CONV, status: 'waiting' }));
  giveHold(run.runId);
  assert.equal((await call('POST', '/api/handsoff/session', { name: 'shop', on: false })).status, 200);
  const ho = loadConfig().handsOff;
  assert.equal('moving' in ho, false, 'the mark of the gone record is dropped');
  assert.equal(from in ho.sessions, false, 'and so is the entry of the gone record');
  assert.equal(ho.sessions[run.runId].on, false);
});

test('a press during the move window, where no run record exists yet, waits for the new run and is not 404', OFFERED, async () => {
  const from = session({ on: true });
  gapMs = 600; // the new launcher's record lands 600 ms after respawn returns: a window with no record
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
    assert.equal(current(), null, 'no run record during the move window');
    const press = await call('POST', '/api/handsoff/session', { name: 'shop', on: false });
    assert.equal(press.status, 200, 'the press waits for the new run instead of answering 404');
  } finally { gapMs = 0; }
  const now = current();
  assert.ok(now && now.runId !== from, 'a new run');
  assert.equal(loadConfig().handsOff.sessions[now.runId].on, false, 'the Off pressed during the window reached the new run');
  assert.equal(asks(now.runId), '', 'the moved session answers nothing after the owner pressed Off');
});

test('Off pressed once the new record exists but before the move is done reaches the new run, not lost', OFFERED, async () => {
  const from = session({ on: true });
  let pressed = null;
  let newId = null;
  duringAfterNew = async () => {
    newId = current()?.runId; // the new launcher's record is there; the old one is gone (the window has closed)
    pressed = (await call('POST', '/api/handsoff/session', { name: 'shop', on: false })).status;
  };
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { duringAfterNew = null; }
  assert.equal(pressed, 200, 'the press was accepted');
  const now = current();
  assert.equal(now.runId, newId, 'the new run');
  const ho = loadConfig().handsOff;
  assert.ok(ho.sessions && ho.sessions[now.runId], 'the new run has an entry of its own (the press is not lost)');
  assert.equal(ho.sessions[now.runId].on, false, 'it carries the Off the owner pressed during the move');
  assert.equal(from in ho.sessions, false, 'nothing left under the old id');
  assert.equal(asks(now.runId), '', 'the moved session answers nothing after the owner pressed Off');
});

test('Off pressed in the window, before the new record, waits then reaches the new run (not lost to the move\'s done)', OFFERED, async () => {
  const from = session({ on: true });
  let status = null;
  duringWindow = async () => {
    // Old record gone, new not written: the press finds no run and waits (server/handsoff.mjs). It must not 404, and
    // once the new record lands and the press writes, the move's done() must not throw its Off away.
    const p = call('POST', '/api/handsoff/session', { name: 'shop', on: false }).then((r) => { status = r.status; });
    await new Promise((r) => setTimeout(r, 300)); // the press starts and begins waiting for the new run
    landNew(lastLaunch); // the new launcher's record appears; the press's wait ends and it writes
    await p;
  };
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { duringWindow = null; }
  assert.equal(status, 200, 'the press waited for the new run, not 404');
  const now = current();
  assert.notEqual(now.runId, from, 'a new run');
  const ho = loadConfig().handsOff;
  assert.equal(ho.sessions[now.runId].on, false, 'the Off pressed in the window reached the new run');
  assert.equal(from in ho.sessions, false, 'nothing left under the old id');
  assert.equal(asks(now.runId), '', 'the moved session answers nothing after the owner pressed Off');
});

// Point 3: two presses inside one move must let the LAST one win. done() picks the entry written latest by its `at`
// (when the switch route wrote it). A guard in both orders: Off-then-On and On-then-Off, each with the last press on
// the new id equal to the carried value. (The prior code compared the whole entry — `at` included — against the
// carried value, so a fresh press already differed and won; this reconciliation reads the write time directly, the
// same result stated plainly, so the guard holds under both.)
test('two presses in one move: the last press wins when it equals the carried value (Off on the old id, then On on the new)', OFFERED, async () => {
  const from = session({ on: true }); // the move carries On (had.at = 1_700_000_000_000)
  let newId = null;
  duringAfterNew = async () => {
    newId = current().runId;
    const ho = loadConfig().handsOff;
    // Off first, on the old id; On later, on the new id — and On equals the carried value.
    saveConfig({ handsOff: { ...ho, sessions: { ...ho.sessions, [from]: { on: false, version: V, at: 1_700_000_001_000 }, [newId]: { on: true, version: V, at: 1_700_000_002_000 } } } });
  };
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { duringAfterNew = null; }
  const now = current();
  assert.equal(now.runId, newId, 'the new run');
  const ho = loadConfig().handsOff;
  assert.equal(ho.sessions[now.runId].on, true, 'the new run carries On — his last press — not the earlier Off');
  assert.equal(from in ho.sessions, false, 'nothing left under the old id');
});

test('two presses in one move, the other way: the last press wins (On on the old id, then Off on the new)', async () => {
  const from = session({ on: false }); // the move carries Off
  let newId = null;
  duringAfterNew = async () => {
    newId = current().runId;
    const ho = loadConfig().handsOff;
    saveConfig({ handsOff: { ...ho, sessions: { ...ho.sessions, [from]: { on: true, version: V, at: 1_700_000_001_000 }, [newId]: { on: false, version: V, at: 1_700_000_002_000 } } } });
  };
  try {
    assert.equal((await call('POST', '/api/sessions/shop/switch', { profile: 'backup' })).status, 200);
  } finally { duringAfterNew = null; }
  const ho = loadConfig().handsOff;
  assert.equal(ho.sessions[current().runId].on, false, 'the new run carries Off — his last press — not the earlier On');
});
