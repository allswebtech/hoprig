'use strict';
// The seal's wrap, in the test file's own process and in every Node child it starts. What it holds and what it does
// not is said at the head of tools/test-seal.mjs. It is CommonJS so that the runner and every child can PRELOAD it
// with --require (NODE_OPTIONS carries it into a Node child): a preload leaves how the child's own main file is loaded
// alone. It runs on Node 22.0, which cannot require an ES module, so everything it loads is CommonJS or built in.
const cp = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const { promisify } = require('node:util');
const { extraTraps, inTmp, ownTree, realAsked, realByFullPath, sealed, sealedPath, SEAL_VARS, TRAP_EXIT, TRAPPED, UNKNOWN_FILE } = require('./seal-core.cjs');
const { defaultPorts, extraPorts, refusePorts } = require('./seal-net.cjs');

const SELF = __filename;
const RUNNER = path.join(path.dirname(SELF), 'test.mjs');
const NPM_TRAP = path.join(path.dirname(SELF), 'test-traps.mjs');
const STAND_IN = path.join(path.dirname(SELF), 'seal-standins.cjs');
// The runner itself must NOT be wrapped: it builds the test child's environment and its own traps by hand, and a
// stale HOPRIG_TEST_TRAPS carried into it (test/seal.test.mjs spawns the runner) would send a child at the wrong
// traps. A grandchild that re-runs the runner is left alone for the same reason. Nor is the npm trap
// (tools/test-traps.mjs run as a program): it hands an allowed call on to the next npm on PATH by that npm's full
// path, which the wrap would send back to the npm trap, and the trap would start itself without end. Nor are the
// df/ps/ss stand-ins (tools/seal-standins.cjs): they start the computer's ps by its full path, for the test's own
// pids only. Every other process wraps; what the trap or a stand-in starts gets the sealed environment it was handed.
const isRunner = process.argv[1] && [RUNNER, NPM_TRAP, STAND_IN].includes(path.resolve(process.argv[1]));
// The test file's own process names itself to every child (HOPRIG_TEST_PID, carried like the runner's variables): the
// root of the tree of processes that the ps stand-in and the /proc listing below answer with. Its mark
// (HOPRIG_TEST_MARK, the pid and a random part) tells its own background processes from those a test file of the same
// pid left behind in an earlier run.
if (process.env.HOPRIG_TEST_TRAPS && !isRunner && process.env.NODE_TEST_CONTEXT && !process.env.HOPRIG_TEST_PID) {
  process.env.HOPRIG_TEST_PID = String(process.pid);
  process.env.HOPRIG_TEST_MARK = `${process.pid}.${require('node:crypto').randomBytes(8).toString('hex')}`;
}

// A full path whose last part is one of these (lower-cased, without a Windows extension) is sent to the trap folder.
const TRAP_NAMES = new Set([...TRAPPED, 'npm', ...extraTraps(process.env.HOPRIG_SEAL_EXTRA_TRAPS)]);

const trapName = (p) => p.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/**
 * The trapped name `full` reaches outside the test's own area, or null when it is the test's own or no trapped
 * program at all. It walks the WHOLE chain of links from `full`, not only its end: at each hop it looks at that
 * node's own name, so a link named as a trapped program (`<tmp>/sudo` -> the real sudo), and a link whose target has
 * another name (`mysnap` -> /usr/bin/snap -> …/snapd), are both caught. A trapped name INSIDE the test's area is a
 * stand-in the test made and is passed over (a real file ends the chain; a link is followed in case it leaves the
 * area). `isOwn` says a path is the test's own; `readlink` reads one hop (it throws when there is none).
 */
function trapAlong(full, { isOwn = inTmp, readlink = fs.readlinkSync, isTrap = (n) => TRAP_NAMES.has(n) } = {}) {
  let at = full;
  for (let i = 0; i < 40; i++) {
    const base = trapName(at);
    if (isTrap(base) && !isOwn(at)) return base;
    let to;
    try { to = readlink(at); } catch { return null; } // a real file or a dangling end: the chain stops here
    at = path.resolve(path.dirname(at), to);
  }
  return null;
}

