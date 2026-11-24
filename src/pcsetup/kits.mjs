// Kits: small named sets of things a coding computer needs, and how to install each one per OS and package
// manager. This file is data plus pure functions: nothing here runs a command, so tests check every array.
//
// `sys` (see sysFacts in detect.mjs): { platform, pm, root, user, arch, tmp, home, dnf5 }
//   pm  apt | dnf | yum | pacman | zypper | apk | brew | winget | null
//
// Where each install command comes from (checked against the tool's own documentation, November 2026):
//   distro packages      the distro's own package names (packages.ubuntu.com, packages.debian.org, packages.fedoraproject.org,
//                        archlinux.org/packages, software.opensuse.org, pkgs.alpinelinux.org, formulae.brew.sh)
//   build tools          https://github.com/nodejs/node-gyp#installation (make, a C/C++ compiler, a supported Python;
//                        macOS: `xcode-select --install`; Windows: the Visual Studio C++ workload)
//   Node.js (nvm)        https://nodejs.org/en/download and https://github.com/nvm-sh/nvm#installing-and-updating:
//                        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/<version>/install.sh | bash
//                        then `nvm install --lts`. Pinned to the same release as install.sh (a few weeks old).
//   Node.js (Alpine)     `apk add nodejs npm` (nvm has no ready-made Node for musl)
//   GitHub CLI           https://github.com/cli/cli/blob/trunk/docs/install_linux.md (apt keyring + list, dnf4/dnf5
//                        config-manager, zypper addrepo; pacman github-cli and apk github-cli are community packages),
//                        https://cli.github.com (brew install gh; winget install --id GitHub.cli)
//   Docker               https://docs.docker.com/engine/install/ubuntu/#install-using-the-convenience-script
//                        (curl -fsSL https://get.docker.com -o get-docker.sh; sudo sh get-docker.sh) and
//                        https://docs.docker.com/engine/install/linux-postinstall/ (usermod -aG docker; log out and in);
//                        macOS: the docker-desktop cask (formulae.brew.sh/cask/docker-desktop); Windows: Docker.DockerDesktop
//   Homebrew             https://brew.sh: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
//   Python on Windows    https://docs.python.org/3/using/windows.html: winget install 9NQ7512CXL7T -e (the Python install manager)
//   PHP + database       the distros' package pages (checked 18 Nov 2026): Debian/Ubuntu php-cli, composer, mariadb-server
//                        (Ubuntu 26.04: php-cli 8.5, composer 2.9, mariadb-server 11.8, no other PHP series); Fedora php-cli,
//                        composer, mariadb-server; Arch php, composer, mariadb; openSUSE php8, php-composer2, mariadb;
//                        Alpine (edge) php85 (it holds /usr/bin/php), composer, mariadb + mariadb-client; Homebrew php,
//                        composer, mariadb. Where the package does not start MariaDB itself, the start commands are SHOWN
//                        (wiki.archlinux.org/title/MariaDB, wiki.alpinelinux.org/wiki/MariaDB, Fedora's and openSUSE's
//                        `systemctl enable --now mariadb`, `brew services start mariadb`), never run.
//   fvm                  https://fvm.app/documentation/getting-started/installation: `dart pub global activate fvm`, for the
//                        user (no administrator rights; it lands in ~/.pub-cache/bin). Its Homebrew tap is a package source
//                        of its own, so it is not used.
//   winget ids           https://github.com/microsoft/winget-pkgs (manifests/<letter>/<Publisher>/<Name>)
//   VS Build Tools       winget id Microsoft.VisualStudio.BuildTools (2026); workload id Microsoft.VisualStudio.Workload.VCTools
//                        https://learn.microsoft.com/visualstudio/install/workload-component-id-vs-build-tools

export const NVM_VERSION = 'v0.40.8'; // the same pinned release as install.sh
export const NVM_INSTALL = `https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh`;
export const BREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const GH_KEYRING = '/etc/apt/keyrings/githubcli-archive-keyring.gpg';
const GH_REPO_RPM = 'https://cli.github.com/packages/rpm/gh-cli.repo';

