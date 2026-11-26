// A whole `hoprig setup --yes` on a simulated cloud server (ssh, no desktop session, a cloud's hardware, only a private
// address, a locale the computer lacks), with the real computer, Git and workspace steps and stand-ins for every
// program. Its text is held line by line against what a new person on a fresh server should read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, recorder, scratch } from './helpers.mjs';
import { sealedPath } from '../seal.mjs';

const s = scratch();
test.after(s.cleanup);
globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });
const log = path.join(s.tmp, 'calls.txt');
// Each stand-in writes down the locale it was started with.
const rec = (n) => `printf '%s LC_ALL=%s LANG=%s :: %s\\n' ${n} "$LC_ALL" "$LANG" "$*" >> '${log}'`;
const bin = fakeBin(path.join(s.tmp, 'bin'), {
  claude: fakeClaude({ loggedIn: false }),
  sudo: `${rec('sudo')}\nexec "$@"`,
  'apt-get': rec('apt-get'),
  // Lingering is off, and turning it on is refused (as a sudo that was refused leaves it).
  loginctl: `${rec('loginctl')}\ncase "$1" in show-user) echo Linger=no ;; enable-linger) echo "Access denied" >&2; exit 1 ;; esac`,
  systemctl: rec('systemctl'),
  git: `${rec('git')}\ncase "$1" in --version) echo "git version 2.43.0" ;; config) exit 1 ;; *) exit 0 ;; esac`,
  gh: `${rec('gh')}\ncase "$1" in --version) echo "gh version 2.40.0" ;; auth) echo "You are not logged into any GitHub hosts." >&2; exit 1 ;; *) exit 1 ;; esac`,
  npm: `${rec('npm')}\ncase "$1" in --version) echo 10.9.0 ;; esac`,
  tmux: 'echo "tmux 3.4"', rg: 'echo "ripgrep 14.1.0"', jq: 'echo "jq-1.7.1"', curl: 'echo "curl 8.5.0"', unzip: 'echo "UnZip 6.00"',
  make: 'echo "GNU Make 4.3"', cc: 'echo "cc 13.2.0"', 'c++': 'echo "c++ 13.2.0"',
  python3: 'case "$*" in *pip*) echo "pip 24.0" ;; *venv*) echo "venv ok" ;; *) echo "Python 3.12.3" ;; esac',
});
// The computer, Git and workspace steps find their programs on this process's PATH: only the stand-ins and node.
process.env.PATH = sealedPath(pathWith(s.tmp, bin));
Object.assign(process.env, { SSH_CONNECTION: '10.0.0.5 50000 10.0.0.9 22', SSH_CLIENT: '10.0.0.5 50000 22', SSH_TTY: '/dev/pts/0', LC_ALL: 'xx_YY.UTF-8', LANG: 'xx_YY.UTF-8' });
for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'LC_CTYPE']) delete process.env[k];
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

async function run(args) {
  const r = recorder();
  const ui = makeUi({ interactive: false, yes: args.includes('--yes'), dryRun: args.includes('--dry-run'), write: r.write, askLine: async () => '' });
  const sys = K.sysInfo({
    env: { ...process.env }, platform: 'linux', pm: 'apt', root: false, user: 'alex', serviceSupported: true, publicIps: [],
    dmi: { vendor: 'Google', product: 'Google Compute Engine' }, localDisplay: false, savedServer: undefined,
    locales: new Set(['c', 'c.utf8', 'posix']), release: { ID: 'ubuntu', ID_LIKE: 'debian', PRETTY_NAME: 'Ubuntu 24.04 LTS' },
  });
  sys.probe = async () => 200;
  sys.running = async () => null;
  fs.rmSync(log, { force: true });
  const code = await SU.setup(args, { ui, sys });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const at = r.text.indexOf('Still yours to do:');
  return { text: r.text, code, calls, before: at < 0 ? r.text : r.text.slice(0, at), list: at < 0 ? [] : r.text.slice(at).trim().split('\n').slice(1).map((l) => l.trim()) };
}