// Programs a test or the product may start by a FULL PATH into the computer's own folders. Each is here for a reason:
//  - node: a test starts a Node child by process.execPath (an absolute path); the product runs itself the same way.
//  - sh, bash, zsh, dash: the product runs `-c <command>` through a shell; the command it then starts is found on the
//    sealed PATH (trapped names still caught), so the shell binary itself is harmless.
//  - env: its argv is sealed above (sealEnvArgv); the program it then runs is found on the sealed PATH.
//  - git: tests drive local bare repositories by a full path to git; it touches only the folders it is given.
//  - bwrap: a test's own sandbox (bubblewrap). It isolates a child in new namespaces and reaches no account of the
//    person; a sandbox feature of the product builds a box on it, and its tests start it for real. The command INSIDE
//    the box is still found on the sealed PATH.
//  - sandbox-exec (macOS only): the same for the box on a Mac (/usr/bin/sandbox-exec, src/box/means.mjs). It applies
//    a deny-by-default profile and only then starts the command, which is still found on the sealed PATH. Not on
//    other systems, where the box has no such program.
// Any OTHER program started by a full path outside the test's own area is the computer's own and is refused, unless
// the test names it in HOPRIG_SEAL_REAL on a line that says why (`// seal: <why>`; test/seal-rule.mjs lists those
// tests): a test that proves what only the real program shows (a browser's cookies, ssh-keygen's print of a key file
// the test wrote). A trapped name is never let through that way: trapAlong sends it to its trap first.
// An entry with a slash is allowed at exactly that full path only (sandbox-exec: the box starts /usr/bin/sandbox-exec
// and nothing else, so a file of that name in another folder is refused as any other program).
const allowFullPath = (platform = process.platform) => new Set(['node', 'sh', 'bash', 'zsh', 'dash', 'env', 'git', 'bwrap', ...(platform === 'darwin' ? ['/usr/bin/sandbox-exec'] : [])]);
const ALLOW_FULL_PATH = allowFullPath();

/**
 * The computer's own program a start by `full` reaches, or null when it is the test's own or allow-listed. Like
 * trapAlong it walks the chain of links, but it refuses ANY program outside the test's area, not only a trapped name:
 * a program named by a full path into the computer's folders is as real as a name found on PATH. An allow-listed name
 * (node, a shell, env, git, bwrap) stops the walk at once, since those are often links to another name (sh -> dash). A path
 * inside the test's area is followed in case a link leaves it. `isOwn` says a path is the test's own; `readlink` reads
 * one hop (it throws when there is none).
 */
function systemAlong(full, { isOwn = inTmp, readlink = fs.readlinkSync, allow = ALLOW_FULL_PATH } = {}) {
  let at = full;
  for (let i = 0; i < 40; i++) {
    if (allow.has(trapName(at)) || allow.has(at)) return null; // node, a shell, env, git (by name), sandbox-exec (by its path)
    if (!isOwn(at)) return at;                         // the computer's own program by a full path: refuse it
    let to;
    try { to = readlink(at); } catch { return null; }  // a real file in the test's own area: its own
    at = path.resolve(path.dirname(at), to);           // a link in the test's area: follow where it points
  }
  return null;
}

// The traps' log (its path is in the npm trap's settings), read once. The net refusal (tools/seal-net.mjs) and the
// full-path refusal both write one line into it, so the runner fails the run by name as it does for a trap.
let forbiddenLog;
function logForbidden(kind, detail) {
  if (forbiddenLog === undefined) {
    try { forbiddenLog = JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_TEST_TRAPS, 'npm-trap.json'), 'utf8')).log; } catch { forbiddenLog = null; }
  }
  if (!forbiddenLog) return;
  const flat = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
  try { fs.appendFileSync(forbiddenLog, `${kind}\t${flat(detail)}\t${flat(process.env.HOPRIG_TEST_FILE || UNKNOWN_FILE)}\n`); } catch { /* the refusal holds even when the log cannot be written */ }
}