/** End of life per major, from the projects' own schedules. A version past its date is "old". */
// https://github.com/nodejs/Release/blob/main/schedule.json
export const NODE_EOL = { 16: '2023-09-11', 18: '2025-04-30', 19: '2023-06-01', 20: '2026-04-30', 21: '2024-06-01', 22: '2027-04-30', 23: '2025-06-01', 24: '2028-04-30', 25: '2026-06-01', 26: '2029-04-30' };
// https://devguide.python.org/versions/
export const PYTHON_EOL = { '3.7': '2023-06-27', '3.8': '2024-10-07', '3.9': '2025-10-31', '3.10': '2026-10-01', '3.11': '2027-10-31', '3.12': '2028-10-31', '3.13': '2029-10-31', '3.14': '2030-10-31', '3.15': '2031-10-31' };

const ALL_PM = ['apt', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'brew', 'winget'];
const same = (pkgs, pms = ['apt', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'brew']) => Object.fromEntries(pms.map((p) => [p, pkgs]));

/**
 * An item: { id, name, bins (all must be on PATH), version (argv), platforms?, packages: { pm: [names] },
 * winget (id), steps (sys) => argv steps instead of packages, eol (version → 'old'?), detect (sys) => result (its own
 * way to look, detect.mjs), cannot (sys) => why it cannot be installed here, in words }.
 * A kit: { id, title, summary, defaultOn, items, after (one sentence, or (sys) => one: what needs a new login/shell),
 * windows (false: Hoprig does not set it up on Windows, and says so), start (sys) => argv lines SHOWN to run by hand }.
 */
