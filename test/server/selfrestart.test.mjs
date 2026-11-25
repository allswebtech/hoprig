// A restart the dashboard asks for itself (an update finished on its own page): the detached helper that waits for
// this dashboard to go and then runs `service restart` (selfrestart.mjs), and which systems count as "installed as a
// service". Nothing here reaches a real program: spawn, the service run, and existsSync are all stand-ins.
import assert from 'node:assert/strict';
import test from 'node:test';
import { restartAfterExit, spawnServiceRestart } from '../../src/server/selfrestart.mjs';
import { serviceInstalled } from '../../src/server/service/index.mjs';

test('restartAfterExit: waits while the dashboard is alive, then runs service restart once', async () => {
  const sleeps = [];
  let left = 3; // alive for three looks, then gone
  const calls = [];
  const code = await restartAfterExit(4321, {
    alive: (p) => {
      assert.equal(p, 4321);
      return left-- > 0;
    },
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    runService: (sub) => (calls.push(sub), 0),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['restart'], 'the service is restarted exactly once, after the wait');
  assert.equal(sleeps.length, 3, 'it waited each look the dashboard was still alive');
});

test('restartAfterExit: a dashboard that never goes still restarts after the tries run out', async () => {
  const calls = [];
  await restartAfterExit(10, { alive: () => true, sleep: () => Promise.resolve(), runService: (s) => (calls.push(s), 1), tries: 5 });
  assert.deepEqual(calls, ['restart']);
});

test('restartAfterExit: no pid (or a bad one) restarts without waiting', async () => {
  for (const bad of [undefined, '0', '-4', 'x']) {
    let waited = false;
    const calls = [];
    await restartAfterExit(bad, { alive: () => (waited = true), sleep: () => Promise.resolve(), runService: (s) => (calls.push(s), 0) });
    assert.equal(waited, false, String(bad));
    assert.deepEqual(calls, ['restart'], String(bad));
  }
});

test('restartAfterExit: what the restart said and its outcome reach the activity log, as its own output goes nowhere', async () => {
  const quiet = console.error;
  console.error = () => {}; // the helper also says it, to a stdio the dashboard ignored
  try {
    for (const [code, said, did, outcome] of [
      [1, ['The new dashboard did not answer within 30 seconds of its start, so this did not work.', 'The last lines of its log:', 'EADDRINUSE'], /could not start the dashboard again/, /^failed \(exit 1\): The new dashboard did not answer within 30 seconds/],
      [0, ['The dashboard started again. It answers at http://127.0.0.1:7433 (process 9100).'], /started the dashboard again/, /^ok$/],
    ]) {
      const added = [];
      const got = await restartAfterExit(undefined, {
        runService: async (s) => {
          assert.equal(s, 'restart');
          for (const line of said) (code ? console.error : console.log)(line);
          return code;
        },
        log: { add: (e) => added.push(e) },
      });
      assert.equal(got, code);
      assert.equal(added.length, 1, 'one line in the activity log');
      assert.equal(added[0].automation, 'updates');
      assert.match(added[0].did, did);
      assert.match(added[0].outcome, outcome);
    }
    const added = [];
    assert.equal(await restartAfterExit(undefined, { runService: async () => { throw new Error('schtasks is missing'); }, log: { add: (e) => added.push(e) } }), 1);
    assert.match(added[0].outcome, /^failed \(exit 1\): schtasks is missing/);
  } finally {
    console.error = quiet;
  }
});

test('spawnServiceRestart: a detached, unref\'d `__service-restart <pid>` helper, its stdio ignored', () => {
  const calls = [];
  let unreffed = false;
  const pid = spawnServiceRestart({
    node: '/usr/bin/node',
    bin: '/opt/hoprig/bin/hoprig.mjs',
    pid: 777,
    env: { PATH: '/usr/bin' }, // seal: a value only recorded by the stand-in spawn, never a program started
    spawnImpl: (cmd, args, opts) => (calls.push({ cmd, args, opts }), { pid: 999, unref: () => (unreffed = true) }),
  });
  assert.equal(pid, 999);
  assert.ok(unreffed, 'the helper is unref\'d, so this process can exit while it runs');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/usr/bin/node');
  assert.deepEqual(calls[0].args, ['/opt/hoprig/bin/hoprig.mjs', '__service-restart', '777']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(calls[0].opts.windowsHide, true);
});

test('serviceInstalled: the file each manager writes and its uninstall removes, on that system only', () => {
  const only = (frag) => (p) => String(p).includes(frag);
  // The file each `service install` writes: a systemd unit, a launchd plist, the Windows startup script.
  assert.equal(serviceInstalled('linux', { existsSync: only('systemd') }), true);
  assert.equal(serviceInstalled('darwin', { existsSync: only('LaunchAgents') }), true);
  assert.equal(serviceInstalled('win32', { existsSync: only('dashboard-service.ps1') }), true);
  // Nothing installed: false on every system; and a system with no service manager here is never "installed".
  assert.equal(serviceInstalled('linux', { existsSync: () => false }), false);
  assert.equal(serviceInstalled('darwin', { existsSync: () => false }), false);
  assert.equal(serviceInstalled('win32', { existsSync: () => false }), false);
  assert.equal(serviceInstalled('freebsd', { existsSync: () => true }), false);
});
