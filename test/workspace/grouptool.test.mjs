// A group's own tool (grouptool.mjs): the group repository "kits" names its command "kit" (run file kit.sh). After
// restore it only waits; after one yes on this computer `kit a "b c" --x` runs the group's file with exactly those
// arguments and returns its exit code. Without the yes there is no launcher; a run that leaves the group, a link, a
// name that shadows hop or a command on PATH, and a changed run are refused or asked again; a missing program of
// `needs` is named in status; no shell start file is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

// Windows gets no launcher for a group's tool (allowTool refuses there); the tests that make one are for macOS and Linux.
const NO_LAUNCHER = { skip: process.platform === 'win32' && 'a group\'s tool gets no launcher on Windows' };

const w = gitWorld('ws-grouptool');
test.after(() => w.cleanup());
const C = w.computer('t');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const T = await import('../../src/workspace/grouptool.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { saveConfig, loadConfig } = await import('../../src/config.mjs');

// Hoprig's own command folder on this computer (setup's ~/.local/bin), first on PATH.
const bin = path.join(C.home, '.local', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'hoprig'), '#!/bin/sh\n# hoprig-command-wrapper\nexit 0\n', { mode: 0o755 });
const PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.PATH = PATH;
const outside = path.join(w.root, 'OUTSIDE');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'evil.sh'), '#!/bin/sh\necho evil\n', { mode: 0o755 });

// The group's repository: kit.sh prints each argument on its own line and exits with 3; a tracked link out.sh.
const seed = w.clone(w.bare('kits'), path.join(w.root, 'seed-kits'));
fs.writeFileSync(path.join(seed, 'AGENTS.md'), '# kits\nUse kit.\n');
fs.writeFileSync(path.join(seed, 'kit.sh'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\nexit 3\n', { mode: 0o755 });
fs.writeFileSync(path.join(seed, 'kit2.sh'), '#!/bin/sh\necho two\n', { mode: 0o755 });
fs.symlinkSync(path.join(outside, 'evil.sh'), path.join(seed, 'out.sh'));
w.sh(seed, 'add', '-A');
w.sh(seed, 'commit', '-q', '-m', 'kits');
w.sh(seed, 'push', '-q', 'origin', 'main');
w.bare('brain');
w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
const kits = w.clone(w.url('kits'), path.join(C.ws, 'kits'));
const tool = (t) => {
  const m = M.readMap(C.ws).exists ? M.readMap(C.ws).map : { version: 2, brain: { url: w.url('brain') }, projects: [], others: [] };
  M.writeMap({ ...m, groups: [{ dir: 'kits', url: w.url('kits'), holds: [{ dir: 'builds' }], tool: t }] }, C.ws);
};
tool({ name: 'kit', run: 'kit.sh', needs: ['git', 'no-such-program-here'] });
const run = async (args, o = {}) => {
  const q = await quietUi();
  if (o.interactive) Object.assign(q.ui, { interactive: true, ask: async () => o.answer });
  let json = '';
  const code = await main(['tool', ...args], { ui: q.ui, write: (s) => (json += s) });
  return { code, text: q.text() + json };
};
const launcher = (n = 'kit') => path.join(bin, n);
const rcFiles = () => ['.profile', '.bashrc', '.bash_profile', '.zshenv', '.zshrc', '.config/fish'].map((f) => [f, fs.existsSync(path.join(C.home, f)) ? fs.readFileSync(path.join(C.home, f), 'utf8').length : null]);
const rcBefore = JSON.stringify(rcFiles());

test('after restore the tool only waits: no launcher; restore and status say it waits for a yes', NO_LAUNCHER, async () => {
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const q = await quietUi();
  q.ui.yes = true;
  const r = await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: C.ws, projects: C.projects });
  assert.ok(r.notes.some((n) => /kits has its own command kit: it is made only after your yes on this computer: +hoprig workspace tool allow kits/.test(n)), r.notes.join('\n'));
  assert.ok(!fs.existsSync(launcher()));
  assert.equal((await T.toolsState())[0].state, 'waits');
  const q2 = await quietUi();
  await main(['status'], { ui: q2.ui, write: () => {} });
  assert.match(q2.text(), /kits has its own command kit: it is made only after your yes/);
  assert.match(q2.text(), /kit \(kits\) needs no-such-program-here, which this computer does not have/);
  assert.doesNotMatch(q2.text(), /needs git,/, 'git is here');
  // Without a terminal and without --yes: refused, nothing made. At a terminal, "no" is no.
  const no = await run(['allow', 'kits']);
  assert.equal(no.code, 1, no.text);
  assert.match(no.text, /kit +→ +.*kits\/kit\.sh/, 'the name and the file are shown');
  const said = await run(['allow', 'kits'], { interactive: true, answer: 'n' });
  assert.equal(said.code, 1);
  assert.ok(!fs.existsSync(launcher()));
  assert.equal((await run(['allow', 'kits', '--dry-run'])).code, 0);
  assert.ok(!fs.existsSync(launcher()), 'a dry run makes nothing');
});

