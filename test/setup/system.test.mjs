import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const S = await import('../../src/setup/system.mjs');

const hasOnly = (...names) => (cmd) => names.includes(cmd);

test('package manager: the first Linux one found, brew on macOS, none on Windows', () => {
  assert.equal(S.detectPackageManager('linux', hasOnly('apt-get', 'dnf')), 'apt');
  assert.equal(S.detectPackageManager('linux', hasOnly('dnf', 'yum')), 'dnf');
  assert.equal(S.detectPackageManager('linux', hasOnly('yum')), 'yum');
  assert.equal(S.detectPackageManager('linux', hasOnly('pacman')), 'pacman');
  assert.equal(S.detectPackageManager('linux', hasOnly('zypper')), 'zypper');
  assert.equal(S.detectPackageManager('linux', hasOnly('apk')), 'apk');
  assert.equal(S.detectPackageManager('linux', hasOnly('brew')), null, 'Linuxbrew is not the system package manager');
  assert.equal(S.detectPackageManager('linux', hasOnly()), null);
  assert.equal(S.detectPackageManager('darwin', hasOnly('brew')), 'brew');
  assert.equal(S.detectPackageManager('darwin', hasOnly()), null);
  assert.equal(S.detectPackageManager('win32', hasOnly('brew', 'apt-get')), null);
});

test('install commands per package manager, with sudo unless root, never sudo for brew', () => {
  // apt is told not to ask (a package's question waits for ever where nobody sees it), inside the sudo command
  assert.deepEqual(S.installCommands('apt', ['tmux']), [['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update'], ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'tmux']]);
  assert.deepEqual(S.installCommands('apt', ['tmux'], { root: true }), [['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update'], ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'tmux']]);
  assert.deepEqual(S.installCommands('dnf', ['tmux']), [['sudo', 'dnf', 'install', '-y', 'tmux']]);
  assert.deepEqual(S.installCommands('yum', ['tmux']), [['sudo', 'yum', 'install', '-y', 'tmux']]);
  assert.deepEqual(S.installCommands('pacman', ['tmux']), [['sudo', 'pacman', '-S', '--needed', '--noconfirm', 'tmux']]);
  assert.deepEqual(S.installCommands('zypper', ['tmux']), [['sudo', 'zypper', '--non-interactive', 'install', 'tmux']]);
  assert.deepEqual(S.installCommands('apk', ['bash', 'curl'], { root: true }), [['apk', 'add', 'bash', 'curl']]);
  assert.deepEqual(S.installCommands('brew', ['tmux']), [['brew', 'install', 'tmux']]);
  assert.deepEqual(S.installCommands('brew', ['tmux'], { root: true }), [['brew', 'install', 'tmux']]);
  assert.equal(S.installCommands(null, ['tmux']), null);
});

test('a privileged command is phrased one way: sudo where it is, nothing for root, "as root:" where there is no sudo', () => {
  const line = 'sudo env DEBIAN_FRONTEND=noninteractive apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential && cd "/home/u/app" && npm rebuild node-pty';
  const withSudo = { platform: 'linux', root: false, has: () => true };
  const noSudo = { platform: 'linux', root: false, has: (c) => c !== 'sudo' };
  const root = { platform: 'linux', root: true, has: () => false };
  assert.equal(S.adminWay(withSudo), 'sudo');
  assert.equal(S.adminWay(noSudo), 'none');
  assert.equal(S.adminWay(root), 'root');
  assert.equal(S.forThisUser(line, withSudo), line);
  assert.equal(S.forThisUser(line, root), 'env DEBIAN_FRONTEND=noninteractive apt-get update && env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential && cd "/home/u/app" && npm rebuild node-pty');
  // without sudo: root runs the privileged part, the rest stays the user's own (nothing is built as root in a home folder)
  assert.equal(S.forThisUser(line, noSudo), 'as root: env DEBIAN_FRONTEND=noninteractive apt-get update && env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential   then as yourself: cd "/home/u/app" && npm rebuild node-pty');
  assert.equal(S.forThisUser('sudo apt update && sudo apt upgrade', noSudo), 'as root: apt update && apt upgrade');
  assert.equal(S.forThisUser("curl -1sLf 'https://x.example/key' | sudo gpg --dearmor -o /usr/share/keyrings/k.gpg", noSudo), "as root: curl -1sLf 'https://x.example/key' | gpg --dearmor -o /usr/share/keyrings/k.gpg");
  // a quoted path is one argument: " && " or "sudo" inside it never splits the line or loses a word
  const odd = `sudo apt-get install -y git && cd ${S.showCommand(['/home/u/a && sudo b'])} && npm ci`;
  assert.equal(S.forThisUser(odd, noSudo), "as root: apt-get install -y git   then as yourself: cd '/home/u/a && sudo b' && npm ci");
  assert.equal(S.forThisUser(odd, root), "apt-get install -y git && cd '/home/u/a && sudo b' && npm ci");
  assert.equal(S.forThisUser(`cd "/x/it's && sudo y" && make`, noSudo), `cd "/x/it's && sudo y" && make`, 'no sudo outside the quotes: left as it is');
  assert.deepEqual(S.splitUnquoted(`a && 'b && c' && "d \\" && e" && f`, ' && '), ['a', "'b && c'", `"d \\" && e"`, 'f']);
  // a line without sudo is nobody's business, and Windows has no sudo to miss
  assert.equal(S.forThisUser('hoprig passwd', noSudo), 'hoprig passwd');
  assert.equal(S.forThisUser('', noSudo), '');
  assert.equal(S.adminWay({ platform: 'win32', root: false, has: () => false }), 'sudo');
});

