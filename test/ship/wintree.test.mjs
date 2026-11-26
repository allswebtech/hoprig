// On Windows for real: a command started the way a go-live starts it (src/ship/runcmd.mjs) outlives the process that
// started it (a dashboard that restarts), its output file goes on growing, and it is ended with what it started by
// its tree (src/cmdtree.mjs: by pid, never by a name). It prints one line "WINDIAG shipwin:" that says whether the
// command and a console program it started have a window (read, never a failure). Elsewhere this is skipped: on Linux
// and macOS the command has always been detached in a group of its own (runcmd.test.mjs, cut.test.mjs).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempShip } from './helpers.mjs';

const skip = process.platform !== 'win32' && 'Windows only: what it proves there (a command outlives its starter only when started detached) has always held on Linux and macOS';
const t = tempShip('ship-wintree');
test.after(() => t.cleanup());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Whether each process has a window: its main window handle (0: none), by .NET, so no PowerShell module loads. */
async function windows(pids) {
  const { POWERSHELL, NO_MODULE_PRELUDE, psArgs } = await import('../../src/server/platform/win32.mjs');
  const script = `${NO_MODULE_PRELUDE}foreach ($id in @(${pids.join(',')})) { try { $p = [System.Diagnostics.Process]::GetProcessById($id); [Console]::Out.WriteLine("$id " + [int64]$p.MainWindowHandle) } catch { [Console]::Out.WriteLine("$id gone") } }`;
  return new Promise((res) => execFile(POWERSHELL, psArgs(script), { timeout: 30_000, windowsHide: true }, (e, out) => res(e ? `not read (${e.code || e.message})` : String(out).trim().split(/\r?\n/).join(', '))));
}

test('a command outlives its starter, its output still grows, and it is ended by its tree', { skip, timeout: 90_000 }, async () => {
  const pidsFile = path.join(t.root, 'pids.json');
  // The command: a line every 100 ms, and a console program (cmd /c, a minute long) it starts as a deploy script would.
  const command = `const { spawn } = require('node:child_process');
const g = spawn('cmd', ['/c', 'ping -n 60 127.0.0.1 >nul'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ node: process.pid, cmd: g.pid }));
setInterval(() => console.log('still here ' + Date.now()), 100);`;
  const runcmd = new URL('../../src/ship/runcmd.mjs', import.meta.url).href;
  const starterCode = `const { runCommand } = await import(${JSON.stringify(runcmd)});
runCommand(['node', '-e', ${JSON.stringify(command)}], { cwd: ${JSON.stringify(t.root)}, minutes: 5 });
setInterval(() => {}, 1000);`;
  const t0 = Date.now();
  const starter = spawn(process.execPath, ['--input-type=module', '-e', starterCode], { stdio: 'ignore', windowsHide: true });
  let pids = null;
  let ended = false;
  try {
    for (let i = 0; i < 200 && !pids; i++) {
      await sleep(100);
      try {
        pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
      } catch {
        /* not yet */
      }
    }
    assert.ok(pids, 'the command started');
    const outDir = path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'output');
    const outFile = path.join(outDir, fs.readdirSync(outDir).find((n) => n.startsWith(`${starter.pid}-`)));
    // The starter ends as a dashboard that restarts does.
    starter.kill();
    await new Promise((r) => (starter.exitCode !== null ? r() : starter.once('exit', r)));
    await sleep(500);
    assert.equal(alive(pids.node), true, 'the command outlived the process that started it');
    const size = fs.statSync(outFile).size;
    await sleep(1000);
    assert.ok(fs.statSync(outFile).size > size, 'its output file still grows');
    console.log(`WINDIAG shipwin: windows of the command (node) and of the console program it started (cmd), pid and main window handle (0: none): ${await windows([pids.node, pids.cmd])}`);
    const { endTree, processTable, treeOf } = await import('../../src/cmdtree.mjs');
    // Everything of it now, read here: also what cmd started (ping), which no pid file names.
    const table = await processTable();
    const all = [pids.node, ...treeOf({ pid: pids.node, start: t0, alive: true }, table)];
    const rows = [...table].filter(([p, x]) => p === pids.node || x.ppid === pids.node || x.ppid === pids.cmd).map(([p, x]) => `${p} (parent ${x.ppid}, start ${x.start === null ? '?' : x.start - t0} ms)`);
    assert.ok(all.includes(pids.cmd), `the tree holds what the command started: ${all.join(', ')}; the table near it, starts from this test's t0: ${rows.join(', ') || 'none'}`);
    const end = endTree({ pid: pids.node, start: t0, alive: true }, 'SIGKILL');
    assert.equal(end.ok, true, 'the command was there to end');
    await end.rest;
    for (let i = 0; i < 100 && all.some(alive); i++) await sleep(100);
    assert.deepEqual(all.filter(alive), [], 'the command and everything it started are gone');
    ended = true;
  } finally {
    starter.kill();
    // Only after a failure part way: once they are gone their pids may be another process's.
    for (const p of pids && !ended ? [pids.node, pids.cmd] : []) {
      try {
        process.kill(p);
      } catch {
        /* gone */
      }
    }
  }
});