/**
 * `cmd` (the program a test starts) redirected when it reaches the computer's own system: a full path to a trapped
 * name goes to that name's trap (exit 97, "A TEST REACHED THE REAL …"); any other full path into the computer's
 * folders, outside the test's area and off the allow list, is refused as a missing file (ENOENT) and one line names
 * the test. A bare name is left for PATH (the traps are first). `args` are logged with a refusal.
 */
function trapPath(cmd, cwd, args = []) {
  if (typeof cmd !== 'string' || !/[\\/]/.test(cmd)) return cmd; // a bare name is found on PATH, where the traps are first
  const traps = process.env.HOPRIG_TEST_TRAPS;
  if (!traps) return cmd;
  const full = path.isAbsolute(cmd) ? cmd : path.resolve(cwd || process.cwd(), cmd);
  const trapped = trapAlong(full);
  if (trapped) return path.join(traps, process.platform === 'win32' ? `${trapped}.cmd` : trapped);
  if (systemAlong(full, { allow: new Set([...ALLOW_FULL_PATH, ...realByFullPath()]) })) { // the computer's own, by a full path: refuse it, name the test
    logForbidden('fullpath', `${cmd}${args.length ? ` ${args.join(' ')}` : ''}`);
    return path.join(traps, 'seal-refused-full-path'); // not a file that is there: the start fails like a missing one
  }
  return cmd;
}

/**
 * The argv of a spawn of `env` with the sealed PATH and the runner's variables forced in, so `env -i` (which throws
 * the environment away), `env -u PATH` / `--unset=PATH` (which removes PATH) and `env PATH=…` (which resets it)
 * cannot search the system's folders past the traps. `env`
 * reads OPTIONS, then NAME=VALUE assignments, then the COMMAND: a PATH among the assignments is sealed in place (the
 * test's own folders kept first, the traps after them), and when `-i` cleared the environment (or `-u PATH` removed
 * it) the sealed PATH, and for `-i` the runner's variables, are added just before the command. An `env` that leaves PATH alone is left as it is
 * (its child inherits the already-sealed environment). `-S`/`--split-string`, whose string holds the whole command,
 * and any option this does not know, are left to the grep rule and said as not covered at the head of this file.
 */
function sealEnvArgv(argv) {
  if (!process.env.HOPRIG_TEST_TRAPS) return argv;
  let i = 0;
  let cleared = false;   // -i / --ignore-environment / a lone '-': the whole environment is thrown away
  let unsetPath = false; // -u PATH / --unset=PATH / -uPATH: PATH alone is removed, so a sealed one must go back
  for (; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--') { i++; break; } // end of options; what follows is assignments then the command
    if (a === '-') { cleared = true; continue; } // a lone '-' clears the environment, like -i
    if (!a.startsWith('-')) break; // a NAME=VALUE assignment or the command
    if (/^(-S|--split-string)/.test(a)) return argv; // the command is inside the option's string: cannot reach it
    if (a.startsWith('--')) {
      if (a === '--ignore-environment') { cleared = true; continue; }
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      if (name === 'unset') { // --unset=NAME or --unset NAME: PATH among them is a reset
        if ((eq >= 0 ? a.slice(eq + 1) : String(argv[++i] ?? '')) === 'PATH') unsetPath = true;
        continue;
      }
      if (['chdir', 'argv0', 'default-signal', 'block-signal', 'ignore-signal'].includes(name)) { if (eq < 0) i++; continue; } // takes a value
      if (['null', 'debug', 'version', 'help'].includes(name)) continue;
      return argv; // a long option this does not know
    }
    // A short-option cluster, scanned letter by letter: -u, -C and -a take a value (the rest of the cluster, else the
    // next argument), and -u PATH / -uPATH is a PATH reset. -i clears; -0 and -v take nothing; -S holds the command.
    let took = false;
    for (let j = 1; j < a.length && !took; j++) {
      const c = a[j];
      if (c === 'i') cleared = true;
      else if (c === '0' || c === 'v') { /* --null, --debug: no value */ }
      else if (c === 'S') return argv; // -S inside a cluster: the command is in its value, out of reach
      else if ('uCa'.includes(c)) {
        const value = j + 1 < a.length ? a.slice(j + 1) : String(argv[++i] ?? ''); // attached rest, else next argument
        if (c === 'u' && value === 'PATH') unsetPath = true;
        took = true; // the value ends the cluster
      } else return argv; // an unknown short flag
    }
    continue;
  }
  const opts = argv.slice(0, i);
  const assigns = [];
  let hadPath = false;
  for (; i < argv.length && /^[A-Za-z_]\w*=/.test(String(argv[i])); i++) {
    const a = String(argv[i]);
    if (/^PATH=/.test(a)) { hadPath = true; assigns.push(`PATH=${sealedPath(a.slice('PATH='.length))}`); }
    else assigns.push(a);
  }
  if (!cleared && !unsetPath && !hadPath) return argv; // nothing cleared or reset: the sealed environment already stands
  const inject = [];
  if (!hadPath) inject.push(`PATH=${sealedPath(undefined)}`); // -i or -u PATH wiped PATH: the traps, then the system's folders
  if (cleared) for (const k of SEAL_VARS) if (process.env[k] !== undefined) inject.push(`${k}=${process.env[k]}`);
  return [...opts, ...assigns, ...inject, ...argv.slice(i)];
}

