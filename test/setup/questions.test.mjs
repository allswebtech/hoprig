// The questions of the whole `hoprig setup` on a fresh Linux desktop, counted: every confirm, ask and choose that
// reaches the person, from the first line to the closing list, with the real computer, Git and workspace steps and
// stand-ins for what leaves the machine (sudo, systemctl, loginctl, gh, the package manager, Claude's installer).
// The number is the proof of the first-run work: a person who is not a programmer answers about 7 plain questions
// (gh's own sign-in questions are gh's and are not counted here), and a computer that is set up is asked nothing new.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SHELL_STANDINS } from '../seal.mjs';
import { gitWorld } from '../workspace/gitfix.mjs';
import { fakeBin, pathWith, recorder } from './helpers.mjs';

const w = gitWorld('setup-questions');
test.after(() => w.cleanup());
const A = w.computer('fresh');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = path.join(A.home, 'Workspace');
// A fresh computer's git: no name, no e-mail, and GitHub's addresses lead to the local "server".
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[protocol "file"]\n\tallow = always\n[url "${String(w.server).replaceAll('\\', '/')}/"]\n\tinsteadOf = https://github.com/\n`);
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_RUNTIME_DIR;
delete process.env.DBUS_SESSION_BUS_ADDRESS;

const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { capture, which } = await import('../../src/setup/system.mjs');
const { runPcSetup } = await import('../../src/pcsetup/index.mjs');
const { sysFacts } = await import('../../src/pcsetup/detect.mjs');
const { runGitStep } = await import('../../src/workspace/gitstep.mjs');
const { runWorkspaceStep } = await import('../../src/workspace/step.mjs');
const { installerUrl } = await import('../../src/claudecode.mjs');

// ---- the stand-ins ---------------------------------------------------------------------------------------------
const tmp = path.join(w.root, 'standins');
fs.mkdirSync(tmp, { recursive: true });
const calls = [];
// Claude's official installer, as a script that puts a stand-in `claude` into ~/.local/bin.
const claudeFile = path.join(tmp, 'claude-fixture');
fs.writeFileSync(claudeFile, '#!/bin/sh\ncase "$1" in --version) echo "2.1.300 (Claude Code)";; auth) echo \'{"loggedIn":true,"authMethod":"claude.ai","email":"a@example.com"}\';; *) exit 0;; esac\n');
const installer = `#!/bin/sh\nnode -e "const fs=require('fs');const d=process.env.HOME+'/.local/bin';fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+'/claude',fs.readFileSync(process.argv[1]),{mode:0o755})" '${claudeFile}'\n`;
globalThis.fetch = async (url) => {
  calls.push(`fetch ${url}`);
  if (url === installerUrl('linux')) return { ok: true, status: 200, url, text: async () => installer };
  if (/claude-code-releases\/latest/.test(url)) return { ok: true, status: 200, url, text: async () => '2.1.300' };
  throw new Error('offline');
};
const bin = fakeBin(path.join(tmp, 'bin'), {
  loginctl: `case "$1" in show-user) if [ -e '${path.join(tmp, 'linger')}' ]; then echo Linger=yes; else echo Linger=no; fi ;; esac`,
  systemctl: 'exit 0',
  sudo: 'exit 0',
});
const real = (n) => which(n, { PATH: process.env.PATH }, 'linux'); // seal: looks for the program to link into the test's own folder
for (const n of ['bash', 'git']) if (real(n)) fs.symlinkSync(real(n), path.join(bin, n));
process.env.PATH = pathWith(tmp, bin); // seal: only the test's own folders
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SSH_|DISPLAY$|WAYLAND_DISPLAY$)/.test(k))), PATH: process.env.PATH }; // seal: only the test's own folders

