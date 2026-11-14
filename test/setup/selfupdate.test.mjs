import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const U = await import('../../src/setup/selfupdate.mjs');
const { appRoot } = await import('../../src/setup/checks.mjs');

test('how hoprig was installed, from its folder', () => {
  const git = path.join(s.tmp, 'checkout');
  fs.mkdirSync(path.join(git, '.git'), { recursive: true });
  assert.equal(U.installKind(git), 'git');
  const npm = path.join(s.tmp, 'prefix', 'lib', 'node_modules', 'hoprig');
  fs.mkdirSync(npm, { recursive: true });
  assert.equal(U.installKind(npm), 'npm');
  const other = path.join(s.tmp, 'copied', 'hoprig-0.1.0');
  fs.mkdirSync(other, { recursive: true });
  assert.equal(U.installKind(other), 'other');
});

test('update commands per kind and OS', () => {
  assert.deepEqual(U.updatePlan('git', '/src/hoprig', 'linux'), [
    { argv: ['git', '-C', '/src/hoprig', 'pull', '--ff-only'], cwd: '/src/hoprig' },
    { argv: ['npm', 'install', '--omit=dev', '--no-audit', '--no-fund'], cwd: '/src/hoprig' },
  ]);
  assert.deepEqual(U.updatePlan('npm', '/x', 'linux'), [{ argv: ['npm', 'install', '-g', 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz'], cwd: undefined }]);
  assert.deepEqual(U.updatePlan('npm', 'C:\\x', 'win32')[0].argv, ['cmd.exe', '/d', '/s', '/c', 'npm', 'install', '-g', 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz']);
  assert.deepEqual(U.updatePlan('other'), []);
  // npm 12 and newer: the address is allowed for this one command, and the terminal module is built afterwards in
  // the installed folder (that npm does not run its install script in a global install); a failed build does not
  // undo the update, it points to doctor.
  for (const older of [10, 11, null]) assert.equal(U.updatePlan('npm', '/x', 'linux', older).length, 1, String(older));
  const plan = U.updatePlan('npm', '/p/lib/node_modules/hoprig', 'linux', 12);
  assert.deepEqual(plan[0], { argv: ['npm', 'install', '-g', '--prefix', '/p', '--allow-remote=root', 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz'], cwd: undefined });
  assert.deepEqual(plan[1].argv, ['npm', 'rebuild', 'node-pty']);
  assert.equal(plan[1].cwd, '/p/lib/node_modules/hoprig');
  assert.match(plan[1].ifFails, /terminal module was not built.*hoprig doctor/);
  assert.equal(U.updatePlan('git', '/src/hoprig', 'linux', 12).length, 2, 'a checkout needs nothing more: its package.json allows the module');
});

test('an update goes to the global folder hoprig is in (the installer may have used ~/.local)', () => {
  assert.equal(U.globalPrefix('/home/u/.local/lib/node_modules/hoprig', 'linux'), '/home/u/.local');
  assert.equal(U.globalPrefix('/usr/local/lib/node_modules/hoprig', 'darwin'), '/usr/local');
  assert.equal(U.globalPrefix('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\hoprig', 'win32'), 'C:\\Users\\u\\AppData\\Roaming\\npm');
  assert.equal(U.globalPrefix('/src/hoprig', 'linux'), null);
  assert.equal(U.globalPrefix('/x/node_modules/hoprig', 'linux'), null, 'a dependency of another project is not a global install');
  assert.deepEqual(U.updatePlan('npm', '/home/u/.local/lib/node_modules/hoprig', 'linux', 11)[0].argv.slice(0, 5), ['npm', 'install', '-g', '--prefix', '/home/u/.local']);
});

test('update --dry-run reports and runs nothing', async () => {
  let out = '';
  const code = await U.selfUpdate(['--dry-run'], { write: (t) => { out += t; } });
  const kind = U.installKind(appRoot());
  if (kind === 'git') {
    assert.equal(code, 0, out);
    assert.match(out, /would run: git -C .* pull --ff-only/);
    assert.match(out, /Dry run: nothing was changed/);
  } else assert.ok(code === 0 || code === 1, out);
  assert.doesNotMatch(out, /^running:/m);
  assert.equal(await U.selfUpdate(['--bogus'], { write: () => {} }), 2);
});
