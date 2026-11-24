// One computer's health in one view (src/machines/health.mjs, GET /api/machines/<name>/health): the hub reads the
// other computer's /api/health with its token over its own link and keeps only the fields the list names; a Fix that
// needs sudo is marked as such with its command; a computer that does not answer is "not reached" with the time it
// last answered (or never), never fine. Nothing is read by itself: only when the route is called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { asBrowser, miniDashboard } from './harness.mjs';

const box = sandbox('machines-health');
const { createMachines } = await import('../../src/machines/index.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { putMachine, getMachine } = await import('../../src/machines/store.mjs');
const { healthChecks, localHealth, pickHealth } = await import('../../src/machines/health.mjs');

const answer = {
  hoprig: 'health',
  at: 1,
  checks: [
    { group: 'This computer', id: 'node', label: 'Node.js', status: 'ok', detail: '22.11.0', fix: '' },
    { group: 'This computer', id: 'linger', label: 'Runs after logout', status: 'warn', detail: 'lingering is off', fix: 'sudo loginctl enable-linger alex', fixId: null },
    { group: 'Coding tools', id: 'git', label: 'Git', status: 'fail', detail: 'missing', fix: 'hoprig pc setup --kits git', fixId: 'git' },
  ],
  versions: { hoprig: '0.3.3', claude: '2.1.0', opencode: null },
  service: { status: 'ok', detail: 'running (systemd user service)' },
  listens: { host: '127.0.0.1', port: 7433 },
  load: [0.5, 0.4, 0.3],
  cpus: 4,
  memory: { total: 8e9, available: 6e9 },
  disks: [{ mount: '/', size: 1e11, used: 2e10, avail: 8e10 }],
  token: 'hop_should-never-pass', // a field the list does not name
};
let asked = 0;
const other = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null }, answers: { '/api/health': answer }, onRequest: (req) => req.url === '/api/health' && asked++ }).listen();
const hub = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null, hub: { probeTimeoutMs: 500, tunnelWaitMs: 1000 } } }).listen();
const browser = asBrowser(hub.base);
const { token } = createToken('hub');
putMachine({ name: 'box2', label: 'Box 2', via: 'url', url: other.base, token, tokenId: null, added: 1 });
putMachine({ name: 'gone', label: 'Gone', via: 'url', url: 'http://127.0.0.1:9', token: 'hop_x', tokenId: null, added: 1 });
test.after(async () => {
  await hub.close();
  await other.close();
  box.cleanup();
});

test('the health of a linked computer: through the hub\'s link, only the listed fields, read only when asked', async () => {
  assert.equal(asked, 0, 'nothing is read before the owner asks');
  const r = await browser('/api/machines/box2/health');
  assert.equal(r.status, 200, r.text);
  assert.equal(asked, 1);
  assert.equal(r.json.reached, true);
  const h = r.json.health;
  assert.deepEqual(h.versions, { hoprig: '0.3.3', claude: '2.1.0', opencode: null });
  assert.deepEqual(h.listens, { host: '127.0.0.1', port: 7433 });
  assert.equal(h.service.status, 'ok');
  assert.deepEqual(h.load, [0.5, 0.4, 0.3]);
  assert.equal(h.disks[0].mount, '/');
  assert.ok(!r.text.includes('should-never-pass'), 'a field the list does not name stays out');
  const [ok, linger, git] = h.checks;
  assert.equal(ok.fix, '', 'a check that is fine has no Fix');
  assert.equal(linger.admin, true, 'a fix with sudo is marked: the page shows its command and asks first');
  assert.equal(linger.fixId, null);
  assert.equal(git.fixId, 'git', 'a check Setup can fix there carries its id for the Fix button');
  assert.equal(git.admin, false);
  assert.ok(getMachine('box2').seenAt > 0, 'when it last answered is kept');
});

test('a computer that does not answer is "not reached" with when it last did, never fine', async () => {
  const never = await browser('/api/machines/gone/health');
  assert.equal(never.status, 200);
  assert.equal(never.json.reached, false);
  assert.equal(never.json.seenAt, null, 'never reached');
  assert.equal(never.json.health, null, 'no figures that would look fine');
  assert.ok(never.json.error);
  const seen = getMachine('box2').seenAt;
  await other.close();
  const later = await browser('/api/machines/box2/health');
  assert.equal(later.json.reached, false);
  assert.equal(later.json.seenAt, seen, 'not reached since the last answer');
  assert.equal((await browser('/api/machines/nobody/health')).status, 404);
});

