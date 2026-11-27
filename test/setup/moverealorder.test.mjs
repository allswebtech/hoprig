// `hoprig move-to-user --yes` on a server with only root, in the real order and with the REAL steps of the move
// (src/setup/moverun.mjs realSteps, moveswitch.mjs realSwitchSys, movegatewaysys.mjs realGatewaySys, movejob.mjs):
// the look finds no user, the installer makes one (a stand-in that answers as install.sh and getent do: an ordinary
// user id, and a home that is not the planned /home/<name>), and then every step must work for THAT user. Only the
// lowest calls are handed in (the program runner, the socket check, the change of owner, the read of a process's user
// id, the stop of a pid, the start of the trial, the free port, the dashboard's answer), and each writes down the user
// it was asked for: the wait asks for /run/user/<made uid>/bus, every run as the user carries the made user's
// XDG_RUNTIME_DIR and home, every owner given is the made user's, the gateway runs as the made user, and the job file's
// mirror is in the made user's state folder. On a real server the move once asked for /run/user/null/bus.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

// The move to a user of its own is Linux only: root, user ids, runuser and systemd, with POSIX paths.
const LINUX_ONLY = { skip: process.platform === 'win32' && 'the move to a user of its own is Linux only (root, chown by uid, POSIX paths)' };

const s = scratch();
test.after(s.cleanup);
const M = await import('../../src/setup/movecli.mjs');
const { capture } = await import('../../src/setup/system.mjs');
const { stateKey } = await import('../../src/server/dashboardfile.mjs');
const { projectSlug: slugOf } = await import('../../src/sessions.mjs');
// Claude Code names a project folder after its real path (process.cwd()); a temporary folder may be reached through a
// link (macOS: /var is a link to /private/var), and a path here may not be made yet.
const projectSlug = (p) => slugOf(path.join(fs.realpathSync(s.tmp), path.relative(s.tmp, p)));
const { gatewayAddons } = await import('../../src/addons/gateways.mjs');

const UID = 1234;
const PORT = 8442; // the dashboard's port of this test (never the product's default)
const TRIAL = 8441;
const root = path.join(s.tmp, 'root');
const madeHome = path.join(s.tmp, 'srv', 'people', 'hoprig'); // where the system made it: not /home/hoprig
const dirs = { config: path.join(root, '.config/hoprig'), state: path.join(root, '.local/state/hoprig'), claude: path.join(root, '.claude'), workspace: path.join(root, 'Workspace') };
const write = (f, t = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
write(path.join(dirs.config, 'config.json'), JSON.stringify({ workspaceDir: dirs.workspace }));
write(path.join(dirs.state, 'server.json'), '{}');
const shop = path.join(dirs.workspace, 'projects/shop');
write(path.join(shop, 'README.md'), 'shop\n');
execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: shop });
execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', 'commit', '-qm', 'first', '--allow-empty'], { cwd: shop });
const conv = path.join(dirs.claude, 'projects', projectSlug(root));
write(path.join(conv, 'one.jsonl'), '{"made":"up"}\n');
// A gateway that runs as root and keeps its data in root's home, and a provider file that starts it.
const gw = gatewayAddons().find((a) => a.dataDir);
assert.ok(gw, 'a shipped gateway keeps its data in a folder of the home');
write(path.join(root, gw.dataDir, 'accounts.json'), '{"made":"up"}');
write(path.join(dirs.config, 'profiles', 'alpha.env'), `PRERUN="/old/node /old/hoprig.mjs addons start ${gw.id}"\n`);

// The look: no user of Hoprig's names on this server yet.
const io = {
  home: root, uid: 0, env: { TMUX_TMPDIR: path.join(s.tmp, 'tmux') }, dirs, statfs: () => ({ bavail: 1e7, bsize: 4096 }), workRunning: async () => 0,
  run: async (argv) => (argv[0] === 'getent' ? { ok: false, code: 2, stdout: '', stderr: '' } : { ok: false, code: 1, stdout: '', stderr: '' }),
};

