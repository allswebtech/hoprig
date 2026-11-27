// A gateway add-on in the move (src/setup/movegateway.mjs), with a made-up gateway definition (`dataDir`) and
// stand-ins for its listener, its stop, its start as root and as the user. Root's is stopped by its listening
// socket's pid, its data copied, it starts as the user on this computer only, the provider's PRERUN names the user's
// Hoprig; when the user's does not come up, root's is started again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const G = await import('../../src/setup/movegateway.mjs');
const { checkDefinition, SHIPPED } = await import('../../src/addons/gateways.mjs');

const oldHome = path.join(s.tmp, 'root');
const user = { name: 'hoprig', uid: 1001, home: path.join(s.tmp, 'users', 'hoprig') };
const profiles = path.join(user.home, '.config/hoprig/profiles');
fs.mkdirSync(path.join(oldHome, '.madeupgw/logs'), { recursive: true });
fs.writeFileSync(path.join(oldHome, '.madeupgw/accounts.json'), '{"made":"up"}');
fs.mkdirSync(profiles, { recursive: true });
const gw = { id: 'madeupgw', title: 'Made-up gateway', port: 29999, dataDir: '.madeupgw' };

function standIn({ userComesUp = true } = {}) {
  const calls = [];
  let holder = { pid: 4711, uid: 0, addr: '0.0.0.0:29999' };
  const sys = {
    listener: async () => holder,
    stop: async (pid) => (calls.push(`stop ${pid}`), (holder = null)),
    copyData: async (from, to) => {
      calls.push('copy');
      fs.cpSync(from, to, { recursive: true });
      const n = (d) => fs.readdirSync(d, { recursive: true }).length;
      return { ok: true, entries: [n(from), n(to)] };
    },
    startAsUser: async (id) => (calls.push(`user-start ${id}`), userComesUp && (holder = { pid: 5000, uid: 1001, addr: '127.0.0.1:29999' })),
    startAsRoot: async (id) => (calls.push(`root-start ${id}`), (holder = { pid: 4712, uid: 0, addr: '0.0.0.0:29999' })),
    userHoprig: async () => ({ node: '/home/hoprig/.nvm/versions/node/v24.11.0/bin/node', bin: '/home/hoprig/.local/lib/node_modules/hoprig/bin/hoprig.mjs' }),
    profilesDir: profiles,
    sleep: async () => {},
  };
  return { sys, calls };
}

test('a gateway definition may name its data folder; nothing outside the home', () => {
  // The definition names a Linux program, read as the move (Linux only) reads it, on any computer the test runs on.
  const linux = { platform: 'linux' };
  assert.equal(checkDefinition({ id: 'madeupgw', title: 'Made-up gateway', bin: '/opt/madeup/gw', port: 29999, dataDir: '.madeupgw' }, linux).def.dataDir, '.madeupgw');
  for (const bad of ['../x', '/etc', 'a/../b', '.', '']) assert.match(checkDefinition({ id: 'madeupgw', title: 'Made-up gateway', bin: '/opt/madeup/gw', port: 29999, dataDir: bad }, linux).error || '', /dataDir/, bad);
  assert.ok(SHIPPED.every((g) => typeof g.dataDir === 'string'), 'a shipped gateway says where it keeps its data');
});

test("root's gateway: stopped by its socket's pid, its data copied, started as the user on this computer only, PRERUN at the user's Hoprig", async () => {
  fs.writeFileSync(path.join(profiles, 'api.env'), 'LABEL="API via it"\nPRERUN="/usr/bin/node /usr/lib/node_modules/hoprig/bin/hoprig.mjs addons start madeupgw"\nANTHROPIC_AUTH_TOKEN=made-up\n');
  fs.writeFileSync(path.join(profiles, 'other.env'), 'PRERUN="node x addons start another"\n');
  const { sys, calls } = standIn();
  const lines = [];
  const r = await G.moveGateways({ user, oldHome }, [gw], { sys, say: (l) => lines.push(l) });
  assert.deepEqual(calls, ['stop 4711', 'copy', 'user-start madeupgw']);
  assert.equal(r.moved[0].ok, true);
  assert.equal(fs.readFileSync(path.join(user.home, '.madeupgw/accounts.json'), 'utf8'), '{"made":"up"}');
  assert.match(fs.readFileSync(path.join(profiles, 'api.env'), 'utf8'), /^PRERUN="\/home\/hoprig\/\.nvm\/versions\/node\/v24\.11\.0\/bin\/node \/home\/hoprig\/\.local\/lib\/node_modules\/hoprig\/bin\/hoprig\.mjs addons start madeupgw"$/m);
  assert.match(fs.readFileSync(path.join(profiles, 'api.env'), 'utf8'), /^ANTHROPIC_AUTH_TOKEN=made-up$/m, 'the rest as it was');
  assert.equal(fs.readFileSync(path.join(profiles, 'other.env'), 'utf8'), 'PRERUN="node x addons start another"\n');
  const text = lines.join('\n');
  assert.match(text, /Before it listened on every address \(0\.0\.0\.0\), open to the network; now on this computer only \(127\.0\.0\.1\)\./);
  assert.doesNotMatch(text, /made-up/, 'no key is said');
});

