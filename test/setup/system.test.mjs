import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SHELL_STANDINS } from '../seal.mjs';
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
  if (process.platform !== 'win32') assert.equal((fs.statSync(log).mode & 0o777).toString(8), '600');
});

test('showCommand quotes only what needs it', () => {
  assert.equal(S.showCommand(['sudo', 'apt-get', 'install', '-y', 'tmux']), 'sudo apt-get install -y tmux');
  assert.equal(S.showCommand(['echo', "it's here", 'a b']), `echo 'it'\\''s here' 'a b'`);
  assert.equal(S.showCommands([['a'], ['b', 'c']]), 'a && b c');
});

test('npm goes through cmd.exe on Windows only', () => {
  const env = { PATH: fakeBin(path.join(s.tmp, 'npm-on-path'), { npm: 'exit 0' }) }; // seal: a value no program is started with
  assert.deepEqual(S.npmArgv(['install', '-g', 'x'], 'linux', env), ['npm', 'install', '-g', 'x']);
  assert.deepEqual(S.npmArgv(['install', '-g', 'x'], 'darwin', env), ['npm', 'install', '-g', 'x']);
  assert.deepEqual(S.npmArgv(['install', '-g', 'x'], 'win32', env), ['cmd.exe', '/d', '/s', '/c', 'npm', 'install', '-g', 'x']);
});

// A made-up Node folder: bin/node (this Node) and lib/node_modules/npm/bin/npm-cli.js, a stand-in that prints the first
// folder of its PATH and its arguments. nodeNpm is given it with no override, so nothing real is ever run.
function madeUpNode(name) {
  const root = path.join(s.tmp, name);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(root, 'bin', 'node'));
  const cli = path.join(root, 'lib', 'node_modules', 'npm', 'bin');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'npm-cli.js'), "console.log('first ' + process.env.PATH.split(require('node:path').delimiter)[0]); console.log('args ' + process.argv.slice(2).join(' '));\n");
  return { node: path.join(root, 'bin', 'node'), bin: path.join(root, 'bin'), cli: path.join(cli, 'npm-cli.js') };
}

