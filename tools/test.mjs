#!/usr/bin/env node
// Runs the tests: every `*.test.mjs` under the given folders (default: `test`), and nothing else.
//
// Why not `node --test test/`: on Node 20 a folder argument means "run every .mjs in it", so the fixtures
// (stand-in servers that never exit) were started as tests and the run hung for ever. So a folder goes to
// `node --test` as a pattern of test-named files (`test/**/*.test.mjs`), which Node expands itself on every
// supported version and system, and the runner lists the same files itself to count their results
// (tools/test-plan.mjs; one path per file made a line too long for Windows).
//
//   node tools/test.mjs                 all tests
//   node tools/test.mjs test/server     one area
//   node tools/test.mjs --test-only     arguments starting with "-" go to `node --test` unchanged

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changes, guardOn, realPlaces, snapshot, writtenDuring } from './home-guard.mjs';
import { createRequire } from 'node:module';
import { extraTraps, makeTraps, reached, UNKNOWN_FILE } from './test-traps.mjs';
import { MIN_NODE_TEXT, belowFloor } from '../src/nodefloor.mjs';
import { longTemp, partOfPlan, testArgs, unlisted } from './test-plan.mjs';

// Below the lowest Node.js Hoprig supports the suite proves nothing that counts (and its proof that every result
// arrived needs each file's own summary, which Node sends from 22.10): one plain line, and no test is started.
if (belowFloor(process.versions.node)) {
  console.error(`The tests need Node.js ${MIN_NODE_TEXT} or newer, the lowest Hoprig supports; this is Node.js ${process.versions.node}. Run them with a newer Node.js.`);
  process.exit(1);
}

const { writeStandIns } = createRequire(import.meta.url)('./seal-standins.cjs');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
// `--part=2/3`: the second of three parts of the files (every third file of the sorted list), for a run split into
// jobs side by side. The runner takes the part itself, so its own count of results knows which files it started
// (Node's --test-shard would start fewer files than the count expects).
const partArg = args.find((a) => /^--part=\d+\/\d+$/.test(a));
const [partNo, partOf] = partArg ? partArg.slice(7).split('/').map(Number) : [1, 1];
if (partArg && !(partOf >= 1 && partNo >= 1 && partNo <= partOf)) {
  console.error(`--part=${partNo}/${partOf} is no part: write --part=<n>/<of>, with n from 1 to <of>.`);
  process.exit(1);
}
const flags = args.filter((a) => a.startsWith('-') && a !== partArg);
const places = args.filter((a) => !a.startsWith('-'));

// A folder goes to `node --test` as one glob pattern, not as its files one by one: about 1,100 paths are longer than
// the command line Windows allows, and both Windows jobs ended at the start with `spawn ENAMETOOLONG`
// (tools/test-plan.mjs says how, and how the files it means to run are still known one by one). A part names its own
// files (a pattern would run them all).
const whole = testArgs(places, { root });
const plan = partOfPlan(whole, partNo, partOf, { root });
const { files } = plan;
if (partArg) console.error(`part ${partNo} of ${partOf}: ${files.length} of ${whole.files.length} test files`);
if (!files.length) {
  console.error('No test files found.');
  process.exit(1);
}
if (plan.tooLong) {
  console.error(plan.tooLong);
  process.exit(1);
}

// A test that hangs must fail, not hold the run for ever (a hung file once kept a CI job alive for 25 minutes).
// The slowest end-to-end test takes well under a minute on Linux. Node 22 holds a whole FILE to the limit, and the
// slowest file (nineteen end-to-end tests that clone repositories) takes about 40 s on GitHub's Linux runner and about
// 150 s on its macOS runner, where it was cut off at 180 s. So three minutes on Linux and ten elsewhere: a hung test
// still ends long before a CI job does.
const LIMIT_MS = process.platform === 'linux' ? 180_000 : 600_000;
const limit = flags.some((f) => f.startsWith('--test-timeout')) ? [] : [`--test-timeout=${LIMIT_MS}`];
// That limit ends a test, not its file: from Node 26 a file whose tests are over but which still holds something open
// (a timer, a terminal, a child's pipe; a test that ran out of time leaves its own behind) never ends, its results are
// never printed, and every file after it waits (a CI job stood still until its 15-minute limit, with no name). Each
// file ends once its tests are done; a test that hangs fails by name at the limit above. Ending a file's process at once
// lost its last results where the runner read them slowly (a busy computer, any pipe on macOS): tools/test-flush.mjs
// makes those writes block, so they are all in the pipe before the process ends, and tools/test-guard.mjs counts them.
if (!flags.includes('--test-force-exit')) limit.push('--test-force-exit');

