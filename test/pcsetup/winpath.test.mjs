// Windows: after winget installs something, the same run (and the dashboard's next look) finds it, because the Path is
// read again from the registry; Python counts only when a python (or the py launcher) really runs. A made-up registry
// and made-up programs: nothing here reaches the real reg, winget or python.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winpath-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const W = await import('../../src/setup/winpath.mjs');
const { sysFacts, detectKits } = await import('../../src/pcsetup/detect.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

// The made-up registry answers the one PowerShell call that reads both keys (winpath.mjs ENV_SCRIPT), as JSON with
// every letter beyond ASCII escaped. Anything else (a real reg or powershell) is never reached.
const MACHINE = 'C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\Git\\cmd;';
const USER_BEFORE = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;';
const RG = '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\BurntSushi.ripgrep.MSVC\\ripgrep-14.1.1';
// SESSIONNAME: a session with a desktop (kits.mjs noDesktop), where the Python install manager installs Python.
const ENV = { USERPROFILE: 'C:\\Users\\alex', LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local', SESSIONNAME: 'Console' };
const asciiJson = (o) => JSON.stringify(o).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';
const isEnvQuery = (argv) => argv[0] === 'powershell.exe' && argv.join(' ') === W.envQuery().join(' ');

// reg.exe writes the console's code page, which Node reads as UTF-8: a letter beyond ASCII comes back as U+FFFD.
const codePage = (t) => t.replace(/[^\x00-\x7f]/g, '\ufffd');

/**
 * `keys()` → { machine, user }, each { name: [kind, value] }. It also answers `reg query <key> /v Path` as reg.exe
 * prints it, so a reader that still asked reg would get what it got on Windows.
 */
function registryOf(keys) {
  return async (argv) => {
    if (argv[0] === 'reg' && argv[1] === 'query') {
      const k = keys()[argv[2] === MACHINE_KEY ? 'machine' : argv[2] === USER_KEY ? 'user' : 'none'];
      const p = k && k.Path;
      return p ? { ok: true, stdout: codePage(`\r\n${argv[2]}\r\n    Path    ${p[0] === 'ExpandString' ? 'REG_EXPAND_SZ' : 'REG_SZ'}    ${p[1]}\r\n\r\n`) } : { ok: false, stdout: '' };
    }
    if (!isEnvQuery(argv)) return { ok: false, stdout: '' };
    const k = keys();
    const one = (o) => (o ? Object.fromEntries(Object.entries(o).map(([n, [kind, value]]) => [n, { kind, value }])) : undefined);
    return { ok: true, stdout: asciiJson({ machine: one(k.machine), user: one(k.user) }) };
  };
}
const registry = (user) => registryOf(() => ({ machine: { Path: ['ExpandString', MACHINE] }, user: { Path: ['ExpandString', user()] } })); // seal: a made-up registry answer for a stand-in run

test('the registry read: one PowerShell call, its answer parsed; nothing when it cannot be read', async () => {
  const keys = W.parseEnvKeys(asciiJson({ machine: { Path: { kind: 'ExpandString', value: 'C:\\x' } }, user: { TEMP: { kind: 'ExpandString', value: '%USERPROFILE%\\t' } } })); // seal: a made-up registry answer, a function's input
  assert.deepEqual(keys, { machine: { Path: { kind: 'ExpandString', value: 'C:\\x' } }, user: { TEMP: { kind: 'ExpandString', value: '%USERPROFILE%\\t' } } }); // seal: a made-up registry answer, a function's input
  assert.equal(W.parseEnvKeys('ERROR'), null);
  assert.equal(await W.systemPath({ env: ENV, run: async () => ({ ok: false, stdout: '' }) }), null);
  const script = Buffer.from(W.envQuery().at(-1), 'base64').toString('utf16le');
  assert.match(script, /DoNotExpandEnvironmentNames/);
  assert.match(script, /HKCU\\Environment/);
});

test('a variable the installer defined at the same time is expanded in Path; a folder left with a %NAME% or not whole is dropped', async () => {
  // NVM_HOME and NVM_SYMLINK were just written to the user's key; this process has never seen them.
  const reg = registryOf(() => ({
    machine: { Path: ['ExpandString', MACHINE] }, // seal: a made-up registry answer for a stand-in run
    user: { Path: ['ExpandString', '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%NVM_HOME%;%NVM_SYMLINK%;%NOT_DEFINED%\\bin;relative\\bin'], NVM_HOME: ['String', 'C:\\Users\\alex\\AppData\\Local\\nvm'], NVM_SYMLINK: ['ExpandString', '%ProgramFiles%\\nodejs'] }, // seal: a made-up registry answer for a stand-in run
  }));
  const env = { ...ENV, ProgramFiles: 'C:\\Program Files', PATH: 'C:\\WINDOWS\\system32' }; // seal: a function's input; its runner is a stand-in
  const added = await W.refreshPath(env, { run: reg });
  assert.deepEqual(added, ['C:\\WINDOWS', 'C:\\Program Files\\Git\\cmd', 'C:\\Users\\alex\\AppData\\Local\\Microsoft\\WindowsApps', 'C:\\Users\\alex\\AppData\\Local\\nvm', 'C:\\Program Files\\nodejs']);
  assert.doesNotMatch(env.PATH, /%|relative/);
});

test('a folder beyond ASCII (a profile such as C:\\Users\\José) comes back whole', async () => {
  const reg = registryOf(() => ({ machine: { Path: ['ExpandString', MACHINE] }, user: { Path: ['String', 'C:\\Users\\José\\tools;C:\\Programme\\Größe'] } })); // seal: a made-up registry answer for a stand-in run
  const env = { USERPROFILE: 'C:\\Users\\José', PATH: MACHINE }; // seal: a function's input; its runner is a stand-in
  assert.deepEqual(await W.refreshPath(env, { run: reg }), ['C:\\Users\\José\\tools', 'C:\\Programme\\Größe']);
});

test('expanded, quoted and trailing-semicolon entries; nothing taken away; nothing twice', () => {
  assert.equal(W.expandVars('%userprofile%\\bin;%NOPE%\\x', ENV), 'C:\\Users\\alex\\bin;%NOPE%\\x');
  const m = W.mergePath('C:\\WINDOWS\\system32;C:\\Tools\\mine;', 'c:\\windows\\System32\;"C:\\Program Files\\Git\\cmd";;C:\\new');
  assert.deepEqual(m.added, ['C:\\Program Files\\Git\\cmd', 'C:\\new']);
  assert.equal(m.path, 'C:\\WINDOWS\\system32;C:\\Tools\\mine;C:\\Program Files\\Git\\cmd;C:\\new');
});

test('pc setup on Windows: what winget just installed is found in the same run, with the Path the registry has now', async () => {
  let user = USER_BEFORE;
  const env = { ...ENV, PATH: 'C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\Git\\cmd' }; // seal: a function's input; its runner is a stand-in
  const reg = registry(() => user);
  const rgDir = W.expandVars(RG, ENV).toLowerCase();
  const has = (b) => b === 'winget' || b === 'git' || b === 'jq' || (b === 'rg' && env.PATH.toLowerCase().includes(rgDir));
  const run = async (argv) => (isEnvQuery(argv) || argv[0] === 'reg' ? reg(argv) : { ok: true, code: 0, stdout: `${argv[0]} 1.2.3`, stderr: '' });
  const sys = await sysFacts({ platform: 'win32', pm: 'winget', root: false, user: 'alex', arch: 'x64', tmp: 'C:\\t', home: 'C:\\Users\\alex', env, has, run, exists: () => false, refreshPath: (e) => W.refreshPath(e, { run: reg }) });
  const before = await detectKits(sys, ['extras']);
  assert.equal(before.extras.find((i) => i.id === 'ripgrep').state, 'missing');
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const runner = async (argv) => {
    if (argv[0] === 'winget' && argv.includes('BurntSushi.ripgrep.MSVC')) user = `${USER_BEFORE}${RG}`; // winget writes the user's Path
    return { ok: true, code: 0, output: '' };
  };
  const r = await runPcSetup({ ui, kits: ['extras'], sys, runner, codingTools: { findTool: () => null } });
  const text = out.join('');
  assert.deepEqual(r.missing, [], text);
  assert.doesNotMatch(text, /still missing/);
  assert.match(text, /ready/);
  assert.ok(env.PATH.toLowerCase().includes(rgDir), 'the run itself has the new folder now');
});

test('Windows Python: python or the py launcher that runs counts; the Store stand-in does not, and is named', async () => {
  const look = async (bins, out) => {
    const run = async (argv) => out[argv.join(' ')] || { ok: false, code: 1, stdout: '', stderr: 'nope' };
    const sys = await sysFacts({ platform: 'win32', pm: 'winget', has: (b) => bins.includes(b), run, exists: () => false, home: 'C:\\Users\\alex', root: false, user: 'alex', env: {}, refreshPath: async () => [] });
    return Object.fromEntries((await detectKits(sys, ['python'])).python.map((i) => [i.id, i]));
  };
  const STUB = { ok: false, code: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.' };
  let f = await look(['python'], { 'python --version': STUB, 'python -m pip --version': STUB, 'python -c import venv, ensurepip; print("venv ok")': STUB });
  assert.equal(f.python.state, 'missing');
  assert.match(f.python.detail, /stand-in python .*Microsoft Store/);
  f = await look(['python', 'py'], {
    'python --version': STUB,
    'py --version': { ok: true, code: 0, stdout: 'Python 3.14.1' },
    'py -m pip --version': { ok: true, code: 0, stdout: 'pip 25.3 from C:\\Users\\alex\\AppData\\Local\\Python\\pythoncore-3.14-64\\Lib\\site-packages\\pip (python 3.14)' },
    'py -c import venv, ensurepip; print("venv ok")': { ok: true, code: 0, stdout: 'venv ok' },
  });
  assert.deepEqual([f.python.state, f.python.version, f.pip.state, f.venv.state], ['ok', '3.14.1', 'ok', 'ok']);
  assert.match(f.python.detail, /py launcher/);
});

test('an App Execution Alias in WindowsApps is found (stat says EACCES, lstat a link); whether it works is decided by running it', async () => {
  const { which } = await import('../../src/setup/system.mjs');
  const { detectWinPython } = await import('../../src/pcsetup/detect.mjs');
  const apps = 'C:\\Users\\alex\\AppData\\Local\\Microsoft\\WindowsApps';
  const elsewhere = 'C:\\Tools';
  const aliases = new Set(['python.exe', 'py.exe'].flatMap((n) => [path.join(apps, n), path.join(elsewhere, n)]));
  const { statSync, lstatSync } = fs;
  fs.statSync = (f, ...a) => {
    if (aliases.has(String(f))) throw Object.assign(new Error(`EACCES: permission denied, stat '${f}'`), { code: 'EACCES' });
    return statSync(f, ...a);
  };
  fs.lstatSync = (f, ...a) => (aliases.has(String(f)) ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } : lstatSync(f, ...a));
  try {
    const env = { PATH: apps, PATHEXT: '.com;.exe;.bat;.cmd' }; // seal: a function's input (which() reads stubbed files); lower case: this test's file names are compared with case on Linux
    assert.equal(which('python', env, 'win32'), path.join(apps, 'python.exe'));
    assert.equal(which('py', env, 'win32'), path.join(apps, 'py.exe'));
    assert.equal(which('python', { ...env, PATH: elsewhere }, 'win32'), null, 'a link anywhere else is not taken for an alias'); // seal: a function's input (which() reads stubbed files)
    assert.equal(which('python', env, 'linux'), null, 'only on Windows');
    // The Store's stand-in: found, run, and named as what it is.
    const STUB = { ok: false, code: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.' };
    const asked = [];
    const sys = { platform: 'win32', has: (c) => !!which(c, env, 'win32'), run: async (argv) => (asked.push(argv.join(' ')), STUB) };
    const r = await detectWinPython({ id: 'python', version: ['python3', '--version'] }, sys);
    assert.equal(r.state, 'missing');
    assert.match(r.detail, /stand-in python .*Microsoft Store/);
    assert.deepEqual(asked, ['python --version', 'py --version'], 'decided by running it');
    // The install manager's python, an alias too: it runs, so Python is there.
    const ok = await detectWinPython({ id: 'python', version: ['python3', '--version'] }, { ...sys, run: async () => ({ ok: true, code: 0, stdout: 'Python 3.14.1' }) });
    assert.deepEqual([ok.state, ok.version], ['ok', '3.14.1']);
  } finally {
    Object.assign(fs, { statSync, lstatSync });
  }
});

test('installed, and still not seen with the system Path: says a new sign-in to Windows makes it visible', async () => { // seal: a title
  const env = { ...ENV, PATH: 'C:\\WINDOWS' }; // seal: a function's input; its runner is a stand-in
  const reg = registry(() => USER_BEFORE);
  const sys = await sysFacts({ platform: 'win32', pm: 'winget', root: false, user: 'alex', arch: 'x64', tmp: 'C:\\t', home: 'C:\\Users\\alex', env, has: (b) => b === 'winget', run: async (a) => (isEnvQuery(a) || a[0] === 'reg' ? reg(a) : { ok: false, code: 1, stdout: '' }), exists: () => false, refreshPath: (e) => W.refreshPath(e, { run: reg }) });
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const r = await runPcSetup({ ui, kits: ['python'], sys, runner: async () => ({ ok: true, code: 0, output: '' }), codingTools: { findTool: () => null } });
  assert.ok(r.missing.includes('python.python'));
  assert.match(out.join(''), /Python: installed, but Windows shows it to programs only after you sign out of Windows and sign in again/);
});

test('Python kit: a failed step shows its retry and never the sign-out line', async () => {
  const env = { ...ENV, PATH: 'C:\\WINDOWS' }; // seal: a function's input; its runner is a stand-in
  const reg = registry(() => USER_BEFORE);
  const sys = await sysFacts({ platform: 'win32', pm: 'winget', root: false, user: 'alex', arch: 'x64', tmp: 'C:\\t', home: 'C:\\Users\\alex', env, has: (b) => b === 'winget', run: async (a) => (isEnvQuery(a) || a[0] === 'reg' ? reg(a) : { ok: false, code: 1, stdout: '' }), exists: () => false, refreshPath: (e) => W.refreshPath(e, { run: reg }) });
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  // winget installs the install manager; pymanager fails.
  const runner = async (argv) => ({ ok: argv[0] !== 'pymanager', code: argv[0] === 'pymanager' ? 1 : 0, output: '' });
  const r = await runPcSetup({ ui, kits: ['python'], sys, runner, codingTools: { findTool: () => null } });
  const text = out.join('');
  assert.ok(r.missing.includes('python.python'));
  assert.match(text, /retry:.*pymanager install default/);
  assert.doesNotMatch(text, /sign out of Windows/);
});

test('Python kit over SSH: no pymanager step there, the Path folder added, and the last words give the command for a window of your own', async () => {
  const { buildPlan, PY_PATH_SCRIPT } = await import('../../src/pcsetup/kits.mjs');
  const env = { ...ENV, PATH: 'C:\\WINDOWS', SSH_CONNECTION: '192.168.1.5 50000 192.168.1.9 22' }; // seal: a function's input; its runner is a stand-in
  const reg = registry(() => USER_BEFORE);
  const sys = await sysFacts({ platform: 'win32', pm: 'winget', root: false, user: 'alex', arch: 'x64', tmp: 'C:\\t', home: 'C:\\Users\\alex', env, has: (b) => b === 'winget', run: async (a) => (isEnvQuery(a) || a[0] === 'reg' ? reg(a) : { ok: false, code: 1, stdout: '' }), exists: () => false, refreshPath: (e) => W.refreshPath(e, { run: reg }) });
  const missing = await detectKits(sys, ['python']);
  const plan = buildPlan(['python'], missing, sys);
  const argvs = plan.steps.map((st) => st.argv[0]);
  assert.deepEqual(argvs, ['winget', 'powershell.exe'], 'no pymanager over SSH');
  const script = Buffer.from(plan.steps[1].argv.at(-1), 'base64').toString('utf16le');
  assert.equal(script, PY_PATH_SCRIPT);
  assert.match(script, /%LOCALAPPDATA%\\Python\\bin/);
  assert.match(script, /ExpandString/);
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const ran = [];
  const runner = async (argv) => (ran.push(argv[0]), { ok: true, code: 0, output: '' });
  await runPcSetup({ ui, kits: ['python'], sys, runner, codingTools: { findTool: () => null } });
  const text = out.join('');
  assert.ok(!ran.includes('pymanager'));
  assert.match(text, /cannot be done over SSH\. On that computer, in a window of your own .*\n\s+pymanager install default\n.*hoprig pc setup again: it looks once more/);
  assert.doesNotMatch(text, /sign out of Windows/);
  // Not over SSH: pymanager runs, then the Path folder is added.
  const { SSH_CONNECTION, ...local } = env;
  const plan2 = buildPlan(['python'], missing, { ...sys, env: local });
  assert.deepEqual(plan2.steps.map((st) => st.argv[0]), ['winget', 'pymanager', 'powershell.exe']);
});
