// Kits: every install command per OS and package manager, as exact arrays, and idempotence (nothing to do when
// everything is there).
import assert from 'node:assert/strict';
import test from 'node:test';
import { KITS, KIT_IDS, NVM_INSTALL, PY_PATH_SCRIPT, buildPlan, debArch, pastEol, pmInstall } from '../../src/pcsetup/kits.mjs';

const allMissing = (sys, ids = KIT_IDS) => Object.fromEntries(ids.map((id) => [id, KITS.find((k) => k.id === id).items.filter((i) => !i.platforms || i.platforms.includes(sys.platform)).map((i) => ({ id: i.id, state: 'missing' }))]));
const allOk = (ids = KIT_IDS) => Object.fromEntries(ids.map((id) => [id, KITS.find((k) => k.id === id).items.map((i) => ({ id: i.id, state: 'ok' }))]));
const linux = (pm, over = {}) => ({ platform: 'linux', pm, root: false, user: 'dev', arch: 'x64', tmp: '/tmp', dnf5: false, ...over });
const argvs = (plan) => plan.steps.map((s) => s.argv);
const NVM = [
  ['bash', '-c', `[ -s "\${NVM_DIR:-$HOME/.nvm}"/nvm.sh ] || curl -o- ${NVM_INSTALL} | bash`],
  ['bash', '-c', 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh" && nvm install --lts'],
];
const DEFAULT_KITS = ['basics', 'node', 'python', 'github', 'extras'];

test('apt (not root): one package-list refresh, then each kit; gh from GitHub\'s own apt repository; nvm for Node', () => {
  const sys = linux('apt');
  const plan = buildPlan(DEFAULT_KITS, allMissing(sys), sys);
  const ENV = ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive'];
  assert.deepEqual(argvs(plan), [
    [...ENV, 'apt-get', 'update'],
    [...ENV, 'apt-get', 'install', '-y', 'git', 'curl', 'ca-certificates', 'unzip', 'build-essential', 'python3'],
    ...NVM,
    [...ENV, 'apt-get', 'install', '-y', 'python3', 'python3-pip', 'python3-venv'],
    ['sudo', 'mkdir', '-p', '-m', '755', '/etc/apt/keyrings'],
    ['sudo', 'curl', '-fsSL', '-o', '/etc/apt/keyrings/githubcli-archive-keyring.gpg', 'https://cli.github.com/packages/githubcli-archive-keyring.gpg'],
    ['sudo', 'chmod', 'go+r', '/etc/apt/keyrings/githubcli-archive-keyring.gpg'],
    ['sudo', 'sh', '-c', "echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list"],
    [...ENV, 'apt-get', 'update'],
    [...ENV, 'apt-get', 'install', '-y', 'gh'],
    [...ENV, 'apt-get', 'install', '-y', 'tmux', 'ripgrep', 'jq'],
  ]);
  assert.equal(plan.admin, true);
  assert.deepEqual(plan.cannot, []);
  // nvm runs as the user, never with sudo
  assert.equal(plan.steps.find((s) => s.kit === 'node').admin, false);
});

test('apt as root: no sudo anywhere; arm64 gets the arm64 repository line', () => {
  const sys = linux('apt', { root: true, arch: 'arm64' });
  const plan = buildPlan(['github'], allMissing(sys, ['github']), sys);
  assert.ok(argvs(plan).every((a) => a[0] !== 'sudo'));
  assert.match(argvs(plan).find((a) => a[0] === 'sh')[2], /arch=arm64 /);
  assert.equal(plan.admin, false);
  assert.equal(debArch('arm'), 'armhf');
});

test('dnf: dnf5 and dnf4 repository steps for gh, as the gh docs give them', () => {
  const five = buildPlan(['github'], allMissing(linux('dnf'), ['github']), linux('dnf', { dnf5: true }));
  assert.deepEqual(argvs(five), [
    ['sudo', 'dnf', 'install', '-y', 'dnf5-plugins'],
    ['sudo', 'dnf', 'config-manager', 'addrepo', '--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo'],
    ['sudo', 'dnf', 'install', '-y', 'gh'],
  ]);
  const four = buildPlan(['github'], allMissing(linux('dnf'), ['github']), linux('dnf'));
  assert.deepEqual(argvs(four), [
    ['sudo', 'dnf', 'install', '-y', 'dnf-command(config-manager)'],
    ['sudo', 'dnf', 'config-manager', '--add-repo', 'https://cli.github.com/packages/rpm/gh-cli.repo'],
    ['sudo', 'dnf', 'install', '-y', 'gh'],
  ]);
  const basics = buildPlan(['basics', 'python', 'extras'], allMissing(linux('dnf')), linux('dnf'));
  assert.deepEqual(argvs(basics), [
    ['sudo', 'dnf', 'install', '-y', 'git', 'curl', 'unzip', 'gcc', 'gcc-c++', 'make', 'python3'],
    ['sudo', 'dnf', 'install', '-y', 'python3', 'python3-pip'],
    ['sudo', 'dnf', 'install', '-y', 'tmux', 'ripgrep', 'jq'],
  ]);
});

test('pacman, zypper, apk: their own package names; apk installs Node from the distro (no nvm on musl)', () => {
  const p = linux('pacman');
  assert.deepEqual(argvs(buildPlan(['basics', 'github'], allMissing(p), p)), [
    ['sudo', 'pacman', '-S', '--needed', '--noconfirm', 'git', 'curl', 'unzip', 'base-devel', 'python'],
    ['sudo', 'pacman', '-S', '--needed', '--noconfirm', 'github-cli'],
  ]);
  const z = linux('zypper');
  assert.deepEqual(argvs(buildPlan(['github'], allMissing(z), z)), [
    ['sudo', 'zypper', '--non-interactive', 'addrepo', 'https://cli.github.com/packages/rpm/gh-cli.repo'],
    ['sudo', 'zypper', '--non-interactive', '--gpg-auto-import-keys', 'ref'],
    ['sudo', 'zypper', '--non-interactive', 'install', 'gh'],
  ]);
  const a = linux('apk', { root: true });
  assert.deepEqual(argvs(buildPlan(['basics', 'node', 'python', 'github'], allMissing(a), a)), [
    ['apk', 'add', 'git', 'curl', 'ca-certificates', 'unzip', 'build-base', 'python3', 'linux-headers'],
    ['apk', 'add', 'nodejs', 'npm'],
    ['apk', 'add', 'python3', 'py3-pip'],
    ['apk', 'add', 'github-cli'],
  ]);
});

test('Docker on Linux: Docker\'s own script, then the docker group for the user (not for root)', () => {
  const sys = linux('apt');
  assert.deepEqual(argvs(buildPlan(['docker'], allMissing(sys, ['docker']), sys)), [
    ['curl', '-fsSL', 'https://get.docker.com', '-o', '/tmp/get-docker.sh'],
    ['sudo', 'sh', '/tmp/get-docker.sh'],
    ['sudo', 'usermod', '-aG', 'docker', 'dev'],
  ]);
  const root = linux('apt', { root: true });
  assert.deepEqual(argvs(buildPlan(['docker'], allMissing(root, ['docker']), root)), [
    ['curl', '-fsSL', 'https://get.docker.com', '-o', '/tmp/get-docker.sh'],
    ['sh', '/tmp/get-docker.sh'],
  ]);
  assert.equal(KITS.find((k) => k.id === 'docker').defaultOn, false);
});

test('macOS: Homebrew first when it is missing, then brew; build tools through xcode-select', () => {
  const mac = { platform: 'darwin', pm: null, root: false, arch: 'arm64', tmp: '/tmp' };
  const plan = buildPlan(['basics', 'extras', 'docker'], allMissing(mac), mac);
  assert.deepEqual(argvs(plan), [
    ['/bin/bash', '-c', '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'],
    ['brew', 'install', 'git'],
    ['xcode-select', '--install'],
    ['brew', 'install', 'tmux', 'ripgrep', 'jq'],
    ['brew', 'install', '--cask', 'docker-desktop'],
  ]);
  const brew = { ...mac, pm: 'brew' };
  assert.deepEqual(argvs(buildPlan(['node', 'github'], allMissing(brew), brew)), [...NVM, ['brew', 'install', 'gh']]);
});

test('Windows: winget ids (each once), the Python install manager, the VS C++ workload; no tmux/unzip/curl items', () => {
  const win = { platform: 'win32', pm: 'winget', root: false, arch: 'x64', tmp: 'C:\\t' };
  const W = (id) => ['winget', 'install', '-e', '--id', id, '--accept-package-agreements', '--accept-source-agreements'];
  assert.deepEqual(argvs(buildPlan(KIT_IDS, allMissing(win), win)), [
    W('Git.Git'),
    ['winget', 'install', '-e', '--id', 'Microsoft.VisualStudio.BuildTools', '--accept-package-agreements', '--accept-source-agreements', '--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'],
    W('OpenJS.NodeJS.LTS'),
    ['winget', 'install', '9NQ7512CXL7T', '-e', '--accept-package-agreements', '--disable-interactivity'],
    ['pymanager', 'install', 'default'],
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PY_PATH_SCRIPT, 'utf16le').toString('base64')],
    W('GitHub.cli'),
    W('BurntSushi.ripgrep.MSVC'),
    W('jqlang.jq'),
    W('Docker.DockerDesktop'),
  ]);
});

