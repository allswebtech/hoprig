#!/usr/bin/env node
// Runs the tests: every `*.test.mjs` under the given folders (default: `test`), and nothing else.
//
// Why not `node --test test/`: on Node 20 a folder argument means "run every .mjs in it", so the fixtures
// (stand-in servers that never exit) were started as tests and the run hung for ever. Newer Node versions only
// pick test-named files, and a glob needs Node 21 or a shell that expands it (not Windows). Listing the files
// here behaves the same on every supported Node version and system.
//
//   node tools/test.mjs                 all tests
//   node tools/test.mjs test/server     one area
//   node tools/test.mjs --test-only     arguments starting with "-" go to `node --test` unchanged

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
const places = args.filter((a) => !a.startsWith('-'));

/** Every `*.test.mjs` under `place` (a folder, or one file), sorted so a run is the same each time. */
function testFiles(place) {
  const full = resolve(root, place);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .filter((f) => !f.split(/[\\/]/).includes('node_modules'))
    .sort();
}

const files = (places.length ? places : ['test']).flatMap(testFiles);
if (!files.length) {
  console.error('No test files found.');
  process.exit(1);
}

// A test that hangs must fail, not hold the run for ever (a hung file once kept a CI job alive for 25 minutes).
// The slowest end-to-end test takes well under a minute on Linux. Node 22 holds a whole FILE to the limit, and the
// slowest file (nineteen end-to-end tests that clone repositories) takes about 40 s on GitHub's Linux runner and about
// 150 s on its macOS runner, where it was cut off at 180 s. So three minutes on Linux and ten elsewhere: a hung test
// still ends long before a CI job does. --test-timeout exists from Node 20.11.
const [major, minor] = process.versions.node.split('.').map(Number);
const LIMIT_MS = process.platform === 'linux' ? 180_000 : 600_000;
const limit = flags.some((f) => f.startsWith('--test-timeout')) || (major === 20 && minor < 11) ? [] : [`--test-timeout=${LIMIT_MS}`];
// That limit ends a test, not its file: from Node 26 a file whose tests are over but which still holds something open
// (a timer, a terminal, a child's pipe; a test that ran out of time leaves its own behind) never ends, its results are
// never printed, and every file after it waits (a CI job stood still until its 15-minute limit, with no name). Each
// file ends once its tests are done; a test that hangs fails by name at the limit above. Ending a file's process at once
// lost its last results where the runner read them slowly (a busy computer, any pipe on macOS): tools/test-flush.mjs
// makes those writes block, so they are all in the pipe before the process ends, and tools/test-guard.mjs counts them.
if (!flags.includes('--test-force-exit') && (major > 20 || (major === 20 && minor >= 14))) limit.push('--test-force-exit');

