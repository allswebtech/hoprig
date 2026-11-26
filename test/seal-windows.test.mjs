// The seal on Windows (tools/test-seal.cjs windowsTrap). Node starts a bare name there only as `.com` or `.exe`, and a
// `.cmd` not at all without a shell, while the runner's traps are `.cmd` files on Windows (tools/test-traps.mjs). So a
// test that started `sudo` or `winget` by name never reached its trap: the first Windows run of the suite showed
// ENOENT for every trapped name, and on a computer that has a real `winget.exe` later on PATH that one would have
// started, with no trap line. The wrap now answers a trapped name itself. Windows' answers are given here, so this
// runs on every system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { msysNoglob, windowsSh, windowsStandIn, windowsStart, windowsTrap } from '../tools/test-seal.mjs';
import { windowsSpawnPlan } from '../src/winspawn.mjs';

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
  const winget = windowsTrap('winget', ['install', 'x'], opts(`${TRAPS};${REAL}`)); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(winget.command, NODE);
  assert.deepEqual(winget.log, ['winget', 'install x']);
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
  // so windowsTrap answers it (the wrap asks windowsStandIn first, which starts it through sh when an sh is there).
  assert.deepEqual(windowsTrap('sudo', ['true'], opts(`${OWN};${TRAPS};${SYS}`)).log, ['sudo', 'true']); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsTrap('git', ['status'], opts(`${TRAPS};${REAL}`)), null); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsTrap('node', [], opts(`${TRAPS}`)), null); // seal: a made-up Windows PATH handed to a pure function
});

test('Windows: "winget --version" is answered as a winget that does not start, with no trap line; any other call is stopped', () => {
  const ask = windowsTrap('winget', ['--version'], opts(`${TRAPS};${REAL}`)); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(ask.command, NODE);
  assert.equal(ask.log, null, 'nothing of the computer was asked');
  assert.match(ask.args[1], /winget: not started by the test runner/);
  assert.match(ask.args[1], /process\.exit\(97\)/, 'it does not start: the product names it so');
  // The computer's winget.exe later on PATH is never started, and an install is a reach with its line.
  assert.deepEqual(windowsTrap('winget', ['install', '-e', '--id', 'jqlang.jq'], opts(`${TRAPS};${REAL}`)).log, ['winget', 'install -e --id jqlang.jq']); // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(windowsTrap('winget', ['--version', 'x'], opts(`${TRAPS};${REAL}`)).log, ['winget', '--version x']); // seal: a made-up Windows PATH handed to a pure function
});

test('nothing changes on Linux or macOS, or outside the runner', () => {
  for (const platform of ['linux', 'darwin']) assert.equal(windowsTrap('sudo', [], { ...opts(TRAPS), platform }), null);
  assert.equal(windowsTrap('sudo', [], { ...opts(TRAPS), traps: '' }), null, 'no trap folder: not under the runner');
});

// A test's own stand-ins (tools/test-seal.cjs windowsStandIn): a `#!/bin/sh` file without an extension, or a .cmd,
// that Node on Windows would never start. Git for Windows' sh is on the computer's PATH; the test's own folder holds
// the stand-ins; another folder of the computer holds a script of the same name that is NOT the test's.
const GIT = 'C:\\Program Files\\Git\\bin';
const TOOLS = 'C:\\tools';
const own = new Set([`${OWN}\\gh`, `${OWN}\\tool.cmd`, `${OWN}\\notes`, `${OWN}\\helper`, `${OWN}\\sh.exe`, `${GIT}\\sh.exe`, `${TOOLS}\\gh`, `${TOOLS}\\docker.exe`, `${OWN}\\docker`, `${TRAPS}\\gh.cmd`, `${TRAPS}\\docker.cmd`, ...files]);
const lines = { [`${OWN}\\gh`]: '#!/bin/sh', [`${OWN}\\notes`]: 'just text', [`${OWN}\\helper`]: '#!/usr/bin/env node', [`${TOOLS}\\gh`]: '#!/bin/sh', [`${OWN}\\sudo`]: '#!/bin/sh', [`${OWN}\\docker`]: '#!/bin/sh' };
const so = (PATH, more = {}) => ({ env: { Path: PATH }, traps: TRAPS, platform: 'win32', exists: (f) => own.has(f), isOwn, firstLine: (f) => lines[f] || '', node: NODE, processPath: '', comspec: 'C:\\Windows\\system32\\cmd.exe', ...more }); // seal: a made-up Windows PATH handed to a pure function

