// The tree end of a run by itself on a REAL Windows (src/work/alone.mjs endWinTree), the one test of it that does not
// run on made-up answers: a Node root (as cmd.exe of the npm shim stands for the run), its child and its grandchild
// are ended through the same function a run uses (the root through its own child handle, the two below it in the one
// plain-.NET end call that compares each start first), and a bystander the test started beside them keeps running.
// It prints one line per process starting with "WINDIAG alone:", with its start read both ways: the table's
// (Win32_Process CreationDate through System.Management) and the end call's (Process.StartTime), so a run on the real
// runner shows whether the two are the same number. Elsewhere it is skipped: it needs Windows' own PowerShell.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const WINDOWS = process.platform === 'win32';
const { endWinTree, parseRunTree, runTreeScript } = await import('../../src/work/alone.mjs');
const { creationScript } = await import('../../src/procid.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
/** One Windows PowerShell call of `script` (no profile, as the product calls it) → its stdout, or '' when it fails. */
const ps = (script) => new Promise((resolve) => {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  execFile('powershell.exe', args, { timeout: 60_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
});
const until = async (what, ok, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (ok()) return;
  assert.fail(`not within ${ms / 1000} s: ${what}`);
};

test('a real Windows tree of a root, its child and its grandchild is ended through the run tree end; a bystander lives', { skip: !WINDOWS && 'a real Windows test: it runs PowerShell and ends a tree of its own Node processes', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alone-real-'));
  const pids = path.join(dir, 'pids.txt');
  // The child starts the grandchild and writes both pids; each waits a minute (the test ends them long before).
  const grandchild = 'setTimeout(() => {}, 60000)';
  const child = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + c.pid); setTimeout(() => {}, 60000)`;
  const rootScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000)`;
  const root = spawn(process.execPath, ['-e', rootScript], { stdio: 'ignore', windowsHide: true });
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  let childPid = null;
  let grandPid = null;
  try {
    await until('the child wrote its pid and its grandchild pid', () => fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').trim().split(' ').length === 2);
    [childPid, grandPid] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    const all = [['root', root.pid], ['child', childPid], ['grandchild', grandPid], ['bystander', bystander.pid]];

    // The starts read both ways, before anything is ended.
    const snap = parseRunTree(await ps(runTreeScript(root.pid)));
    assert.ok(snap, 'the table of the run could be read');
    const net = new Map();
    for (const line of (await ps(creationScript(all.map(([, p]) => p)))).split(/\r?\n/)) {
      const m = /^(\d+) (\d+)$/.exec(line.trim());
      if (m) net.set(Number(m[1]), Number(m[2]));
    }
    for (const [name, pid] of all) {
      const t = snap.procs.get(pid)?.start ?? null;
      const n = net.get(pid) ?? null;
      console.log(`WINDIAG alone: ${name} pid ${pid} table ${t} net ${n} table-net ${t !== null && n !== null ? t - n : 'unknown'}`);
    }

    const gone = () => root.exitCode !== null || root.signalCode !== null;
    const t0 = Date.now();
    const res = await endWinTree(root.pid, { gone, start: net.get(root.pid) ?? null, endRoot: () => root.kill() });
    console.log(`WINDIAG alone: end ${JSON.stringify(res)} in ${Date.now() - t0} ms`);
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const p of [grandPid, childPid, root.pid]) assert.ok(res.ended.includes(p), `process ${p} is counted as ended: ${JSON.stringify(res)}`);
    await until('the root, the child and the grandchild are gone', () => !alive(root.pid) && !alive(childPid) && !alive(grandPid));
    assert.ok(alive(bystander.pid), 'the bystander, beside the tree and not below it, still runs');
  } finally {
    for (const p of [grandPid, childPid]) if (p && alive(p)) try { process.kill(p); } catch { /* gone */ }
    root.kill();
    bystander.kill();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
