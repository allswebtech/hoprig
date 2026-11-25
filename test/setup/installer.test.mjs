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
import { sealed, sealedPath } from '../seal.mjs';

const s = scratch();
test.after(s.cleanup);
const { which } = await import('../../src/setup/system.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The stand-in npm answers what the installer asks and writes down each install command; "installing" puts a
// hoprig command into the prefix, which the installer then starts with `setup`.
const prefix = path.join(s.tmp, 'prefix');
const log = path.join(s.tmp, 'npm.log');
// install.sh asks `id -u` who runs it: the stand-in answers the user id the test plays (an ordinary user by default),
// so the user that runs the suite never decides what is tested.
const idStandIn = '[ "$1" = -u ] && { echo "${FAKE_UID:-1000}"; exit 0; }; exit 1';
const bin = fakeBin(path.join(s.tmp, 'installer-bin'), {
  id: idStandIn,
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
const PATH = sealedPath(`${pathWith(s.tmp, bin)}:/usr/bin:/bin:/usr/sbin:/sbin`);
const has = (c) => !!which(c, { PATH }, process.platform);
// The installer installs what is missing (a downloader; on Linux the build tools). A test must never get there.
const complete = (has('curl') || has('wget')) && (process.platform !== 'linux' || (has('make') && (has('g++') || has('c++')) && has('python3')));
const skip = process.platform === 'win32' ? 'install.sh is for macOS and Linux' : !complete && 'this computer lacks something the installer would install (curl or wget; on Linux make, g++, python3)';

function install(npmVersion, source) {
  fs.rmSync(log, { force: true });
  const out = execFileSync('sh', [path.join(ROOT, 'install.sh'), '--yes'], {
    env: sealed({ PATH, HOME: s.env.HOME, FAKE_NPM_VERSION: npmVersion, ...(source ? { HOPRIG_SOURCE: source } : {}) }),
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
function bareComputer(name, { first = [], env = {} } = {}) {
  const dir = path.join(s.tmp, name);
  const pfx = path.join(dir, 'prefix');
  const rec = path.join(dir, 'record.log');
  fs.mkdirSync(pfx, { recursive: true });
  const reads = 'input=$(cat); printf \'%s read %s bytes of input\\n\' "$0" "${#input}" >> "$REC"';
  const b = fakeBin(path.join(dir, 'bin'), {
    uname: 'echo Linux',
    id: idStandIn,
    sudo: `printf 'sudo %s\\n' "$*" >> "$REC"; exec "$@"`,
    'apt-get': `printf 'apt-get %s | DEBIAN_FRONTEND=%s\\n' "$*" "\${DEBIAN_FRONTEND:-}" >> "$REC"; ${reads}`,
    curl: 'exit 0',
    npm: `case "$1" in
  --version) echo 11.20.0 ;;
  prefix) echo "${pfx}" ;;
  install)
    ${reads}
    printf 'npm-locale LANG=%s LC_ALL=%s\\n' "\${LANG:-}" "\${LC_ALL:-}" >> "$REC"
    printf 'npm %s\\n' "$*" >> "$REC"
    mkdir -p "${pfx}/bin"
    printf '#!/bin/sh\\necho "hoprig-stand-in $*"\\n' > "${pfx}/bin/hoprig"
    chmod +x "${pfx}/bin/hoprig" ;;
esac`,
  });
  for (const tool of ['sh', 'sed', 'mktemp', 'tail', 'rm', 'env', 'cat', 'mkdir', 'chmod', 'grep']) {
    const real = which(tool, { PATH: '/usr/bin:/bin' }, process.platform); // seal: a value no program is started with
    if (real) fs.symlinkSync(real, path.join(b, tool));
  }
  return { env: sealed({ PATH: pathWith(s.tmp, ...first, b), HOME: s.env.HOME, REC: rec, HOPRIG_SOURCE: 'hoprig', ...env }), record: () => fs.readFileSync(rec, 'utf8') };
}

/** Run install.sh without a terminal (its own session, so /dev/tty cannot be opened): from the file, or piped. */
function installBare(pc, { piped, args = ['--yes'] }) {
  const file = path.join(ROOT, 'install.sh');
  return new Promise((resolve) => {
    const child = spawn('sh', piped ? ['-s', '--', ...args] : [file, ...args], { env: pc.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

test('install.sh: a locale the computer lacks is said once, and the rest runs with C.UTF-8', { skip: posixOnly }, async () => {
  const pc = bareComputer('locale');
  fs.writeFileSync(path.join(s.tmp, 'locale', 'bin', 'locale'), "#!/bin/sh\n[ \"$1\" = -a ] && printf 'C\\nC.utf8\\nPOSIX\\n'\n", { mode: 0o755 });
  // The system it says the fix for is named by a release file of the test's own (not the computer running the tests).
  const release = path.join(s.tmp, 'locale', 'os-release');
  fs.writeFileSync(release, 'ID=ubuntu\nID_LIKE=debian\n');
  pc.env = { ...pc.env, LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', HOPRIG_OS_RELEASE: release };
  const r = await installBare(pc, { piped: false });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.out.split('\n').filter((l) => /locale/i.test(l)), ['! The locale en_GB.UTF-8 (LC_ALL, sent by your terminal) is not on this computer: the installer and set-up run with C.UTF-8. Fix: sudo locale-gen en_GB.UTF-8']);
  // Debian's locale-gen takes no name; a value with no language part (macOS's LC_CTYPE=UTF-8) is changed on your side.
  fs.writeFileSync(release, 'ID=debian\n');
  const deb = await installBare(pc, { piped: false });
  assert.deepEqual(deb.out.split('\n').filter((l) => /locale/i.test(l)), ['! The locale en_GB.UTF-8 (LC_ALL, sent by your terminal) is not on this computer: the installer and set-up run with C.UTF-8. Fix: sudo dpkg-reconfigure locales (choose en_GB.UTF-8)']);
  const { LANG: _l, LC_ALL: _a, ...rest } = pc.env;
  const mac = await installBare({ ...pc, env: { ...rest, LC_CTYPE: 'UTF-8' } }, { piped: false });
  assert.deepEqual(mac.out.split('\n').filter((l) => /locale/i.test(l)), ['! The locale UTF-8 (LC_CTYPE, sent by your terminal) is not on this computer: the installer and set-up run with C.UTF-8. Fix: export LC_CTYPE=C.UTF-8 in your shell\'s start file on this computer, or stop your ssh client sending it (SendEnv LC_* in its ssh config)']);
  assert.deepEqual([...new Set(pc.record().split('\n').filter((l) => l.startsWith('npm-locale ')))], ['npm-locale LANG=C.UTF-8 LC_ALL='], 'npm and set-up after it get the working one');
  // a locale that is there: not a word, nothing changed
  const ok = bareComputer('locale-ok');
  fs.writeFileSync(path.join(s.tmp, 'locale-ok', 'bin', 'locale'), "#!/bin/sh\nprintf 'C\\nen_GB.utf8\\n'\n", { mode: 0o755 });
  ok.env = { ...ok.env, LANG: 'en_GB.UTF-8' };
  const r2 = await installBare(ok, { piped: false });
  assert.equal(r2.code, 0, r2.out);
  assert.doesNotMatch(r2.out, /locale/i);
  assert.match(ok.record(), /npm-locale LANG=en_GB\.UTF-8 LC_ALL=\n/);
});

test('install.sh: a locale the computer lacks on a computer with no os-release file (macOS, a minimal image) is said and the run goes on', { skip: posixOnly }, async () => {
  const pc = bareComputer('locale-norelease');
  fs.writeFileSync(path.join(s.tmp, 'locale-norelease', 'bin', 'locale'), "#!/bin/sh\n[ \"$1\" = -a ] && printf 'C\\nC.utf8\\nPOSIX\\n'\n", { mode: 0o755 });
  // sh is the system's own (dash on Debian and Ubuntu): there `.` of a missing file ends the shell it runs in.
  pc.env = { ...pc.env, LANG: 'xx_YY.UTF-8', LC_ALL: 'xx_YY.UTF-8', HOPRIG_OS_RELEASE: path.join(s.tmp, 'locale-norelease', 'no-such-os-release') };
  const r = await installBare(pc, { piped: false });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.out.split('\n').filter((l) => /locale/i.test(l)), ['! The locale xx_YY.UTF-8 (LC_ALL, sent by your terminal) is not on this computer: the installer and set-up run with C.UTF-8. Fix: sudo dpkg-reconfigure locales (choose xx_YY.UTF-8)']);
  assert.match(r.out, /hoprig-stand-in setup --yes/, 'the whole script ran, to its last line');
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
  // outside main and its functions nothing is set: an assignment at the top would run before the last line is read
  assert.deepEqual(lines.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)), []);
  // after main and the functions it calls: two helpers on one line each, and the call, in one group the shell reads
  // whole before running it
  assert.deepEqual(lines.slice(end + 1).filter((l) => l.trim() && !l.startsWith('#')), [
    'have() { command -v "$1" >/dev/null 2>&1; }',
    'can_ask() { (: </dev/tty) 2>/dev/null; }',
    '{', '  main "$@"', '  exit $?', '}',
  ]);
  // cut anywhere, the file either does nothing or is not valid shell: try a cut every 40 lines
  for (let n = 5; n < lines.length - 1; n += 40) {
    const cut = lines.slice(0, n).join('\n') + '\n';
    const r = spawnSync('sh', ['-s'], { input: cut, env: sealed({ PATH: '/usr/bin:/bin' }), encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.stdout, '', `cut after line ${n}: nothing printed, nothing run`);
  }
});

test('install.sh: no $NAME runs straight into a byte that is not ASCII (bash 3.2 in a C locale reads it as part of the name)', () => {
  // macOS's /bin/sh is bash 3.2: with set -u, "$PKGS…" in a locale it cannot load stops the script with
  // "PKGS\xE2: unbound variable". ${PKGS}… is read the same in every shell and every locale.
  const bytes = fs.readFileSync(path.join(ROOT, 'install.sh'));
  const lines = bytes.toString('latin1').split('\n');
  const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]/.test(l)).map(([n]) => n);
  assert.deepEqual(bad, [], 'lines with $NAME before a byte that is not ASCII: write ${NAME}');
});

test('install.ps1 follows the same rule (read, not run: no PowerShell here)', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  assert.match(ps, /\$npmMajor -ge 12 -and -not \(Test-Path -LiteralPath \$Source\)/);
  assert.match(ps, /\$npmAllow = @\('--allow-git=root'\)/);
  assert.match(ps, /\$npmAllow = @\('--allow-remote=root'\)/);
  assert.match(ps, /& npm install -g @npmAllow --no-audit --no-fund \$Source/);
});

test('install.sh: a readable os-release that does not parse is read past, not fatal', { skip: posixOnly }, async () => {
  const pc = bareComputer('locale-badrelease');
  fs.writeFileSync(path.join(s.tmp, 'locale-badrelease', 'bin', 'locale'), "#!/bin/sh\n[ \"$1\" = -a ] && printf 'C\nC.utf8\nPOSIX\n'\n", { mode: 0o755 });
  const rel = path.join(s.tmp, 'locale-badrelease', 'os-release');
  fs.writeFileSync(rel, 'ID=ubuntu\nif then fi\n'); // a line a POSIX shell cannot parse: `.` aborts the subshell
  pc.env = { ...pc.env, LANG: 'xx_YY.UTF-8', LC_ALL: 'xx_YY.UTF-8', HOPRIG_OS_RELEASE: rel };
  const r = await installBare(pc, { piped: false });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /The locale xx_YY\.UTF-8 \(LC_ALL, sent by your terminal\) is not on this computer/);
  assert.match(r.out, /hoprig-stand-in setup --yes/, 'the whole script ran, to its last line');
});

// Root (uid 0, played by the stand-in id): said before anything is installed. The container files are the computer's
// own paths, looked at as files only: where the computer running the tests has one, the plain-root case cannot be played.
const CONTAINER_FILES = ['/.dockerenv', '/run/.containerenv', '/run/systemd/container'];
const inContainer = CONTAINER_FILES.some((f) => fs.existsSync(f));
const asRoot = (pc, extra = {}) => ({ ...pc, env: { ...pc.env, FAKE_UID: '0', ...extra } });
const installed = (rec) => rec.split('\n').filter((l) => /^(apt-get|npm|sudo) /.test(l) && !/read \d+ bytes/.test(l));

// The work user that root's set-up makes has its own tests (installroot.test.mjs). Here: piped with no terminal and no
// --yes, on a computer without the programs that make a user, nothing is installed and the way to stay root is said.
test('install.sh as root, not in a container and without --stay-root: installs nothing, exits non-zero, says what to run', { skip: posixOnly || (inContainer && 'this computer is a container') }, async () => {
  const pc = bareComputer('root-plain');
  fs.writeFileSync(path.join(s.tmp, 'root-plain', 'record.log'), '');
  const r = await installBare(asRoot(pc), { piped: true });
  assert.notEqual(r.code, 0, r.out);
  // Piped: there is no install.sh file, so the advice names the piped command.
  assert.match(r.out, /^hoprig installer: this is root, .*Nothing was made\. To keep Hoprig on root instead: curl -fsSL \S+\/install\.sh \| sh -s -- --stay-root$/m);
  assert.doesNotMatch(r.out, /Run this installer as an ordinary user/, 'never the advice to use a user he does not have');
  assert.deepEqual(installed(pc.record()), [], 'no package manager, no sudo, no npm was asked');
  assert.doesNotMatch(r.out, /hoprig-stand-in/, 'set-up was not started');
});

test('install.sh as root with --stay-root: said first, then installed as before, and set-up gets the choice', { skip: posixOnly || (inContainer && 'this computer is a container') }, async () => {
  const pc = bareComputer('root-stay');
  const r = await installBare(asRoot(pc), { piped: false, args: ['--yes', '--stay-root'] });
  assert.equal(r.code, 0, r.out);
  const said = r.out.indexOf('· This is root, kept on root by your choice (--stay-root). Claude Code refuses bypass permissions mode for root; the modes that ask still start.');
  assert.ok(said >= 0, r.out);
  assert.ok(said < r.out.indexOf('To install:'), 'said before anything is installed');
  // as root the package manager runs without sudo
  assert.deepEqual(installed(pc.record()).filter((l) => l.startsWith('sudo ')), []);
  assert.match(r.out, /hoprig-stand-in setup --yes --stay-root/);
});

test('install.sh as root inside a container (the variable container): stays on root, naming the fact', { skip: posixOnly || (inContainer && 'this computer is a container: its own file would be named') }, async () => {
  const pc = bareComputer('root-container');
  const r = await installBare(asRoot(pc, { container: 'podman' }), { piped: false });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^· This is root, inside a container \(container=podman\): Hoprig stays on root here\./m);
  assert.ok(r.out.indexOf('This is root') < r.out.indexOf('To install:'));
  assert.match(r.out, /hoprig-stand-in setup --yes\n/);
});

test('install.sh with a Node.js 22 installed: says in one line what it found, installs the newest LTS with nvm for this user, and goes on with it', { skip: posixOnly }, async () => {
  const floor = /\n  MIN_NODE=(\S+) /.exec(fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'))[1];
  const fixture = path.join(ROOT, 'test', 'fixtures', 'runner', 'node-version.mjs');
  const dir = path.join(s.tmp, 'old-node');
  // A node that reports 22.11.0 first on PATH; nvm a stand-in that writes down what it is asked and, on `use`, puts a
  // node that reports a newer LTS first on PATH, as the real nvm does. Nothing is downloaded or installed.
  const old = fakeBin(path.join(dir, 'old'), { node: `SEAL_FAKE_NODE=22.11.0 exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(fixture)} "$@"` });
  const lts = fakeBin(path.join(dir, 'lts'), { node: `SEAL_FAKE_NODE=26.1.0 exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(fixture)} "$@"` });
  const nvmDir = path.join(dir, 'nvm');
  fs.mkdirSync(nvmDir, { recursive: true });
  fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), `nvm() {\n  printf 'nvm %s\\n' "$*" >> "$REC"\n  case $1 in use) PATH=${JSON.stringify(lts)}:$PATH; export PATH ;; esac\n  return 0\n}\n`);
  const pc = bareComputer('old-node-pc', { first: [old], env: { NVM_DIR: nvmDir } });
  const r = await installBare(pc, { piped: false });
  assert.equal(r.code, 0, r.out);
  const found = r.out.split('\n').filter((l) => l.startsWith('Found Node.js'));
  assert.deepEqual(found, [`Found Node.js 22.11.0, older than ${floor}, the lowest Hoprig runs on: the newest long-term release of Node.js goes in its place, for you only, with nvm.`]);
  assert.ok(r.out.indexOf('Found Node.js') < r.out.indexOf('To install:'), 'said before the list of what is installed');
  assert.match(r.out, /\n {2}Node\.js LTS, for you only, with nvm v[\d.]+ in /);
  assert.deepEqual(pc.record().split('\n').filter((l) => l.startsWith('nvm ')), ['nvm install --lts --no-progress', 'nvm use --lts']);
  assert.match(r.out, /\n✓ Node\.js v\d+/);
  assert.match(r.out, /hoprig-stand-in setup --yes\n/, 'hoprig is installed and set up with the new Node.js');
  // A Node.js at the floor is kept: no line about it and no nvm.
  const keep = fakeBin(path.join(dir, 'floor'), { node: `SEAL_FAKE_NODE=${floor} exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(fixture)} "$@"` });
  const again = bareComputer('floor-node-pc', { first: [keep], env: { NVM_DIR: nvmDir } });
  const r2 = await installBare(again, { piped: false });
  assert.equal(r2.code, 0, r2.out);
  assert.doesNotMatch(r2.out, /Found Node\.js|Node\.js LTS/);
  assert.ok(!/^nvm /m.test(again.record()), 'nvm is not asked');
});