/**
 * NODE_OPTIONS that also preloads this module, added to what the test set (never twice). It is a --require: a
 * preload runs before the child's main file and leaves how that file is loaded alone. An --import would send the
 * main file through the ES-module loader, which refuses an ending it does not know (`…/versions/2.1.328`, the shape
 * of the coding tool's own install), so such a program would not start at all under the seal.
 */
function withRequire(current) {
  const flag = `--require ${JSON.stringify(SELF)}`;
  const cur = String(current || '');
  if (cur.includes(SELF)) return cur;
  return cur ? `${cur} ${flag}` : flag;
}

/** `opts` (a child's options, possibly absent) with the environment sealed and this module carried into a Node child. */
function sealOptions(opts) {
  const base = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const env = sealed(base.env ?? process.env);
  env.NODE_OPTIONS = withRequire(env.NODE_OPTIONS);
  return { ...base, env };
}

/**
 * `opts` of a worker thread with the seal kept: an env object of its own sealed (the traps, the runner's variables and
 * NODE_OPTIONS, as for a child), and an execArgv of its own given the --require of this module. Left alone: no
 * options, an absent env or execArgv (the worker then takes the parent's, which are sealed), and SHARE_ENV (the
 * parent's own environment).
 */
function sealWorkerOptions(opts, shareEnv) {
  if (!opts || typeof opts !== 'object') return opts;
  const out = { ...opts };
  if (out.env && typeof out.env === 'object' && out.env !== shareEnv) {
    out.env = sealed(out.env);
    out.env.NODE_OPTIONS = withRequire(out.env.NODE_OPTIONS);
  }
  if (Array.isArray(out.execArgv) && !out.execArgv.some((a) => String(a).includes(SELF))) out.execArgv = [...out.execArgv, '--require', SELF];
  return out;
}

/**
 * Wraps one child_process function. `program` is true when the first argument names the program to start (spawn,
 * execFile and their sync forms): then a full path to a trapped name is redirected. exec/execSync take a shell string
 * and fork a module path, so they only get the sealed environment. The options object is the first non-array object
 * among the arguments; when there is none, one is inserted before any callback. With `shell: true` the first argument
 * is a COMMAND STRING, not a program path (`spawnSync('touch /tmp/x', { shell: true })`), so it is left for the shell
 * to find on the sealed PATH (the traps are first); a full path inside a shell string is the documented residual.
 */
