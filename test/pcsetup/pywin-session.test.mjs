// Windows' Python kit: the install manager alone gives no Python, and in a session without a desktop it installs none.
// Such a session is not only SSH: a scheduled task or a service has no SESSIONNAME, or "Services". There the kit's
// result says what was installed, what is not there yet and the one line to type in a window of one's own, in the CLI
// run and in the dashboard's kit row. With a desktop the runtime itself is installed, and found in the same run.
// Made-up registry and programs: nothing reaches a real winget, pymanager, powershell or python.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pywin-session-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const W = await import('../../src/setup/winpath.mjs');
const { sysFacts, detectKits } = await import('../../src/pcsetup/detect.mjs');
const { buildPlan, noDesktop } = await import('../../src/pcsetup/kits.mjs');
const { kitChecks } = await import('../../src/pcsetup/status.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const BASE = { USERPROFILE: 'C:\\Users\\alex', LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local', PATH: 'C:\\WINDOWS' }; // seal: a function's input; its runner is a stand-in
const PYBIN = 'C:\\Users\\alex\\AppData\\Local\\Python\\bin';

/**
 * A made-up Windows: `state.manager` (the install manager installed), `state.python` (a Python installed) and the
 * user's Path in the registry (`state.userPath`). Programs are found only on this env's PATH as it is now.
 */