let first;
let second;
test('the first run on a fresh server: each thing left to the person is said once, in the one closing list', { skip: process.platform === 'win32' && 'a Linux server is handed in (apt, sudo, loginctl)' }, async () => {
  first = await run(['--yes']);
  const { before, list, text } = first;
  assert.equal(text.split('Still yours to do:').length, 2, text);
  // The git name and e-mail and the GitHub sign-in: the computer step's kit line says they are yours, then the list.
  assert.match(before, /✗ GitHub: missing Commit name and e-mail, GitHub sign-in .*← yours to do \(listed at the end\)/);
  assert.doesNotMatch(before, /will set up.*\n?.*GitHub|GitHub[^\n]*will set up/, 'what --yes never sets up is not "will set up"');
  for (const said of [/commit name and e-mail not set/i, /commits need your name/i, /not signed in to GitHub/i, /GitHub: not signed in/, /GitHub: still missing/, /gh auth login/, /git config --global user\.name "/]) assert.doesNotMatch(before, said, `said before the list:\n${before}`);
  assert.equal(list.filter((l) => l.startsWith('· Your name and e-mail for commits:')).length, 1, list.join('\n'));
  assert.equal(list.filter((l) => l === '· Sign in to GitHub: On the dashboard: Home → Get started → Set up git and GitHub. Or only here, on this computer: gh auth login').length, 1, list.join('\n'));
  assert.equal(list.filter((l) => l === '· Sign in to Claude Code: On the dashboard: Home → Get started → Sign in to Claude. Or only here, on this computer: run claude, then type /login').length, 1, list.join('\n'));
});

test('the brain\'s first commit waits for the git name and e-mail: a short mark, and one item after theirs, on both runs', { skip: process.platform === 'win32' && 'it reads the first run, a Linux server that is skipped on Windows' }, async () => {
  // The page's way first, then the command.
  const brain = (r) => r.list.filter((l) => l.startsWith('· The AI brain\'s first commit, once git knows your name and e-mail: On the dashboard: Home → Get started → Git and GitHub set up, then Keep on GitHub (with a GitHub account: it also keeps the brain in a new private GitHub repository). Or only here, on this computer: git -C '));
  assert.equal(brain(first).length, 1, first.list.join('\n'));
  assert.match(first.before, /· the brain: no first commit yet \(it waits for your name and e-mail\)\n/);
  assert.doesNotMatch(first.before, /git -C .*ai_brain init/, 'the commands only in the list');
  assert.ok(first.list.findIndex((l) => l.startsWith('· Your name and e-mail')) < first.list.indexOf(brain(first)[0]), 'after the name and e-mail');
  if (!second) second = await run(['--yes']);
  assert.equal(brain(second).length, 1, `the second run lists it too:\n${second.list.join('\n')}`);
});

test('lingering refused: listed among the steps, its command in the closing list, and no "starts with the computer"', { skip: process.platform === 'win32' && 'a Linux server is handed in (apt, sudo, loginctl)' }, () => {
  assert.match(first.before, /Will run.*\n(?:.*\n)*? {4}sudo loginctl enable-linger alex\n/);
  assert.match(first.before, /! The dashboard stops when you log out: lingering is off\n/);
  assert.doesNotMatch(first.text, /starts with the computer/);
  assert.equal(first.list.filter((l) => l === '· Keep the dashboard running after you log out (lingering): On the dashboard: Computers → this computer → Health → Let them start after a restart. Or only here, on this computer: sudo loginctl enable-linger alex').length, 1, first.list.join('\n'));
});

test('every program set-up starts runs with the working locale (C.UTF-8, no LC_ALL)', { skip: process.platform === 'win32' && 'a Linux server is handed in (apt, sudo, loginctl)' }, () => {
  assert.ok(first.calls.length > 5, first.calls.join('\n'));
  for (const c of first.calls) assert.match(c, /^\S+ LC_ALL= LANG=C\.UTF-8 :: /, c);
});

test('the run says nothing private and no QR code: the dashboard is for this computer only', { skip: process.platform === 'win32' && 'it reads the first run, a Linux server that is skipped on Windows' }, () => {
  const { text } = first;
  assert.doesNotMatch(text, /10\.0\.0\.\d|0\.0\.0\.0|Scan with your phone/);
  assert.match(text, /✓ Open to: only this computer/);
  assert.doesNotMatch(text, /logged in with/, 'no claim of a Claude login');
});

test('a second run: still one list, nothing of it earlier', { skip: process.platform === 'win32' && 'a Linux server is handed in (apt, sudo, loginctl)' }, async () => {
  second = await run(['--yes']);
  assert.equal(second.text.split('Still yours to do:').length, 2, second.text);
  for (const said of [/commits need your name/i, /GitHub: not signed in/, /gh auth login/]) assert.doesNotMatch(second.before, said, second.before);
});