// Every test runs in a home of its own: HOME, the settings, state and Claude folders and the workspace point into a
// fresh temporary folder, and git has a test identity. A test that forgets to set up its own folders then still never
// reads or changes the real ones (one rewrote the real workspace map once, 15 Nov 2026). What a session of Claude Code
// or Hoprig puts in the environment (a provider's address and key, the run file) is left out for the same reason.
// Windows: the temporary folder by its long name first (tools/test-plan.mjs longTemp), so the sandbox, every test and
// every child name it as git and the system's real path do.
Object.assign(process.env, longTemp(process.env, { realpath: realpathSync.native }) || {});
const sandbox = mkdtempSync(join(tmpdir(), 'hoprig-tests-'));
const home = join(sandbox, 'home');
mkdirSync(home);
const gitconfig = join(sandbox, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = Test Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
// The tests' environment is built from a LIST OF NAMES LET IN, not by taking names out. The runner's own
// environment holds the owner's tokens, agent sockets, desktop and keyring that do not live under HOME; taking a few
// names out left all of those in, and a test that reached a program could use them. So only these groups pass, each
// with why it is let in; everything else (and anything that looks like a secret, even inside a group) stays out. A
// test that needs an inherited variable sets it itself, by name.
const SECRET = /token|secret|passw|credential|api[_-]?key|_key$|auth|bearer/i;
// npm_config_userconfig and npm_config_globalconfig are absolute paths `npm test` sets to the real ~/.npmrc and the
// global npmrc, which hold the owner's registry token. They are let in by /^npm_/ above but point OUTSIDE the test's
// home even when HOME is a temporary one, so an npm child of a test would read the owner's token. Dropped here; npm
// then uses the test home's own .npmrc (or none).
const POINTS_AT_REAL = /^npm_config_(userconfig|globalconfig)$/i;
const LET_IN = [
  /^PATH$/i, // where programs are found; the runner puts its traps first (below)
  /^(TMPDIR|TEMP|TMP)$/, // the temporary folder every test makes its home under (os.tmpdir reads these)
  /^(LANG|LANGUAGE|LC_[A-Z]+|TZ)$/, // the language, locale and time zone a program sorts and formats by
  /^(TERM|SHELL|USER|LOGNAME|USERNAME)$/, // a terminal and the user's name a program may read
  // What Windows needs to start any program at all.
  /^(SystemRoot|windir|ComSpec|PATHEXT|SystemDrive|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|ProgramData|CommonProgramFiles(\(x86\)|W6432)?|PROCESSOR_[A-Z0-9]+|OS|USERDOMAIN)$/i,
  // What Node, npm and a CI job need (never a token — SECRET above drops those).
  /^npm_/, /^(NODE_OPTIONS|NODE_EXTRA_CA_CERTS)$/, /^(CI|GITHUB_ACTIONS|RUNNER_(OS|ARCH|NAME|TEMP))$/,
  // The seal self-test's own control variables: its fixtures pass these to a nested runner (test/seal.test.mjs).
  // HOPRIG_TEST_FILE and HOPRIG_TEST_TRAPS are deliberately NOT here: the runner and tools/test-flush.mjs set those
  // per file, so an inherited one would misname a nested run; HOPRIG_TEST_SLOW_READER is carried by name below.
  /^SEAL_/,
  // The suite's own opt-in switches, each documented in the test that reads it: a maintainer hands one in on the
  // command line to widen a check or keep its evidence (SECRET above still drops anything that looks like a secret).
  /^SITE_PRIVATE_WORDS$/, // test/site/site.test.mjs: private words no public file may hold
  /^(AUTOMATION_EVIDENCE|OPERATOR_BYITSELF|OPERATOR_ONERULE|BYITSELF_CHANGES|KITS_BYITSELF_CHANGES)$/, // the "by itself" tests: where to write what they saw
  /^(DROP_PROP_TREES|DROP_PROP_SEED|DROP_QUIET_PORT|HOPRIG_PROP_SEED|HOPRIG_PROP_TREES|HOPRIG_PROP_WORLDS|HOPRIG_FULL_PROPERTY)$/, // the property tests: replay a seed, run more cases
  /^(DEBUG_P2|HARNESS_DEBUG)$/, // test/server/phase2.test.mjs and test/maydelete.test.mjs: say more
  /^CHROME$/, // tools/chrome.mjs: which browser the page tests drive
  /^HOPRIG_TEST_FISH$/, // test/server/launchline.test.mjs: a fish shell to check as well
  /^GUARD_FIXTURE_HOME$/, // test/homeguard.test.mjs: where its fixture writes, so the sub-runner passes it on to prove the home guard fires
];
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (LET_IN.some((re) => re.test(k)) && !SECRET.test(k) && !POINTS_AT_REAL.test(k)) env[k] = v;
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

// No test reaches the real system of the computer that runs it (tools/test-traps.mjs): sudo, systemctl, loginctl,
// the package managers and a global npm are traps first on the PATH, and a test that reaches one fails the run by
// name. A test once ran `brew install cloudflared` on a Mac; another, with a half-made change, installed a package
// globally with the real npm and ran the real sudo. A test that needs one of them puts its own stand-in before the
// traps (test/seal.mjs keeps them on a PATH a test makes for a child).
const guard = join(sandbox, 'guard');
const forbidden = join(sandbox, 'forbidden.log');
makeTraps({ dir: guard, log: forbidden, roots: [tmpdir(), sandbox], home, extra: extraTraps(process.env.HOPRIG_SEAL_EXTRA_TRAPS) });
// df, ps and ss stand in the trap folder too (tools/seal-standins.cjs): a made-up disk with room, the test file's own
// listeners and processes only. Wherever the traps go on a PATH, these go with them.
if (process.platform !== 'win32') writeStandIns(guard);
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
// A nested runner (test/seal.test.mjs starts a runner from inside a test, now with the child_process wrap) inherits
// the outer run's trap folder on PATH. Strip it before our own goes first, so a test's child finds this run's traps,
// not the outer run's (which would write the outer run's log and leave this run's empty). Set only in that case.
const priorTraps = process.env.HOPRIG_TEST_TRAPS;
if (priorTraps) env[pathKey] = (env[pathKey] || '').split(delimiter).filter((d) => d && resolve(d) !== resolve(priorTraps)).join(delimiter);
env[pathKey] = `${guard}${delimiter}${env[pathKey] || ''}`;
env.HOPRIG_TEST_TRAPS = guard;
// Made-up names trapped as well (tools/test-traps.mjs extraTraps): the test process knows them too, so the wrap sends a
// full path to one of them to its trap as it does for the real names.
const extraNames = extraTraps(process.env.HOPRIG_SEAL_EXTRA_TRAPS);
if (extraNames.length) env.HOPRIG_SEAL_EXTRA_TRAPS = extraNames.join(',');
// Ports refused as well as the product's defaults (tools/seal-net.mjs extraPorts; only adds): the seal's own proof.
if (process.env.HOPRIG_SEAL_EXTRA_PORTS) env.HOPRIG_SEAL_EXTRA_PORTS = process.env.HOPRIG_SEAL_EXTRA_PORTS;
// The product's one way to an npm that is not on PATH (nodeNpm in src/setup/system.mjs) goes to the trap as well.
env.HOPRIG_NODE_NPM = join(guard, process.platform === 'win32' ? 'npm.cmd' : 'npm');

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
// test-seal.cjs wraps node:child_process in each test file's process, so a child is sealed even when a test forgets
// test/seal.mjs: the traps first on any environment it hands a child, a full path to a trapped name refused. It is a
// preload (--require), the way it is also carried into every Node child (tools/test-seal.mjs says why).
const imports = ['--import', pathToFileURL(join(root, 'tools', 'test-flush.mjs')).href, '--require', join(root, 'tools', 'test-seal.cjs')];
// The real profile's Hoprig and coding-tool folders, before the run (tools/home-guard.mjs): read from this process's
// own environment, which is the person's, before any test changes anything.
const homeGuard = guardOn() ? { places: realPlaces(process.env) } : null;
if (homeGuard) homeGuard.before = snapshot(homeGuard.places);
// On every system: nothing a test runs may create an entry in the repository root. A test that built a Windows-style
// path (path.win32.join) on POSIX once made folders named "\\tmp\\..." here; the entries present before the run are
// known, and any new one fails the run by name.
const rootBefore = new Set(readdirSync(root));
// npm's debug logs of the person's own home (~/.npm/_logs), before the run: the npm trap gives every npm call of a test
// a cache and a log folder of the test's own (tools/test-traps.mjs npmEnv), so a log that appears there during the run
// and names this run's folders came from an npm that got past it. On every system; a log of another program of the
// person's (it names none of this run's folders) is left alone. Only the outermost runner watches: a runner a test
// starts has the outer test's home as its own, where the outer run's npm writes by design (SEAL_WATCH_NPM_LOGS=1 asks
// for it there, for the seal's own proof).
const watchNpmLogs = !priorTraps || process.env.SEAL_WATCH_NPM_LOGS === '1';
const realNpmLogs = join(process.env.USERPROFILE || process.env.HOME || home, '.npm', '_logs');
const npmLogsBefore = new Set(watchNpmLogs ? listNames(realNpmLogs) : []);
const child = spawn(process.execPath, [...imports, '--test', ...limit, ...reporters, ...flags, ...plan.args], { cwd: root, stdio: out, env });
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
  const asked = reached(forbidden);
  const special = new Set(['knock', 'fullpath', 'registry']); // log lines that are not a trapped program name
  for (const r of asked.filter((x) => !special.has(x.program))) console.error(`\n✖ A TEST REACHED THE REAL ${r.program}: ${r.file} (it asked: ${r.program}${r.args ? ` ${r.args}` : ''}; stopped by the runner's trap)`);
  if (asked.some((x) => !special.has(x.program))) console.error('  The traps stopped it: the real program did not run. Give the test a stand-in of its own, in its temporary folder (os.tmpdir()) or under test/, first on PATH, or build the PATH with sealedPath() from test/seal.mjs. To play a computer WITHOUT the program, give the product facts that say so, or a PATH of the test\'s own empty folder: the trap is a program of that name, and the product would take it for an installed one (AGENTS.md, "The suite cannot touch the computer").');
  for (const r of asked.filter((x) => x.program === 'fullpath')) console.error(`\n✖ A TEST STARTED A COMPUTER PROGRAM BY ITS FULL PATH: ${r.file} (it ran: ${r.args}; refused as a missing file so the real one did not run)`);
  if (asked.some((x) => x.program === 'fullpath')) console.error('  No test may start one of this computer\'s own programs by a full path. Give the test facts that say it is not there (the facts `sysFacts` is given, or `--offline`), or a stand-in of its own in its temporary folder (os.tmpdir()) or under test/.');
  for (const r of asked.filter((x) => x.program === 'knock')) {
    const [port, host, ...what] = r.args.split(' ');
    console.error(`\n✖ A TEST KNOCKED ON THE DEFAULT PORT ${port} (${what.join(' ')}): ${r.file} (it asked ${host}:${port}; refused before it left, as a closed port)`);
  }
  if (asked.some((x) => x.program === 'knock')) console.error('  Give the test\'s settings ports of its own (server.port, router.port, the gateway\'s addons.<id>.port, closedGateways() from test/seal.mjs, or PORT), also when the test listens on a port of its own: a part of the product that reads the address from the settings knocks on the default when they name none. Then it never asks where a contributor\'s own dashboard, router or gateway listens.');
  for (const r of asked.filter((x) => x.program === 'registry')) console.error(`\n✖ A TEST ASKED A PUBLIC REGISTRY: ${r.file} (it ran: npm ${r.args}; refused on this computer, nothing left it)`);
  if (asked.some((x) => x.program === 'registry')) console.error('  No test asks a registry that is not on this computer. Hand the product the answer it needs (a run of its own, as `toolRun` or `run`), or give the test a registry of its own on 127.0.0.1 (npm_config_registry).');
  const ranAt = runsOf();
  const npmLogs = (watchNpmLogs ? listNames(realNpmLogs) : []).filter((n) => !npmLogsBefore.has(n)).map((n) => join(realNpmLogs, n)).filter(namesThisRun);
  for (const p of npmLogs) {
    const who = writtenDuring(p, ranAt);
    console.error(`\n✖ NPM WROTE INTO THE REAL HOME: ${who.length ? who.join(', ') : UNKNOWN_FILE} (it made ${p})`);
  }
  if (npmLogs.length) console.error('  An npm of a test got past the npm trap, which gives every call a cache and log folder of the test\'s own: start npm by its name (the trap is first on PATH), not by a full path, and keep the environment the test was given.');
  const touched = homeGuard ? changes(homeGuard.before, snapshot(homeGuard.places)) : [];
  if (touched.length) {
    const by = (t) => {
      const who = writtenDuring(t.replace(/^\w+: /, ''), ranAt);
      return who.length ? `  (written while ${who.join(', ')} ran)` : '';
    };
    console.error(`\n✖ REAL HOME CHANGED: a test wrote outside its temporary home (a child's environment without USERPROFILE?):\n${touched.map((t) => `  ${t}${by(t)}`).join('\n')}`);
  }
  let strayRoot = [];
  try {
    strayRoot = readdirSync(root).filter((e) => !rootBefore.has(e));
  } catch {
    /* the root could not be read again */
  }
  if (strayRoot.length) console.error(`\n✖ WORKTREE ROOT CHANGED: a test made ${strayRoot.length} new entr${strayRoot.length === 1 ? 'y' : 'ies'} in the repository root (a Windows-style path built on POSIX, or a missing temporary home?):\n${strayRoot.map((e) => `  ${e}`).join('\n')}`);
  const lost = ownReporters ? [] : incomplete();
  if (ownReporters) console.error('(Reporters of your own: the count of every file\'s results is left out.)');
  else if (lost.length) console.error(`\n✖ RESULTS LOST: ${lost.length} test file(s) did not report all they ran, so the totals above miss tests (failing ones may be among them):\n${lost.map((l) => `  ${l}`).join('\n')}`);
  else console.error(`ℹ every result arrived: ${files.length} file(s), each with its own summary`);
  rmSync(sandbox, { recursive: true, force: true });
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  // No process.exit: it would cut off what is still being written to a pipe, the very thing above prevents.
  process.exitCode = signal || asked.length || lost.length || touched.length || strayRoot.length || npmLogs.length ? 1 : (code ?? 1);
});