test("the user's gateway does not come up: root's is started again as it was", async () => {
  fs.rmSync(path.join(user.home, '.madeupgw'), { recursive: true, force: true });
  const { sys, calls } = standIn({ userComesUp: false });
  const lines = [];
  const r = await G.moveGateways({ user, oldHome }, [gw], { sys, say: (l) => lines.push(l) });
  assert.deepEqual(calls, ['stop 4711', 'copy', 'user-start madeupgw', 'root-start madeupgw']);
  assert.equal(r.moved[0].ok, false);
  assert.match(lines.at(-1), /did not come up as hoprig\. Starting root's again as it was\./);
});

test("a provider file the user's side made a link is not rewritten through it", async () => {
  const outside = path.join(s.tmp, 'gw-outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'target.env'), 'PRERUN="/usr/bin/node /usr/lib/node_modules/hoprig/bin/hoprig.mjs addons start madeupgw"\n');
  for (const n of fs.readdirSync(profiles)) fs.rmSync(path.join(profiles, n));
  fs.symlinkSync(path.join(outside, 'target.env'), path.join(profiles, 'linked.env'));
  const { sys } = standIn();
  const lines = [];
  await G.moveGateways({ user, oldHome }, [gw], { sys, say: (l) => lines.push(l) });
  assert.match(fs.readFileSync(path.join(outside, 'target.env'), 'utf8'), /^PRERUN="\/usr\/bin\/node /, 'the file outside is as it was');
  fs.rmSync(path.join(profiles, 'linked.env'), { force: true });
});

// The user is the runner's own id, so the copy's chown works without root.
test("the gateway's data copy never writes through a link a user process put at a folder above it", { skip: process.platform === 'win32' && 'the move to a user of its own is Linux only (chown by uid)' }, async () => {
  const { realGatewaySys } = await import('../../src/setup/movegatewaysys.mjs');
  const uhome = path.join(s.tmp, 'gwlink-home');
  const outside = path.join(s.tmp, 'gwlink-outside');
  const rootHome = path.join(s.tmp, 'gwlink-root');
  fs.mkdirSync(path.join(rootHome, '.local/share/madeupgw'), { recursive: true });
  fs.writeFileSync(path.join(rootHome, '.local/share/madeupgw/accounts.json'), '{"made":"up"}');
  fs.mkdirSync(uhome, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // The user's ~/.local is swapped for a link to a folder outside the home.
  fs.symlinkSync(outside, path.join(uhome, '.local'));
  const me = { name: 'hoprig', uid: process.getuid(), gid: process.getgid(), home: uhome };
  const sys = realGatewaySys({ user: me, oldHome: rootHome, dirs: { config: path.join(rootHome, '.config/hoprig') } });
  const c = await sys.copyData(path.join(rootHome, '.local/share/madeupgw'), path.join(uhome, '.local/share/madeupgw'));
  assert.equal(c.ok, false);
  assert.match(c.error, /is not a plain folder/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was made at the link\'s target');
  // With plain folders it copies, the missing ones made inside the home.
  fs.rmSync(path.join(uhome, '.local'));
  const ok = await sys.copyData(path.join(rootHome, '.local/share/madeupgw'), path.join(uhome, '.local/share/madeupgw'));
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.entries, [2, 2]);
  assert.equal(fs.lstatSync(path.join(uhome, '.local')).isDirectory(), true);
  if (process.platform !== 'win32') assert.equal(fs.lstatSync(path.join(uhome, '.local')).mode & 0o777, 0o700);
  // What is already there is never written over.
  assert.match((await sys.copyData(path.join(rootHome, '.local/share/madeupgw'), path.join(uhome, '.local/share/madeupgw'))).error, /already there/);
});

test("a failed copy of the gateway's data takes away only what this call made", { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'Linux only, and not as root (root reads every file)' }, async () => {
  const { realGatewaySys } = await import('../../src/setup/movegatewaysys.mjs');
  const uhome = path.join(s.tmp, 'gwfail-home');
  const rootHome = path.join(s.tmp, 'gwfail-root');
  fs.mkdirSync(path.join(rootHome, 'data'), { recursive: true });
  fs.writeFileSync(path.join(rootHome, 'data/a.json'), '{}');
  fs.writeFileSync(path.join(rootHome, 'data/b.json'), '{}');
  fs.chmodSync(path.join(rootHome, 'data/b.json'), 0); // unreadable: the copy fails after it has begun
  fs.mkdirSync(uhome, { recursive: true });
  const me = { name: 'hoprig', uid: process.getuid(), gid: process.getgid(), home: uhome };
  const sys = realGatewaySys({ user: me, oldHome: rootHome, dirs: { config: path.join(rootHome, '.config/hoprig') } });
  const to = path.join(uhome, '.gw');
  const c = await sys.copyData(path.join(rootHome, 'data'), to);
  assert.equal(c.ok, false, JSON.stringify(c));
  assert.match(c.error, /half-made copy .* was removed/);
  assert.equal(fs.existsSync(to), false, 'nothing is left of the failed copy, so a later move is not refused');
  // A folder that was there before the call is refused and stays as it is.
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'mine.json'), '1');
  const again = await sys.copyData(path.join(rootHome, 'data'), to);
  assert.match(again.error, /already there/);
  assert.deepEqual(fs.readdirSync(to), ['mine.json']);
});

test('realGatewaySys.stop returns only once the process has ended, not when its port closes', async () => {
  const { realGatewaySys } = await import('../../src/setup/movegatewaysys.mjs');
  const plan = { user, oldHome, dirs: { config: path.join(oldHome, '.config/hoprig') } };
  let after = -1; // readProc calls since the kill
  const mk = (kill) => realGatewaySys(plan, {
    kill,
    readProc: () => {
      after += 1;
      if (after >= 3) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return 'Name:\tnode\nUid:\t0\t0\t0\t0\n';
    },
  });
  await mk(() => { after = 0; }).stop(4343);
  assert.equal(after, 3, 'it asked until the process was gone');
  after = -1;
  await mk(() => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); }).stop(4343);
  assert.equal(after, -1, 'a kill that fails returns at once');
});

