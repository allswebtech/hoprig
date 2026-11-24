// `hoprig setup` and `hoprig service install` as root on a computer where Hoprig was never set up: both start the same
// making of the work user, the installer shipped with this Hoprig (src/setup/rootwork.mjs). Root is played by facts;
// the installer's start is a stand-in that writes what it was handed. The installer itself has its tests in
// installroot.test.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const C = await import('../../src/config.mjs');
const W = await import('../../src/setup/rootwork.mjs');
const CLI = await import('../../src/server/cli.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { which } = await import('../../src/setup/system.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude(), loginctl: 'echo Linger=yes', systemctl: 'exit 0' });
process.env.PATH = pathWith(s.tmp, bin);
function sys(over = {}) {
  const env = { HOME: s.env.HOME, PATH: pathWith(s.tmp, bin) }; // seal: only the test's own stand-ins and node
  const S = K.sysInfo({ env, platform: 'linux', has: (c) => c !== 'systemctl' && !!which(c, env, 'linux'), pm: null, root: true, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, user: 'root', ...over });
  S.probe = async () => 200;
  return S;
}
async function run(args, over = {}) {
  const rec = recorder();
  const calls = [];
  const ui = makeUi({ interactive: false, yes: args.includes('--yes'), dryRun: args.includes('--dry-run'), write: rec.write, askLine: async () => '' });
  const S = sys(over);
  S.workSetup = async (a, o) => (calls.push({ args: a, env: o.env }), 0);
  const summary = {};
  const code = await SU.setup(args, { ui, sys: S, summary, parts: { pc: async () => ({ ok: true }), git: async () => ({ ok: true }), workspace: async () => ({ ok: true }), projects: async () => ({ dir: '/nowhere', names: [] }), projectSkills: async () => ({ ok: true, added: [], skipped: [] }), userSkills: async () => ({ ok: true, added: [], skipped: [] }) } });
  return { code, text: rec.text, calls, summary };
}

test('set-up as root with Hoprig never set up: the installer of this Hoprig makes the work user, with set-up\'s own arguments', async () => {
  C.saveConfig({ server: { passwordHash: null } });
  const r = await run(['--yes', '--access', 'local']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.calls.map((c) => c.args), [['--yes', '--access', 'local']]);
  assert.match(r.text, /This is root and Hoprig is not set up here yet: the installer of this Hoprig makes an ordinary user/);
  assert.doesNotMatch(r.text, /Node\.js|Claude/, 'nothing of set-up ran for root');
  assert.deepEqual(r.summary.steps, [{ id: 'work-user', end: 'done' }]);
});

test('set-up as root goes on for root where root is on purpose or Hoprig is set up for root already', async () => {
  assert.deepEqual((await run(['--yes', '--stay-root', '--no-service'])).calls, [], '--stay-root');
  C.saveConfig({ stayRoot: false });
  assert.deepEqual((await run(['--yes', '--no-service'], { exists: (f) => f === '/.dockerenv' })).calls, [], 'a container');
  C.saveConfig({ server: { passwordHash: 'scrypt$made-up' } });
  const before = await run(['--yes', '--no-service']);
  assert.deepEqual(before.calls, [], 'an installation of before');
  assert.match(before.text, /Runs as root: Hoprig works as root here\..*Next: hoprig move-to-user/);
  C.saveConfig({ server: { passwordHash: null } });
  assert.deepEqual((await run(['--yes', '--no-service'], { root: false, user: 'alex' })).calls, [], 'an ordinary user');
});

test('service install as root with Hoprig never set up: the same making; otherwise the command goes on as before', async () => {
  const calls = [];
  const work = async (a) => (calls.push(a), 0);
  const root = { root: true, container: [], stay: false };
  C.saveConfig({ server: { passwordHash: null } });
  assert.equal(await CLI.freshRootSetup({ facts: root, installed: false, work }), 0);
  assert.deepEqual(calls, [[]]);
  assert.equal(await CLI.freshRootSetup({ facts: root, installed: true, work }), null, 'root has its service already');
  assert.equal(await CLI.freshRootSetup({ facts: { ...root, stay: true }, installed: false, work }), null, 'on purpose');
  assert.equal(await CLI.freshRootSetup({ facts: { ...root, root: false }, installed: false, work }), null, 'not root');
  C.saveConfig({ server: { passwordHash: 'scrypt$made-up' } });
  assert.equal(await CLI.freshRootSetup({ facts: root, installed: false, work }), null, 'set up for root already');
  assert.equal(calls.length, 1);
});

test('the installer is this Hoprig\'s own, its source this Hoprig\'s folder (the same build), and only a typed --yes counts', async () => {
  const c = W.workSetupCommand(['--yes'], { PATH: '/x', HOPRIG_YES: '1', HOPRIG_SOURCE: 'https://example.com/newest.tgz' }); // seal: a value no program is started with
  assert.deepEqual(c.argv, ['sh', path.join(K.appRoot(), 'install.sh'), '--yes']);
  assert.equal(c.env.HOPRIG_SOURCE, K.appRoot());
  assert.equal(c.env.HOPRIG_INSTALL_COMMAND, 'hoprig setup');
  assert.equal('HOPRIG_YES' in c.env, false);
  // Never started but by the real root.
  assert.equal(await W.runWorkSetup(['--yes'], { uid: 1000 }), 1);
});
