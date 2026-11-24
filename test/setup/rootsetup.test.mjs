// Set-up as root (src/setup/setup.mjs): the one line "Runs as root" is said once, before anything is set up, and
// `--stay-root` keeps the owner's choice in the settings, after which the line is information with no step. Root is
// played by facts (`sys.root`); stand-ins on the test's own PATH, nothing real is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const C = await import('../../src/config.mjs');
const { configFile } = await import('../../src/paths.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { which } = await import('../../src/setup/system.mjs');
const { STAY_ROOT_KEY } = await import('../../src/setup/rootfacts.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude(), loginctl: 'echo Linger=yes', systemctl: 'exit 0' });
process.env.PATH = pathWith(s.tmp, bin);
function sys(over = {}) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SSH_|DISPLAY$|WAYLAND_DISPLAY$|container$)/.test(k))), PATH: pathWith(s.tmp, bin) }; // seal: only the test's own folders, in an environment that keeps the runner's variables
  const S = K.sysInfo({ env, platform: 'linux', has: (c) => c !== 'systemctl' && !!which(c, env, 'linux'), pm: null, root: true, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, user: 'root', serviceSupported: true, exists: () => false, workUser: null, ...over });
  S.probe = async () => 200;
  return S;
}
const parts = {
  pc: async () => ({ ok: true }), git: async () => ({ ok: true }), workspace: async () => ({ ok: true }), projects: async () => ({ dir: '/nowhere', names: ['demo'] }),
  projectSkills: async () => ({ ok: true, added: [], skipped: [] }), userSkills: async () => ({ ok: true, added: [], skipped: [] }),
};
async function run(args, over) {
  const rec = recorder();
  const ui = makeUi({ interactive: false, yes: args.includes('--yes'), dryRun: args.includes('--dry-run'), write: rec.write, askLine: async () => '' });
  await SU.setup(args, { ui, sys: sys(over), parts });
  return rec.text;
}
const stayKept = () => C.loadConfig()[STAY_ROOT_KEY];

const SVC = await import('../../src/server/service/index.mjs');
const { unitDir, UNIT } = await import('../../src/server/service/systemd.mjs');
const { FRESH_ROOT_LINE } = await import('../../src/setup/rootfacts.mjs');

test('as root: "Runs as root" once, before anything is set up, with the move as its step', async () => {
  // Hoprig set up for root before (its dashboard password is there): a fresh one makes the work user (rootwork.test.mjs).
  C.saveConfig({ server: { passwordHash: 'scrypt$made-up' } });
  const t = await run(['--yes', '--no-service']);
  assert.equal(t.split('Runs as root').length - 1, 1, t);
  assert.match(t, /^ {2}! Runs as root: Hoprig works as root here\..*Next: hoprig move-to-user/m);
  assert.ok(t.indexOf('Runs as root') < t.indexOf('Node.js'), 'said before the first step');
  assert.equal(stayKept(), undefined, 'nothing is kept without the choice');
});

test('an ordinary user: nothing is said about root', async () => {
  assert.doesNotMatch(await run(['--yes', '--no-service'], { root: false, user: 'alex' }), /Runs as root/);
});

test('--stay-root: kept in the settings, said once as information with no step; a dry run keeps nothing', async () => {
  const dry = await run(['--dry-run', '--stay-root', '--no-service']);
  assert.match(dry, /^ {2}· Runs as root: on purpose, kept on root by your choice\./m);
  assert.equal(stayKept(), undefined, 'a dry run writes no setting');
  const t = await run(['--yes', '--stay-root', '--no-service']);
  assert.equal(t.split('Runs as root').length - 1, 1, t);
  assert.match(t, /^ {2}· Runs as root: on purpose, kept on root by your choice\./m);
  assert.doesNotMatch(t, /move-to-user/, 'nothing nags');
  assert.equal(stayKept(), true);
  // A later run without the flag reads the kept choice.
  assert.match(await run(['--yes', '--no-service']), /^ {2}· Runs as root: on purpose, kept on root by your choice\./m);
});

test('inside a container (a named file): information, naming the fact', async () => {
  fs.rmSync(configFile(), { force: true });
  const t = await run(['--yes', '--no-service'], { exists: (f) => f === '/.dockerenv' });
  assert.match(t, /^ {2}· Runs as root: on purpose, inside a container \(\/\.dockerenv\)\./m);
});

// The background service as root (src/server/service/index.mjs): never made NEW for root unless root is on purpose.
// The service manager is a stand-in `run` that writes down what it was asked; the unit goes into the test's home.
async function installAs(facts) {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(s.tmp, 'svc', 'config') };
  const asked = [];
  const run = async (cmd, args) => (asked.push([cmd, ...args].join(' ')), { ok: true, out: '', err: '' });
  const { log, error } = console;
  let said = '';
  console.log = console.error = (...m) => (said += `${m.join(' ')}\n`);
  try {
    const code = await SVC.service('install', 'linux', { env, run, lingerNote: false, rootFacts: facts });
    return { code, said, asked, unit: path.join(unitDir(env), UNIT) };
  } finally {
    Object.assign(console, { log, error });
  }
}
const facts = (over) => ({ root: true, container: [], stay: false, ...over });

