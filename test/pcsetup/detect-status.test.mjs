// Detection and system status from realistic command output per OS (no real command runs: `run` is a fake).
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectItem, detectKits, parseGhAuth, preselect, sshKeys, sysFacts, versionOf } from '../../src/pcsetup/detect.mjs';
import { KITS } from '../../src/pcsetup/kits.mjs';
import {
  clockOffset, countLines, diskChecks, githubChecks, kitChecks, parseAptCheck, parseAptList, parseMeminfo, parseSoftwareUpdate, parseSwapusage, updatesCheck,
} from '../../src/pcsetup/status.mjs';

const TOKEN = 'gho_' + 'A'.repeat(36);
// gh 2.x `gh auth status` (it prints the token masked, but an older version or --show-token prints it whole)
const GH_STATUS = `github.com\n  ✓ Logged in to github.com account octo-dev (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: ${TOKEN}\n  - Token scopes: 'gist', 'read:org', 'repo'\n`;

/** A fake computer: `bins` on PATH, `out` maps "argv joined" → { ok, stdout, stderr, code }. */
async function fake({ platform = 'linux', pm = 'apt', bins = [], out = {}, files = [], clt } = {}) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.join(' '));
    const r = out[argv.join(' ')];
    return r ? { ok: r.code === undefined ? true : r.code === 0, code: r.code ?? 0, stdout: r.stdout || '', stderr: r.stderr || '' } : { ok: false, code: 1, stdout: '', stderr: 'not found' };
  };
  const sys = await sysFacts({ platform, pm, has: (b) => bins.includes(b), run, exists: (f) => files.includes(f), home: '/home/dev', root: false, user: 'dev', clt, dnf5: false });
  return { sys, calls };
}

test('versions are read from each tool\'s own answer', () => {
  assert.equal(versionOf('git version 2.43.0'), '2.43.0');
  assert.equal(versionOf('v22.11.0'), '22.11.0');
  assert.equal(versionOf('gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0'), '2.62.0');
  assert.equal(versionOf('tmux 3.4'), '3.4');
  assert.equal(versionOf('ripgrep 14.1.0\n\nfeatures:+pcre2'), '14.1.0');
  assert.equal(versionOf('jq-1.7.1'), '1.7.1');
  assert.equal(versionOf('Python 3.12.3'), '3.12.3');
  assert.equal(versionOf('pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)'), '24.0');
});

test('a fresh Ubuntu: everything missing except what is there; the default kits are preselected', async () => {
  const { sys } = await fake({ bins: ['curl', 'python3'], out: { 'curl --version': { stdout: 'curl 8.5.0 (x86_64-pc-linux-gnu)' }, 'python3 --version': { stdout: 'Python 3.12.3' }, 'python3 -m pip --version': { code: 1, stderr: '/usr/bin/python3: No module named pip' }, 'python3 -c import venv, ensurepip; print("venv ok")': { code: 1, stderr: "ModuleNotFoundError: No module named 'ensurepip'" } } });
  const f = await detectKits(sys);
  const st = (k, i) => f[k].find((x) => x.id === i).state;
  assert.equal(st('basics', 'git'), 'missing');
  assert.equal(st('basics', 'curl'), 'ok');
  assert.equal(st('python', 'python'), 'ok');
  assert.equal(st('python', 'pip'), 'missing');
  assert.equal(st('python', 'venv'), 'missing');
  assert.equal(st('github', 'identity'), 'missing');
  assert.equal(st('github', 'signin'), 'missing');
  assert.deepEqual(preselect(f), ['basics', 'node', 'python', 'github', 'extras']);
});

test('macOS without the command line tools: git and python3 count as missing and are NOT run (that opens Apple\'s window)', async () => {
  const { sys, calls } = await fake({ platform: 'darwin', pm: 'brew', bins: ['git', 'python3'], clt: false });
  const git = await detectItem(KITS[0].items[0], sys);
  assert.equal(git.state, 'missing');
  assert.ok(!calls.some((c) => c.startsWith('git ') || c.startsWith('python3')));
  const build = await detectItem(KITS[0].items.find((i) => i.id === 'build'), sys);
  assert.equal(build.state, 'missing');
});

test('an old Node is "old" (past its end of life), never "missing"', async () => {
  const { sys } = await fake({ bins: ['node'], out: { 'node --version': { stdout: 'v18.19.1' } } });
  const r = await detectItem(KITS.find((k) => k.id === 'node').items[0], sys);
  assert.equal(r.state, 'old');
  assert.equal(r.version, '18.19.1');
});