export const KITS = [
  {
    id: 'basics',
    title: 'Basics',
    summary: 'git, curl, unzip and the C/C++ build tools that Claude Code and node modules need to compile.',
    defaultOn: true,
    items: [
      { id: 'git', name: 'git', bins: ['git'], version: ['git', '--version'], packages: same(['git']), winget: 'Git.Git', needsClt: true },
      { id: 'curl', name: 'curl', bins: ['curl'], version: ['curl', '--version'], platforms: ['linux'], packages: { apt: ['curl', 'ca-certificates'], dnf: ['curl'], yum: ['curl'], pacman: ['curl'], zypper: ['curl'], apk: ['curl', 'ca-certificates'] } },
      { id: 'unzip', name: 'unzip', bins: ['unzip'], version: ['unzip', '-v'], platforms: ['linux'], packages: same(['unzip'], ['apt', 'dnf', 'yum', 'pacman', 'zypper', 'apk']) },
      {
        id: 'build', name: 'C/C++ build tools', version: null,
        // node-gyp needs make, a C/C++ compiler and Python (https://github.com/nodejs/node-gyp#on-unix)
        bins: ['make', 'cc', 'c++', 'python3'],
        packages: { apt: ['build-essential', 'python3'], dnf: ['gcc', 'gcc-c++', 'make', 'python3'], yum: ['gcc', 'gcc-c++', 'make', 'python3'], pacman: ['base-devel', 'python'], zypper: ['gcc', 'gcc-c++', 'make', 'python3'], apk: ['build-base', 'python3', 'linux-headers'] },
        steps: (sys) => {
          if (sys.platform === 'darwin') return [{ argv: ['xcode-select', '--install'], admin: false, interactive: true, why: 'Apple opens a window: click Install' }];
          if (sys.platform === 'win32') {
            return [{ argv: ['winget', 'install', '-e', '--id', 'Microsoft.VisualStudio.BuildTools', '--accept-package-agreements', '--accept-source-agreements', '--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'], admin: false, interactive: true, why: 'Windows asks for permission itself' }];
          }
          return null;
        },
      },
    ],
  },
  {
    id: 'node',
    title: 'Node.js',
    summary: 'Node.js LTS and npm, installed for you only with nvm (no administrator rights).',
    defaultOn: true,
    after: 'Open a new terminal so it finds the new node (nvm adds itself to your shell start file).',
    items: [
      { id: 'node', name: 'Node.js', bins: ['node'], version: ['node', '--version'], eol: (v) => pastEol(NODE_EOL[majorOf(v)]), steps: nodeSteps, winget: 'OpenJS.NodeJS.LTS', packages: { apk: ['nodejs', 'npm'] } },
      { id: 'npm', name: 'npm', bins: ['npm'], version: ['npm', '--version'], steps: nodeSteps, winget: 'OpenJS.NodeJS.LTS', packages: { apk: ['npm'] } },
    ],
  },
  {
    id: 'python',
    title: 'Python',
    summary: 'python3 with pip and venv, for scripts and Python projects.',
    defaultOn: true,
    items: [
      { id: 'python', name: 'python3', bins: ['python3'], version: ['python3', '--version'], eol: (v) => pastEol(PYTHON_EOL[minorOf(v)]), needsClt: true, packages: { ...same(['python3'], ['apt', 'dnf', 'yum', 'zypper', 'apk']), pacman: ['python'], brew: ['python'] }, steps: pyWin },
      { id: 'pip', name: 'pip', bins: ['python3'], version: ['python3', '-m', 'pip', '--version'], needsClt: true, packages: { apt: ['python3-pip'], dnf: ['python3-pip'], yum: ['python3-pip'], pacman: ['python-pip'], zypper: ['python3-pip'], apk: ['py3-pip'], brew: ['python'] }, steps: pyWin },
      // Debian and Ubuntu split venv's pip bootstrap (ensurepip) into python3-venv; elsewhere it comes with python3.
      { id: 'venv', name: 'venv', bins: ['python3'], version: ['python3', '-c', 'import venv, ensurepip; print("venv ok")'], needsClt: true, packages: { apt: ['python3-venv'], dnf: ['python3'], yum: ['python3'], pacman: ['python'], zypper: ['python3'], apk: ['python3'], brew: ['python'] }, steps: pyWin },
    ],
  },
  {
    id: 'github',
    title: 'GitHub',
    summary: 'The gh command, your commit name and e-mail, and signing in so clone and push work.',
    defaultOn: true,
    items: [
      { id: 'gh', name: 'GitHub CLI (gh)', bins: ['gh'], version: ['gh', '--version'], packages: { pacman: ['github-cli'], apk: ['github-cli'], brew: ['gh'] }, winget: 'GitHub.cli', steps: ghSteps },
      // These two are set up by asking (setup.mjs), never installed: detect.mjs reads them.
      { id: 'identity', name: 'Commit name and e-mail', kind: 'identity' },
      { id: 'signin', name: 'GitHub sign-in', kind: 'signin' },
    ],
  },
  {
    id: 'extras',
    title: 'Terminal extras',
    summary: 'tmux (sessions that survive), ripgrep (fast search) and jq (JSON on the command line).',
    defaultOn: true,
    items: [
      { id: 'tmux', name: 'tmux', bins: ['tmux'], version: ['tmux', '-V'], platforms: ['linux', 'darwin'], packages: same(['tmux']) },
      { id: 'ripgrep', name: 'ripgrep', bins: ['rg'], version: ['rg', '--version'], packages: same(['ripgrep']), winget: 'BurntSushi.ripgrep.MSVC' },
      { id: 'jq', name: 'jq', bins: ['jq'], version: ['jq', '--version'], packages: same(['jq']), winget: 'jqlang.jq' },
    ],
  },
  {
    id: 'docker',
    title: 'Docker',
    summary: 'Containers. Optional: needs administrator rights, and you must log out and in again before it works without sudo.',
    defaultOn: false,
    after: 'Log out and back in (or restart) so your account may use Docker without sudo.',
    items: [
      { id: 'docker', name: 'Docker', bins: ['docker'], version: ['docker', '--version'], packages: { pacman: ['docker'], zypper: ['docker'], apk: ['docker'] }, winget: 'Docker.DockerDesktop', steps: dockerSteps },
    ],
  },
  {
    id: 'php',
    title: 'PHP + database',
    summary: 'PHP\'s command line, Composer and the MariaDB database server, for PHP projects. Optional: needs administrator rights. Hoprig never removes or downgrades a PHP, adds a package source or changes which PHP the php command runs.',
    defaultOn: false,
    windows: false,
    after: (sys) => (mariadbStart(sys).length
      ? 'MariaDB is a database that runs in the background. Hoprig does not start it; to start it now and with the computer, run:'
      : 'MariaDB is a service: it starts now and with the computer, and keeps running in the background.'),
    start: mariadbStart,
    items: [
      { id: 'php', name: 'PHP (command line)', bins: ['php'], detect: (sys) => import('./detect.mjs').then((d) => d.detectPhp(sys)), packages: { apt: ['php-cli'], dnf: ['php-cli'], yum: ['php-cli'], pacman: ['php'], zypper: ['php8'], apk: ['php85'], brew: ['php'] } },
      // Composer runs `sudo -K` before any command, its version too, and so would end the person's sudo sign-in on
      // every status; COMPOSER_ALLOW_SUPERUSER leaves that check out.
      { id: 'composer', name: 'Composer', bins: ['composer'], version: ['composer', '--version', '--no-interaction'], versionEnv: { COMPOSER_ALLOW_SUPERUSER: '1' }, packages: { ...same(['composer']), zypper: ['php-composer2'] } },
      // A MySQL or MariaDB server already here counts (detect.mjs): MariaDB is never put beside MySQL, a package
      // manager would replace it.
      { id: 'mariadb', name: 'MariaDB (server)', detect: (sys) => import('./detect.mjs').then((d) => d.detectDbServer(sys)), packages: { apt: ['mariadb-server'], dnf: ['mariadb-server'], yum: ['mariadb-server'], pacman: ['mariadb'], zypper: ['mariadb'], apk: ['mariadb', 'mariadb-client'], brew: ['mariadb'] } },
    ],
  },
  {
    id: 'fvm',
    title: 'Flutter versions (fvm)',
    summary: 'Only for work on several Flutter versions at once: fvm keeps one Flutter per project. Needs Flutter first.',
    defaultOn: false,
    windows: false,
    after: 'fvm is in ~/.pub-cache/bin: add that folder to your PATH (Dart says how at the end of the install), then open a new terminal.',
    items: [
      {
        id: 'fvm', name: 'fvm', bins: ['fvm'], version: ['fvm', '--version'],
        detect: (sys) => import('./detect.mjs').then((d) => d.detectFvm(sys)),
        steps: (sys) => (sys.has && sys.has('dart') ? [{ argv: ['dart', 'pub', 'global', 'activate', 'fvm'], admin: false, why: 'fvm with Dart, for you only' }] : null),
        cannot: () => 'Install Flutter first; fvm comes with Flutter\'s dart command.',
      },
    ],
  },
];

