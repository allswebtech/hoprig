// The test sandbox (helpers.mjs) keeps a test dashboard apart from the session that runs the tests: no run record of
// that session, and no GitHub sign-in of the person (Setup reads it with `gh auth status`).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fakeTools } from '../setup/helpers.mjs';
import { sandbox } from './helpers.mjs';

test('a sandbox drops the running session\'s run file and any GitHub sign-in', async (t) => {
  process.env.HOPRIG_RUN_FILE = '/somewhere/real.json';
  process.env.HOPRIG_TERM_ID = 't-real';
  process.env.GH_TOKEN = 'not-a-real-token';
  const box = sandbox('sandbox');
  t.after(() => box.cleanup());
  // A stand-in gh (installed, not signed in) first on PATH: Setup's check runs it, so the owner's real GitHub sign-in
  // is never read. The sandbox cleared GH_CONFIG_DIR to its own, so even the real gh would see nobody; this keeps it
  // off the real gh entirely.
  process.env.PATH = `${fakeTools(path.join(box.root, 'tools'))}${path.delimiter}${process.env.PATH}`;
  assert.equal(process.env.HOPRIG_RUN_FILE, undefined);
  assert.equal(process.env.HOPRIG_TERM_ID, undefined);
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.ok(process.env.GH_CONFIG_DIR.startsWith(box.root + path.sep));
  // With GitHub's command on this computer: Setup's own check finds nobody signed in.
  if (spawnSync('gh', ['--version']).status !== 0) return t.skip('gh is not installed');
  const { gitState } = await import('../../src/workspace/gitstep.mjs');
  const st = await gitState({ dir: box.workspace });
  assert.deepEqual([st.gh.installed, st.gh.signedIn, st.gh.account], [true, false, null]);
});

test('a process that outlives its sandbox fails the cleanup, named; one that is just ending does not', { skip: process.platform !== 'linux' && 'the sandbox reads its processes from /proc' }, async (t) => {
  const box = sandbox('sandbox');
  // Started after sandbox(), so it carries the box's folders in its environment, like every child of a test. It
  // writes into the box on and on, as a leaked launcher writes its run records.
  const child = spawn(process.execPath, ['-e', 'const fs=require("fs"),p=require("path");setInterval(()=>{try{fs.mkdirSync(p.join(process.env.HOPRIG_STATE_DIR,"x"+Date.now()),{recursive:true})}catch{}},20)'], { stdio: 'ignore' });
  const gone = new Promise((r) => child.once('exit', r));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await gone;
  });
  await new Promise((r) => child.once('spawn', r));
  assert.throws(() => box.cleanup(), (e) => e.message.includes(`${child.pid} (`) && e.message.includes('still alive after the test'));
  child.kill('SIGKILL');
  await gone;
  box.cleanup(); // gone now: nothing to name, and the folder goes
  assert.equal(fs.existsSync(box.root), false);
  // One that ends a moment after the test is waited for, not named.
  const box2 = sandbox('sandbox');
  const late = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { stdio: 'ignore' });
  t.after(() => late.kill('SIGKILL'));
  await new Promise((r) => late.once('spawn', r));
  box2.cleanup();
  assert.equal(fs.existsSync(box2.root), false);
});
