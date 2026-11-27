// The service files keep the dashboard up on every system, and the owner's own stop stays a stop. Stand-ins for the
// service manager: nothing here starts, stops or reads a real service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isStopped } from '../../src/keeper/keep.mjs';
import { service, serviceFiles } from '../../src/server/service/index.mjs';
import * as launchd from '../../src/server/service/launchd.mjs';
import * as systemd from '../../src/server/service/systemd.mjs';
import * as windows from '../../src/server/service/windows.mjs';
import { stopDashboard } from '../../src/server/cli.mjs';

const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'units-test-'));
  made.push(d);
  return d;
};
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const silent = async (fn) => {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, error });
  }
};
const ENV = { PATH: '/opt/n/bin:/usr/bin', LANG: 'en_US.UTF-8', HOPRIG_STATE_DIR: '/s' }; // seal: a value no program is started with
const INSTALL_SHELL = { PATH: '/install/shell/bin', LANG: 'C.UTF-8' }; // seal: a value no program is started with
const OPTS = { node: '/opt/n/bin/node', bin: '/app/bin/hoprig.mjs', env: ENV, locales: null };

// ---- systemd ----
test('systemd unit: always restarted 3 s apart, a crash loop (5 in 60 s) goes to the keeper', () => {
  const u = systemd.unitText(OPTS);
  assert.match(u, /^Restart=always$/m);
  assert.doesNotMatch(u, /Restart=on-failure/);
  assert.match(u, /^RestartSec=3$/m);
  assert.match(u, /^StartLimitIntervalSec=60$/m);
  assert.match(u, /^StartLimitBurst=5$/m);
  assert.match(u, /^OnFailure=hoprig-keep\.service$/m);
  assert.match(u, /^KillMode=process$/m, 'a stop still leaves tmux and its sessions alone');
  // The limits belong in [Unit]: systemd ignores them in [Service].
  assert.ok(u.indexOf('StartLimitBurst') < u.indexOf('[Service]'));
  assert.ok(u.indexOf('OnFailure=') < u.indexOf('[Service]'));
});

test('the keeper unit runs hoprig keep --failed once, with the same carried variables', () => {
  const k = systemd.keepUnitText(OPTS);
  assert.match(k, /^Type=oneshot$/m);
  assert.match(k, /^ExecStart="\/opt\/n\/bin\/node" "\/app\/bin\/hoprig\.mjs" keep --failed$/m);
  assert.match(k, /^Environment="PATH=\/opt\/n\/bin:\/usr\/bin"$/m);
});

test('install writes both units; uninstall removes both; stop and start are the service manager\'s own', async () => {
  const dir = tmp();
  const env = { XDG_CONFIG_HOME: dir };
  const state = path.join(dir, 'state');
  const calls = [];
  const run = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), { ok: true, out: '', err: '' });
  assert.equal((await silent(() => systemd.service('install', { run, env, lingerNote: false }))), 0);
  assert.ok(fs.existsSync(path.join(dir, 'systemd', 'user', 'hoprig.service')));
  assert.ok(fs.existsSync(path.join(dir, 'systemd', 'user', 'hoprig-keep.service')));
  calls.length = 0;
  assert.equal(await silent(() => service('stop', 'linux', { run, env, state })), 0);
  assert.deepEqual(calls, ['systemctl --user stop hoprig.service']);
  assert.equal(isStopped(state), true, 'the stop is remembered, so the keeper leaves it stopped');
  calls.length = 0;
  assert.equal(await silent(() => service('start', 'linux', { run, env, state })), 0);
  assert.deepEqual(calls, ['systemctl --user reset-failed hoprig.service', 'systemctl --user start hoprig.service'], 'the failed state of a crash loop is cleared first');
  assert.equal(isStopped(state), false);
  await silent(() => service('stop', 'linux', { run, env, state }));
  assert.equal(await silent(() => service('restart', 'linux', { run, env, state })), 0);
  assert.equal(isStopped(state), false, 'a restart is a start');
  assert.equal(await silent(() => systemd.service('uninstall', { run, env })), 0);
  assert.ok(!fs.existsSync(path.join(dir, 'systemd', 'user', 'hoprig-keep.service')));
});

test('a stop that failed is not remembered; a stop of a service that is not installed says so', async () => {
  const dir = tmp();
  const env = { XDG_CONFIG_HOME: dir };
  const state = path.join(dir, 'state');
  const none = await silent(() => service('stop', 'linux', { run: async () => ({ ok: true }), env, state }));
  assert.equal(none, 3);
  fs.mkdirSync(path.join(dir, 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'systemd', 'user', 'hoprig.service'), 'x');
  const bad = await silent(() => service('stop', 'linux', { run: async () => ({ ok: false, err: 'no' }), env, state }));
  assert.equal(bad, 1);
  assert.equal(isStopped(state), false);
});

test('the keeper compares the files without the carried variables of another shell, and sees a broken file', () => {
  const dir = tmp();
  const env = { XDG_CONFIG_HOME: dir };
  const unitFile = path.join(dir, 'systemd', 'user', 'hoprig.service');
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  // Written at install in a shell with its own PATH.
  fs.writeFileSync(unitFile, systemd.unitText({ ...OPTS, env: INSTALL_SHELL })); // seal: a value no program is started with
  fs.writeFileSync(path.join(dir, 'systemd', 'user', 'hoprig-keep.service'), systemd.keepUnitText({ ...OPTS, env: INSTALL_SHELL })); // seal: a value no program is started with
  const mine = { env: { ...ENV, XDG_CONFIG_HOME: dir }, node: OPTS.node, bin: OPTS.bin };
  const same = serviceFiles('linux', mine);
  assert.deepEqual(same.filter((f) => fs.readFileSync(f.file, 'utf8') !== f.text), [], 'the keeper own PATH makes no difference');
  fs.writeFileSync(unitFile, fs.readFileSync(unitFile, 'utf8').replace('Restart=always', 'Restart=no'));
  assert.deepEqual(serviceFiles('linux', mine).filter((f) => fs.readFileSync(f.file, 'utf8') !== f.text).map((f) => path.basename(f.file)), ['hoprig.service']);
  fs.writeFileSync(unitFile, 'garbage');
  assert.equal(serviceFiles('linux', mine).find((f) => f.file === unitFile).text.includes('Restart=always'), true);
});