export const KIT_IDS = KITS.map((k) => k.id);
export const kitById = (id) => KITS.find((k) => k.id === id) || null;

export const majorOf = (v) => (/(\d+)\./.exec(String(v || '')) || [])[1] || null;
export const minorOf = (v) => {
  const m = /(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? `${m[1]}.${m[2]}` : null;
};
/** True when `date` (YYYY-MM-DD) has passed. */
export const pastEol = (date, now = Date.now()) => Boolean(date) && Date.parse(`${date}T00:00:00Z`) < now;

/** Prefix sudo unless we already are root. brew and winget never run under sudo. */
const su = (sys, argv) => (sys.root || sys.platform !== 'linux' ? argv : ['sudo', ...argv]);

/** The command that installs distro `packages` with `sys.pm` (one argv), or null. */
export function pmInstall(sys, packages) {
  const pk = [...new Set(packages)];
  if (!pk.length) return null;
  switch (sys.pm) {
    case 'apt': return su(sys, ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', ...pk]);
    case 'dnf': return su(sys, ['dnf', 'install', '-y', ...pk]);
    case 'yum': return su(sys, ['yum', 'install', '-y', ...pk]);
    case 'pacman': return su(sys, ['pacman', '-S', '--needed', '--noconfirm', ...pk]);
    case 'zypper': return su(sys, ['zypper', '--non-interactive', 'install', ...pk]);
    case 'apk': return su(sys, ['apk', 'add', ...pk]);
    case 'brew': return ['brew', 'install', ...pk];
    default: return null;
  }
}

/** pmInstall without the flags that answer yes for the person (one argv, or null): the package manager lists what it
 * would change, and asks first. Shown, never run. */
export function askingInstall(sys, packages) {
  const argv = pmInstall(sys, packages);
  if (!argv) return null;
  return argv.filter((a, i) => !['-y', '--noconfirm', '--non-interactive', 'DEBIAN_FRONTEND=noninteractive'].includes(a) && !(a === 'env' && argv[i + 1] === 'DEBIAN_FRONTEND=noninteractive'));
}

const aptUpdate = (sys) => su(sys, ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update']);
const wingetInstall = (id) => ['winget', 'install', '-e', '--id', id, '--accept-package-agreements', '--accept-source-agreements'];

function nodeSteps(sys) {
  if (sys.platform === 'win32' || sys.pm === 'apk') return null; // winget id / apk packages
  const nvmDir = '"${NVM_DIR:-$HOME/.nvm}"';
  return [
    { argv: ['bash', '-c', `[ -s ${nvmDir}/nvm.sh ] || curl -o- ${NVM_INSTALL} | bash`], admin: false, why: `nvm ${NVM_VERSION}, for you only` },
    { argv: ['bash', '-c', `export NVM_DIR=${nvmDir}; . "$NVM_DIR/nvm.sh" && nvm install --lts`], admin: false, why: 'Node.js LTS with nvm' },
  ];
}

/** Whether this runs in an SSH session (OpenSSH for Windows sets these as it does elsewhere). */
export const sshSession = (env = {}) => !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);

/** The command a person types in a window of their own to finish the Python kit (see pyWin). */
export const PY_INSTALL = ['pymanager', 'install', 'default'];

// The install manager puts the Pythons it installs, and their python/pip commands, in %LOCALAPPDATA%\Python\bin, and
// that folder is not on Path until it is added. Added to the user's Path in the registry as an expandable entry, once
// (the folder as it is stored, or expanded, already there: nothing is written). Read and written with the registry's own
// calls, not [Environment]::SetEnvironmentVariable: Windows PowerShell 5.1 writes that as plain text, and every
// %USERPROFILE% in the user's Path would stop being expanded.
export const PY_BIN = '%LOCALAPPDATA%\\Python\\bin';
export const PY_PATH_SCRIPT = `$ErrorActionPreference = 'Stop'
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$old = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$dir = '${PY_BIN.replace(/\\\\/g, '\\')}'
$want = [Environment]::ExpandEnvironmentVariables($dir).TrimEnd('\\')
$have = @($old -split ';' | Where-Object { $_ -ne '' })
if (-not ($have | Where-Object { [Environment]::ExpandEnvironmentVariables($_).Trim('"').TrimEnd('\\') -ieq $want })) {
  $k.SetValue('Path', (@($have) + $dir) -join ';', [Microsoft.Win32.RegistryValueKind]::ExpandString)
}`;

function pyWin(sys) {
  if (sys.platform !== 'win32') return null;
  const ps = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PY_PATH_SCRIPT, 'utf16le').toString('base64')];
  // The install manager alone gives no Python: its first `python` would install one, but not in a session without a
  // desktop, and its docs advise an explicit install. `pymanager` (not `py`: an older launcher may hold that name). In
  // an SSH session the install manager only updates itself, so that step is left to the person, in a window of their
  // own on that computer (setup.mjs says so at the end); the Path folder is added either way.
  return [
    { argv: ['winget', 'install', '9NQ7512CXL7T', '-e', '--accept-package-agreements', '--disable-interactivity'], admin: false, why: 'the Python install manager' },
    ...(sshSession(sys.env) ? [] : [{ argv: PY_INSTALL, admin: false, why: 'the newest Python, for you only' }]),
    { argv: ps, admin: false, why: `${PY_BIN.replace(/\\\\/g, '\\')} on your Path` },
  ];
}

