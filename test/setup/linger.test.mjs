// Lingering on a server (src/setup/linger.mjs): one of the sudo steps set-up lists and runs under the same yes, and
// one plain line about what came of it. Stand-ins for loginctl, sudo and systemctl on PATH; nothing real is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const L = await import('../../src/setup/linger.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { which } = await import('../../src/setup/system.mjs');

const flag = path.join(s.tmp, 'linger-on');
const ran = path.join(s.tmp, 'ran.log');
const services = path.join(s.tmp, 'systemctl.log');
const trapped = path.join(s.tmp, 'trapped.log');
const asked = path.join(s.tmp, 'loginctl.log');
// No program of the computer itself is ever started: the test's own PATH holds traps that write down what reached them
// and fail, and without the user's session bus a real systemctl --user could not reach the user's service manager
// either. Set-up must start the stand-ins of its own `sys.env` (below) instead.
const trap = fakeBin(path.join(s.tmp, 'trap'), Object.fromEntries(['systemctl', 'loginctl', 'sudo'].map((n) => [n, `printf '%s\\n' "${n} $*" >> '${trapped}'; exit 1`])));
process.env.PATH = pathWith(s.tmp, trap);
delete process.env.XDG_RUNTIME_DIR;
delete process.env.DBUS_SESSION_BUS_ADDRESS;
test.after(() => assert.equal(fs.existsSync(trapped) ? fs.readFileSync(trapped, 'utf8') : '', '', 'a program outside sys.env was started'));
// loginctl answers from a file; sudo writes down what it ran and runs it; systemctl writes down what it was asked.
const systemctl = `printf '%s\\n' "systemctl $*" >> '${services}'`;
const bin = fakeBin(path.join(s.tmp, 'bin'), {
  claude: fakeClaude(),
  loginctl: `printf '%s\\n' "loginctl $*" >> '${asked}'; case "$1" in show-user) if [ -e '${flag}' ]; then echo Linger=yes; else echo Linger=no; fi ;; enable-linger) : > '${flag}' ;; esac`,
  sudo: `printf '%s\\n' "sudo $*" >> '${ran}'; exec "$@"`,
  systemctl,
});
const noSudo = fakeBin(path.join(s.tmp, 'bin-nosudo'), { claude: fakeClaude(), loginctl: 'echo Linger=no', systemctl });
function sys(dir = bin, over = {}) {
  // A home computer: the ssh session of whoever runs the tests (SSH_CONNECTION) would make it a server (server.mjs).
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SSH_|DISPLAY$|WAYLAND_DISPLAY$)/.test(k))), PATH: pathWith(s.tmp, dir) }; // seal: only the test's own folders, in an environment that keeps the runner's variables
  return K.sysInfo({ env, platform: 'linux', has: (c) => c !== 'systemctl' && !!which(c, env, 'linux'), pm: null, root: false, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, user: 'alex', serviceSupported: true, ...over });
}
const ui = (o = {}) => {
  const rec = recorder();
  return { rec, ui: makeUi({ interactive: false, write: rec.write, askLine: async () => '', ...o }) };
};
const reset = () => [flag, ran, services, asked].forEach((f) => fs.rmSync(f, { force: true }));
// The computer step as set-up runs it, but only with the steps it was given (no kits to install here).
// Its facts see the same stand-ins (sudo among them) as set-up's own. Its runner starts ONLY a program of this test's
// own folder, found on the stand-in PATH (the real environment's PATH would reach the computer's real sudo): anything
// else fails the test instead of running.
const { stream } = await import('../../src/setup/system.mjs');
const standIn = (dir) => async (argv, o = {}) => {
  const PATH = pathWith(s.tmp, dir);
  const file = which(argv[0], { PATH }, 'linux'); // seal: a value no program is started with
  if (!file || !file.startsWith(s.tmp + path.sep)) throw new Error(`a test step would run ${argv[0]} outside the test's folder`);
  return stream([file, ...argv.slice(1)], { ...o, interactive: false, env: { ...(o.env || process.env), PATH } }); // seal: only the test's own folders, in an environment that keeps the runner's variables
};
const parts = (dir = bin) => ({
  pc: async (o) => (await import('../../src/pcsetup/index.mjs')).runPcSetup({ ...o, kits: [], runner: standIn(dir), sys: await (await import('../../src/pcsetup/detect.mjs')).sysFacts({ platform: 'linux', pm: null, has: (c) => ['sudo', 'loginctl'].includes(c) && !!which(c, { PATH: pathWith(s.tmp, dir) }, 'linux') }) }), // seal: a value no program is started with
  git: async () => ({ ok: true }), workspace: async () => ({ ok: true }), projects: async () => ({ dir: '/nowhere', names: ['demo'] }),
  projectSkills: async () => ({ ok: true, added: [], skipped: [] }), userSkills: async () => ({ ok: true, added: [], skipped: [] }),
});