// The lowest calls. Each writes down who it was asked for.
const seen = { bus: [], asUser: [], chown: [], made: 0, killed: [], unknown: [] };
const ok = { ok: true, code: 0, stdout: '', stderr: '' };
let made = false;
let trial = false;
let dash = null; // { pid, uid } of what listens on PORT
let gwInstalled = false;
let gwl = { pid: 4343, uid: 0 }; // root's gateway
const uids = new Map([[4343, 0]]);
const ssText = () => [
  dash && `LISTEN 0 511 127.0.0.1:${PORT} 0.0.0.0:* users:(("node",pid=${dash.pid},fd=20))`,
  gwl && `LISTEN 0 511 127.0.0.1:${gw.gateway.port()} 0.0.0.0:* users:(("node",pid=${gwl.pid},fd=21))`,
].filter(Boolean).join('\n');
const userState = path.join(madeHome, '.local/state/hoprig');
const low = {
  run: async (argv, o = {}) => {
    // The installer's making of the user (movemake.mjs), and getent after it.
    if (argv[0] === 'sh' && argv.includes('--user-only')) {
      seen.made += 1;
      fs.mkdirSync(madeHome, { recursive: true });
      made = true;
      return { ...ok, stdout: '✓ the user hoprig, made\n' };
    }
    if (argv[0] === 'getent' && argv[2] === 'hoprig') return made ? { ...ok, stdout: `hoprig:x:${UID}:${UID}:Hoprig work user:${madeHome}:/bin/bash\n` } : { ok: false, code: 2, stdout: '', stderr: '' };
    if (argv[0] === 'tar') return (fs.writeFileSync(argv[2], 'packed'), ok);
    if (argv[0] === 'ss') return { ...ok, stdout: ssText() };
    if (argv[0] === 'systemctl') return ok; // root's own service: stopped, disabled
    if (argv[0] === 'runuser') {
      // runuser -u NAME -- env K=V ... argv: the user and the address of its service manager are written down.
      const at = argv.indexOf('env');
      const vars = {};
      let i = at + 1;
      for (; i < argv.length && /^[A-Z_]+=/.test(argv[i]); i += 1) vars[argv[i].split('=')[0]] = argv[i].slice(argv[i].indexOf('=') + 1);
      const rest = argv.slice(i);
      seen.asUser.push({ name: argv[2], xdg: vars.XDG_RUNTIME_DIR, bus: vars.DBUS_SESSION_BUS_ADDRESS, home: vars.HOME, what: rest.slice(0, 3).join(' ') });
      if (rest[0] === 'git') return capture(rest, o); // the check reads the copy's git as the user
      if (rest.join(' ') === 'hoprig service install') {
        dash = { pid: 4242, uid: UID };
        uids.set(4242, UID);
        return ok;
      }
      if (rest.join(' ') === `hoprig addons install ${gw.id}`) return (gwInstalled = true, ok);
      if (rest.join(' ') === `hoprig addons start ${gw.id}`) {
        // As on a real server: root's copy lives in root's Node, so the user's start finds nothing until it is installed for the user.
        if (!gwInstalled) return { ok: false, code: 1, stdout: `${gw.title} is not installed (hoprig addons install ${gw.id})\n`, stderr: '' };
        gwl = { pid: 4344, uid: UID };
        uids.set(4344, UID);
        return ok;
      }
      return { ...ok, stdout: 'hoprig is ready.\n' }; // the install for the user
    }
    seen.unknown.push(argv.join(' '));
    return { ok: false, code: 1, stdout: '', stderr: 'not played by this test' };
  },
  has: (c) => c === 'runuser',
  isSocket: (p) => (seen.bus.push(p), p === `/run/user/${UID}/bus`),
  chown: (p, uid, gid) => seen.chown.push({ p, uid, gid }),
  ownerOf: (p) => (seen.chown.findLast((c) => c.p === p)?.uid ?? -1),
  marked: (u) => u.name === 'hoprig' && made,
  readProc: (pid) => `Name:\tnode\nUid:\t${uids.get(pid)}\t${uids.get(pid)}\t${uids.get(pid)}\t${uids.get(pid)}\n`,
  kill: (pid) => {
    seen.killed.push(pid);
    if (gwl?.pid === pid) gwl = null;
  },
  spawn: () => {
    // The user's trial dashboard: it writes where it listens, and root's side writes a conversation meanwhile.
    trial = true;
    write(path.join(userState, 'dashboard.json'), JSON.stringify({ key: 'made-up-key' }));
    write(path.join(conv, 'two.jsonl'), '{"later":"line"}\n');
    return { kill: () => (trial = false) };
  },
  freePort: async () => TRIAL,
  // The network look of the move's real step: every host answers (never the real network).
  reachFetch: async () => ({ ok: true, status: 200 }),
  fetch: async (url) => {
    const port = Number(new URL(url).port);
    if ((port === TRIAL && trial) || (port === PORT && dash)) return { ok: true, json: async () => ({ state: stateKey(userState) }) };
    throw new Error('connection refused');
  },
  sleep: async () => {},
};