/** dpkg's name for this CPU (what `dpkg --print-architecture` prints). */
export const debArch = (arch) => ({ x64: 'amd64', arm64: 'arm64', arm: 'armhf', ia32: 'i386' }[arch] || arch);

function ghSteps(sys) {
  if (sys.platform === 'win32' || ['pacman', 'apk', 'brew'].includes(sys.pm)) return null;
  if (sys.pm === 'apt') {
    const line = `deb [arch=${debArch(sys.arch)} signed-by=${GH_KEYRING}] https://cli.github.com/packages stable main`;
    return [
      { argv: su(sys, ['mkdir', '-p', '-m', '755', '/etc/apt/keyrings']), admin: !sys.root, why: 'GitHub\'s package signing key' },
      { argv: su(sys, ['curl', '-fsSL', '-o', GH_KEYRING, 'https://cli.github.com/packages/githubcli-archive-keyring.gpg']), admin: !sys.root },
      { argv: su(sys, ['chmod', 'go+r', GH_KEYRING]), admin: !sys.root },
      { argv: su(sys, ['sh', '-c', `echo '${line}' > /etc/apt/sources.list.d/github-cli.list`]), admin: !sys.root, why: 'GitHub\'s package list' },
      { argv: aptUpdate(sys), admin: !sys.root },
      { argv: pmInstall(sys, ['gh']), admin: !sys.root },
    ];
  }
  if (sys.pm === 'dnf') {
    return sys.dnf5
      ? [
        { argv: su(sys, ['dnf', 'install', '-y', 'dnf5-plugins']), admin: !sys.root },
        { argv: su(sys, ['dnf', 'config-manager', 'addrepo', `--from-repofile=${GH_REPO_RPM}`]), admin: !sys.root },
        { argv: su(sys, ['dnf', 'install', '-y', 'gh']), admin: !sys.root },
      ]
      : [
        { argv: su(sys, ['dnf', 'install', '-y', 'dnf-command(config-manager)']), admin: !sys.root },
        { argv: su(sys, ['dnf', 'config-manager', '--add-repo', GH_REPO_RPM]), admin: !sys.root },
        { argv: su(sys, ['dnf', 'install', '-y', 'gh']), admin: !sys.root },
      ];
  }
  if (sys.pm === 'zypper') {
    return [
      { argv: su(sys, ['zypper', '--non-interactive', 'addrepo', GH_REPO_RPM]), admin: !sys.root },
      { argv: su(sys, ['zypper', '--non-interactive', '--gpg-auto-import-keys', 'ref']), admin: !sys.root },
      { argv: su(sys, ['zypper', '--non-interactive', 'install', 'gh']), admin: !sys.root },
    ];
  }
  return null;
}

