// The seal of tools/test.mjs: no test reaches the real system of the computer that runs it.
//
// A folder of traps comes FIRST on the PATH of every test file's process: sudo, systemctl, loginctl, the package
// managers, and npm for anything global. A trap does nothing but write one line (the program, its arguments, the test
// file) into the runner's log and exit with a code of its own; the runner then fails the run by name. Without this a
// test run with a half-made change once sent its npm stand-ins to the real npm (a package installed globally, a
// running program's folder half deleted) and ran the real, passwordless sudo. A test that needs one of these programs
// puts a stand-in of its own BEFORE the traps (test/seal.mjs).
//
// npm is trapped only for a call that changes or reads the computer's own npm folder: -g (also inside short flags such
// as -gf), --global, --location=global, link, a --prefix outside the temporary folder, or npm_config_global or
// npm_config_location=global in the environment. Every other npm call (npm --version, an install into a temporary
// folder) goes on to the npm that comes next on the caller's PATH. npm_config_prefix alone is not a sign: `npm test`
// sets it to the computer's global folder for every script, and npm reads it only for a global call.
//
// A call that goes on gets npm's cache and log folder under the test's own home, whatever `npm test` set (it sets
// npm_config_cache to the person's ~/.npm, where npm then wrote a debug log for every call), and no way to a registry
// that is not on this computer: its registry and its proxy are a refusing stand-in of this trap's own on 127.0.0.1, so
// a call that needs the network is written down ("registry") and the runner fails the run by name. A registry the test
// runs itself on this computer (npm_config_registry on 127.0.0.1 or localhost) is left as it is.
//
// Run as a program, this file is the npm trap: node tools/test-traps.mjs <its settings file> <npm's arguments>.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The trapped names, the made-up ones and the exit code live in tools/seal-core.cjs (one copy for the wrap too).
import { extraTraps, TRAP_EXIT, TRAPPED, UNKNOWN_FILE } from './seal-core.mjs';

export { extraTraps, TRAP_EXIT, TRAPPED, UNKNOWN_FILE };

const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** True when `p` (resolved against `cwd`) lies inside one of `roots`. A path that climbs with ".." never does. */
function inside(p, roots, cwd, platform) {
  if (!p || /(^|[\\/])\.\.([\\/]|$)/.test(p)) return false;
  const norm = (x) => (platform === 'win32' ? x.toLowerCase() : x);
  const full = norm(isAbsolute(p) ? resolve(p) : resolve(cwd, p));
  return roots.map(norm).some((r) => full === r || full.startsWith(r.endsWith(sep) ? r : r + sep));
}

const truthy = (v) => v !== undefined && !/^(false|0|)$/i.test(String(v).trim());

/**
 * Whether this npm call is global: it changes or reads the computer's own npm folder, not a temporary one.
 * `args` are npm's arguments, `env` its environment, `roots` the folders a --prefix may name.
 */
export function npmIsGlobal(args, { env = {}, roots = [], cwd = process.cwd(), platform = process.platform } = {}) {
  const lower = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  if (truthy(lower.npm_config_global)) return true;
  if (String(lower.npm_config_location || '').trim().toLowerCase() === 'global') return true;
  let command = null;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') break; // what follows goes to a package's own script
    const [flag, value] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (flag === '-g' || (/^-[a-zA-Z]+$/.test(flag) && flag.includes('g'))) return true;
    if (flag === '--global') {
      if (value === undefined || truthy(value)) return true;
    } else if (flag === '--location') {
      if ((value ?? args[i + 1] ?? '').toLowerCase() === 'global') return true;
      if (value === undefined) i++;
    } else if (flag === '--prefix' || flag === '-C') {
      const p = value ?? args[++i];
      if (!inside(p, roots, cwd, platform)) return true;
    } else if (!a.startsWith('-') && command === null) {
      command = a;
      if (command === 'link' || command === 'ln') return true;
    }
  }
  return false;
}

/**
 * The first npm on `path` (a PATH value) AFTER the trap folder: what an allowed npm call goes on to. Only what comes
 * after it: a runner started by a test puts its own traps before this one, and going back to them would loop.
 */
function nextNpm(path, trapDir, platform = process.platform) {
  const name = platform === 'win32' ? 'npm.cmd' : 'npm';
  const dirs = String(path || '').split(delimiter);
  const at = dirs.findIndex((d) => d && resolve(d) === resolve(trapDir));
  for (const d of dirs.slice(at + 1)) {
    if (d && resolve(d) !== resolve(trapDir) && existsSync(join(d, name))) return join(d, name);
  }
  return null;
}

/**
 * Makes the trap folder `dir`. Each trap writes `<program>\t<arguments>\t<test file>` into `log`. `roots` are the
 * folders an npm --prefix may name (the temporary folder).
 */