/**
 * Windows: what a start of `cmd` must become so that a trapped program is answered as its trap answers, or null.
 * Node starts a bare name on Windows only as `.com` or `.exe`, and a `.cmd` not at all without a shell, so the traps,
 * which are `.cmd` files there (tools/test-traps.mjs), were never reached by a start of the program itself: a test
 * that started `sudo` got ENOENT where the computer has none, and would have started the real `sudo.exe` or
 * `winget.exe` where it has one, with no trap line. So a trapped name, bare or sent to the trap folder by trapPath,
 * is answered here: npm goes to the npm trap (which passes on a call that stays on the computer), any other name to a
 * Node child that says what the trap says and exits as it does; `log` is the trap line the wrap writes. A test's own
 * stand-in, the first match on the child's PATH and in the test's area, still runs. `exists` and `isOwn` are the
 * system's answers, so a test gives Windows' own on any system.
 */
function windowsTrap(cmd, args, { env = {}, traps = process.env.HOPRIG_TEST_TRAPS, platform = process.platform, exists = fs.existsSync, isOwn = inTmp, node = process.execPath, npmTrap = NPM_TRAP } = {}) {
  if (platform !== 'win32' || typeof cmd !== 'string' || !traps) return null;
  const name = trapName(cmd);
  if (!TRAP_NAMES.has(name)) return null;
  const p = path.win32;
  const inTraps = (f) => p.resolve(p.dirname(f)).toLowerCase() === p.resolve(traps).toLowerCase();
  if (/[\\/]/.test(cmd)) {
    if (!inTraps(cmd)) return null; // a full path: trapPath sent a trapped one to the trap folder, and left the test's own
  } else {
    // What Node itself would start: the first folder of PATH that holds the name as given when it has an extension,
    // else the name with .com or .exe. A file without an extension (a shell-script stand-in) or a .cmd it never
    // starts, so such a stand-in first on PATH does not hide a real .exe later on it (Windows 11 has a sudo.exe).
    // Only when Node's pick is the test's own stand-in does it run.
    const found = Object.entries(env || {}).find(([k]) => k.toUpperCase() === 'PATH');
    const exts = /\.[^.\\/]+$/.test(cmd) ? [''] : ['.com', '.exe'];
    let pick = null;
    for (const d of String((found && found[1]) || '').split(';').filter(Boolean)) {
      pick = exts.map((e) => p.join(d, cmd + e)).find((f) => exists(f)) || null;
      if (pick) break;
    }
    if (pick && !inTraps(pick) && isOwn(pick)) return null; // the test's own stand-in is what Node starts: it runs
  }
  const rest = (Array.isArray(args) ? args : []).map(String);
  if (name === 'npm') return { command: node, args: [npmTrap, p.join(traps, 'npm-trap.json'), ...rest], log: null };
  // A stand-in, as df, ps and ss are elsewhere (tools/seal-standins.cjs): `winget --version` is how the product asks
  // whether winget starts (src/setup/system.mjs wingetState), at every look at a Windows computer, also where a test
  // hands no facts. The answer is the same on every test computer: winget does not start here (the exit the trap gives
  // too, so no test's result changes). No trap line: nothing of the computer was asked. Any other winget call (an
  // install) is stopped and named as before.
  if (name === 'winget' && rest.length === 1 && rest[0] === '--version') {
    const say = 'winget: not started by the test runner (a test computer has no winget of its own)\n';
    return { command: node, args: ['-e', `process.stderr.write(${JSON.stringify(say)}); process.exit(${TRAP_EXIT})`], log: null };
  }
  const say = `${name}: stopped by the test runner: a test reached the real ${name}\n`;
  return { command: node, args: ['-e', `process.stderr.write(${JSON.stringify(say)}); process.exit(${TRAP_EXIT})`], log: [name, rest.join(' ')] };
}

// The same quoting rules as src/winspawn.mjs (cmdArgument, windowsSpawnPlan): this file is CommonJS and runs where
// require() of an ES module does not, so they are written out here; test/seal-windows.test.mjs checks both give the
// same line.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function cmdLine(file, args) {
  const arg = (x) => {
    let a = String(x).replace(/\r\n|[\r\n]/g, ' ');
    a = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
    return `"${a}"`.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
  };
  return `"${[file.replace(CMD_META, '^$1'), ...args.map(arg)].join(' ')}"`;
}

