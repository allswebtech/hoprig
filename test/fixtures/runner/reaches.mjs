// A test file for test/seal.test.mjs. It starts a child that runs the program SEAL_CALL names (a JSON argv) and
// passes whatever that program does: only the runner's traps can fail its run. The test file itself does NOTHING for
// the seal (it never imports test/seal.mjs), so a run that is caught proves the in-process wrap (tools/test-seal.mjs)
// sealed the child on its own. How the child is started is SEAL_MODE:
//   self (default)  spawnSync(argv, { env: process.env })        — the test's own environment, or a cwd from SEAL_CWD
//   bare            spawnSync(argv, { env: { PATH, HOME } })      — a fresh environment, no test-file name in it
//   nopath          spawnSync(argv, { env: { HOME } })           — an environment that names no PATH at all
//   pathcase        spawnSync(argv, { env: { Path, HOME } })     — PATH spelled Path, which only Windows reads as PATH
//   checkedin       test/fixtures/runner/bin first on PATH, then the same stand-in by its full path: a stand-in kept
//                   in the repository's test folder must run, not the trap
//   unknown         the trap itself, by its path, with HOPRIG_TEST_FILE emptied: the trap cannot tell the file
//   link            a link of another name, in a temporary folder, to /usr/bin/<argv[0]>, run by its full path
//   trapnamedlink   a link NAMED as argv[0] (a trapped name), in a temporary folder, to /usr/bin/<argv[0]>, run by
//                   its full path: the wrap must follow it out of the test's area and trap it
//   enviargv        spawnSync('env', ['-i', …argv]) — env -i wipes PATH; the wrap must force the traps into env's argv
//   enviargvfull    the same with the full path '/usr/bin/env'
//   envpathargv     spawnSync('env', ['PATH=/usr/bin:/bin', …argv]) — the wrap must seal that PATH value
//   unsetpathargv   spawnSync('env', ['-u', 'PATH', …argv]) — env removes PATH; the wrap must put a sealed one back
//   fullpath        spawnSync('/usr/bin/'+argv[0], …) — a program by a full path into a system folder; the wrap refuses it
//   fullpathreal    the same, with argv[0] named in HOPRIG_SEAL_REAL by the test file itself (the opt-out): allowed,
//                   unless argv[0] is a trapped name, which goes to its trap all the same
//   envpathown      env with PATH=<the test's own folder>:… — the stand-in there must run, not the trap (a guard)
//   ownreal         a stand-in for argv[0] made under the REAL path of the temporary folder, first on PATH (as a
//                   test that realpaths its mkdtemp does); it must run, not the trap
//   othertmp        a stand-in for argv[0] under the run's tmp, started by its full path from a Node child handed
//                   its own environment with another TMPDIR (macOS: no TMPDIR, so /tmp): it must run, not be refused
//   fork            fork(child-run.mjs)                         — a forked Node child runs the program
//   grandchild      spawn(node, [child-run.mjs]) with a fresh { PATH: '/usr/bin' } for the program it starts
//   worker          a worker thread (node:worker_threads) that starts the program with a fresh { PATH: '/usr/bin' }:
//                   only the wrap, preloaded into the worker as well, can find the trap
//   workerenv       the same worker given an environment of its own ({ PATH: '/usr/bin' }, no runner variables)
//   workerexecargv  the same worker given execArgv: [] (none of the parent's flags, so no preload of its own)
//   versions        a Node program whose main file is <tmp>/versions/2.1.328 (a #! line, CommonJS: the shape of the
//                   coding tool's own install), started by its path; it starts the program with a fresh
//                   { PATH: '/usr/bin' }, so only the wrap carried into it can find the trap
import { fork, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, 'child-run.mjs');
const argv = JSON.parse(process.env.SEAL_CALL);
const mode = process.env.SEAL_MODE || (process.env.SEAL_BARE ? 'bare' : 'self');

