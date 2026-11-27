// The keeper (src/keeper/keep.mjs): every rule with its bound. Nothing here reaches a real service, dashboard or push
// address: the service files, the start, the health look and the push are all handed in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DAY, announceNote, beginUpdate, canRollBack, clearStopped, confirmStart, isStopped, keep, keeperDir, markStopped, markVerified,
  prepareUpdate, readNote, refreshFiles, readUpdate, startCheck, undoUpdate,
} from '../../src/keeper/keep.mjs';

const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-test-'));
  made.push(d);
  return d;
};
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A made-up installed product in `dir/lib/node_modules/hoprig` at `version`. */
function install(dir, version, extra = {}) {
  const root = path.join(dir, 'lib', 'node_modules', 'hoprig');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hoprig', version }));
  fs.writeFileSync(path.join(root, 'src', 'main.mjs'), `// ${version}\n`);
  for (const [f, t] of Object.entries(extra)) fs.writeFileSync(path.join(root, f), t);
  return root;
}

/** The pieces of one look: a service that is up only when `upWhen()` says so, and records. */
function rig({ state, upWhen = () => false, files = [], push = [] } = {}) {
  const calls = [];
  let t = Date.now();
  return {
    calls,
    deps: {
      state, now: () => t, sleep: async (ms) => { t += ms; }, waitMs: 3000, step: 1000, grace: 20_000, settle: 0,
      files: () => files,
      reload: async () => calls.push('reload'),
      start: async () => calls.push('start'),
      answers: async () => upWhen(calls),
      push: async (text) => push.push(text),
    },
    clock: { set: (v) => { t = v; }, get: () => t, add: (ms) => { t += ms; } },
  };
}

test('while the owner stopped Hoprig himself the keeper does nothing at all', async () => {
  const state = tmp();
  markStopped(state);
  const r = rig({ state, files: [{ file: path.join(state, 'x.service'), text: 'new' }] });
  assert.deepEqual(await keep({ ...r.deps, failed: true }), { did: 'stopped' });
  assert.deepEqual(r.calls, []);
  assert.ok(!fs.existsSync(path.join(state, 'x.service')), 'no file written');
  clearStopped(state);
  assert.equal(isStopped(state), false);
});

test('a dashboard that answers is left alone and an old episode ends', async () => {
  const state = tmp();
  const r = rig({ state, upWhen: () => true });
  fs.mkdirSync(keeperDir(state), { recursive: true });
  fs.writeFileSync(path.join(keeperDir(state), 'episode.json'), JSON.stringify({ downSince: 1, rewrites: 1, rollbacks: 1, started: 1, gaveUp: true }));
  assert.deepEqual(await keep(r.deps), { did: 'up' });
  assert.ok(!fs.existsSync(path.join(keeperDir(state), 'episode.json')));
  assert.deepEqual(r.calls, []);
});

test('a dashboard that has been down only a moment is waited for (the service manager is already restarting it)', async () => {
  const state = tmp();
  const r = rig({ state });
  assert.deepEqual(await keep(r.deps), { did: 'waiting' });
  assert.deepEqual(r.calls, []);
  r.clock.add(21_000);
  assert.notEqual((await keep(r.deps)).did, 'waiting', 'after the grace it acts');
});

test('a broken service file is written again, once, and the dashboard is started', async () => {
  const state = tmp();
  const file = path.join(state, 'units', 'hoprig.service');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'garbage');
  const r = rig({ state, files: [{ file, text: '[Service]\nExecStart=ok\n' }], upWhen: (calls) => calls.includes('start') });
  // The dashboard reads the note as it comes up, so it must be there before the start, not after.
  let noteAtStart = null;
  const out = await keep({ ...r.deps, failed: true, start: async () => { noteAtStart = fs.existsSync(path.join(keeperDir(state), 'note.json')); r.calls.push('start'); } });
  assert.equal(noteAtStart, true, 'the note is written before the start');
  assert.equal(out.did, 'rewrote');
  assert.equal(fs.readFileSync(file, 'utf8'), '[Service]\nExecStart=ok\n');
  assert.deepEqual(r.calls, ['reload', 'start']);
  const note = JSON.parse(fs.readFileSync(path.join(keeperDir(state), 'note.json'), 'utf8'));
  assert.equal(note.kind, 'mended');
  assert.equal(readNote(state), null, 'a mend that worked is an Activity line only, not a row');
});

test('a service file that is right is not written again, and a file that cannot help is tried only once', async () => {
  const state = tmp();
  const file = path.join(state, 'hoprig.service');
  fs.writeFileSync(file, 'same');
  const r = rig({ state, files: [{ file, text: 'same' }] });
  const a = await keep({ ...r.deps, failed: true });
  assert.equal(a.did, 'gaveup', 'nothing to rewrite, nothing to roll back; one start did not help');
  assert.deepEqual(r.calls, ['reload', 'start'], 'one plain start only');
  // The same episode again: it says nothing more and tries nothing more.
  const b = await keep({ ...r.deps, failed: true });
  assert.equal(b.did, 'quiet');
  assert.deepEqual(r.calls, ['reload', 'start']);
});

