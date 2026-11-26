// The move as it met a real server (src/setup/moverun.mjs, moveplan.mjs, movemark.mjs, movemake.mjs, moveswitch.mjs):
// with no user Hoprig made it makes one first, through the installer; the install for the user takes the same build
// root runs and leaves the dashboard alone; a stop names the line that says what failed and where the whole output is;
// a second run goes on from the move's own copy and never writes over what the move did not make. Every program is a
// stand-in function that writes down what it was asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

// The move to a user of its own is Linux only: root, user ids, runuser and systemd, with POSIX paths.
const LINUX_ONLY = { skip: process.platform === 'win32' && 'the move to a user of its own is Linux only (root, chown by uid, POSIX paths)' };

const s = scratch();
test.after(s.cleanup);
const P = await import('../../src/setup/moveplan.mjs');
const R = await import('../../src/setup/moverun.mjs');
const MK = await import('../../src/setup/movemark.mjs');
const MM = await import('../../src/setup/movemake.mjs');
const SW = await import('../../src/setup/moveswitch.mjs');
const { appRoot } = await import('../../src/setup/checks.mjs');

const root = path.join(s.tmp, 'root');
const home = path.join(s.tmp, 'users', 'hoprig');
const dirs = { config: path.join(root, '.config/hoprig'), state: path.join(root, '.local/state/hoprig'), claude: path.join(root, '.claude'), workspace: path.join(root, 'Workspace') };
const write = (f, t = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
write(path.join(dirs.config, 'config.json'), '{}');
write(path.join(dirs.state, 'server.json'), '{}');
write(path.join(dirs.workspace, 'projects/shop/README.md'), 'shop');
fs.mkdirSync(home, { recursive: true });
const MARK = path.join(home, '.hoprig-made-by-move');
fs.writeFileSync(MARK, 'Hoprig work user hoprig\n');

const realLstat = fs.lstatSync;
const io = (over = {}) => ({
  home: root, uid: 0, env: { TMUX_TMPDIR: path.join(s.tmp, 'tmux') }, dirs, statfs: () => ({ bavail: 1e7, bsize: 4096 }), workRunning: async () => 0,
  // The user's home is the user's; the mark Hoprig left in it is root's (a test cannot make a file of another owner).
  lstat: (p) => (p === home || p === MARK ? Object.assign(Object.create(Object.getPrototypeOf(realLstat(p))), realLstat(p), { uid: p === home ? 1001 : 0 }) : realLstat(p)),
  run: async (argv) => (argv[0] === 'getent' && argv[2] === 'hoprig' ? { ok: true, stdout: `hoprig:x:1001:1001:Hoprig work user:${home}:/bin/bash\n` } : argv[0] === 'loginctl' ? { ok: true, stdout: 'Linger=yes\n' } : { ok: false, code: 2, stdout: '', stderr: '' }),
  ...over,
});

test('a stop names the line that says what failed, never an advice that came last, and where the whole output is', LINUX_ONLY, async () => {
  const out = 'hoprig setup 0.0.0\n  ✓ Node.js v24\n  ! Dashboard restarted, but set-up cannot read where it listens\n  hoprig is not ready: set-up cannot read where the dashboard running now listens\n  · Sign in to Claude Code: run claude, then type /login\n';
  assert.equal(SW.failedLine(out), 'hoprig is not ready: set-up cannot read where the dashboard running now listens');
  assert.equal(SW.failedLine('x\nhoprig installer: npm could not reach the network\n· advice\n'), 'hoprig installer: npm could not reach the network');
  assert.equal(SW.failedLine('  ✗ Claude Code did not install\n  · Sign in later\n'), '✗ Claude Code did not install');
  const said = [];
  const plan = { user: { name: 'hoprig', uid: 1001, home }, oldHome: root, dirs, admin: [], parts: [] };
  const sys = { hasRunuser: () => true, waitBus: async () => true, installUser: async () => ({ ok: false, code: 1, stdout: out, stderr: '' }) };
  const r = await SW.switchToUser(plan, { sys, say: (l) => said.push(l) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.did, ['install']);
  const stop = said.find((l) => l.startsWith('STOPPED'));
  assert.equal(stop, `STOPPED at "install for the user": hoprig is not ready: set-up cannot read where the dashboard running now listens (the whole output: ${path.join(dirs.state, 'move-install.log')})`);
  assert.match(said.join('\n'), /Root's dashboard was not stopped: it runs as before\./);
});

// The user is the runner's own id, so the hand-over's chown works without root; as uid 0 that user would be root.
test('the install for the user: the same build root runs, packed from this Hoprig, with --no-dashboard; its output kept', { skip: LINUX_ONLY.skip || (process.getuid() === 0 && 'the runner is uid 0: the user would be root') }, async () => {
  const user = { name: 'hoprig', uid: process.getuid(), gid: process.getgid(), home: path.join(s.tmp, 'own-home') };
  fs.mkdirSync(user.home, { recursive: true });
  const asked = [];
  const run = async (argv, o = {}) => {
    asked.push({ argv, env: o.env });
    if (argv[0] === 'tar') fs.writeFileSync(argv[2], 'packed');
    return argv[0] === 'tar' ? { ok: true, stdout: '' } : { ok: true, stdout: 'hoprig is ready.\n', stderr: '' };
  };
  const sys = SW.realSwitchSys(user, { run, env: { HOPRIG_SOURCE: 'https://example.com/newest.tgz' } });
  const logDir = path.join(s.tmp, 'rootstate');
  fs.mkdirSync(logDir);
  const r = await sys.installUser({ logDir });
  assert.equal(r.ok, true);
  const tar = asked.find((a) => a.argv[0] === 'tar').argv;
  assert.deepEqual(tar.slice(3), ['-C', path.dirname(appRoot()), '--exclude=node_modules', '--exclude=.git', path.basename(appRoot())]);
  const inst = asked.find((a) => a.argv[0] === 'runuser').argv;
  const tgz = path.join(user.home, '.cache/hoprig-move/hoprig.tgz');
  assert.deepEqual(inst.slice(-5), ['env', `HOPRIG_SOURCE=${tgz}`, 'sh', path.join(user.home, '.cache/hoprig-move/install.sh'), '--yes', '--no-dashboard'].slice(-5));
  assert.ok(inst.includes(`HOPRIG_SOURCE=${tgz}`) && inst.includes('--no-dashboard'), inst.join(' '));
  assert.ok(!inst.join(' ').includes('example.com'), 'never the newest from the network');
  assert.equal(fs.readFileSync(path.join(logDir, 'move-install.log'), 'utf8'), 'hoprig is ready.\n');
  assert.equal(fs.existsSync(path.join(user.home, '.cache/hoprig-move')), false, 'the hand-over folder is taken away');
});

test('no user Hoprig made: the move makes it first through the installer (--user-only), then copies to its real home', LINUX_ONLY, async () => {
  const calls = [];
  const madeHome = path.join(s.tmp, 'made', 'hoprig');
  const plan = await P.movePlan({ io: io({ run: async (argv) => (calls.push(argv.join(' ')), { ok: false, code: 2, stdout: '' }) }) });
  assert.equal(plan.make, true, plan.stops.join('\n'));
  const said = [];
  let copiedTo = null;
  const steps = {
    reach: async () => ({ ok: true, unreached: [] }),
    makeUser: async (p) => (calls.push(`make ${p.user.name}`), { ok: true, user: { name: 'hoprig', uid: 1500, gid: 1500, home: madeHome } }),
    mark: (m) => calls.push(`mark ${m.state} madeUser=${m.madeUser}`),
    copy: async (p) => ((copiedTo = p.parts.map((x) => x.to)), calls.push('copy'), { ok: false, error: 'made up', made: copiedTo }),
  };
  const r = await R.runMove(plan, { say: (l) => said.push(l), steps });
  assert.deepEqual(r, { ok: false, step: 'copy' });
  // Made, marked, copied, then marked again with the end of the move's own writes (madeUntil).
  assert.deepEqual(calls.slice(-4), ['make hoprig', 'mark copying madeUser=true', 'copy', 'mark copying madeUser=true']);
  assert.ok(copiedTo.every((t) => t.startsWith(`${madeHome}/`)), copiedTo.join('\n'));
  const text = said.join('\n');
  assert.match(text, /To go on: hoprig move-to-user --yes --user hoprig \(it takes this copy away first and copies again; a part changed since is set aside beside it, never deleted\)/);
  assert.match(text, /To take it all away: rm -f \/etc\/sudoers\.d\/90-hoprig-hoprig && loginctl disable-linger hoprig && userdel --remove hoprig/);
  // The making fails: nothing copied, the installer's own line said.
  calls.length = 0;
  const no = await R.runMove(plan, { say: (l) => said.push(l), steps: { ...steps, makeUser: async () => ({ ok: false, why: 'a user named hoprig is already on this computer and Hoprig did not make it' }) } });
  assert.deepEqual(no, { ok: false, step: 'user' });
  assert.deepEqual(calls, []);
});

test('the making goes through the installer shipped with this Hoprig, and a failure names the installer\'s own line', async () => {
  const c = MM.makeUserCommand('hoprig', { noAdmin: true, env: { HOPRIG_YES: '1', PATH: '/x' } }); // seal: a value no program is started with
  assert.deepEqual(c.argv, ['sh', path.join(appRoot(), 'install.sh'), '--yes', '--user-only', '--user', 'hoprig', '--no-admin']);
  assert.equal('HOPRIG_YES' in c.env, false);
  const said = [];
  const r = await MM.makeWorkUser({ user: { name: 'hoprig' } }, { say: (l) => said.push(l), run: async () => ({ ok: false, code: 1, stdout: 'To set Hoprig up…\n', stderr: 'hoprig installer: lingering could not be turned on for hoprig\nWhat this run made…\n' }) });
  assert.deepEqual(r, { ok: false, why: 'lingering could not be turned on for hoprig' });
  assert.ok(said.includes('What this run made…'), 'every line of the installer is said');
  const made = { name: 'hoprig', uid: 1500, gid: 1500, comment: 'Hoprig work user', home: '/home/hoprig/' };
  const ok = await MM.makeWorkUser({ user: { name: 'hoprig' } }, { run: async () => ({ ok: true, stdout: '' }), look: async () => made, marked: (u) => u === made });
  // The comment field alone is not the mark (anyone may change it with chfn): without the file of root's, refused.
  const noMark = await MM.makeWorkUser({ user: { name: 'hoprig' } }, { run: async () => ({ ok: true, stdout: '' }), look: async () => made, marked: () => false });
  assert.equal(noMark.ok, false);
  assert.deepEqual(ok, { ok: true, user: { name: 'hoprig', uid: 1500, gid: 1500, home: '/home/hoprig' } });
});

test('a second run finds the move\'s own copy by its mark and goes on; a folder the move did not make still stops it', LINUX_ONLY, async () => {
  const own = path.join(home, '.config/hoprig');
  write(path.join(own, 'config.json'), '{"half":true}');
  // No mark: what lies there is someone's, and it stops the move.
  assert.match((await P.movePlan({ io: io() })).stops.join('\n'), /\.config\/hoprig is already in hoprig's home: the move does not write over it/);
  // The move's own mark of a copy it began and never switched to.
  MK.writeMark(dirs.state, { user: 'hoprig', home, parts: [own, path.join(home, 'Workspace')], at: '2026-11-20T10:00:00.000Z', madeUntil: new Date(Date.now() + 60_000).toISOString(), state: 'copying' });
  const plan = await P.movePlan({ io: io() });
  assert.equal(plan.ok, true, plan.stops.join('\n'));
  assert.match(P.planLines(plan).join('\n'), /An earlier move to hoprig began a copy on 2026-11-20T10:00Z and did not switch: that copy is taken away and made again\./);
  assert.equal(P.moveParts(root, home, dirs).parts.find((p) => p.id === 'state').keep('move-copy.json'), false, 'the mark is root\'s, never copied');
  // A switched copy: the look says what clearOwnCopy does with it (set aside, made again), not that it is kept as it is.
  assert.match(P.planLines({ ...plan, again: { ...plan.again, switchedAt: '2026-11-20T11:00:00.000Z' } }).join('\n'), /switched on 2026-11-20T11:00Z: its copy is set aside beside it \(never deleted\) and made again from root's\./);
  // Cleared: only the mark's parts, through real folders.
  const gone = [];
  const c = MK.clearOwnCopy(plan, plan.again, { rm: (p) => gone.push(p) });
  assert.deepEqual(c.gone, [own]);
  assert.deepEqual(gone, [own]);
  // A copy the user's dashboard ran on is set aside, never deleted.
  const moved = [];
  const aside = MK.clearOwnCopy(plan, { ...plan.again, switchedAt: '2026-11-20T11:00:00.000Z' }, { rm: () => assert.fail('never deleted'), rename: (a, b) => moved.push([a, b]), now: () => new Date('2026-11-20T12:00:00Z') });
  assert.deepEqual(moved, [[own, `${own}.before-20261120T120000`]]);
  assert.deepEqual(aside.gone, []);
  // A link in the way (the user could have put one there): left alone.
  const linkHome = path.join(s.tmp, 'linkhome');
  fs.mkdirSync(path.join(s.tmp, 'elsewhere', 'hoprig'), { recursive: true });
  fs.mkdirSync(linkHome);
  fs.symlinkSync(path.join(s.tmp, 'elsewhere'), path.join(linkHome, '.config'));
  const lp = { user: { name: 'hoprig', home: linkHome }, parts: [{ id: 'config', to: path.join(linkHome, '.config/hoprig') }] };
  assert.deepEqual(MK.clearOwnCopy(lp, { parts: [path.join(linkHome, '.config/hoprig')] }, { rm: () => assert.fail('not through a link') }).gone, []);
  // The run says it in one line, then copies.
  const said = [];
  const r = await R.runMove(plan, { say: (l) => said.push(l), steps: { reach: async () => ({ ok: true, unreached: [] }), clearOwn: () => ({ gone: [own], aside: [] }), mark: () => {}, copy: async () => ({ ok: false, error: 'made up', made: [] }) } });
  assert.equal(r.step, 'copy');
  assert.match(said.join('\n'), /An earlier move began a copy here and did not switch: it was taken away first \(1 folder, unchanged since that move made them\), and the copy is made again\./);
  fs.rmSync(path.join(dirs.state, MK.MARK_FILE));
  fs.rmSync(own, { recursive: true });
});

test('a move that switched (or was switching) stops a second look: nothing is cleared, renamed or copied until --back', LINUX_ONLY, async () => {
  const own = path.join(home, '.config/hoprig');
  write(path.join(own, 'config.json'), '{"live":true}');
  for (const state of ['switching', 'switched']) {
    MK.writeMark(dirs.state, { user: 'hoprig', home, parts: [own], at: '2026-11-20T10:00:00.000Z', switchingAt: '2026-11-20T10:05:00.000Z', ...(state === 'switched' ? { switchedAt: '2026-11-20T10:06:00.000Z' } : {}), state });
    const plan = await P.movePlan({ io: io() });
    assert.equal(plan.ok, false, state);
    assert.match(plan.stops.join('\n'), /Hoprig runs as hoprig since 2026-11-20T10:0\dZ, on the move's copy in .*: nothing is copied over it\. To go back to root's dashboard first: hoprig move-to-user --back/, state);
  }
  // The step back writes "back" into the mark: the look goes on again, and sets the used copy aside (never deleted).
  const marks = [];
  const back = await R.runBack(await P.movePlan({ io: io() }), { steps: { switchSys: () => ({ stopUserService: async () => ({ ok: true }), startRoot: async () => ({ ok: true }), portFree: async () => true, listenerUid: async () => 0, sleep: async () => {} }), mark: (m) => marks.push(m) } });
  assert.equal(back.ok, true);
  assert.equal(marks.at(-1).state, 'back');
  MK.writeMark(dirs.state, marks.at(-1));
  const after = await P.movePlan({ io: io() });
  assert.equal(after.ok, true, after.stops.join('\n'));
  const moved = [];
  MK.clearOwnCopy(after, after.again, { rm: () => assert.fail('a copy the user ran on is never deleted'), rename: (a, b) => moved.push(a) });
  assert.deepEqual(moved, [own]);
  // The user's own dashboard on the port, whatever the mark says (or with none): the look stops.
  fs.rmSync(path.join(dirs.state, MK.MARK_FILE));
  const ss = io({
    run: async (argv) => (argv[0] === 'ss' ? { ok: true, stdout: 'LISTEN 0 511 127.0.0.1:7433 0.0.0.0:* users:(("node",pid=4321,fd=20))\n' } : io().run(argv)),
    readFile: (f, e) => (f === '/proc/4321/status' ? 'Name:\tnode\nUid:\t1001\t1001\t1001\t1001\n' : fs.readFileSync(f, e)),
  });
  const busy = await P.movePlan({ io: ss });
  assert.match(busy.stops.join('\n'), /hoprig's own dashboard answers on port 7433: Hoprig runs as hoprig already\. To go back to root's first: hoprig move-to-user --back/);
  fs.rmSync(own, { recursive: true });
});

test('a part of a stopped copy that changed after the move made it is set aside, never deleted; an unchanged one is taken away', LINUX_ONLY, async () => {
  const base = path.join(s.tmp, 'changed');
  const a = path.join(base, 'Workspace');
  const b = path.join(base, '.config', 'hoprig');
  write(path.join(a, 'projects/shop/README.md'), 'copied');
  write(path.join(b, 'config.json'), '{}');
  const plan = { user: { name: 'hoprig', home: base }, parts: [{ id: 'workspace', to: a }, { id: 'config', to: b }] };
  const madeUntil = new Date(Date.now() + 1000).toISOString();
  // Nothing changed after the move's own writes ended: taken away.
  const gone = [];
  const r = MK.clearOwnCopy(plan, { parts: [a, b], madeUntil }, { rm: (p) => gone.push(p) });
  assert.deepEqual(gone, [a, b]);
  assert.deepEqual(r.aside, []);
  // Work done in the copy after the stop (a new file deep down): that part is set aside; the other is taken away.
  await new Promise((res) => setTimeout(res, 1100));
  write(path.join(a, 'projects/shop/notes.md'), 'his own work after the stop');
  const gone2 = [];
  const moved = [];
  const r2 = MK.clearOwnCopy(plan, { parts: [a, b], madeUntil }, { rm: (p) => gone2.push(p), rename: (x, y) => moved.push([x, y]), now: () => new Date('2026-11-20T12:00:00Z') });
  assert.deepEqual(gone2, [b]);
  assert.deepEqual(moved, [[a, `${a}.before-20261120T120000`]]);
  assert.deepEqual(r2.aside, [[a, `${a}.before-20261120T120000`, 'changed']]);
  // A mark that does not say when the move's writes ended (an older one): nothing is deleted.
  const r3 = MK.clearOwnCopy(plan, { parts: [a, b] }, { rm: () => assert.fail('no end known: kept'), rename: () => {} });
  assert.equal(r3.aside.length, 2);
});

test('the run marks "switching" before root\'s dashboard stops, and "back" when the switch failed after it', LINUX_ONLY, async () => {
  const marks = [];
  const plan = await P.movePlan({ io: io() });
  assert.equal(plan.ok, true, plan.stops.join('\n'));
  const order = [];
  const ok = { ok: true, stdout: '', stderr: '' };
  const userKey = (await import('../../src/server/dashboardfile.mjs')).stateKey(path.join(home, '.local/state/hoprig'));
  const sys = {
    hasRunuser: () => true, linger: async () => ok, waitBus: async () => true, installUser: async () => ok, freePort: async () => 8441,
    startTrial: async () => ({ stop: async () => {} }), facts: async (p) => (p === 8441 ? { state: userKey } : null),
    stopRoot: async () => (order.push(`stop-root after ${marks.at(-1).state}`), ok), startRoot: async () => ok, disableRoot: async () => ok,
    installUserService: async () => ({ ok: false, stderr: 'no service here (made up)' }), stopUserService: async () => ok,
    listenerUid: async () => null, portFree: async () => true, writeFile: () => {}, sleep: async () => {},
  };
  const steps = {
    reach: async () => ({ ok: true, unreached: [] }),
    mark: (m) => marks.push(m), clearOwn: () => ({ gone: [], aside: [] }),
    copy: async () => ({ ok: true, made: [], placed: [] }), check: async () => ({ ok: true, repos: 0, hashes: { same: 0, total: 0 }, owners: 0, problems: [] }),
    switchSys: () => sys,
  };
  const r = await R.runMove(plan, { steps });
  assert.equal(r.ok, false);
  assert.deepEqual(order, ['stop-root after switching']);
  assert.deepEqual(marks.map((m) => m.state), ['copying', 'copying', 'checked', 'switching', 'back']);
  assert.ok(marks.at(-1).switchingAt && marks.at(-1).backAt);
});

test('a used copy set aside by this run, or an earlier one, is never offered for removal by a later stop', async () => {
  // The move again after --back: the copy the user's dashboard ran on is set aside, then the new copy fails.
  const plan = {
    user: { name: 'hoprig', uid: 1234, gid: 1234, home: '/srv/hoprig' }, make: false, dirs, total: { entries: 1, bytes: 1 },
    again: { user: 'hoprig', home: '/srv/hoprig', parts: ['/srv/hoprig/Workspace'], madeUser: true, state: 'back', switchedAt: '2026-11-01T00:10:00Z', kept: [] },
    parts: [{ id: 'workspace', to: '/srv/hoprig/Workspace' }, { id: 'ssh', to: '/srv/hoprig/.ssh' }],
  };
  const aside = '/srv/hoprig/Workspace.before-20261121T000000';
  const marks = [];
  const said = [];
  // This run's copy made Workspace again (after the used one was set aside): that, and only that, may be taken away.
  const steps = { reach: async () => ({ ok: true, unreached: [] }), clearOwn: () => ({ gone: [], aside: [['/srv/hoprig/Workspace', aside, 'switched']] }), mark: (m) => marks.push(m), copy: async () => ({ ok: false, error: 'made up', made: ['/srv/hoprig/Workspace'] }) };
  assert.deepEqual(await R.runMove(plan, { say: (l) => said.push(l), steps }), { ok: false, step: 'copy' });
  const text = said.join('\n');
  assert.doesNotMatch(text, /userdel|none of it in use/, text);
  assert.match(text, /Kept as they were, never taken away: \/srv\/hoprig\/Workspace\.before-20261121T000000\./);
  assert.match(text, /To take the copy away: rm -r \/srv\/hoprig\/Workspace$/m);
  // The mark keeps it, so the next run's stop says the same.
  assert.deepEqual(marks.at(-1).kept, [aside]);
  write(path.join(dirs.state, MK.MARK_FILE), JSON.stringify(marks.at(-1)));
  assert.deepEqual(MK.readMark(dirs.state).kept, [aside]);
  fs.rmSync(path.join(dirs.state, MK.MARK_FILE));
  const next = [];
  await R.runMove({ ...plan, again: { ...marks.at(-1), state: 'copying' } }, { say: (l) => next.push(l), steps: { ...steps, clearOwn: () => ({ gone: ['/srv/hoprig/Workspace'], aside: [] }) } });
  assert.doesNotMatch(next.join('\n'), /userdel/, next.join('\n'));
  assert.deepEqual(MK.leftLines(plan, { kept: [aside] }).filter((l) => /userdel/.test(l)), []);
});

test('a stop says what it leaves behind, the one command that goes on and the one that takes it away', () => {
  const plan = { user: { name: 'alex', home: '/home/alex' }, parts: [{ id: 'config', to: '/home/alex/.config/hoprig' }, { id: 'ssh', to: '/home/alex/.ssh' }, { id: 'workspace', to: '/home/alex/Workspace' }] };
  assert.deepEqual(MK.leftLines(plan, { did: ['linger', 'install'], made: ['/home/alex/.config', '/home/alex/.config/hoprig', '/home/alex/.ssh', '/home/alex/Workspace'] }), [
    "Left behind, none of it in use: the copy in /home/alex, Hoprig installed for alex, lingering for alex. Root's installation works as before.",
    'To go on: hoprig move-to-user --yes --user alex (it takes this copy away first and copies again; a part changed since is set aside beside it, never deleted)',
    'To take the copy away: rm -r /home/alex/.config/hoprig /home/alex/Workspace',
  ]);
});

test('move-to-user --no-admin: the user is made without administrator rights; the look and its JSON say a user is made', LINUX_ONLY, async () => {
  const CLI = await import('../../src/setup/movecli.mjs');
  assert.equal(CLI.parseMoveArgs(['--no-admin']).noAdmin, true);
  assert.match(CLI.MOVE_USAGE, /--no-admin/);
  const seen = [];
  const out = [];
  const none = io({ run: async () => ({ ok: false, code: 2, stdout: '' }) });
  const steps = { reach: async () => ({ ok: true, unreached: [] }), makeUser: async (p, o) => (seen.push(o.noAdmin), { ok: false, why: 'made up' }) };
  assert.equal(await CLI.main(['--yes', '--no-admin'], { io: none, cfg: {}, steps, out: (l) => out.push(l), err: (l) => out.push(l) }), 1);
  assert.deepEqual(seen, [true]);
  const json = [];
  await CLI.main(['--dry-run', '--json'], { io: none, cfg: {}, out: (l) => json.push(l) });
  const view = JSON.parse(json[0]);
  assert.equal(view.make, true);
  assert.equal(view.user.name, 'hoprig');
});

test('a hang-up after the switch, while root\'s gateway is stopped and the user\'s not yet started, does not end the move', LINUX_ONLY, async () => {
  const { EventEmitter } = await import('node:events');
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const plan = await P.movePlan({ io: io() });
  assert.equal(plan.ok, true, plan.stops.join('\n'));
  const ok = { ok: true, stdout: '', stderr: '' };
  const userKey = (await import('../../src/server/dashboardfile.mjs')).stateKey(path.join(home, '.local/state/hoprig'));
  let dash = 0;
  const sys = {
    hasRunuser: () => true, linger: async () => ok, waitBus: async () => true, installUser: async () => ok, freePort: async () => 8441,
    startTrial: async () => ({ stop: async () => {} }), facts: async (p) => (p === 8441 || dash === 1001 ? { state: userKey } : null),
    stopRoot: async () => ((dash = null), ok), startRoot: async () => ((dash = 0), ok), disableRoot: async () => ok,
    installUserService: async () => ((dash = 1001), ok), stopUserService: async () => ok,
    listenerUid: async () => dash, portFree: async () => dash === null, writeFile: () => {}, sleep: async () => {},
    guard: () => SW.guardSignals({ proc }),
  };
  let gw = { pid: 4711, uid: 0, addr: '127.0.0.1:29999' };
  let heldAtStop = null;
  const gatewaySys = {
    listener: async () => gw,
    // The SSH connection drops right after root's gateway was stopped.
    stop: async () => {
      gw = null;
      heldAtStop = proc.listenerCount('SIGHUP');
      proc.emit('SIGHUP');
    },
    copyData: async () => ({ ok: true, entries: [3, 3] }),
    startAsUser: async () => { gw = { pid: 5000, uid: 1001, addr: '127.0.0.1:29999' }; },
    startAsRoot: async () => { gw = { pid: 4712, uid: 0, addr: '127.0.0.1:29999' }; },
    userHoprig: async () => ({ node: null, bin: '/home/hoprig/.local/bin/hoprig' }),
    profilesDir: path.join(s.tmp, 'no-profiles'), sleep: async () => {},
  };
  const said = [];
  const steps = {
    reach: async () => ({ ok: true, unreached: [] }),
    mark: () => {}, clearOwn: () => ({ gone: [], aside: [] }), own: () => {}, endTerminals: async () => [],
    copy: async () => ({ ok: true, made: [], placed: [] }), check: async () => ({ ok: true, repos: 0, hashes: { same: 0, total: 0 }, owners: 0, problems: [] }),
    switchSys: () => sys, sleep: async () => {},
    gateways: async () => [{ id: 'madeupgw', title: 'Made-up gateway', port: 29999, dataDir: '.madeupgw' }], gatewaySys: () => gatewaySys,
  };
  const r = await R.runMove(plan, { say: (l) => said.push(l), steps });
  const text = said.join('\n');
  assert.equal(r.ok, true, text);
  assert.equal(heldAtStop, 1, 'the hang-up is held while root\'s gateway is stopped');
  assert.match(text, /Made-up gateway runs as hoprig\./);
  assert.match(text, /\(SIGHUP came during the switch or the gateways' step and was held back until both were done\.\)/);
  for (const sig of SW.HELD_SIGNALS) assert.equal(proc.listenerCount(sig), 0, `${sig} is let go at the end`);
});

test("after a used copy, or once root's dashboard stopped, no stop offers to take away the user, its home or a part this run did not make", async () => {
  const userKey = (await import('../../src/server/dashboardfile.mjs')).stateKey('/srv/hoprig/.local/state/hoprig');
  const ok = { ok: true, stdout: '', stderr: '' };
  const sysFor = (failAt) => ({
    hasRunuser: () => true, linger: async () => ok, waitBus: async () => true,
    installUser: async () => (failAt === 'install' ? { ok: false, code: 1, stdout: '', stderr: 'made up' } : ok),
    freePort: async () => 8441, startTrial: async () => ({ stop: async () => {} }), facts: async (p) => (p === 8441 ? { state: userKey } : null),
    stopRoot: async () => ok, startRoot: async () => ok, disableRoot: async () => ok,
    installUserService: async () => ({ ok: false, stderr: 'no service here (made up)' }), stopUserService: async () => ok,
    listenerUid: async () => null, portFree: async () => true, writeFile: () => {}, sleep: async () => {},
  });
  const both = ['/srv/hoprig/.config/hoprig', '/srv/hoprig/Workspace'];
  const base = {
    user: { name: 'hoprig', uid: 1234, gid: 1234, home: '/srv/hoprig' }, make: false, oldHome: '/made-up/root', admin: [], total: { entries: 1, bytes: 1 }, port: 7433,
    running: { terminals: [] }, dirs: { state: '/made-up/root/.local/state/hoprig', config: '/made-up/root/.config/hoprig', claude: '/made-up/root/.claude' },
    parts: [{ id: 'config', to: both[0] }, { id: 'workspace', to: both[1] }, { id: 'ssh', to: '/srv/hoprig/.ssh' }],
  };
  const earlier = { user: 'hoprig', home: '/srv/hoprig', parts: both, madeUser: true, kept: [] };
  // The earlier marks: switched then back; stopped root's while switching, then back; a later copy after a used one.
  const plans = {
    'switched, then back': { ...base, again: { ...earlier, state: 'back', switchingAt: '2026-11-01T00:09:00Z', switchedAt: '2026-11-01T00:10:00Z', backAt: '2026-11-15T00:00:00Z' } },
    'switching, then back': { ...base, again: { ...earlier, state: 'back', switchingAt: '2026-11-01T00:09:00Z', backAt: '2026-11-01T00:11:00Z' } },
    'a later copy after a used one': { ...base, again: { ...earlier, state: 'copying', madeUntil: '2026-11-16T00:00:00Z', usedBefore: true } },
    'this run made the user': { ...base, madeUser: true },
  };
  // Each stop, with what this run's copy made: only those parts may be offered for removal, and none once root's stopped.
  const stops = {
    'the copy, nothing made (the used parts are gone or under a link)': { copy: { ok: false, error: 'made up', made: [] }, own: [] },
    'the copy, stopped midway': { copy: { ok: false, error: 'made up', made: ['/srv/hoprig/Workspace'] }, own: ['/srv/hoprig/Workspace'] },
    'the check': { check: false, own: both },
    'the switch, before root stopped': { fail: 'install', own: both },
    'the switch, after root stopped': { fail: 'service', own: [], ran: true },
  };
  for (const [pn, plan] of Object.entries(plans)) {
    for (const [sn, st] of Object.entries(stops)) {
      const said = [];
      const steps = {
        reach: async () => ({ ok: true, unreached: [] }), mark: () => {}, clearOwn: () => ({ gone: [], aside: [] }),
        copy: async () => st.copy || { ok: true, made: both, placed: [] },
        check: async () => (st.check === false ? { ok: false, problems: ['made up'] } : { ok: true, repos: 0, hashes: { same: 0, total: 0 }, owners: 0, problems: [] }),
        switchSys: () => sysFor(st.fail), endTerminals: async () => [], gateways: async () => [],
      };
      const r = await R.runMove(plan, { say: (l) => said.push(l), steps });
      const text = said.join('\n');
      const at = `${pn} / ${sn}\n${text}`;
      assert.equal(r.ok, false, at);
      const fresh = pn === 'this run made the user' && !st.ran;
      if (fresh) assert.match(text, /userdel --remove hoprig/, at); // the run's own user, home and copy, nothing else there
      else assert.doesNotMatch(text, /userdel|disable-linger|sudoers|none of it in use/, at);
      if (fresh) continue;
      // The go-on never says it takes away a copy the user's dashboard ran on (a later copy's own parts it may).
      if (MK.usedCopy(plan.again)) assert.doesNotMatch(text, /takes this copy away first/, at);
      const rm = text.match(/^To take the copy away: rm -r (.*)$/m);
      assert.deepEqual(rm ? rm[1].split(' ') : [], st.own, at);
    }
  }
});

test('the real clearing and copy after a used copy whose ~/.config is a link: the user\'s own settings are never offered for removal', LINUX_ONLY, async () => {
  const t = path.join(s.tmp, 'linked');
  const r0 = path.join(t, 'root');
  const h = path.join(t, 'home');
  for (const d of ['root/.config/hoprig', 'root/Workspace', 'state', 'home/Workspace', 'home/dotfiles/config/hoprig']) fs.mkdirSync(path.join(t, d), { recursive: true });
  fs.writeFileSync(path.join(r0, '.config/hoprig/config.json'), '{}');
  // A dotfiles manager links ~/.config: the used copy's settings lie under the link, so clearOwnCopy leaves them alone.
  fs.symlinkSync(path.join(h, 'dotfiles/config'), path.join(h, '.config'));
  const userConfig = path.join(h, '.config/hoprig/config.json');
  fs.writeFileSync(userConfig, '{"the user":"weeks of work"}');
  const parts = [
    { id: 'config', from: path.join(r0, '.config/hoprig'), to: path.join(h, '.config/hoprig'), entries: 1, bytes: 2 },
    { id: 'workspace', from: path.join(r0, 'Workspace'), to: path.join(h, 'Workspace'), entries: 1, bytes: 0 },
  ];
  const plan = {
    ok: true, user: { name: 'hoprig', uid: 1234, gid: 1234, home: h }, make: false, oldHome: r0, admin: [], total: { entries: 2, bytes: 2 },
    dirs: { state: path.join(t, 'state'), config: path.join(r0, '.config/hoprig'), claude: path.join(r0, '.claude'), workspace: path.join(r0, 'Workspace') },
    again: { user: 'hoprig', home: h, parts: parts.map((p) => p.to), madeUser: true, state: 'back', switchedAt: '2026-11-01T00:10:00Z', kept: [] },
    parts, network: [], proxy: null, running: { terminals: [] },
  };
  const said = [];
  const marks = [];
  const r = await R.runMove(plan, { say: (l) => said.push(l), low: { chown: () => {}, run: async () => assert.fail('no program here'), has: () => false }, steps: { mark: (m) => marks.push(m) } });
  const text = said.join('\n');
  assert.deepEqual(r, { ok: false, step: 'copy' }, text);
  assert.match(text, /\.config\/hoprig is already in hoprig's home/);
  assert.doesNotMatch(text, /userdel|rm -r|none of it in use|takes this copy away first/, text);
  assert.equal(fs.readFileSync(userConfig, 'utf8'), '{"the user":"weeks of work"}');
  assert.ok(fs.readdirSync(h).some((n) => n.startsWith('Workspace.before-')), 'the used Workspace is set aside');
  // The mark of this stop claims none of what lay in the way, and keeps that the user's dashboard ran in this home.
  assert.deepEqual([marks.at(-1).parts, marks.at(-1).usedBefore], [[], true]);
});

test('the look and --json say that a copy whose switch stopped root\'s dashboard is set aside, never taken away', async () => {
  const CLI = await import('../../src/setup/movecli.mjs');
  const plan = {
    user: { name: 'hoprig', home: '/srv/hoprig' }, make: false, stops: [], parts: [], admin: [], total: { entries: 0, bytes: 0 },
    running: { working: [], idle: [], terminals: [], work: 0, assistant: 0 },
    again: { user: 'hoprig', home: '/srv/hoprig', parts: [], at: '2026-11-01T00:00:00Z', state: 'back', switchingAt: '2026-11-01T00:09:00Z', backAt: '2026-11-01T00:11:00Z' },
  };
  const lines = P.planLines(plan).join('\n');
  assert.match(lines, /An earlier move to hoprig stopped root's dashboard on 2026-11-01T00:09Z and went back: its copy is set aside beside it \(never deleted\) and made again from root's\./);
  assert.doesNotMatch(lines, /taken away/);
  assert.equal(CLI.planView(plan).again.used, true);
  assert.equal(CLI.planView({ ...plan, again: { ...plan.again, state: 'copying', switchingAt: undefined, backAt: undefined } }).again.used, false);
});
