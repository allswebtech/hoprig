// The seal of the suite's runner (tools/test.mjs, tools/test-traps.mjs): a test that reaches the real sudo,
// systemctl, loginctl, a package manager or a global npm fails the run by name. Every call made here is harmless if
// it ever got through (`sudo -n true`, `--version`, `npm ls -g`).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmIsGlobal, TRAP_EXIT, UNKNOWN_FILE } from '../tools/test-traps.mjs';
import { allowFullPath, systemAlong, trapAlong } from '../tools/test-seal.mjs';
import { createRequire } from 'node:module';
import { sealed, sealedPath } from './seal.mjs';
import { clearedEnvs, REAL_PROGRAMS, realPrograms, unsealedPaths } from './seal-rule.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join('test', 'fixtures', 'runner', 'reaches.mjs');
const { psArgs } = createRequire(import.meta.url)('../tools/seal-standins.cjs');

/** Runs tools/test.mjs on the fixture, which runs `argv`. → { code, out } */
function runFixture(argv, extra = {}) {
  const env = { ...process.env, SEAL_CALL: JSON.stringify(argv), ...extra };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'tools', 'test.mjs'), fixture], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out }));
  });
}

/** Runs tools/test.mjs on `fixtureRel`, with `extraEnv` added to the runner's OWN environment. → { code, out } */
function runOn(fixtureRel, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'tools', 'test.mjs'), fixtureRel], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out }));
  });
}

const CAUGHT = [
  ['sudo', '-n', 'true'],
  ['systemctl', '--version'],
  ['loginctl', '--version'],
  ['useradd', '--help'],
  ['visudo', '--version'],
  ['apt-get', '--version'],
  ['apt', '--version'],
  ['dnf', '--version'],
  ['yum', '--version'],
  ['pacman', '--version'],
  ['zypper', '--version'],
  ['apk', '--version'],
  ['brew', '--version'],
  ['port', 'version'],
  ['npm', 'ls', '-g', '--depth=0'],
  ['npm', 'ls', '--global', '--depth=0'],
  ['npm', 'ls', '--location=global', '--depth=0'],
  ['npm', 'ls', '-gp', '--depth=0'],
];

// A set-up as root makes the work user and its one administrator rights file: a test that forgot a stand-in for one of
// these would change this computer's accounts (its user may use sudo without a password).
test('the programs that make or change accounts are trapped', () => {
  const { TRAPPED } = createRequire(import.meta.url)('../tools/seal-core.cjs');
  for (const name of ['useradd', 'usermod', 'userdel', 'groupadd', 'visudo', 'chpasswd']) assert.ok(TRAPPED.includes(name), name);
});

for (const argv of CAUGHT) {
  test(`a test that runs \`${argv.join(' ')}\` fails the run by name`, { timeout: 120_000 }, async () => {
    const r = await runFixture(argv);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ℹ fail 0/, 'the fixture itself passed: only the trap fails the run');
    assert.ok(r.out.includes(`A TEST REACHED THE REAL ${argv[0]}: ${fixture.split(path.sep).join('/')} (it asked: ${argv.join(' ')};`), r.out);
    assert.match(r.out, new RegExp(`exit ${TRAP_EXIT} `), 'the trap ends with its own code');
    assert.match(r.out, /The traps stopped it: the real program did not run\. Give the test a stand-in of its own/, 'what happened and what to do');
    assert.match(r.out, /To play a computer WITHOUT the program, give the product facts that say so, or a PATH of the test's own empty folder/, 'how to play a computer without it');
  });
}

test('a global npm through npm\'s own environment is caught too', { timeout: 120_000 }, async () => {
  for (const extra of [{ npm_config_global: 'true' }, { npm_config_location: 'global' }]) {
    const r = await runFixture(['npm', 'ls', '--depth=0'], extra);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /A TEST REACHED THE REAL npm: /, JSON.stringify(extra));
  }
});

test('a child given a fresh environment that keeps the traps is caught, and the wrap still names its file', { timeout: 120_000 }, async () => {
  const r = await runFixture(['sudo', '-n', 'true'], { SEAL_BARE: '1' });
  assert.equal(r.code, 1, r.out);
  // The fixture builds a fresh { PATH, HOME } for the child (no HOPRIG_TEST_FILE); the in-process wrap
  // (tools/test-seal.mjs) carries the runner's variables back in, so the child is named by its file now.
  assert.match(r.out, new RegExp(`A TEST REACHED THE REAL sudo: ${fixture.split(path.sep).join('/')} \\(it asked: sudo -n true;`));
});

// By construction (tools/test-seal.mjs, the in-process wrap): each of these fixtures does NOTHING for the seal, yet the in-process
// wrap seals the child it starts. The fixture's file name must appear in the runner's line, not "an unknown test file".
const named = (out, program, asked) => out.includes(`A TEST REACHED THE REAL ${program}: ${fixture.split(path.sep).join('/')} (it asked: ${asked};`);
// A made-up name the runner traps as well (HOPRIG_SEAL_EXTRA_TRAPS): a proof run WITHOUT the change it proves then
// finds no real program of that name, so it fails with ENOENT instead of reaching a real one.
const MADE_UP = 'seal-made-up';
const madeUp = (extra = {}) => ({ HOPRIG_SEAL_EXTRA_TRAPS: MADE_UP, ...extra });


test('the wrap seals a child whose environment names no PATH at all', { timeout: 120_000 }, async () => {
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'nopath' }));
  assert.equal(r.code, 1, r.out);
  // With no PATH the sealed PATH is the traps, then the system's default folders: the trap is found first.
  assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
});

test('a child given an environment with no PATH still finds the computer\'s ordinary programs, after the traps', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-nopath-'));
  try {
    // { HOME } alone: the operating system would look in its default folders; the seal must not take those away.
    for (const [cmd, args] of [['git', ['--version']], ['sh', ['-c', 'echo hi']]]) {
      const r = spawnSync(cmd, args, { env: { HOME: home }, encoding: 'utf8' });
      assert.equal(r.status, 0, `${cmd}: ${r.error || r.stderr}`);
    }
    assert.equal(sealedPath(undefined).split(path.delimiter)[0], process.env.HOPRIG_TEST_TRAPS, 'the traps still come first');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a child given an EMPTY PATH finds no program of the computer: only the traps are added', { skip: process.platform === 'win32' && 'POSIX search rules' }, () => {
  // On POSIX an empty PATH searches no folder (only an absent one falls back to the system's defaults). A test that
  // hands a child PATH '' to prove "the program is missing" must still see it missing.
  assert.equal(sealedPath(''), process.env.HOPRIG_TEST_TRAPS);
  const r = spawnSync('/bin/sh', ['-c', 'command -v git || echo none'], { env: { PATH: '', HOME: os.tmpdir() }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'none', r.stdout);
});


test('a child whose PATH is spelled Path is sealed: on POSIX only PATH itself is read', { timeout: 120_000 }, async () => {
  // { Path: '/usr/bin:/bin' } with no PATH: the system searches its default folders, where no trap is. The seal must
  // put the traps under PATH itself, or the child runs the real program with nothing said.
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'pathcase' }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`A TEST REACHED THE REAL ${MADE_UP}: ${fixture.split(path.sep).join('/')} (it asked: ${MADE_UP}`), r.out);
  assert.match(r.out, new RegExp(`exit ${TRAP_EXIT} `), 'the trap ran');
});

