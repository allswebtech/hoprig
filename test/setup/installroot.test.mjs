// install.sh as root (played: a stand-in `id` says 0) makes the work user and sets Hoprig up there. Every program that
// would change an account or a file under /etc is a stand-in in the test's own folder that writes what it was asked:
// useradd, install, visudo, loginctl, runuser, and rm and stat where they name /etc or /run/user. "/etc" is a folder of
// the test's own (FAKE_ETC); the passwd database is a file of the test's own read by a stand-in getent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeBin, pathWith, scratch } from './helpers.mjs';
import { sealed } from '../seal.mjs';

const s = scratch();
test.after(s.cleanup);
const { which } = await import('../../src/setup/system.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'install.sh');
const CONTAINER_FILES = ['/.dockerenv', '/run/.containerenv', '/run/systemd/container'];
const skip = process.platform !== 'linux' ? 'the work user is made on Linux' : CONTAINER_FILES.some((f) => fs.existsSync(f)) && 'this computer is a container';
const real = (tool) => which(tool, { PATH: '/usr/bin:/bin' }, process.platform); // seal: a value no program is started with
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUpKeyForTestsOnly alex@laptop';
const KEY_OPT = 'command="echo hi",no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAnotherMadeUpKey ci';

/**
 * A root server with nothing of Hoprig: its passwd file, root's home with two key lines (one with options, CRLF, no
 * newline at the end), and stand-ins. `users` adds passwd lines. → { env, record, dir, etc, passwd }
 */
function rootServer(name, { users = [], keys = `${KEY}\r\n${KEY_OPT}` } = {}) {
  const dir = path.join(s.tmp, name);
  const etc = path.join(dir, 'etc');
  const homes = path.join(dir, 'home');
  const rootHome = path.join(dir, 'root');
  const pfx = path.join(dir, 'prefix');
  const rec = path.join(dir, 'record.log');
  const owners = path.join(dir, 'owners.log');
  const passwd = path.join(dir, 'passwd');
  for (const d of [path.join(etc, 'sudoers.d'), homes, path.join(rootHome, '.ssh'), pfx]) fs.mkdirSync(d, { recursive: true });
  if (keys !== null) fs.writeFileSync(path.join(rootHome, '.ssh', 'authorized_keys'), keys, { mode: 0o600 });
  fs.writeFileSync(passwd, [`root:x:0:0:root:${rootHome}:/bin/bash`, ...users].map((l) => `${l}\n`).join(''));
  fs.writeFileSync(rec, '');
  fs.writeFileSync(owners, '');
  const map = `map() { case $1 in /etc/*) printf '%s' "$FAKE_ETC\${1#/etc}" ;; /etc) printf '%s' "$FAKE_ETC" ;; *) printf '%s' "$1" ;; esac; }`;
  // The real basic tools by name; the stand-ins of the programs that change things in a folder of their own, first.
  const tools = fakeBin(path.join(dir, 'tools'), {
    uname: 'echo Linux',
    'apt-get': 'printf \'apt-get %s\\n\' "$*" >> "$REC"',
    curl: 'exit 0',
    // The build tools are there: nothing needs a package here (the package step has its own tests).
    make: 'exit 0',
    'g++': 'exit 0',
    python3: 'exit 0',
    npm: `case "$1" in
  --version) echo 11.20.0 ;;
  prefix) echo "${pfx}" ;;
  install)
    printf 'npm %s | as %s HOME=%s\\n' "$*" "\${FAKE_UID}" "$HOME" >> "$REC"
    mkdir -p "${pfx}/bin"
    printf '#!/bin/sh\\necho "hoprig-stand-in $*"\\n' > "${pfx}/bin/hoprig"
    chmod +x "${pfx}/bin/hoprig" ;;
esac`,
  });
  for (const tool of ['sh', 'sed', 'mktemp', 'tail', 'head', 'env', 'cat', 'mkdir', 'chmod', 'grep', 'awk', 'cmp', 'ls', 'sort', 'cp', 'tar', 'gzip', 'sleep']) {
    const at = real(tool);
    if (at) fs.symlinkSync(at, path.join(tools, tool));
  }
  const admin = fakeBin(path.join(dir, 'admin'), {
    id: '[ "$1" = -u ] && { echo "${FAKE_UID:-0}"; exit 0; }; exit 1',
    getent: `[ "$1" = passwd ] && [ -n "$2" ] || exit 1; grep "^$2:" "${passwd}" || exit 2`,
    useradd: `printf 'useradd %s\\n' "$*" >> "$REC"
[ -n "$FAKE_USERADD_FAIL" ] && { echo "useradd: cannot create directory /home/x: No space left on device" >&2; exit 12; }
c=; for a in "$@"; do [ "$prev" = --comment ] && c=$a; prev=$a; n=$a; done
mkdir -p "${homes}/$n"
echo "$n:x:\${FAKE_USER_UID:-1500}:\${FAKE_USER_UID:-1500}:$c:${homes}/$n:/bin/sh" >> "${passwd}"`,
    install: `printf 'install %s\\n' "$*" >> "$REC"
${map}
d=0; m=; o=
while [ $# -gt 0 ]; do case $1 in -d) d=1 ;; -m) m=$2; shift ;; -o) o=$2; shift ;; -g) shift ;; *) break ;; esac; shift; done
if [ $d = 1 ]; then for x in "$@"; do x=$(map "$x"); mkdir -p "$x"; [ -z "$m" ] || chmod "$m" "$x"; done; exit 0; fi
dst=$(map "$2"); cat "$1" > "$dst" || exit 1; [ -z "$m" ] || chmod "$m" "$dst"
# The owner it was asked for, written down (a test cannot give a file to another user): the stand-in stat answers it.
[ "$o" = root ] && o=0; [ -z "$o" ] || printf '%s %s\n' "$dst" "$o" >> "${owners}"`,
    visudo: `printf 'visudo %s\\n' "$*" >> "$REC"
${map}
f=; while [ $# -gt 0 ]; do [ "$1" = -f ] && f=$2; shift; done
if [ -n "$f" ]; then f=$(map "$f"); [ -f "$f" ] || exit 1; [ -z "$FAKE_VISUDO_NO_FILE" ] || exit 1; grep -q 'NOPASSWD:ALL$' "$f" || exit 1; exit 0; fi
[ -z "$FAKE_VISUDO_NO_ALL" ]`,
    rm: `${map}
case " $* " in *' /etc/'*) printf 'rm %s\\n' "$*" >> "$REC" ;; esac
n=$#; for a in "$@"; do set -- "$@" "$(map "$a")"; done; shift $n
exec ${real('rm')} "$@"`,
    stat: `last=; for a in "$@"; do last=$a; done
case $last in /run/user/*/bus) [ -n "$FAKE_NO_BUS" ] && exit 1; echo socket; exit 0 ;; esac
# A file whose owner was written down (by the stand-in install, or by a test playing the user): that owner.
u=$(awk -v p="$last" '$1 == p { u = $2 } END { print u }' "${owners}")
if [ -n "$u" ] && [ -e "$last" ]; then
  case " $* " in *' %u %h '*) echo "$u $(${real('stat')} -c %h "$last")"; exit 0 ;; *' %u '*) echo "$u"; exit 0 ;; esac
fi
exec ${real('stat')} "$@"`,
    // Never asked: a user that exists is not changed (its shell neither).
    usermod: `printf 'usermod %s\\n' "$*" >> "$REC"`,
    chsh: `printf 'chsh %s\\n' "$*" >> "$REC"`,
    loginctl: `printf 'loginctl %s\\n' "$*" >> "$REC"
case $1 in show-user) echo "Linger=\${FAKE_LINGER:-no}" ;; enable-linger) exit "\${FAKE_LINGER_RC:-0}" ;; esac`,
    // Writes its argv down, then runs the rest as the user would: the user's id for the stand-in id, and the test's
    // own PATH kept (the PATH it was handed is written down, not used: it names the computer's own folders).
    runuser: `printf 'runuser %s\\n' "$*" >> "$REC"
printf 'runuser-cwd %s\\n' "$PWD" >> "$REC"
[ "$1" = -u ] && [ "$3" = -- ] || exit 2
shift 3
[ "$1" = env ] && shift
n=$#; for a in "$@"; do case $a in PATH=*) ;; *) set -- "$@" "$a" ;; esac; done; shift $n
FAKE_UID=\${FAKE_USER_UID:-1500} exec env "$@"`,
  });
  const env = sealed({ PATH: pathWith(s.tmp, admin, tools), HOME: rootHome, REC: rec, FAKE_ETC: etc, HOPRIG_SOURCE: 'hoprig', HOPRIG_BUS_WAIT: '2', HOPRIG_BIN_BASH: path.join(dir, 'no-bash') });
  // own(path, uid): a file the test plays as that user's (or root's) for the stand-in stat.
  const own = (p, uid) => fs.appendFileSync(owners, `${p} ${uid}\n`);
  return { env, dir, etc, passwd, homes, rootHome, own, record: () => fs.readFileSync(rec, 'utf8') };
}

// "/bin/bash" for install.sh is a path of the test's own (HOPRIG_BIN_BASH): by default nothing is there.
const withBash = (pc, mode = 0o755) => {
  const at = path.join(pc.dir, 'bin-bash');
  fs.writeFileSync(at, '#!/bin/sh\n', { mode });
  fs.chmodSync(at, mode);
  return { HOPRIG_BIN_BASH: at };
};

/**
 * install.sh as root. `tty`: run under `script`, which gives it a terminal, and type `answer`. Else no terminal (its
 * own session). → { code, out }
 */
function runRoot(pc, { args = [], tty = false, answer = '', extra = {}, piped = false } = {}) {
  const env = { ...pc.env, ...extra };
  return new Promise((resolve) => {
    const argv = tty ? ['script', ['-qefc', ['sh', INSTALLER, ...args].join(' '), '/dev/null']] : ['sh', piped ? ['-s', '--', ...args] : [INSTALLER, ...args]];
    const child = spawn(argv[0], argv[1], { env, detached: !tty, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\r/g, '') });
    });
    child.stdin.on('error', () => {});
    if (piped) child.stdin.end(fs.readFileSync(INSTALLER));
    else if (tty) setTimeout(() => child.stdin.write(answer), 400); // kept open: script ends when the installer does
    else child.stdin.end();
  });
}
const linkScript = (pc) => fs.symlinkSync(real('script'), path.join(pc.dir, 'tools', 'script'));
const changed = (rec) => rec.split('\n').filter((l) => /^(useradd|install|visudo|loginctl enable-linger|rm|runuser|npm|apt-get) /.test(l));