/**
 * Before anything runs: do the real steps take their lowest calls from this test? Steps that kept a real one would
 * start the real installer below, so the test stops on its own assertion first. The making is asked with a `run` of
 * the test's in both places it could be taken from, so neither answer starts a program.
 */
async function lowIsUsed() {
  const R = await import('../../src/setup/moverun.mjs');
  const asked = [];
  const refuse = (who) => async () => (asked.push(who), { ok: false, code: 1, stdout: '', stderr: '' });
  const steps = R.realSteps({ ...low, run: refuse('low') });
  await steps.makeUser({ user: { name: 'hoprig', uid: null, gid: null, home: '/home/hoprig' } }, { say: () => {}, run: refuse('given') });
  return asked;
}

test('only root, one command: every real step of the move works for the user the installer made', LINUX_ONLY, async () => {
  assert.deepEqual(await lowIsUsed(), ['low'], "the real steps take this test's lowest calls: without that nothing real is started here");
  const out = [];
  const job = path.join(dirs.state, 'move-job.json');
  const code = await M.main(['--yes', '--job', job], { io, cfg: { server: { port: PORT } }, low, out: (l) => out.push(l), err: (l) => out.push(l) });
  const text = out.join('\n');
  assert.equal(seen.made, 1, text);
  // The wait for the user's service manager asks for the made user's socket, never one of a user with no id.
  assert.ok(seen.bus.length > 0, text);
  assert.deepEqual([...new Set(seen.bus)], [`/run/user/${UID}/bus`], text);
  assert.equal(code, 0, text);
  assert.match(text, /^Done\. Hoprig runs as hoprig;/m);
  // Every run as the user: the made user, its home and the address of its service manager.
  assert.ok(seen.asUser.some((a) => a.what === 'hoprig service install'), JSON.stringify(seen.asUser));
  for (const a of seen.asUser) assert.deepEqual([a.name, a.xdg, a.bus, a.home], ['hoprig', `/run/user/${UID}`, `unix:path=/run/user/${UID}/bus`, madeHome], a.what);
  // Every owner given (the copy, the hand-over of the install, the catch-up, the gateway's data, the provider file,
  // the job's mirror): the made user's, and only in the made user's home.
  assert.ok(seen.chown.length > 0);
  for (const c of seen.chown) {
    assert.deepEqual([c.uid, c.gid], [UID, UID], c.p);
    assert.ok(c.p.startsWith(`${madeHome}/`), c.p);
  }
  // The catch-up's new file (root's side wrote it after the copy) is given to the made user, in both project names.
  const newName = path.join(madeHome, '.claude/projects', projectSlug(madeHome), 'two.jsonl');
  assert.equal(fs.readFileSync(newName, 'utf8'), '{"later":"line"}\n', text);
  assert.ok(seen.chown.some((c) => c.p === newName), 'the catch-up gave its file to the made user');
  // The gateway: root's stopped by its pid, its data copied into the made home, started and seen as the made user.
  assert.deepEqual(seen.killed, [4343]);
  const gwRuns = seen.asUser.map((a) => a.what).filter((w) => w.startsWith('hoprig addons '));
  assert.deepEqual(gwRuns, ['hoprig addons install', 'hoprig addons start'], 'the package is installed for the user, then started');
  assert.equal(fs.readFileSync(path.join(madeHome, gw.dataDir, 'accounts.json'), 'utf8'), '{"made":"up"}');
  assert.match(text, new RegExp(`${gw.title} runs as hoprig\\.`));
  assert.match(fs.readFileSync(path.join(madeHome, '.config/hoprig/profiles/alpha.env'), 'utf8'), new RegExp(`addons start ${gw.id}"`));
  assert.ok(seen.chown.some((c) => c.p === path.join(madeHome, '.config/hoprig/profiles/alpha.env')), 'the provider file is the made user\'s');
  // The job file's mirror: in the made user's state folder, the made user's, with the move's end in it.
  const mirror = path.join(userState, 'move-job.json');
  const j = JSON.parse(fs.readFileSync(mirror, 'utf8'));
  assert.deepEqual(j.result, { ok: true, code: 0 });
  // The mirror writes a file of its own beside it, gives it to the user and renames it over (movesafe.mjs replaceIn);
  // root's job file is never copied there (moveplan.mjs STATE_LEFT), so this is the mirror's own write.
  const mirrored = seen.chown.filter((c) => path.dirname(c.p) === userState && /^\.move-job\.json\.[0-9a-f]+\.tmp$/.test(path.basename(c.p)));
  assert.ok(mirrored.length > 0 && mirrored.every((c) => c.uid === UID), 'the mirror is the made user\'s');
  assert.ok(!seen.chown.some((c) => c.p === mirror), "root's job file was not copied into the made user's state");
  // Nothing was asked of a home that was only planned.
  assert.ok(!JSON.stringify(seen).includes('/home/hoprig'), 'the planned home is never used');
  assert.deepEqual(seen.unknown, []);
});

