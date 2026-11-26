// The look of `hoprig move-to-user` and its --dry-run (src/setup/moveplan.mjs, movecli.mjs). Root, the work user, its
// home's owner and the disk are played by readers the test hands in; every program the look asks (getent, tmux,
// loginctl) is a stand-in function that writes down its call. A dry run changes nothing: a whole-home snapshot of
// root's home and the user's home before and after is the same, and only reading programs were asked.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

// The move to a user of its own is Linux only: root, user ids, runuser and systemd, with POSIX paths.
const LINUX_ONLY = { skip: process.platform === 'win32' && 'the move to a user of its own is Linux only (root, chown by uid, POSIX paths)' };

const s = scratch();
test.after(s.cleanup);
const P = await import('../../src/setup/moveplan.mjs');
const M = await import('../../src/setup/movecli.mjs');

const root = path.join(s.tmp, 'root');
const userHome = path.join(s.tmp, 'users', 'hoprig');
const dirs = { config: path.join(root, '.config/hoprig'), state: path.join(root, '.local/state/hoprig'), claude: path.join(root, '.claude'), workspace: path.join(root, 'Workspace') };
const write = (f, t = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
// Root's installation: settings, state with what belongs to the running dashboard, the workspace, Claude Code's
// folder with a project's conversation, ssh with the login keys and the keys git uses.
write(path.join(dirs.config, 'config.json'), '{"server":{}}');
write(path.join(dirs.config, 'profiles/api.env'), 'ANTHROPIC_API_KEY=made-up\n');
write(path.join(dirs.state, 'server.json'), '{}');
write(path.join(dirs.state, 'dashboard.json'), '{}');
write(path.join(dirs.state, 'router.log'), 'log');
write(path.join(dirs.state, 'runs/old.json'), JSON.stringify({ tmuxSocket: path.join(s.tmp, 'tmux/tmux-0/default'), tmuxPane: '%3' }));
write(path.join(dirs.workspace, 'projects/shop/README.md'), 'shop');
fs.mkdirSync(path.join(dirs.workspace, 'projects/shop/.git'), { recursive: true });
write(path.join(dirs.claude, 'projects', `${root.replace(/[^A-Za-z0-9]/g, '-')}-Workspace-projects-shop`, 'a1.jsonl'), '{}\n');
write(path.join(root, '.ssh/authorized_keys'), 'ssh-ed25519 AAAA made-up');
write(path.join(root, '.ssh/id_ed25519'), 'made-up private');
write(path.join(root, '.ssh/known_hosts'), 'example.com ssh-ed25519 AAAA');
write(path.join(root, '.claude.json'), '{}');
fs.mkdirSync(userHome, { recursive: true });
// The mark Hoprig leaves in the home of a user it made: owned by root (played by the lstat below), its one line.
write(path.join(userHome, '.hoprig-made-by-move'), 'Hoprig work user hoprig\n');
write(path.join(s.tmp, 'tmux/tmux-0/default'), '');

const passwd = { hoprig: `hoprig:x:1001:1001:Hoprig work user:${userHome}:/bin/bash`, alex: `alex:x:1002:1002::${path.join(s.tmp, 'users', 'alex')}:/bin/bash`, svc: `svc:x:998:998::${userHome}:/usr/sbin/nologin` };

/** The readers of a server where root runs Hoprig; `over` changes one. `calls` gets every program asked. */
function io(over = {}, calls = []) {
  const realLstat = fs.lstatSync;
  const owners = { [userHome]: 1001, [path.join(userHome, '.hoprig-made-by-move')]: 0, [path.join(s.tmp, 'users', 'alex')]: 1002 };
  return {
    home: root,
    uid: 0,
    env: { TMUX_TMPDIR: path.join(s.tmp, 'tmux') },
    dirs,
    lstat: (p) => {
      const st = realLstat(p);
      return p in owners ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: owners[p] }) : st;
    },
    statfs: () => ({ bavail: 1e6, bsize: 4096 }),
    workRunning: async () => 0,
    hasBash: () => false,
    run: async (argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'getent') return passwd[argv[2]] ? { ok: true, code: 0, stdout: `${passwd[argv[2]]}\n`, stderr: '' } : { ok: false, code: 2, stdout: '', stderr: '' };
      // Root's tmux server: the session of Hoprig's terminal (its pane in a run record), and one of his own.
      if (argv[0] === 'tmux') return { ok: true, code: 0, stdout: '%3\tshop\n%7\tnotes\n', stderr: '' };
      if (argv[0] === 'loginctl') return { ok: true, code: 0, stdout: 'Linger=no\n', stderr: '' };
      return { ok: false, code: 97, stdout: '', stderr: 'not a reader' };
    },
    ...over,
  };
}