// ---- launchd ----
test('launchd: kept alive always, started again after 3 s, with a watcher job every minute', () => {
  const p = launchd.plistText({ node: '/n/node', bin: '/app/b.mjs', env: ENV, home: '/Users/u', log: '/l' });
  assert.match(p, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.doesNotMatch(p, /SuccessfulExit/);
  assert.match(p, /<key>ThrottleInterval<\/key>\s*<integer>3<\/integer>/);
  const w = launchd.keepPlistText({ node: '/n/node', bin: '/app/b.mjs', env: ENV, home: '/Users/u', log: '/l' });
  assert.match(w, /<string>keep<\/string>/);
  assert.match(w, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(w, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(w, new RegExp(`<string>${launchd.KEEP_LABEL.replace(/\./g, '\\.')}</string>`));
  assert.deepEqual(launchd.launchctlArgs.unloadKeeper().slice(0, 1), ['bootout']);
});

test('launchd stop takes the job out of launchd (no kill: KeepAlive would start it again) and is remembered', { skip: process.platform === 'win32' && 'the uid' }, async () => {
  const home = tmp();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const state = path.join(home, 'state');
    const calls = [];
    const run = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), { ok: true, out: '', err: '' });
    fs.mkdirSync(path.dirname(launchd.plistFile(home)), { recursive: true });
    fs.writeFileSync(launchd.plistFile(home), 'x');
    const r = await silent(() => service('stop', 'darwin', { run, state }));
    // The plist path comes from os.homedir(), which follows HOME on this system.
    assert.equal(r, os.homedir() === home ? 0 : 3);
    if (os.homedir() === home) {
      assert.ok(calls.every((c) => c.startsWith('launchctl bootout')), calls.join('\n'));
      assert.ok(!calls.some((c) => /kill/.test(c)));
      assert.equal(isStopped(state), true);
    }
  } finally {
    process.env.HOME = saved;
  }
});

// ---- Windows ----
test('Windows script starts the dashboard again 3 s after any exit, unless the owner stopped it', () => {
  const s = windows.scriptText({ node: 'C:\\n\\node.exe', bin: 'C:\\app\\b.mjs', env: {}, home: 'C:\\Users\\me', log: 'C:\\l.log', stopped: 'C:\\s\\keeper\\stopped' });
  const lines = s.split('\r\n');
  assert.ok(lines.includes('while ($true) {'));
  assert.ok(lines.includes("  if (Test-Path -LiteralPath 'C:\\s\\keeper\\stopped') { break }"));
  assert.ok(lines.includes('  Start-Sleep -Seconds 3'));
  assert.ok(lines.indexOf('  $code = $LASTEXITCODE') < lines.indexOf("  if (Test-Path -LiteralPath 'C:\\s\\keeper\\stopped') { break }"));
  assert.equal(lines.at(-2), 'exit $code');
});

test('Windows keeper task runs every minute; its script runs hoprig keep', () => {
  const x = windows.keepTaskXml({ user: 'S-1-5-21-1', script: 'C:\\k.ps1', home: 'C:\\Users\\me' });
  assert.match(x, /<Interval>PT1M<\/Interval>/);
  assert.match(x, /<ExecutionTimeLimit>PT5M<\/ExecutionTimeLimit>/);
  const k = windows.keepScriptText({ node: 'C:\\n\\node.exe', bin: 'C:\\app\\b.mjs', env: {}, home: 'C:\\Users\\me', log: 'C:\\l.log' });
  assert.ok(k.split('\r\n').includes("& 'C:\\n\\node.exe' 'C:\\app\\b.mjs' 'keep' *>> 'C:\\l.log'"));
  assert.deepEqual(windows.schtasksArgs.createKeeper('x.xml').slice(0, 3), ['/Create', '/TN', windows.KEEP_TASK]);
});

// ---- hoprig stop ----
test('hoprig stop goes through the service stop when the service is installed', async () => {
  let stopped = 0;
  const code = await stopDashboard({ installed: () => true, stopService: async () => (stopped++, 0), endOld: async () => assert.fail('no process is ended by hand') });
  assert.equal(code, 0);
  assert.equal(stopped, 1);
});

test('hoprig stop without a service ends the recorded dashboard, or says there is none', async () => {
  let said = '';
  const { log, error } = console;
  console.log = console.error = (m) => (said += `${m}\n`);
  try {
    assert.equal(await stopDashboard({ installed: () => false, endOld: async () => ({ ended: 4242 }) }), 0);
    assert.match(said, /process 4242/);
    assert.equal(await stopDashboard({ installed: () => false, endOld: async () => ({ ended: null, why: null }) }), 0);
    assert.match(said, /No dashboard of this Hoprig is running/);
    assert.equal(await stopDashboard({ installed: () => false, endOld: async () => ({ ended: null, why: 'process 7 did not end' }) }), 1);
  } finally {
    Object.assign(console, { log, error });
  }
});