export function makeTraps({ dir, log, roots, home = null, extra = [], platform = process.platform, node = process.execPath }) {
  mkdirSync(dir, { recursive: true });
  const realRoots = [...new Set(roots.flatMap((r) => { try { return [resolve(r), realpathSync(r)]; } catch { return [resolve(r)]; } }))];
  for (const name of [...TRAPPED, ...extra]) {
    if (platform === 'win32') writeFileSync(join(dir, `${name}.cmd`), `@echo ${name}\t%*\t%HOPRIG_TEST_FILE%>>"${log}"\r\n@echo ${name}: stopped by the test runner: a test reached the real ${name} 1>&2\r\n@exit /b ${TRAP_EXIT}\r\n`);
    else writeFileSync(join(dir, name), `#!/bin/sh\na=$(printf '%s' "$*" | tr '\\t\\n' '  ')\nprintf '%s\\t%s\\t%s\\n' ${sh(name)} "$a" "\${HOPRIG_TEST_FILE:-${UNKNOWN_FILE}}" >> ${sh(log)}\necho ${sh(`${name}: stopped by the test runner: a test reached the real ${name}`)} >&2\nexit ${TRAP_EXIT}\n`, { mode: 0o755 });
  }
  const settings = join(dir, 'npm-trap.json');
  writeFileSync(settings, JSON.stringify({ log, roots: realRoots, dir, home }));
  const self = fileURLToPath(import.meta.url);
  if (platform === 'win32') writeFileSync(join(dir, 'npm.cmd'), `@"${node}" "${self}" "${settings}" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  else writeFileSync(join(dir, 'npm'), `#!/bin/sh\nexec ${sh(node)} ${sh(self)} ${sh(settings)} "$@"\n`, { mode: 0o755 });
  return dir;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const onThisComputer = (url) => {
  try {
    return LOOPBACK.has(new URL(String(url)).hostname);
  } catch {
    return false;
  }
};

/**
 * The environment an npm call that goes on gets: `env` with npm's cache and log folder inside the test's own area
 * (its HOME when that is the test's own, else the run's home `home`), its registry and proxy at `refuser` (the trap's
 * own stand-in on 127.0.0.1) unless the test names a registry on this computer, no update check and no retry.
 */
export function npmEnv(env, { roots = [], home = null, refuser, cwd = process.cwd(), platform = process.platform } = {}) {
  const get = (name) => Object.entries(env).find(([k]) => k.toLowerCase() === name)?.[1];
  const own = (p) => typeof p === 'string' && p !== '' && isAbsolute(p) && inside(p, roots, cwd, platform);
  const registry = get('npm_config_registry');
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/^npm_config_(cache|logs_dir|registry|proxy|https_proxy|noproxy|update_notifier|fetch_retries)$/i.test(k)));
  const ownHome = own(env.HOME) ? env.HOME : home;
  const cache = own(get('npm_config_cache')) ? get('npm_config_cache') : join(ownHome || roots[0] || '.', '.npm');
  const logs = own(get('npm_config_logs_dir')) ? get('npm_config_logs_dir') : join(cache, '_logs');
  return {
    ...out,
    npm_config_cache: cache,
    npm_config_logs_dir: logs,
    npm_config_registry: registry && onThisComputer(registry) ? registry : `${refuser}/`,
    npm_config_proxy: refuser,
    npm_config_https_proxy: refuser,
    npm_config_noproxy: '127.0.0.1,localhost,::1',
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0',
  };
}

/** The lines the traps wrote, as { program, args, file }. */
export function reached(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const [program, args = '', file = ''] = l.split('\t');
    const f = file.trim();
    return { program: program.trim(), args: args.trim(), file: !f || f === '%HOPRIG_TEST_FILE%' ? UNKNOWN_FILE : f };
  });
}

/** Writes one trap line: the program, its arguments, the test file. */
function record(log, program, args) {
  const flat = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
  appendFileSync(log, `${program}\t${flat(args.join(' '))}\t${flat(process.env.HOPRIG_TEST_FILE || UNKNOWN_FILE)}\n`);
}

// The npm trap: a global call is written down and refused; every other call goes on to the real npm.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [settingsFile, ...args] = process.argv.slice(2);
  const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
  if (npmIsGlobal(args, { env: process.env, roots: s.roots })) {
    record(s.log, 'npm', args);
    process.stderr.write('npm: stopped by the test runner: a test reached the real npm for a global call\n');
    process.exit(TRAP_EXIT);
  }
  // SEAL_NEXT_NPM: the seal's own proof hands the trap a made-up npm to go on to (test/seal.test.mjs), so a run of that
  // proof without a piece of the seal never reaches the real npm. It gets what the real one would get.
  const npm = process.env.SEAL_NEXT_NPM || nextNpm(process.env.PATH ?? process.env.Path, s.dir);
  if (!npm) {
    process.stderr.write('npm: command not found\n');
    process.exit(127);
  }
  // The refusing stand-in: every request to it (a registry's, or a proxy's CONNECT for any other host) is written down
  // once for this call and answered with a refusal; nothing leaves the computer.
  let told = false;
  const tell = () => {
    if (!told) record(s.log, 'registry', args);
    told = true;
  };
  const refuse = http.createServer((req, res) => {
    req.resume();
    tell();
    res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"the test runner refuses every registry that is not on this computer"}');
  });
  refuse.on('connect', (req, socket) => {
    tell();
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((r) => refuse.listen(0, '127.0.0.1', r));
  const env = npmEnv(process.env, { roots: s.roots, home: s.home, refuser: `http://127.0.0.1:${refuse.address().port}` });
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', npm, ...args], { stdio: 'inherit', env })
    : spawn(npm, args, { stdio: 'inherit', env });
  child.on('error', (e) => {
    process.stderr.write(`npm: ${e.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    refuse.close();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}
