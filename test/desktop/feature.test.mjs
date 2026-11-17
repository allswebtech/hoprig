// The desktop's system routes (src/desktop/feature.mjs) with stand-ins for the system's programs: no service is
// started, stopped or restarted, and the only process ended is this test's own child. The administrator password
// goes to sudo's input only, never into an argv, an answer or an error; this dashboard's own service is refused;
// SSH needs its name typed; Windows is read-only; every input is checked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { killProcess } from '../../src/server/platform.mjs';
import { TmuxBackend } from '../../src/server/backends/tmux.mjs';
import { runSync } from '../../src/server/platform/common.mjs';

const hasTmux = runSync('tmux', ['-V']) !== null;

const box = sandbox('desktop-feature');
const { desktopFeature } = await import('../../src/desktop/feature.mjs');
test.after(() => box.cleanup());

const PASSWORD = 'Sudo pw 7#desk';
const UNITS = 'cron.service loaded active running Cron\nssh.service loaded active running OpenBSD Secure Shell server\nhoprig.service loaded active running Hoprig\n';

/** A feature with stand-ins: `run` answers systemctl, ps, journalctl; `stream` is sudo (right password: PASSWORD). */
function harness(over = {}) {
  const ran = [];
  const streamed = [];
  const run = async (cmd, args) => {
    ran.push([cmd, ...args]);
    if (cmd === 'systemctl' && args.includes('list-units')) return { ok: true, stdout: UNITS };
    if (cmd === 'systemctl' && args.includes('list-unit-files')) return { ok: true, stdout: 'cron.service enabled enabled\n' };
    if (cmd === 'systemctl') return { ok: true, stdout: '', stderr: '' };
    if (cmd === 'journalctl') return { ok: true, stdout: JSON.stringify({ __CURSOR: 's=1;i=9', __REALTIME_TIMESTAMP: '1000000', PRIORITY: '6', _SYSTEMD_UNIT: 'cron.service', MESSAGE: 'ran' }) };
    if (cmd === 'sudo') return { ok: false, stdout: '', stderr: 'a password is required' };
    return { ok: false, stdout: '', stderr: `no ${cmd} here` };
  };
  const stream = async (argv, o = {}) => {
    streamed.push({ argv, input: o.input });
    const right = o.input === `${PASSWORD}\n`;
    // sudo echoing what it was given would be the worst case: the answer must still not carry it.
    return { ok: right, code: right ? 0 : 1, output: right ? `done; input was ${PASSWORD}` : 'Sorry, try again.' };
  };
  const f = desktopFeature({ readJson: async (req) => req.body || {} }, { platform: 'linux', run, stream, readFile: () => null, root: false, ...over });
  const call = async (method, p, body, req = {}) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn({ headers: {}, socket: { remoteAddress: '127.0.0.1' }, ...req, body }, match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  return { call, ran, streamed };
}

test('the service list marks this dashboard\'s own unit and SSH', async () => {
  const { call } = harness();
  const r = await call('GET', '/api/services?scope=system');
  assert.deepEqual(r.scopes, ['user', 'system']);
  assert.deepEqual(r.services.map((s) => [s.name, s.own, s.ssh]), [['cron.service', false, false], ['hoprig.service', true, false], ['ssh.service', false, true]]);
  await assert.rejects(call('GET', '/api/services?scope=root'), (e) => e.status === 400);
});

test('a user service is changed with systemctl --user and fixed arguments; bad input is refused before anything runs', async () => {
  const { call, ran } = harness();
  assert.deepEqual(await call('POST', '/api/services/action', { scope: 'user', name: 'cron.service', action: 'restart' }), { ok: true, output: '' });
  assert.deepEqual(ran.at(-1), ['systemctl', '--user', 'restart', '--', 'cron.service']);
  const before = ran.length;
  for (const b of [
    { scope: 'user', name: '--now.service', action: 'stop' },
    { scope: 'user', name: 'cron.service; reboot', action: 'stop' },
    { scope: 'user', name: 'cron.service', action: 'mask' },
    { scope: 'nobody', name: 'cron.service', action: 'stop' },
  ]) await assert.rejects(call('POST', '/api/services/action', b), (e) => e.status === 400, JSON.stringify(b));
  assert.equal(ran.length, before, 'nothing ran');
});

test('the system\'s services: the password is asked for, checked, given to sudo\'s input only, and scrubbed', async () => {
  const { call, streamed } = harness();
  const body = { scope: 'system', name: 'cron.service', action: 'restart' };
  assert.deepEqual(await call('POST', '/api/services/action', body), { needsPassword: true });
  assert.deepEqual(await call('POST', '/api/services/action', { ...body, password: 'wrong' }), { needsPassword: true, wrong: true, notAllowed: false });
  const r = await call('POST', '/api/services/action', { ...body, password: PASSWORD });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes(PASSWORD), 'the answer never carries the password');
  assert.match(r.output, /input was ••••/);
  const last = streamed.at(-1);
  assert.deepEqual(last.argv, ['sudo', '-S', '-k', '-p', '', '--', 'systemctl', 'restart', '--', 'cron.service']);
  assert.equal(last.input, `${PASSWORD}\n`);
  for (const s of streamed) assert.ok(!s.argv.join(' ').includes(PASSWORD), 'never in an argv');
  await assert.rejects(call('POST', '/api/services/action', { ...body, password: 'a\nb' }), (e) => e.status === 400);
  // sudo that needs no password: sudo -n, nothing on its input.
  const seen = [];
  const nopw = harness({ adminNeeded: async () => false, stream: async (argv, o) => (seen.push({ argv, input: o.input }), { ok: true, output: '' }) });
  assert.equal((await nopw.call('POST', '/api/services/action', body)).ok, true);
  assert.deepEqual(seen, [{ argv: ['sudo', '-n', '--', 'systemctl', 'restart', '--', 'cron.service'], input: null }]);
});