test('a bad file that does not help: one rewrite and then the rollback, one each, then it stops with one push', async () => {
  const state = tmp();
  // The kept version 0.3.5 and the update record.
  const old = install(state, '0.3.5', { 'old.txt': 'kept' });
  assert.equal(prepareUpdate({ root: old, version: '0.3.5', state }).ok, true);
  fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ version: '0.3.6' })); // the update changed it
  fs.rmSync(path.join(old, 'old.txt'));
  const file = path.join(state, 'hoprig.service');
  fs.writeFileSync(file, 'garbage');
  const pushed = [];
  const r = rig({ state, files: [{ file, text: 'fixed' }], push: pushed, upWhen: () => fs.existsSync(path.join(old, 'old.txt')) });
  const out = await keep({ ...r.deps, failed: true });
  assert.equal(out.did, 'rolledback');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixed', 'the file was written first');
  assert.equal(fs.readFileSync(path.join(old, 'old.txt'), 'utf8'), 'kept', 'the kept tree is back');
  assert.equal(r.calls.filter((c) => c === 'start').length, 2, 'one start after the rewrite, one after the rollback');
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /went back to 0\.3\.5 because 0\.3\.6 did not start/);
  assert.equal(readNote(state).kind, 'rollback', 'a rollback is a row');
  assert.equal(readUpdate(state).rolledBack, true);
  assert.equal(canRollBack({ state }), false, 'only one rollback');
});

test('a rollback is made only for an update under a day old that never passed its start check', async () => {
  const state = tmp();
  const cases = [
    ['verified', (u) => ({ ...u, verified: true })],
    ['older than a day', (u) => ({ ...u, at: u.at - DAY - 1000 })],
    ['already put back', (u) => ({ ...u, rolledBack: true })],
  ];
  for (const [name, change] of cases) {
    const dir = tmp();
    const root = install(dir, '0.3.5');
    assert.equal(prepareUpdate({ root, version: '0.3.5', state: dir }).ok, true);
    const f = path.join(keeperDir(dir), 'update.json');
    fs.writeFileSync(f, JSON.stringify(change(JSON.parse(fs.readFileSync(f, 'utf8')))));
    assert.equal(canRollBack({ state: dir }), false, name);
    const r = rig({ state: dir });
    assert.equal((await keep({ ...r.deps, failed: true })).did, 'gaveup', name);
    assert.equal(r.calls.length, 2, `${name}: only the plain start`);
  }
  assert.equal(canRollBack({ state }), false, 'no update at all');
});

test('giving up leaves a row, says what was tried, and pushes once', async () => {
  const state = tmp();
  const pushed = [];
  const r = rig({ state, push: pushed });
  assert.equal((await keep({ ...r.deps, failed: true })).did, 'gaveup');
  assert.equal(pushed.length, 1);
  await keep({ ...r.deps, failed: true });
  assert.equal(pushed.length, 1, 'one push, not one per look');
  const n = readNote(state);
  assert.equal(n.kind, 'gaveup');
  assert.match(n.text, /does not start.*started it; it did not help/);
  assert.match(fs.readFileSync(path.join(keeperDir(state), 'keeper.log'), 'utf8'), /does not start/);
});

test('the note becomes one Activity line at the next start; a row stays until an update passes its check', () => {
  const state = tmp();
  const lines = [];
  const activity = (e) => lines.push(e);
  fs.mkdirSync(keeperDir(state), { recursive: true });
  fs.writeFileSync(path.join(keeperDir(state), 'note.json'), JSON.stringify({ kind: 'rollback', text: 'Hoprig went back to 0.3.5 because 0.3.6 did not start.', at: Date.now(), told: false }));
  announceNote({ state, activity });
  announceNote({ state, activity });
  assert.equal(lines.length, 1, 'one line, not one per start');
  assert.match(lines[0].did, /went back to 0\.3\.5/);
  assert.equal(readNote(state).kind, 'rollback', 'the row stays');
  // A mend note is an Activity line and then gone.
  fs.writeFileSync(path.join(keeperDir(state), 'note.json'), JSON.stringify({ kind: 'mended', text: 'Hoprig started again.', at: Date.now(), told: false }));
  announceNote({ state, activity });
  assert.equal(lines.length, 2);
  assert.equal(fs.existsSync(path.join(keeperDir(state), 'note.json')), false);
  // A row older than a week is not shown.
  fs.writeFileSync(path.join(keeperDir(state), 'note.json'), JSON.stringify({ kind: 'gaveup', text: 'x', at: Date.now() - 8 * DAY, told: true }));
  assert.equal(readNote(state), null);
});