test('localHealth: the doctor\'s checks, the versions, the service, where it listens and the system figures', async () => {
  const h = await localHealth({ now: () => 5, parts: {
    plans: async () => ({ git: { admin: true, commands: ['sudo apt-get install -y git'] } }),
    checks: async () => [{ id: 'service', label: 'Background service', status: 'warn', detail: 'not installed', fix: 'hoprig service install' }, { id: 'git', label: 'Git', status: 'fail', detail: 'missing', fix: 'sudo apt-get install -y git', fixKit: 'git' }],
    snapshot: async () => ({ load: [1, 2, 3, 4], cpus: 2, mem: { total: 10, available: 4, swapTotal: 1 }, disks: [{ mount: '/', size: 3, used: 1, avail: 2, extra: 'x' }], topCpu: [{ cmd: 'secret' }] }),
    versions: async () => ({ hoprig: '0.3.3', claude: null, opencode: null }),
    listens: () => ({ host: '127.0.0.1', port: 8191 }),
  } });
  assert.deepEqual(h.service, { status: 'warn', detail: 'not installed' });
  assert.deepEqual(h.load, [1, 2, 3]);
  assert.deepEqual(h.memory, { total: 10, available: 4 });
  assert.deepEqual(h.disks, [{ mount: '/', size: 3, used: 1, avail: 2 }]);
  assert.equal(h.checks[1].fixId, 'git');
  assert.equal(h.checks[1].admin, true);
  assert.ok(!JSON.stringify(h).includes('secret'), 'no process list');
  assert.deepEqual(Object.keys(pickHealth(h)).sort(), Object.keys(h).sort(), 'the hub keeps the same fields');
  assert.equal(healthChecks([{ id: 'x', status: 'ok', fix: 'sudo x' }])[0].admin, false, 'a fine check needs no fix');
});

test('localHealth sends the mount of the workspace\'s disk, never the workspace\'s path', async () => {
  const h = await localHealth({ own: () => ({ working: 1, runs: { running: 0, atOnce: 2 }, holdLeftMs: null, workspace: '/home/alex/Workspace' }), parts: {
    checks: async () => [], plans: async () => ({}), versions: async () => ({}), listens: () => ({ host: '127.0.0.1', port: 1 }),
    snapshot: async () => ({ load: [1, 1, 1], cpus: 2, mem: { total: 10, available: 4 }, disks: [{ mount: '/', size: 3, used: 1, avail: 2 }, { mount: '/home', size: 9, used: 1, avail: 8 }, { mount: '/mnt/backup', size: 9, used: 9, avail: 0 }] }),
  } });
  assert.equal(h.own.mount, '/home');
  assert.ok(!JSON.stringify(h).includes('Workspace'), 'the path stays on the computer');
  assert.equal(pickHealth(h).own.mount, '/home');
});

test('a Fix\'s administrator rights come from what its kit runs there, never from the words of its fix line', async () => {
  // The GitHub command's fix line names no sudo, but its kit installs gh with sudo apt.
  const h = await localHealth({ parts: {
    checks: async () => [{ id: 'github.gh', label: 'GitHub CLI', status: 'warn', detail: 'missing', fix: 'hoprig pc setup --kits github', fixKit: 'github' }],
    plans: async () => ({ github: { admin: true, commands: ['sudo mkdir -p -m 755 /etc/apt/keyrings', 'sudo apt-get install -y gh'] } }),
    snapshot: async () => ({}), versions: async () => ({}), listens: () => ({ host: '127.0.0.1', port: 1 }),
  } });
  const [c] = h.checks;
  assert.equal(c.admin, true, 'marked: the page shows its commands and asks first');
  assert.deepEqual(c.commands, ['sudo mkdir -p -m 755 /etc/apt/keyrings', 'sudo apt-get install -y gh']);
  const [kept] = pickHealth(h).checks;
  assert.equal(kept.admin, true, 'the hub keeps what that computer said');
  assert.deepEqual(kept.commands, c.commands);
  assert.equal(kept.fixId, 'github.gh');
});

test('a check that Setup\'s Fix cannot do (the commit name, the GitHub sign-in) has no Fix and points to where it is done', async () => {
  const h = await localHealth({ parts: {
    checks: async () => [
      { id: 'identity', label: 'Commit name and e-mail', status: 'warn', detail: 'not set', fix: 'git config --global user.name "Your Name"', fixKit: 'github' },
      { id: 'signin', label: 'GitHub sign-in', status: 'warn', detail: 'not signed in', fix: 'gh auth login', fixKit: 'github' },
    ],
    plans: async () => ({ github: { admin: true, commands: ['sudo apt-get install -y gh'] } }),
    snapshot: async () => ({}), versions: async () => ({}), listens: () => ({ host: '127.0.0.1', port: 1 }),
  } });
  for (const c of [...h.checks, ...pickHealth(h).checks]) {
    assert.equal(c.fixId, null, `${c.id}: no Fix that ends ok and changes nothing`);
    assert.equal(c.where, 'Setup → Git and GitHub', c.id);
  }
});