function dockerSteps(sys) {
  if (sys.platform === 'darwin') return [{ argv: ['brew', 'install', '--cask', 'docker-desktop'], admin: false, why: 'Docker Desktop; open it once to finish' }];
  if (sys.platform === 'win32') return null; // winget id
  if (!['apt', 'dnf', 'yum'].includes(sys.pm)) return null; // distro packages
  const file = `${sys.tmp}/get-docker.sh`;
  const out = [
    { argv: ['curl', '-fsSL', 'https://get.docker.com', '-o', file], admin: false, why: 'Docker\'s own install script' },
    { argv: su(sys, ['sh', file]), admin: !sys.root },
  ];
  if (!sys.root && sys.user) out.push({ argv: ['sudo', 'usermod', '-aG', 'docker', sys.user], admin: true, why: 'use Docker without sudo (after you log in again)' });
  return out;
}

/** The commands that start MariaDB where its package does not (shown for the person to run, never run). */
export function mariadbStart(sys) {
  const enable = ['systemctl', 'enable', '--now', 'mariadb'];
  switch (sys.pm) {
    case 'dnf': case 'yum': case 'zypper': return [su(sys, enable)];
    case 'pacman': return [su(sys, ['mariadb-install-db', '--user=mysql', '--basedir=/usr', '--datadir=/var/lib/mysql']), su(sys, enable)];
    case 'apk': return [su(sys, ['rc-service', 'mariadb', 'setup']), su(sys, ['rc-service', 'mariadb', 'start']), su(sys, ['rc-update', 'add', 'mariadb', 'default'])];
    case 'brew': return [['brew', 'services', 'start', 'mariadb']];
    default: return []; // apt: Debian's package starts and enables it itself
  }
}

/** A kit's `after` sentence on this computer (it may depend on the package manager). */
export const afterText = (kit, sys) => (typeof kit.after === 'function' ? kit.after(sys) : kit.after || null);
/** False where Hoprig does not set the kit up (the new optional kits on Windows). */
export const kitCovered = (kit, platform) => !(kit.windows === false && platform === 'win32');

/** True when the item is meant for this OS. */
export const itemHere = (item, platform) => !item.platforms || item.platforms.includes(platform);