test('npm: the one on PATH when there is one, else the npm of the Node Hoprig runs on, else one plain sentence', { skip: process.platform === 'win32' && 'the made-up Node folder has the layout of Linux and macOS (bin/node, lib/node_modules/npm)' }, async () => {
  const withNpm = fakeBin(path.join(s.tmp, 'g5-path'), { npm: 'echo "path npm $*"' });
  const empty = fakeBin(path.join(s.tmp, 'g5-empty'), {});
  const n = madeUpNode('g5-node');
  // The npm beside the Node is used only for the system this runs on (npmArgv): the tests' own platform.
  const here = process.platform;
  const own = S.nodeNpm(here, { node: n.node, instead: '' });
  assert.equal(own[0], n.node);
  assert.equal(own.at(-1), n.cli);
  // PATH first: an npm stand-in on PATH is what runs, never the one beside the Node
  assert.deepEqual(S.npmArgv(['ls'], here, { PATH: withNpm }, own), ['npm', 'ls']); // seal: a value no program is started with
  // no npm on PATH (a service, an ssh login without nvm's folder): the Node's own npm, its folder first on PATH
  const argv = S.npmArgv(['install', 'x'], here, { PATH: empty }, own); // seal: a value no program is started with
  assert.equal(S.showCommand(argv), `${n.node} ${n.cli} install x`, 'shown as it would be typed');
  const r = await S.capture(argv, { env: { PATH: empty } }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [`first ${n.bin}`, 'args install x']);
  // neither: plain npm, which says what to do instead of "spawn npm ENOENT"
  assert.deepEqual(S.npmArgv(['ls'], here, { PATH: empty }, null), ['npm', 'ls']); // seal: a value no program is started with
  const c = await S.capture(['npm', 'ls'], { env: { PATH: empty } }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  assert.equal(c.stderr, S.NPM_MISSING);
  const lines = [];
  const st = await S.stream(['npm', 'ls'], { env: { PATH: empty }, onLine: (l) => lines.push(l) }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  assert.equal(st.ok, false);
  assert.deepEqual(lines, [S.NPM_MISSING]);
  assert.doesNotMatch(`${c.stderr} ${st.output}`, /ENOENT|spawn/);
  // a Node with no npm beside it
  assert.equal(S.nodeNpm('linux', { node: path.join(empty, 'node'), instead: '' }), null);
  // the version check finds npm the same way
  assert.equal(await S.npmMajor({ env: { PATH: withNpm }, platform: 'linux' }), null, 'the stand-in prints no version'); // seal: only the test's own folders, in an environment that keeps the runner's variables
});

test('npm 12 and newer get the flag that allows a package named by an address; older npm and other sources get none', SHELL_STANDINS, async () => {
  const url = 'https://github.com/allswebtech/hoprig/archive/refs/heads/main.tar.gz';
  assert.deepEqual(S.npmSourceFlags(url, 12), ['--allow-remote=root']);
  assert.deepEqual(S.npmSourceFlags(url, 13), ['--allow-remote=root']);
  for (const major of [9, 10, 11, null]) assert.deepEqual(S.npmSourceFlags(url, major), [], String(major));
  for (const git of ['git+https://example.com/a/hoprig.git', 'git://example.com/hoprig', 'github:allswebtech/hoprig', 'https://example.com/a/hoprig.git']) assert.deepEqual(S.npmSourceFlags(git, 12), ['--allow-git=root'], git);
  for (const plain of ['hoprig', 'hoprig@latest', '/tmp/hoprig-0.1.0.tgz', './hoprig']) assert.deepEqual(S.npmSourceFlags(plain, 12), [], plain);
  // the version of whatever npm is first on PATH
  const bin = fakeBin(path.join(s.tmp, 'npm12'), { npm: 'echo 12.2.2' });
  assert.equal(await S.npmMajor({ env: { PATH: bin }, platform: 'linux' }), 12); // seal: only the test's own folders, in an environment that keeps the runner's variables
  assert.equal(await S.npmMajor({ env: { PATH: path.join(s.tmp, 'nothing-here') }, platform: 'linux' }), null); // seal: only the test's own folders, in an environment that keeps the runner's variables
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

test('which finds executables on the given PATH only', { skip: process.platform === 'win32' && 'file modes: Windows has no execute bit, and Linux PATH rules are handed in' }, () => {
  const dir = fakeBin(path.join(s.tmp, 'bin-which'), { tool: 'exit 0' });
  fs.writeFileSync(path.join(dir, 'notexec'), 'x', { mode: 0o644 });
  const env = { PATH: dir }; // seal: a value no program is started with
  assert.equal(S.which('tool', env, 'linux'), path.join(dir, 'tool'));
  assert.equal(S.which('notexec', env, 'linux'), null);
  assert.equal(S.which('missing', env, 'linux'), null);
  assert.equal(S.which(path.join(dir, 'tool'), {}, 'linux'), path.join(dir, 'tool'));
  assert.equal(S.which('', env, 'linux'), null);
});

test('which on Windows takes the file Windows can start, not the shell script npm puts beside it', () => {
  const dir = path.join(s.tmp, 'bin-which-win');
  const other = path.join(s.tmp, 'bin-which-win-2');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  for (const name of ['gate', 'gate.cmd', 'gate.ps1', 'bare']) fs.writeFileSync(path.join(dir, name), 'x');
  fs.writeFileSync(path.join(other, 'bare.cmd'), 'x');
  fs.writeFileSync(path.join(other, 'late.exe'), 'x');
  fs.writeFileSync(path.join(other, 'plain'), 'x');
  fs.writeFileSync(path.join(other, 'plain.CMD'), 'x');
  // (the extensions in the case the files have: the test also runs where file names are case-sensitive)
  const env = { PATH: `${dir};${other}`, PATHEXT: '.exe;.cmd' };  // seal: which() is a pure function; no program is started
  // npm's three files side by side: the .cmd, never the extensionless script and never the .ps1
  assert.equal(S.which('gate', env, 'win32'), path.join(dir, 'gate.cmd'));
  // a later folder's startable file wins over an earlier folder's bare name
  assert.equal(S.which('bare', env, 'win32'), path.join(other, 'bare.cmd'));
  assert.equal(S.which('late', env, 'win32'), path.join(other, 'late.exe'));
  // a name given with its extension is that file
  assert.equal(S.which('gate.cmd', env, 'win32'), path.join(dir, 'gate.cmd'));
  // the bare name is the last resort, and a path is checked the same way
  assert.equal(S.which('bare', { ...env, PATH: dir }, 'win32'), path.join(dir, 'bare'));  // seal: which() is a pure function; no program is started
  assert.equal(S.which(path.join(dir, 'gate'), env, 'win32'), path.join(dir, 'gate.cmd'));
  assert.equal(S.which('missing', env, 'win32'), null);
  // the default extensions when PATHEXT is not set, and PATH spelled as Windows spells it
  assert.equal(S.which('plain', { Path: other }, 'win32'), path.join(other, 'plain.CMD'));  // seal: which() is a pure function; no program is started
});

test('capture and stream report output, exit codes and programs that do not exist', SHELL_STANDINS, async () => {
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

test('a move or a removal as a person types it: the POSIX line on Linux and macOS, PowerShell on Windows; a link removed alone', () => {
  const odd = "C:\\Users\\al'ex\\my $(x) folder";
  for (const p of ['linux', 'darwin']) {
    assert.equal(S.showFileCommand('mv', ['/a b/x', '/a b/y'], p), "mv '/a b/x' '/a b/y'");
    assert.equal(S.showFileCommand('rm -rf', ['/a/x'], p), 'rm -rf /a/x');
    assert.equal(S.showLinkRemoveCommand('/a b/memory', p), "rm '/a b/memory'");
    assert.equal(S.showThen('rm /a/l', 'hoprig project link x', p), 'rm /a/l && hoprig project link x');
  }
  assert.equal(S.showFileCommand('mv', [odd, 'C:\\y'], 'win32'), "Move-Item -LiteralPath 'C:\\Users\\al''ex\\my $(x) folder' -Destination 'C:\\y'");
  assert.equal(S.showFileCommand('rm', ['C:\\x\\lock'], 'win32'), "Remove-Item -LiteralPath 'C:\\x\\lock'");
  // A folder: walked by the block itself, each link inside removed as a link (never Remove-Item -Recurse, which in
  // Windows PowerShell 5.1 could go into a junction); proven on the real system in pastelines-windows.test.mjs.
  const tree = S.showFileCommand('rm -rf', ["C:\\it's"], 'win32');
  assert.match(tree, /^& \{ param\(\$p\) \$ErrorActionPreference = 'Stop'; .*ReparsePoint.*\} 'C:\\it''s'$/);
  assert.doesNotMatch(tree, /-Recurse/);
  // A junction or a folder link: Get-Item does not follow it, and Delete() removes the link itself (never -Recurse).
  assert.equal(S.showLinkRemoveCommand(odd, 'win32'), "(Get-Item -LiteralPath 'C:\\Users\\al''ex\\my $(x) folder' -Force).Delete()");
  // Windows PowerShell 5.1 has no &&.
  assert.equal(S.showThen('a', 'b', 'win32'), 'a; if ($?) { b }', 'the second only when the first worked');
  // A memory folder merged into another, never over a file there, removed once empty.
  for (const p of ['linux', 'darwin']) assert.equal(S.showMergeCommand('/a b/mem', '/p/mem', p), "mv -n '/a b/mem'/* /p/mem/ && rmdir '/a b/mem'");
  assert.equal(S.showMergeCommand("C:\\al'ex\\mem", 'C:\\p\\mem', 'win32'), "Get-ChildItem -LiteralPath 'C:\\al''ex\\mem' -Force | Move-Item -Destination 'C:\\p\\mem'; (Get-Item -LiteralPath 'C:\\al''ex\\mem' -Force).Delete()");
});