// The keeper of a go-live command's output (src/ship/outkeeper.mjs) on Windows: it gets the output file as its fourth
// handle (fd 3), lives while what the command left behind runs, empties the file past its limit (64 KiB), and goes on
// its own once nothing of the command is left (it looks every 30 s then). A WINDIAG keeper line says what it did.
test('the output keeper lives on Windows: what a server left by the command writes stays bounded, then it goes', { skip, timeout: 120_000 }, async () => {
  const sizes = path.join(t.root, 'sizes.txt');
  const serverPid = path.join(t.root, 'server.pid');
  // The server writes 1 MiB every 100 ms into the output it inherited, and says after each write how big that file is.
  const serverCode = `const fs = require('node:fs'); const b = Buffer.alloc(1 << 20, 120); fs.writeFileSync(${JSON.stringify(serverPid)}, String(process.pid));
process.stdout.on('error', () => {}); setInterval(() => { try { fs.writeSync(1, b); } catch {} fs.appendFileSync(${JSON.stringify(sizes)}, fs.fstatSync(1).size + '\\n'); }, 100);`;
  const command = ['node', '-e', `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(serverCode)}], { stdio: 'inherit', detached: true }); c.unref(); console.log('started');`];
  const { runCommand } = await import('../../src/ship/runcmd.mjs');
  const { endTree } = await import('../../src/cmdtree.mjs');
  const t0 = Date.now();
  let cmdPid = 0;
  const r = await runCommand(command, { cwd: t.root, minutes: 1, started: (c) => (cmdPid = c.pid) });
  const seen = () => (fs.existsSync(sizes) ? fs.readFileSync(sizes, 'utf8').trim().split(/\r?\n/).map(Number) : []);
  let server = 0;
  let done = false;
  try {
    assert.equal(r.ok, true, r.last);
    for (let i = 0; i < 50 && !fs.existsSync(serverPid); i++) await sleep(100);
    server = Number(fs.readFileSync(serverPid, 'utf8'));
    assert.ok(Number.isInteger(r.keeper), 'a keeper was started for the output the server goes on writing into');
    await sleep(300);
    const before = seen().at(-1) || 0;
    await sleep(1000);
    const lived = alive(r.keeper);
    const n = seen().length;
    await sleep(2000);
    const during = seen().slice(n);
    const most = Math.max(0, ...during);
    // Ended by the tree of the command (gone already): the server it left, found by its parent and start.
    const end = endTree({ pid: cmdPid, start: t0 }, 'SIGKILL');
    await end.rest;
    for (let i = 0; i < 50 && alive(server); i++) await sleep(100);
    const serverGone = !alive(server);
    const tEnd = Date.now();
    for (let i = 0; i < 400 && alive(r.keeper); i++) await sleep(100); // its look comes at most 30 s after the last
    const goneAfter = alive(r.keeper) ? null : Date.now() - tEnd;
    console.log(`WINDIAG keeper: pid ${r.keeper}, alive 1 s after its start ${lived}, the file ${before} bytes before and at most ${most} bytes over 2 s after (${during.length} writes), gone ${goneAfter === null ? 'not within 40 s' : `${goneAfter} ms`} after the tree's end`);
    assert.equal(lived, true, 'the keeper lives while the server writes');
    assert.ok(during.length >= 5 && most <= 4 * (1 << 20), `the file the server writes into held ${most} bytes over ${during.length} writes: emptied past its limit`);
    assert.equal(serverGone, true, 'the server is ended by the command tree');
    assert.notEqual(goneAfter, null, 'the keeper goes by itself once nothing of the command is left');
    done = true;
  } finally {
    // Only after a failure part way, before the test saw them gone.
    for (const p of done ? [] : [server, r.keeper].filter((x) => x && alive(x))) {
      try {
        process.kill(p);
      } catch {
        /* gone */
      }
    }
  }
});