test('refused: this dashboard\'s own service; SSH until its name is typed', async () => {
  const { call, streamed, ran } = harness();
  await assert.rejects(call('POST', '/api/services/action', { scope: 'user', name: 'hoprig.service', action: 'stop' }), (e) => e.status === 409 && /this dashboard runs in/.test(e.message));
  const ssh = { scope: 'system', name: 'ssh.service', action: 'stop', password: PASSWORD };
  const q = await call('POST', '/api/services/action', ssh);
  assert.equal(q.needsConfirm, true);
  assert.match(q.why, /cut this computer off/);
  assert.equal(streamed.length, 0, 'nothing ran, the password was not even checked');
  assert.equal((await call('POST', '/api/services/action', { ...ssh, confirm: 'ssh' })).needsConfirm, true, 'the full name, exactly');
  assert.equal((await call('POST', '/api/services/action', { ...ssh, confirm: 'ssh.service' })).ok, true);
  assert.equal((await call('POST', '/api/services/action', { scope: 'user', name: 'ssh.service', action: 'start' })).ok, true, 'starting SSH needs no confirmation');
  // A password from another dashboard over a plain leg: test/desktop/relay.test.mjs (it needs the machines gate).
  assert.ok(!ran.flat().join(' ').includes(PASSWORD));
});

test('the network\'s units ask for their name like SSH; the list marks them; a start needs nothing', async () => {
  const { call } = harness();
  const q = await call('POST', '/api/services/action', { scope: 'system', name: 'NetworkManager.service', action: 'restart' });
  assert.deepEqual([q.needsConfirm, /off the network/.test(q.why)], [true, true]);
  assert.equal((await call('POST', '/api/services/action', { scope: 'user', name: 'dbus.service', action: 'stop' })).needsConfirm, true);
  assert.equal((await call('POST', '/api/services/action', { scope: 'user', name: 'dbus.service', action: 'stop', confirm: 'dbus.service' })).ok, true);
  assert.equal((await call('POST', '/api/services/action', { scope: 'user', name: 'tailscaled.service', action: 'start' })).ok, true);
  const list = await call('GET', '/api/services?scope=system');
  assert.deepEqual(list.services.map((x) => [x.name, x.critical]), [['cron.service', false], ['hoprig.service', false], ['ssh.service', true]]);
});

test('wrong passwords: after three from one caller the next try waits, and the password is not even checked', async () => {
  const { call, streamed } = harness();
  const body = { scope: 'system', name: 'cron.service', action: 'restart' };
  const from = (ip) => ({ socket: { remoteAddress: ip } });
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/services/action', { ...body, password: `wrong ${i}` }, from('10.0.0.5'))).wrong, true);
  const checked = streamed.length;
  await assert.rejects(call('POST', '/api/services/action', { ...body, password: PASSWORD }, from('10.0.0.5')), (e) => e.status === 429 && /try again in \d+ min/.test(e.message));
  assert.equal(streamed.length, checked, 'sudo was not asked');
  assert.equal((await call('POST', '/api/services/action', { ...body, password: PASSWORD }, from('10.0.0.6'))).ok, true, 'another caller is not held up');
});

