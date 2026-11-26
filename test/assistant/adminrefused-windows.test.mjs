// The administrator forms refused at every level, on Windows. There the system names a place with backslashes
// (`C:\Users\example\.config\hoprig`), takes a forward slash as the same separator and does not tell letter case
// apart, and a session's working folder is a Windows folder. Her own tool compared Hoprig's folders with a `/` written
// by hand and dropped a working folder that did not begin with `/`, and Bash's reading of a word takes an unquoted
// backslash away (`C:\opt\hoprig` reached the check as `C:opthoprig`): a write into one of Hoprig's own folders was
// not refused there. The platform is a parameter (`platform: 'win32'`), so these are Windows' answers on any
// computer; the places are made up and nothing on disk is asked for them.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { adminRefusal, sudoArgv } from '../../src/assistant/adminrefused.mjs';

const HOME = 'C:\\Users\\example';
const HOPRIG = [`${HOME}\\.config\\hoprig`, `${HOME}\\.local\\state\\hoprig`, 'C:\\opt\\hoprig'];
const CWD = `${HOME}\\work\\shop`;
const ctx = { hoprigDirs: HOPRIG, home: HOME, cwd: CWD, platform: 'win32' };
const id = (line, c = ctx) => (adminRefusal(line, c) || {}).id || null;

