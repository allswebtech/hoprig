// install.sh for real, with stand-ins for npm and for the installed hoprig: which npm command it runs for each npm
// version and each kind of source. Nothing is installed and nothing leaves the scratch folder. install.ps1 cannot
// be run here: its text is checked for the same rule.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeBin, pathWith, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const { which } = await import('../../src/setup/system.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The stand-in npm answers what the installer asks and writes down each install command; "installing" puts a
// hoprig command into the prefix, which the installer then starts with `setup`.
const prefix = path.join(s.tmp, 'prefix');
const log = path.join(s.tmp, 'npm.log');
const bin = fakeBin(path.join(s.tmp, 'installer-bin'), {
  npm: `case "$1" in
  --version) echo "$FAKE_NPM_VERSION" ;;
  prefix) echo "${prefix}" ;;
  install)
    printf '%s\\n' "$*" >> "${log}"
    mkdir -p "${prefix}/bin"
    printf '#!/bin/sh\\necho "hoprig-stand-in $*"\\n' > "${prefix}/bin/hoprig"
    chmod +x "${prefix}/bin/hoprig" ;;
esac`,
});
fs.mkdirSync(prefix, { recursive: true });
const PATH = `${pathWith(s.tmp, bin)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const has = (c) => !!which(c, { PATH }, process.platform);
// The installer installs what is missing (a downloader; on Linux the build tools). A test must never get there.
const complete = (has('curl') || has('wget')) && (process.platform !== 'linux' || (has('make') && (has('g++') || has('c++')) && has('python3')));
const skip = process.platform === 'win32' ? 'install.sh is for macOS and Linux' : !complete && 'this computer lacks something the installer would install (curl or wget; on Linux make, g++, python3)';

function install(npmVersion, source) {
  fs.rmSync(log, { force: true });
  const out = execFileSync('sh', [path.join(ROOT, 'install.sh'), '--yes'], {
    env: { PATH, HOME: s.env.HOME, FAKE_NPM_VERSION: npmVersion, ...(source ? { HOPRIG_SOURCE: source } : {}) },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  assert.match(out, /hoprig-stand-in setup --yes/, 'setup is started at the end');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'one npm install');
  return lines[0];
}

test('install.sh: npm 12 gets the flag that allows the address it installs from; older npm and files get none', { skip }, () => {
  const url = 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz';
  for (const older of ['10.8.2', '10.9.9', '11.20.0']) {
    assert.equal(install(older), `install -g --no-audit --no-fund --no-update-notifier --loglevel=error ${url}`, older);
  }
  assert.equal(install('12.2.2'), `install -g --allow-remote=root --no-audit --no-fund --no-update-notifier --loglevel=error ${url}`);
  assert.equal(install('13.0.0'), `install -g --allow-remote=root --no-audit --no-fund --no-update-notifier --loglevel=error ${url}`);
  assert.match(install('12.2.2', 'git+https://example.com/team/hoprig.git'), /^install -g --allow-git=root --no-audit /);
  // a file on this computer is not an address: nothing to allow
  const tgz = path.join(s.tmp, 'hoprig-0.1.0.tgz');
  fs.writeFileSync(tgz, '');
  assert.equal(install('12.2.2', tgz), `install -g --no-audit --no-fund --no-update-notifier --loglevel=error ${tgz}`);
  // a name on npm neither
  assert.match(install('12.2.2', 'hoprig'), /^install -g --no-audit .* hoprig$/);
});

// A computer with nothing on it but what the installer itself needs to run: real basic tools by name, and
// stand-ins for the package manager, sudo, npm and the installed hoprig. `uname` says Linux, so the package step is
// exercised on any system. The stand-ins that could read their input do read it, as a package's question does.
function bareComputer(name) {
  const dir = path.join(s.tmp, name);
  const pfx = path.join(dir, 'prefix');
  const rec = path.join(dir, 'record.log');
  fs.mkdirSync(pfx, { recursive: true });
  const reads = 'input=$(cat); printf \'%s read %s bytes of input\\n\' "$0" "${#input}" >> "$REC"';
  const b = fakeBin(path.join(dir, 'bin'), {
    uname: 'echo Linux',
    sudo: `printf 'sudo %s\\n' "$*" >> "$REC"; exec "$@"`,
    'apt-get': `printf 'apt-get %s | DEBIAN_FRONTEND=%s\\n' "$*" "\${DEBIAN_FRONTEND:-}" >> "$REC"; ${reads}`,
    curl: 'exit 0',
    npm: `case "$1" in
  --version) echo 11.20.0 ;;
  prefix) echo "${pfx}" ;;
  install)
    ${reads}
    printf 'npm %s\\n' "$*" >> "$REC"
    mkdir -p "${pfx}/bin"
    printf '#!/bin/sh\\necho "hoprig-stand-in $*"\\n' > "${pfx}/bin/hoprig"
    chmod +x "${pfx}/bin/hoprig" ;;