test('as root with --yes: the steps said first, the user made with its comment and root\'s mark in its home, keys, the one sudoers file, lingering, then the set-up as the user', { skip }, async () => {
  const pc = rootServer('yes');
  const r = await runRoot(pc, { args: ['--yes'] });
  assert.equal(r.code, 0, r.out);
  const rec = pc.record();
  // Said before anything is made: every command.
  const plan = r.out.indexOf('This is root. Hoprig does not work as root');
  assert.ok(plan >= 0 && plan < r.out.indexOf('✓ Made the user hoprig'), r.out);
  for (const c of ['useradd --create-home --comment "Hoprig work user" hoprig', '/etc/sudoers.d/90-hoprig-hoprig  holding  hoprig ALL=(ALL) NOPASSWD:ALL', 'loginctl enable-linger hoprig', 'runuser -u hoprig -- env HOME=']) {
    assert.ok(r.out.slice(0, r.out.indexOf('✓ Made')).includes(c), c);
  }
  // The user: useradd with the comment mark, and the file mark in its home.
  assert.match(rec, /^useradd --create-home --comment Hoprig work user hoprig$/m);
  const home = path.join(pc.homes, 'hoprig');
  assert.equal(fs.readFileSync(path.join(home, '.hoprig-made-by-move'), 'utf8'), 'Hoprig work user hoprig\n', 'the mark, its one line');
  assert.match(rec, new RegExp(`^install -m 0644 -o root -g root \\S+ ${home}/.hoprig-made-by-move$`, 'm'), "the mark is root's: the user cannot write one");
  // The keys: .ssh 0700 and the file 0600, owned by the user; root's lines as written (options kept), root's file unchanged.
  assert.match(rec, new RegExp(`^install -d -m 0700 -o 1500 -g 1500 ${home}/.ssh$`, 'm'));
  assert.match(rec, new RegExp(`^install -m 0600 -o 1500 -g 1500 \\S+ ${home}/.ssh/authorized_keys$`, 'm'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, '.ssh')).mode & 0o777, 0o700);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, '.ssh', 'authorized_keys')).mode & 0o777, 0o600);
  // The line with a forced command is left out (it would not log in as the user), and said so.
  assert.equal(fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), `${KEY}\r\n`);
  assert.match(r.out, /! 1 of root's key lines were not given to hoprig: they hold a forced command/);
  assert.equal(fs.readFileSync(path.join(pc.rootHome, '.ssh', 'authorized_keys'), 'utf8'), `${KEY}\r\n${KEY_OPT}`, "root's file as it was");
  assert.doesNotMatch(r.out + rec, /AAAAC3Nza/, 'no key is printed or put on a command line');
  // The sudoers file: checked as a temporary file first, put in place 0440 root:root, then the whole checked.
  const order = changed(rec);
  const tmpCheck = order.findIndex((l) => /^visudo -c -q -f \/(?!etc)/.test(l));
  const put = order.findIndex((l) => /^install -m 0440 -o root -g root \S+ \/etc\/sudoers\.d\/90-hoprig-hoprig$/.test(l));
  const whole = order.indexOf('visudo -c -q');
  assert.ok(tmpCheck >= 0 && tmpCheck < put && put < whole, order.join('\n'));
  assert.equal(fs.readFileSync(path.join(pc.etc, 'sudoers.d', '90-hoprig-hoprig'), 'utf8'), 'hoprig ALL=(ALL) NOPASSWD:ALL\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(pc.etc, 'sudoers.d', '90-hoprig-hoprig')).mode & 0o777, 0o440);
  // Lingering, then the same installer as the user through runuser with its service manager's address.
  assert.ok(order.indexOf('loginctl enable-linger hoprig') > whole);
  const ru = rec.split('\n').find((l) => l.startsWith('runuser '));
  assert.ok(ru.startsWith(`runuser -u hoprig -- env HOME=${home} USER=hoprig LOGNAME=hoprig XDG_RUNTIME_DIR=/run/user/1500 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1500/bus PATH=${home}/.local/bin:/usr/local/bin:/usr/bin:/bin env NVM_DIR=${home}/.nvm HOPRIG_SOURCE=hoprig sh ${home}/.cache/hoprig-install/install.sh --yes`), ru);
  assert.match(rec, new RegExp(`^runuser-cwd ${home}$`, 'm'), "started in the user's home");
  assert.equal(fs.readFileSync(path.join(home, '.cache', 'hoprig-install', 'install.sh'), 'utf8'), fs.readFileSync(INSTALLER, 'utf8'), 'the same installer');
  // Hoprig installed as the user (its id, its home), and set-up started there; nothing of Hoprig under root.
  assert.match(rec, new RegExp(`^npm install .* hoprig \\| as 1500 HOME=${home}$`, 'm'));
  assert.doesNotMatch(rec, /\| as 0 /, 'npm never ran as root');
  assert.match(r.out, /hoprig-stand-in setup --yes\n/);
  // The closing words: the user's ssh and tunnel lines, never root@, and root's login said unchanged once.
  assert.match(r.out, /Log in as hoprig with the key you use for root: {2}ssh hoprig@/);
  assert.match(r.out, /ssh -N -L 17433:127\.0\.0\.1:7433 hoprig@/);
  assert.doesNotMatch(r.out, /root@/);
  assert.equal(r.out.split("Root's login still works and was not changed.").length, 2);
});