test('service install as root: nothing made and nothing asked, one line; on purpose or already installed it goes on', async () => {
  fs.rmSync(path.join(s.tmp, 'svc'), { recursive: true, force: true });
  const no = await installAs(facts());
  assert.equal(no.code, 1);
  assert.equal(no.said.trim(), FRESH_ROOT_LINE);
  assert.deepEqual(no.asked, [], 'no systemctl, no loginctl');
  assert.equal(fs.existsSync(no.unit), false, 'no unit for root');
  for (const [why, over] of [['his choice', { stay: true }], ['a container', { container: ['/.dockerenv'] }]]) {
    fs.rmSync(path.join(s.tmp, 'svc'), { recursive: true, force: true });
    const r = await installAs(facts(over));
    assert.equal(r.code, 0, `${why}: ${r.said}`);
    assert.ok(fs.existsSync(r.unit), why);
  }
  // Already installed for root (an installation of before): it keeps working; the doctor offers the move.
  const again = await installAs(facts());
  assert.equal(again.code, 0, again.said);
  assert.deepEqual(again.asked.slice(0, 1), ['systemctl --user daemon-reload']);
  // An ordinary user: as before.
  fs.rmSync(path.join(s.tmp, 'svc'), { recursive: true, force: true });
  assert.equal((await installAs(facts({ root: false }))).code, 0);
});

test('set-up as root: no service is made for root and no lingering is listed; "not ready" at the end, exit 1', async () => {
  fs.rmSync(configFile(), { force: true });
  await SU.stepPassword(makeUi({ interactive: false, yes: true, write: () => {}, askLine: async () => '' }), {}, {});
  const unit = path.join(process.env.HOME, '.config', 'systemd', 'user', 'hoprig.service');
  fs.rmSync(unit, { force: true });
  const rec = recorder();
  const ui = makeUi({ interactive: false, yes: true, write: rec.write, askLine: async () => '' });
  const code = await SU.setup(['--yes'], { ui, sys: sys({ probe: async () => 0, running: async () => null }), parts });
  const t = rec.text;
  assert.equal(code, 1, t);
  assert.equal(t.split(FRESH_ROOT_LINE).length - 1, 1, t);
  assert.match(t, /hoprig is not ready.*: this is root, and no background service was made for root/i);
  assert.doesNotMatch(t, /enable-linger|Dashboard running in the background/);
  assert.equal(fs.existsSync(unit), false);
  // --stay-root: the service is made, as for an ordinary user.
  const rec2 = recorder();
  const ui2 = makeUi({ interactive: false, yes: true, write: rec2.write, askLine: async () => '' });
  await SU.setup(['--yes', '--stay-root'], { ui: ui2, sys: sys({ probe: async () => 200, running: async () => null }), parts });
  assert.doesNotMatch(rec2.text, new RegExp(FRESH_ROOT_LINE.slice(0, 40)));
  assert.ok(fs.existsSync(unit), rec2.text);
});

// The closing summary: it says "this is root", and its ssh line names the work user once there is
// one, never root@. The summary is drawn from a state of its own; the config is the test's.
test('the summary as root: "This is root" after "ready"; on purpose as information, else with the move', async () => {
  const say = async (state, over = {}) => {
    const rec = recorder();
    const ui = makeUi({ interactive: false, yes: true, write: rec.write, askLine: async () => '' });
    await SU.stepSummary(ui, state, { env: { SSH_CONNECTION: '192.168.1.20 50000 203.0.114.7 22' }, publicIps: [], user: 'root', ...over });
    return rec.text;
  };
  const { rootCheck } = await import('../../src/setup/rootfacts.mjs');
  const kept = rootCheck(facts({ stay: true }));
  let t = await say({ server: { sshPort: null }, root: kept, workUser: null });
  assert.match(t, /is ready\.\n {2}This is root, on purpose, kept on root by your choice\. Claude Code refuses bypass permissions mode for root/);
  // A work user Hoprig made: the ssh line names it, never root@.
  t = await say({ server: { sshPort: null }, root: kept, workUser: { name: 'hoprig', uid: 1001, home: '/home/hoprig' } });
  assert.match(t, / hoprig@203\.0\.114\.7$/m);
  assert.doesNotMatch(t, /root@/);
  // Not on purpose (a service of before kept working): the move is the step.
  t = await say({ server: { sshPort: null }, root: rootCheck(facts()), workUser: null });
  assert.match(t, /^ {2}This is root, and Claude Code refuses bypass permissions mode for root .*\. Next: hoprig move-to-user\b/m);
  // An ordinary user: nothing about root.
  assert.doesNotMatch(await say({ server: { sshPort: null }, workUser: null }, { user: 'alex' }), /This is root/);
});

test('a whole set-up as root on purpose says "This is root" at its end too', async () => {
  fs.rmSync(configFile(), { force: true });
  const t = await run(['--yes', '--no-service', '--stay-root']);
  const end = t.slice(t.lastIndexOf('is ready'));
  assert.match(end, /This is root, on purpose, kept on root by your choice\./, t);
});