/**
 * The steps that install `missing` items of one kit: [{ argv, admin, interactive?, why?, items }]. Items without a
 * way to install here are returned in `cannot`. Pure: the same input always gives the same arrays.
 */
export function kitSteps(kit, missing, sys) {
  const steps = [];
  const cannot = [];
  const pkgs = [];
  const pkgItems = [];
  const seen = new Set();
  for (const item of missing) {
    if (item.kind) continue; // identity and sign-in are asked, not installed
    const custom = item.steps ? item.steps(sys) : null;
    if (custom) {
      const key = JSON.stringify(custom.map((s) => s.argv));
      if (!seen.has(key)) {
        seen.add(key);
        steps.push(...custom.map((s) => ({ ...s, items: [item.id] })));
      } else for (const s of steps) if (JSON.stringify(s.argv) === JSON.stringify(custom[0].argv)) s.items.push(item.id);
      continue;
    }
    if (sys.platform === 'win32') {
      if (item.winget) {
        const argv = wingetInstall(item.winget);
        const found = steps.find((s) => JSON.stringify(s.argv) === JSON.stringify(argv));
        if (found) found.items.push(item.id);
        else steps.push({ argv, admin: false, interactive: true, items: [item.id] });
      } else cannot.push(item);
      continue;
    }
    const p = item.packages && item.packages[sys.pm];
    if (p && sys.pm) {
      pkgs.push(...p);
      pkgItems.push(item.id);
    } else cannot.push(item);
  }
  if (pkgs.length) steps.unshift({ argv: pmInstall(sys, pkgs), admin: sys.platform === 'linux' && !sys.root, items: pkgItems });
  return { steps, cannot };
}

/**
 * The whole plan for the chosen kits and what detection found ({ kitId: [ { item, state } ] }): apt's package
 * lists are refreshed once at the start (on a fresh machine they are empty); Homebrew is installed first on a Mac
 * without it. Returns { steps, cannot, admin }.
 */
export function buildPlan(kitIds, found, sys, { extra = {} } = {}) {
  const steps = [];
  const cannot = [];
  let brewFirst = false;
  for (const id of kitIds) {
    const kit = kitById(id);
    if (!kit || !kitCovered(kit, sys.platform)) continue;
    // A missing item that detection holds back (`hold`: MariaDB where only MySQL's client is here) is never planned:
    // it is said, with its reason, among what cannot be installed.
    const held = (found[id] || []).filter((r) => r.state === 'missing' && r.hold);
    const missing = (found[id] || []).filter((r) => r.state === 'missing' && !r.hold).map((r) => kit.items.find((i) => i.id === r.id)).filter(Boolean);
    cannot.push(...held.map((r) => ({ kit: id, item: r.id, name: (kit.items.find((i) => i.id === r.id) || {}).name || r.id, why: r.hold })));
    // `extra`: steps a kit adds for this computer (another PHP series a project needs, optional.mjs), after its own.
    const more = (extra[id] || []).map((s) => ({ ...s, kit: id }));
    if (!missing.length) {
      steps.push(...more);
      continue;
    }
    if (sys.platform === 'darwin' && sys.pm !== 'brew' && missing.some((i) => !i.kind && i.packages && i.packages.brew && !(i.steps && i.steps(sys)))) brewFirst = true;
    const plan = kitSteps(kit, missing, { ...sys, pm: sys.platform === 'darwin' && brewFirst ? 'brew' : sys.pm });
    steps.push(...plan.steps.map((s) => ({ ...s, kit: id })), ...more);
    cannot.push(...plan.cannot.map((i) => ({ kit: id, item: i.id, name: i.name, why: i.cannot ? i.cannot(sys) : null })));
  }
  if (sys.pm === 'apt' && steps.some((s) => s.argv.includes('apt-get') && s.argv.includes('install'))) {
    steps.unshift({ argv: aptUpdate(sys), admin: !sys.root, kit: null, items: [], why: 'refresh the package lists' });
  }
  if (brewFirst) steps.unshift({ argv: ['/bin/bash', '-c', BREW_INSTALL], admin: false, interactive: true, kit: null, items: ['brew'], why: 'Homebrew (https://brew.sh); it asks for your password itself' });
  return { steps, cannot, admin: steps.some((s) => s.admin) };
}

export { ALL_PM };
