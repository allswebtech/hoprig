// Three things the first run on Windows saw and did not check: Claude Code's native install there is "official
// installer" (not "a package manager"); long paths off in Windows and in git are named by doctor, each with the one
// command that turns it on, and nothing is changed. Made-up answers of reg and git: nothing real runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { methodOf } from '../../src/claudecode.mjs';
import { LONGPATHS_KEY, longPathsChecks, parseLongPaths } from '../../src/setup/checks.mjs';

test('Windows: the native installer\'s claude.exe in .local\\bin is the native install', () => {
  assert.equal(methodOf('C:\\Users\\alex\\.local\\bin\\claude.exe'), 'native');
  assert.equal(methodOf('C:\\Users\\alex\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'), 'unknown');
  assert.equal(methodOf('/home/alex/.local/bin/claude'), 'unknown', 'elsewhere it is a link: its real path decides');
});

const regOut = (v) => `\r\n${LONGPATHS_KEY}\r\n    LongPathsEnabled    REG_DWORD    0x${v}\r\n\r\n`;
const sys = (has = true) => ({ platform: 'win32', env: {}, has: (b) => has && b === 'git' });

test('doctor on Windows: long paths off in Windows and in git, each with its command; on: ok; nothing changed', async () => {
  const calls = [];
  const answers = (reg, git) => async (argv) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'reg') return reg;
    if (argv[0] === 'git' && argv[1] === 'config' && argv[2] === '--get') return git;
    return { ok: false, stdout: '' };
  };
  let c = await longPathsChecks(sys(), answers({ ok: true, stdout: regOut('0') }, { ok: false, stdout: '' }));
  // Off is the default of every Windows: named for information, with its command, not a warning on every first run.
  assert.deepEqual(c.map((x) => [x.id, x.status]), [['longpaths', 'info'], ['gitlongpaths', 'info']]);
  assert.match(c[0].fix, /Run as administrator.*LongPathsEnabled -Value 1/);
  // What turning it on helps, and what it does not: PowerShell 5.1 and Explorer are not long-path aware.
  assert.match(c[0].detail, /helps Node, git and newer programs; Windows PowerShell 5\.1 and File Explorer still cannot use such a path/);
  assert.equal(c[1].fix, 'git config --global core.longpaths true');
  c = await longPathsChecks(sys(), answers({ ok: false, stdout: '' }, { ok: true, stdout: 'true\n' }));
  assert.deepEqual(c.map((x) => [x.id, x.status]), [['longpaths', 'info'], ['gitlongpaths', 'ok']], 'no value: Windows\' default, off');
  c = await longPathsChecks(sys(false), answers({ ok: true, stdout: regOut('1') }, null));
  assert.deepEqual(c.map((x) => [x.id, x.status]), [['longpaths', 'ok']]);
  assert.ok(calls.every((x) => /^reg query |^git config --get /.test(x)), `only asked: ${calls}`);
  assert.deepEqual(await longPathsChecks({ platform: 'linux', env: {}, has: () => true }, async () => assert.fail('nothing asked')), []);
  assert.equal(parseLongPaths('ERROR: The system was unable to find the specified registry key or value.'), null);
});
