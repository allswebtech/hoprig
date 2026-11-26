// One command of a check or a go-live (src/ship/runcmd.mjs): run without a shell, in its folder, at its time limit
// ended with everything it started, only its last lines kept; the limiter's words go first; at low priority it runs
// under nice. And the keep paths' picture (src/ship/picture.mjs): names, counts, bytes and hashes, never contents; a
// change is named by file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempShip, write } from './helpers.mjs';

const t = tempShip('ship-run');
test.after(() => t.cleanup());
const { runCommand, endWords, LAST_LINES } = await import('../../src/ship/runcmd.mjs');
const { takePicture, comparePictures, shownPicture } = await import('../../src/ship/picture.mjs');
const dir = path.join(t.root, 'p');
fs.mkdirSync(dir);

test('a command runs without a shell, in its folder; only its last lines are kept', async () => {
  const r = await runCommand(['node', '-e', 'for (let i = 1; i <= 100; i++) console.log("line " + i); console.log(process.cwd()); process.exit(3)'], { cwd: dir });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  const lines = r.last.split('\n');
  assert.equal(lines.length, LAST_LINES);
  assert.equal(lines.at(-1), dir);
  assert.equal(endWords(r, 10), 'ended with code 3');
  // A shell's words are words: nothing expands them.
  const s = await runCommand(['node', '-e', 'console.log(process.argv[1])', '$(touch hacked); `id`'], { cwd: dir });
  assert.equal(s.last, '$(touch hacked); `id`');
  assert.equal(fs.existsSync(path.join(dir, 'hacked')), false);
});

// The pids of the commands this file ended at their time limit: a later failure says whether its process had one of
// them (Windows hands a pid on at once).
const endedPids = [];

test('at its time limit the command and what it started are ended', async () => {
  const pidFile = path.join(dir, 'child.pid');
  const code = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  const r = await runCommand(['node', '-e', code], { cwd: dir, minutes: 0.02, started: (c) => endedPids.push(c.pid) });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.match(endWords(r, 0.02), /time limit/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), 'the grandchild is gone too');
});

test('the limiter goes first, nice at low priority; a program that is not there is said', async () => {
  // Windows: the test seal starts a stand-in with no extension (tools/test-seal.cjs windowsStandIn), never a `.sh`, so
  // the limiter there is a Node script that says the same and starts the rest without a shell.
  const limiter = process.platform === 'win32' ? 'limit' : 'limit.sh';
  if (process.platform === 'win32') write(t.root, { limit: '#!/usr/bin/env node\nconst a = process.argv.slice(2);\nconsole.log(`limited: ${a.join(" ")}`);\nconst r = require("node:child_process").spawnSync(a[0], a.slice(1), { stdio: "inherit" });\nprocess.exit(r.status === null ? 1 : r.status);\n' });
  else write(t.root, { 'limit.sh': '#!/bin/sh\necho "limited: $*"\nexec "$@"\n' });
  const r = await runCommand(['node', '-e', 'console.log("inside")'], { cwd: dir, prefix: [path.join(t.root, limiter)], low: true });
  assert.equal(r.ok, true);
  assert.match(r.last, /^limited: node -e/);
  const n = await runCommand(['node', '-e', 'console.log(require("node:os").getPriority())'], { cwd: dir, low: true });
  // On the public macOS test computers the child reports priority 0 under nice (cause not found, 24 Nov 2026): low
  // priority is proven on Linux and is not proven on macOS; that the run works there is.
  if (process.platform === 'darwin') assert.match(n.last.trim(), /^(0|10)$/);
  else assert.equal(n.last.trim(), '10');
  const missing = await runCommand(['no-such-program-here'], { cwd: dir });
  assert.equal(missing.ok, false);
  assert.match(endWords(missing, 10), /not on this computer/);
  assert.deepEqual(t.trapped(), []);
});

test('Windows, which has no nice: low priority is the priority class below normal, set on the command at once', async () => {
  const calls = [];
  const pids = [];
  const setPriority = (pid, p) => calls.push([pid, p]);
  const r = await runCommand(['node', '-e', 'console.log(require("node:os").getPriority())'], { cwd: dir, low: true, platform: 'win32', setPriority, started: (c) => pids.push(c.pid) });
  assert.equal(r.ok, true, r.last);
  assert.deepEqual(calls, [[pids[0], 10]], 'below normal (10), on the command itself');
  assert.doesNotMatch(r.last, /nice/, 'no nice in front of it');
  await runCommand(['node', '-e', '0'], { cwd: dir, low: false, platform: 'win32', setPriority });
  assert.equal(calls.length, 1, 'not at the ordinary priority');
  await runCommand(['node', '-e', '0'], { cwd: dir, low: true, platform: 'linux', setPriority });
  assert.equal(calls.length, 1, 'Linux and macOS keep nice');
});