// Every test runs in a home of its own: HOME, the settings, state and Claude folders and the workspace point into a
// fresh temporary folder, and git has a test identity. A test that forgets to set up its own folders then still never
// reads or changes the real ones (one rewrote the real workspace map once, 15 Nov 2026). What a session of Claude Code
// or Hoprig puts in the environment (a provider's address and key, the run file) is left out for the same reason.
const sandbox = mkdtempSync(join(tmpdir(), 'hoprig-tests-'));
const home = join(sandbox, 'home');
mkdirSync(home);
const gitconfig = join(sandbox, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = Test Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$|HOPRIG_|XDG_(CONFIG|STATE|DATA|CACHE)_HOME$|GIT_CONFIG|TMUX$|TMUX_PANE$)/.test(k)) delete env[k];
}
// tmux keeps a server's socket in $TMUX_TMPDIR/tmux-<uid>/<name> (else in /tmp), and a tmux command run inside tmux
// ($TMUX, removed above) reaches the server around it. The tests' tmux servers live in this run's own folder: two
// runs side by side never share one, and a command that names no server of its own reaches an empty default server
// of this run, never the person's. A socket's path has at most 104 bytes (macOS): a long temporary folder gets a short
// one in /tmp instead.
const tmuxDir = process.platform === 'win32' ? null : sandbox.length <= 48 ? join(sandbox, 'tmux') : mkdtempSync('/tmp/hoprig-tmux-');
if (tmuxDir) {
  mkdirSync(tmuxDir, { recursive: true });
  env.TMUX_TMPDIR = tmuxDir;
}
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  HOPRIG_CONFIG_DIR: join(sandbox, 'config'),
  HOPRIG_STATE_DIR: join(sandbox, 'state'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: '1',
});
if (process.platform === 'win32') Object.assign(env, { APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') });

// No test installs anything on the computer that runs it. The package managers of a Mac (Homebrew, MacPorts) are
// found first on the PATH as stand-ins that write down what they were asked and fail; a test that reaches one fails
// the run on every system, instead of installing for real where they exist (a test once ran `brew install cloudflared`
// on a Mac). Only the product's install steps call them: no check asks either one anything else.
const guard = join(sandbox, 'guard');
const forbidden = join(sandbox, 'forbidden.log');
mkdirSync(guard);
for (const name of ['brew', 'port']) {
  if (process.platform === 'win32') writeFileSync(join(guard, `${name}.cmd`), `@echo ${name} %*>>"${forbidden}"\r\n@exit /b 1\r\n`);
  else writeFileSync(join(guard, name), `#!/bin/sh\necho "${name} $*" >> '${forbidden}'\nexit 1\n`, { mode: 0o755 });
}
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
env[pathKey] = `${guard}${delimiter}${env[pathKey] || ''}`;

// The report reaches the log whole. With --test-force-exit the test runner ends its process as soon as the last result
// is handed to its output, and where that output is a pipe that does not block (macOS, and a CI runner's log is a
// pipe), what was not yet written is lost: on macOS a run's whole end, the details of every failure and the totals,
// never reached the log. Unless the output is a terminal, the runner writes into a file (a file is written at once)
// and this process copies the file to its own output as it grows, then reads the rest and ends by itself, which
// waits until everything is written. Each test file's own process gets tools/test-flush.mjs for the same reason.
const live = process.stdout.isTTY ? null : { path: join(sandbox, 'report.txt'), at: 0 };
let out = 'inherit';
if (live) {
  const fd = openSync(live.path, 'a');
  out = ['inherit', fd, fd];
  live.fd = fd;
}
// Every result is counted (tools/test-guard.mjs, a second reporter beside the one that prints): after the run each file
// it started must have sent its own summary, and its results must add up to it. Where the flags name reporters of
// their own, the count is left out and said so.
const countFile = join(sandbox, 'count.json');
const ownReporters = flags.some((f) => f.startsWith('--test-reporter'));
const reporters = ownReporters ? [] : ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${pathToFileURL(join(root, 'tools', 'test-guard.mjs')).href}`, `--test-reporter-destination=${countFile}`];
if (process.env.HOPRIG_TEST_SLOW_READER) env.HOPRIG_TEST_SLOW_READER = process.env.HOPRIG_TEST_SLOW_READER; // test/runner.test.mjs
const child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'tools', 'test-flush.mjs')).href, '--test', ...limit, ...reporters, ...flags, ...files], { cwd: root, stdio: out, env });
if (live) {
  closeSync(live.fd);
  live.reader = openSync(live.path, 'r');
  live.timer = setInterval(copyReport, 250);
}

/** Copies what the runner has written since the last call to this process's own output. */
function copyReport() {
  const buf = Buffer.alloc(1 << 16);
  for (let n; (n = readSync(live.reader, buf, 0, buf.length, live.at)) > 0; ) {
    live.at += n;
    process.stdout.write(Buffer.from(buf.subarray(0, n)));
  }
}

child.on('exit', (code, signal) => {
  if (live) {
    clearInterval(live.timer);
    copyReport();
    closeSync(live.reader);
  }
  const asked = existsSync(forbidden) ? readFileSync(forbidden, 'utf8').trim() : '';
  if (asked) console.error(`A test ran a package manager that installs on this computer (stopped by a stand-in):\n${asked}`);
  const lost = ownReporters ? [] : incomplete();
  if (ownReporters) console.error('(Reporters of your own: the count of every file\'s results is left out.)');
  else if (lost.length) console.error(`\n✖ RESULTS LOST: ${lost.length} test file(s) did not report all they ran, so the totals above miss tests (failing ones may be among them):\n${lost.map((l) => `  ${l}`).join('\n')}`);
  else console.error(`ℹ every result arrived: ${files.length} file(s), each with its own summary`);
  rmSync(sandbox, { recursive: true, force: true });
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  // No process.exit: it would cut off what is still being written to a pipe, the very thing above prevents.
  process.exitCode = signal || asked || lost.length ? 1 : (code ?? 1);
});

/** The files whose results did not all arrive (tools/test-guard.mjs): one line each, saying what came. */
function incomplete() {
  let seen;
  try {
    seen = Object.fromEntries(Object.entries(JSON.parse(readFileSync(countFile, 'utf8'))).map(([f, c]) => [resolve(root, f), c]));
  } catch {
    return ['the runner ended before it wrote its count of the results'];
  }
  const out = [];
  for (const file of files) {
    const c = seen[file];
    const name = file.startsWith(root + sep) ? relative(root, file) : file;
    if (!c || !c.summary) out.push(`${name}: its own summary never came (${c ? `${c.results} result(s) came${c.asFile ? `, and the runner's line for the whole file says ${c.asFile}` : ''}` : 'nothing came'})`);
    else if (c.results !== c.summary.tests || c.suites !== c.summary.suites) out.push(`${name}: ${c.results} result(s) and ${c.suites} suite(s) came of the ${c.summary.tests} and ${c.summary.suites} it ran`);
  }
  return out;
}