/** The first line of `file` (its first 200 bytes), or '' when it cannot be read. */
function firstLineOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(200);
    return buf.subarray(0, fs.readSync(fd, buf, 0, 200, 0)).toString('utf8').split(/\r?\n/)[0];
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

const pathOf = (env) => { const f = Object.entries(env || {}).find(([k]) => k.toUpperCase() === 'PATH'); return String((f && f[1]) || ''); };

/**
 * Windows: the `sh.exe` (Git for Windows) on `PATH` (a Windows PATH string), in a folder that is neither the test's
 * own area nor the trap folder, or null.
 */
function windowsSh(PATH, { traps = process.env.HOPRIG_TEST_TRAPS, exists = fs.existsSync, isOwn = inTmp } = {}) {
  const p = path.win32;
  for (const d of String(PATH || '').split(';').filter(Boolean)) {
    if (isOwn(d) || (traps && p.resolve(d).toLowerCase() === p.resolve(traps).toLowerCase())) continue;
    const f = p.join(d, 'sh.exe');
    if (exists(f)) return f;
  }
  return null;
}

/**
 * Windows: how to start a test's own stand-in that Node would not start, or null. Node starts a bare name there only
 * as `.com` or `.exe`, a `.cmd`/`.bat` not at all without a shell, and an extensionless file by a full path not at
 * all; so a stand-in a test writes as a `#!/bin/sh` script (fakeBin and the like) never ran. Only the test's own file
 * counts: a bare name whose FIRST holder on the child's PATH is a folder of the test's area (not the trap folder)
 * with no `.com`/`.exe` of it there, or a full path into that area. An extensionless file whose first line is `#!`
 * starts through `sh <file> <args…>` (Git for Windows' sh, found on the child's PATH, else on the test process's own,
 * outside the test's area and the traps), or through this Node when the line names node; a `.cmd`/`.bat` through
 * `cmd.exe /d /s /c` with every argument escaped as src/winspawn.mjs does. A program of the computer, a file Node
 * starts itself, a trapped name (windowsTrap answers it first) and every other system are left as they are. `exists`,
 * `isOwn`, `firstLine` and `processPath` are the system's answers, so a test gives Windows' own on any system.
 */
