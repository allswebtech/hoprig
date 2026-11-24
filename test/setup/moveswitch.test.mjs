// The switch of the move (src/setup/moveswitch.mjs): every system call is a stand-in that writes down what it was
// asked (lingering, the install as the user, the trial dashboard, root's service, the user's service, the owner of the
// listener). Root's dashboard is started again on every failure after it was stopped, and before that nothing of
// root's is touched. The same password signs in to a dashboard started on the copied settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';
import { closedGateways } from '../seal.mjs';

const s = scratch();
test.after(s.cleanup);
const W = await import('../../src/setup/moveswitch.mjs');
const { stateKey } = await import('../../src/server/dashboardfile.mjs');

const oldHome = path.join(s.tmp, 'root');
const user = { name: 'hoprig', uid: 1001, gid: 1001, home: path.join(s.tmp, 'users', 'hoprig') };
fs.mkdirSync(oldHome, { recursive: true });
fs.mkdirSync(path.join(user.home, '.local/state/hoprig'), { recursive: true });
const plan = (over = {}) => ({
  user, oldHome, port: 7433,
  dirs: { state: path.join(oldHome, '.local/state/hoprig') },
  parts: [{ from: path.join(oldHome, 'Workspace') }, { from: path.join(oldHome, '.claude') }],
  admin: [{ id: 'linger' }, { id: 'owner' }],
  ...over,
});
const userKey = stateKey(path.join(user.home, '.local/state/hoprig'));

/** The stand-in system: `calls` in order; `over` changes one answer. Port 7433 is held by root until stopRoot. */
function standIn(over = {}) {
  const calls = [];
  const st = { holder: 0, written: {} };
  const ok = { ok: true, code: 0, stdout: '', stderr: '' };
  const sys = {
    hasRunuser: () => true,
    linger: async () => (calls.push('linger'), ok),
    waitBus: async () => (calls.push('bus'), true),
    installUser: async () => (calls.push('install-user'), ok),
    freePort: async () => 8441,
    startTrial: async (p) => (calls.push(`trial ${p}`), (st.trial = p), { stop: async () => { calls.push('trial-stop'); st.trial = null; } }),
    facts: async (p) => (p === st.trial || (p === 7433 && st.holder === user.uid) ? { state: userKey, port: p } : p === 7433 && st.holder === 0 ? { state: 'roots' } : null),
    stopRoot: async () => (calls.push('stop-root'), (st.holder = null), ok),
    startRoot: async () => (calls.push('start-root'), (st.holder = 0), ok),
    disableRoot: async () => (calls.push('disable-root'), ok),
    installUserService: async () => (calls.push('user-service'), (st.holder = user.uid), ok),
    stopUserService: async () => (calls.push('stop-user-service'), st.holder === user.uid && (st.holder = null), ok),
    listenerUid: async () => st.holder,
    portFree: async () => st.holder === null,
    writeFile: (f, t) => { calls.push(`write ${path.basename(f)}`); st.written[f] = t; },
    sleep: async () => {},
    ...over,
  };
  return { sys, calls, st };
}