test('after one yes: kit a "b c" --x runs the group\'s file with exactly those arguments and its exit code', NO_LAUNCHER, async () => {
  const r = await run(['allow', 'kits', '--yes']);
  assert.equal(r.code, 0, r.text);
  assert.ok(fs.readFileSync(launcher(), 'utf8').includes(T.MARK));
  const p = spawnSync('kit', ['a', 'b c', '--x'], { encoding: 'utf8', env: { ...process.env, PATH } });
  assert.equal(p.status, 3);
  assert.equal(p.stdout, 'a\nb c\n--x\n');
  assert.equal((await T.toolsState())[0].state, 'made');
  assert.deepEqual(loadConfig().groupTools, { kits: { name: 'kit', run: 'kit.sh', url: w.url('kits') } }, 'the yes is kept per computer with what was shown: the name, the run and the group\'s address');
  assert.match(fs.readFileSync(launcher(), 'utf8'), /workspace tool run 'kits' -- "\$@"/, 'the launcher starts Hoprig, which checks again');
  assert.equal(w.sh(kits, 'status', '--porcelain'), '', 'nothing written into the group\'s repository');
});

test('a run that leaves the group, a tracked link, an untracked link, hop and a command on PATH are refused', NO_LAUNCHER, async () => {
  const { validateMap } = M;
  const map = (t) => ({ version: 2, brain: { url: null }, groups: [{ dir: 'kits', url: w.url('kits'), tool: t }], projects: [], others: [] });
  assert.equal(validateMap(map({ name: 'kit', run: '../kit.sh' })).ok, false);
  assert.equal(validateMap(map({ name: 'kit', run: '/bin/sh' })).ok, false);
  assert.match(validateMap(map({ name: 'hop', run: 'kit.sh' })).errors.join(' '), /Hoprig's own command/);
  assert.match(validateMap(map({ name: 'hoprig', run: 'kit.sh' })).errors.join(' '), /Hoprig's own command/);
  tool({ name: 'kitout', run: 'out.sh' });
  let r = await run(['allow', 'kits', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.text, /out\.sh leaves its folder through a link/);
  fs.symlinkSync(path.join(outside, 'evil.sh'), path.join(kits, 'mine.sh'));
  tool({ name: 'kitmine', run: 'mine.sh' });
  r = await run(['allow', 'kits', '--yes']);
  assert.match(r.text, /mine\.sh leaves its folder through a link/);
  fs.rmSync(path.join(kits, 'mine.sh'));
  tool({ name: 'git', run: 'kit.sh' });
  r = await run(['allow', 'kits', '--yes']);
  assert.match(r.text, /a command "git" is on this computer already/);
  assert.ok(!fs.existsSync(launcher('kitout')) && !fs.existsSync(launcher('kitmine')) && !fs.existsSync(launcher('git')));
  assert.ok(fs.existsSync(launcher('kit')), 'the launcher made before stays until a yes for another one');
});

test('a changed run or name asks again; the old launcher goes only when Hoprig made it', NO_LAUNCHER, async () => {
  tool({ name: 'kit', run: 'kit2.sh' });
  const st = (await T.toolsState())[0];
  assert.equal(st.state, 'waits');
  assert.match(st.why, /it was kit → kit\.sh/);
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  assert.equal(spawnSync('kit', [], { encoding: 'utf8', env: { ...process.env, PATH } }).stdout, 'two\n');
  // A new name: the old launcher (Hoprig's) goes; a file of the owner's with the old name of another tool stays.
  tool({ name: 'kit3', run: 'kit2.sh' });
  const r = await run(['allow', 'kits', '--yes']);
  assert.equal(r.code, 0, r.text);
  assert.ok(!fs.existsSync(launcher('kit')), 'Hoprig\'s old launcher is removed');
  assert.ok(fs.existsSync(launcher('kit3')));
  fs.writeFileSync(launcher('kit'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
  tool({ name: 'kit', run: 'kit2.sh' });
  const mine = await run(['allow', 'kits', '--yes']);
  assert.equal(mine.code, 1, 'a command of that name that is not this group\'s launcher is never replaced');
  assert.equal(fs.readFileSync(launcher('kit'), 'utf8'), '#!/bin/sh\necho mine\n');
  // remove takes away only Hoprig's launcher, and the yes.
  const rm = await run(['remove', 'kits', '--json']);
  assert.equal(rm.code, 0, rm.text);
  assert.ok(!fs.existsSync(launcher('kit3')));
  assert.ok(fs.existsSync(launcher('kit')), 'the owner\'s own file stays');
  assert.equal((loadConfig().groupTools || {}).kits, undefined);
});

test('no shell start file was touched, and nothing of this computer went into a repository', () => {
  assert.equal(JSON.stringify(rcFiles()), rcBefore);
  assert.equal(w.sh(kits, 'status', '--porcelain'), '');
  assert.doesNotMatch(fs.readFileSync(M.mapFile(C.ws), 'utf8'), new RegExp(C.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---- the checks of every start (the review's cases) ----

// The owner's own file named kit (a test above) stays: these use the name kt.
const kitRun = (args = []) => spawnSync('kt', args, { encoding: 'utf8', env: { ...process.env, PATH } });
const allowKit = async () => {
  tool({ name: 'kt', run: 'kit.sh' });
  const r = await run(['allow', 'kits', '--yes']);
  assert.equal(r.code, 0, r.text);
};

test('the yes is tied to the group\'s repository: another repository in its folder, or the group gone, and it does not start', NO_LAUNCHER, async () => {
  await allowKit();
  assert.equal(kitRun(['x']).status, 3);
  // The folder is replaced by a clone of another repository with a kit.sh of its own, and the map is changed to it.
  const evil = w.clone(w.bare('evil'), path.join(w.root, 'seed-evil'));
  fs.writeFileSync(path.join(evil, 'kit.sh'), '#!/bin/sh\necho EVIL-RAN\n', { mode: 0o755 });
  w.sh(evil, 'add', '-A');
  w.sh(evil, 'commit', '-q', '-m', 'evil');
  w.sh(evil, 'push', '-q', 'origin', 'main');
  fs.renameSync(kits, `${kits}.aside`);
  let p = kitRun();
  assert.equal(p.status, 126);
  assert.equal(p.stdout, '');
  assert.match(p.stderr, /the command of kits was not started: kits is not on this computer; to get the group: {2}hoprig workspace restore/);
  w.clone(w.url('evil'), kits);
  const m = M.readMap(C.ws).map;
  M.writeMap({ ...m, groups: [{ ...m.groups[0], url: w.url('evil') }] }, C.ws);
  p = kitRun();
  assert.doesNotMatch(p.stdout, /EVIL-RAN/);
  assert.match(p.stderr, /another address than the one your yes was for/);
  const st = (await T.toolsState())[0];
  assert.equal(st.state, 'blocked');
  // Restore says the truth about it: it would not start (never "waiting" while its launcher is there).
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const q = await quietUi();
  q.ui.yes = true;
  const r = await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: C.ws, projects: C.projects });
  assert.ok(r.notes.some((n) => /kt \(the command of kits\) would not start: .*hoprig workspace tool allow kits/.test(n)), r.notes.join('\n'));
  // Back as it was.
  fs.rmSync(kits, { recursive: true, force: true });
  fs.renameSync(`${kits}.aside`, kits);
  M.writeMap({ ...m, groups: [{ ...m.groups[0], url: w.url('kits') }] }, C.ws);
  assert.equal(kitRun(['x']).status, 3);
});

test('a run file replaced by a link after the yes, or a group folder that is a link: it does not start, status says why', NO_LAUNCHER, async () => {
  await allowKit();
  fs.renameSync(path.join(kits, 'kit.sh'), path.join(kits, 'kit.sh.keep'));
  fs.symlinkSync(path.join(outside, 'evil.sh'), path.join(kits, 'kit.sh'));
  const p = kitRun();
  assert.doesNotMatch(p.stdout, /evil/);
  assert.match(p.stderr, /kit\.sh leaves its folder through a link: a tool is never started through one/);
  const st = (await T.toolsState())[0];
  assert.deepEqual([st.state, /leaves its folder/.test(st.why)], ['blocked', true]);
  const q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.match(q.text(), /kt \(the command of kits\) would not start: .*kit\.sh leaves its folder through a link/);
  fs.rmSync(path.join(kits, 'kit.sh'));
  fs.renameSync(path.join(kits, 'kit.sh.keep'), path.join(kits, 'kit.sh'));
  // A group folder that is itself a link to a clone outside the workspace: refused at the yes.
  const away = w.clone(w.url('kits'), path.join(outside, 'kits-clone'));
  fs.renameSync(kits, `${kits}.real`);
  fs.symlinkSync(away, kits);
  try {
    const r = await run(['allow', 'kits', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.text, /kits leaves its folder through a link/);
    assert.notEqual(kitRun().status, 3, 'and the launcher made before does not start it either');
  } finally {
    fs.rmSync(kits);
    fs.renameSync(`${kits}.real`, kits);
  }
});

test('the yes is what was shown: a map changed during the question makes nothing', NO_LAUNCHER, async () => {
  await allowKit();
  const plan = await T.allowTool('kits', { dryRun: true });
  tool({ name: 'kt', run: 'kit2.sh' }); // a sync of the brain while the question is open
  await assert.rejects(T.allowTool('kits', { plan }), /the map changed while you were asked/);
  assert.equal(loadConfig().groupTools.kits.run, 'kit.sh', 'the yes kept is still the one given');
  tool({ name: 'kt', run: 'kit.sh' });
});

test('the launcher\'s name: a dangling link or another group\'s launcher is never replaced; the marker names its group exactly', NO_LAUNCHER, async () => {
  fs.symlinkSync('/nonexistent/owner-tool', launcher('mytool'));
  tool({ name: 'mytool', run: 'kit.sh' });
  let r = await run(['allow', 'kits', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.text, /mytool is there already and is not this group's launcher/);
  assert.equal(fs.readlinkSync(launcher('mytool')), '/nonexistent/owner-tool');
  fs.rmSync(launcher('mytool'));
  // Groups "kit" and "kits" (one is a prefix of the other): each launcher is its own group's only.
  fs.writeFileSync(launcher('shared'), T.launcherText('kits'), { mode: 0o755 });
  assert.equal(T.ourLauncher(launcher('shared'), 'kits'), true);
  assert.equal(T.ourLauncher(launcher('shared'), 'kit'), false);
  assert.equal(T.ourLauncher(launcher('shared'), 'kits.x'), false);
  fs.rmSync(launcher('shared'));
  tool({ name: 'kt', run: 'kit.sh' });
  r = await run(['allow', 'kits', '--yes']);
  assert.equal(r.code, 0, r.text);
});

test('"is a command now" only when its folder is on PATH; else the line to add', NO_LAUNCHER, async () => {
  const before = process.env.PATH;
  process.env.PATH = before.split(path.delimiter).filter((d) => d !== bin).join(path.delimiter);
  try {
    // Hoprig's own command is in ~/.local/bin, so the launcher goes there, but that folder is not on PATH now.
    const r = await run(['allow', 'kits', '--yes']);
    assert.equal(r.code, 0, r.text);
    assert.doesNotMatch(r.text, /is a command now/);
    assert.ok(r.text.includes(`which is not on your PATH: to run it by its name, add this line to your shell's start file (Hoprig does not edit it):  export PATH="${bin}:$PATH"`), r.text); // seal: a value no program is started with
  } finally {
    process.env.PATH = before;
  }
  assert.match((await run(['allow', 'kits', '--yes'])).text, /kt is a command now/);
});

test('a group named __proto__ or constructor: every look-up is by a Map, nothing crashes', async () => {
  const r1 = await run(['remove', '__proto__']);
  assert.equal(r1.code, 0, r1.text);
  assert.match(r1.text, /__proto__ has no yes on this computer: nothing to remove/);
  const r2 = await run(['remove', 'toString']);
  assert.match(r2.text, /toString has no yes on this computer/);
  const st = await T.toolsState({ map: { version: 2, groups: [{ dir: 'constructor', url: w.url('kits'), tool: { name: 'ctool', run: 'kit.sh' } }] } });
  assert.deepEqual([st[0].state, st[0].changed], ['absent', undefined]);
});

test('the exit code and a signal reach the caller as the tool gave them', NO_LAUNCHER, async () => {
  const s = w.clone(w.url('kits'), path.join(w.root, 'seed-kits-sig'));
  fs.writeFileSync(path.join(s, 'sig.sh'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
  w.sh(s, 'add', '-A');
  w.sh(s, 'commit', '-q', '-m', 'sig');
  w.sh(s, 'push', '-q', 'origin', 'main');
  w.sh(kits, 'pull', '-q');
  tool({ name: 'kt', run: 'sig.sh' });
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  const p = kitRun();
  assert.equal(p.signal, 'SIGTERM', JSON.stringify(p));
  tool({ name: 'kt', run: 'kit.sh' });
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  assert.equal(kitRun().status, 3);
});

test('where Node has no execve, the file runs as a child with the terminal and its exit code comes back', NO_LAUNCHER, async () => {
  tool({ name: 'kt', run: 'kit.sh' });
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  const keep = process.execve;
  process.execve = undefined;
  try {
    assert.equal(await T.runTool('kits', ['a']), 3);
  } finally {
    process.execve = keep;
  }
  // And the checks come first there too.
  assert.equal(await T.runTool('nope', [], { err: () => {} }), 126);
});

test('a run file that is not the group\'s own: in another repository cloned into its folder, or one it does not track', NO_LAUNCHER, async () => {
  await allowKit();
  // The map clones another repository into kits/vendor (an "others" entry); the tool's run points into it.
  const ev = w.clone(w.bare('vendor-kit'), path.join(w.root, 'seed-vendor'));
  fs.writeFileSync(path.join(ev, 'kit.sh'), '#!/bin/sh\necho VENDOR-RAN\n', { mode: 0o755 });
  w.sh(ev, 'add', '-A');
  w.sh(ev, 'commit', '-q', '-m', 'vendor');
  w.sh(ev, 'push', '-q', 'origin', 'main');
  const vendor = w.clone(w.url('vendor-kit'), path.join(kits, 'vendor'));
  tool({ name: 'kt', run: 'vendor/kit.sh' });
  const r = await run(['allow', 'kits', '--yes']);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /vendor\/kit\.sh is not a file of the group's repository \(it is in vendor, another repository\)/);
  // A yes given before the map pointed there does not start it either.
  assert.equal(loadConfig().groupTools.kits.run, 'kit.sh');
  const m = M.readMap(C.ws).map;
  saveConfig({ groupTools: { kits: { name: 'kt', run: 'vendor/kit.sh', url: w.url('kits') } } });
  let p = kitRun();
  assert.doesNotMatch(p.stdout, /VENDOR-RAN/);
  assert.match(p.stderr, /another repository/);
  assert.equal((await T.toolsState({ map: m }))[0].state, 'blocked');
  fs.rmSync(vendor, { recursive: true, force: true });
  // A file the group's repository does not track (untracked, or ignored), with the group's own address all the same.
  fs.writeFileSync(path.join(kits, 'local.sh'), '#!/bin/sh\necho LOCAL-RAN\n', { mode: 0o755 });
  tool({ name: 'kt', run: 'local.sh' });
  const r2 = await run(['allow', 'kits', '--yes']);
  assert.equal(r2.code, 1, r2.text);
  assert.match(r2.text, /local\.sh is not a file of the group's repository \(the repository does not track it\)/);
  saveConfig({ groupTools: { kits: { name: 'kt', run: 'local.sh', url: w.url('kits') } } });
  p = kitRun();
  assert.doesNotMatch(p.stdout, /LOCAL-RAN/);
  assert.match(p.stderr, /does not track it/);
  fs.rmSync(path.join(kits, 'local.sh'));
  tool({ name: 'kt', run: 'kit.sh' });
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  assert.equal(kitRun().status, 3);
});

test('a launcher that names a Node no longer on this computer: status says it cannot start, a new yes makes it again', NO_LAUNCHER, async () => {
  await allowKit();
  const text = fs.readFileSync(launcher('kt'), 'utf8');
  const node = process.execPath;
  assert.ok(text.includes(`'${node}'`), 'the launcher names the Node that made it');
  const gone = path.join(w.root, 'old-node', 'bin', 'node');
  fs.writeFileSync(launcher('kt'), text.replace(`'${node}'`, `'${gone}'`), { mode: 0o755 });
  assert.notEqual(kitRun().status, 3, 'it really cannot start');
  const st = (await T.toolsState())[0];
  assert.equal(st.state, 'stale');
  assert.match(st.why, /it starts .*old-node\/bin\/node, which is not on this computer any more/);
  const l = await run(['list']);
  assert.match(l.text, /kt .* cannot start: .*; to allow it again: {2}hoprig workspace tool allow kits/);
  const q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.match(q.text(), /kt \(the command of kits\) cannot start: .*To make it again: {2}hoprig workspace tool allow kits/);
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  assert.equal((await T.toolsState())[0].state, 'made');
  assert.equal(kitRun().status, 3);
});

test('where Node has no execve, a Ctrl-C reaches the tool once: the terminal sends it to the tool, Hoprig does not again', { skip: process.platform === 'win32' && 'process groups are POSIX' }, async () => {
  // A file of the group's own repository that counts each SIGINT it gets. It is a Node script, which runs its handler
  // as each signal comes (a shell defers a trap while it waits, so two signals a moment apart would count as one).
  fs.writeFileSync(path.join(kits, 'sig.cjs'), `#!${process.execPath}
const fs = require('node:fs');
const f = process.env.SIGFILE;
process.on('SIGINT', () => fs.appendFileSync(f, 'INT\\n'));
fs.appendFileSync(f, 'ready ' + process.pid + '\\n');
setTimeout(() => process.exit(0), 1500);
`, { mode: 0o755 });
  w.sh(kits, 'add', 'sig.cjs');
  w.sh(kits, 'commit', '-q', '-m', 'sig');
  tool({ name: 'kt', run: 'sig.cjs' });
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  const SIGFILE = path.join(w.root, 'sig.txt');
  fs.writeFileSync(SIGFILE, '');
  const { spawn } = await import('node:child_process');
  // In its own process group, as a terminal starts a command; a Ctrl-C goes to the whole group.
  const child = spawn('kt', [], { detached: true, stdio: 'ignore', env: { ...process.env, PATH, SIGFILE, NODE_OPTIONS: '--import=data:text/javascript,process.execve=undefined' } });
  const done = new Promise((resolve) => child.on('exit', resolve));
  for (let i = 0; i < 100 && !fs.readFileSync(SIGFILE, 'utf8').includes('ready'); i++) await new Promise((r) => setTimeout(r, 50));
  const [ready] = fs.readFileSync(SIGFILE, 'utf8').trim().split('\n');
  assert.match(ready || '', /^ready \d+$/, 'the tool started');
  // The tool is a child of Hoprig, not Hoprig itself: the path without execve is the one under test.
  assert.notEqual(Number(ready.split(' ')[1]), child.pid, 'the tool ran as a child (no execve)');
  process.kill(-child.pid, 'SIGINT');
  await done;
  assert.deepEqual(fs.readFileSync(SIGFILE, 'utf8').trim().split('\n').slice(1), ['INT']);
  w.sh(kits, 'reset', '-q', '--hard', 'HEAD~1');
});

test('the workspace rules file: its state is in status --json, and tool remove and allow say when it no longer fits', NO_LAUNCHER, async () => {
  tool({ name: 'kt', run: 'kit.sh' });
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 0);
  const statusJson = async () => {
    let out = '';
    await main(['status', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s) });
    return JSON.parse(out).workspaceRules;
  };
  assert.equal((await statusJson()).state, 'not-written');
  const q = await quietUi();
  assert.equal(await main(['rules', '--write', '--yes'], { ui: q.ui, write: () => {} }), 0, q.text());
  const st = await statusJson();
  assert.equal(st.state, 'current');
  assert.match(st.file, /hoprig-workspace\.md$/);
  const rm = await run(['remove', 'kits']);
  assert.match(rm.text, /the workspace rules file .*hoprig-workspace\.md still names kt: {2}hoprig workspace rules --write/);
  assert.equal((await statusJson()).state, 'older');
  // Allowed again: the file names it as it did, so nothing is said.
  const again = await run(['allow', 'kits', '--yes']);
  assert.doesNotMatch(again.text, /workspace rules file/);
  assert.equal((await statusJson()).state, 'current');
  fs.rmSync(st.file);
});

test('the refusals name the fix that works: a new yes only where it can succeed, never nested brackets', NO_LAUNCHER, async () => {
  await allowKit();
  // The map changed the run: a new yes helps, said flat.
  tool({ name: 'kt', run: 'kit2.sh' });
  let l = await run(['list']);
  assert.match(l.text, /kt .*waits for your yes: the map changed it, it was kt → kit\.sh; to allow it again: {2}hoprig workspace tool allow kits/);
  assert.doesNotMatch(l.text, /\(.*\(/, 'no brackets in brackets');
  // The map no longer names a tool: a yes cannot help, taking the command away does.
  tool(undefined);
  const p = kitRun();
  assert.equal(p.status, 126);
  assert.match(p.stderr, /the command of kits was not started: the map no longer names a tool for kits; to take the command away: {2}hoprig workspace tool remove kits/);
  assert.doesNotMatch(p.stderr, /tool allow/);
  // A run file the group's repository does not track: allow would refuse it too.
  tool({ name: 'kt', run: 'kit.sh' });
  fs.writeFileSync(path.join(kits, 'loose.sh'), '#!/bin/sh\necho loose\n', { mode: 0o755 });
  saveConfig({ groupTools: { kits: { ...loadConfig().groupTools.kits, run: 'loose.sh' } } });
  tool({ name: 'kt', run: 'loose.sh' });
  const st = (await T.toolsState())[0];
  assert.deepEqual([st.state, st.fix], ['blocked', 'remove']);
  l = await run(['list']);
  assert.match(l.text, /would not start: loose\.sh is not a file of the group's repository \(the repository does not track it\); to take the command away: {2}hoprig workspace tool remove kits/);
  assert.equal((await run(['allow', 'kits', '--yes'])).code, 1, 'and allow does refuse it');
  const rm = await run(['remove', 'kits']);
  assert.match(rm.text, /the yes for the command of kits is forgotten on this computer/);
  fs.rmSync(path.join(kits, 'loose.sh'));
  tool({ name: 'kt', run: 'kit.sh' });
});

test('a map that is refused: the refusal names the real fix, not an allow that would be refused the same way', async () => {
  const ws = path.join(w.root, 'bad-map-ws');
  fs.mkdirSync(path.join(ws, 'ai_brain'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'ai_brain', 'workspace.json'), '{bad');
  let said = '';
  assert.equal(await T.runTool('kits', [], { dir: ws, err: (s) => (said += s) }), 126);
  assert.match(said, /^the command of kits was not started: the workspace map was refused \(workspace\.json is not valid JSON\); hoprig workspace status says why\n$/);
  assert.doesNotMatch(said, /tool allow/);
});