test('a stand-in under the real path of a linked temporary folder stays the test\'s own (macOS\'s usual TMPDIR)', { timeout: 120_000, skip: process.platform === 'win32' && 'POSIX links and stand-ins' }, async () => {
  // TMPDIR is a link to another folder, as /var/folders/… is on macOS. A test that realpaths its mkdtemp makes its
  // stand-in under the link's target: the seal must still count it as the test's own and leave it before the traps.
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-real-'));
  const link = `${realDir}-link`;
  fs.symlinkSync(realDir, link);
  try {
    const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'ownreal', TMPDIR: link }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /exit 0 {2}the test's own stand-in/);
    assert.doesNotMatch(r.out, /A TEST REACHED/);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

test('a stand-in under the run\'s tmp stays the test\'s own in a child handed another TMPDIR (macOS: a child given no TMPDIR)', { timeout: 120_000, skip: process.platform === 'win32' && 'a POSIX stand-in' }, async () => {
  // The child's os.tmpdir() is not the run's, so only the run's own roots (the runner's trap settings) say the
  // stand-in is the test's. A made-up name, not trapped: refused, its start fails as a missing file (nothing real runs).
  const r = await runFixture(['seal-made-up-own', '--version'], { SEAL_MODE: 'othertmp' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /exit 0 child exit 0\s*$/m);
  assert.doesNotMatch(r.out, /A TEST STARTED A COMPUTER PROGRAM BY ITS FULL PATH/);
});

test('a stand-in kept in the repository\'s test folder runs, on PATH and by its full path, and is not taken for the real one', { timeout: 120_000, skip: process.platform === 'win32' && 'a POSIX stand-in' }, async () => {
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'checkedin' }));
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/exit 0 {2}a checked-in stand-in/g) || []).length, 2, r.out);
  assert.doesNotMatch(r.out, /A TEST REACHED/);
});

test('a trap that cannot tell the test file says so, and still fails the run', { timeout: 120_000, skip: process.platform === 'win32' && 'the POSIX trap' }, async () => {
  // The wrap carries HOPRIG_TEST_FILE into a child that has none, so only a child whose name was emptied (or one
  // started past the wrap, as by env -i) reaches the trap without it: the line then names no file, but the run fails.
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'unknown' }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`A TEST REACHED THE REAL ${MADE_UP}: ${UNKNOWN_FILE} (it asked: ${MADE_UP} --version;`), r.out);
});

test('a link of another name to a trapped program, run by its full path, is sent to the trap', { timeout: 120_000, skip: process.platform === 'win32' && 'POSIX links' }, async () => {
  // The link ends at /usr/bin/<made-up trapped name>, which does not exist: run without the wrap it finds nothing.
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'link' }));
  assert.equal(r.code, 1, r.out);
  assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
  assert.match(r.out, new RegExp(`exit ${TRAP_EXIT} `), 'the trap ran');
});

test('a link NAMED as a trapped program, kept in a temporary folder, run by its full path, is sent to the trap', { timeout: 120_000, skip: process.platform === 'win32' && 'POSIX links' }, async () => {
  // The link's own name is a trapped name and it sits in the temporary folder, where a stand-in the test made would
  // be its own. But it links out to /usr/bin/<made-up>, the computer's own program: the wrap must follow the chain
  // and trap it, not trust the trapped name for being in tmp. (Run past the wrap it would reach the real program.)
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'trapnamedlink' }));
  assert.equal(r.code, 1, r.out);
  assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
  assert.match(r.out, new RegExp(`exit ${TRAP_EXIT} `), 'the trap ran');
});

test('trapAlong walks the whole chain of links, not only its end', () => {
  // The chain is given by hand (isOwn/readlink), so no link to the computer's own system is made. A test's area is
  // /own/*; a trapped name is `sudo` or `made-up`; everything else is an ordinary program.
  const isOwn = (p) => p.startsWith(`${path.sep}own${path.sep}`);
  const isTrap = (n) => n === 'sudo' || n === 'made-up';
  const chain = (links) => (p) => { if (p in links) return links[p]; throw new Error('not a link'); };
  const along = (full, links) => trapAlong(full, { isOwn, isTrap, readlink: chain(links) });
  // Finding: a link whose own target has another name (made-up -> real-end): caught at the trapped hop, not its end.
  assert.equal(along('/own/other', { '/own/other': '/out/made-up', '/out/made-up': '/out/real-end' }), 'made-up');
  // A trapped name INSIDE the test's area that links out to the real program is caught where it leaves the area.
  assert.equal(along('/own/made-up', { '/own/made-up': '/out/made-up' }), 'made-up');
  // A trapped name by full path outside the area, with no links at all, is caught.
  assert.equal(along('/usr/bin/sudo', {}), 'sudo');
  // A stand-in the test keeps (a real file, a trapped name, in its own area) is its own: nothing is trapped.
  assert.equal(along('/own/tmp/made-up', {}), null);
  // A link that stays inside the test's area the whole way is its own too.
  assert.equal(along('/own/a', { '/own/a': '/own/b', '/own/b': '/own/made-up' }), null);
  // An ordinary program the dashboard runs (not trapped) is left alone, links and all.
  assert.equal(along('/usr/bin/git', { '/usr/bin/git': '/usr/lib/git' }), null);
});

test('the wrap sends a trapped program named by its full path to the trap, not the real one', { timeout: 120_000 }, async () => {
  // /usr/bin/sudo is passwordless on many computers: run by its full path it would bypass the PATH traps. The wrap
  // decides by the last part of the path, so a made-up trapped name under /usr/bin proves it without the real sudo
  // being there to reach when the wrap is taken out.
  const r = await runFixture([path.join('/usr/bin', MADE_UP), '--version'], madeUp());
  assert.equal(r.code, 1, r.out);
  assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
  assert.match(r.out, new RegExp(`exit ${TRAP_EXIT} `), 'the trap ran');
});

test('a program named by a full path into the computer\'s own folders is refused, and the test is named', { timeout: 120_000, skip: process.platform === 'win32' && 'POSIX paths' }, async () => {
  // A made-up name, NOT a trapped one, under /usr/bin: it is not on the real system there, so without the refusal the
  // start fails as a missing file (no real program is reached). With it, the wrap refuses it and names the test file.
  const prog = 'seal-made-up-prog';
  const r = await runFixture([prog, '--version'], { SEAL_MODE: 'fullpath' });
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`A TEST STARTED A COMPUTER PROGRAM BY ITS FULL PATH: ${fixture.split(path.sep).join('/')} (it ran: /usr/bin/${prog} --version`), r.out);
  assert.match(r.out, /the facts `sysFacts` is given, or `--offline`/, 'the same words as AGENTS.md');
});

