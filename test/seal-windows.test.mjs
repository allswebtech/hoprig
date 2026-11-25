// The seal on Windows (tools/test-seal.cjs windowsTrap). Node starts a bare name there only as `.com` or `.exe`, and a
// `.cmd` not at all without a shell, while the runner's traps are `.cmd` files on Windows (tools/test-traps.mjs). So a
// test that started `sudo` or `winget` by name never reached its trap: the first Windows run of the suite showed
// ENOENT for every trapped name, and on a computer that has a real `winget.exe` later on PATH that one would have
// started, with no trap line. The wrap now answers a trapped name itself. Windows' answers are given here, so this
// runs on every system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsTrap } from '../tools/test-seal.mjs';

const TRAPS = 'C:\\t\\hoprig-tests-ab\\guard';
const OWN = 'C:\\t\\shop-test\\bin';
const REAL = 'C:\\Program Files\\WindowsApps';
const NODE = 'C:\\node\\node.exe';
// What is on this made-up Windows: the trap folder holds every trap as a .cmd, the computer a real winget.exe.
// The test's own folder holds a stand-in Node can start (winget.exe) and a shell-script one it cannot (sudo); the
// computer has a real sudo.exe in System32, as Windows 11 does.
const SYS = 'C:\\Windows\\System32';
const files = new Set([`${TRAPS}\\sudo.cmd`, `${TRAPS}\\winget.cmd`, `${TRAPS}\\npm.cmd`, `${REAL}\\winget.exe`, `${OWN}\\winget.exe`, `${OWN}\\sudo`, `${SYS}\\sudo.exe`]);
const exists = (f) => files.has(f);
const isOwn = (f) => f.toLowerCase().startsWith('c:\\t\\');
const opts = (PATH) => ({ env: { Path: PATH }, traps: TRAPS, platform: 'win32', exists, isOwn, node: NODE, npmTrap: 'C:\\repo\\tools\\test-traps.mjs' });  // seal: a made-up Windows PATH handed to a pure function

test('Windows: a trapped name started by itself is answered as its trap answers, with the trap line', () => {
  const sudo = windowsTrap('sudo', ['-n', 'true'], opts(`${TRAPS};${REAL}`)); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(sudo.command, NODE);
  assert.deepEqual(sudo.log, ['sudo', '-n true']);
  assert.match(sudo.args[1], /sudo: stopped by the test runner: a test reached the real sudo/);
  assert.match(sudo.args[1], /process\.exit\(97\)/);
  // winget: the computer's real winget.exe stands later on PATH, and is never the one that starts.
  const winget = windowsTrap('winget', ['--version'], opts(`${TRAPS};${REAL}`)); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(winget.command, NODE);
  assert.deepEqual(winget.log, ['winget', '--version']);
  // With an extension, and with the trap's own full path (where trapPath sends a trapped full path), the same.
  assert.deepEqual(windowsTrap('WINGET.EXE', [], opts(`${TRAPS};${REAL}`)).log, ['winget', '']); // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(windowsTrap(`${TRAPS}\\sudo.cmd`, ['x'], opts('')).log, ['sudo', 'x']);
});

test('Windows: npm goes to the npm trap, which passes on a call that stays on the computer', () => {
  const npm = windowsTrap('npm', ['--version'], opts(`${TRAPS};${REAL}`)); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(npm.command, NODE);
  assert.deepEqual(npm.args, ['C:\\repo\\tools\\test-traps.mjs', `${TRAPS}\\npm-trap.json`, '--version']);
  assert.equal(npm.log, null, 'the npm trap writes its own line when the call does not stay on the computer');
});

test('Windows: a test\'s own stand-in first on its PATH still runs, and other programs are left alone', () => {
  assert.equal(windowsTrap('winget', ['--version'], opts(`${OWN};${TRAPS};${REAL}`)), null); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsTrap(`${OWN}\\winget.exe`, [], opts('')), null, 'a full path into the test\'s area is its own');
  // A shell-script stand-in first on PATH is never started by Node on Windows: the real sudo.exe after it would be,
  // so the trap answers instead.
  assert.deepEqual(windowsTrap('sudo', ['true'], opts(`${OWN};${TRAPS};${SYS}`)).log, ['sudo', 'true']); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsTrap('git', ['status'], opts(`${TRAPS};${REAL}`)), null); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsTrap('node', [], opts(`${TRAPS}`)), null); // seal: a made-up Windows PATH handed to a pure function
});

test('nothing changes on Linux or macOS, or outside the runner', () => {
  for (const platform of ['linux', 'darwin']) assert.equal(windowsTrap('sudo', [], { ...opts(TRAPS), platform }), null);
  assert.equal(windowsTrap('sudo', [], { ...opts(TRAPS), traps: '' }), null, 'no trap folder: not under the runner');
});