test('the step: sudo loginctl enable-linger <user>, only when lingering is off; as root without sudo', async () => {
  reset();
  assert.deepEqual((await L.lingerPlan(sys())).step.argv, ['sudo', 'loginctl', 'enable-linger', 'alex']);
  assert.deepEqual((await L.lingerPlan(sys(bin, { root: true }))).step.argv, ['loginctl', 'enable-linger', 'alex']);
  assert.deepEqual(await L.lingerPlan(sys(noSudo)), { manual: 'as root: loginctl enable-linger alex' });
  fs.writeFileSync(flag, '');
  assert.deepEqual(await L.lingerPlan(sys()), {}, 'already on: nothing to do');
  assert.deepEqual(await L.lingerPlan(sys(bin, { platform: 'darwin' })), {}, 'not Linux');
  assert.deepEqual(await L.lingerPlan(sys(fakeBin(path.join(s.tmp, 'bin-none'), {}))), {}, 'no loginctl: nothing to say');
});

test('set-up lists lingering among the sudo steps ("Will run") and runs it under the same yes; no "run this once yourself"', async () => {
  reset();
  const { ui: u, rec } = ui({ yes: true });
  // The service step runs systemctl from sys.env: the stand-in, never the computer's own.
  const S = sys();
  S.probe = async () => 200;
  const code = await SU.setup(['--yes', '--no-service'], { ui: u, sys: S, parts: parts() });
  assert.equal(code, 0, rec.text);
  assert.doesNotMatch(rec.text, /enable-linger/, '--no-service: no service, no lingering');
  reset();
  const yes = ui({ yes: true });
  await SU.stepPassword(yes.ui, {}, {});
  const S2 = sys();
  S2.probe = async () => 200;
  fs.mkdirSync(path.join(process.env.HOME, '.config', 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, '.config', 'systemd', 'user', 'hoprig.service'), '');
  await SU.setup(['--yes'], { ui: yes.ui, sys: S2, parts: parts() });
  const t = yes.rec.text;
  assert.match(t, /Will run.*\n(?:.*\n)*? {4}sudo loginctl enable-linger alex\n/);
  assert.match(t, /Run this now\? yes/);
  assert.match(t, /Run this now\? yes(?:.*\n)*?.*Done(?:.*\n)*?  ✓ The dashboard keeps running after you log out[^\n]*\n(?:.*\n)*?Git and GitHub|Skills/, 'said right after the computer step');
  assert.equal(fs.readFileSync(ran, 'utf8').trim(), 'sudo loginctl enable-linger alex', 'run once, through sudo');
  assert.match(t, /✓ The dashboard keeps running after you log out \(lingering is on\)/);
  assert.doesNotMatch(t, /Open a new terminal/, 'no program was installed');
  assert.doesNotMatch(t, /run this once yourself|To keep it running while you are logged out/);
});