// The rows of test/assistant/adminrefused.test.mjs CASES['hoprig-own'], word for word: there each names one of the
// Hoprig folders /home/example/.config/hoprig, /home/example/.local/state/hoprig or /opt/hoprig, or a folder that
// holds one of them. Here every path word is written as Windows names the same place (`/home` is `C:\Users`).
const POSIX_ROWS = ['sudo rm -rf /opt/hoprig', 'sudo cp evil /home/example/.config/hoprig/config.json', 'sudo tee /home/example/.local/state/hoprig/runs/x', 'sudo chown -R nobody /', 'sudo mv /home/example /tmp/x', 'sudo rm -rf /opt', 'sudo chmod -R 000 /home/example//.config', 'sudo rm -rf /home/*'];
const winPlace = (word) => `C:${word.replace(/^\/home(?=\/|$)/, '/Users')}`.replace(/\//g, '\\');
const eachPath = (line, f) => line.split(' ').map((w) => (w.startsWith('/') ? f(winPlace(w)) : w)).join(' ');
const FORMS = {
  backslashes: (line) => eachPath(line, (p) => p),
  'forward slashes': (line) => eachPath(line, (p) => p.replace(/\\/g, '/')),
  'upper case': (line) => eachPath(line, (p) => p.toUpperCase()),
  'lower case, forward slashes': (line) => eachPath(line, (p) => p.toLowerCase().replace(/\\/g, '/')),
  'relative to the working folder': (line) => eachPath(line, (p) => path.win32.relative(CWD, p)),
  'relative, forward slashes': (line) => eachPath(line, (p) => path.win32.relative(CWD, p).replace(/\\/g, '/')),
};

test('on win32 every Hoprig-folder row is refused as hoprig-own, however the place is written', () => {
  const missed = [];
  for (const [form, write] of Object.entries(FORMS)) {
    for (const row of POSIX_ROWS) {
      const line = write(row);
      assert.notEqual(line, row, `${form}: the row is written as a Windows place`);
      if (id(line) !== 'hoprig-own') missed.push(`${form}: ${line} (got ${id(line)})`);
      const r = sudoArgv(line, ctx);
      if (!r.refuse || r.refuse.id !== 'hoprig-own') missed.push(`${form}, her own tool: ${line}`);
    }
  }
  assert.deepEqual(missed, []);
});

test('on win32 a Hoprig folder named from home, with mixed or doubled separators, or from the drive root is refused', () => {
  for (const line of [
    'sudo rm ~/.local/state/hoprig/hook-settings/r.json.tia',
    'sudo rm C:\\Users\\example/.config\\hoprig/config.json',
    'sudo rm C:\\\\Users\\\\example\\\\.config\\\\hoprig\\\\x',
    'sudo rm "C:\\Users\\example\\.config\\hoprig\\x"',
    'sudo tee \\opt\\hoprig\\x',
    'sudo mv ..\\..\\.config C:\\tmp\\x',
    'sudo mv C:\\Users\\example\\work\\shop\\..\\..\\.config C:\\tmp\\x',
    'sudo rm -rf C:\\*',
  ]) {
    assert.equal(id(line), 'hoprig-own', line);
  }
});

test('on win32 an ordinary command, and an administrator command away from Hoprig, is not refused', () => {
  for (const line of ['dir', 'git status', 'npm test', 'dir C:\\Users\\example\\.config\\hoprig']) assert.equal(id(line), null, line);
  for (const line of [
    'sudo rm C:\\Users\\example\\work\\shop\\build.log',
    'sudo rm .\\build.log',
    'sudo rm build\\out.log',
    'sudo mkdir C:\\opt\\other',
    'sudo rm -rf C:\\opt\\hoprig2',
    'sudo rm -rf C:\\Users\\example\\work\\shop\\*',
    'sudo ls C:\\Users\\example',
    'sudo dir C:\\',
  ]) {
    assert.equal(id(line), null, line);
  }
  // A path with the backslashes quoted is read as written: her own tool runs that exact argv.
  assert.deepEqual(sudoArgv("sudo mkdir 'C:\\opt\\other'", ctx).argv, ['sudo', 'mkdir', 'C:\\opt\\other'], 'a quoted path away from Hoprig is a runnable argv');
});

// Her own tool reads a word as Bash does, dropping an unquoted backslash (`C:\opt\other` would run as `C:optother`, a
// different place). On Windows a word with an unquoted backslash is refused with what to do instead (quote it), rather
// than run at a place the card does not show.
test('on win32 her own tool refuses a word with an unquoted backslash', () => {
  for (const line of ['sudo mkdir C:\\opt\\other', 'sudo rm .\\build.log', 'sudo dir C:\\']) {
    const r = sudoArgv(line, ctx);
    assert.ok(r.refuse && r.refuse.id === 'win-backslash', `${line}: ${JSON.stringify(r)}`);
  }
  // Elsewhere a backslash is an ordinary character her tool keeps: the argv is built as before.
  assert.deepEqual(sudoArgv('sudo mkdir /opt/other', { ...ctx, platform: 'linux' }).argv, ['sudo', 'mkdir', '/opt/other']);
});

// A UNC or device path (`\\.\C:\…`, `\\localhost\C$\…`, `\\?\UNC\…`) names a place on this computer that Hoprig
// cannot place against its folders, and a loopback administrative share needs administrator rights, so such a word in
// an administrator command is refused (fail closed) rather than run.
test('on win32 a UNC or device path in an administrator command is refused', () => {
  for (const line of [
    "sudo rm -rf '\\\\.\\C:\\opt\\hoprig'",
    'sudo rm -rf //./C:/opt/hoprig',
    "sudo rm -rf '\\\\localhost\\C$\\opt\\hoprig'",
    "sudo rm -rf '\\\\127.0.0.1\\c$\\opt\\hoprig'",
    "sudo rm -rf '\\\\?\\UNC\\localhost\\C$\\opt\\hoprig'",
  ]) {
    assert.equal(id(line), 'hoprig-own', line);
  }
});

// A drive-relative word (`C:..`, `C:.`) is read from the current folder on that drive, so `C:..\..\.config\hoprig`
// from C:\Users\example\work\shop climbs to C:\Users\example\.config\hoprig, a Hoprig folder. Hoprig cannot place a
// drive-relative word against its folders, so one in an administrator command is refused (fail closed).
test('on win32 a drive-relative word that could climb into a Hoprig folder is refused', () => {
  for (const line of [
    'sudo rm -rf C:..\\..\\.config\\hoprig',
    "sudo rm -rf 'C:..\\..\\.config\\hoprig'",
    'sudo rm -rf C:../../.config/hoprig',
    'sudo rm -rf c:../../.CONFIG/hoprig',
    'sudo rm -rf C:.\\..\\..\\.config\\hoprig',
  ]) {
    assert.equal(id(line), 'hoprig-own', line);
  }
  // A bare drive or an absolute drive path is not drive-relative: a reader of one is not refused for this reason.
  assert.equal(id('sudo dir C:\\'), null);
  assert.equal(id('sudo ls C:\\Users\\example'), null);
});

// On a volume that keeps 8.3 short names, `.config` has a short name such as CONFIG~1, so a word with a `~<digit>`
// component could name a Hoprig folder by its short name. Hoprig cannot expand it from the line, so such a word in an
// administrator command is refused (fail closed) rather than run.
test('on win32 a short (8.3) name that could be a Hoprig folder is refused', () => {
  for (const line of [
    'sudo rm -rf C:\\Users\\example\\CONFIG~1\\hoprig',
    "sudo rm -rf 'C:\\Users\\example\\CONFIG~1\\hoprig'",
    'sudo rm -rf C:\\opt\\HOPRIG~1',
  ]) {
    assert.equal(id(line), 'hoprig-own', line);
  }
  // Elsewhere a `~1` is an ordinary name, no Hoprig folder.
  assert.equal(id('sudo rm -rf C:\\opt\\HOPRIG~1', { ...ctx, platform: 'linux' }), null);
});

test('on win32 a protected administrator file named as written is still refused', () => {
  for (const line of ['sudo tee /etc/sudoers.d/mine', 'sudo cat /etc/shadow', 'sudo rm -rf /*']) assert.equal(id(line), 'protected-path', line);
});

test('on win32 the rows written as on other systems (from the root, with ~, relative) stay refused as hoprig-own', () => {
  const posix = { hoprigDirs: ['/home/example/.config/hoprig', '/home/example/.local/state/hoprig', '/opt/hoprig'], platform: 'win32' };
  for (const row of POSIX_ROWS) assert.equal(id(row, posix), 'hoprig-own', row);
  const c = { hoprigDirs: ['/home/alex/.local/state/hoprig'], home: '/home/alex', cwd: '/home/alex/ws/shop', platform: 'win32' };
  for (const line of ['sudo rm ~/.local/state/hoprig/hook-settings/r.json.tia', 'sudo rm ../../.local/state/hoprig/x', 'sudo rm /home/alex/.local/state/hoprig/x']) {
    assert.equal(id(line, c), 'hoprig-own', line);
  }
  assert.equal(id('sudo rm ~/ws/shop/build.log', c), null);
});

test('elsewhere than Windows the same lines are read as before: a Windows place is no Hoprig folder there', () => {
  const linux = { ...ctx, platform: 'linux' };
  for (const row of POSIX_ROWS) assert.equal(id(FORMS.backslashes(row), linux), null, FORMS.backslashes(row));
});

// A Windows shell, or a Windows shell launcher given a command, run as administrator could run anything as root, so no
// level allows it. The name is read as Windows reads it: either separator, any case, a trailing .exe/.com/.bat/.cmd
// dropped. cmd, powershell, pwsh and wsl are shells there too.
test('on win32 a Windows shell or shell launcher as administrator is refused', () => {
  const shells = [
    'sudo cmd',
    'sudo cmd.exe /k',
    'sudo powershell',
    'sudo powershell.exe',
    'sudo pwsh -NoProfile',
    'sudo cmd /c "rd /s /q C:\\opt\\hoprig"',
    'sudo pwsh -c "Remove-Item -Recurse -Force ~\\.config\\hoprig"',
    'sudo bash.exe',
    'sudo Bash.EXE',
    'sudo sh.exe -c "rm -rf ~/.config/hoprig"',
    'sudo /usr/bin/bash.exe',
    "sudo 'C:\\Program Files\\Git\\bin\\bash.exe'",
    'sudo env.exe bash',
    'sudo wsl rm -rf /mnt/c/opt/hoprig',
  ];
  for (const line of shells) assert.equal(id(line), 'shell-as-admin', line);
  assert.equal(id('sudo su.exe'), 'escalator-as-admin');
  assert.equal(id('sudo nice.exe bash'), 'passer-as-admin');
  // The same shell lines are plain administrator programs on other systems, read as before.
  const linux = { ...ctx, platform: 'linux' };
  assert.equal(id('sudo cmd', linux), null);
  assert.equal(id('sudo pwsh', linux), null);
});

// The escalator name is read as Windows reads it (either separator, any case, a trailing .exe dropped), so sudo.exe is
// sudo; and gsudo is another way to become administrator, never a command of hers, refused at every level.
test('on win32 sudo.exe is read as sudo, and gsudo is a non-sudo escalator', () => {
  assert.equal(id('sudo.exe rm -rf C:\\opt\\hoprig'), 'hoprig-own');
  assert.equal(id('Sudo.EXE rm -rf C:\\opt\\hoprig'), 'hoprig-own');
  assert.equal(id('sudo.exe cmd'), 'shell-as-admin');
  assert.equal(id('gsudo rm -rf C:\\opt\\hoprig'), 'non-sudo-escalator');
  assert.equal(id('gsudo cmd'), 'non-sudo-escalator');
  assert.equal(id('sudo gsudo rm -rf C:\\opt\\other'), 'escalator-as-admin');
  // gsudo is not an escalator on other systems: there it is an ordinary program.
  assert.equal(id('gsudo rm -rf /opt/hoprig', { ...ctx, platform: 'linux' }), null);
});

// Inside single quotes Bash keeps a backslash as written, so the second reading (backslashes kept) must not double it:
// `'\tmp\x'` was read as the share `\\tmp\x` and refused as hoprig-own though it names no Hoprig folder.
test('on win32 a single-quoted path from the root of the drive is read as written, not as a share', () => {
  for (const q of ["'", '"']) {
    assert.equal(id(`sudo tee ${q}\\tmp\\elsewhere\\x${q}`), null, `${q}-quoted: not refused`);
    assert.ok(sudoArgv(`sudo tee ${q}\\tmp\\elsewhere\\x${q}`, ctx).argv, `${q}-quoted: a runnable argv`);
  }
  // The same quoting into one of Hoprig's folders stays refused, and a share written as one is still a share.
  assert.equal(id(`sudo tee '${HOPRIG[0]}\\x'`), 'hoprig-own');
  assert.equal(id(`sudo tee "${HOPRIG[2]}\\x"`), 'hoprig-own');
  assert.equal(id("sudo tee '\\\\localhost\\C$\\x'"), 'hoprig-own');
});

// cmd fills in %NAME% itself, so a word holding one would reach a place her own tool cannot read; it is refused like a
// $-word (word-not-read).
test('on win32 a word holding an environment variable is refused for her own tool', () => {
  const r = sudoArgv('sudo rm %USERPROFILE%', ctx);
  assert.ok(r.refuse, 'refused');
  assert.equal(r.refuse.id, 'word-not-read');
  // Not a win32 concern elsewhere: %NAME% is an ordinary word on other systems.
  const linux = sudoArgv('sudo rm %USERPROFILE%', { ...ctx, platform: 'linux' });
  assert.ok(linux.argv, 'a runnable argv on linux');
});

test('each system is told only what is refused there: gsudo and %NAME% are named on Windows, never on Linux or macOS', () => {
  const words = (line, c) => (adminRefusal(line, c) || {}).why || '';
  for (const platform of ['linux', 'darwin']) {
    const posix = { hoprigDirs: [], home: '/home/alex', cwd: '/home/alex', platform };
    assert.equal(words('sudo su', posix), 'it runs another way to become administrator as the program (sudo su, sudo sudo, sudo doas, sudo pkexec, sudo runas, sudo sudoedit), which is never a command of hers', platform);
    const v = words('sudo cp $X /tmp/y', { ...posix, argv: true });
    assert.match(v, /^it holds a variable \(a word with \$\), which only a shell fills in/, platform);
    assert.doesNotMatch(v, /%NAME%|Windows/);
  }
  assert.match(words('sudo su', ctx), /sudo sudoedit, sudo gsudo\), which is never a command of hers$/);
  assert.match(words('sudo copy %X% C:\\opt\\y', { ...ctx, argv: true }), /^it holds a variable \(a word with \$, or %NAME%\), which only a shell fills in/);
});