esac`,
  });
  for (const tool of ['sh', 'id', 'sed', 'mktemp', 'tail', 'rm', 'env', 'cat', 'mkdir', 'chmod', 'grep']) {
    const real = which(tool, { PATH: '/usr/bin:/bin' }, process.platform);
    if (real) fs.symlinkSync(real, path.join(b, tool));
  }
  return { env: { PATH: pathWith(s.tmp, b), HOME: s.env.HOME, REC: rec, HOPRIG_SOURCE: 'hoprig' }, record: () => fs.readFileSync(rec, 'utf8') };
}

/** Run install.sh without a terminal (its own session, so /dev/tty cannot be opened): from the file, or piped. */
function installBare(pc, { piped }) {
  const file = path.join(ROOT, 'install.sh');
  return new Promise((resolve) => {
    const child = spawn('sh', piped ? ['-s', '--', '--yes'] : [file, '--yes'], { env: pc.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(piped ? fs.readFileSync(file) : '');
  });
}
const posixOnly = process.platform === 'win32' && 'install.sh is for macOS and Linux';

test('install.sh piped into sh without a terminal (curl … | sh): a command that reads its input cannot take the script away', { skip: posixOnly }, async () => {
  const pc = bareComputer('piped');
  const r = await installBare(pc, { piped: true });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Syntax error|unexpected/);
  assert.match(r.out, /hoprig-stand-in setup --yes/, 'the whole script ran, to its last line');
  // the stand-ins did read their input, and found none: it is no longer the script
  const rec = pc.record();
  assert.match(rec, /apt-get read 0 bytes of input/);
  assert.match(rec, /npm read 0 bytes of input/);
});

test('install.sh: the package manager is told not to ask (a question would wait for ever in a hidden log)', { skip: posixOnly }, async () => {
  const pc = bareComputer('quiet-apt');
  const r = await installBare(pc, { piped: false });
  assert.equal(r.code, 0, r.out);
  const rec = pc.record().split('\n');
  const apt = rec.filter((l) => l.startsWith('apt-get '));
  assert.deepEqual(apt.filter((l) => !/read \d+ bytes/.test(l)), [
    'apt-get update -q | DEBIAN_FRONTEND=noninteractive',
    'apt-get install -y -q build-essential python3 | DEBIAN_FRONTEND=noninteractive',
  ]);
  // through sudo for an ordinary user, with the setting inside the sudo command (sudo drops the environment)
  if (process.getuid() !== 0) {
    assert.deepEqual(rec.filter((l) => l.startsWith('sudo ')), [
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get update -q',
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q build-essential python3',
    ]);
  }
  assert.match(r.out, /To install:\n {2}build-essential python3 /);
});

test('install.sh runs nothing until its last line is read (a download that breaks off does no half install)', { skip: posixOnly }, () => {
  const text = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const lines = text.split('\n');
  const start = lines.indexOf('main() {');
  const end = lines.lastIndexOf('}', lines.lastIndexOf('{') - 1);
  assert.ok(start > 0 && end > start);
  // before main: comments and `set -eu` only
  assert.deepEqual(lines.slice(0, start).filter((l) => l.trim() && !l.startsWith('#')), ['set -eu']);
  // after main: two helpers on one line each, and the call, in one group the shell reads whole before running it
  assert.deepEqual(lines.slice(end + 1).filter((l) => l.trim() && !l.startsWith('#')), [
    'have() { command -v "$1" >/dev/null 2>&1; }',
    'can_ask() { (: </dev/tty) 2>/dev/null; }',
    '{', '  main "$@"', '  exit $?', '}',
  ]);
  // cut anywhere, the file either does nothing or is not valid shell: try a cut every 40 lines
  for (let n = 5; n < lines.length - 1; n += 40) {
    const cut = lines.slice(0, n).join('\n') + '\n';
    const r = spawnSync('sh', ['-s'], { input: cut, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.stdout, '', `cut after line ${n}: nothing printed, nothing run`);
  }
});

test('install.ps1 follows the same rule (read, not run: no PowerShell here)', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  assert.match(ps, /\$npmMajor -ge 12 -and -not \(Test-Path -LiteralPath \$Source\)/);
  assert.match(ps, /\$npmAllow = @\('--allow-git=root'\)/);
  assert.match(ps, /\$npmAllow = @\('--allow-remote=root'\)/);
  assert.match(ps, /& npm install -g @npmAllow --no-audit --no-fund \$Source/);
});