test('a program a test names in HOPRIG_SEAL_REAL may be started by its full path, and a trapped name never', { timeout: 120_000, skip: process.platform === 'win32' && 'POSIX paths' }, async () => {
  // Made-up names under /usr/bin, not there: with the opt-out the start goes on and fails as a missing file, with no
  // line; without it (the source change taken away) the wrap refuses it and the run fails by name.
  const named = await runFixture(['seal-made-up-real', '--version'], { SEAL_MODE: 'fullpathreal' });
  assert.equal(named.code, 0, named.out);
  assert.doesNotMatch(named.out, /A TEST STARTED A COMPUTER PROGRAM BY ITS FULL PATH/);
  assert.match(named.out, /exit null ENOENT/, 'the start itself went on');
  // A trapped name, named the same way, still meets its trap.
  const trapped = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'fullpathreal' }));
  assert.equal(trapped.code, 1, trapped.out);
  assert.ok(trapped.out.includes(`A TEST REACHED THE REAL ${MADE_UP}`), trapped.out);
});

test('systemAlong refuses a computer program by a full path, and allows the test\'s own and the allow list', () => {
  // The chain is given by hand (isOwn/readlink), so no link to the computer's own system is made. The test's area is
  // /own/*; everything else is the computer's.
  const isOwn = (p) => p.startsWith(`${path.sep}own${path.sep}`);
  const along = (full, links = {}) => systemAlong(full, { isOwn, readlink: (p) => { if (p in links) return links[p]; throw new Error('not a link'); } });
  // The computer's own programs, started by a full path: refused (the path itself is returned).
  assert.equal(along('/usr/lib/update-notifier/apt-check'), '/usr/lib/update-notifier/apt-check');
  assert.equal(along('/usr/sbin/mariadbd'), '/usr/sbin/mariadbd');
  assert.equal(along('/usr/bin/df'), '/usr/bin/df');
  // The allow list: node, a shell, env, git — allowed, and a link is not followed past them (sh -> dash).
  assert.equal(along('/usr/bin/node'), null);
  assert.equal(along('/bin/sh', { '/bin/sh': '/bin/dash' }), null);
  assert.equal(along('/usr/bin/env'), null);
  assert.equal(along('/usr/bin/git'), null);
  // The test's own: a real file in its area, and a link that stays inside it.
  assert.equal(along('/own/tmp/mybin'), null);
  assert.equal(along('/own/a', { '/own/a': '/own/b' }), null);
  // A link the test keeps in its own area, pointing out to a computer program, is caught where it leaves.
  assert.equal(along('/own/tmp/mylink', { '/own/tmp/mylink': '/usr/bin/df' }), '/usr/bin/df');
});

test('the box\'s macOS sandbox may be started by its full path on macOS only, like bwrap', () => {
  const isOwn = () => false;
  const readlink = () => { throw new Error('not a link'); };
  const on = (platform, full) => systemAlong(full, { isOwn, readlink, allow: allowFullPath(platform) });
  assert.equal(on('darwin', '/usr/bin/sandbox-exec'), null);
  assert.equal(on('linux', '/usr/bin/sandbox-exec'), '/usr/bin/sandbox-exec');
  assert.equal(on('win32', '/usr/bin/sandbox-exec'), '/usr/bin/sandbox-exec');
  // Only at its own place: a file of that name in another folder is refused like any other program.
  assert.equal(on('darwin', '/opt/other/sandbox-exec'), '/opt/other/sandbox-exec');
  assert.equal(on('darwin', '/usr/local/bin/sandbox-exec'), '/usr/local/bin/sandbox-exec');
  // bwrap stays allowed everywhere, and nothing else is added on macOS.
  for (const platform of ['darwin', 'linux']) assert.equal(on(platform, '/usr/bin/bwrap'), null);
  assert.deepEqual([...allowFullPath('darwin')].filter((n) => !allowFullPath('linux').has(n)), ['/usr/bin/sandbox-exec']);
});

for (const mode of ['enviargv', 'enviargvfull', 'envpathargv', 'unsetpathargv']) {
  test(`the wrap seals an env argv that clears, unsets or resets PATH (${mode})`, { timeout: 120_000, skip: process.platform === 'win32' && 'POSIX env' }, async () => {
    // env -i throws the sealed environment away, env -u PATH removes PATH, and env PATH=… resets it; past the wrap the
    // made-up trapped name would be searched on the system's folders, where it does not exist. The wrap forces the
    // traps into env's own argv, so the trap is found and the run fails by name.
    const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: mode }));
    assert.equal(r.code, 1, r.out);
    assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
    assert.match(r.out, new RegExp(`exit ${TRAP_EXIT} `), 'the trap ran');
  });
}

test('the wrap keeps the test\'s own folder first when it seals an env PATH, so a stand-in there still runs', { timeout: 120_000, skip: process.platform === 'win32' && 'POSIX env' }, async () => {
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'envpathown' }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /exit 0 {2}the test's own stand-in/);
  assert.doesNotMatch(r.out, /A TEST REACHED/);
});

test('the wrap seals a forked Node child', { timeout: 120_000 }, async () => {
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'fork' }));
  assert.equal(r.code, 1, r.out);
  assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
});

test('the wrap seals a Node child of a Node child that builds a fresh environment', { timeout: 120_000 }, async () => {
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'grandchild' }));
  assert.equal(r.code, 1, r.out);
  assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
});

// src/editor/walk.mjs runs a worker thread. The preload runs in a worker too, so its child_process is wrapped; a worker
// given an environment of its own (no trap folder in it) or execArgv: [] (no preload) is sealed by the wrapped Worker.
for (const [mode, how] of [['worker', 'with the parent\'s environment and flags'], ['workerenv', 'given an environment of its own'], ['workerexecargv', 'given execArgv: []']]) {
  test(`the wrap seals a child of a worker thread ${how} that builds a fresh environment`, { timeout: 120_000 }, async () => {
    const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: mode }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`worker child exit ${TRAP_EXIT} `), 'the worker\'s child met the trap');
    assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
  });
}

test('the wrap reaches a Node program whose main file has no ending the loader knows (…/versions/2.1.328)', { timeout: 120_000, skip: process.platform === 'win32' && 'started through its #! line' }, async () => {
  // The coding tool's own install has this shape. The wrap is carried into a Node child by NODE_OPTIONS; carried as
  // --import it sent the child's main file through the ESM loader, which refuses an unknown ending, so the program did
  // not start at all. Carried as --require it starts as on a person's computer, and its own child is still sealed.
  const r = await runFixture([MADE_UP, '--version'], madeUp({ SEAL_MODE: 'versions' }));
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /ERR_UNKNOWN_FILE_EXTENSION/);
  assert.match(r.out, new RegExp(`versions child exit ${TRAP_EXIT} `), 'the program started and its child met the trap');
  assert.ok(named(r.out, MADE_UP, `${MADE_UP} --version`), r.out);
});

// df, ps and ss stand-ins (tools/seal-standins.cjs). Each proof first checks that the name is found in the trap
// folder, so a run without the stand-ins fails before it starts the computer's own program.
const standIn = (name) => {
  const found = process.env.PATH.split(path.delimiter).map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
  assert.equal(found && path.dirname(found), process.env.HOPRIG_TEST_TRAPS, `${name} is the runner's stand-in`);
};

