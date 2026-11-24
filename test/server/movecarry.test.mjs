// A move of the dashboard's carries Hands-off's stops (src/launchfile.mjs HAND, src/runs.mjs createRun): the launch file
// may hold a hand-over { from, runId, conversation, carry }, checked strictly; the new record takes the run id the
// dashboard chose and the stops and the count of the run it came from, only for the conversation the move carries on.
// A launch file without it is exactly the old shape and starts as before.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('movecarry');
test.after(() => box.cleanup());
const L = await import('../../src/launchfile.mjs');
const R = await import('../../src/runs.mjs');
const { runsDir } = await import('../../src/paths.mjs');

const CONV = crypto.randomUUID();
const DONE = [{ at: 1_700_000_000_000, kind: 'question', question: 'Which runner?', text: 'node:test (Recommended)', because: 'recommended' }];
const good = () => ({ from: 'mabc123-111', runId: 'mabc124-222', conversation: CONV, carry: { stop: 'hour', row: 2, done: DONE } });

test('the old shape: no hand-over is written, read or kept', () => {
  const file = L.writeLaunch({ cwd: box.root, argv: ['work'] }, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, cwd: box.root, argv: ['work'], at: 5 });
  assert.deepEqual(L.takeLaunch(file), { cwd: box.root, argv: ['work'] });
});

test('a hand-over goes through the file whole and comes back once', () => {
  const file = L.writeLaunch({ cwd: box.root, argv: ['work', '--resume', CONV], hand: good() });
  assert.deepEqual(L.takeLaunch(file).hand, good());
  // applyLaunch keeps it in the launcher's memory only: no environment variable holds it, and it is taken once.
  const again = L.writeLaunch({ cwd: box.root, argv: ['work'], hand: good() });
  const argv = ['node', 'hoprig', L.LAUNCH_FLAG, again];
  const env = JSON.stringify(process.env);
  const cwd = process.cwd();
  L.applyLaunch(argv);
  process.chdir(cwd);
  assert.deepEqual(argv, ['node', 'hoprig', 'work']);
  assert.equal(JSON.stringify(process.env).includes('mabc124-222'), false);
  assert.deepEqual(L.takeHand(), good());
  assert.equal(L.takeHand(), null, 'taken once');
});

test('every bad shape of the hand-over refuses the start, as a bad file does', () => {
  const bad = [
    null, 'x', [], { ...good(), extra: 1 },
    { ...good(), from: '../x' }, { ...good(), runId: 'a/b' }, { ...good(), runId: good().from }, { ...good(), from: 7 },
    { ...good(), conversation: 'not-an-id' }, { ...good(), carry: null }, { ...good(), carry: [] },
    { ...good(), carry: { stop: 'forever' } }, { ...good(), carry: { row: 0 } }, { ...good(), carry: { row: -1 } }, { ...good(), carry: { row: 1.5 } },
    { ...good(), carry: { done: [] } }, { ...good(), carry: { done: 'x' } }, { ...good(), carry: { done: [{ text: 'no time' }] } },
    { ...good(), carry: { done: Array.from({ length: 11 }, () => DONE[0]) } }, { ...good(), carry: { done: [{ at: 1, nested: { a: 1 } }] } },
    { ...good(), carry: { on: true } },
  ];
  for (const h of bad) {
    assert.throws(() => L.writeLaunch({ cwd: box.root, argv: [], hand: h || { x: 1 } }), /shape/, JSON.stringify(h));
    // Written by hand, past writeLaunch's own check: takeLaunch refuses it with its one sentence.
    const file = path.join(L.launchDir(), `${crypto.randomBytes(16).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify({ v: 1, cwd: box.root, argv: [], at: 1, hand: h }), { mode: 0o600 });
    assert.throws(() => L.takeLaunch(file), L.LaunchError, JSON.stringify(h));
  }
});

test('createRun takes the chosen run id and the carry, for the conversation the move carries on', () => {
  const { file, run } = R.createRun({ profile: 'backup', cwd: box.root, conversation: CONV, hand: good() });
  assert.equal(run.runId, 'mabc124-222');
  assert.equal(file, path.join(runsDir(), 'mabc124-222.json'));
  assert.equal(run.handsOffStop, 'hour');
  assert.equal(run.handsOffRow, 2);
  assert.deepEqual(run.handsOffDone, DONE);
  R.removeRun(file);
});

test('createRun copies nothing for another conversation, and never takes the id of a record that is there', () => {
  const other = R.createRun({ profile: 'backup', cwd: box.root, conversation: crypto.randomUUID(), hand: good() });
  assert.equal(other.run.runId, 'mabc124-222', 'the id is the dashboard\'s');
  for (const k of ['handsOffStop', 'handsOffRow', 'handsOffDone']) assert.equal(k in other.run, false, k);
  // The id is taken now: a second start with the same hand-over writes a record of its own, carrying nothing.
  const second = R.createRun({ profile: 'backup', cwd: box.root, conversation: CONV, hand: good() });
  assert.notEqual(second.run.runId, 'mabc124-222');
  for (const k of ['handsOffStop', 'handsOffRow', 'handsOffDone']) assert.equal(k in second.run, false, k);
  R.removeRun(other.file);
  R.removeRun(second.file);
  // No conversation named (a new one, -c): nothing is carried either.
  const none = R.createRun({ profile: 'backup', cwd: box.root, conversation: null, hand: good() });
  for (const k of ['handsOffStop', 'handsOffRow', 'handsOffDone']) assert.equal(k in none.run, false, k);
  R.removeRun(none.file);
});

test('the launcher\'s own move (its kept record) carries as before, and the hand-over is not read then', () => {
  const { file } = R.createRun({ profile: 'work', cwd: box.root, conversation: CONV });
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), handsOffStop: 'loop', handsOffRow: 3 }));
  const { run } = R.createRun({ profile: 'backup', cwd: box.root, conversation: CONV, file, hand: good() });
  assert.equal(run.runId, path.basename(file, '.json'));
  assert.equal(run.handsOffStop, 'loop');
  assert.equal(run.handsOffRow, 3);
  assert.equal('handsOffDone' in run, false);
  R.removeRun(file);
});

test('a reset hand starts the new run with its answers stopped (a resume the dashboard could not carry)', () => {
  // handOk takes a reset hand; a malformed one is refused.
  assert.equal(L.handOk({ reset: true }), true);
  assert.equal(L.handOk({ reset: false }), false);
  assert.equal(L.handOk({ reset: true, from: 'mabc123-111' }), false);
  assert.equal(L.handOk({ reset: 1 }), false);
  // It rides the launch file whole and comes back once.
  const file = L.writeLaunch({ cwd: box.root, argv: ['work', '--resume', CONV], hand: { reset: true } });
  assert.deepEqual(L.takeLaunch(file).hand, { reset: true });
  // createRun sets handsOffStop 'reset' (the answers stop; the wall still holds by the switch — hook.mjs preToolHold).
  const { run } = R.createRun({ profile: 'work', cwd: box.root, conversation: CONV, hand: { reset: true } });
  assert.equal(run.handsOffStop, 'reset');
  // Not on a relaunch of the same record (a reset is a fresh resume, not a re-run of the launcher).
  const first = R.createRun({ profile: 'work', cwd: box.root, conversation: crypto.randomUUID() });
  const relaunch = R.createRun({ profile: 'backup', cwd: box.root, conversation: CONV, file: first.file, hand: { reset: true } });
  assert.notEqual(relaunch.run.handsOffStop, 'reset');
});
