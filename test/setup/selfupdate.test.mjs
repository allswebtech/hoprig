import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const U = await import('../../src/setup/selfupdate.mjs');
const { appRoot } = await import('../../src/setup/checks.mjs');

const { hoprigSource } = await import('../../src/paths.mjs');
const { appVersion } = await import('../../src/setup/checks.mjs');

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

// ---- the newest version, from where the install and the update come from ----

const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('the newest version is read from the package.json the update would install, and nothing else is sent', async () => {
  const src = hoprigSource();
  assert.match(src.package, /^https:\/\/github\.com\/[^/]+\/hoprig\/archive\/refs\/heads\/main\.tar\.gz$/);
  assert.match(src.versionFile, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/hoprig\/main\/package\.json$/);
  // The two name the same repository and branch, and the update installs exactly the package address.
  const [, repo] = /github\.com\/([^/]+\/[^/]+)\/archive/.exec(src.package);
  assert.ok(src.versionFile.includes(`/${repo}/main/`), 'the lookup reads the same repository and branch the install takes');
  assert.equal(U.updatePlan('npm', '/x', 'linux').at(0).argv.at(-1), src.package);
  const asked = [];
  const r = await U.newestVersion({ fetchImpl: async (url, init) => (asked.push([url, init]), { ok: true, status: 200, text: async () => '{"name":"hoprig","version":"0.3.1"}' }) });
  assert.deepEqual(r, { version: '0.3.1', note: null });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], src.versionFile);
  assert.deepEqual(Object.keys(asked[0][1]), ['signal'], 'a plain GET with a time limit: no headers, no body of this computer');
});

test('a version that cannot be read is unknown, with a plain note, never a wrong number', async () => {
  const cases = [
    [async () => { throw new TypeError('fetch failed'); }, /could not be read from raw\.githubusercontent\.com \(it could not be reached\)/],
    [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, /no answer in time/],
    [answer(404, 'Not Found'), /it answered 404/],
    [answer(200, '<html>'), /not a package file/],
    [answer(200, '{"name":"hoprig"}'), /names no version/],
    [answer(200, '{"version":"newest"}'), /names no version/],
    [answer(200, '{"version":7}'), /names no version/],
  ];
  for (const [fetchImpl, why] of cases) {
    const r = await U.newestVersion({ fetchImpl });
    assert.equal(r.version, null, String(why));
    assert.match(r.note, why);
  }
});

test('hoprig update on an npm install: newer, the same, older and unreadable', async () => {
  const root = path.join(s.tmp, 'npmprefix', 'lib', 'node_modules', 'hoprig');
  fs.mkdirSync(root, { recursive: true });
  const current = appVersion();
  const [a, b, c] = current.split('.').map(Number);
  const run = async () => {
    throw new Error('a dry run runs nothing');
  };
  const go = async (newest) => {
    let out = '';
    const code = await U.selfUpdate(['--dry-run'], { write: (t) => { out += t; }, root, run, lookup: async () => newest });
    return { code, out };
  };
  const newer = await go({ version: `${a}.${b}.${c + 1}`, note: null });
  assert.equal(newer.code, 0, newer.out);
  assert.match(newer.out, new RegExp(`Version ${a}\\.${b}\\.${c + 1} is available`));
  // Windows starts npm (npm.cmd) through cmd.exe, and the line says so.
  const npmStart = process.platform === 'win32' ? 'cmd\\.exe /d /s /c npm' : 'npm';
  assert.match(newer.out, new RegExp(`would run: ${npmStart} install -g .*archive/refs/heads/main\\.tar\\.gz`));
  for (const v of [current, `${a}.${Math.max(b - 1, 0)}.0`, '0.0.1']) {
    const same = await go({ version: v, note: null });
    assert.equal(same.code, 0, same.out);
    assert.match(same.out, new RegExp(`The newest version is ${v.replace(/\./g, '\\.')}, and this is ${current.replace(/\./g, '\\.')}\\. Nothing to do\\.`));
    assert.doesNotMatch(same.out, /would run/);
  }
  const unread = await go({ version: null, note: 'The newest version could not be read from example.com (it could not be reached).' });
  assert.equal(unread.code, 1);
  assert.match(unread.out, /could not be read from example\.com \(it could not be reached\)\. Nothing changed\./);
  assert.doesNotMatch(unread.out, /would run/);
});

test('install.sh and install.ps1 install from the same place the update and its lookup read', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const from = hoprigSource().package;
  assert.ok(fs.readFileSync(path.join(root, 'install.sh'), 'utf8').includes(`SOURCE=\${HOPRIG_SOURCE:-${from}}`));
  assert.ok(fs.readFileSync(path.join(root, 'install.ps1'), 'utf8').includes(`else { '${from}' }`));
});