test('df answers one made-up disk with room, in the Linux and the macOS forms', { skip: process.platform === 'win32' && 'POSIX stand-ins' }, async () => {
  standIn('df');
  const { DF_ARGS, parseDf } = await import('../src/server/platform/linux.mjs');
  const { parseDfMac } = await import('../src/server/platform/darwin.mjs');
  const linux = parseDf(spawnSync('df', DF_ARGS, { encoding: 'utf8' }).stdout);
  assert.deepEqual(linux.map((d) => [d.fs, d.mount, d.size, d.avail]), [['/dev/seal-made-up', '/', 100 * 2 ** 30, 90 * 2 ** 30]]);
  const mac = parseDfMac(spawnSync('df', ['-P', '-k', '-l'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(mac.map((d) => [d.fs, d.mount, d.size]), [['/dev/seal-made-up', '/', 100 * 2 ** 30]]);
});

test('ss answers the test file\'s own listeners only, and exits 0', { skip: process.platform !== 'linux' && 'ss is Linux\'s' }, async () => {
  standIn('ss');
  const { parseSs } = await import('../src/server/platform/linux.mjs');
  const net = await import('node:net');
  // A listener of a child of this test's, and one in this process: both its own.
  const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); })"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const server = net.createServer();
  try {
    const childPort = Number(await new Promise((res) => child.stdout.once('data', (d) => res(String(d).trim()))));
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const r = spawnSync('ss', ['-Htlnp'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const seen = parseSs(r.stdout);
    assert.ok(seen.length >= 2, r.stdout);
    for (const l of seen) assert.ok([process.pid, child.pid].includes(l.pid), `only the test's own listeners: ${JSON.stringify(l)}`);
    assert.deepEqual(seen.map((l) => l.port).sort(), [childPort, server.address().port].sort());
    const one = spawnSync('ss', ['-ltnpH', `sport = :${childPort}`], { encoding: 'utf8' });
    assert.match(one.stdout, new RegExp(`pid=${child.pid}\\b`), 'a filter of the caller\'s own is kept');
    // Without -p (the web-server check asks `ss -ltnH`): the same listeners, in the shape asked, with no process field.
    const bare = spawnSync('ss', ['-ltnH'], { encoding: 'utf8' });
    assert.equal(bare.status, 0);
    const ports = bare.stdout.split('\n').filter((l) => l.trim()).map((l) => Number(/:(\d+)\s/.exec(l)?.[1]));
    assert.deepEqual(ports.sort(), [childPort, server.address().port].sort(), bare.stdout);
    assert.doesNotMatch(bare.stdout, /users:/, 'no process field where the caller did not ask -p');
  } finally {
    child.kill();
    server.close();
  }
});

test('ps answers the test file\'s own processes, in every column list the product asks', { skip: process.platform !== 'linux' && 'the tree is read from /proc' }, async () => {
  standIn('ps');
  const { parsePs } = await import('../src/server/platform/linux.mjs');
  const { parsePsAll } = await import('../src/server/platform/linux-system.mjs');
  const child = spawn('sleep', ['30']);
  try {
    const all = parsePs(spawnSync('ps', ['-eo', 'pid=,uid=,pcpu=,rss=,etimes=,comm=,args='], { encoding: 'utf8' }).stdout).map((p) => p.pid);
    assert.ok(all.includes(process.pid) && all.includes(child.pid), `the test and its child: ${all}`);
    assert.ok(!all.includes(1), 'nothing of the computer\'s own (init)');
    assert.ok(parsePsAll(spawnSync('ps', ['-eo', 'pid=,ppid=,uid=,user:32=,rss=,etimes=,args='], { encoding: 'utf8' }).stdout).some((p) => p.pid === child.pid && p.ppid === process.pid));
    assert.equal(spawnSync('ps', ['-o', 'args=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim(), 'sleep 30');
    assert.match(spawnSync('ps', ['-A', '-o', 'pgid=', '-o', 'args='], { encoding: 'utf8' }).stdout, /sleep 30/);
    const none = spawnSync('ps', ['-o', 'uid=,args=', '-p', '1'], { encoding: 'utf8' });
    assert.deepEqual([none.status, none.stdout], [1, ''], 'a pid that is not the test\'s own: nothing, exit 1, as for a pid that is not there');
    // A BSD-style word, a long option or the value of a selection never widens the answer past the test's own tree.
    const { ownTree } = createRequire(import.meta.url)('../tools/seal-core.cjs');
    const pidsOf = (out, col) => out.split('\n').map((l) => Number(l.trim().split(/\s+/)[col])).filter(Boolean);
    for (const [args, col] of [[['aux'], 1], [['ax', '-o', 'pid='], 0], [['-o', 'pid=', 'ax'], 0], [['-ef'], 1], [['-u', String(process.getuid()), '-o', 'pid='], 0], [['-e', '--user', String(process.getuid()), '-o', 'pid='], 0], [['-aux'], 1], [['-eZ'], 1], [['axZ'], 1], [['-eM', '-o', 'pid='], 0]]) {
      const r = spawnSync('ps', args, { encoding: 'utf8' });
      const seen = pidsOf(r.stdout, col);
      const own = ownTree(process.pid);
      assert.equal(r.status, 0, `ps ${args.join(' ')}: ${r.stderr}`);
      assert.ok(seen.includes(process.pid) && seen.includes(child.pid), `ps ${args.join(' ')}: the test and its child: ${seen}`);
      assert.deepEqual(seen.filter((p) => fs.existsSync(`/proc/${p}`) && !own.has(p)), [], `ps ${args.join(' ')}: only the test's own processes`);
    }
    // A selection by name, parent, user or pid is the real program's, narrowed to the test's own tree: a name or a
    // user none of its processes has gives nothing and exit 1, and --ppid <the test> gives its children, not itself.
    const sel = (args) => { const r = spawnSync('ps', args, { encoding: 'utf8' }); return { status: r.status, pids: pidsOf(r.stdout, 0), stderr: r.stderr }; };
    for (const args of [['-C', 'seal-made-up', '-o', 'pid='], ['--ppid', '1', '-o', 'pid='], ['--user=1', '-o', 'pid='], ['-u', '0', '-o', 'pid='], ['--deselect', '-o', 'pid=']]) {
      assert.deepEqual(sel(args), { status: 1, pids: [], stderr: '' }, `ps ${args.join(' ')}: none of the test's own processes, so nothing and exit 1`);
    }
    assert.deepEqual(sel(['-C', 'sleep', '-o', 'pid=']), { status: 0, pids: [child.pid], stderr: '' }, 'ps -C sleep: its sleep alone');
    const kids = sel(['--ppid', String(process.pid), '-o', 'pid=']);
    assert.ok(kids.status === 0 && kids.pids.includes(child.pid) && !kids.pids.includes(process.pid), `ps --ppid <the test>: its children, not itself: ${JSON.stringify(kids)}`);
    assert.deepEqual(sel(['-p', `${process.pid},1`, '-o', 'pid=']), { status: 0, pids: [process.pid], stderr: '' }, 'ps -p <the test>,1: the test alone');
    const unknown = spawnSync('ps', ['-u', 'seal-made-up-user', '-o', 'pid='], { encoding: 'utf8' });
    assert.ok(unknown.status !== 0 && /user/i.test(unknown.stderr) && unknown.stdout === '', `a user that is not there is refused as the real ps refuses it: ${JSON.stringify(unknown)}`);
    assert.match(spawnSync('ps', ['aux'], { encoding: 'utf8' }).stdout, /^USER\s+PID\s+%CPU/, 'the format the caller asked (u) is kept');
    assert.match(spawnSync('ps', ['-ef'], { encoding: 'utf8' }).stdout, /^UID\s+PID\s+PPID/, 'the format the caller asked (-f) is kept');
    assert.match(spawnSync('ps', ['-eZ'], { encoding: 'utf8' }).stdout, /^LABEL\s+PID/, 'an output modifier the caller asked (-Z) is kept');
    assert.match(spawnSync('ps', ['-aux'], { encoding: 'utf8' }).stdout, /^USER\s+PID\s+%CPU/, '-aux is read as BSD aux, as procps reads it when no user is named x');
  } finally {
    child.kill();
  }
});

test('psArgs keeps the columns and the format asked apart from the selection asked, and drops what it does not know', () => {
  assert.deepEqual(psArgs(['aux']), { keep: ['u'], select: ['ax'] });
  assert.deepEqual(psArgs(['-ef']), { keep: ['-f'], select: ['-e'] });
  assert.deepEqual(psArgs(['-eo', 'pid=,args=']), { keep: ['-o', 'pid=,args='], select: ['-e'] });
  assert.deepEqual(psArgs(['ax', 'o', 'pid=', '--sort', 'pid', '--no-headers', '-w']), { keep: ['-o', 'pid=', '--sort', 'pid', '--no-headers', '-w'], select: ['ax'] });
  assert.deepEqual(psArgs(['--deselect', '--ppid', '1', '-u', '1000', '-U', 'alex', '--user=alex', '-t', 'pts/1', '-C', 'node', '-o', 'pid=']), { keep: ['-o', 'pid='], select: ['--deselect', '--ppid=1', '-u', '1000', '-U', 'alex', '--user=alex', '-t', 'pts/1', '-C', 'node'] });
  assert.deepEqual(psArgs(['-p', '12,13', '--pid=14', 'p15', '16']), { keep: [], select: ['-p', '12,13', '--pid=14', '-p', '15', '-p', '16'] });
  assert.deepEqual(psArgs(['-o', 'pid=', '-p12', '-q', '17']), { keep: ['-o', 'pid='], select: ['-p', '12', '-q', '17'] });
  assert.deepEqual(psArgs(['command=', 'pid,args', '-A', '-o', 'pgid=', '-o', 'args=']), { keep: ['-o', 'pgid=', '-o', 'args='], select: ['-A'] });
  assert.deepEqual(psArgs(['-axo', 'pid=,ppid=']), { keep: ['-o', 'pid=,ppid='], select: ['-ax'] });
  assert.deepEqual(psArgs(['-o', 'pid=', '--seal-made-up-option']), { keep: ['-o', 'pid='], select: [] });
  // Output modifiers (Z, M) shape the answer and are kept; -aux is BSD aux when no user is named by the rest of it.
  assert.deepEqual(psArgs(['-eZ']), { keep: ['-Z'], select: ['-e'] });
  assert.deepEqual(psArgs(['axZ']), { keep: ['Z'], select: ['ax'] });
  assert.deepEqual(psArgs(['-eM', '-o', 'pid=']), { keep: ['-M', '-o', 'pid='], select: ['-e'] });
  assert.deepEqual(psArgs(['-aux'], { userExists: () => false }), { keep: ['u'], select: ['ax'] });
  assert.deepEqual(psArgs(['-aux'], { userExists: (u) => u === 'x' }), { keep: [], select: ['-u', 'x', '-a'] });
});

test('a process left over from an earlier run whose test file had the same pid is not the test\'s own', () => {
  // A made-up /proc: the test file is 500 with its child 501; 600 is a tmux server an EARLIER test file of pid 500 left
  // running (its parent is now 1), with a child 602; 601 is the server this test file started. Both servers name the
  // pid 500; only the mark of this test file (its pid and a random part, HOPRIG_TEST_MARK) tells them apart.
  const { ownTree } = createRequire(import.meta.url)('../tools/seal-core.cjs');
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-proc-'));
  try {
    const now = '500.made-up-now';
    const put = (pid, ppid, env) => {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (made-up) S ${ppid} ${Array(48).fill(0).join(' ')}\n`);
      fs.writeFileSync(path.join(proc, String(pid), 'environ'), `${['HOME=/home/alex', ...env].join('\0')}\0`);
    };
    put(1, 0, []);
    put(500, 1, ['HOPRIG_TEST_PID=500', `HOPRIG_TEST_MARK=${now}`]);
    put(501, 500, ['HOPRIG_TEST_PID=500', `HOPRIG_TEST_MARK=${now}`]);
    put(600, 1, ['HOPRIG_TEST_PID=500', 'HOPRIG_TEST_MARK=500.made-up-before']);
    put(602, 600, ['HOPRIG_TEST_PID=500', 'HOPRIG_TEST_MARK=500.made-up-before']);
    put(601, 1, ['HOPRIG_TEST_PID=500', `HOPRIG_TEST_MARK=${now}`]);
    assert.deepEqual([...ownTree(500, { proc, mark: now })].sort(), [500, 501, 601]);
  } finally {
    fs.rmSync(proc, { recursive: true, force: true });
  }
});

test('the macOS tree from ps takes in a tmux server the test started, by its mark, and not one of an earlier run', () => {
  // Made-up answers of the Mac's ps: `-axo pid=,ppid=` and `-axE -o pid=,command=` (the command, then the environment,
  // for the user's own processes). 500 is the test file, 501 its child; 601 a tmux server it started (its parent is
  // launchd, 1) with a pane 603; 600 a server an earlier test file of the same pid left, with a pane 602.
  const { treeFromPs } = createRequire(import.meta.url)('../tools/seal-standins.cjs');
  const now = '500.made-up-now';
  const parents = ['1 0', '500 1', '501 500', '600 1', '602 600', '601 1', '603 601', '700 1'].map((l) => `  ${l}`).join('\n');
  const envs = [
    '  1 /sbin/launchd',
    `500 node --test a.test.mjs HOME=/Users/alex HOPRIG_TEST_PID=500 HOPRIG_TEST_MARK=${now}`,
    `501 sleep 30 HOPRIG_TEST_MARK=${now}`,
    '600 tmux -L seal-own new-session -d HOPRIG_TEST_PID=500 HOPRIG_TEST_MARK=500.made-up-before',
    '602 -zsh HOPRIG_TEST_MARK=500.made-up-before',
    `601 tmux -L seal-own new-session -d HOPRIG_TEST_PID=500 HOPRIG_TEST_MARK=${now}`,
    `603 -zsh HOPRIG_TEST_MARK=${now}x`,
    '700 tmux new-session HOME=/Users/alex',
  ].join('\n');
  assert.deepEqual([...treeFromPs(500, now, parents, envs)].sort(), [500, 501, 601, 603]);
  assert.deepEqual([...treeFromPs(500, '', parents, envs)].sort(), [500, 501], 'with no mark: the root and its descendants');
});

test('no test sees a tmux server it did not start: by ps or by the listing of /proc', { timeout: 120_000, skip: process.platform !== 'linux' && 'the tree is read from /proc' }, async () => {
  // A tmux server of this test's, on a made-up socket, outside the fixture's tree; started and ended here by its name.
  const socket = `seal-other-${process.pid}`;
  assert.equal(spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', 'sleep 60']).status, 0);
  try {
    const other = spawnSync('tmux', ['-L', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).stdout.trim();
    assert.match(other, /^\d+$/);
    const r = await runOn(path.join('test', 'fixtures', 'runner', 'tree.mjs'), { SEAL_OTHER_PID: other });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(/TREE (\{.*\})/.exec(r.out)[1]), { own: true, psOwn: true, psOther: false, psSelf: true, procOwn: true, procOther: false, byPidOther: '', byPidStatus: 1 });
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});

test('the tests that ask for the computer\'s own df, ps, ss or /proc are the ones the rule lists, each with its reason', () => {
  const { files, bare } = realPrograms(path.join(root, 'test'));
  assert.deepEqual(bare, [], 'These lines set HOPRIG_SEAL_REAL without saying why: // seal: <why>');
  assert.deepEqual(files, REAL_PROGRAMS, 'The tests that set HOPRIG_SEAL_REAL are listed in REAL_PROGRAMS (test/seal-rule.mjs)');
});

test('the real-program rule names a file that sets HOPRIG_SEAL_REAL and a line without its reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-real-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.test.mjs'), "process.env.HOPRIG_SEAL_REAL = 'ps'; // seal: it proves the real ps's columns\n");
    fs.writeFileSync(path.join(dir, 'b.test.mjs'), "const env = { ...process.env, HOPRIG_SEAL_REAL: 'df' };\n");
    fs.writeFileSync(path.join(dir, 'c.test.mjs'), "// HOPRIG_SEAL_REAL in a comment only\n");
    assert.deepEqual(realPrograms(dir), { files: ['test/a.test.mjs', 'test/b.test.mjs'], bare: ["test/b.test.mjs:1: const env = { ...process.env, HOPRIG_SEAL_REAL: 'df' };"] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a test that asks for the real one gets the next program on PATH, not the stand-in', { skip: process.platform === 'win32' && 'POSIX stand-ins' }, () => {
  // A made-up df of the test's own, after the trap folder: what the stand-in hands the call to. (Never the computer's.)
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-nextdf-'));
  try {
    fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\necho "the next df $*"\n', { mode: 0o755 });
    // The stand-in is started by its full path: a PATH of the test's own folders only is left without the traps.
    const df = path.join(process.env.HOPRIG_TEST_TRAPS, 'df');
    const env = { ...process.env, PATH: bin, HOPRIG_SEAL_REAL: 'df' }; // seal: only the test's own df to hand on to
    assert.equal(spawnSync(df, ['-P'], { env, encoding: 'utf8' }).stdout.trim(), 'the next df -P');
    assert.match(spawnSync(df, ['-P'], { env: { ...env, HOPRIG_SEAL_REAL: '' }, encoding: 'utf8' }).stdout, /seal-made-up/, 'without the switch: the stand-in');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('the runner builds the environment from a list of names let in, so a token or a desktop socket never reaches a test', { timeout: 120_000 }, async () => {
  // Set in the runner's OWN environment (made-up values): a way to the owner's accounts, agent, keyring or desktop
  // that does not live under HOME. None of them may reach a test file's process.
  const leaks = {
    SSH_AUTH_SOCK: '/tmp/made-up-agent.sock', GH_TOKEN: 'made-up', GITHUB_TOKEN: 'made-up',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/made-up', XDG_RUNTIME_DIR: '/run/made-up', DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0', OPENAI_API_KEY: 'made-up', GEMINI_API_KEY: 'made-up',
    CLOUDFLARE_API_TOKEN: 'made-up', NPM_TOKEN: 'made-up',
    // npm_* is let in (npm needs it), but these two are absolute paths to the real ~/.npmrc and global npmrc, which
    // hold the owner's registry token: dropped so an npm child of a test cannot read them.
    npm_config_userconfig: '/home/made-up/.npmrc', npm_config_globalconfig: '/made-up/etc/npmrc',
  };
  const r = await runOn(path.join('test', 'fixtures', 'runner', 'env-leak.mjs'), leaks);
  assert.equal(r.code, 0, r.out);
  const keys = JSON.parse(/ENVKEYS (\[.*\])/.exec(r.out)[1]);
  for (const k of Object.keys(leaks)) assert.ok(!keys.includes(k), `${k} reached a test process`);
  assert.ok(keys.includes('PATH'), 'PATH is let in'); // a name a test needs is kept
});

// No test connects to a default port of the product (tools/seal-net.mjs). The proof never touches a real default
// port: the runner refuses a port named in HOPRIG_SEAL_EXTRA_PORTS the same way, and the fixture listens on one of
// its own, one the system hands out.
const freePort = async () => {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
};
for (const how of ['net', 'http', 'fetch']) {
  test(`a test that connects to a refused port by ${how} sees a closed port, and the run fails by name`, { timeout: 120_000 }, async () => {
    const port = await freePort();
    const r = await runOn(path.join('test', 'fixtures', 'runner', 'knocks.mjs'), { HOPRIG_SEAL_EXTRA_PORTS: String(port), SEAL_PORT: String(port), SEAL_KNOCK: how });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ℹ fail 0/, 'the fixture itself passed: only the refusal fails the run');
    assert.match(r.out, /KNOCK ECONNREFUSED accepted 0/, 'refused before a connection was made, as a closed port');
    assert.ok(r.out.includes(`A TEST KNOCKED ON THE DEFAULT PORT ${port} (a port the run named in HOPRIG_SEAL_EXTRA_PORTS): test/fixtures/runner/knocks.mjs`), r.out);
    assert.match(r.out, /Give the test's settings ports of its own/);
    assert.match(r.out, /also when the test listens on a port of its own/, 'the case a test that listens on its own port meets');
    assert.match(r.out, /closedGateways\(\) from test\/seal\.mjs/);
  });
}

test('the same fixture without a refused port connects: the refusal is the seal\'s, not the fixture\'s', { timeout: 120_000 }, async () => {
  const port = await freePort();
  const r = await runOn(path.join('test', 'fixtures', 'runner', 'knocks.mjs'), { SEAL_PORT: String(port), SEAL_KNOCK: 'net' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /KNOCK connected accepted 1/);
});

test('the refused ports are the product\'s own defaults: the dashboard\'s, the router\'s, each shipped gateway\'s and Caddy\'s admin API', async () => {
  const { defaultPorts } = await import('../tools/seal-net.mjs');
  // Only the module's constants are read, no server is started; it gets a workspace of its own all the same, as the
  // suite asks of every test that loads the server (test/server/workspace-isolation.test.mjs).
  process.env.HOPRIG_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-ws-'));
  const { DEFAULT_PORT } = await import('../src/server/server.mjs');
  const { DEFAULT_ROUTER_PORT } = await import('../src/routerstate.mjs');
  const { SHIPPED } = await import('../src/addons/gateways.mjs');
  const { CADDY_ADMIN_PORT } = await import('../src/machines/hubcert.mjs');
  assert.deepEqual(defaultPorts().map((p) => p.port), [DEFAULT_PORT, DEFAULT_ROUTER_PORT, ...SHIPPED.map((g) => g.port), CADDY_ADMIN_PORT]);
});

test('the suite\'s own opt-in switches reach a test file, and a token still does not', { timeout: 120_000 }, async () => {
  const r = await runOn(path.join('test', 'fixtures', 'runner', 'env-leak.mjs'), { SITE_PRIVATE_WORDS: 'made-up-word', HOPRIG_PROP_SEED: '7', HOPRIG_TEST_FISH: '/made-up/fish', GH_TOKEN: 'made-up' });
  assert.equal(r.code, 0, r.out);
  const keys = JSON.parse(/ENVKEYS (\[.*\])/.exec(r.out)[1]);
  for (const k of ['SITE_PRIVATE_WORDS', 'HOPRIG_PROP_SEED', 'HOPRIG_TEST_FISH']) assert.ok(keys.includes(k), `${k} did not reach a test file: ${keys.join()}`);
  assert.ok(!keys.includes('GH_TOKEN'), 'GH_TOKEN reached a test process');
});

test('npm calls that stay in a temporary folder go on to the real npm, and the run passes', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-npm-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"seal-probe","version":"1.0.0"}');
    for (const argv of [['npm', '--version'], ['npm', 'ls', '--depth=0'], ['npm', 'ls', '--prefix', dir, '--depth=0']]) {
      const r = await runFixture(argv, { SEAL_CWD: dir });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /exit 0 /, argv.join(' '));
      assert.doesNotMatch(r.out, /A TEST REACHED/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an npm call that goes on gets a cache and log folder of the test\'s own, and a registry that is not on this computer is refused by name', { timeout: 120_000, skip: process.platform === 'win32' && 'a POSIX stand-in' }, async () => {
  // A made-up npm stands in for the real one after the trap (SEAL_NEXT_NPM), and a made-up "real" cache is set as
  // `npm test` sets the person's: without this piece of the seal the stand-in says so and reaches nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-npm-'));
  try {
    const npm = path.join(dir, 'npm');
    fs.writeFileSync(npm, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'test', 'fixtures', 'runner', 'npm-made-up.mjs'))} "$@"\n`, { mode: 0o755 });
    const said = path.join(dir, 'said.txt');
    const r = await runFixture(['npm', 'view', 'seal-made-up-package', 'version'], { SEAL_NEXT_NPM: npm, SEAL_NPM_SAID: said, npm_config_cache: path.join(path.sep, 'nonexistent-seal-made-up', '.npm') });
    const words = fs.readFileSync(said, 'utf8');
    assert.match(words, /^log: the test's own folder$/m, words);
    assert.match(words, /^registry: on this computer, answered 403$/m, words);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`A TEST ASKED A PUBLIC REGISTRY: ${fixture.split(path.sep).join('/')} (it ran: npm view seal-made-up-package version`), r.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an npm debug log that appears in the real home during the run, naming the run, fails it by name', { timeout: 120_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-real-home-'));
  try {
    const r = await runOn(path.join('test', 'fixtures', 'runner', 'writes-npm-log.mjs'), { HOME: home, USERPROFILE: home, SEAL_REAL_HOME: home, SEAL_WATCH_NPM_LOGS: '1' });
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`NPM WROTE INTO THE REAL HOME: ${['test', 'fixtures', 'runner', 'writes-npm-log.mjs'].join('/')} (it made ${path.join(home, '.npm', '_logs', '2026-01-01T00_00_00_000Z-debug-0.log')})`), r.out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('which npm calls are global', () => {
  const roots = [path.join(path.sep, 'tmp', 'run')];
  const cwd = path.join(roots[0], 'x');
  const global = (args, env = {}) => npmIsGlobal(args, { env, roots, cwd });
  for (const args of [['i', '-g', 'x'], ['i', 'x', '-g'], ['i', '-gf', 'x'], ['i', '--global', 'x'], ['i', '--global=true', 'x'], ['i', '--location', 'global', 'x'], ['i', '--location=global'], ['link'], ['ln', 'x'], ['uninstall', '-g', 'x'], ['rm', '--global', 'x'], ['i', '--prefix', '/usr/local', 'x'], ['i', '--prefix=/opt/x'], ['i', '-C', '/srv', 'x'], ['i', '--prefix', path.join(roots[0], '..', 'etc'), 'x']]) {
    assert.equal(global(args), true, args.join(' '));
  }
  for (const env of [{ npm_config_global: 'true' }, { NPM_CONFIG_GLOBAL: '1' }, { npm_config_location: 'global' }]) assert.equal(global(['ls'], env), true, JSON.stringify(env));
  for (const args of [['--version'], ['ls'], ['i', 'x'], ['i', '--prefix', path.join(roots[0], 'a'), 'x'], ['i', '--prefix', 'rel'], ['run', 'build', '--', '-g'], ['i', '--global=false', 'x'], ['view', 'g', 'version'], ['i', '--save-exact', 'x']]) {
    assert.equal(global(args), false, args.join(' '));
  }
  assert.equal(global(['ls'], { npm_config_prefix: '/usr/local', npm_config_global: 'false' }), false, 'what `npm test` sets for every script is not a global call');
});

test('every PATH a test writes keeps the seal (test/seal.mjs), or says on its line why it needs none', () => {
  assert.deepEqual(unsealedPaths(path.join(root, 'test')), [], 'These lines write a PATH without the seal. Build it with sealed() or sealedPath() from test/seal.mjs, or say on the line why it needs none: // seal: <why>');
});

test('the rule catches a child given the computer\'s PATH without the traps, and passes the ways that keep them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-rule-'));
  try {
    const bad = [
      "spawnSync('sh', [], { env: { PATH: '/usr/bin:/bin' } });",
      "spawnSync('sh', [], { env: { PATH: process.env.PATH, HOME: home } });",
      "const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };",
      "process.env.PATH = [bin, path.dirname(process.execPath)].join(':');",
    ];
    const good = [
      "spawnSync('sh', [], { env: sealed({ PATH: '/usr/bin:/bin' }) });",
      "const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };",
      "process.env.PATH = `${bin}${path.delimiter}${was}`;",
      "const env = { ...process.env, PATH: pathWith(s.tmp, bin) };",
      "assert.equal(f({ PATH: '/bin' }).PATH, '/bin'); // seal: a value no program is started with",
    ];
    fs.writeFileSync(path.join(dir, 'x.test.mjs'), [...bad, ...good].join('\n'));
    assert.deepEqual(unsealedPaths(dir).map((l) => Number(l.split(':')[1])), [1, 2, 3, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no test starts a child with an environment cleared by env -i (the wrap cannot seal what env throws away)', () => {
  assert.deepEqual(clearedEnvs(path.join(root, 'test')), [], 'These lines start a child through env -i, which throws the seal away: drop -i and set what the child needs by name, or say on the line why: // seal: <why>');
});

test('the env -i rule names a cleared environment in a command string or an argv, and passes the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-envi-'));
  try {
    // Written, never run: each of these would start the real sudo or systemctl past every trap.
    const bad = [
      'execSync("env -i sudo -n true");',
      'exec(`env -i systemctl --version`);',
      "spawnSync('env', ['-i', 'sudo', '-n', 'true']);",
      "spawnSync('sh', ['-c', 'env -iS sudo -n true']);",
      "execFileSync('env', ['--ignore-environment', 'systemctl', '--version']);",
      "const argv = ['env', '-i', 'sudo', '-n', 'true'];",
      "spawn('sh', ['-c', 'env - sudo -n true'], { stdio: 'inherit' });",
      "spawnSync('/usr/bin/env', ['-i', 'sudo', '-n', 'true']);", // a full path to env
      "execSync('env -u HOME -i sudo -n true');", // options between env and -i, in a string
      "spawnSync('sh', ['-c', 'PATH=/usr/bin:/bin sudo -n true']);", // a PATH reset at the head of a shell command
      "execSync('FOO=1 PATH=/usr/bin:/bin systemctl --version');", // a PATH reset after another assignment in a string
      "execSync('env -u PATH sudo -n true');", // -u PATH removes PATH in a shell string
      "spawn('sh', ['-c', 'env --unset=PATH systemctl --version']);", // --unset=PATH in a shell string
      "spawnSync('env', ['-u', 'PATH', 'sudo', '-n', 'true']);", // -u PATH as an argv (held by the wrap, named here too)
      "spawnSync('env', ['--unset=PATH', 'systemctl', '--version']);", // --unset=PATH as an argv
      "spawnSync('env', ['-uPATH', 'sudo', '-n', 'true']);", // -uPATH attached, as an argv
    ];
    const good = [
      "const PASS = ['env -i ', 'env -iu A ']; // data for a parser, never started",
      "spawnSync('env', ['A=1', 'node', '--version']);",
      "execSync('env -u A sh -c true');",
      "spawnSync('env', ['PATH=/usr/bin:/bin', 'sudo', '-n', 'true']);", // an env PATH= argv: the wrap seals it
      "spawnSync('env', ['-u', 'HOME', 'node', '--version']);", // unset of HOME, not PATH: allowed
      "spawnSync('env', ['--unset=HOME', 'node', '--version']);", // --unset of a non-PATH name: allowed
      "execSync(`env -i ${trap}`); // seal: proves the trap's own fallback name",
    ];
    fs.writeFileSync(path.join(dir, 'x.test.mjs'), [...bad, ...good].join('\n'));
    assert.deepEqual(clearedEnvs(dir).map((l) => Number(l.split(':')[1])), bad.map((_, i) => i + 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sealedPath: the test\'s own stand-ins first, then the traps, then the computer\'s folders', () => {
  const traps = process.env.HOPRIG_TEST_TRAPS;
  assert.ok(traps, 'the runner names its traps');
  const own = path.join(os.tmpdir(), 'seal-own-bin');
  assert.equal(sealedPath([own, '/usr/bin', '/bin']), [own, traps, '/usr/bin', '/bin'].join(path.delimiter));
  assert.equal(sealedPath(`${traps}${path.delimiter}/usr/bin`), [traps, '/usr/bin'].join(path.delimiter), 'never twice');
  assert.equal(sealedPath([own]), own, 'only the test\'s own folders: nothing real to find');
  const env = sealed({ PATH: '/usr/bin', HOME: '/h' });
  assert.equal(env.PATH, [traps, '/usr/bin'].join(path.delimiter));
  assert.equal(env.HOPRIG_TEST_TRAPS, traps);
  assert.equal(env.HOPRIG_TEST_FILE, 'test/seal.test.mjs');
});

// The product finds sudo, systemctl, loginctl, the package managers and npm on PATH, where the traps are. The one
// exception is nodeNpm (src/setup/system.mjs): the npm beside the Node Hoprig runs on, which HOPRIG_NODE_NPM overrides.
const PROGRAMS = 'sudo|systemctl|loginctl|apt-get|apt|dnf|yum|pacman|zypper|apk|brew|port|npm';
const BY_PATH = new RegExp(`(^|[^\\w.-])(/usr(/local)?|/opt/homebrew|/snap)?/s?bin/(${PROGRAMS})\\b|npm-cli|dirname\\(process\\.execPath\\)|lib[\\\\/]node_modules[\\\\/]npm|node_modules', 'npm'`);

/** The lines of src/ and bin/ that name such a program by a path of their own, outside nodeNpm. */
function ownPaths(dirs) {
  const out = [];
  for (const d of dirs) {
    for (const rel of fs.readdirSync(path.join(root, d), { recursive: true }).map(String).sort()) {
      if (!/\.m?js$/.test(rel)) continue;
      const file = `${d}/${rel.split(path.sep).join('/')}`;
      let text = fs.readFileSync(path.join(root, d, rel), 'utf8');
      if (file === 'src/setup/system.mjs') text = text.replace(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\nexport function nodeNpm\([\s\S]*?\n\}\n/, '');
      text.split('\n').forEach((l, i) => BY_PATH.test(l) && out.push(`${file}:${i + 1}: ${l.trim()}`));
    }
  }
  return out;
}

test('src/ names none of these programs by a path of its own, except the npm of its Node, in nodeNpm alone', () => {
  assert.deepEqual(ownPaths(['src', 'bin']), []);
  const system = fs.readFileSync(path.join(root, 'src', 'setup', 'system.mjs'), 'utf8');
  assert.match(system, /export function nodeNpm\(/, 'the one function is there');
});

test('the rule over src/ catches a second way round PATH', () => {
  for (const line of ["spawn('/usr/bin/sudo', ['-n', 'true'])", "capture(['/bin/systemctl', '--version'])", "const cli = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');", "['/opt/homebrew/bin/brew', 'install', 'x']"]) {
    assert.ok(BY_PATH.test(line), line);
  }
  for (const line of ["capture(['sudo', '-n', 'true'])", "['/bin/bash', '-c', BREW_INSTALL]", "npmArgv(['install'])", "fs.existsSync('/run/systemd/system')"]) {
    assert.ok(!BY_PATH.test(line), line);
  }
});

test('the runner points the npm of Hoprig\'s Node at its trap', async () => {
  const { nodeNpm } = await import('../src/setup/system.mjs');
  assert.ok(process.env.HOPRIG_NODE_NPM, 'set by the runner');
  assert.equal(path.dirname(process.env.HOPRIG_NODE_NPM), process.env.HOPRIG_TEST_TRAPS);
  assert.deepEqual(nodeNpm('linux'), [process.env.HOPRIG_NODE_NPM]);
  assert.ok(sealed({ PATH: '/usr/bin' }).HOPRIG_NODE_NPM, 'kept in an environment a test makes for a child');
});

test('a global npm through the npm of Hoprig\'s Node fails the run by name', { timeout: 120_000 }, async () => {
  const code = "const { nodeNpm } = await import(process.env.SEAL_SYSTEM); const { spawnSync } = await import('node:child_process'); const [cmd, ...pre] = nodeNpm(); spawnSync(cmd, [...pre, 'ls', '-g', '--depth=0']);";
  const r = await runFixture([process.execPath, '--input-type=module', '-e', code], { SEAL_SYSTEM: pathToFileURL(path.join(root, 'src', 'setup', 'system.mjs')).href });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /A TEST REACHED THE REAL npm: test\/fixtures\/runner\/reaches\.mjs \(it asked: npm ls -g --depth=0;/);
});
