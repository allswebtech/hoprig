// Windows: the Path is read again from the registry by the facts themselves (sysFacts), with the platform and the
// registry's answer handed in, so Windows' answers are given here on any system. The same pc setup run sees what winget
// just installed, and the dashboard's tool list sees it without a restart (at most one registry read a minute, and one
// right after an install it ran). A made-up registry and made-up programs: nothing reaches a real reg, winget or python.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winpath-fresh-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const W = await import('../../src/setup/winpath.mjs');
const { sysFacts, detectKits } = await import('../../src/pcsetup/detect.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const MACHINE = 'C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\Git\\cmd;';
const USER_BEFORE = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;';
const RG = '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\BurntSushi.ripgrep.MSVC\\ripgrep-14.1.1';
const ENV = { USERPROFILE: 'C:\\Users\\alex', LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' };
const rgDir = W.expandVars(RG, ENV).toLowerCase();

/** A made-up registry: answers only the one PowerShell call that reads both keys; `reads` counts those calls. */
function registry() {
  const reg = { user: USER_BEFORE, reads: 0 };
  reg.run = async (argv) => {
    if (argv.join(' ') !== W.envQuery().join(' ')) return { ok: false, stdout: '' };
    reg.reads += 1;
    return { ok: true, stdout: JSON.stringify({ machine: { Path: { kind: 'ExpandString', value: MACHINE } }, user: { Path: { kind: 'ExpandString', value: reg.user } } }) };  // seal: a made-up registry answer, no program is started
  };
  return reg;
}

/** Windows' facts: winget, git and jq are here; rg is found only once its folder is on this env's PATH. */
const winFacts = (env, reg, more = {}) => ({
  platform: 'win32', pm: 'winget', root: false, user: 'alex', arch: 'x64', tmp: 'C:\\t', home: 'C:\\Users\\alex', ws: null, env,
  has: (b) => ['winget', 'git', 'jq'].includes(b) || (b === 'rg' && String(env.PATH).toLowerCase().includes(rgDir)),
  run: async (argv) => ({ ok: true, code: 0, stdout: `${argv[0]} 1.2.3`, stderr: '' }),
  registry: reg.run, exists: () => false, blockHas: () => false, list: () => [],
  ...more,
});

test('pc setup on Windows, with only the registry handed in: the same run sees what winget just installed', async () => {
  const reg = registry();
  const env = { ...ENV, PATH: 'C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\Git\\cmd' }; // seal: a function's input; its runner is a stand-in
  const sys = await sysFacts(winFacts(env, reg));
  assert.equal((await detectKits(sys, ['extras'])).extras.find((i) => i.id === 'ripgrep').state, 'missing');
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const runner = async (argv) => {
    if (argv[0] === 'winget' && argv.includes('BurntSushi.ripgrep.MSVC')) reg.user = `${USER_BEFORE}${RG}`; // winget writes the user's Path
    return { ok: true, code: 0, output: '' };
  };
  const r = await runPcSetup({ ui, kits: ['extras'], sys, runner, codingTools: { findTool: () => null } });
  const text = out.join('');
  assert.deepEqual(r.missing, [], text);
  assert.doesNotMatch(text, /still missing/);
  assert.match(text, /Extra tools: ready|ready/);
  assert.ok(env.PATH.toLowerCase().includes(rgDir), 'the process itself has the new folder now');
});

test('the dashboard: its tool list sees a tool installed while it runs, without a restart; at most one registry read a minute', async () => {
  const reg = registry();
  const env = { ...ENV, PATH: 'C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\Git\\cmd' }; // seal: a function's input; its runner is a stand-in
  let now = 1_000_000;
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [] }, deck: { launcher: () => ['node', 'hoprig'], terminal: async () => {} } };
  const extras = { suggested: [], php: [], java: null };
  const f = pcsetupFeature(sctx, { computer: () => 'box2', facts: winFacts(env, reg, { clock: () => now }), extras, status: async () => [], projectsDir: () => path.join(tmp, 'projects'), sudoNeedsPassword: async () => false });
  const kits = async () => {
    for (const [m, re, fn] of f.routes) if (m === 'GET' && re.exec('/api/pcsetup/kits')) return fn(Readable.from([]), null, new URLSearchParams());
    throw new Error('no route');
  };
  const rg = async () => (await kits()).kits.find((k) => k.id === 'extras').items.find((i) => i.id === 'ripgrep').state;
  assert.equal(await rg(), 'missing');
  assert.equal(reg.reads, 1);
  reg.user = `${USER_BEFORE}${RG}`; // installed by hand, while the dashboard runs
  now += 10_000;
  assert.equal(await rg(), 'missing', 'within the minute the registry is not read again');
  assert.equal(reg.reads, 1);
  now += 51_000;
  assert.equal(await rg(), 'ok', 'a minute on: read again, found');
  assert.equal(reg.reads, 2);
});

test('after an install this process ran, the registry is read again at once, whatever the minute', async () => {
  const reg = registry();
  const env = { ...ENV, PATH: 'C:\\WINDOWS' }; // seal: a function's input; its runner is a stand-in
  let now = 5_000_000;
  const sys = await sysFacts(winFacts(env, reg, { clock: () => now }));
  assert.equal(reg.reads, 1);
  reg.user = `${USER_BEFORE}${RG}`;
  now += 1_000;
  await sysFacts(winFacts(env, reg, { clock: () => now }));
  assert.equal(reg.reads, 1, 'a look within the minute');
  assert.ok((await sys.refreshPath()).some((d) => d.toLowerCase() === rgDir), 'forced after an install');
  assert.equal(reg.reads, 2);
});

test('Linux and macOS: no registry is ever read, whatever is handed in', async () => {
  const reg = registry();
  for (const platform of ['linux', 'darwin']) {
    const sys = await sysFacts({ ...winFacts({ PATH: '/usr/bin' }, reg), platform, pm: null }); // seal: a function's input; its runner is a stand-in
    assert.deepEqual(await sys.refreshPath(), []);
  }
  assert.equal(reg.reads, 0);
});