function ownReal() {
  const bin = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'seal-own-'));
  fs.writeFileSync(path.join(bin, argv[0]), '#!/bin/sh\necho "the test\'s own stand-in"\n', { mode: 0o755 });
  const r = spawnSync(argv[0], argv.slice(1), { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8' });
  console.log(`exit ${r.status} ${r.error ? r.error.code : ''} ${String(r.stdout).trim()}`);
  fs.rmSync(bin, { recursive: true, force: true });
}

function checkedIn() {
  const bin = path.join(here, 'bin');
  for (const [cmd, env] of [[argv[0], { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }], [path.join(bin, argv[0]), process.env]]) {
    const r = spawnSync(cmd, argv.slice(1), { env, encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''} ${String(r.stdout).trim()}`);
  }
}

function direct() {
  const env =
    mode === 'bare' ? { PATH: process.env.PATH, HOME: process.env.HOME } : // seal: the wrap seals it; this fixture proves it
    mode === 'nopath' ? { HOME: process.env.HOME } :
    mode === 'pathcase' ? { Path: '/usr/bin:/bin', HOME: process.env.HOME } :
    process.env;
  const r = spawnSync(argv[0], argv.slice(1), { env, cwd: process.env.SEAL_CWD || undefined, encoding: 'utf8' });
  console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
}

const wait = (c) => new Promise((res) => c.on('exit', res));

test('runs one program', async () => {
  // A fresh env with no traps (SEAL_CALL is only the fixture's own instruction): only the wrap carries the traps in.
  if (mode === 'fork') await wait(fork(child, { env: { HOME: process.env.HOME, PATH: '/usr/bin', SEAL_CALL: process.env.SEAL_CALL }, stdio: 'inherit' }));
  else if (mode === 'versions') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-versions-'));
    const main = path.join(dir, 'versions', '2.1.328');
    fs.mkdirSync(path.dirname(main));
    fs.writeFileSync(main, `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst argv = JSON.parse(process.env.SEAL_CALL);\nconst r = spawnSync(argv[0], argv.slice(1), { env: { PATH: '/usr/bin', HOME: process.env.HOME }, encoding: 'utf8' });\nprocess.stdout.write(\`versions child exit \${r.status} \${r.error ? r.error.code : ''}\\n\`);\n`, { mode: 0o755 });
    const r = spawnSync(main, [], { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''} ${String(r.stdout).trim()} ${String(r.stderr).split('\n').find((l) => /ERR_|Error/.test(l)) || ''}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  else if (mode === 'worker' || mode === 'workerenv' || mode === 'workerexecargv') {
    const { Worker } = await import('node:worker_threads');
    const code = "const { spawnSync } = require('node:child_process'); const argv = JSON.parse(process.env.SEAL_CALL); const r = spawnSync(argv[0], argv.slice(1), { env: { PATH: '/usr/bin', HOME: process.env.HOME }, encoding: 'utf8' }); require('node:worker_threads').parentPort.postMessage(`worker child exit ${r.status} ${r.error ? r.error.code : ''}`);";
    // This fixture runs under a runner that a wrapped test started, so its NODE_OPTIONS carries the preload, and a
    // worker reads NODE_OPTIONS as well as its execArgv. A test file of the top-level runner has none: drop it here, so
    // that execArgv: [] is the only way the preload could reach the worker.
    if (mode === 'workerexecargv') delete process.env.NODE_OPTIONS;
    const own = mode === 'workerenv' ? { env: { PATH: '/usr/bin', HOME: process.env.HOME, SEAL_CALL: process.env.SEAL_CALL } } : mode === 'workerexecargv' ? { execArgv: [] } : {}; // seal: the wrap seals it; this fixture proves it
    const w = new Worker(code, { eval: true, ...own });
    console.log(await new Promise((res) => w.once('message', res)));
  }
  else if (mode === 'grandchild') await wait(spawn(process.execPath, [child], { env: { ...process.env, SEAL_FRESH: '1' }, stdio: 'inherit' }));
  else if (mode === 'unknown') {
    const r = spawnSync(path.join(process.env.HOPRIG_TEST_TRAPS, argv[0]), argv.slice(1), { env: { ...process.env, HOPRIG_TEST_FILE: '' }, encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
  } else if (mode === 'ownreal') ownReal();
  else if (mode === 'link') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-link-'));
    fs.symlinkSync(path.join('/usr/bin', argv[0]), path.join(dir, 'another-name'));
    const r = spawnSync(path.join(dir, 'another-name'), argv.slice(1), { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  else if (mode === 'trapnamedlink') {
    // A link NAMED as the trapped program, in a temporary folder, to /usr/bin/<name> (which does not exist, so a run
    // past the wrap finds nothing): the wrap must follow the link out of the test's area and send it to the trap, not
    // trust the trapped name because it sits in tmp.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-tnl-'));
    fs.symlinkSync(path.join('/usr/bin', argv[0]), path.join(dir, argv[0]));
    const r = spawnSync(path.join(dir, argv[0]), argv.slice(1), { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  else if (mode === 'enviargv' || mode === 'enviargvfull') {
    // env -i throws the environment away; the program after it is searched on the system's folders. The wrap must
    // force the traps back into env's own argv. (The command is a made-up trapped name: past the wrap it is not found.)
    const envCmd = mode === 'enviargvfull' ? '/usr/bin/env' : 'env';
    const r = spawnSync(envCmd, ['-i', ...argv], { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
  }
  else if (mode === 'envpathargv') {
    // env PATH=… resets PATH for the command. The wrap must seal that value (the traps before the system's folders).
    const r = spawnSync('env', ['PATH=/usr/bin:/bin', ...argv], { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
  }
  else if (mode === 'envpathown') {
    // env PATH=<the test's own folder>:… : the wrap keeps the test's own stand-in first, the traps after it, so the
    // stand-in runs and is not taken for the real program. (A guard: the seal must not clobber a legitimate PATH.)
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-envown-'));
    fs.writeFileSync(path.join(bin, argv[0]), '#!/bin/sh\necho "the test\'s own stand-in"\n', { mode: 0o755 });
    const r = spawnSync('env', [`PATH=${bin}:/usr/bin:/bin`, ...argv], { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''} ${String(r.stdout).trim()}`);
    fs.rmSync(bin, { recursive: true, force: true });
  }
  else if (mode === 'unsetpathargv') {
    // env -u PATH removes PATH for the command; the wrap must put a sealed PATH back so the trap is found (else the
    // made-up name is searched on the system's folders, where it does not exist: no real program is reached either way).
    const r = spawnSync('env', ['-u', 'PATH', ...argv], { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
  }
  else if (mode === 'fullpath') {
    // A made-up program named by a full path into a system folder. It is not there, so WITHOUT the refusal the start
    // fails as a missing file (no real program is reached). WITH it, the wrap names the test and refuses it the same way.
    const r = spawnSync(path.join('/usr/bin', argv[0]), argv.slice(1), { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
  }
  else if (mode === 'fullpathreal') {
    process.env.HOPRIG_SEAL_REAL = argv[0]; // seal: the opt-out under test; its program is a made-up name
    const r = spawnSync(path.join('/usr/bin', argv[0]), argv.slice(1), { encoding: 'utf8' });
    console.log(`exit ${r.status} ${r.error ? r.error.code : ''}`);
  }
  else if (mode === 'othertmp') {
    // A stand-in made under the run's tmp, started by its full path from a Node child handed an environment of its own
    // whose TMPDIR is another folder (macOS: a child given no TMPDIR has /tmp, the run's tmp is /var/folders/…/T).
    // The child's os.tmpdir() is then not the run's; the stand-in must still be the test's own, not refused.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-own-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-other-'));
    fs.writeFileSync(path.join(bin, argv[0]), '#!/bin/sh\necho "the test\'s own stand-in"\n', { mode: 0o755 });
    const call = JSON.stringify([path.join(bin, argv[0]), ...argv.slice(1)]);
    const r = spawnSync(process.execPath, [child], { env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: other, SEAL_CALL: call }, encoding: 'utf8' }); // seal: the wrap seals it; this fixture proves it
    console.log(`exit ${r.status} ${String(r.stdout).trim()}`);
    for (const d of [bin, other]) fs.rmSync(d, { recursive: true, force: true });
  }
  else if (mode === 'checkedin') checkedIn();
  else direct();
});