test('a quiet run keeps the output in a log and gives the last lines back only when it fails', async () => {
  const log = path.join(s.tmp, 'quiet.log');
  const ok = await S.runQuiet(['sh', '-c', 'echo line one; echo line two'], { log });
  assert.deepEqual(ok, { ok: true, code: 0, tail: '' });
  const bad = await S.runQuiet(['sh', '-c', 'echo before; echo "E: it broke" >&2; exit 3'], { log });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.match(bad.tail, /E: it broke/);
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /^\$ sh -c 'echo line one; echo line two'\nline one\nline two\n\(exit 0\)\n\$ sh -c /);
  assert.match(text, /E: it broke\n\(exit 3\)\n$/);
  assert.equal((fs.statSync(log).mode & 0o777).toString(8), '600');
});

test('showCommand quotes only what needs it', () => {
  assert.equal(S.showCommand(['sudo', 'apt-get', 'install', '-y', 'tmux']), 'sudo apt-get install -y tmux');
  assert.equal(S.showCommand(['echo', "it's here", 'a b']), `echo 'it'\\''s here' 'a b'`);
  assert.equal(S.showCommands([['a'], ['b', 'c']]), 'a && b c');
});

test('npm goes through cmd.exe on Windows only', () => {
  assert.deepEqual(S.npmArgv(['install', '-g', 'x'], 'linux'), ['npm', 'install', '-g', 'x']);
  assert.deepEqual(S.npmArgv(['install', '-g', 'x'], 'darwin'), ['npm', 'install', '-g', 'x']);
  assert.deepEqual(S.npmArgv(['install', '-g', 'x'], 'win32'), ['cmd.exe', '/d', '/s', '/c', 'npm', 'install', '-g', 'x']);
});

test('npm 12 and newer get the flag that allows a package named by an address; older npm and other sources get none', async () => {
  const url = 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz';
  assert.deepEqual(S.npmSourceFlags(url, 12), ['--allow-remote=root']);
  assert.deepEqual(S.npmSourceFlags(url, 13), ['--allow-remote=root']);
  for (const major of [9, 10, 11, null]) assert.deepEqual(S.npmSourceFlags(url, major), [], String(major));
  for (const git of ['git+https://example.com/a/hoprig.git', 'git://example.com/hoprig', 'github:allswebtech/hoprig', 'https://example.com/a/hoprig.git']) assert.deepEqual(S.npmSourceFlags(git, 12), ['--allow-git=root'], git);
  for (const plain of ['hoprig', 'hoprig@latest', '/tmp/hoprig-0.1.0.tgz', './hoprig']) assert.deepEqual(S.npmSourceFlags(plain, 12), [], plain);
  // the version of whatever npm is first on PATH
  const bin = fakeBin(path.join(s.tmp, 'npm12'), { npm: 'echo 12.2.2' });
  assert.equal(await S.npmMajor({ env: { PATH: bin }, platform: 'linux' }), 12);
  assert.equal(await S.npmMajor({ env: { PATH: path.join(s.tmp, 'nothing-here') }, platform: 'linux' }), null);
});

test('versions: parse and compare', () => {
  assert.deepEqual(S.parseVersion('v20.11.1'), [20, 11, 1]);
  assert.deepEqual(S.parseVersion('2.1.325 (Claude Code)'), [2, 1, 325]);
  assert.deepEqual(S.parseVersion('tmux 3.4'), [3, 4, 0]);
  assert.deepEqual(S.parseVersion('tmux next-3.5'), [3, 5, 0]);
  assert.equal(S.parseVersion('no version'), null);
  assert.equal(S.compareVersions('2.1.325', '2.1.311'), 1);
  assert.equal(S.compareVersions('2.1.9', '2.1.10'), -1);
  assert.equal(S.compareVersions('20.0.0', '20.0.0'), 0);
  assert.equal(S.compareVersions('19.9.0', '20.0.0'), -1);
  assert.equal(S.compareVersions('x', '1.0.0'), -1);
});

test('which finds executables on the given PATH only', () => {
  const dir = fakeBin(path.join(s.tmp, 'bin-which'), { tool: 'exit 0' });
  fs.writeFileSync(path.join(dir, 'notexec'), 'x', { mode: 0o644 });
  const env = { PATH: dir };
  assert.equal(S.which('tool', env, 'linux'), path.join(dir, 'tool'));
  assert.equal(S.which('notexec', env, 'linux'), null);
  assert.equal(S.which('missing', env, 'linux'), null);
  assert.equal(S.which(path.join(dir, 'tool'), {}, 'linux'), path.join(dir, 'tool'));
  assert.equal(S.which('', env, 'linux'), null);
});

test('capture and stream report output, exit codes and programs that do not exist', async () => {
  const dir = fakeBin(path.join(s.tmp, 'bin-run'), { two: 'echo one; echo two >&2; exit 3' });
  const c = await S.capture([path.join(dir, 'two')]);
  assert.equal(c.ok, false);
  assert.equal(c.code, 3);
  assert.equal(c.stdout.trim(), 'one');
  const missing = await S.capture([path.join(dir, 'nope')]);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'ENOENT');
  const lines = [];
  const r = await S.stream([path.join(dir, 'two')], { onLine: (l) => lines.push(l) });
  assert.equal(r.code, 3);
  assert.deepEqual(lines.sort(), ['one', 'two']);
});

test('os-release is read into fields', () => {
  const f = path.join(s.tmp, 'os-release');
  fs.writeFileSync(f, 'ID=debian\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n');
  assert.deepEqual(S.osRelease(f), { ID: 'debian', PRETTY_NAME: 'Debian GNU/Linux 12 (bookworm)' });
  assert.deepEqual(S.osRelease(path.join(s.tmp, 'none')), {});
});