// A GitHub with one account, signed in by `gh auth login`, that keeps a private repository per `repo create`.
const gh = { signedIn: false, created: null };
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', output: stdout });
const no = (stderr = '') => ({ ok: false, code: 1, stdout: '', stderr, output: stderr });
async function ghRun(argv) {
  const a = argv.slice(1).join(' ');
  calls.push(`gh ${a}`);
  if (a.startsWith('--version')) return ok('gh version 2.0.0 (2024-01-01)');
  if (a.startsWith('auth status')) return gh.signedIn ? { ...ok(), stderr: 'github.com\n  ✓ Logged in to github.com account alex (keyring)\n' } : no('You are not logged into any GitHub hosts.');
  if (a.startsWith('auth login')) {
    gh.signedIn = true;
    return ok();
  }
  if (!gh.signedIn) return no('not signed in');
  if (a.startsWith('auth setup-git')) return capture(['git', 'config', '--global', 'credential.https://github.com.helper', '!gh auth git-credential'], { env });
  if (a === 'api user --jq [.id, .login, (.name // "")] | @tsv') return ok('12345\talex\tAlex Example\n');
  if (a === 'api user --jq .login') return ok('alex\n');
  if (a === 'api user/orgs --jq .[].login') return ok('');
  if (a.startsWith('repo list')) return ok(JSON.stringify(gh.created ? [{ name: gh.created, url: '', isPrivate: true }] : []));
  if (a.startsWith('repo create')) {
    const [owner, name] = argv[3].split('/');
    const dir = argv[argv.indexOf('--source') + 1];
    fs.mkdirSync(path.join(w.server, owner), { recursive: true });
    w.sh(w.server, 'init', '-q', '--bare', '-b', 'main', path.join(w.server, owner, `${name}.git`));
    w.sh(dir, 'remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`);
    w.sh(dir, 'push', '-q', '-u', 'origin', 'HEAD');
    gh.created = name;
    return ok();
  }
  if (a.startsWith(`api repos/alex/${gh.created}/contents/`)) return ok('workspace.json\n');
  return no(`unexpected: gh ${a}`);
}
let packagesInstalled = false;
const hasProgram = (c) => (c === 'gh' ? packagesInstalled : ['git', 'sudo', 'bash', 'curl', 'loginctl'].includes(c) || !!which(c, env, 'linux'));
/** What runs for the computer step: git for real (the commit name goes into the test's git), gh as above, the package manager never. */
const pcRunner = async (argv) => {
  calls.push(`run ${argv.join(' ')}`);
  if (argv[0] === 'gh') return ghRun(argv);
  if (argv[0] === 'git') return capture(argv, { env });
  if (argv[0] === 'sudo' && argv[1] === 'loginctl') {
    fs.writeFileSync(path.join(tmp, 'linger'), '');
    return ok();
  }
  packagesInstalled = true; // the kits' installs "ran": gh is there afterwards
  return ok();
};
const gitRun = async (argv, o) => (argv[0] === 'gh' ? ghRun(argv) : capture(argv, { ...o, env }));
const parts = {
  pc: async (o) => runPcSetup({ ...o, runner: pcRunner, sys: await sysFacts({ platform: 'linux', pm: 'apt', has: hasProgram, run: (argv, o2) => (argv[0] === 'gh' ? ghRun(argv) : capture(argv, { ...o2, env })), env, root: false, user: 'alex', home: A.home }) }),
  git: async (o) => runGitStep({ ...o, run: gitRun, term: gitRun, has: (c) => (c === 'gh' ? packagesInstalled : c === 'git') }),
  workspace: async (o) => runWorkspaceStep(o),
};

/** The answers of a person who takes what is offered: a name, an e-mail, a computer name, no project. */
function person() {
  const asked = [];
  const rec = recorder();
  const answer = (q) => (/name for commits/.test(q) ? 'Alex Example' : /e-mail for commits/.test(q) ? 'alex@example.com' : /This computer's name/.test(q) ? 'laptop' : '');
  const ui = makeUi({ interactive: true, write: rec.write, askLine: async (q) => { asked.push(q.trim()); return answer(q); } });
  return { ui, asked, rec };
}
function sys() {
  const s = K.sysInfo({ env, platform: 'linux', has: hasProgram, pm: 'apt', root: false, publicIps: [], dmi: {}, localDisplay: true, savedServer: null, user: 'alex', serviceSupported: true });
  s.probe = async () => 200;
  return s;
}

// Linux only: the walk plays a Linux desktop (apt, systemd, a Linux home), which does not exist on Windows.
test('a fresh Linux desktop, the whole set-up: 7 questions of Hoprig, and a second run asks nothing new', { ...SHELL_STANDINS, skip: process.platform === 'win32' ? 'a Linux desktop set-up (apt, systemd) does not exist on Windows' : SHELL_STANDINS.skip }, async () => {
  const first = person();
  const code = await SU.setup([], { ui: first.ui, sys: sys(), parts });
  const list = `questions asked:\n${first.asked.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n${first.rec.text}`;
  assert.equal(code, 0, list);
  assert.equal(first.asked.length, 7, list);
  // Nothing Hoprig can decide for the person is asked.
  for (const q of first.asked) assert.doesNotMatch(q, /Install it now|Add "hoprig"|working rules|name for commits|e-mail for commits|Create the workspace\?/, q);
  assert.equal(gh.signedIn, true, 'GitHub is signed in');
  assert.equal(calls.filter((c) => /^(run )?gh auth login/.test(c)).length, 1, 'one sign-in');
  const id = await capture(['git', 'config', '--global', 'user.email'], { env });
  assert.match(id.stdout, /@/, 'the commit identity is set');

  // The same computer again: what was answered is not asked again. (Left: the one list of installs, because this
  // world's package manager only pretends to install, and the project, which Enter skipped.)
  const second = person();
  assert.equal(await SU.setup([], { ui: second.ui, sys: sys(), parts }), 0, second.rec.text);
  for (const q of second.asked) assert.match(q, /^(Install these \d+ steps now|A project to work on)/, `asked again: ${q}`);
});