test('GitHub sign-in: only the account name is kept, never the token', async () => {
  assert.deepEqual(parseGhAuth({ ok: true, stdout: '', stderr: GH_STATUS }), { signedIn: true, host: 'github.com', account: 'octo-dev' });
  assert.deepEqual(parseGhAuth({ ok: true, stdout: 'github.com\n  ✓ Logged in to github.com as octo (oauth_token)\n' }).account, 'octo');
  assert.equal(parseGhAuth({ ok: false, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }).signedIn, false);
  const { sys } = await fake({ bins: ['gh', 'git'], out: { 'gh auth status --hostname github.com': { stdout: GH_STATUS }, 'git config --global user.name': { stdout: 'Dev One\n' }, 'git config --global user.email': { stdout: 'dev@example.com\n' } }, files: ['/home/dev/.ssh/id_ed25519.pub'] });
  const checks = await githubChecks(sys);
  assert.ok(!JSON.stringify(checks).includes(TOKEN));
  assert.ok(!JSON.stringify(checks).includes('gho_'));
  assert.deepEqual(checks.map((c) => c.status), ['ok', 'ok', 'ok']);
  assert.match(checks[2].detail, /id_ed25519/);
});

test('SSH keys are looked for in the home as the system of the facts names it', () => {
  const keys = (platform, home, file) => sshKeys({ platform, home, exists: (f) => f === file });
  assert.deepEqual(keys('win32', 'C:\\Users\\dev', 'C:\\Users\\dev\\.ssh\\id_rsa.pub'), ['id_rsa']);
  assert.deepEqual(keys('linux', '/home/dev', '/home/dev/.ssh/id_ed25519.pub'), ['id_ed25519']);
});

test('Ubuntu updates: apt-check "12;3", reboot-required → warn with both', async () => {
  assert.deepEqual(parseAptCheck('12;3'), { updates: 12, security: 3 });
  assert.equal(parseAptCheck('garbage'), null);
  const { sys } = await fake({ files: ['/usr/lib/update-notifier/apt-check', '/var/run/reboot-required'], out: { '/usr/lib/update-notifier/apt-check': { stderr: '12;3' } } });
  const c = await updatesCheck(sys);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /12 updates waiting · a restart is pending/);
});

test('Debian without apt-check: `apt list --upgradable` is counted', async () => {
  const list = 'Listing... Done\nbash/stable 5.2.15-2+b8 amd64 [upgradable from: 5.2.15-2+b7]\nopenssl/stable-security 3.0.15-1~deb12u1 amd64 [upgradable from: 3.0.14-1~deb12u2]\n';
  assert.equal(parseAptList(list), 2);
  const { sys } = await fake({ out: { 'apt list --upgradable': { stdout: list } } });
  assert.match((await updatesCheck(sys)).detail, /2 updates waiting/);
  const none = await fake({ out: { 'apt list --upgradable': { stdout: 'Listing... Done\n' } } });
  assert.equal((await updatesCheck(none.sys)).status, 'ok');
});

test('offline skips the Linux package-manager probe (a real program), but still reads the restart file', async () => {
  const { sys, calls } = await fake({ files: ['/usr/lib/update-notifier/apt-check', '/var/run/reboot-required'], out: { '/usr/lib/update-notifier/apt-check': { stderr: '12;3' } } });
  const c = await updatesCheck(sys, { offline: true });
  assert.match(c.detail, /updates not checked · a restart is pending/);
  assert.ok(!calls.some((x) => x.includes('apt-check') || x.includes('apt list')), `offline must start no package manager; it ran: ${calls.join('; ')}`);
});

test('Fedora: dnf check-update exit 100 lists packages; needs-restarting -r exit 1 = restart', async () => {
  const txt = '\nkernel.x86_64                6.11.7-300.fc41      updates\nfirefox.x86_64               132.0.2-1.fc41       updates\n';
  assert.equal(countLines(txt), 2);
  const { sys } = await fake({ pm: 'dnf', bins: ['needs-restarting'], out: { 'dnf check-update -q --cacheonly': { code: 100, stdout: txt }, 'needs-restarting -r': { code: 1, stdout: 'Reboot is required' } } });
  assert.match((await updatesCheck(sys)).detail, /2 updates waiting · a restart is pending/);
});

test('macOS softwareupdate output', () => {
  const t = 'Software Update Tool\n\nFinding available software\nSoftware Update found the following new or updated software:\n* Label: macOS Sequoia 15.1.1-24B91\n\tTitle: macOS Sequoia 15.1.1, Version: 15.1.1, Size: 1528320K, Recommended: YES, Action: restart,\n* Label: Safari18.1.1\n';
  assert.deepEqual(parseSoftwareUpdate(t), { updates: 2, restart: true });
  assert.deepEqual(parseSoftwareUpdate('No new software available.'), { updates: 0, restart: false });
});

test('memory and swap from /proc/meminfo and vm.swapusage', () => {
  const m = parseMeminfo('MemTotal:       16314732 kB\nMemFree:          912344 kB\nMemAvailable:    9876544 kB\nSwapTotal:       4194300 kB\nSwapFree:        4194300 kB\n');
  assert.equal(m.total, 16314732 * 1024);
  assert.equal(m.available, 9876544 * 1024);
  assert.equal(m.swapTotal, m.swapFree);
  const s = parseSwapusage('vm.swapusage: total = 2048.00M  used = 1536.25M  free = 511.75M  (encrypted)');
  assert.equal(s.swapTotal, 2048 * 1024 ** 2);
});