test('a picture holds names, counts, bytes and hashes, never contents, and names what changed', () => {
  const base = path.join(t.root, 'proj');
  write(base, { 'data/a.json': '{"secret":"s3cr3t-value"}', 'data/sub/b.txt': 'bee', '.env': 'TOKEN=abcdefabcdef' });
  const one = takePicture(base, ['data', '.env', 'missing']);
  assert.deepEqual(shownPicture(one), [
    { path: 'data', exists: true, files: 2, bytes: 28 },
    { path: '.env', exists: true, files: 1, bytes: 18 },
    { path: 'missing', exists: false, files: 0, bytes: 0 },
  ]);
  const text = JSON.stringify(one);
  assert.equal(text.includes('s3cr3t'), false);
  assert.equal(text.includes('abcdefabcdef'), false);
  assert.equal(comparePictures(one, takePicture(base, ['data', '.env', 'missing'])).same, true);
  write(base, { 'data/sub/b.txt': 'bee2', 'missing/x': '1' });
  fs.rmSync(path.join(base, '.env'));
  const cmp = comparePictures(one, takePicture(base, ['data', '.env', 'missing']));
  assert.equal(cmp.same, false);
  assert.deepEqual(cmp.changed, [
    { path: '.env', what: 'removed' },
    { path: 'data/sub/b.txt', what: 'changed' },
    { path: 'missing/x', what: 'added' },
  ]);
});

test('a command gets no provider key and none of Hoprig\'s tokens', async () => {
  const secrets = { ANTHROPIC_API_KEY: 'sk-ant-made-up', ANTHROPIC_AUTH_TOKEN: 'made-up', HOPRIG_ASSISTANT_TOKEN: 'tia_made-up', OPENAI_API_KEY: 'sk-made-up' };
  const env = { ...process.env, ...secrets, SHOP_PORT: '8080' };
  const r = await runCommand(['node', '-e', `console.log(${JSON.stringify(Object.keys(secrets))}.filter((k) => k in process.env).join(',') + '|' + process.env.SHOP_PORT)`], { cwd: dir, env });
  assert.equal(r.ok, true);
  assert.equal(r.last.trim(), '|8080', 'no secret, the rest as it was');
});