/** When each test file ran ({ file: { from, to } }, from tools/test-guard.mjs), or {} when the count is not there. */
function runsOf() {
  try {
    return Object.fromEntries(Object.entries(JSON.parse(readFileSync(countFile, 'utf8'))).map(([f, c]) => [relative(root, resolve(root, f)), c]));
  } catch {
    return {};
  }
}

/** The names in `dir`, or none when it is not there. */
function listNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Whether an npm debug log names a folder of this run (its temporary folder, its sandbox or this repository). */
function namesThisRun(file) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  return [tmpdir(), sandbox, root].some((d) => text.includes(d));
}

/** The files whose results did not all arrive (tools/test-guard.mjs): one line each, saying what came. */
function incomplete() {
  let seen;
  try {
    seen = Object.fromEntries(Object.entries(JSON.parse(readFileSync(countFile, 'utf8'))).map(([f, c]) => [resolve(root, f), c]));
  } catch {
    // The count is written into the run's own temporary folder. Another run that empties the shared temporary folder
    // (two reviewers once shared one) takes it away under this run: then that is said, not only that results are lost.
    if (!existsSync(sandbox)) return [`this run's own temporary folder ${sandbox} was removed while its tests ran, by something other than this run (another run that emptied ${tmpdir()}?): the count of the results was in it`];
    return ['the runner ended before it wrote its count of the results'];
  }
  const out = [];
  for (const file of files) {
    const c = seen[file];
    const name = file.startsWith(root + sep) ? relative(root, file) : file;
    if (!c || !c.summary) out.push(`${name}: its own summary never came (${c ? `${c.results} result(s) came${c.asFile ? `, and the runner's line for the whole file says ${c.asFile}` : ''}` : 'nothing came'})`);
    else if (c.results !== c.summary.tests || c.suites !== c.summary.suites) out.push(`${name}: ${c.results} result(s) and ${c.suites} suite(s) came of the ${c.summary.tests} and ${c.summary.suites} it ran`);
  }
  // Node expands a folder's pattern itself: a file it ran that the runner's own list does not hold would add to the
  // totals unchecked, so it fails the run by name as well.
  for (const file of unlisted(files, Object.keys(seen))) out.push(`${file.startsWith(root + sep) ? relative(root, file) : file}: Node ran it, but it is not among the files this run meant to run`);
  return out;
}