test('disks: warn when nearly full, fail when full; one line per disk', () => {
  const GB = 1024 ** 3;
  const fs = (free) => () => ({ type: 1, blocks: 100 * GB / 4096, bsize: 4096, bavail: free * GB / 4096 });
  assert.equal(diskChecks(['/home/dev'], fs(50))[0].status, 'ok');
  assert.equal(diskChecks(['/home/dev'], fs(8))[0].status, 'warn');
  assert.equal(diskChecks(['/home/dev'], fs(1))[0].status, 'fail');
  assert.equal(diskChecks(['/home/dev', '/home/dev/projects'], fs(50)).length, 1);
});

test('clock offset from a Date header', () => {
  assert.equal(clockOffset('Thu, 14 Nov 2026 10:00:00 GMT', Date.parse('2026-11-14T10:02:00Z')), 120);
  assert.equal(clockOffset(null), null);
});

test('kit checks: missing items carry the exact install command and the kit that fixes them; optional kits are info', async () => {
  const { sys } = await fake({ bins: [] });
  const checks = kitChecks(await detectKits(sys), sys);
  const tmux = checks.find((c) => c.id === 'extras.tmux');
  assert.equal(tmux.status, 'fail');
  assert.equal(tmux.fixKit, 'extras');
  // The fix runs the whole kit (every missing item of it), so the row shows the whole kit's plan.
  assert.equal(tmux.fix, 'sudo env DEBIAN_FRONTEND=noninteractive apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux ripgrep jq');
  const docker = checks.find((c) => c.id === 'docker.docker');
  assert.equal(docker.status, 'info');
  assert.deepEqual([docker.fixKit, docker.setupKit, docker.fix], [undefined, 'docker', 'hoprig pc setup --kits docker'], 'an optional kit is chosen in the sheet, never run from its row');
});

test('Windows detection: python (not python3), npm through cmd.exe, the C++ tools through vswhere', async () => {
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  const { sys, calls } = await fake({ platform: 'win32', pm: 'winget', bins: ['python', 'npm', 'node'], files: [vswhere.replace(/\\/g, '/')], out: {
    'python --version': { stdout: 'Python 3.14.0' },
    'cmd.exe /d /s /c npm --version': { stdout: '11.6.0' },
  } });
  sys.env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  sys.exists = () => true;
  const f = await detectKits(sys, ['python', 'node', 'basics']);
  assert.equal(f.python.find((i) => i.id === 'python').version, '3.14.0');
  assert.equal(f.node.find((i) => i.id === 'npm').version, '11.6.0');
  assert.ok(calls.some((c) => c.startsWith('cmd.exe /d /s /c npm')));
  assert.ok(calls.some((c) => c.includes('vswhere.exe -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64')));
  assert.equal(f.basics.find((i) => i.id === 'build').state, 'missing'); // vswhere answered nothing
  assert.deepEqual(f.basics.filter((i) => i.state === 'na').map((i) => i.id), ['curl', 'unzip']);
});

test('a PATH without Node and npm (an ssh login that skips nvm\'s lines): the ones Hoprig runs on, never "missing", with the fix', { skip: process.platform === 'win32' && 'a POSIX login: a PATH and home of Linux and macOS (/nowhere, /home/dev) on this system, and the fix names the shell\'s start file, which Windows has none of' }, async () => {
  const calls = [];
  // Only the npm beside Hoprig's Node answers (in tests HOPRIG_NODE_NPM points it at the runner's trap: never run here).
  const run = async (argv) => {
    calls.push(argv);
    return argv[0] !== 'npm' && argv.at(-1) === '--version' ? { ok: true, code: 0, stdout: '10.9.0\n', stderr: '' } : { ok: false, code: 1, stdout: '', stderr: 'not found' };
  };
  const sys = await sysFacts({ platform: process.platform, pm: 'apt', env: { PATH: '/nowhere' }, has: () => false, run, // seal: a value no program is started with (run is the test's own)
    exists: () => false, home: '/home/dev', root: false, user: 'dev', dnf5: false });
  const node = await detectItem(KITS.find((k) => k.id === 'node').items.find((i) => i.id === 'node'), sys);
  const npm = await detectItem(KITS.find((k) => k.id === 'node').items.find((i) => i.id === 'npm'), sys);
  assert.deepEqual([node.state, node.version], ['offpath', process.versions.node]);
  assert.deepEqual([npm.state, npm.version], ['offpath', '10.9.0']);
  assert.ok(calls.some((a) => a[0] !== 'npm'), 'npm was asked the way set-up asks it (npmArgv), not by its name');
  const lines = kitChecks({ node: [node, npm] }, sys).filter((c) => c.group === 'kit:node');
  for (const c of lines) {
    assert.equal(c.status, 'warn', c.detail);
    assert.match(c.detail, /not on this shell's PATH; the one that comes with the Node Hoprig runs on \(/);
    assert.match(c.fix, /^add the folder of .* to PATH in your shell's start file/);
  }
});