test('where /bin/bash is there, the new user is made with bash as its shell, and the steps show that exact command', { skip }, async () => {
  const pc = rootServer('bash-there');
  const r = await runRoot(pc, { args: ['--yes'], extra: withBash(pc) });
  assert.equal(r.code, 0, r.out);
  const said = r.out.slice(0, r.out.indexOf('✓ Made the user hoprig'));
  assert.ok(said.includes('Make the user hoprig, with no password, bash as its shell (the usual command line, with history and arrow keys) and its home made by the system'), said);
  assert.ok(said.includes('useradd --create-home --comment "Hoprig work user" --shell /bin/bash hoprig'), said);
  assert.match(pc.record(), /^useradd --create-home --comment Hoprig work user --shell \/bin\/bash hoprig$/m);
  // The move's making (--user-only) is the same.
  const mv = rootServer('bash-there-user-only');
  const r2 = await runRoot(mv, { args: ['--yes', '--user-only'], extra: { ...withBash(mv), HOPRIG_INSTALL_COMMAND: 'hoprig move-to-user' } });
  assert.equal(r2.code, 0, r2.out);
  assert.match(mv.record(), /^useradd --create-home --comment Hoprig work user --shell \/bin\/bash hoprig$/m);
});

test('where /bin/bash is not there (or is no program), no shell is named: the system\'s default stays', { skip }, async () => {
  for (const [name, extra] of [['bash-none', () => ({})], ['bash-not-a-program', (pc) => withBash(pc, 0o644)]]) {
    const pc = rootServer(name);
    const r = await runRoot(pc, { args: ['--yes'], extra: extra(pc) });
    assert.equal(r.code, 0, r.out);
    assert.match(pc.record(), /^useradd --create-home --comment Hoprig work user hoprig$/m, name);
    assert.doesNotMatch(r.out + pc.record(), /--shell|bash as its shell/, name);
  }
});

