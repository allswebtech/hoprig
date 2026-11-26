// A box a dashboard started keeps running when that dashboard is killed (bwrap is detached). Its run lock
// now records the box's own process group; a later run of the same worktree finds the box still alive by that group
// and ends it by the group id (never by a name) before it claims the worktree, so the two never overlap.
//
// This exercises the mission-layer mechanism without the real box: a detached child stands in for the orphaned box
// (its pid is its own process group), and a lock with a long-dead owner pid plus that group stands in for what a
// killed dashboard left behind. Without the change, waitIdle reads the dead owner, calls the worktree free at once,
// and leaves the stand-in box running (an overlap); with it, the group is ended first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boxorphan-'));
process.env.HOPRIG_STATE_DIR = path.join(root, 'state');
process.env.HOPRIG_CONFIG_DIR = path.join(root, 'config');
process.env.HOPRIG_WORKSPACE_DIR = path.join(root, 'ws');
const { waitIdle, runsNow } = await import('../../src/mission/boxed.mjs');
const { stateDir } = await import('../../src/paths.mjs');
const { system: ident } = await import('../../src/procid.mjs');
const { earlierIdentity } = await import('../server/helpers.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const lockOf = (tree) => path.join(stateDir(), 'mission-runs', `${crypto.createHash('sha256').update(tree).digest('hex').slice(0, 24)}.lock`);
// The box runs on Linux and macOS only, and Windows has no process groups: a box a dead dashboard left cannot be there.
const skip = process.platform === 'win32' && 'Windows has no box and no process groups: no box can outlive its dashboard there';
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('a box left by a dead dashboard is ended by its group id before the worktree is free; no overlap (20 tries)', { skip, timeout: 60_000 }, async () => {
  assert.ok(stateDir().startsWith(root), 'the state folder is isolated to this test');
  const groups = [];
  let overlaps = 0;
  try {
    for (let i = 0; i < 20; i += 1) {
      const tree = fs.mkdtempSync(path.join(root, 'tree-'));
      // A detached child is its own process group: it stands in for the box an earlier run started.
      const box = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      groups.push(box);
      await new Promise((r) => setTimeout(r, 60));
      const lock = lockOf(tree);
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      // The dashboard that made this lock is long gone (its pid is dead), but its box group still runs.
      // It recorded the box's leader as it was then (its pid and start), as setGroup does.
      fs.writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000 + i, ident: null, group: box.pid, groupIdent: ident.of([box.pid]).get(box.pid) }));
      assert.equal(runsNow(tree), false, 'a lock whose owner dashboard is gone is not counted as a live run');
      const free = await waitIdle(tree, 5000);
      assert.equal(free, true, 'the worktree is freed');
      if (groupAlive(box.pid)) overlaps += 1; // the box was still running when the worktree was called free: an overlap
    }
    assert.equal(overlaps, 0, 'no try left the orphaned box running once the worktree was declared free');
  } finally {
    for (const g of groups) { try { process.kill(-g.pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
});

// The group id a dead dashboard recorded can be handed out again by the system once its box ended. A lock whose group
// id now leads another process (here: a process of this test's own whose start is not the recorded one) is not the box:
// it is never signalled, and the lock is taken as free. One whose leader cannot be told (no identity recorded) is not
// signalled either: the worktree waits.
test('a group id that now belongs to another process is never signalled; one that cannot be told waits', { skip, timeout: 60_000 }, async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 60));
    const now = ident.of([other.pid]).get(other.pid);
    assert.ok(now, 'this system tells when a process of this test\'s started (/proc, or ps on macOS)');
    // What the dead dashboard's box was: the same id, an earlier start (another process that had this id before), in
    // this system's own form (L: on Linux, T: on macOS).
    const before = earlierIdentity(now);
    for (const [i, rec] of [{ groupIdent: before }, { groupIdent: null }, {}].entries()) {
      const tree = fs.mkdtempSync(path.join(root, 'reused-'));
      const lock = lockOf(tree);
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, JSON.stringify({ pid: 2_000_000_100 + i, ident: null, group: other.pid, ...rec }));
      const free = await waitIdle(tree, 600, 50);
      assert.ok(groupAlive(other.pid), `the other process was not signalled (${JSON.stringify(rec)})`);
      if (rec.groupIdent) assert.equal(free, true, 'another process leads that group now: the box is gone, the worktree is free');
      else {
        assert.equal(free, false, 'the leader cannot be told: nothing is signalled and the worktree waits');
        assert.equal(runsNow(tree), true);
      }
    }
  } finally {
    try { process.kill(-other.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
