// Windows: winget that is registered (an App Execution Alias, so which() finds it) but does not start (spawn winget
// EACCES). "winget is there" means `winget --version` ran: doctor says it is registered but does not start, with the
// error and what to do; pc setup runs no winget step, and each kit it would have installed names its own installer.
// Made-up answers: nothing reaches a real winget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-start-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { sysFacts, detectKits } = await import('../../src/pcsetup/detect.mjs');
const { buildPlan, WIN_INSTALLERS } = await import('../../src/pcsetup/kits.mjs');
const { kitChecks } = await import('../../src/pcsetup/status.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { wingetChecks } = await import('../../src/setup/checks.mjs');
const { wingetState } = await import('../../src/setup/system.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const EACCES = { ok: false, code: null, stdout: '', stderr: '', error: 'EACCES' };
/** Windows' answers: winget is found on Path; `--version` gives `answer`; nothing else is here. */
const winFacts = (answer, asked) => ({
  platform: 'win32', root: false, user: 'alex', arch: 'x64', tmp: 'C:\\t', home: 'C:\\Users\\alex', ws: null, env: { PATH: 'C:\\WINDOWS' }, // seal: a function's input; its runner is a stand-in
  has: (b) => b === 'winget',
  run: async (argv) => (asked.push(argv.join(' ')), argv[0] === 'winget' && argv[1] === '--version' ? answer : { ok: false, code: 1, stdout: '', stderr: '' }),
  exists: () => false, blockHas: () => false, list: () => [], refreshPath: async () => [],
});

test('doctor on Windows: winget found but --version fails with EACCES: registered but does not start, the error, what to do', async () => {
  const asked = [];
  const sys = winFacts(EACCES, asked);
  const [line] = await wingetChecks({ ...sys, env: {} }, sys.run);
  assert.equal(line.id, 'winget');
  assert.equal(line.status, 'warn');
  assert.match(line.detail, /winget is registered but does not start \(spawn winget EACCES\)/);
  assert.match(line.detail, /App Installer from the Microsoft Store/);
  assert.match(line.detail, /https:\/\/learn\.microsoft\.com\/windows\/package-manager\/winget\//);
  assert.match(line.fix, /App Installer/);
  // An exit code instead of a start error is named as that.
  const [code] = await wingetChecks({ ...sys, env: {} }, async () => ({ ok: false, code: 2316632065, stdout: '', stderr: '' }));
  assert.match(code.detail, /does not start \(exit code 2316632065\)/);
  // One that starts: ok, with its version; not on Windows: no line, nothing asked.
  const [ok] = await wingetChecks({ ...sys, env: {} }, async () => ({ ok: true, code: 0, stdout: 'v1.12.350\r\n' }));
  assert.deepEqual([ok.status, ok.detail], ['ok', '1.12.350']);
  assert.deepEqual(await wingetChecks({ platform: 'linux', env: {}, has: () => true }, async () => assert.fail('nothing asked')), []);
});

test('pc setup on Windows with a winget that does not start: no winget step run, each kit names its own installer', async () => {
  const asked = [];
  const sys = await sysFacts(winFacts(EACCES, asked));
  assert.equal(sys.pm, null, 'winget is not taken for the package manager');
  assert.deepEqual([sys.winget.here, sys.winget.starts], [true, false]);
  const kits = ['basics', 'node', 'python', 'github', 'extras', 'docker'];
  const found = await detectKits(sys, kits);
  const plan = buildPlan(kits, found, sys);
  assert.deepEqual(plan.steps.filter((s) => s.argv && s.argv[0] === 'winget'), [], 'no winget step');
  // On a Windows computer the made-up Windows runs on this test's own Node: it is there, off this PATH (detect.mjs), so
  // it is not one to install; anywhere else Node is missing from the made-up Windows like the rest.
  const here = process.platform === 'win32' ? ['node'] : [];
  if (here.length) assert.equal(found.node.find((i) => i.id === 'node').state, 'offpath');
  for (const id of ['git', 'build', 'node', 'npm', 'python', 'gh', 'ripgrep', 'jq', 'docker'].filter((x) => !here.includes(x))) {
    const c = plan.cannot.find((x) => x.item === id);
    assert.ok(c, `${id} is named`);
    assert.match(c.why, new RegExp(`official installer, ${WIN_INSTALLERS[id].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`), id);
  }
  // The dashboard's rows of the same kits say the installer too, with no Install button that runs winget.
  const rows = kitChecks(found, sys);
  const gitRow = rows.find((r) => r.id === 'basics.git');
  assert.match(gitRow.detail, /git-scm\.com\/downloads\/win/);
  assert.equal(gitRow.fix, '');
  // The run itself: the winget line once, then each item's installer; the runner is never called.
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const ran = [];
  await runPcSetup({ ui, kits: ['basics', 'extras'], sys, runner: async (argv) => (ran.push(argv[0]), { ok: true, code: 0, output: '' }), codingTools: { findTool: () => null } });
  const text = out.join('');
  assert.deepEqual(ran, [], 'nothing was started');
  assert.equal(text.match(/winget is registered but does not start \(spawn winget EACCES\)/g).length, 1, text);
  assert.match(text, /ripgrep \(.*\): winget does not work here.*github\.com\/BurntSushi\/ripgrep\/releases/);
  assert.match(text, /jq \(.*\): winget does not work here.*jqlang\.org\/download/);
  assert.equal(asked.filter((a) => a === 'winget --version').length, 1, 'one --version call for the run');
});

test('a winget that starts is asked once and kept; one that does not is asked again', async () => {
  const env = {};
  let calls = 0;
  const run = async () => (calls += 1, { ok: true, code: 0, stdout: 'v1.12.350' });
  assert.equal((await wingetState({ has: () => true, run, env })).starts, true);
  assert.equal((await wingetState({ has: () => true, run, env })).starts, true);
  assert.equal(calls, 1);
  const env2 = {};
  let n = 0;
  const bad = async () => (n += 1, EACCES);
  await wingetState({ has: () => true, run: bad, env: env2 });
  await wingetState({ has: () => true, run: bad, env: env2 });
  assert.equal(n, 2);
  assert.deepEqual(await wingetState({ has: () => false, run: async () => assert.fail('not asked'), env: {} }), { here: false, starts: false, version: null, why: 'not found' });
});
