// A command Tia runs (src/assistant/ops.mjs runShell) ended at its time limit as one tree (src/cmdtree.mjs): with the
// answers of Windows handed in, and once for real on Windows only: the shell, the Node child it started, and nothing
// else (a process of this test beside them lives on). On Windows the shell alone used to be ended: the child it started
// went on, holding the output pipes, so the answer never came.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { runShell } = await import('../../src/assistant/ops.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opstree-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const left = []; // processes a failure part way left, ended before the folder goes (Windows cannot remove it then)
test.after(async () => {
  for (const p of left) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* ended, as it should be */
    }
  }
  for (let i = 0; i < 50 && left.some(alive); i++) await sleep(100);
  fs.rmSync(root, { recursive: true, force: true, ...(process.platform === 'win32' ? { maxRetries: 10, retryDelay: 100 } : {}) });
});

/** A stand-in child of spawn: its output streams, its pid, ended when told. */
function fakeChild() {
  const c = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
  c.stop = () => {
    c.signalCode = 'SIGKILL';
    c.emit('close', null, 'SIGKILL');
  };
  c.killed = [];
  // Its own handle: it ends (exit), while what it started may still hold its output (no close).
  c.kill = (sig) => {
    c.killed.push(sig);
    setImmediate(() => ((c.signalCode = sig), c.emit('exit', null, sig)));
    return true;
  };
  return c;
}

for (const platform of ['win32', 'linux']) {
  test(`at its time limit a command is ended as one tree, the command known to run (${platform})`, async () => {
    const ends = [];
    let child;
    let opts;
    const spawnImpl = (cmd, args, o) => ((opts = o), (child = fakeChild()));
    const end = (rootProc, sig, o) => {
      ends.push([rootProc.pid, typeof rootProc.alive === 'function' ? rootProc.alive() : rootProc.alive, Number.isFinite(rootProc.start), sig, o.platform]);
      assert.equal(typeof rootProc.killRoot, 'function', 'it is handed its own handle to end it by');
      setImmediate(child.stop);
      return { ok: true, rest: Promise.resolve([]) };
    };
    const r = await runShell('npm test', { cwd: root, timeoutMs: 30, platform, spawnImpl, end });
    assert.equal(r.timedOut, true);
    assert.deepEqual(ends, [[4242, true, true, 'SIGKILL', platform]], 'its tree, never the shell alone');
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'], 'its output still comes through pipes: how it starts is unchanged');
    assert.equal(opts.detached, platform !== 'win32');
  });
}

test('a command whose processes cannot be read at its time limit: the shell is ended, the answer comes and says so', async () => {
  const { endTree, TREE_UNSURE } = await import('../../src/cmdtree.mjs');
  let child;
  const killed = [];
  const spawnImpl = () => (child = fakeChild());
  // Windows: the processes cannot be read (twice); the shell ends, what it started keeps the output pipes open.
  const end = (root, sig, o) => endTree(root, sig, { ...o, kill: (p, s) => killed.push([p, s]), table: async () => null, wait: async () => {} });
  const r = await runShell('npm test', { cwd: root, timeoutMs: 30, platform: 'win32', spawnImpl, end });
  assert.equal(r.timedOut, true);
  assert.ok(r.output.endsWith(`(${TREE_UNSURE})`), r.output);
  assert.deepEqual(child.killed, ['SIGKILL'], 'the shell itself, through its own handle');
  assert.deepEqual(killed, [], 'nothing by its number');
});

const skip = process.platform !== 'win32' && 'Windows only: on Linux and macOS the command has always been ended as its process group';

test('on Windows a timed-out command ends with the Node child its shell started; a process beside them lives', { skip, timeout: 60_000 }, async () => {
  const pidFile = path.join(root, 'sleeper.pid');
  const sleeper = path.join(root, 'sleeper.js');
  fs.writeFileSync(sleeper, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);\n`);
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  left.push(bystander.pid);
  let shell = 0;
  // The shell by its name (the product names it by its full path, %ComSpec%): the same program and arguments.
  const spawnImpl = (cmd, args, o) => {
    const c = spawn('cmd.exe', args, o);
    shell = c.pid;
    return c;
  };
  const t0 = Date.now();
  const r = await Promise.race([runShell(`node "${sleeper}"`, { cwd: root, timeoutMs: 4000, spawnImpl }), sleep(30_000).then(() => null)]);
  const sleeperPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  if (sleeperPid) left.push(sleeperPid);
  for (let i = 0; i < 50 && sleeperPid && (alive(sleeperPid) || alive(shell)); i++) await sleep(100);
  console.log(`WINDIAG opstree: the shell ${shell}, its Node child ${sleeperPid || 'never started'}, the answer ${r ? `came after ${Date.now() - t0} ms (timed out ${r.timedOut})` : 'did not come within 30 s'}; alive after the end: shell ${alive(shell)}, child ${sleeperPid ? alive(sleeperPid) : '-'}, a process beside them ${alive(bystander.pid)}`);
  assert.ok(sleeperPid, 'the Node child started before the time limit');
  assert.ok(r, 'the answer came: nothing of the command holds its output any more');
  assert.equal(r.timedOut, true);
  assert.deepEqual([alive(shell), alive(sleeperPid)], [false, false], 'the shell and the Node child it started are gone');
  left.splice(left.indexOf(sleeperPid), 1); // seen gone: its pid may be another process's from now on
  assert.equal(alive(bystander.pid), true, 'a process beside them lives on');
  bystander.kill();
  await new Promise((r) => (bystander.exitCode !== null || bystander.signalCode !== null ? r() : bystander.once('exit', r)));
  left.splice(left.indexOf(bystander.pid), 1);
});