test('a command that leaves a server running in the background with its output: done when the command ends, the server lives', async () => {
  const pidFile = path.join(dir, 'server.pid');
  // The server inherits the command's output pipes and its process group, as `server &` without a redirect does. On
  // Windows the stand-in server is started detached: Node's docs say only a detached child can go on after its parent
  // exits there (libuv puts every other child in a job object that ends with the parent). The public Windows run said
  // "kill ESRCH" here, the server gone; that this is why is read from those docs, not watched on a Windows computer.
  const code = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: ${process.platform === 'win32'} }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); console.log('started');`;
  const t0 = Date.now();
  const r = await runCommand(['node', '-e', code], { cwd: dir, minutes: 0.1 });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(r.ok, true, r.last);
    assert.equal(r.timedOut, false);
    assert.ok(Date.now() - t0 < 3000, `it ended after ${Date.now() - t0} ms, not at its time limit`);
    assert.equal(r.last, 'started');
    await new Promise((res) => setTimeout(res, 7000)); // past the time limit of 6 s
    assert.doesNotThrow(() => process.kill(pid, 0), `the server still runs (its pid ${pid}${endedPids.includes(pid) ? ' was that of a command this file ended at its time limit' : ''}; the command took ${r.ms} ms)`);
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

// `server & echo $! > <pidName>; echo started` in a shell. On Windows the command is a Node one that does the same: under
// Git for Windows' sh, `$!` is sh's own number for the job, not the Windows pid that process.kill takes, so the test
// could neither see the server nor end it (the public Windows run: false !== true here, and EPERM on removing the
// folder a server left running still held). The server is detached there, as Node needs on Windows to outlive its parent.
const inBackground = (server, pidName) => (process.platform === 'win32'
  ? ['node', '-e', `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], { stdio: 'inherit', detached: true }); require('node:fs').writeFileSync(${JSON.stringify(pidName)}, String(c.pid)); c.unref(); console.log('started');`]
  : ['sh', '-c', `node -e '${server}' & echo $! > ${pidName}; echo started`]);

test('a server left in the background that keeps printing lives on after the command, and its file goes', async () => {
  const pidFile = path.join(dir, 'talker.pid');
  // `server &` in a shell: the server inherits the command's output and prints every 100 ms. A write to a pipe that
  // was let go would end it (EPIPE); it must not.
  const server = 'process.stdout.on("error", () => process.exit(9)); setInterval(() => console.log("request"), 100)';
  const r = await runCommand(inBackground(server, 'talker.pid'), { cwd: dir, minutes: 0.1 });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(r.ok, true, r.last);
    assert.match(r.last, /started/);
    await new Promise((res) => setTimeout(res, 1500));
    assert.doesNotThrow(() => process.kill(pid, 0), 'the server still runs and prints');
    const left = fs.readdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'output'));
    assert.deepEqual(left, [], 'the output file was removed after the command');
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('a server left in the background that prints a lot: what it prints after the command is bounded, never a growing file', async () => {
  const pidFile = path.join(dir, 'loud.pid');
  // 1 MiB every 100 ms into the output it inherited: before, all of it went into a removed file that only grew.
  const server = 'const b = Buffer.alloc(1 << 20, 120); process.stdout.on("error", () => process.exit(9)); setInterval(() => process.stdout.write(b), 100)';
  const r = await runCommand(inBackground(server, 'loud.pid'), { cwd: dir, minutes: 0.1 });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const out = path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'output');
  try {
    assert.equal(r.ok, true, r.last);
    assert.match(r.last, /started/);
    assert.ok(Buffer.byteLength(r.last) <= 64 * 1024, 'only the last lines are kept');
    await new Promise((res) => setTimeout(res, 3000)); // about 30 MiB printed meanwhile
    assert.doesNotThrow(() => process.kill(pid, 0), 'the server still runs and prints');
    let biggest = 0;
    for (const n of fs.existsSync(out) ? fs.readdirSync(out) : []) biggest = Math.max(biggest, fs.statSync(path.join(out, n)).size);
    assert.ok(biggest <= 64 * 1024, `no output file over its limit (${biggest} bytes)`);
    if (process.platform === 'linux') {
      // The removed file the server writes into is emptied whenever it is past its limit: sampled over a second it
      // never holds more than a few of the server's writes (without the keeper it held all 30 MiB, and grew).
      let most = 0;
      for (let i = 0; i < 20; i++) {
        most = Math.max(most, fs.statSync(`/proc/${pid}/fd/1`).size);
        await new Promise((res) => setTimeout(res, 50));
      }
      assert.ok(most <= 4 * (1 << 20), `the file the server writes into held ${most} bytes: past its limit`);
    }
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('a provider\'s key under its own name reaches no command; GitHub\'s token reaches no check', async () => {
  const { writeProfile, deleteProfile } = await import('../../src/profiles.mjs');
  writeProfile('bedrock', { label: 'Bedrock', env: { AWS_BEARER_TOKEN_BEDROCK: 'x', GATEWAY_KEY: 'x', AWS_REGION: 'x', CLAUDE_CODE_USE_BEDROCK: '1' } });
  try {
    const names = ['AWS_BEARER_TOKEN_BEDROCK', 'GATEWAY_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'AWS_REGION'];
    const env = { ...process.env, AWS_BEARER_TOKEN_BEDROCK: 'made-up', GATEWAY_KEY: 'made-up', GH_TOKEN: 'made-up', GITHUB_TOKEN: 'made-up', AWS_REGION: 'eu-west-1' };
    const seen = `console.log(${JSON.stringify(names)}.filter((k) => k in process.env).join(','))`;
    const check = await runCommand(['node', '-e', seen], { cwd: dir, env, branches: true });
    assert.equal(check.last.trim(), 'AWS_REGION', 'a check runs code from task branches: no provider key, no GitHub token');
    const live = await runCommand(['node', '-e', seen], { cwd: dir, env });
    assert.equal(live.last.trim(), 'GH_TOKEN,GITHUB_TOKEN,AWS_REGION', 'a go-live keeps GitHub\'s token for a fetch, never a provider key');
  } finally {
    deleteProfile('bedrock');
  }
});