test('Windows: a test\'s own shell-script stand-in, by its bare name, starts through the sh of Git for Windows with its arguments', () => {
  const gh = windowsStandIn('gh', ['auth', 'status', 'a b'], so(`${OWN};${TRAPS};${GIT}`)); // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(gh, { command: `${GIT}\\sh.exe`, args: [`${OWN.replace(/\\/g, "/")}/gh`, 'auth', 'status', 'a b'], verbatim: false });
  // The child's PATH holds only the test's folders (pathWith): the sh comes from the test process's own PATH.
  const bare = windowsStandIn('gh', ['--version'], so(`${OWN}`, { processPath: `${TRAPS};${GIT}` })); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(bare.command, `${GIT}\\sh.exe`);
  // The wrap's whole answer for it: no trap line.
  assert.deepEqual(windowsStart('gh', ['x'], so(`${OWN};${TRAPS};${GIT}`)), { command: `${GIT}\\sh.exe`, args: [`${OWN.replace(/\\/g, "/")}/gh`, 'x'], log: null, verbatim: false }); // seal: a made-up Windows PATH handed to a pure function
  // A node stand-in (`#!/usr/bin/env node`) starts through this Node.
  assert.deepEqual(windowsStandIn('helper', ['1'], so(`${OWN};${GIT}`)), { command: NODE, args: [`${OWN}\\helper`, '1'], verbatim: false }); // seal: a made-up Windows PATH handed to a pure function
});

test('Windows: a stand-in started through sh gets MSYS=noglob, so sh never expands a wildcard such as .[].login', () => {
  // Git for Windows' sh, started by a native program, expands wildcards in its arguments and died on `.[].login` with
  // an access violation before the script ran (the gh stand-in on a real Windows run).
  assert.deepEqual(msysNoglob({ Path: `${OWN};${GIT}` }), { Path: `${OWN};${GIT}`, MSYS: 'noglob' }); // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(msysNoglob({ MSYS: 'winsymlinks:nativestrict' }), { MSYS: 'winsymlinks:nativestrict noglob' }, 'added to the value that is there');
  assert.deepEqual(msysNoglob({ Msys: 'noglob' }), { Msys: 'noglob' }, 'once, under the name the environment spells');
  assert.deepEqual(msysNoglob({ MSYS: 'glob' }), { MSYS: 'glob' }, 'a caller that asks for glob itself keeps it');
  const given = { MSYS: 'x' };
  msysNoglob(given);
  assert.deepEqual(given, { MSYS: 'x' }, 'the caller\'s object is left as it was');
});

test('Windows: a test\'s own shell-script stand-in by its full path starts through sh too', () => {
  assert.deepEqual(windowsStandIn(`${OWN}\\gh`, ['--version'], so(`${TRAPS};${GIT}`)), { command: `${GIT}\\sh.exe`, args: [`${OWN.replace(/\\/g, "/")}/gh`, '--version'], verbatim: false }); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsStandIn(`${OWN}\\notes`, [], so(`${GIT}`)), null, 'no #! first line: not a stand-in'); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsStandIn(`${OWN}\\missing`, [], so(`${GIT}`)), null, 'not there: left as it is'); // seal: a made-up Windows PATH handed to a pure function
});

test('Windows: a test\'s own .cmd stand-in starts through cmd.exe with every argument escaped as src/winspawn.mjs does', () => {
  const tricky = ['say "hi" & exit', '50%', 'line\nnext', 'a\\'];
  const plan = windowsStandIn('tool', tricky, so(`${OWN};${TRAPS};${GIT}`)); // seal: a made-up Windows PATH handed to a pure function
  const want = windowsSpawnPlan(`${OWN}\\tool.cmd`, tricky, { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(plan.command, want.command);
  assert.deepEqual(plan.args, want.args);
  assert.equal(plan.verbatim, true, 'the line is handed to cmd.exe as it is');
  assert.deepEqual(windowsStandIn(`${OWN}\\tool.cmd`, ['x'], so(`${GIT}`)).args, windowsSpawnPlan(`${OWN}\\tool.cmd`, ['x'], {}).args); // seal: a made-up Windows PATH handed to a pure function
});

test('Windows: a stand-in outside the test\'s area, a program Node starts itself, and an sh of the test\'s own are left alone', () => {
  assert.equal(windowsStandIn('gh', [], so(`${TOOLS};${OWN};${GIT}`)), null, 'the first gh on PATH is the computer\'s'); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsStandIn(`${TOOLS}\\gh`, [], so(`${GIT}`)), null, 'a full path outside the test\'s area'); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsStandIn('docker', [], so(`${TOOLS};${OWN};${GIT}`)), null, 'a docker.exe before the stand-in: Node starts that one, as before'); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsStandIn('docker.exe', [], so(`${OWN};${GIT}`)), null, 'an .exe: Node starts it'); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsStandIn('gh', [], so(`${OWN}`)), null, 'only an sh in the test\'s own folder: no sh to start it'); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(windowsSh(`${OWN};${TRAPS};${GIT}`, { traps: TRAPS, exists: (f) => own.has(f), isOwn }), `${GIT}\\sh.exe`, 'the sh is never the test\'s own'); // seal: a made-up Windows PATH handed to a pure function
});