test('idempotent: nothing missing → nothing to run, on every package manager', () => {
  for (const pm of ['apt', 'dnf', 'pacman', 'zypper', 'apk']) assert.deepEqual(buildPlan(KIT_IDS, allOk(), linux(pm)).steps, []);
  assert.deepEqual(buildPlan(KIT_IDS, allOk(), { platform: 'darwin', pm: null }).steps, []);
  assert.deepEqual(buildPlan(KIT_IDS, allOk(), { platform: 'win32', pm: 'winget' }).steps, []);
  // "old" is reported by status, never reinstalled or downgraded by setup
  const old = allOk();
  old.node[0].state = 'old';
  assert.deepEqual(buildPlan(['node'], old, linux('apt')).steps, []);
});

test('no package manager: items are reported as "cannot", never guessed', () => {
  const plan = buildPlan(['extras'], allMissing(linux(null)), linux(null));
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.cannot.map((c) => c.item), ['tmux', 'ripgrep', 'jq']);
  assert.equal(pmInstall(linux(null), ['x']), null);
});

test('end of life from the projects\' schedules', () => {
  const node = KITS.find((k) => k.id === 'node').items[0];
  const py = KITS.find((k) => k.id === 'python').items[0];
  assert.equal(node.eol('20.11.1'), pastEol('2026-04-30'));
  assert.equal(node.eol('24.1.0'), false);
  assert.equal(py.eol('3.9.6'), true);
  assert.equal(py.eol('3.13.1'), false);
  assert.equal(pastEol('2020-01-01', Date.parse('2026-11-14')), true);
  assert.equal(pastEol(undefined), false);
});