test("the switch: lingering, the install as the user, a trial, root's service stopped, the user's service checked by its listener's owner, the plain file", async () => {
  const { sys, calls, st } = standIn();
  const lines = [];
  const r = await W.switchToUser(plan(), { sys, say: (l) => lines.push(l) });
  assert.equal(r.ok, true, lines.join('\n'));
  // Root's service is stopped (still enabled), and disabled only once the user's answered as the user.
  assert.deepEqual(calls, ['linger', 'bus', 'install-user', 'trial 8441', 'trial-stop', 'stop-root', 'user-service', 'disable-root', `write ${W.MOVED_FILE}`]);
  const text = st.written[path.join(oldHome, W.MOVED_FILE)];
  assert.match(text, /^Hoprig on this server runs as the user hoprig since \d{4}-\d\d-\d\dT\d\d:\d\dZ\./);
  assert.match(text, new RegExp(`Root's copy of what was moved is kept, unchanged, in ${oldHome}:`));
  assert.match(text, /Become that user: sudo -iu hoprig/);
  assert.match(lines.join('\n'), /hoprig's dashboard answers on port 7433, as hoprig\./);
});

test('a failure before root is stopped (the install, the trial) leaves root as it was: no stop, no start', async () => {
  for (const [name, over] of [
    ['install', { installUser: async () => ({ ok: false, stderr: 'npm failed (made up)' }) }],
    ['trial', { facts: async () => null }],
    ['bus', { waitBus: async () => false }],
    ['runuser', { hasRunuser: () => false }],
  ]) {
    const { sys, calls } = standIn(over);
    const lines = [];
    const r = await W.switchToUser(plan(), { sys, say: (l) => lines.push(l) });
    assert.equal(r.ok, false, name);
    assert.ok(!calls.includes('stop-root') && !calls.includes('start-root'), `${name}: ${calls}`);
    assert.match(lines.join('\n'), /Root's dashboard was not stopped: it runs as before\./, name);
  }
});

test("a dashboard on the port that is not the user's process: the user's service is stopped and root's started again", async () => {
  const { sys, calls, st } = standIn({ listenerUid: async () => 4242 });
  const lines = [];
  const r = await W.switchToUser(plan(), { sys, say: (l) => lines.push(l) });
  assert.equal(r.ok, false);
  assert.match(lines.join('\n'), /runs as user id 4242, not as hoprig \(1001\)/);
  assert.deepEqual(calls.slice(-3), ['user-service', 'stop-user-service', 'start-root']);
  assert.equal(st.holder, 0, "root's holds the port again");
  assert.match(lines.at(-1), /Root's dashboard runs again, as before\./);
  assert.equal(Object.keys(st.written).length, 0, 'no plain file');
});

test("the user's service fails: root's is started again", async () => {
  const { sys, calls } = standIn({ installUserService: async () => ({ ok: false, stderr: 'no background service here' }) });
  const r = await W.switchToUser(plan(), { sys });
  assert.equal(r.ok, false);
  assert.deepEqual(calls.slice(-2), ['stop-user-service', 'start-root']);
});

test("root's service is stopped, never disabled, until the user's answered: a failure after the stop leaves it enabled", async () => {
  for (const over of [{ installUserService: async () => ({ ok: false, stderr: 'no background service here' }) }, { listenerUid: async () => 4242 }]) {
    const { sys, calls } = standIn(over);
    assert.equal((await W.switchToUser(plan(), { sys })).ok, false);
    assert.ok(!calls.includes('disable-root'), calls.join(' '));
  }
  // The real commands: stop for the switch, disable after it.
  const run = [];
  const real = W.realSwitchSys(user, { run: async (argv) => (run.push(argv.join(' ')), { ok: true, stdout: '' }), env: {} });
  await real.stopRoot();
  await real.disableRoot();
  assert.deepEqual(run, ['systemctl --user stop hoprig.service', 'systemctl --user disable hoprig.service']);
});

test('a hang-up, Ctrl-C or SIGTERM in the switch window does not end the move: held back, said, and the switch goes through', async () => {
  const { EventEmitter } = await import('node:events');
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const lines = [];
  let guarded = null;
  const { sys, calls } = standIn({
    guard: () => (guarded = W.guardSignals({ proc })),
    // The connection drops while root's dashboard is stopped.
    stopRoot: async () => {
      calls.push('stop-root');
      for (const sig of W.HELD_SIGNALS) assert.equal(proc.listenerCount(sig), 1, `${sig} is held`);
      proc.emit('SIGHUP');
      proc.emit('SIGINT');
      return { ok: true, stdout: '', stderr: '' };
    },
  });
  // The stand-in stopRoot above does not free the port by itself: the user's service takes it over.
  sys.portFree = async () => true;
  const r = await W.switchToUser(plan(), { sys, say: (l) => lines.push(l) });
  assert.equal(r.ok, true, lines.join('\n'));
  assert.ok(guarded, 'the guard was put up');
  assert.deepEqual(guarded.seen, ['SIGHUP', 'SIGINT']);
  for (const sig of W.HELD_SIGNALS) assert.equal(proc.listenerCount(sig), 0, `${sig} is let go after the switch`);
  assert.match(lines.join('\n'), /SIGHUP, SIGINT came during the switch and was held back until a dashboard ran again/);
  assert.ok(calls.includes('disable-root'));
  // A failure in the window lets them go as well.
  const proc2 = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const two = standIn({ guard: () => W.guardSignals({ proc: proc2 }), installUserService: async () => ({ ok: false, stderr: 'x' }) });
  assert.equal((await W.switchToUser(plan(), { sys: two.sys })).ok, false);
  for (const sig of W.HELD_SIGNALS) assert.equal(proc2.listenerCount(sig), 0);
});

test("the step back: the user's service stopped, root's started again and listening as root", async () => {
  const { sys, calls, st } = standIn();
  st.holder = user.uid;
  const lines = [];
  const r = await W.stepBack(plan(), { sys, say: (l) => lines.push(l) });
  assert.equal(r.ok, true, lines.join('\n'));
  assert.deepEqual(calls, ['stop-user-service', 'start-root']);
  assert.match(lines.at(-1), /Root's dashboard runs again on port 7433\. hoprig's copy stays where it is\./);
});

test('the listener and its owner are read from ss and /proc', () => {
  const ss = 'LISTEN 0 511 127.0.0.1:7433 0.0.0.0:* users:(("node",pid=4711,fd=21))\nLISTEN 0 511 127.0.0.1:74330 0.0.0.0:* users:(("x",pid=9,fd=3))';
  assert.equal(W.listenerPid(ss, 7433), 4711);
  assert.equal(W.listenerPid(ss, 7434), null);
  assert.equal(W.procUid('Name:\tnode\nUid:\t1001\t1001\t1001\t1001\n'), 1001);
});

test('the same password signs in to a dashboard on the copied settings', async () => {
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const copied = path.join(user.home, '.config/hoprig');
  fs.mkdirSync(copied, { recursive: true });
  fs.writeFileSync(path.join(copied, 'config.json'), JSON.stringify({ launcher: ['L'], server: { passwordHash: await hashPassword('the-old-password') }, router: { port: 1 }, addons: closedGateways() }));
  process.env.HOPRIG_CONFIG_DIR = copied;
  process.env.HOPRIG_STATE_DIR = path.join(user.home, '.local/state/hoprig');
  const { createServer } = await import('../../src/server/server.mjs');
  const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name, id: 'pty-1' }), respawn: async () => {} };
  const app = createServer({ backend, root: false, rootExists: () => false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const login = (password) => fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ password }) });
    assert.equal((await login('the-old-password')).status, 200);
    assert.equal((await login('another')).status, 401);
  } finally {
    await app.close();
  }
});

test("the trial dashboard answers and starts no feature of its own (no restore, link, gateway): the bypass first look's marker is not written", async () => {
  const { createServer } = await import('../../src/server/server.mjs');
  const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name, id: 'pty-1' }), respawn: async () => {} };
  const marker = path.join(process.env.HOPRIG_STATE_DIR, 'bypass-first-look.json');
  fs.rmSync(marker, { force: true });
  const trial = createServer({ backend, root: false, rootExists: () => false, dashboardFile: false, watch: false, startFeatures: false });
  await trial.listen(0, '127.0.0.1');
  await trial.close();
  assert.equal(fs.existsSync(marker), false, 'a trial starts no feature');
  const real = createServer({ backend, root: false, rootExists: () => false, dashboardFile: false, watch: false });
  await real.listen(0, '127.0.0.1');
  await real.close();
  assert.equal(fs.existsSync(marker), true, 'an ordinary start does');
});
