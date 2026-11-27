// install.ps1 cannot run here (no PowerShell): its text is held to the rules of the first-run design, and the Windows
// runner walk (tools/firstrun-walk.mjs) proves the same rules by running it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
// What runs: the comments are not code.
const code = ps.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const at = (re) => code.search(re);

test('it never closes the window: no exit anywhere, the end returns', () => {
  assert.doesNotMatch(code, /(^|[\s;{(])exit\b/m, 'a top-level exit closes the PowerShell window that ran irm | iex');
  assert.match(code, /Paste the same line again to try once more\./);
  assert.match(code, /Details: \$Log/);
});

test('an administrator window is stopped before anything is installed, with one line', () => {
  assert.match(code, /HOPRIG_ALLOW_ADMIN/);
  assert.match(code, /Close this window, open PowerShell the normal way \(not as administrator\) and paste the line again\./);
  assert.ok(at(/Test-Admin\) -and/) < at(/^\s+Install-NodeZip$/m), 'the stop comes before the first install');
});

test('Node.js comes as the official zip in the person\'s own folder after a checksum, never through winget', () => {
  assert.match(code, /nodejs\.org\/dist\/latest-v24\.x/);
  assert.match(code, /SHASUMS256\.txt/);
  assert.match(code, /Get-FileHash -LiteralPath \$zip -Algorithm SHA256/);
  assert.match(code, /\$got -ne \$want/);
  assert.match(code, /\$NodeDir = Join-Path \$Home_ 'node'/);
  assert.match(code, /Join-Path \$env:LOCALAPPDATA 'hoprig'/);
  assert.match(code, /SetEnvironmentVariable\('Path'/);
  assert.doesNotMatch(code, /OpenJS\.NodeJS/, 'no winget package for Node.js');
  assert.match(code, /\$v -ge \[version\]\$MinNode/);
});

test('Git is installed before Claude Code (setup), and only when it is missing', () => {
  assert.match(code, /if \(-not \(Get-Command git -ErrorAction SilentlyContinue\)\) \{ Install-Git \}/);
  assert.match(code, /Windows asks to allow a change: click Yes\./);
  assert.ok(at(/Install-Git \}/) < at(/& \$bin setup/), 'Git before setup, which installs Claude Code');
});

test('npm runs by its .cmd name, and the .ps1 shims are taken away', () => {
  assert.doesNotMatch(code, /&\s+npm\s/, 'never npm.ps1: the default policy refuses it');
  assert.match(code, /npm\.cmd/);
  assert.match(code, /'hoprig\.ps1', 'hop\.ps1'/);
  assert.match(code, /'npm\.ps1', 'npx\.ps1'/);
  assert.match(code, /& \$bin setup/);
  assert.match(code, /\$bin = Join-Path \$prefix 'hoprig\.cmd'/);
});

test('one tick line per part, a red cross with the reason on failure, a log', () => {
  for (const part of ['Node.js', 'Git', 'Hoprig']) assert.match(code, new RegExp(`Tick '${part}'`));
  assert.match(code, /did not install: \$why/);
  assert.match(code, /install\.log/);
  assert.match(code, /\*>> \$Log/);
});

test('a Start menu entry opens the page signed in', () => {
  assert.match(code, /Start Menu\\Programs/);
  assert.match(code, /Hoprig\.lnk/);
  assert.match(code, /link --open/);
});

test('it asks nothing', () => {
  assert.doesNotMatch(code, /Read-Host|\$Host\.UI\.Prompt|Confirm-|PromptForChoice/);
});
