// The owner question doctor asks on Windows (src/setup/winowner.mjs ownerArgv), run as it is by the real Windows
// PowerShell on a folder of the test's own: it names the owner Windows gave the folder, the token's own default owner
// (this account, or the Administrators group when the test runs elevated), and loads no module, so it answers within
// 10 s. It only reads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const W = await import('../../src/setup/winowner.mjs');
const { POWERSHELL, psArgs } = await import('../../src/server/platform/win32.mjs');

test('the owner question, run by Windows PowerShell on a folder of the test\'s own, names its owner within 10 s', { skip: process.platform !== 'win32' && 'the owner is read by Windows PowerShell', timeout: 60_000 }, (tc) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoprig-owner-it's $x "));
  tc.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argv = W.ownerArgv(dir);
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, windowsHide: true });
  const took = Date.now() - t0;
  assert.equal(r.error, undefined, `ended within 10 s: ${r.error}`);
  assert.equal(r.status, 0, r.stderr);
  const owner = r.stdout.trim();
  assert.match(owner, /^S-1-\d+(?:-\d+)+$/, r.stdout);
  // Who Windows makes the owner of a new folder of this process: the token's default owner, asked of .NET apart.
  const me = spawnSync(POWERSHELL, psArgs('[Console]::Out.WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().Owner.Value)'), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, windowsHide: true });
  assert.equal(me.status, 0, me.stderr);
  assert.equal(owner, me.stdout.trim(), 'the owner read is the one this account gives a folder it makes');
  tc.diagnostic(`owner ${owner}, read in ${took} ms`);
});