function windowsStandIn(cmd, args, { env = {}, cwd, traps = process.env.HOPRIG_TEST_TRAPS, platform = process.platform, exists = fs.existsSync, isOwn = inTmp, firstLine = firstLineOf, node = process.execPath, processPath = pathOf(process.env), comspec } = {}) {
  if (platform !== 'win32' || typeof cmd !== 'string' || !traps || !cmd) return null;
  const p = path.win32;
  const inTraps = (f) => p.resolve(p.dirname(f)).toLowerCase() === p.resolve(traps).toLowerCase();
  const ext = (/\.[^.\\/]+$/.exec(cmd) || [''])[0].toLowerCase();
  if (ext === '.com' || ext === '.exe') return null; // Node starts it itself
  let file = null;
  if (/[\\/]/.test(cmd)) {
    const full = p.resolve(cwd || process.cwd(), cmd);
    if (inTraps(full) || !isOwn(full) || !exists(full)) return null;
    file = full;
  } else {
    for (const d of pathOf(env).split(';').filter(Boolean)) {
      if (!ext && ['.com', '.exe'].some((e) => exists(p.join(d, cmd + e)))) return null; // Node's own pick
      const held = (ext ? [cmd] : [cmd, `${cmd}.cmd`, `${cmd}.bat`]).map((n) => p.join(d, n)).find((f) => exists(f));
      if (!held) continue;
      if (inTraps(held) || !isOwn(held)) return null; // the first holder is the computer's or a trap: as before
      file = held;
      break;
    }
    if (!file) return null;
  }
  const rest = (Array.isArray(args) ? args : []).map(String);
  if (/\.(cmd|bat)$/i.test(file)) {
    return { command: comspec || env.ComSpec || env.COMSPEC || process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', cmdLine(file, rest)], verbatim: true };
  }
  if (/\.[^.\\/]+$/.test(file)) return null; // another extension: not a stand-in this knows
  const line = firstLine(file);
  if (!line.startsWith('#!')) return null;
  const words = line.slice(2).trim().split(/\s+/);
  const prog = p.basename(words[0] || '') === 'env' ? words[1] : p.basename(words[0] || '');
  if (prog === 'node') return { command: node, args: [file, ...rest], verbatim: false };
  if (!['sh', 'bash', 'dash'].includes(prog)) return null;
  const sh = windowsSh(pathOf(env), { traps, exists, isOwn }) || windowsSh(processPath, { traps, exists, isOwn });
  if (!sh) return null;
  return { command: sh, args: [file.replace(/\\/g, '/'), ...rest], verbatim: false }; // C:/… : read the same by sh and by Windows
}

/**
 * Windows: what a start of `cmd` becomes, or null. A test's own stand-in that is the FIRST holder of the name on the
 * child's PATH and that can be started (windowsStandIn) runs, as it does on Linux, also under a trapped name (`gh`,
 * `docker` and `tailscale` are trapped, and most stand-ins are those). Every other start of a trapped name goes to its
 * trap (windowsTrap): the trap folder before the stand-in, a `.com`/`.exe` of the name before it, a stand-in outside
 * the test's area, or no sh to start it with (Node would then pass it by and start a real one later on PATH).
 */
function windowsStart(cmd, args, o = {}) {
  const own = windowsStandIn(cmd, args, o);
  if (own) return { command: own.command, args: own.args, log: null, verbatim: own.verbatim };
  return windowsTrap(cmd, args, o);
}

/**
 * The environment of a stand-in started through Git for Windows' sh: `noglob` added to MSYS (to the value that is
 * there, space separated; a caller that asks for `glob` itself keeps it). The MSYS runtime expands wildcards in the
 * arguments a native caller hands it, and an argument such as `.[].login` ends sh with an access violation before the
 * script runs; a POSIX exec never expands arguments, so with noglob the stand-in gets them as it does on Linux.
 */
function msysNoglob(env) {
  const out = { ...(env || {}) };
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'MSYS') || 'MSYS';
  const words = String(out[key] || '').split(/\s+/).filter(Boolean);
  if (!words.includes('noglob') && !words.includes('glob')) words.push('noglob');
  out[key] = words.join(' ');
  return out;
}

function wrap(orig, program) {
  return function sealedChild(...args) {
    let at = -1;
    for (let i = 1; i < args.length; i++) {
      if (args[i] && typeof args[i] === 'object' && !Array.isArray(args[i])) { at = i; break; }
    }
    const shell = at >= 0 && args[at].shell;
    if (program && !shell && typeof args[0] === 'string') {
      args[0] = trapPath(args[0], at >= 0 ? args[at].cwd : undefined, Array.isArray(args[1]) ? args[1] : []);
      // An `env` that clears or resets PATH is sealed in its own argv (a shell string is not reached: the grep rule).
      if (trapName(args[0]) === 'env' && Array.isArray(args[1])) args[1] = sealEnvArgv(args[1]);
    }
    if (at >= 0) args[at] = sealOptions(args[at]);
    else {
      const cb = args.findIndex((a, i) => i >= 1 && typeof a === 'function');
      if (cb >= 0) args.splice(cb, 0, sealOptions());
      else args.push(sealOptions());
    }
    if (program && !shell && process.platform === 'win32' && typeof args[0] === 'string') {
      const opts = args.find((a, i) => i >= 1 && a && typeof a === 'object' && !Array.isArray(a));
      const plan = windowsStart(args[0], Array.isArray(args[1]) ? args[1] : [], { env: opts && opts.env, cwd: opts && opts.cwd });
      if (plan) {
        if (plan.log) logForbidden(plan.log[0], plan.log[1]);
        args[0] = plan.command;
        if (Array.isArray(args[1])) args[1] = plan.args;
        else args.splice(1, 0, plan.args);
        if (opts && plan.verbatim) opts.windowsVerbatimArguments = true;
        else if (opts) delete opts.windowsVerbatimArguments;
        if (opts && path.win32.basename(plan.command).toLowerCase() === 'sh.exe') opts.env = msysNoglob(opts.env);
      }
    }
    return orig.apply(this, args);
  };
}