function windows(env) {
  const state = { manager: false, python: false, userPath: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps' };
  const onPath = (dir) => String(env.PATH).toLowerCase().split(';').includes(dir.toLowerCase());
  const has = (b) => b === 'winget' || (b === 'pymanager' && state.manager) || ((b === 'python' || b === 'py') && state.python && onPath(PYBIN));
  const registry = async (argv) => (argv.join(' ') === W.envQuery().join(' ')
    ? { ok: true, stdout: JSON.stringify({ machine: { Path: { kind: 'ExpandString', value: 'C:\\WINDOWS' } }, user: { Path: { kind: 'ExpandString', value: state.userPath } } }) }  // seal: a made-up registry answer, no program is started
    : { ok: false, stdout: '' });
  const run = async (argv) => {
    if (argv[0] === 'winget' && argv[1] === '--version') return { ok: true, code: 0, stdout: 'v1.12.350' };
    if ((argv[0] === 'python' || argv[0] === 'py') && has(argv[0])) {
      if (argv[1] === '--version') return { ok: true, code: 0, stdout: 'Python 3.14.1' };
      if (argv[1] === '-m') return { ok: true, code: 0, stdout: 'pip 25.3 from x (python 3.14)' };
      return { ok: true, code: 0, stdout: 'venv ok' };
    }
    return { ok: false, code: 1, stdout: '', stderr: '' };
  };
  // What each step does on that computer: winget installs the manager; pymanager installs a Python; the PowerShell
  // step puts the install manager's folder on the user's Path in the registry.
  const ran = [];
  const runner = async (argv) => {
    ran.push(argv[0]);
    if (argv[0] === 'winget' && argv.includes('9NQ7512CXL7T')) state.manager = true;
    if (argv[0] === 'pymanager') state.python = true;
    if (argv[0] === 'powershell.exe') state.userPath += ';%LOCALAPPDATA%\\Python\\bin';
    return { ok: true, code: 0, output: '' };
  };
  const facts = { platform: 'win32', root: false, user: 'alex', arch: 'x64', tmp: 'C:\\t', home: 'C:\\Users\\alex', ws: null, env, has, run, registry, exists: () => false, blockHas: () => false, list: () => [] };
  return { state, facts, runner, ran };
}

test('which sessions have no desktop: SSH, no SESSIONNAME (a scheduled task, a service), "Services"; Console and RDP have one', () => {
  assert.equal(noDesktop({ SESSIONNAME: 'Console' }), false);
  assert.equal(noDesktop({ SESSIONNAME: 'RDP-Tcp#3' }), false);
  assert.equal(noDesktop({}), true);
  assert.equal(noDesktop({ SESSIONNAME: 'Services' }), true);
  assert.equal(noDesktop({ SESSIONNAME: 'Console', SSH_CONNECTION: '10.0.0.5 50000 10.0.0.9 22' }), true); // seal: a function's input
});

for (const [name, extra] of [['a scheduled task (no SESSIONNAME, no SSH variables)', {}], ['a service session (SESSIONNAME=Services)', { SESSIONNAME: 'Services' }]]) {
  test(`Python kit in ${name}: no pymanager step; the result says what was installed, what is not, and the one line to type`, async () => {
    const env = { ...BASE, ...extra };
    const win = windows(env);
    const sys = await sysFacts(win.facts);
    const plan = buildPlan(['python'], await detectKits(sys, ['python']), sys);
    assert.deepEqual(plan.steps.map((s) => s.argv[0]), ['winget', 'powershell.exe'], 'no pymanager without a desktop');
    const out = [];
    const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
    const r = await runPcSetup({ ui, kits: ['python'], sys, runner: win.runner, codingTools: { findTool: () => null } });
    const text = out.join('');
    assert.ok(!win.ran.includes('pymanager'));
    assert.ok(r.missing.includes('python.python'));
    assert.match(text, /Python: the Python install manager is installed; Python itself, pip and venv are not there yet/);
    assert.match(text, /cannot be done in a session without a desktop .*\n\s+pymanager install default\n.*hoprig pc setup again/);
    assert.doesNotMatch(text, /still missing python3/);
    assert.doesNotMatch(text, /sign out of Windows/);
    // Where a later look shows the kit (pc status and the dashboard's rows): the same three things, not only "missing".
    const found = await detectKits(sys, ['python']);
    const py = found.python.find((i) => i.id === 'python');
    assert.equal(py.state, 'missing');
    assert.match(py.detail, /only the Python install manager is here: Python itself, pip and venv are not installed yet\. Next: in a PowerShell window of your own on this computer, run pymanager install default, then hoprig pc setup again/);
    const row = kitChecks(found, sys).find((c) => c.id === 'python.python');
    assert.match(row.detail, /Next: in a PowerShell window of your own on this computer, run pymanager install default/);
    assert.match(found.python.find((i) => i.id === 'pip').detail, /comes with Python itself, which is not installed yet/);
  });
}

test('the dashboard\'s kit list says the same next step for Python, with nothing installed again', async () => {
  const env = { ...BASE };
  const win = windows(env);
  win.state.manager = true; // installed by an earlier run
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [] }, deck: { launcher: () => ['node', 'hoprig'], terminal: async () => {} } };
  const f = pcsetupFeature(sctx, { computer: () => 'box2', facts: win.facts, extras: { suggested: [], php: [], java: null }, status: async () => [], projectsDir: () => path.join(tmp, 'projects'), sudoNeedsPassword: async () => false });
  const [, , route] = f.routes.find(([m, re]) => m === 'GET' && re.exec('/api/pcsetup/kits'));
  const kit = (await route(Readable.from([]), null, new URLSearchParams())).kits.find((k) => k.id === 'python');
  assert.match(kit.items.find((i) => i.id === 'python').detail, /only the Python install manager is here.*Next: in a PowerShell window of your own on this computer, run pymanager install default, then hoprig pc setup again/);
  assert.ok(kit.commands.every((c) => !c.includes('9NQ7512CXL7T')), 'the install manager is not installed again');
});

test('Python kit at the desktop (SESSIONNAME=Console): the runtime itself is installed, and found in the same run', async () => {
  const env = { ...BASE, SESSIONNAME: 'Console' };
  const win = windows(env);
  const sys = await sysFacts(win.facts);
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const r = await runPcSetup({ ui, kits: ['python'], sys, runner: win.runner, codingTools: { findTool: () => null } });
  const text = out.join('');
  assert.deepEqual(win.ran, ['winget', 'pymanager', 'powershell.exe']);
  assert.deepEqual(r.missing, [], text);
  assert.match(text, /Python: ready/);
  assert.doesNotMatch(text, /window of your own|sign out of Windows/);
});