test('a start clears the owner stop and the episode; a new version up for a minute passes its start check and clears the row', () => {
  const state = tmp();
  markStopped(state);
  const root = install(state, '0.3.5');
  prepareUpdate({ root, version: '0.3.5', state });
  fs.mkdirSync(keeperDir(state), { recursive: true });
  fs.writeFileSync(path.join(keeperDir(state), 'episode.json'), '{}');
  fs.writeFileSync(path.join(keeperDir(state), 'note.json'), JSON.stringify({ kind: 'rollback', text: 'x', at: Date.now(), told: true }));
  confirmStart({ state, version: '0.3.5' });
  assert.equal(isStopped(state), false);
  assert.equal(fs.existsSync(path.join(keeperDir(state), 'episode.json')), false);
  confirmStart({ state, version: '0.3.5', verify: true });
  assert.equal(readUpdate(state).verified, false, 'the same version proves nothing');
  confirmStart({ state, version: '0.3.6', verify: true });
  assert.equal(readUpdate(state).verified, true);
  assert.equal(readNote(state), null, 'the row of a rollback goes when an update works');
  assert.equal(fs.existsSync(path.join(keeperDir(state), 'previous')), false, 'the kept copy is no longer kept');
  assert.equal(markVerified({ state }), false, 'once');
});

test('an update that cannot keep the running version aside does not start; only npm installs are swapped', () => {
  const state = tmp();
  const root = install(state, '0.3.5');
  assert.deepEqual(beginUpdate({ kind: 'git', root, version: '0.3.5', state }), { kept: false });
  assert.equal(readUpdate(state), null, 'a git checkout is never swapped');
  const bad = beginUpdate({ kind: 'npm', root, version: '0.3.5', state, copy: () => { throw new Error('disk full'); } });
  assert.equal(bad.kept, false);
  assert.match(bad.error, /disk full/);
  assert.equal(readUpdate(state), null);
  assert.deepEqual(beginUpdate({ kind: 'npm', root, version: '0.3.5', state }), { kept: true });
  assert.match(undoUpdate({ state }), /Version 0\.3\.5 is back/);
});

test('start check after an update: a new version that answers stays, one that does not goes back and says so', async () => {
  for (const answers of [true, false]) {
    const state = tmp();
    const root = install(state, '0.3.5');
    beginUpdate({ kind: 'npm', root, version: '0.3.5', state });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.6' }));
    fs.rmSync(path.join(root, 'src'), { recursive: true }); // a module removed: the half update
    const calls = [];
    const pushed = [];
    let t = 0;
    const out = await startCheck({ state, now: () => Date.now(), sleep: async (ms) => { t += ms; }, restart: async () => calls.push('restart'), answers: async () => answers, push: async (x) => pushed.push(x), waitMs: 3000, step: 1000 });
    if (answers) {
      assert.equal(out.did, 'ok');
      assert.deepEqual(calls, []);
      assert.ok(!fs.existsSync(path.join(root, 'src')), 'the new version was not touched');
    } else {
      assert.equal(out.did, 'rolledback');
      assert.deepEqual(calls, ['restart']);
      assert.ok(fs.existsSync(path.join(root, 'src', 'main.mjs')), 'the old version is back');
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.3.5');
      assert.equal(pushed.length, 1);
      assert.equal(readNote(state).kind, 'rollback');
      assert.ok(t >= 3000, 'it waited the whole time before it gave up on the new version');
    }
  }
  const state = tmp();
  assert.deepEqual(await startCheck({ state, answers: async () => false }), { did: 'none' }, 'no update, no check');
});

test('at a start the service files of an older install are written again, only when they differ, and read again only where that is safe', async () => {
  const dir = tmp();
  const a = path.join(dir, 'a.service');
  const b = path.join(dir, 'b.service');
  fs.writeFileSync(a, 'old');
  fs.writeFileSync(b, 'same');
  let reloads = 0;
  const files = () => [{ file: a, text: 'new' }, { file: b, text: 'same' }, { file: path.join(dir, 'sub', 'c.service'), text: 'made' }];
  assert.deepEqual((await refreshFiles({ files, reload: async () => reloads++ })).map((f) => path.basename(f)), ['a.service', 'c.service']);
  assert.equal(fs.readFileSync(a, 'utf8'), 'new');
  assert.equal(reloads, 1);
  assert.deepEqual(await refreshFiles({ files, reload: async () => reloads++ }), [], 'nothing differs the second time');
  assert.equal(reloads, 1, 'no reload when nothing was written');
  fs.writeFileSync(a, 'old');
  assert.equal((await refreshFiles({ files, reload: null })).length, 1, 'launchd: written, not loaded (that would end the running dashboard)');
});

test('started by the service manager at a failure, it first gives the dashboard the time to come back by itself', async () => {
  const state = tmp();
  let looks = 0;
  const r = rig({ state, files: [{ file: path.join(state, 'x.service'), text: 'new' }], upWhen: () => ++looks > 3 });
  const out = await keep({ ...r.deps, failed: true, settle: 10_000, step: 1000 });
  assert.equal(out.did, 'up');
  assert.deepEqual(r.calls, [], 'nothing started, nothing written');
  assert.ok(!fs.existsSync(path.join(state, 'x.service')));
  // One that stays down for the whole time is looked after.
  const r2 = rig({ state: tmp() });
  assert.equal((await keep({ ...r2.deps, failed: true, settle: 3000, step: 1000 })).did, 'gaveup');
});