// The shipped gateway has a copy of its own in Hoprig's folder (src/addons/owncopy.mjs): the user gets one installed
// again as the user (never root's), and the data folder is the one Hoprig computes by the gateway's own rule.
test("a gateway with a copy of its own: its data folder by the gateway's rule, its program installed again as the user, and the move undone when that fails", async () => {
  const ownGw = { id: 'madeupgw', title: 'Made-up gateway', port: 29999, dataDir: '.madeupgw', own: true };
  fs.rmSync(path.join(user.home, '.trouteai'), { recursive: true, force: true });
  fs.mkdirSync(path.join(oldHome, '.trouteai'), { recursive: true });
  fs.writeFileSync(path.join(oldHome, '.trouteai/accounts.json'), '{"made":"up"}');
  const asked = [];
  const { sys, calls } = standIn();
  const start = sys.startAsUser;
  sys.startAsUser = async (id, opts) => (asked.push(opts), start(id));
  const lines = [];
  const r = await G.moveGateways({ user, oldHome }, [ownGw], { sys, say: (l) => lines.push(l) });
  assert.equal(r.moved[0].ok, true, lines.join('\n'));
  assert.deepEqual(asked, [{ own: true }], 'the sys is told it is a copy of its own');
  assert.equal(fs.readFileSync(path.join(user.home, '.trouteai/accounts.json'), 'utf8'), '{"made":"up"}', 'root\'s data folder by the rule, not the definition\'s dataDir');
  assert.match(lines.join('\n'), /its program is installed for hoprig in hoprig's own Hoprig folder/);
  assert.deepEqual(calls.slice(0, 2), ['stop 4711', 'copy']);
});

test('the real start as the user installs the own copy first and does not start without it', async () => {
  const { realGatewaySys } = await import('../../src/setup/movegatewaysys.mjs');
  const ran = [];
  const run = async (argv) => (ran.push(argv.join(' ')), { ok: !argv.includes('install'), stdout: '', stderr: 'no network' });
  const sys = realGatewaySys({ user: { name: 'hoprig', uid: 1001, home: user.home }, oldHome, dirs: { config: path.join(oldHome, '.config/hoprig') } }, { run, has: () => true });
  await sys.startAsUser('madeupgw', { own: true });
  assert.equal(ran.length, 1, ran.join(' | '));
  assert.match(ran[0], /addons install madeupgw/);
});