test('not done: one plain line with the one command (refused, no sudo); a dry run only lists it', async () => {
  reset();
  const refuse = fakeBin(path.join(s.tmp, 'bin-refuse'), { claude: fakeClaude(), loginctl: 'echo Linger=no', sudo: 'echo "sorry, try again" >&2; exit 1', systemctl });
  // Inside set-up: the mark where it happens, the command in the closing list ("Still yours to do"). With sudo here,
  // Health's one press (web/health.js "Let them start after a restart") comes first; without sudo it cannot work, so
  // the list names only the command for root.
  for (const [dir, line] of [[refuse, /^ {2}! The dashboard stops when you log out: lingering is off\n(?:.*\n)*? {2}Still yours to do:\n(?:.*\n)*? {4}· Keep the dashboard running after you log out \(lingering\): On the dashboard: Computers → this computer → Health → Let them start after a restart\. Or only here, on this computer: sudo loginctl enable-linger alex$/m], [noSudo, /^ {2}! The dashboard stops when you log out: lingering is off\n(?:.*\n)*? {2}Still yours to do:\n(?:.*\n)*? {4}· Keep the dashboard running after you log out \(lingering\): as root: loginctl enable-linger alex$/m]]) {
    const { ui: u, rec } = ui({ yes: true });
    const S = sys(dir);
    S.probe = async () => 200;
    await SU.setup(['--yes'], { ui: u, sys: S, parts: parts(dir) });
    assert.match(rec.text, line);
    assert.equal(rec.text.match(/lingering is off/g).length, 1, 'said once');
    // The command itself: in "Will run" and on the step's own "→" line as it runs (when there was a step to run), and
    // in the one line; never again as a retry.
    const cmd = dir === refuse ? 'sudo loginctl enable-linger alex' : 'as root: loginctl enable-linger alex';
    assert.equal(rec.text.split(cmd).length - 1, dir === refuse ? 3 : 1, rec.text);
    assert.doesNotMatch(rec.text, /retry:.*enable-linger|some installs failed|This computer for coding: not finished/, rec.text);
  }
  const dry = ui({ dryRun: true });
  const S = sys();
  S.probe = async () => 200;
  await SU.setup(['--dry-run'], { ui: dry.ui, sys: S, parts: parts() });
  assert.match(dry.rec.text, /sudo loginctl enable-linger alex/);
  assert.equal(fs.existsSync(ran), false, 'a dry run runs nothing');
  // --only base: no computer step, the step is asked on its own.
  const alone = ui({ yes: true });
  await SU.setup(['--yes', '--only', 'base'], { ui: alone.ui, sys: S, parts: parts() });
  assert.match(alone.rec.text, /Will run.*\n {4}sudo loginctl enable-linger alex\n {2}Run it now\? yes/);
  assert.match(alone.rec.text, /✓ The dashboard keeps running after you log out/);
});

test('the service install runs the systemctl of set-up\'s own environment, never the one on the process PATH', async () => {
  reset();
  const unit = path.join(process.env.HOME, '.config', 'systemd', 'user', 'hoprig.service');
  fs.rmSync(unit, { force: true });
  const { ui: u, rec } = ui({ yes: true });
  await SU.stepPassword(u, {}, {});
  const S = sys(bin, { probe: async () => 200 });
  assert.equal(await SU.stepService(u, S, { service: true }, { changed: true }), true, rec.text);
  // The service's own "run this once yourself" paragraph is written straight to the output after it asks loginctl:
  // set-up lists and runs lingering itself, so the service step never asks.
  assert.equal(fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8') : '', '', 'the service step asked loginctl about lingering');
  assert.doesNotMatch(rec.text, /run this once yourself|enable-linger/);
  assert.equal(fs.readFileSync(services, 'utf8'), 'systemctl --user daemon-reload\nsystemctl --user enable hoprig.service\nsystemctl --user restart hoprig.service\n');
  assert.ok(fs.existsSync(unit), 'the unit file is written in the test home');
  assert.match(fs.readFileSync(unit, 'utf8'), new RegExp(`Environment="PATH=${S.env.PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), 'from set-up\'s environment');
});

test('lingering left off: "running in the background" claims no start with the computer', async () => {
  reset();
  // No unit yet: the service is installed and started in this run (not the "already running" line).
  fs.rmSync(path.join(process.env.HOME, '.config', 'systemd', 'user', 'hoprig.service'), { force: true });
  const refuse = fakeBin(path.join(s.tmp, 'bin-refuse-words'), { claude: fakeClaude(), loginctl: 'echo Linger=no', sudo: 'echo "sorry, try again" >&2; exit 1', systemctl });
  const { ui: u, rec } = ui({ yes: true });
  const S = sys(refuse);
  S.probe = async () => 200;
  await SU.setup(['--yes'], { ui: u, sys: S, parts: parts(refuse) });
  assert.match(rec.text, /✓ Dashboard running in the background\n/);
  assert.match(fs.readFileSync(services, 'utf8'), /--user restart hoprig\.service/, 'installed and started in this run');
  assert.doesNotMatch(rec.text, /starts with the computer/, 'lingering is off: it does not');
});