test('Windows: a trapped name still goes to its trap, also when a shell-script stand-in of the test holds it', () => {
  assert.deepEqual(windowsStart('sudo', ['true'], so(`${TRAPS};${OWN};${SYS};${GIT}`)).log, ['sudo', 'true'], 'the trap folder first'); // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(windowsStart('sudo', ['true'], so(`${SYS};${OWN};${TRAPS};${GIT}`)).log, ['sudo', 'true'], 'the computer\'s sudo.exe first: never started'); // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(windowsStart('sudo', ['true'], so(`${OWN};${TRAPS};${SYS}`)).log, ['sudo', 'true'], 'no sh: the trap, never the sudo.exe later on PATH'); // seal: a made-up Windows PATH handed to a pure function
  // The test's own sudo stand-in FIRST on PATH runs, as it does on Linux (the seal lets a test's own stand-in run).
  assert.equal(windowsStart('sudo', ['true'], so(`${OWN};${TRAPS};${SYS};${GIT}`)).command, `${GIT}\\sh.exe`); // seal: a made-up Windows PATH handed to a pure function
  const npm = windowsStart('npm', ['--version'], so(`${OWN};${TRAPS};${GIT}`)); // seal: a made-up Windows PATH handed to a pure function
  assert.equal(npm.command, NODE);
  assert.equal(npm.args.at(-1), '--version');
  assert.equal(npm.args[1], `${TRAPS}\\npm-trap.json`, 'npm goes to the npm trap');
  assert.equal(windowsStandIn(`${TRAPS}\\sudo.cmd`, [], so(GIT)), null, 'a trap file is never started as a stand-in');
  // gh is trapped too: the test's own gh runs only where it is the first holder and an sh can start it.
  assert.deepEqual(windowsStart('gh', ['x'], so(`${TRAPS};${OWN};${GIT}`)).log, ['gh', 'x'], 'the trap folder before the stand-in'); // seal: a made-up Windows PATH handed to a pure function
  assert.deepEqual(windowsStart('gh', ['x'], so(`${OWN}`)).log, ['gh', 'x'], 'no sh to start it: the trap'); // seal: a made-up Windows PATH handed to a pure function
});

test('a stand-in is left alone on Linux and macOS, and outside the runner', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.equal(windowsStandIn('gh', ['x'], so(`${OWN};${GIT}`, { platform })), null); // seal: a made-up Windows PATH handed to a pure function
    assert.equal(windowsStart('gh', ['x'], so(`${OWN};${GIT}`, { platform })), null); // seal: a made-up Windows PATH handed to a pure function
  }
  assert.equal(windowsStandIn('gh', ['x'], so(`${OWN};${GIT}`, { traps: '' })), null, 'no trap folder: not under the runner'); // seal: a made-up Windows PATH handed to a pure function
});

// Git for Windows' sh, which starts a test's #!/bin/sh stand-in there, looks a bare name up as `name` and `name.exe`,
// never as `name.cmd`: the trap folder holds an sh trap of each name beside its .cmd, so a trapped name called from
// inside such a stand-in is caught and written down as on Linux (tools/test-traps.mjs makeTraps).
test('Windows: every trap is also an sh script of the name itself, which writes its line into the log as on Linux', async () => {
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { execFileSync } = await import('node:child_process');
  const { makeTraps } = await import('../tools/test-traps.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-shtraps-'));
  try {
    // Windows' answers for the paths: the log and the Node of a Windows computer, written with / for its sh.
    makeTraps({ dir: path.join(dir, 'win'), log: 'C:\\Users\\dev\\AppData\\Local\\Temp\\hoprig-tests-x\\forbidden.log', roots: [dir], platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe' });
    for (const name of ['gh', 'sudo', 'ssh', 'taskkill', 'shutdown']) {
      assert.ok(fs.existsSync(path.join(dir, 'win', `${name}.cmd`)), `${name}.cmd for Node and cmd`);
      const text = fs.readFileSync(path.join(dir, 'win', name), 'utf8');
      assert.match(text, /^#!\/bin\/sh\n/, `${name} for sh`);
      assert.ok(text.includes(">> 'C:/Users/dev/AppData/Local/Temp/hoprig-tests-x/forbidden.log'"), text);
    }
    assert.match(fs.readFileSync(path.join(dir, 'win', 'npm'), 'utf8'), /^#!\/bin\/sh\nexec 'C:\/Program Files\/nodejs\/node\.exe' '[^']*test-traps\.mjs' /);
    // The sh trap itself, run by an sh here: it writes its line and ends with the trap's code.
    const log = path.join(dir, 'forbidden.log');
    makeTraps({ dir: path.join(dir, 'run'), log, roots: [dir], platform: 'win32' });
    let code = 0;
    try {
      execFileSync('sh', [path.join(dir, 'run', 'gh'), 'auth', 'status'], { env: { ...process.env, HOPRIG_TEST_FILE: 'test/made-up.test.mjs' }, stdio: 'ignore' }); // seal: the trap itself is the program run
    } catch (e) {
      code = e.status;
    }
    const { TRAP_EXIT } = await import('../tools/test-traps.mjs');
    assert.equal(code, TRAP_EXIT);
    assert.equal(fs.readFileSync(log, 'utf8'), 'gh\tauth status\ttest/made-up.test.mjs\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