test('macOS uses launchctl; Windows lists its services and changes none', async () => {
  const mac = harness({ platform: 'darwin', run: async () => ({ ok: true, stdout: '' }) });
  const ran = [];
  const m2 = desktopFeature({ readJson: async (r) => r.body }, { platform: 'darwin', root: false, run: async (cmd, args) => (ran.push([cmd, ...args]), { ok: true, stdout: '' }), stream: async () => ({ ok: true, output: '' }) });
  const act = m2.routes.find(([m, re]) => m === 'POST' && re.test('/api/services/action'))[2];
  await act({ body: { scope: 'user', name: 'com.example.agent', action: 'restart' }, headers: {}, socket: {} });
  assert.deepEqual(ran.at(-1).slice(0, 3), ['launchctl', 'kickstart', '-k']);
  assert.match(ran.at(-1)[3], /^gui\/\d+\/com\.example\.agent$/);
  assert.equal((await mac.call('GET', '/api/logs')).available, false, 'no journal on macOS');
  const win = harness({ platform: 'win32', run: async () => ({ ok: true, stdout: JSON.stringify([{ Name: 'sshd', DisplayName: 'OpenSSH', Status: 4, StartType: 2 }]) }) });
  const list = await win.call('GET', '/api/services');
  assert.deepEqual([list.readOnly, list.scopes, list.services[0].name], [true, ['system'], 'sshd']);
  await assert.rejects(win.call('POST', '/api/services/action', { scope: 'system', name: 'sshd', action: 'stop' }), (e) => e.status === 409 && /read-only/.test(e.message));
});

test('processes: the dashboard, the processes above it and the sessions\' tmux server are guarded; ending works on this test\'s own child only', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  const gone = new Promise((r) => child.once('exit', (code, sig) => r(sig)));
  // The real kill only ever reaches the child: a guard that broke would show as a stand-in call, not as a signal to
  // the test runner or this test itself.
  const signalled = [];
  const kill = (pid, sig) => (signalled.push(pid), pid === child.pid ? killProcess(pid, sig) : { ok: false, error: 'stand-in: not signalled' });
  // A stand-in tmux server: this test's parent's parent is not above the dashboard in every runner, so a pid that is
  // surely not above it stands for the tmux server (the child's own pid would be refused, which the end of this test
  // relies on not happening).
  const host = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
    c.once('spawn', () => resolve(c));
  });
  try {
    // This system's own part with its real programs (ps, and /proc where there is one): read only.
    const { call } = harness({ platform: process.platform, run: undefined, readFile: undefined, kill, sessionHosts: async () => [host.pid] });
    const list = await call('GET', '/api/system/processes');
    const me = list.processes.find((p) => p.pid === process.pid);
    assert.equal(me.guarded, true, 'the dashboard itself');
    assert.equal(list.processes.find((p) => p.pid === process.ppid)?.guarded, true, 'its parent');
    const tmux = list.processes.find((p) => p.pid === host.pid);
    assert.deepEqual([tmux.guarded, tmux.holdsSessions], [true, true], 'the server that holds every session');
    const kid = list.processes.find((p) => p.pid === child.pid);
    assert.deepEqual([kid.guarded, kid.mine, kid.holdsSessions], [false, true, false]);
    assert.ok(list.processes.every((p) => !('cpuTime' in p) && !('uid' in p)));
    for (const pid of [process.pid, process.ppid, host.pid, 1, 0, -5, 'x', 2 ** 31]) {
      await assert.rejects(call('POST', '/api/system/processes/end', { pid }), (e) => e.status === 409 && !/stand-in/.test(e.message), String(pid));
    }
    assert.deepEqual(signalled, [], 'no refused pid reached kill');
    // A pid the page showed under another name now (used again): refused before any signal.
    await assert.rejects(call('POST', '/api/system/processes/end', { pid: child.pid, name: 'not-this-one' }), (e) => e.status === 409 && /ended already/.test(e.message));
    assert.equal(child.exitCode, null, 'still running');
    assert.deepEqual(await call('POST', '/api/system/processes/end', { pid: child.pid, name: kid.name }), { ok: true });
    assert.equal(await gone, 'SIGTERM');
    assert.deepEqual(signalled, [child.pid]);
  } finally {
    host.kill('SIGKILL');
    child.kill('SIGKILL');
  }
  // Another user's process: the OS part refuses it (a stand-in here, so nothing real is even tried).
  const other = harness({ kill: () => ({ ok: false, error: 'not your process' }), parentLookup: async () => () => null });
  await assert.rejects(other.call('POST', '/api/system/processes/end', { pid: 4321 }), (e) => e.status === 409 && /not your process/.test(e.message));
});