test('the system calls of a user the move only planned (no id, no home of its own yet) are refused, never made', async () => {
  const { realSwitchSys } = await import('../../src/setup/moveswitch.mjs');
  const { realGatewaySys } = await import('../../src/setup/movegatewaysys.mjs');
  const planned = { name: 'hoprig', uid: null, gid: null, home: '/home/hoprig' };
  assert.throws(() => realSwitchSys(planned, low), /hoprig has no ordinary user id yet/);
  assert.throws(() => realGatewaySys({ user: planned, oldHome: root, dirs }, low), /hoprig has no ordinary user id yet/);
  assert.deepEqual(seen.unknown, []);
});

test('--back where no user was made yet: one plain line, nothing asked of a user that is not there', async () => {
  const bare = path.join(s.tmp, 'bare-root');
  const d = { config: path.join(bare, '.config/hoprig'), state: path.join(bare, '.local/state/hoprig'), claude: path.join(bare, '.claude'), workspace: path.join(bare, 'Workspace') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  const asked = [];
  const out = [];
  const code = await M.main(['--back'], { io: { ...io, home: bare, dirs: d }, cfg: {}, low: { ...low, run: async (argv) => (asked.push(argv.join(' ')), { ok: false, code: 2, stdout: '', stderr: '' }) }, out: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(out, ["There is no user hoprig on this server yet, so there is nothing to go back from: root's dashboard is the one in use."]);
  assert.deepEqual(asked, []);
});