test('a user Hoprig made that is there already is never changed, also where /bin/bash is there: no usermod, no chsh', { skip }, async () => {
  const pc = rootServer('bash-exists');
  assert.equal((await runRoot(pc, { args: ['--yes'] })).code, 0); // made where no bash is: the system's default shell
  assert.match(fs.readFileSync(pc.passwd, 'utf8'), /^hoprig:x:1500:1500:Hoprig work user:.*:\/bin\/sh$/m);
  fs.writeFileSync(path.join(pc.dir, 'record.log'), '');
  const r = await runRoot(pc, { args: ['--yes'], extra: { ...withBash(pc), FAKE_LINGER: 'yes' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1\. The user hoprig is here already and Hoprig made it: kept as it is/);
  assert.doesNotMatch(r.out, /--shell|bash as its shell/);
  assert.doesNotMatch(pc.record(), /^(useradd|usermod|chsh) /m);
  assert.match(fs.readFileSync(pc.passwd, 'utf8'), /^hoprig:x:1500:1500:Hoprig work user:.*:\/bin\/sh$/m, 'its shell as it was');
});

test('as root with a terminal: ONE question with yes written as the default; Enter makes the user', { skip }, async () => {
  const pc = rootServer('tty-yes');
  linkScript(pc);
  const r = await runRoot(pc, { tty: true, answer: '\n' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.split('[Y/n]').length, 2, 'one question');
  assert.match(r.out, /Make the user hoprig and set Hoprig up there\? \[Y\/n\]/);
  assert.match(pc.record(), /^useradd --create-home --comment Hoprig work user hoprig$/m);
  assert.match(r.out, /Hoprig is set up for the user hoprig/);
});

test('as root with a terminal and the answer no: nothing is made, and the two ways are said', { skip }, async () => {
  const pc = rootServer('tty-no');
  linkScript(pc);
  const r = await runRoot(pc, { tty: true, answer: 'n\n' });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(changed(pc.record()), [], 'no stand-in that changes something was asked');
  assert.match(r.out, /hoprig installer: nothing was made\. To make the user later: sh install\.sh --yes {3}To keep Hoprig on root instead: sh install\.sh --stay-root/);
});

test('piped (curl | sh), the advice names the piped command: there is no install.sh file to run', { skip }, async () => {
  const pc = rootServer('piped-words');
  const r = await runRoot(pc, { piped: true });
  assert.equal(r.code, 1, r.out);
  const pipe = 'curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh -s --';
  assert.ok(r.out.includes(`To make the user hoprig and set Hoprig up there: ${pipe} --yes`), r.out);
  assert.ok(r.out.includes(`To keep Hoprig on root instead: ${pipe} --stay-root`), r.out);
  // The advice (the installer's own line) never names a file he does not have.
  assert.doesNotMatch(r.out.split('\n').filter((l) => l.startsWith('hoprig installer:')).join('\n'), /sh install\.sh/);
});

test('as root with no terminal and no --yes: the steps are said, nothing is made, and one line names the two commands', { skip }, async () => {
  for (const piped of [false]) {
    const pc = rootServer(`no-tty-${piped}`);
    const r = await runRoot(pc, { piped, extra: { HOPRIG_YES: '1' } }); // the variable is not his yes as root
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(changed(pc.record()), [], 'no stand-in that changes something was asked');
    assert.ok(r.out.indexOf('useradd --create-home') < r.out.indexOf('hoprig installer:'), 'the steps first');
    assert.match(r.out, /^hoprig installer: this is root, and there is no terminal to ask in, so nothing was made\. To make the user hoprig and set Hoprig up there: sh install\.sh --yes {3}To keep Hoprig on root instead: sh install\.sh --stay-root$/m);
    assert.doesNotMatch(r.out, /as an ordinary user/, 'never the advice to run it as a user he does not have');
    assert.doesNotMatch(r.out, /hoprig-stand-in/, 'set-up was not started');
  }
});

test('as root with --dry-run: the steps are said and nothing is made', { skip }, async () => {
  const pc = rootServer('dry');
  const r = await runRoot(pc, { args: ['--yes', '--dry-run'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /A dry run: nothing was made or installed\./);
  assert.deepEqual(changed(pc.record()), []);
});

test('as root with --stay-root: no user is made, and Hoprig is set up for root as before', { skip }, async () => {
  const pc = rootServer('stay');
  const r = await runRoot(pc, { args: ['--yes', '--stay-root'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /This is root, kept on root by your choice \(--stay-root\)/);
  assert.doesNotMatch(pc.record(), /^(useradd|visudo|runuser|loginctl) /m);
  assert.match(r.out, /hoprig-stand-in setup --yes --stay-root/);
  const both = await runRoot(rootServer('stay-user'), { args: ['--yes', '--stay-root', '--user', 'alex'] });
  assert.equal(both.code, 1, both.out);
  assert.match(both.out, /choose one\. Nothing was made\./);
});

test('as root where Hoprig is kept on root by his choice, or set up for root already: no user is made', { skip }, async () => {
  const cfgOf = (pc, cfg) => {
    fs.mkdirSync(path.join(pc.rootHome, '.config', 'hoprig'), { recursive: true });
    fs.writeFileSync(path.join(pc.rootHome, '.config', 'hoprig', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  };
  // His kept choice (Settings, or an earlier --stay-root): the stay-root branch, as if he typed it again.
  const kept = rootServer('kept');
  cfgOf(kept, { stayRoot: true, server: { passwordHash: 'made-up-hash' } });
  const r = await runRoot(kept, { args: ['--yes'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /This is root, kept on root by your choice \(in \S+config\.json\)/);
  assert.equal(r.out.split('kept on root by your choice').length, 2, 'said once');
  assert.doesNotMatch(kept.record(), /^(useradd|visudo|runuser|loginctl) /m);
  assert.match(r.out, /hoprig-stand-in setup --yes --stay-root/);
  // Set up for root already (a dashboard password, or its service), not kept: nothing made, the move named.
  for (const [name, make] of [
    ['has-password', (pc) => cfgOf(pc, { server: { passwordHash: 'made-up-hash' } })],
    ['has-service', (pc) => {
      fs.mkdirSync(path.join(pc.rootHome, '.config', 'systemd', 'user'), { recursive: true });
      fs.writeFileSync(path.join(pc.rootHome, '.config', 'systemd', 'user', 'hoprig.service'), '[Unit]\n');
    }],
  ]) {
    const pc = rootServer(name);
    make(pc);
    const r2 = await runRoot(pc, { args: ['--yes'] });
    assert.equal(r2.code, 1, r2.out);
    assert.match(r2.out, /^hoprig installer: this is root, and Hoprig is set up for root here already \(.+\), so no user was made and nothing was installed\. To move it to an ordinary user: hoprig move-to-user {3}To keep it on root and install this version there: sh install\.sh --stay-root$/m);
    assert.deepEqual(changed(pc.record()), [], `${name}: no stand-in that changes something was asked`);
    assert.doesNotMatch(r2.out, /This is root\. Hoprig does not work as root/, `${name}: the steps of making a user are not offered`);
  }
  // A password of nothing ("passwordHash": "") is no installation: the user is made as on a fresh server.
  const empty = rootServer('empty-password');
  cfgOf(empty, { server: { passwordHash: '' } });
  assert.equal((await runRoot(empty, { args: ['--yes'] })).code, 0);
  assert.match(empty.record(), /^useradd /m);
});

test('as root inside a container: stays on root by default; --user makes the user all the same', { skip }, async () => {
  const pc = rootServer('container');
  const r = await runRoot(pc, { args: ['--yes'], extra: { container: 'podman' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /This is root, inside a container \(container=podman\): Hoprig stays on root here/);
  assert.doesNotMatch(pc.record(), /^useradd /m);
  const second = rootServer('container-user');
  const r2 = await runRoot(second, { args: ['--yes', '--user', 'alex'], extra: { container: 'podman' } });
  assert.equal(r2.code, 0, r2.out);
  assert.match(second.record(), /^useradd --create-home --comment Hoprig work user alex$/m);
});

test('a user of the name that Hoprig did not make is never taken over: another name is offered', { skip }, async () => {
  const pc = rootServer('taken', { users: [`hoprig:x:1200:1200:Someone Else:${path.join(s.tmp, 'taken', 'home', 'hoprig')}:/bin/bash`] });
  const r = await runRoot(pc, { args: ['--yes'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a user named hoprig is already on this computer and Hoprig did not make it, so it is not used\. Nothing was made\. Choose another name: sh install\.sh --yes --user hoprig2/);
  assert.deepEqual(changed(pc.record()), []);
  // --user with a bad name is refused before anything.
  const bad = await runRoot(rootServer('badname'), { args: ['--yes', '--user', 'Alex;rm'] });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /is not a user name/);
  // The offered name works.
  const r2 = await runRoot(pc, { args: ['--yes', '--user', 'hoprig2'] });
  assert.equal(r2.code, 0, r2.out);
  assert.match(pc.record(), /^useradd --create-home --comment Hoprig work user hoprig2$/m);
});

test('a user that writes the mark into its own home itself is not made by Hoprig: no keys, no sudo, another name offered', { skip }, async () => {
  const home = path.join(s.tmp, 'forged', 'home', 'hoprig');
  const pc = rootServer('forged', { users: [`hoprig:x:1200:1200:Hoprig work user:${home}:/bin/sh`] });
  fs.mkdirSync(home, { recursive: true });
  // The person's own account: he owns his home and writes the mark there, its exact line, and even the comment field.
  const mark = path.join(home, '.hoprig-made-by-move');
  fs.writeFileSync(mark, 'Hoprig work user hoprig\n');
  pc.own(mark, 1200);
  const r = await runRoot(pc, { args: ['--yes'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a user named hoprig is already on this computer and Hoprig did not make it, so it is not used\. Nothing was made\. Choose another name: sh install\.sh --yes --user hoprig2/);
  assert.deepEqual(changed(pc.record()), [], 'no keys, no sudoers file, no lingering, nothing run as it');
  assert.ok(!fs.existsSync(path.join(pc.etc, 'sudoers.d', '90-hoprig-hoprig')));
  assert.ok(!fs.existsSync(path.join(home, '.ssh')));
  // A file of root's renamed into that name (it holds another text) is not the mark either.
  fs.writeFileSync(mark, 'some file of root\'s\n');
  pc.own(mark, 0);
  const r2 = await runRoot(pc, { args: ['--yes'] });
  assert.equal(r2.code, 1, r2.out);
  assert.deepEqual(changed(pc.record()), []);
  // The mark as Hoprig writes it (root's, its line): that user is Hoprig's and is kept.
  fs.writeFileSync(mark, 'Hoprig work user hoprig\n');
  pc.own(mark, 0);
  const r3 = await runRoot(pc, { args: ['--yes', '--no-admin'], extra: { FAKE_USER_UID: '1200' } });
  assert.equal(r3.code, 0, r3.out);
  assert.match(r3.out, /The user hoprig is here already and Hoprig made it: kept as it is/);
});

test('a second run on a server already set up redoes nothing: the user, keys, rights and lingering are said as done', { skip }, async () => {
  const pc = rootServer('second');
  assert.equal((await runRoot(pc, { args: ['--yes'] })).code, 0);
  fs.writeFileSync(path.join(pc.dir, 'record.log'), '');
  const r = await runRoot(pc, { args: ['--yes'], extra: { FAKE_LINGER: 'yes' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1\. The user hoprig is here already and Hoprig made it: kept as it is/);
  for (const l of ['✓ The user hoprig is here already (made by Hoprig).', "✓ hoprig has root's login keys already.", '✓ Administrator rights for hoprig: /etc/sudoers.d/90-hoprig-hoprig is there already.', '✓ Lingering is on for hoprig already.']) assert.ok(r.out.includes(l), l);
  const rec = pc.record();
  assert.doesNotMatch(rec, /^(useradd|loginctl enable-linger) /m);
  assert.doesNotMatch(rec, /^install .*(sudoers|authorized_keys)/m);
  assert.equal(fs.readFileSync(path.join(pc.etc, 'sudoers.d', '90-hoprig-hoprig'), 'utf8'), 'hoprig ALL=(ALL) NOPASSWD:ALL\n', 'one line, not two');

});

test('the sudoers file counts only when the checker says yes: a no takes it away and the step fails plainly', { skip }, async () => {
  const pc = rootServer('visudo-no');
  const r = await runRoot(pc, { args: ['--yes'], extra: { FAKE_VISUDO_NO_ALL: '1' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the system's check of all administrator rights \(visudo -c\) failed with \/etc\/sudoers\.d\/90-hoprig-hoprig, so that file was taken away again/);
  assert.ok(!fs.existsSync(path.join(pc.etc, 'sudoers.d', '90-hoprig-hoprig')), 'taken away');
  assert.match(pc.record(), /^rm -f \/etc\/sudoers\.d\/90-hoprig-hoprig$/m);
  assert.doesNotMatch(pc.record(), /^runuser /m, 'nothing ran as the user');
  const second = rootServer('visudo-file-no');
  const r2 = await runRoot(second, { args: ['--yes'], extra: { FAKE_VISUDO_NO_FILE: '1' } });
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /did not pass the system's check \(visudo -cf\), so nothing was written to \/etc\/sudoers\.d/);
  assert.deepEqual(fs.readdirSync(path.join(second.etc, 'sudoers.d')), []);
});

test('a failure after the user was made says what was made, the one command that goes on and the commands that take it away', { skip }, async () => {
  const pc = rootServer('fail-after');
  const r = await runRoot(pc, { args: ['--yes'], extra: { FAKE_LINGER_RC: '1' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hoprig installer: lingering could not be turned on for hoprig/);
  assert.match(r.out, /What this run made \(Hoprig does not run there yet\): the user hoprig; the login keys in \S+\/\.ssh; the file \/etc\/sudoers\.d\/90-hoprig-hoprig;/);
  assert.match(r.out, /To go on from here, run the same command again: sh install\.sh --yes\n/);
  assert.match(r.out, /To take it away: {2}rm \/etc\/sudoers\.d\/90-hoprig-hoprig; {2}userdel --remove hoprig/);
  assert.doesNotMatch(pc.record(), /^runuser /m, 'nothing ran as the user');
  // useradd itself failing (a full disk): nothing was made, said so.
  const second = rootServer('fail-useradd');
  const r2 = await runRoot(second, { args: ['--yes'], extra: { FAKE_USERADD_FAIL: '1' } });
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /No space left on device/);
  assert.match(r2.out, /the user hoprig could not be made \(useradd said why above\)\. Nothing was made\./);
  assert.doesNotMatch(r2.out, /What this run made/);
  // The set-up as the user failing: the user and what was made are said, with the way to take them away.
  const third = rootServer('fail-user-setup');
  fs.writeFileSync(path.join(third.dir, 'tools', 'npm'), '#!/bin/sh\ncase "$1" in --version) echo 11.20.0 ;; prefix) echo /nowhere ;; install) echo "npm error network" >&2; exit 1 ;; esac\n', { mode: 0o755 });
  const r3 = await runRoot(third, { args: ['--yes'] });
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, /the set-up for hoprig did not finish \(exit 1; its own lines above say why\), so Hoprig does not run for hoprig\./);
  assert.match(r3.out, /lingering for hoprig;\nTo go on from here/);
  assert.match(r3.out, /loginctl disable-linger hoprig; {2}userdel --remove hoprig/);
});

test("root's key lines that force a command or forbid forwarding are not given to the user, and no ssh line is promised", { skip }, async () => {
  // The line cloud images put in root's file, and two more that would not log in or tunnel as the user.
  const cloud = 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,command="echo \'Please login as the user \\"alex\\" rather than the user \\"root\\".\';echo;sleep 10;exit 142" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUpKeyForTestsOnly alex@laptop';
  const pc = rootServer('forced', { keys: `${cloud}\nrestrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRestricted ci\nno-port-forwarding ssh-rsa AAAAB3NzaMadeUp backup\n` });
  const r = await runRoot(pc, { args: ['--yes'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /! 3 of root's key lines were not given to hoprig: they hold a forced command, no-port-forwarding or restrict/);
  assert.ok(!fs.existsSync(path.join(pc.homes, 'hoprig', '.ssh', 'authorized_keys')), 'no file of lines that would not work');
  assert.doesNotMatch(r.out, /ssh hoprig@|ssh -N -L/, 'no login or tunnel line that would not work');
  assert.match(r.out, /hoprig has no key that logs in by ssh\. Become hoprig from root's login: {2}runuser -u hoprig -- sh/);
  // One usable line among them: only that one is given, and the ssh and tunnel lines are said.
  const mixed = rootServer('forced-mixed', { keys: `${cloud}\nfrom="192.168.1.0/24" ${KEY}\n` });
  const r2 = await runRoot(mixed, { args: ['--yes'] });
  assert.equal(r2.code, 0, r2.out);
  assert.equal(fs.readFileSync(path.join(mixed.homes, 'hoprig', '.ssh', 'authorized_keys'), 'utf8'), `from="192.168.1.0/24" ${KEY}\n`);
  assert.match(r2.out, /Log in as hoprig with the key you use for root: {2}ssh hoprig@/);
  assert.match(r2.out, /ssh -N -L 17433:127\.0\.0\.1:7433 hoprig@/);
});

test('as root with no key file: no keys, and the closing words say how to become the user from root', { skip }, async () => {
  const pc = rootServer('nokeys', { keys: null });
  const r = await runRoot(pc, { args: ['--yes'] });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(pc.record(), /authorized_keys/);
  assert.match(r.out, /Become hoprig from root's login: {2}runuser -u hoprig -- sh/);
});

test('started by set-up with this Hoprig\'s folder: its words name hoprig setup, the user gets that build packed, and root\'s Hoprig folders stay out', { skip }, async () => {
  const src = path.join(s.tmp, 'srcfolder', 'hoprig');
  fs.mkdirSync(path.join(src, 'node_modules', 'big'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(src, 'install.sh'));
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"hoprig","version":"0.0.0-made-up"}\n');
  const pc = rootServer('from-setup');
  const no = await runRoot(pc, { extra: { HOPRIG_INSTALL_COMMAND: 'hoprig setup', HOPRIG_SOURCE: src } });
  assert.match(no.out, /To make the user hoprig and set Hoprig up there: hoprig setup --yes {3}To keep Hoprig on root instead: hoprig setup --stay-root/);
  // A command of anyone else's choosing is never named.
  const odd = await runRoot(rootServer('odd-cmd'), { extra: { HOPRIG_INSTALL_COMMAND: 'rm -rf x' } });
  assert.match(odd.out, /sh install\.sh --yes/);
  const r = await runRoot(pc, { args: ['--yes'], extra: { HOPRIG_INSTALL_COMMAND: 'hoprig setup', HOPRIG_SOURCE: src, HOPRIG_CONFIG_DIR: path.join(pc.rootHome, '.config', 'hoprig'), CLAUDE_CONFIG_DIR: path.join(pc.rootHome, '.claude') } });
  assert.equal(r.code, 0, r.out);
  const home = path.join(pc.homes, 'hoprig');
  const tgz = path.join(home, '.cache', 'hoprig-install', 'hoprig.tgz');
  assert.match(pc.record(), new RegExp(`^npm install .* ${tgz} \\| as 1500 HOME=${home}$`, 'm'), 'the same build, from root\'s folder, never the network');
  const listed = (await import('node:child_process')).execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
  assert.match(listed, /^hoprig\/package\.json$/m);
  assert.doesNotMatch(listed, /node_modules/);
  const ru = pc.record().split('\n').find((l) => l.startsWith('runuser '));
  assert.doesNotMatch(ru, /HOPRIG_CONFIG_DIR|CLAUDE_CONFIG_DIR/);
});

test('--user-only (the move): the user is made with its keys, rights and lingering, and nothing is installed for it', { skip }, async () => {
  const pc = rootServer('user-only');
  const r = await runRoot(pc, { args: ['--yes', '--user-only'], extra: { HOPRIG_INSTALL_COMMAND: 'hoprig move-to-user', container: 'podman' } });
  assert.equal(r.code, 0, r.out);
  const rec = pc.record();
  assert.match(rec, /^useradd --create-home --comment Hoprig work user hoprig$/m);
  assert.match(rec, /^loginctl enable-linger hoprig$/m);
  assert.doesNotMatch(rec, /^(runuser|npm) /m, 'nothing installed, nothing run as the user');
  assert.doesNotMatch(r.out, /Install Hoprig FOR/);
  assert.match(r.out, /✓ The user hoprig is ready for Hoprig \(home \S+, user id 1500\)\./);
});

test('--no-work-user (the hub without his confirmation): as root nothing is made, and the two commands are said', { skip }, async () => {
  const pc = rootServer('no-work');
  const r = await runRoot(pc, { args: ['--yes', '--no-work-user'] });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(changed(pc.record()), []);
  assert.match(r.out, /this install was not asked to make a user, so nothing was made\. To make the user hoprig and set Hoprig up there: sh install\.sh --yes/);
});

test('a whole-home snapshot: sh install.sh --dry-run as root changes nothing in root\'s home, the homes or "/etc"', { skip }, async () => {
  const pc = rootServer('dry-snapshot');
  const snap = () => {
    const out = [];
    const walk = (d) => {
      for (const n of fs.readdirSync(d).sort()) {
        const p = path.join(d, n);
        const st = fs.lstatSync(p);
        out.push(`${path.relative(pc.dir, p)} ${st.mode.toString(8)} ${st.size} ${st.mtimeMs} ${st.isFile() ? fs.readFileSync(p, 'utf8') : ''}`);
        if (st.isDirectory()) walk(p);
      }
    };
    for (const d of [pc.rootHome, pc.homes, pc.etc]) walk(d);
    out.push(fs.readFileSync(pc.passwd, 'utf8'));
    return out.join('\n');
  };
  const before = snap();
  for (const args of [['--dry-run'], ['--yes', '--dry-run']]) {
    const r = await runRoot(pc, { args });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /A dry run: nothing was made or installed\./);
  }
  assert.equal(snap(), before);
  assert.deepEqual(changed(pc.record()), [], 'no stand-in that changes something was asked');
});