test('the tmux server of the sessions is found on the backend\'s own socket and guarded by default', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  const socket = `hoprig-desk-test-${process.pid}`;
  const tmux = new TmuxBackend({ socket, configFile: '/dev/null' });
  assert.equal(await tmux.serverPid(), null, 'no server yet');
  await tmux.create({ name: 'held', dir: os.tmpdir() });
  try {
    const pid = await tmux.serverPid();
    assert.ok(Number.isInteger(pid) && pid > 1);
    const signalled = [];
    const f = desktopFeature({ readJson: async (req) => req.body || {}, backend: tmux }, { platform: 'linux', kill: (p) => (signalled.push(p), { ok: false, error: 'stand-in' }) });
    const end = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/system/processes/end'))[2];
    await assert.rejects(end({ body: { pid }, headers: {}, socket: {} }), (e) => e.status === 409 && /holds its sessions/.test(e.message));
    const list = await f.routes.find(([m, re]) => m === 'GET' && re.test('/api/system/processes'))[2]({ headers: {}, socket: {} });
    assert.deepEqual(list.processes.filter((p) => p.holdsSessions).map((p) => [p.pid, p.guarded]), [[pid, true]]);
    assert.deepEqual(signalled, []);
  } finally {
    await tmux.run(['kill-server']).catch(() => {});
    // tmux leaves the socket file behind: one more in the shared tmux folder at every run.
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, socket), { force: true });
  }
});

test('usage, disks and network answer with numbers; the journal and the log files with checked input', async () => {
  const logs = path.join(box.root, 'var-log');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'syslog'), 'a line\n');
  const { call, ran } = harness({ logDirs: () => [logs], run: undefined, readFile: undefined });
  const u = await call('GET', '/api/system/usage');
  assert.equal(u.cpu.cores.length, os.cpus().length);
  assert.ok(u.mem.total > 0 && u.cpu.total >= 0 && u.cpu.total <= 100);
  assert.ok(Array.isArray((await call('GET', '/api/system/disks')).disks));
  const n = await call('GET', '/api/system/network');
  assert.ok(n.interfaces.length > 0 && Array.isArray(n.ports));
  const files = await call('GET', '/api/logs/files');
  assert.deepEqual(files.files.map((f) => path.basename(f.path)), ['syslog']);
  const read = await call('GET', `/api/logs/file?path=${encodeURIComponent(path.join(logs, 'syslog'))}`);
  assert.deepEqual([read.text, read.next], ['a line\n', 7]);
  await assert.rejects(call('GET', '/api/logs/file?path=%2Fetc%2Fpasswd'), (e) => e.status === 404);
  await assert.rejects(call('GET', `/api/logs/file?path=${encodeURIComponent(path.join(logs, 'syslog'))}&from=-1`), (e) => e.status === 400);
  const j = harness();
  const e = await j.call('GET', '/api/logs?unit=cron.service&priority=4&after=s%3D1%3Bi%3D8');
  assert.deepEqual(e.entries.map((x) => [x.cursor, x.message]), [['s=1;i=9', 'ran']]);
  const args = j.ran.at(-1);
  assert.deepEqual(args.slice(args.indexOf('-u'), args.indexOf('-u') + 2), ['-u', 'cron.service']);
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), ['-p', '4']);
  await assert.rejects(j.call('GET', '/api/logs?unit=--all'), (x) => x.status === 400);
  await assert.rejects(j.call('GET', '/api/logs?after=1;rm'), (x) => x.status === 400);
  const svc = await j.call('GET', '/api/services/logs?scope=user&name=cron.service&lines=20');
  assert.equal(svc.entries.length, 1);
  assert.ok(j.ran.at(-1).includes('--user'));
  assert.ok(ran.length === 0, 'the real programs ran, not the stand-in');
});