/** Every entry under `dir` with its mode and content's hash (a link: where it points). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (e.isSymbolicLink()) out[p] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) {
        out[`${p}/`] = `${st.mode} ${st.mtimeMs}`;
        walk(p);
      } else out[p] = `${st.mode} ${st.mtimeMs} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

test('the look names the user, what runs, what would be copied with counts and sizes, and the administrator steps', LINUX_ONLY, async () => {
  const plan = await P.movePlan({ io: io() });
  assert.equal(plan.ok, true, plan.stops.join('\n'));
  assert.equal(plan.user.name, 'hoprig');
  const ids = plan.parts.map((p) => p.id);
  for (const id of ['config', 'state', 'workspace', 'claude', '.claude.json', 'ssh']) assert.ok(ids.includes(id), id);
  const state = plan.parts.find((p) => p.id === 'state');
  assert.equal(state.entries, 2, "the state's own folder and server.json: runs, dashboard.json and router.log stay behind");
  assert.equal(plan.parts.find((p) => p.id === 'ssh').entries, 3, 'the folder, the key and known_hosts: never authorized_keys');
  assert.equal(plan.parts.find((p) => p.id === 'workspace').repos, 1);
  assert.equal(plan.parts.find((p) => p.id === 'workspace').to, path.join(userHome, 'Workspace'));
  assert.ok(plan.total.entries > 10 && plan.total.bytes > 0);
  assert.deepEqual(plan.running.terminals.map((t) => t.session), ['shop']);
  assert.deepEqual(plan.admin.map((a) => a.id), ['linger', 'owner', 'stop-root', 'install', 'service', 'disable-root']);
  assert.deepEqual(plan.admin[0].argv, ['loginctl', 'enable-linger', 'hoprig']);
  const lines = P.planLines(plan).join('\n');
  assert.match(lines, /terminals of root: shop \(ended after the switch, each by its own socket and session\)/);
  assert.match(lines, /loginctl enable-linger hoprig/);
  assert.match(lines, /runuser -u hoprig -- env .*XDG_RUNTIME_DIR=\/run\/user\/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1001\/bus/);
  assert.doesNotMatch(lines, /made-up private|ANTHROPIC_API_KEY/, 'no content of a file is said');
});

test('--dry-run: a whole-home snapshot of root and the user is the same afterwards, and only readers were asked', LINUX_ONLY, async () => {
  const before = snapshot(s.tmp);
  const calls = [];
  const out = [];
  const code = await M.main(['--dry-run'], { io: io({}, calls), cfg: {}, out: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 0, out.join('\n'));
  assert.match(out.join('\n'), /A dry run: nothing was copied or changed\./);
  assert.deepEqual(snapshot(s.tmp), before);
  assert.ok(calls.length > 0);
  for (const c of calls) assert.match(c, /^(getent passwd |tmux -S \S+ list-panes -a |loginctl show-user |ss -ltnpH$)/, c);
  // The page's view holds no function and no file's content.
  const view = M.planView(await P.movePlan({ io: io() }));
  assert.doesNotMatch(JSON.stringify(view), /made-up private|ANTHROPIC_API_KEY/);
});

test('no user Hoprig made: the look says the user hoprig is made by the move, with the steps that make it; nothing is made', async () => {
  const calls = [];
  const none = io({ run: async (argv) => (calls.push(argv.join(' ')), { ok: false, code: 2, stdout: '', stderr: '' }) });
  const plan = await P.movePlan({ io: none });
  assert.equal(plan.make, true);
  assert.deepEqual(plan.user, { name: 'hoprig', uid: null, gid: null, home: '/home/hoprig' });
  const text = P.planLines(plan).join('\n');
  assert.match(text, /^Hoprig would move from root to a new user hoprig, made by the move \(home \/home\/hoprig\)\.$/m);
  assert.match(text, /make the user hoprig with no password .*: useradd --create-home --comment 'Hoprig work user' hoprig/);
  assert.match(text, /sudo without a password, in one file checked by visudo first: install -m 0440 -o root -g root '<the checked line>' \/etc\/sudoers\.d\/90-hoprig-hoprig/);
  assert.match(text, /XDG_RUNTIME_DIR=\/run\/user\/'?<its user id>'?/, 'a user not made yet: no made-up user id');
  assert.match(text, /loginctl enable-linger hoprig/);
  assert.doesNotMatch(text, /not built/);
  for (const c of calls) assert.match(c, /^(getent passwd |tmux -S \S+ list-panes -a |loginctl show-user |ss -ltnpH$)/, `only looked: ${c}`);
});

test('a user made by the move gets bash where /bin/bash is there, shown as its exact command; a user that exists is not changed', LINUX_ONLY, async () => {
  const none = io({ run: async () => ({ ok: false, code: 2, stdout: '', stderr: '' }), hasBash: () => true });
  const text = P.planLines(await P.movePlan({ io: none })).join('\n');
  assert.match(text, /make the user hoprig with no password, bash as its shell \(the usual command line, with history and arrow keys\) .*: useradd --create-home --comment 'Hoprig work user' --shell \/bin\/bash hoprig$/m);
  // The user Hoprig made is there: no step changes it, also with bash there.
  const kept = await P.movePlan({ io: io({ hasBash: () => true }) });
  assert.equal(kept.make, false);
  assert.doesNotMatch(P.planLines(kept).join('\n'), /--shell|usermod|chsh|bash as its shell/);
});

test('a user named hoprig without a mark is not taken; --user takes an ordinary user that exists, and refuses the rest', LINUX_ONLY, async () => {
  const unmarked = { ...passwd, hoprig: `hoprig:x:1001:1001::${userHome}:/bin/bash` };
  const base = io();
  const run = async (argv) => (argv[0] === 'getent' ? (unmarked[argv[2]] ? { ok: true, stdout: `${unmarked[argv[2]]}\n` } : { ok: false, stdout: '' }) : base.run(argv));
  // Said as what it is, with a free name and his word for that user.
  const noMark = (p) => {
    if (p.endsWith('/.hoprig-made-by-move')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return base.lstat(p);
  };
  assert.deepEqual((await P.movePlan({ io: io({ run, lstat: noMark }) })).stops, [P.NAME_TAKEN('hoprig', 'hoprig2')]);
  assert.match(P.NAME_TAKEN('hoprig', 'hoprig2'), /Hoprig did not make it.*hoprig move-to-user --user hoprig2\. To move to hoprig all the same: hoprig move-to-user --user hoprig$/);
  // --user of a name nobody has: that user is made by the move.
  assert.equal((await P.movePlan({ userName: 'alex2', io: io() })).make, true);
  fs.mkdirSync(path.join(s.tmp, 'users', 'alex'), { recursive: true });
  const alex = await P.movePlan({ userName: 'alex', io: io() });
  assert.equal(alex.user?.name, 'alex', alex.stops.join('\n'));
  assert.match((await P.movePlan({ userName: 'svc', io: io() })).stops[0], /user id 998/);
  assert.match((await P.movePlan({ userName: 'Bad Name', io: io() })).stops[0], /is not a user name/);
});

test('--new (the hub confirmed a new user): a user of that name that Hoprig did not make is refused; one it made, or none, goes on', LINUX_ONLY, async () => {
  const unmarked = { ...passwd, hoprig: `hoprig:x:1001:1001::${userHome}:/bin/bash` };
  const base = io();
  const run = async (argv) => (argv[0] === 'getent' ? (unmarked[argv[2]] ? { ok: true, stdout: `${unmarked[argv[2]]}\n` } : { ok: false, stdout: '' }) : base.run(argv));
  const noMark = (p) => {
    if (p.endsWith('/.hoprig-made-by-move')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return base.lstat(p);
  };
  const foreign = await P.movePlan({ userName: 'hoprig', fresh: true, io: io({ run, lstat: noMark }) });
  assert.deepEqual([foreign.ok, foreign.user, foreign.make], [false, null, undefined], 'refused, never moved into');
  assert.deepEqual(foreign.stops, [P.NOT_NEW('hoprig')]);
  assert.match(P.NOT_NEW('hoprig'), /Hoprig did not make it.*nothing was made or copied\..*To move to hoprig all the same: hoprig move-to-user --user hoprig$/);
  // Without --new, his word --user hoprig still moves into that user (as before).
  assert.equal((await P.movePlan({ userName: 'hoprig', io: io({ run, lstat: noMark }) })).user?.name, 'hoprig');
  // The user Hoprig made (the mark of root's): taken.
  const made = await P.movePlan({ userName: 'hoprig', fresh: true, io: io() });
  assert.equal(made.user?.name, 'hoprig', made.stops.join('\n'));
  // No user of that name: made by the move.
  assert.equal((await P.movePlan({ userName: 'alex3', fresh: true, io: io() })).make, true);
  // The command line's flag.
  assert.equal(M.parseMoveArgs(['--yes', '--user', 'hoprig', '--new']).fresh, true);
  assert.equal(M.parseMoveArgs(['--yes']).fresh, undefined);
});

test("root's own tmux sessions are not ended: only the sessions of Hoprig's runs, never the one the move runs in", LINUX_ONLY, async () => {
  const sock = path.join(s.tmp, 'tmux/tmux-0/default');
  // On his normal tmux server: shop (Hoprig's, a run names its pane) is listed; notes (his own) is not.
  assert.deepEqual((await P.movePlan({ io: io() })).running.terminals, [{ socket: sock, session: 'shop' }]);
  // The move typed in the session shop itself: that session is left, or the move would end itself.
  const inside = io({ env: { TMUX_TMPDIR: path.join(s.tmp, 'tmux'), TMUX: `${sock},123,0`, TMUX_PANE: '%3' } });
  assert.deepEqual((await P.movePlan({ io: inside })).running.terminals, []);
  // The dashboard's own socket (server.tmuxSocket): every session there is the dashboard's, still never the move's.
  write(path.join(s.tmp, 'tmux/tmux-0/hoprig'), '');
  const ownSock = path.join(s.tmp, 'tmux/tmux-0/hoprig');
  const own = await P.movePlan({ io: io({ env: { TMUX_TMPDIR: path.join(s.tmp, 'tmux'), TMUX: `${ownSock},1,0`, TMUX_PANE: '%7' } }), cfg: { server: { tmuxSocket: 'hoprig' } } });
  assert.deepEqual(own.running.terminals, [{ socket: ownSock, session: 'shop' }]);
});

test('every step that runs as administrator shows its exact command, in plain words, with singular and plural right', () => {
  const user = { name: 'hoprig', uid: 1001, home: '/home/hoprig' };
  for (const make of [true, false]) {
    const steps = P.adminSteps(user, 'no', { make });
    for (const st of steps) {
      assert.ok(Array.isArray(st.argv) && st.argv.length > 0, `${make ? 'make' : 'move'}: ${st.id} has a command`);
      assert.doesNotMatch(st.why, /service manager's address|installer of this Hoprig|--no-admin/, st.why);
    }
  }
  const lines = P.planLines({ user, make: false, again: null, running: { working: [], idle: [], terminals: [], work: 0, assistant: 0 }, parts: [{ what: "Hoprig's settings", from: '/root/.config/hoprig', to: '/home/hoprig/.config/hoprig', entries: 1, bytes: 10 }], total: { entries: 1, bytes: 10 }, free: 1e9, admin: [], stops: [] }).join('\n');
  assert.match(lines, /, 1 entry, 10 B/);
  assert.doesNotMatch(lines, /1 entries/);
});

test('a session that works stops the move before anything is copied; idle terminals do not', LINUX_ONLY, async () => {
  write(path.join(dirs.state, 'runs/live.json'), JSON.stringify({ pid: process.pid, cwd: '/x/shop', status: 'working' }));
  try {
    const plan = await P.movePlan({ io: io() });
    assert.equal(plan.ok, false);
    assert.match(plan.stops.join('\n'), /a session is working now \(shop \(working\)\): end it first/);
    const out = [];
    assert.equal(await M.main(['--dry-run'], { io: io(), cfg: {}, out: (l) => out.push(l), err: (l) => out.push(l) }), 1);
    assert.match(out.join('\n'), /^STOP: a session is working now/m);
  } finally {
    fs.rmSync(path.join(dirs.state, 'runs/live.json'));
  }
  assert.equal((await P.movePlan({ io: io({ workRunning: async () => 1 }) })).stops[0], 'Work is running 1 task: end it first');
});

test('a disk that is too small (the size and a tenth more) stops the move with one line', LINUX_ONLY, async () => {
  const plan = await P.movePlan({ io: io({ statfs: () => ({ bavail: 1, bsize: 1 }) }) });
  assert.equal(plan.ok, false);
  assert.equal(plan.stops.length, 1);
  assert.match(plan.stops[0], /disk has 1 B free, and the copy needs .* \(its size and a tenth more\): make room first/);
  assert.ok(plan.need >= Math.ceil(plan.total.bytes * 1.1));
});

test('not root: nothing to move', async () => {
  assert.deepEqual((await P.movePlan({ io: io({ uid: 1000 }) })).stops, [P.NOT_ROOT]);
});

test("root's own move job and the lock's files stay in root's state: the copy never carries a move that runs", LINUX_ONLY, () => {
  const state = P.moveParts(root, userHome, dirs).parts.find((p) => p.id === 'state');
  // The page's job file (root's move, running, with root's pid), its half-written file, the lock and a temporary lock
  // file a crash left: none of them is copied.
  for (const rel of ['move-job.json', 'move-job.json.4242.tmp', 'move.lock', '.move.lock.4242.deadbeef']) assert.equal(state.keep(rel), false, rel);
  // What the user's dashboard needs is copied, also a file whose name only begins like one of them.
  for (const rel of ['server.json', 'move-job.json.d/x', 'jobs/move-job.json', 'jobs/.move.lock.1.ab']) assert.equal(state.keep(rel), true, rel);
});