if (process.env.HOPRIG_TEST_TRAPS && !isRunner) {
  cp.spawn = wrap(cp.spawn, true);
  cp.spawnSync = wrap(cp.spawnSync, true);
  cp.execFile = wrap(cp.execFile, true);
  cp.execFileSync = wrap(cp.execFileSync, true);
  cp.exec = wrap(cp.exec, false);
  cp.execSync = wrap(cp.execSync, false);
  cp.fork = wrap(cp.fork, false);
  // exec and execFile carry a util.promisify.custom that returns a promise with a `.child`; the plain wrapper above
  // drops it, so `promisify(execFile)(...).child` would be undefined. Re-attach one that calls the wrapped function
  // (the promisified form stays sealed) and exposes `.child`, as node's own does.
  for (const name of ['exec', 'execFile']) {
    const wrapped = cp[name];
    cp[name][promisify.custom] = (...a) => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.child = wrapped(...a, (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
        else resolve({ stdout, stderr });
      });
      return promise;
    };
  }
  // The listing of /proc (Linux) holds the test's own processes only: the Operator's look and the session tools find
  // processes there, not through ps, and would read every other process of the computer, another run's tmux server
  // among them. Only the listing of the folder itself is narrowed; a read of /proc/<pid> by a pid is left as it is. A
  // test that needs the whole table says so (HOPRIG_SEAL_REAL=proc, test/seal-rule.mjs lists it).
  if (process.platform === 'linux') {
    const readdirSync = fs.readdirSync;
    fs.readdirSync = function sealedReaddir(p, ...rest) {
      const out = readdirSync.call(this, p, ...rest);
      if (typeof p !== 'string' || path.resolve(p) !== '/proc' || realAsked().includes('proc') || !Array.isArray(out)) return out;
      const own = ownTree(process.env.HOPRIG_TEST_PID || process.pid, { readdir: readdirSync });
      return out.filter((e) => { const n = String(typeof e === 'object' && e ? e.name : e); return !/^\d+$/.test(n) || own.has(Number(n)); });
    };
  }
  // A worker thread runs the preload only when its execArgv carries it (the default is the parent's, which does), and
  // the wrap inside it only when its environment names the traps (the default is a copy of the parent's, which does).
  // A worker given its own `env` or `execArgv: []` would lose either, and its children would be found on whatever
  // PATH it was handed. So its env is sealed like a child's and the --require is put back into its execArgv.
  const wt = require('node:worker_threads');
  const Worker = wt.Worker;
  wt.Worker = class SealedWorker extends Worker {
    constructor(filename, options) { super(filename, sealWorkerOptions(options, wt.SHARE_ENV)); }
  };
  // So that `import { spawn } from 'node:child_process'` sees the wrapped function too, not only `import cp from …`.
  syncBuiltinESMExports();
  // No connection to a default port of the product (tools/seal-net.mjs). The refusal is written into the traps' log
  // (its path is in the npm trap's settings), so the runner fails the run by name as it does for a trap.
  const ports = [...defaultPorts(), ...extraPorts(process.env.HOPRIG_SEAL_EXTRA_PORTS).map((port) => ({ port, what: 'a port the run named in HOPRIG_SEAL_EXTRA_PORTS' }))];
  refusePorts(ports, ({ port, what, host }) => logForbidden('knock', `${port} ${host} ${what}`));
}

module.exports = { trapAlong, systemAlong, logForbidden, allowFullPath, windowsTrap, windowsStandIn, windowsStart, windowsSh, msysNoglob };
