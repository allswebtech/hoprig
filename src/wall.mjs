// The wall of Hands-off, at the ACT. While Hands-off is on for a session, a command of a kind that is the owner's
// alone is HELD where it runs: the hook answers "ask", so the coding tool draws the owner's card, in every
// permission mode (bypass included). This is not the net of a question's words (handsoff.mjs SIGNS reads what a
// session SAYS); this reads what it is about to DO. Its rule, kept from asking.mjs's own reader: a line it cannot
// read with certainty is held.
//
// The kinds in this file are the owner's WHEREVER they run, so they need no git or folder context:
//   admin     administrator rights: sudo, sudoedit, su, doas, pkexec, run0 (and machinectl shell, systemd-run)
//   release   publishing or releasing by the tool that does it: npm|pnpm|yarn publish, cargo publish,
//             twine upload, gem push, docker|podman push, gh release create
//   pr        a pull or merge request made or merged: gh pr create|merge, glab mr create|merge
// A push that would move a default branch or a tag (git, read with the repository), a delete outside the session's
// own folder, and a write to Hoprig's own files are read with their context, by the readers further down this file.
// An administrator command never hides what it does: the command behind `sudo` is read by those readers as the same
// words without it are, and each thing found is an act of its own beside `admin` (behindAdmin).
// Nor does a program in front of it hide it: behind a program that runs its own words as a command (a passer, a
// wrapper, the shell's `if` and `while`) the command is read by that program's own words, and where those are not
// all known, from every later word a command of these kinds can begin with (the net in walk).
//
// The reader is small and strict and holds anything it is not sure of. It reads one line of Bash: commands joined
// by ; && || and pipes, words that may be quoted or split, bare ${variables} (dropped where they stand in an
// argument: their value does not change which program runs; but a variable standing alone AS the command's head
// IS held, since its value can be any program), and a nested command in sh -c "…", eval "…" and the like (read one
// level deep). What it
// HOLDS without reading further: a line over the budget, a quote that never closes, and a command substitution
// $( … ) or a backtick (its value can be any program, so the wall cannot be sure what would run). Only node:
// imports: the hook loads this and Claude Code waits for it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mayDelete, plainDelete } from './asking.mjs';
import { pathTexts, shellWords } from './shellwords.mjs';

const LINE_MAX = 4000;
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';

// Administrator rights: the program is the act, wherever it stands (also where it only passes a command on: `sudo
// npm publish` is both the owner's, and `sudo` alone names the act). `sudoedit` edits a file as administrator (it is
// `sudo -e`, which is already caught because `sudo` heads it); the owner approves an editor as administrator at
// every level, since an editor as administrator can change who may be administrator.
const ADMIN = new Set(['sudo', 'sudoedit', 'su', 'doas', 'pkexec', 'run0']);
// On Windows the escalator may be a program the Unix reading does not know: `gsudo`. A `sudo.exe`, `Sudo.EXE` or a
// full path to one is read as `sudo` by baseName on win32 (either separator, any case, no .exe/.com/.bat/.cmd).
// `runas` runs a program as another user (`runas /user:Administrator cmd`), which is how Windows asks for an
// administrator without sudo.
const WIN_ADMIN = new Set(['gsudo', 'runas']);
// On Windows PowerShell runs the text of its `-c`/`-Command` as a command line, as `sh -c` does.
const WIN_SHELLS = new Set(['powershell', 'pwsh']);
// The switch of `cmd` that runs what follows as a command: `/c` or `/k`, in any case, as Git Bash must write it
// (`//c`: it turns a bare `/c` into a path), behind other switches joined to it (`/s/c`, `/d/s/c`), and with the
// command joined on (`/c"gsudo whoami"`, `/cgsudo`). Group 1: what is joined on after the switch.
const CMD_RUNS = /^\/\/?(?:[a-z](?::[^/\s]*)?\/+)*[ck](.*)$/is;
// PowerShell's `-Command` in every prefix it takes (`-c`, `-com`, `-Comm`, …), with one or two dashes or a slash, and
// its `-File` the same way.
const PS_COMMAND = /^(?:--?|\/)c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?(?::(.*))?$/is; // group 1: a command joined on with a colon
const PS_FILE = /^(?:--?|\/)f(?:i(?:l(?:e)?)?)?$/i;
// Its `-EncodedCommand` (`-e`, `-ec`, `-enc`, …): the command as base64 of UTF-16, which hides it from a reader of the
// line. It is decoded and read as the command text it is; what does not decode to a text is held as unreadable.
const PS_ENCODED = /^(?:--?|\/)e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?$/i;
const psDecoded = (w) => {
  if (typeof w !== 'string' || !/^[A-Za-z0-9+/]{4,}={0,2}$/.test(w) || w.length > 200_000) return null;
  const text = Buffer.from(w, 'base64').toString('utf16le');
  // eslint-disable-next-line no-control-regex
  return text && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text) ? text : null;
};
// PowerShell's own switches that take no value: the word after one of them is the command or the script it runs.
const PS_BARE = /^(?:--?|\/)(?:nop(?:rofile)?|nol(?:ogo)?|noni(?:nteractive)?|noe(?:xit)?|sta|mta|i(?:nteractive)?|l(?:ogin)?)$/i;
// Its switches that take a value, which is never what it runs (`-ExecutionPolicy Bypass`, `-WorkingDirectory ../x`).
const PS_VALUE = /^(?:--?|\/)(?:ex(?:ecutionpolicy)?|ep|w(?:indowstyle)?|wd|workingdirectory|o(?:utputformat)?|of|inputformat|if|v(?:ersion)?|config(?:urationname)?|settingsfile|settings|custompipename|psconsolefile)$/i;
// (A value may be joined on with a colon, `-Version:5.1`, `-wd:C:/x`; a Git Bash path `/c/Users/…` is no switch.)
const PS_SWITCH = /^(?:--?|\/)[a-z][\w-]*(?::.*)?$/i;
// What `start` may be handed that is a program: a bare name, a program or script by its ending, or (whatever its
// folder) one of the programs that ask for administrator rights or run a command text. A folder, a document and a web
// address are opened, not run.
const WIN_PROGRAM_END = /\.(?:exe|com|bat|cmd|ps1|sh)$/i;
// On Windows these take a command text as PowerShell's -c does (`iex 'gsudo whoami'`).
const WIN_TAKES_COMMAND = new Set(['iex', 'invoke-expression']);
// PowerShell's Start-Process and its two short names; with the verb RunAs it asks Windows for administrator rights.
const WIN_START_PROCESS = new Set(['start-process', 'saps', 'start']);
const PS_VERB = /^-v(?:e(?:r(?:b)?)?)?(?::(.*))?$/i;
// What only passes a command on (its options, assignments and counts come after it), so the real head is the next
// word. sudo/su/doas/pkexec pass a command on too, but they are the admin act first and are caught before this. A
// scheduler, affinity, namespace or sandbox wrapper runs its argument as a command the same way (`chrt 1 sudo su`,
// `flock /tmp/l sudo su`): a program behind one was invisible, so an administrator command hid what it does. The
// shell's own words that stand before a command (`if sudo …`, `while sudo …`, `! sudo …`) pass it on as well.
const PASSERS = new Set(['env', 'time', 'nice', 'nohup', 'timeout', 'command', 'builtin', 'exec', 'xargs', 'ionice', 'stdbuf', 'setsid', 'eatmydata', 'fakeroot', 'busybox', 'chrt', 'taskset', 'numactl', 'firejail', 'unshare', 'nsenter', 'setpriv', 'flock', 'chroot', 'then', 'do', 'if', 'elif', 'else', 'while', 'until', '!']);
// Programs whose string argument is another command line, read one level deeper (sh -c "…", eval "…", ssh host "…").
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);
const TAKES_COMMAND = new Set(['eval', 'ssh', 'env', 'xargs', 'watch', 'timeout', 'nice', 'ionice', 'nohup', 'time', 'stdbuf', 'setsid', 'flock', 'script', 'parallel', 'tmux', 'screen', 'concurrently', 'nodemon', 'watchexec']);
// More programs that run their own words as a command, whose own options this reader does not step (a tracer, a
// group or user switch, a control group, the service manager's runner, a fake clock, a proxy and the like).
const MORE_RUNNERS = new Set(['sg', 'runuser', 'cgexec', 'systemd-run', 'machinectl', 'strace', 'ltrace', 'valgrind', 'perf', 'unbuffer', 'faketime', 'setarch', 'linux32', 'linux64', 'prlimit', 'runcon', 'dbus-run-session', 'xvfb-run', 'torsocks', 'proxychains', 'proxychains4', 'systemd-inhibit', 'caffeinate', 'entr', 'daemonize', 'start-stop-daemon', 'cpulimit', 'rlwrap', 'sshpass', 'sem', 'at', 'batch']);
// A package runner, an environment loader and a version manager's runner run their own words as a command too, and
// each is read by its own words, so the command behind it is read as it is without it (`npx npm publish` is `npm
// publish`): `values` its options whose value is the next word, `texts` its options whose value is a command line
// (read one level in, as a shell's -c is), `program` an option whose value is the program (`uv run -m twine`), `own`
// the plain words of its own before the command (direnv's folder), `pkg` the command may carry a version (`npx
// npm@10 publish` runs npm). `--` ends its own words. Where one of its options is not known here, the net in walk
// still reads a command of the owner's kinds further on. npx and npm exec are read from npm's own documentation,
// corepack from its README; the others are written as their documentation is known.
// One word: these are on the ONE list (runsItsWords).
const RUN_ONE = Object.freeze({
  npx: { values: ['-p', '--package', '-w', '--workspace', '--prefix'], texts: ['-c', '--call'], pkg: true },
  pnpx: { values: ['--package'], pkg: true },
  bunx: { values: ['-p', '--package'], pkg: true },
  uvx: { values: ['--from', '--with', '--with-editable', '--with-requirements', '-p', '--python', '--index', '--index-url', '--default-index', '--extra-index-url', '-f', '--find-links', '--directory', '--project', '--config-file', '--cache-dir'], pkg: true },
  'cross-env': {},
  'cross-env-shell': {},
  // dotenv-cli (`dotenv -e .env -- jest`) and python-dotenv (`dotenv -f .env run jest`) share the name.
  dotenv: { values: ['-e', '-v', '-p', '-f', '--file'], own: { test: (w) => w === 'run', max: 1 } },
  'env-cmd': { values: ['-f', '--file', '-e', '--environments', '-r', '--rc-file'] },
});
// Two words: a program and the subcommand that runs a command (`npm exec`, `uv run`). Only with that subcommand is it
// a runner: `npm`, `uv` or `poetry` alone never run their words. `before`: the program's options that take a value
// before the subcommand (`pnpm --filter web exec jest`).
const UV_RUN = ['--with', '--with-editable', '--with-requirements', '-p', '--python', '--from', '--package', '--extra', '--group', '--only-group', '--env-file', '--directory', '--project', '--index', '--index-url', '--default-index', '--extra-index-url', '-f', '--find-links', '--config-file', '--cache-dir'];
const RUN_TWO = Object.freeze({
  npm: { before: ['-w', '--workspace', '--prefix'], subs: [['exec'], ['x']], values: ['--package', '-w', '--workspace', '--prefix'], texts: ['-c', '--call'], pkg: true },
  pnpm: { before: ['-C', '--dir', '-F', '--filter', '--workspace-dir'], subs: [['dlx'], ['exec']], values: ['--package', '-C', '--dir', '-F', '--filter', '--allow-build'], pkg: true },
  yarn: { before: ['--cwd'], subs: [['dlx'], ['exec']], values: ['-p', '--package'], pkg: true },
  bun: { before: ['--cwd'], subs: [['x']], values: ['-p', '--package'], pkg: true },
  uv: { before: ['--directory', '--project', '--config-file', '--cache-dir'], subs: [['run'], ['tool', 'run']], values: UV_RUN, program: ['-m', '--module'], pkg: true },
  pipx: { subs: [['run']], values: ['--spec', '--python', '--pip-args', '--index-url', '--backend'] },
  poetry: { before: ['-C', '--directory', '-P', '--project'], subs: [['run']] },
  bundle: { subs: [['exec']], values: ['--gemfile'] },
  mise: { before: ['-C', '--cd', '-E', '--env'], subs: [['exec'], ['x']], values: ['-C', '--cd', '-E', '--env', '-j', '--jobs'], texts: ['-c', '--command'], own: { test: (w) => w.includes('@'), max: Infinity }, dashes: true },
  direnv: { subs: [['exec']], own: { test: () => true, max: 1 } },
  pdm: { subs: [['run']] },
  hatch: { before: ['-e', '--env'], subs: [['run']] },
  rye: { subs: [['run']] },
  pixi: { subs: [['run']], values: ['-e', '--environment', '--manifest-path'] },
  pipenv: { subs: [['run']] },
  conda: { subs: [['run']], values: ['-n', '--name', '-p', '--prefix', '--cwd'] },
  mamba: { subs: [['run']], values: ['-n', '--name', '-p', '--prefix', '--cwd'] },
  micromamba: { subs: [['run']], values: ['-n', '--name', '-p', '--prefix', '--cwd'] },
  pyenv: { subs: [['exec']] },
  rbenv: { subs: [['exec']] },
  nodenv: { subs: [['exec']] },
  asdf: { subs: [['exec']] },
  volta: { subs: [['run']], values: ['--node', '--npm', '--pnpm', '--yarn', '--env'] },
  fnm: { subs: [['exec']], values: ['--using'] },
  nvm: { subs: [['exec']], own: { test: (w) => /^(?:v?\d[\w.]*|node|stable|iojs|lts\/[\w*-]+)$/.test(w), max: 1 } },
  dotenvx: { subs: [['run']], values: ['-f', '--env-file', '-e', '--env', '-fk', '--env-keys-file'] },
  doppler: { subs: [['run']], values: ['-p', '--project', '-c', '--config', '--token', '--mount', '--fallback'], texts: ['--command'] },
  op: { subs: [['run']], values: ['--env-file', '--account'] },
  infisical: { subs: [['run']], values: ['--env', '--path', '--projectId', '--token', '--domain'], texts: ['--command'] },
  'aws-vault': { subs: [['exec']], own: { test: () => true, max: 1 }, dashes: true },
  // corepack runs the package manager it names (`corepack pnpm publish`); `corepack enable` runs nothing.
  corepack: { keep: ['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg'] },
});
// A package name as the program it runs: its version taken off (`npm@10`, `@scope/tool@2` → `tool`).
const pkgName = (w) => baseName(w.replace(/^(@?[^@]+)@.*$/, '$1'));
// Step a runner's own words (RUN_ONE, or RUN_TWO with its subcommand) from the program at k. → null when the word at
// k is not a runner here, else { next: where the command it runs begins, texts: the command lines it carries, name:
// the program's name where it carries a version }.
function runnerStep(cmd, k, b) {
  let spec = Object.hasOwn(RUN_ONE, b) ? RUN_ONE[b] : null;
  let j = k + 1;
  if (!spec) {
    const two = Object.hasOwn(RUN_TWO, b) ? RUN_TWO[b] : null;
    if (!two) return null;
    while (j < cmd.length && isOption(cmd[j].word)) j += (two.before || []).includes(cmd[j].word) ? 2 : 1;
    if (two.keep) return j < cmd.length && two.keep.includes(pkgName(cmd[j].word)) ? { next: j, texts: [], name: pkgName(cmd[j].word) } : null;
    const sub = two.subs.find((s) => s.every((w, n) => j + n < cmd.length && cmd[j + n].word === w));
    if (!sub) return null;
    j += sub.length;
    spec = two;
  }
  // A runner whose own words end at `--` (mise's tools, aws-vault's profile): the command stands after it.
  const dashes = spec.dashes ? cmd.findIndex((t, n) => n >= j && t.word === '--') : -1;
  if (dashes >= 0) return { next: dashes + 1, texts: [], name: null };
  const texts = [];
  let own = spec.own ? spec.own.max : 0;
  while (j < cmd.length) {
    const w = cmd[j].word;
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    if (w === '--') {
      j += 1;
      break;
    }
    if ((spec.texts || []).includes(w)) {
      if (j + 1 < cmd.length) texts.push(cmd[j + 1].word);
      j = cmd.length; // it runs that text, not the words after it
      break;
    }
    if (eq > 0 && (spec.texts || []).includes(w.slice(0, eq))) {
      texts.push(w.slice(eq + 1));
      j = cmd.length;
      break;
    }
    if ((spec.program || []).includes(w)) {
      j += 1;
      break;
    }
    if (isOption(w)) j += (spec.values || []).includes(w) ? 2 : 1;
    else if (isAssignment(w)) j += 1;
    else if (own > 0 && spec.own.test(w)) {
      own -= 1;
      j += 1;
    } else break;
  }
  const at = Math.min(j, cmd.length);
  return { next: at, texts, name: spec.pkg && at < cmd.length ? pkgName(cmd[at].word) : null };
}
// python's own words, as its usage text gives them: `-c cmd` and `-m mod` end its options, `-W arg` and `-X opt` take
// a value, short flags may stand together (`-Bu`, `-um twine`) and `-m` may carry its module glued (`-mtwine`). From
// index i of the words after python → { module, at (its index; `glued` when it stands in the option word) } for
// `-m`, { text } for `-c`, { script: its index } for a script file, or {} for none.
const PYTHON = /^python(?:\d+(?:\.\d+)*)?$/;
function pythonArgs(words, i = 0) {
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--check-hash-based-pycs') {
      i += 1;
      continue;
    }
    if (w.startsWith('--')) continue;
    if (w === '-' || !w.startsWith('-')) return { script: i };
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (ch === 'c') return { text: i };
      if (ch === 'm') return c + 1 < w.length ? { module: w.slice(c + 1), at: i, glued: true } : { module: words[i + 1], at: i + 1 };
      if (ch === 'W' || ch === 'X') {
        if (c + 1 === w.length) i += 1;
        break;
      }
    }
  }
  return {};
}
// `python -m <module>` runs the module as its own command (`python3 -m twine upload` is `twine upload`): → the same
// shape as runnerStep, or null when python runs no module.
function pythonStep(cmd, k) {
  const r = pythonArgs(cmd.map((t) => t.word), k + 1);
  if (typeof r.module !== 'string' || !r.module) return null;
  return { next: r.at, texts: [], name: r.glued ? baseName(r.module) : null, glued: !!r.glued };
}
/**
 * Does this program run its own words as a command (an administrator program, a passer, a wrapper, or a program
 * that takes a command to run)? The ONE list: the wall reads behind such a program, and the floor no level lifts
 * (src/assistant/adminrefused.mjs) refuses one as the program sudo runs, since it hides which program would run.
 * A runner of two words (`npm exec`, `uv run`) is read with its subcommand by the wall and is not on this list.
 */
export const runsItsWords = (program) => ADMIN.has(program) || PASSERS.has(program) || TAKES_COMMAND.has(program) || MORE_RUNNERS.has(program) || Object.hasOwn(RUN_ONE, program);
// Where a command of the owner's kinds can begin behind a program that runs its words: an administrator program, the
// tools the kinds are read from, a shell and a program that takes a command text. (Not any word: a branch that is
// called `release` is no deploy script.)
const NET_HEADS = new Set([...ADMIN, ...SHELLS, ...TAKES_COMMAND, 'git', 'npm', 'pnpm', 'yarn', 'cargo', 'twine', 'gem', 'docker', 'podman', 'nerdctl', 'gh', 'glab', 'make',
  // the two doors to administrator rights read by kindOfCommand
  'systemd-run', 'machinectl',
  // the package runners and the other release tools read by releaseKind
  'npx', 'bunx', 'pnpx', 'uvx', 'cross-env', 'dotenv', 'poetry', 'uv', 'bun', 'flit', 'hatch', 'pdm', 'rye', 'vsce', 'ovsx', 'lerna', 'changeset', 'deno', 'jsr', 'dart', 'flutter', 'pod', 'mix', 'dotnet', 'nuget', 'helm', 'mvn', 'mvnw', 'gradle', 'gradlew', 'semantic-release', 'release-it', 'goreleaser',
  // the interpreters and task runners read by deployKind
  'node', 'nodejs', 'python', 'python3', 'ruby', 'perl', 'php', 'tsx', 'ts-node', 'rake', 'just', 'gmake', 'cap', 'fab', 'invoke', 'mage']);
// Commands that change the working directory. A git push/merge/rebase after one of these lands in a folder the
// event's cwd does not name, so the wall cannot say which repository it moves: it is held (gitKind). `builtin` and
// `command` before cd are stepped over as passers, so `builtin cd …` reaches cd here.
const CHANGES_DIR = new Set(['cd', 'pushd', 'popd', 'chdir']);
// The environment variables that point git at another repository: set on the line (GIT_DIR=… git push) or exported,
// they make the repository a push/merge would move unreadable, exactly as a cd does.
const GIT_REPO_VARS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']);
// Shell builtins that set a variable for the rest of the line, so `export GIT_DIR=… ; git push` points git elsewhere.
const EXPORTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
const assignName = (w) => {
  const eq = w.indexOf('=');
  return eq > 0 ? w.slice(0, eq) : null;
};

const WIN_EXE = /\.(?:exe|com|bat|cmd)$/;
const baseName = (w, platform = process.platform) => {
  if (platform === 'win32') {
    // cmd takes a caret away and PowerShell a backtick before they look a program up (`g^sudo`, `` g`sudo ``): the
    // name is read without them.
    w = w.replace(/[\^`]/g, '');
    const cut = Math.max(w.lastIndexOf('/'), w.lastIndexOf('\\'));
    const b = w.slice(cut + 1).toLowerCase().replace(WIN_EXE, '');
    // A full path written unquoted with backslashes reaches the reader without them (`C:\Windows\System32\sudo.exe`
    // is `C:WindowsSystem32sudo.exe`): where such a word ends in an escalator's name, it is that escalator.
    // The same for the programs that run a command text, by the full path Windows keeps them at
    // (`C:\Windows\System32\cmd.exe /c …`, `…\WindowsPowerShell\v1.0\powershell.exe`), so what they run is read.
    if (cut < 0 && /^[a-z]:./.test(b)) {
      const esc = [...ADMIN, ...WIN_ADMIN].sort((x, y) => y.length - x.length).find((n) => b.endsWith(n));
      if (esc) return esc;
      // Only from the folders Windows keeps them in, so a program whose name merely ends like one is itself.
      if (/(?:system32|syswow64|sysnative)cmd$/.test(b)) return 'cmd';
      if (/v1\.0powershell$/.test(b)) return 'powershell';
      if (/powershell\d+pwsh$/.test(b)) return 'pwsh';
    }
    return b;
  }
  const b = w.slice(w.lastIndexOf('/') + 1);
  return platform === 'darwin' ? b.toLowerCase() : b;
};
const isOption = (w) => w.startsWith('-');
// A leading assignment before the program, in every form bash reads as one: a plain `NAME=value`, an append
// `NAME+=value`, and an array element `NAME[subscript]=value` or `NAME[subscript]+=value`. Each sets a variable for
// the command and is not the program, so `x+=1 sudo su` and `a[0]=1 sudo su` reach sudo as `x=1 sudo su` does.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const isAssignment = (w) => ASSIGNMENT.test(w);
// A passer's own argument that is not the command: a bare number or a duration (timeout 5, timeout 90s, nice 10).
const isCount = (w) => /^\d+(?:\.\d+)?[smhd]?$/.test(w);
// What a passer takes of its own before the command it passes on. `values`: its options whose value is the NEXT word,
// so that word is not the command (`timeout -s KILL sudo …`, `nice -n 5 sudo …`, `stdbuf -o L sudo …`, `xargs -a list
// sudo …`). `own`: the one plain word of its own that comes first (timeout's duration, chrt's priority, taskset's
// mask or list, chroot's new root), told by its shape. A passer with no `own` steps bare counts as before. A program
// behind a passer whose words are not all known here is still found by the net in walk.
const NO_VALUES = new Set();
const GRAMMAR = Object.freeze({
  timeout: { values: new Set(['-s', '--signal', '-k', '--kill-after']), own: (w) => isCount(w) },
  chrt: { values: new Set(['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline']), own: (w) => isCount(w) },
  taskset: { values: NO_VALUES, own: (w) => /^(?:0x[0-9a-f]+|[0-9][0-9a-f,:-]*)$/i.test(w) },
  chroot: { values: new Set(['--userspec', '--groups']), own: () => true },
  nice: { values: new Set(['-n', '--adjustment']) },
  ionice: { values: new Set(['-c', '--class', '-n', '--classdata']) },
  stdbuf: { values: new Set(['-i', '--input', '-o', '--output', '-e', '--error']) },
  exec: { values: new Set(['-a']) },
  xargs: { values: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']) },
  numactl: { values: new Set(['-N', '--cpunodebind', '-C', '--physcpubind', '-m', '--membind', '-i', '--interleave', '-p', '--preferred']) },
  nsenter: { values: new Set(['-t', '--target', '-S', '--setuid', '-G', '--setgid']) },
  sudo: { values: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-r', '--role', '-t', '--type', '-U', '--other-user']) },
  doas: { values: new Set(['-u', '-C']) },
  pkexec: { values: new Set(['--user']) },
});
// Step over a passer's own words to reach the command it passes on: its options (with the value of one that takes
// one), assignments, bare counts/durations, and the one plain word of its own. `b` is the passer's name. A word is
// read as the passer receives it, in quotes or not: quotes do not change what it is given, so `nice "-n" 5 sudo su`
// and `timeout "5" sudo su` are the commands they are without the quotes (a quoted option or count hid the program).
const stepArgs = (cmd, k, b = null) => {
  const g = (b && GRAMMAR[b]) || null;
  const values = g ? g.values : NO_VALUES;
  const own = g && g.own ? g.own : null;
  while (k < cmd.length) {
    const w = cmd[k].word;
    if (isOption(w)) k += values.has(w) && k + 1 < cmd.length ? 2 : 1;
    else if (isAssignment(w) || (!own && isCount(w))) k += 1;
    else break;
  }
  if (own && k < cmd.length && own(cmd[k].word)) k += 1;
  return k;
};
// env takes options that consume the next word (`-C DIR`/`--chdir DIR`, `-u NAME`/`--unset NAME`, `-S STR`) and
// assignments, before the command it runs. Step over them to the command, and report `-C`/`--chdir` (the command
// runs in another folder, like a cd), any GIT_DIR-family assignment (it points git at another repository) and the
// value of `-S`/`--split-string`, which is itself a command line (`texts`: walk reads it one level in). A generic
// stepArgs would take the value of `-C` as the command's head, so `env -C . git push` slipped through. Read as env
// receives its words, in quotes or not.
function envStep(cmd, k) {
  let chdir = false;
  let repoVar = false;
  const texts = [];
  while (k < cmd.length) {
    const w = cmd[k].word;
    if (isAssignment(w)) {
      if (GIT_REPO_VARS.has(assignName(w))) repoVar = true;
      k += 1;
    } else if (w === '-C' || w === '--chdir') {
      chdir = true;
      k += 2;
    } else if (w.startsWith('--chdir=')) {
      chdir = true;
      k += 1;
    } else if (w === '--split-string' || /^-[A-Za-z0-9]*S$/.test(w)) {
      if (k + 1 < cmd.length) texts.push(cmd[k + 1].word);
      k += 2;
    } else if (w.startsWith('--split-string=')) {
      texts.push(w.slice('--split-string='.length));
      k += 1;
    } else if (/^-[A-Za-z0-9]*S./.test(w) && !w.startsWith('--')) {
      texts.push(w.slice(w.indexOf('S') + 1));
      k += 1;
    } else if (w === '-u' || w === '--unset') {
      k += 2;
    } else if (isOption(w)) {
      k += 1;
    } else {
      break; // the command env runs
    }
  }
  return { next: k, chdir, repoVar, texts };
}
// flock's own words: its options (two take a value), then the lock file, folder or descriptor, then EITHER the
// command and its arguments (`flock /tmp/l sudo su`) OR `-c TEXT` / `--command TEXT`, a command line it hands to a
// shell (`flock /tmp/l -c 'sudo su'`; the text may stand first, glued, or with no quotes). → `next`: where the command
// it runs begins (the end of the words when it runs a text), and `texts`: the command lines it carries, which walk
// reads one level in. Every quoted word after flock is such a text too, as it was before flock's words were stepped.
const FLOCK_VALUES = new Set(['-w', '--wait', '--timeout', '-E', '--conflict-exit-code']);
function flockStep(cmd, k) {
  const texts = cmd.slice(k).filter((t) => t.quoted).map((t) => t.word);
  let carried = false;
  let file = false;
  while (k < cmd.length) {
    const w = cmd[k].word;
    if (w === '-c' || w === '--command') {
      if (k + 1 < cmd.length) texts.push(cmd[k + 1].word);
      carried = true;
      k += 2;
    } else if (w.startsWith('--command=')) {
      texts.push(w.slice('--command='.length));
      carried = true;
      k += 1;
    } else if (/^-c./.test(w)) {
      texts.push(w.slice(2));
      carried = true;
      k += 1;
    } else if (file) {
      break; // the command it runs
    } else if (isOption(w)) {
      k += FLOCK_VALUES.has(w) ? 2 : 1;
    } else {
      file = true;
      k += 1;
    }
  }
  return { next: carried ? cmd.length : Math.min(k, cmd.length), texts: [...new Set(texts)] };
}

// A command substitution that only cats quoted heredocs — `$(cat <<'EOF' … EOF)` — expands to literal text: a quoted
// delimiter means the body has no expansion and runs no command, so this is how Claude Code passes a commit message,
// not a command to run. From `start` (at `$`), return the index just past the closing `)` when the substitution is
// exactly that; else -1. An UNQUOTED delimiter, any extra command, or anything else returns -1 and stays unreadable.
function matchCatHeredocSubst(line, start) {
  let j = start + 2; // past "$("
  const ws = () => { while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++; };
  ws();
  if (line.slice(j, j + 3) !== 'cat') return -1;
  j += 3;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t' && line[j] !== '<') return -1; // `cat` as a whole word
  ws();
  if (line[j] !== '<' || line[j + 1] !== '<') return -1;
  j += 2;
  if (line[j] === '-') j++;
  ws();
  const q = line[j];
  if (q !== "'" && q !== '"') return -1; // the delimiter must be quoted, so the body is literal
  j++;
  const ds = j;
  while (j < line.length && line[j] !== q) j++;
  if (j >= line.length) return -1;
  const delim = line.slice(ds, j);
  if (!/^[A-Za-z0-9_]+$/.test(delim)) return -1;
  j++; // past the closing quote
  ws();
  if (line[j] === '\r') j++;
  if (line[j] !== '\n') return -1; // nothing else on the heredoc's opening line
  j++;
  for (;;) { // the body, until a line that is exactly the delimiter (leading whitespace allowed, as <<- strips tabs)
    const nl = line.indexOf('\n', j);
    const end = nl < 0 ? line.length : nl;
    if (line.slice(j, end).replace(/^[ \t]+/, '') === delim) { j = end; break; }
    if (nl < 0) return -1;
    j = nl + 1;
  }
  while (j < line.length && ' \t\r\n'.includes(line[j])) j++; // after the delimiter line: only whitespace, then ")"
  return line[j] === ')' ? j + 1 : -1;
}

// Replace each `$(cat <<'EOF' … EOF)` (a literal commit message, above) with empty text, so a `git commit` written
// the way Claude Code writes it reads as an ordinary command instead of an unreadable one. `$(git branch
// --show-current)` and `$(git rev-parse --abbrev-ref HEAD)`, exactly, name the branch the session stands on: as a whole
// word of `git push`, bare or in double quotes, after the remote and plain words only on the same line, each becomes
// `HEAD`, so the push is judged as `git push origin HEAD` is (a branch name holds no space or glob, so the bare form
// is one word too). Anywhere else (the program, part of a longer word, after a quote, a variable or a line break) it
// stays a substitution. Every other substitution and every unquoted heredoc is left, so it is still held.
function neutralizeSafeSubst(line) {
  if (line.indexOf('$(') < 0) return line;
  let out = '';
  for (let i = 0; i < line.length;) {
    if (line[i] === '$' && line[i + 1] === '(') {
      const m = /^\$\(\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD)\s*\)/.exec(line.slice(i));
      const p = m && /(?:^|[ \t;&|])git[ \t]+push((?:[ \t]+[A-Za-z0-9_.\/@+=,%:-]+)*)[ \t]+("?)$/.exec(line.slice(0, i));
      if (p && p[1].split(/[ \t]+/).some((w) => w && !w.startsWith('-'))) {
        let k = i + m[0].length;
        if (p[2] === '"' ? line[k++] === '"' : line[k] !== '"') {
          if (k >= line.length || ' \t\n;&|'.includes(line[k])) { out += 'HEAD'; i += m[0].length; continue; } // a whole word
        }
      }
      const end = matchCatHeredocSubst(line, i);
      if (end >= 0) { i = end; continue; } // dropped: its text is a literal message, left as empty
    }
    out += line[i++];
  }
  return out;
}

/**
 * The line as a list of commands, each a list of { word, quoted }: `word` is the text with quotes taken off and
 * adjacent segments joined (so a quoted or split name is one word: `"sudo"`, `su""do` and `s'u'do` are all `sudo`),
 * and `quoted` is true where any part of the word stood inside quotes (a candidate nested command to read deeper).
 * A top-level ; && || | newline or & ends a command. Returns null for anything the reader cannot read with
 * certainty: a quote that never closes, or a command substitution $( … ) or backtick (its value is any program).
 */
export function readCommands(line) {
  if (typeof line !== 'string' || line.length > LINE_MAX) return null;
  line = neutralizeSafeSubst(line);
  const commands = [];
  let cmd = [];
  let word = '';
  let quoted = false;
  let started = false; // a word is being built (even an empty quoted one, `""`)
  let inSq = false;
  let inDq = false;
  let varEnd = -1; // where this word's text after its last variable (bare or in double quotes) begins (-1: none)
  let varStart = -1; // where this word's first variable stands (-1: none)
  // A bare variable after text ends the token (below), so one shell word can be several tokens: `glue` says the
  // next token goes on the same shell word (it is marked `glued`), `chainHead` is where that word's first token
  // stands in the command.
  let glue = false;
  let chainHead = -1;
  let redirectNext = false; // the next word that starts is a redirection's target (a file name), not a program word
  const endWord = () => {
    // The word right after a redirection operator (`> file`, `< file`) is that redirection's target, not a program
    // and not a command head: it is marked `redirect` and read past by headOf and lead, so a program that stands
    // after it (`> out.txt sudo su`) is still read, and a quoted or variable target (`> "$LOG"`) is not taken for a
    // head that cannot be read.
    const redirTarget = started && redirectNext;
    // `varProg`: this word's program name is a variable, so which program it would run cannot be read. It holds when
    // a variable (bare or in double quotes) stands in the word and the word's text after that last variable has no
    // `/` — `$PROG`, `"$EDITOR"`, `${PROG}x`, `$PROG.sh`, `''"$EDITOR"`, `"$A"b` — but not when the name is written
    // out after the variable (`$VENV/bin/python`, `"${DIR}/bin/tool"`). A word judged the same with or without its
    // quotes. Whether the word is actually the program (so the command is held) or an argument (dropped) is decided
    // in walk, by whether the command's head lands on this token after lead steps assignments, redirections and the
    // passers. A redirection target is never a program, and an assignment is not one either.
    const varProg = !redirTarget && started && varEnd >= 0 && !word.slice(varEnd).includes('/') && !isAssignment(word);
    // What goes on behind a bare variable in an assignment's value or a redirection's target (`FOO=$A$B`,
    // `> out$N.txt`) is more of that value or target, not a word of its own: it is no program and no argument,
    // so the program that stands after it is still the one that is read.
    const more = glue ? cmd[chainHead] : null;
    const partOfBefore = !!more && (more.redirect === true || isAssignment(more.word));
    // `vars`: a variable stood inside this word (a push reads it: where it would go cannot be told).
    if (started && !partOfBefore) {
      const t = varEnd >= 0 ? { word, quoted, vars: true, varFirst: varStart, varLast: varEnd } : { word, quoted };
      if (varProg) t.varProg = true;
      if (glue) {
        t.glued = true;
        // The shell word this token goes on began with text and a bare variable (`x$PROG…`): its first token
        // was marked `varProg` there. Text with a `/` after the word's last variable writes the program's name
        // out (`x$DIR/bin/tool`), so the mark goes; without one the name is still a variable's value.
        const first = cmd[chainHead];
        if (first && first.varGlued && word.slice(varEnd >= 0 ? varEnd : 0).includes('/')) {
          delete first.varProg;
          delete first.varGlued;
        }
      }
      if (redirTarget) {
        t.redirect = true;
        redirectNext = false;
      }
      cmd.push(t);
    }
    word = '';
    quoted = false;
    started = false;
    varEnd = -1;
    varStart = -1;
    glue = false;
    chainHead = -1;
  };
  // Where each command stands in the line (`spans`, beside `commands`): the card shows the one that was held. A
  // variable standing as a command's head is carried on its own token (`varProg`), kept with the command, so headOf
  // and walk see which program would run cannot be read (held).
  const spans = [];
  let cmdStart = -1;
  const endCommand = (at = line.length) => {
    endWord();
    if (cmd.length) {
      commands.push(cmd);
      spans.push([cmdStart < 0 ? 0 : cmdStart, at]);
    }
    cmd = [];
    cmdStart = -1;
  };
  // A $-reference at i (line[i] === '$'): → { sub: true } for $( (held), else { next } the last index it consumes.
  const skipVar = (i) => {
    const n = line[i + 1];
    if (n === '(') return { sub: true };
    if (n === '{') {
      const e = line.indexOf('}', i + 2);
      return { next: e < 0 ? line.length - 1 : e };
    }
    let j = i + 1;
    if (j < line.length && '?$!#@*-'.includes(line[j])) return { next: j };
    while (j < line.length && (line[j] === '_' || (line[j] >= 'a' && line[j] <= 'z') || (line[j] >= 'A' && line[j] <= 'Z') || (line[j] >= '0' && line[j] <= '9'))) j++;
    return { next: j - 1 };
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    // A leading redirection operator (`> out`, `2> err`, `< in`) belongs to the command it feeds: its `<`/`>` start
    // the command's span, so a command that begins with a redirection (`> $LOG npm test`) is shown and re-read with
    // its operator, and its target is read as a target, not taken for a program when the span is walked on its own.
    if (cmdStart < 0 && !inSq && !inDq && !' \t;\n|&(){}'.includes(c)) cmdStart = i;
    if (inSq) {
      if (c === "'") inSq = false;
      else {
        word += c;
        started = true;
      }
      continue;
    }
    if (inDq) {
      if (c === '"') {
        inDq = false;
      } else if (c === '\\' && '"\\$`'.includes(line[i + 1] || '')) {
        word += line[++i];
        started = true;
      } else if (c === '`') {
        return null;
      } else if (c === '$') {
        const r = skipVar(i);
        if (r.sub) return null;
        if (varStart < 0) varStart = word.length;
        varEnd = word.length;
        started = true;
        i = r.next;
      } else {
        word += c;
        started = true;
      }
      continue;
    }
    // Outside quotes.
    if (c === "'") {
      inSq = true;
      quoted = true;
      started = true;
      continue;
    }
    if (c === '"') {
      inDq = true;
      quoted = true;
      started = true;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < line.length && line[i + 1] !== '\n') {
        word += line[++i];
        started = true;
      }
      continue;
    }
    if (c === '`') return null;
    if (c === '$') {
      const r = skipVar(i);
      if (r.sub) return null;
      // A bare variable that is a redirection's target (`> $LOG`) is no command head: consume it and read on, so a
      // program after it is still the head and the line is not held for a head that cannot be read.
      if (redirectNext && !started) {
        redirectNext = false;
        i = r.next;
        continue;
      }
      // A bare variable at the START of a word (no literal text built yet, only perhaps empty quotes): it may be the
      // program's name, bare or glued to text (`$PROG`, `${PROG}x`, `$PROG.sh`, `''$PROG`), so it is accumulated into
      // the word and endWord marks the word `varProg` when the text after it has no `/`. walk decides from the
      // command's head whether it is the program (held) or an argument (its `varProg` is then ignored). A path whose
      // program name is written out after the variable (`$VENV/bin/python`) still reads: its text holds a `/`.
      if (word === '') {
        if (varStart < 0) varStart = word.length;
        varEnd = word.length;
        started = true;
        i = r.next;
        continue;
      }
      // A bare variable AFTER literal text in the word (`foo$BAR`, an argument `--flag=$X`): its expansion may split
      // into several words, so it breaks the word, and where it stood is kept for a push to read (`varAfter`).
      // The shell word goes on behind the variable. As the program's word (`x$PROG`, `pre${CMD} arg`,
      // `./run-$TARGET.sh`) its name ends in a variable's value, so which program would run cannot be read: the
      // word's first token is marked `varProg`, as a word that begins with a variable is, until text with a `/`
      // after the last variable writes the name out (endWord). A redirection's target and an assignment are no
      // program. walk holds the command only when its head lands on that token; as an argument the mark is ignored.
      const goesOn = glue ? chainHead : -1;
      endWord();
      if (cmd.length) {
        cmd[cmd.length - 1].varAfter = true;
        chainHead = goesOn >= 0 ? goesOn : cmd.length - 1;
        const first = cmd[chainHead];
        if (!first.redirect && !isAssignment(first.word)) {
          first.varProg = true;
          first.varGlued = true;
        }
        glue = true;
      }
      i = r.next;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      endCommand(i);
      if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) i++;
      continue;
    }
    if (c === '<') {
      // A heredoc (<< or <<-, but not the <<< here-string): its body, which begins on the next line, is read line by
      // line as commands by this reader, so a word in the body (sudo, npm publish) would be taken for the act and
      // given a false reason. Until the body is parsed as a heredoc, the line cannot be read with certainty: held.
      if (line[i + 1] === '<' && line[i + 2] !== '<') return null;
      if (line[i + 1] === '<' && line[i + 2] === '<') i += 2; // <<< here-string: a word redirect, step over the operator
      // A redirection ends the WORD before it, but not the command: the word that follows is the redirection's
      // target, which stays in this command marked `redirect`, so the program before OR after it (`npm test < in`,
      // `< in sudo su`) is read and the target is not taken for a program. A leading fd number (`2< file`) is part
      // of the operator, not a program word, so it is discarded as it is for `>`.
      if (started && !quoted && /^[0-9]+$/.test(word)) {
        word = '';
        started = false;
      }
      endWord();
      redirectNext = true;
      continue;
    }
    if (c === '>') {
      // A redirection out (`>`, `>>`, `&>`): its target is a file name, not a program. A leading fd number
      // (`2>`, `1>`) is part of the operator, not a program word: discard it, or it becomes the command head and
      // hides the program behind it (`2> out.txt sudo su` would read `2` as the program and `sudo su` as its words).
      if (started && !quoted && /^[0-9]+$/.test(word)) {
        word = '';
        started = false;
      }
      endWord();
      redirectNext = true;
      continue;
    }
    if ('(){}'.includes(c)) {
      // A subshell or a group: end the command here.
      endCommand(i);
      continue;
    }
    word += c;
    started = true;
  }
  if (inSq || inDq) return null; // a quote that never closes
  endCommand();
  // Not enumerable: a list of commands as before, which also knows each command's place in the line it read, and
  // which of them have a bare variable for a head.
  Object.defineProperty(commands, 'spans', { value: spans });
  Object.defineProperty(commands, 'line', { value: line });
  return commands;
}

// The head program of a command and its positional words, after passers are stepped over. → { admin, head,
// positionals, nested: the quoted words that may be nested commands }.
function headOf(cmd, platform = process.platform) {
  const { k, admin, chdir, repoVar, texts, first, firstIndex, asksOnly, fed, ran, runner, name } = lead(cmd, false, platform);
  const head = k < cmd.length ? name || baseName(cmd[k].word, platform) : '';
  const args = cmd.slice(k + 1).filter((t) => !t.redirect); // a redirection target after the program is no argument
  // A bare variable standing alone as a whole argument word (`git push origin $BRANCH`) carries no readable word: it
  // is dropped from the argument list, as a bare variable was before it was carried on its own token, so a push's
  // refspec is read as it was. It still marks the command as holding a variable (hasVars, below). A quoted empty
  // variable (`"$BRANCH"`) keeps its empty word, as before, so a refspec written with one reads the same way.
  const rest = args.filter((t) => !(t.varProg && !t.quoted && t.word === ''));
  const positionals = rest.filter((t) => !isOption(t.word)).map((t) => (CASE_BLIND ? t.word.toLowerCase() : t.word));
  const nested = rest.filter((t) => t.quoted).map((t) => t.word);
  // A quoted word with a blank in it where the program should stand behind a passer is no program's name: it is a
  // text the passer was handed (`env -iS 'sudo su'`), read like the others.
  if (k < cmd.length && k > firstIndex && cmd[k].quoted && /\s/.test(cmd[k].word)) texts.push(cmd[k].word);
  // `hasVars`: a variable stands in the program's words or right after one of them (a push reads it: where it would go
  // cannot be told). `varTexts`: the quoted words that held a variable, whose value their nested command never shows.
  const hasVars = (k < cmd.length && (cmd[k].vars || cmd[k].varAfter)) || args.some((t) => t.vars || t.varAfter);
  const varTexts = rest.filter((t) => t.quoted && t.vars).map((t) => t.word);
  // The redirection targets of the command (`> project.json`), kept for the readers that need them (editsProjectJson).
  const redirects = cmd.filter((t) => t.redirect).map((t) => t.word);
  // `headVar`: the command's head (after lead stepped assignments, redirections, env, command and the passers) is a
  // word whose program name is a variable, so which program it would run cannot be read — walk holds it.
  const headVar = k < cmd.length && !!cmd[k].varProg;
  // `argTokens`: the words after the program as the reader made them (with where a variable stood), for the one
  // reader that needs to know which WORD held a variable (a gh or glab api call's address).
  return { platform, admin, head, headIndex: k, headVar, positionals, nested, rest: rest.map((t) => t.word), chdir, repoVar, texts, first, firstIndex, asksOnly, fed, ran, runner, hasVars, varTexts, redirects, argTokens: args };
}

// The ONE stepping of what stands before the program a command runs: leading assignments, the administrator programs
// (unless `stopAtAdmin`), env, `command`, flock and the other passers, each by its own words. A word is read as the
// program receives it, in quotes or not: `FOO="a b" sudo su` sets a variable and runs sudo, as it does without the
// quotes (a quoted value hid the program behind it). → where the program stands (`k`), whether an administrator
// program was stepped (`admin`), the folder and repository changes env made, the command texts the stepped words carry
// (`texts`), the first program word (`first`, at `firstIndex`), `asksOnly` for `command -v NAME`, which runs nothing,
// and `fed` where xargs was stepped (it hands the command more words than the line shows).
function lead(cmd, stopAtAdmin = false, platform = process.platform) {
  let k = 0;
  let admin = false;
  let chdir = false; // an env -C/--chdir before the command: it runs in another folder
  let repoVar = false; // a GIT_DIR-family assignment on the command (leading, or passed by env)
  let first = '';
  let firstIndex = -1;
  let asksOnly = false;
  let fed = false; // xargs was stepped: the command it runs gets more words than the line shows
  let ran = false; // a runner of two words was stepped (`uv run`): the net reads behind it, as behind a runner of one
  let runner = false; // any runner was stepped: what it fetches or loads cannot be told from the line
  let name = null; // the program's name where the word carries more (`npm@10`, python's `-mtwine`), at `nameAt`
  let nameAt = -1;
  const texts = [];
  for (;;) {
    // Leading redirection targets and assignments, in ANY order and number, are stepped over together to the program:
    // `x=1 2> err.txt sudo su`, `2> err.txt x=1 sudo su` and `x=1 > a 2> b y=2 sudo su` all reach sudo. Stepped in two
    // passes (targets, then assignments) a redirection target after an assignment was taken for the program head.
    while (k < cmd.length && (cmd[k].redirect || isAssignment(cmd[k].word))) {
      if (!cmd[k].redirect && GIT_REPO_VARS.has(assignName(cmd[k].word))) repoVar = true;
      k++;
    }
    if (k >= cmd.length) break;
    const b = k === nameAt && name ? name : baseName(cmd[k].word, platform);
    if (firstIndex < 0) {
      first = b;
      firstIndex = k;
    }
    if (ADMIN.has(b) || (platform === 'win32' && WIN_ADMIN.has(b))) {
      if (stopAtAdmin) break;
      admin = true;
      k = stepArgs(cmd, k + 1, b); // sudo/su/doas/pkexec pass the rest on; step to the command they run
      continue;
    }
    if (b === 'env') {
      const r = envStep(cmd, k + 1);
      chdir = chdir || r.chdir;
      repoVar = repoVar || r.repoVar;
      texts.push(...r.texts);
      k = r.next;
      continue;
    }
    if (b === 'command') {
      // `command -v NAME` / `-V` only prints where NAME is; it runs nothing (asking where a program is is not using
      // it), so the head stays `command` and no kind is read. `command NAME …` runs NAME, a passer like the others.
      let j = k + 1;
      while (j < cmd.length && isAssignment(cmd[j].word)) j++;
      const opts = [];
      while (j < cmd.length && isOption(cmd[j].word)) { opts.push(cmd[j].word); j++; }
      if (opts.some((o) => /^-[a-z]*v/i.test(o))) {
        asksOnly = true;
        break;
      }
      k = stepArgs(cmd, k + 1, 'command');
      continue;
    }
    if (b === 'flock') {
      const r = flockStep(cmd, k + 1);
      texts.push(...r.texts);
      k = r.next;
      continue;
    }
    if (PASSERS.has(b)) {
      if (b === 'xargs') fed = true;
      k = stepArgs(cmd, k + 1, b);
      continue;
    }
    // A package runner, an environment loader, a version manager's runner, `python -m <module>`: the command behind
    // it is read as it is without it. Its own words may point the command at another folder or repository.
    const run = runnerStep(cmd, k, b) || (PYTHON.test(b) ? pythonStep(cmd, k) : null);
    if (run) {
      if (!PYTHON.test(b)) {
        runner = true;
        if (!Object.hasOwn(RUN_ONE, b)) ran = true;
      }
      for (const t of cmd.slice(k + 1, run.next)) {
        if (isAssignment(t.word) && GIT_REPO_VARS.has(assignName(t.word))) repoVar = true;
        if (RUN_CHDIR.has(t.word) || [...RUN_CHDIR].some((o) => o.startsWith('--') && t.word.startsWith(`${o}=`))) chdir = true;
      }
      if (b === 'direnv' && k + 2 < run.next && !['.', './'].includes(cmd[k + 2].word)) chdir = true; // its first word is a folder
      texts.push(...run.texts);
      name = run.name;
      nameAt = run.next;
      k = run.next;
      continue;
    }
    break;
  }
  return { k, admin, chdir, repoVar, texts, first, firstIndex, asksOnly, fed, ran, runner, name: k === nameAt ? name : null };
}
// A runner's own options that run the command in another folder (`pnpm -C ../blog exec`, `uv run --directory x`).
const RUN_CHDIR = new Set(['-C', '--cd', '--dir', '--directory', '--cwd', '--prefix']);

/**
 * Step over the leading wrapper programs of ONE command (readCommands' list of { word, quoted }) to the index of the
 * escalator or program they run, STOPPING at the first escalator (sudo/su/doas/pkexec). The ONE reading of wrappers
 * the wall and the refusal list share: src/assistant/adminrefused.mjs imports this so the floor sees the same command
 * the wall sees, and a passer with a value or an argument (`nice -n 5 sudo …`, `flock /tmp/l sudo …`, `busybox
 * sudo …`) no longer hides the escalator from either. It is headOf's own stepping (lead), less the admin step.
 */
export function pastWrappers(cmd) {
  return lead(cmd, true).k;
}

// Does this command set a GIT_DIR-family variable for the rest of the line — as a bare assignment (GIT_DIR=… on its
// own) or through export/declare — so a later git push/merge lands in a repository the cwd does not name?
function setsRepoVar(info) {
  if (info.repoVar && !info.head) return true; // a bare `GIT_DIR=… ` with no command: it persists for the line
  if (EXPORTERS.has(info.head)) return info.rest.some((w) => GIT_REPO_VARS.has(assignName(w)));
  return false;
}

// A deploy/release/publish script the project names. The project's own file is someone else's words until
// the owner says so, so a named script is held whether or not anything was accepted: `npm|pnpm|yarn run deploy…`, the
// pnpm/yarn shorthand `pnpm deploy…`, `make deploy…`, and a script file whose name begins deploy/release/publish run
// directly (`./deploy.sh`, `bash scripts/release.sh`). A name begins with one of the words, so an unusually named
// deploy script is not caught — a known limit, noted in the document.
const DEPLOY_WORD = /^(?:deploy|release|publish)/i;
const DEPLOY_EXACT = /^(?:deploy|release|publish)$/i;
const DEPLOY_FILE = /^(?:deploy|release|publish)[\w.-]*\.(?:sh|bash|zsh|ksh|py|rb|js|mjs|cjs|ts|mts|cts|pl|php|rake)$/i;
// A word that names a script file to run: it holds a path separator, or its base name ends in a script extension.
// The interpreter runs the FIRST such word, so a word that looks like a script but is not a deploy script is the
// program the interpreter runs (`dist/server.js`, `bin/www`, `src/cli.mjs`), not a deploy.
const SCRIPT_EXT = /\.(?:sh|bash|zsh|ksh|py|rb|js|mjs|cjs|ts|mts|cts|pl|php|rake)$/i;
const looksLikeScript = (w) => typeof w === 'string' && (w.includes('/') || SCRIPT_EXT.test(w.slice(w.lastIndexOf('/') + 1)));
// A program that is a deploy script run directly: its name is exactly deploy/release/publish (a bare `deploy` or a
// path'd `scripts/deploy`, whose basename the reader keeps), or a deploy-named file with a script extension
// (`deploy.sh`, `release.py`). `release-notes` (a name that only begins with the word, no script extension) is not.
const isDeployFile = (w) => {
  if (typeof w !== 'string' || !w) return false;
  const b = w.slice(w.lastIndexOf('/') + 1);
  return DEPLOY_EXACT.test(b) || DEPLOY_FILE.test(b);
};
function deployKind({ head, positionals, rest = [] }) {
  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    const ri = positionals.indexOf('run');
    if (ri >= 0 && positionals[ri + 1] && DEPLOY_WORD.test(positionals[ri + 1])) return 'deploy';
    if ((head === 'pnpm' || head === 'yarn') && positionals[0] && positionals[0] !== 'run' && DEPLOY_WORD.test(positionals[0])) return 'deploy';
  }
  if (TASK_RUNNERS.has(head) && positionals.some((t) => DEPLOY_WORD.test(t))) return 'deploy';
  if (isDeployFile(head)) return 'deploy';
  if (SHELLS.has(head) && positionals.some(isDeployFile)) return 'deploy';
  if (interpretedDeploy(head, rest)) return 'deploy';
  return null;
}
// make and the task runners that run a task the project names, as make does (`rake release`, `just deploy`, `cap
// production deploy`, `fab deploy`).
const TASK_RUNNERS = new Set(['make', 'gmake', 'rake', 'just', 'cap', 'fab', 'invoke', 'mage']);
// A deploy script run by an interpreter is held as it is when a shell runs it (`python3 deploy.py`, `node
// scripts/release.mjs`, `deno run -A deploy.ts`), and a package script by its runner (`node --run deploy`, `bun run
// deploy`, `deno task deploy`). The interpreter's options that take the next word are stepped to the script; with a
// program text (`-e`, `-c`) it runs no script file. python's options are read from its usage text, perl's from its
// usage text and node's from its manual; the others are written as their documentation is known. A test file
// (`release.test.mjs`) run by an interpreter, and node's own test runner, run no deploy.
const INTERPRETERS = Object.freeze({
  node: { values: ['-r', '--require', '-C', '--conditions', '--import', '--loader', '--experimental-loader', '--env-file', '--input-type', '--watch-path', '--title', '--redirect-warnings', '--icu-data-dir', '--openssl-config', '--disable-warning', '--trace-event-categories', '--trace-event-file-pattern', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-shard', '--test-timeout'], texts: ['-e', '--eval', '-p', '--print'], run: '--run' },
  ruby: { values: ['-r', '-I', '-C', '-E', '--encoding'], texts: ['-e'] },
  perl: { values: ['-I'], texts: ['-e', '-E'] },
  php: { values: ['-c', '-d', '-z'], texts: ['-r', '-R', '-B', '-E'], file: '-f' },
  tsx: { values: ['--tsconfig', '--import', '--require', '-r'], texts: ['-e', '--eval', '-p', '--print'] },
  'ts-node': { values: ['-r', '--require', '-P', '--project', '-C', '--compiler', '-O', '--compiler-options', '-I', '--ignore', '--cwd'], texts: ['-e', '--eval', '-p', '--print'] },
  bun: { values: ['--cwd', '-r', '--preload', '--config', '-c', '--env-file'], texts: ['-e', '--eval', '-p', '--print'], sub: 'run' },
  deno: { values: ['-c', '--config', '--import-map', '--lock', '--cert', '--location', '--seed'], texts: [], subs: ['run', 'task'] },
});
const INTERPRETER_ALIAS = Object.freeze({ nodejs: 'node', 'ts-node-esm': 'ts-node', 'babel-node': 'node' });
// A test file by its base name: the `.test.`/`.spec.` form of most ecosystems, and pytest's own `_test.py` and
// `test_*.py` names. A test file run by an interpreter (`node release.test.mjs`, `python3 deploy_test.py`) runs the
// tests, not a deploy, even when its name begins deploy/release/publish, so it is not held as a deploy.
const isTestFile = (w) => {
  const b = typeof w === 'string' ? w.slice(w.lastIndexOf('/') + 1) : '';
  return /\.(?:test|spec)\.[^./]+$/i.test(b) || /_test\.py$/i.test(b) || /^test_.*\.py$/i.test(b);
};
// A script whose name's next part after deploy/release/publish is `note` or `notes` (`release-notes.mjs`,
// `release_notes.py`): it writes release notes as text, not a deployment, so an interpreter is not held for running
// it. `deploy-site.sh` (next part `site`) and a bare `release.mjs` keep their hold.
const isNotesFile = (w) => {
  const b = typeof w === 'string' ? w.slice(w.lastIndexOf('/') + 1) : '';
  return /^(?:deploy|release|publish)[-_]notes?(?![a-z0-9])/i.test(b);
};
function interpretedDeploy(head, rest) {
  const deployFile = (w) => isDeployFile(w) && !isTestFile(w) && !isNotesFile(w);
  if (PYTHON.test(head)) {
    const r = pythonArgs(rest);
    return typeof r.script === 'number' && deployFile(rest[r.script]);
  }
  const spec = INTERPRETERS[INTERPRETER_ALIAS[head] || head];
  if (!Object.hasOwn(INTERPRETERS, INTERPRETER_ALIAS[head] || head)) return false;
  let i = 0;
  let task = false; // the next word names a package script, not a file (node --run, bun run, deno task)
  if (spec.subs) { // deno: only `deno run <file>` and `deno task <name>` run a script here
    while (i < rest.length && isOption(rest[i])) i += 1;
    if (!spec.subs.includes(rest[i])) return false;
    task = rest[i] === 'task';
    i += 1;
  }
  for (; i < rest.length; i++) {
    const w = rest[i];
    if (w === '--') {
      i += 1;
      break;
    }
    if (spec.texts.includes(w) || spec.texts.some((o) => o.startsWith('--') && w.startsWith(`${o}=`))) return false;
    if (spec === INTERPRETERS.node && (w === '--test' || w.startsWith('--test='))) return false;
    if (spec.run && (w === spec.run || w.startsWith(`${spec.run}=`))) return DEPLOY_WORD.test(w === spec.run ? rest[i + 1] || '' : w.slice(spec.run.length + 1));
    if (spec.file && w === spec.file) return deployFile(rest[i + 1] || '');
    if (!isOption(w)) break;
    const knownEq = spec.values.some((o) => o.startsWith('--') && w.startsWith(`${o}=`)); // --require=x: takes no next word
    if (spec.values.includes(w)) i += 1; // a value option: its value is the next word
    else if (!knownEq) {
      // An option the spec does not know may take the next word as its value, or that word may be the script itself.
      // So test that word as the script and step over it as the option's possible value, however many unknown options
      // stand before the script (`node --inspect-port 9229 --trace-warnings scripts/release.mjs`). Only a word that
      // looks like a file — it holds a `/` or a deploy-named script extension — is held here; a bare `release`,
      // `deploy` or `publish` is as likely a flag's value or a build subcommand (`--mode release`, `--env publish`).
      const next = rest[i + 1];
      if (next !== undefined && !isOption(next)) {
        if (deployFile(next) && (next.includes('/') || DEPLOY_FILE.test(next.slice(next.lastIndexOf('/') + 1)))) return true;
        // A word that looks like a script but is not a deploy script is the program the interpreter runs; it runs
        // THAT, and a later bare `release`/`deploy`/`publish` is its argument, not a second script to run. So the
        // line is not a deploy (`node --inspect dist/server.js release`, `tsx --inspect src/index.ts deploy`). Only a
        // word that does not look like a script is stepped over as the unknown option's possible value.
        if (looksLikeScript(next)) return false;
        i += 1;
      }
    }
  }
  const script = rest[i] || '';
  if (spec.sub && script === spec.sub) {
    const next = rest.slice(i + 1).find((w) => !isOption(w)) || '';
    return deployFile(next) || (!next.includes('.') && DEPLOY_WORD.test(next));
  }
  return task ? DEPLOY_WORD.test(script) : deployFile(script);
}

// Mutating commands that could write a project's own project.json from the shell; a read (cat, grep) is not one.
const WRITERS = new Set(['mv', 'cp', 'ln', 'tee', 'dd', 'truncate', 'install', 'patch', 'sed']);
// Does a shell command edit a project.json (the session changing its project's own manifest)? A mutating head that
// names a project.json, or a redirection whose target is a project.json (readCommands marks a redirection target, so
// `> project.json` is read from the command's own redirects, not taken for a program).
function editsProjectJson(info) {
  const base = (w) => (typeof w === 'string' ? w.slice(w.lastIndexOf('/') + 1) : '');
  if ((info.redirects || []).some((w) => base(w) === 'project.json')) return true; // a redirection target `> project.json`
  return WRITERS.has(info.head) && info.positionals.some((w) => base(w) === 'project.json');
}

// systemd-run's own options (its --help), by long name: those that take a value (the next word, or after `=`) and
// those that take none. Its options end at the first word that is not one (it stops there, `+` in its getopt), and a
// long name may be shortened to any prefix that names one option only, as getopt_long allows.
const SDRUN_VALUE = ['host', 'machine', 'unit', 'property', 'description', 'slice', 'expand-environment', 'service-type', 'uid', 'gid', 'nice', 'working-directory', 'root-directory', 'setenv', 'json', 'job-mode', 'background', 'path-property', 'socket-property', 'on-active', 'on-boot', 'on-startup', 'on-unit-active', 'on-unit-inactive', 'on-calendar', 'timer-property'];
const SDRUN_FLAG = ['user', 'system', 'no-ask-password', 'scope', 'slice-inherit', 'no-block', 'remain-after-exit', 'wait', 'send-sighup', 'same-dir', 'same-root-dir', 'pty', 'pty-late', 'pipe', 'quiet', 'verbose', 'collect', 'shell', 'ignore-failure', 'no-pager', 'on-timezone-change', 'on-clock-change', 'help', 'version'];
const SDRUN_SHORT = { H: 'host', M: 'machine', u: 'unit', p: 'property', E: 'setenv', h: 'help', r: 'remain-after-exit', d: 'same-dir', R: 'same-root-dir', t: 'pty', T: 'pty-late', P: 'pipe', q: 'quiet', v: 'verbose', G: 'collect', S: 'shell' };
const sdrunName = (typed) => {
  const all = [...SDRUN_VALUE, ...SDRUN_FLAG];
  if (all.includes(typed)) return typed;
  const m = all.filter((n) => n.startsWith(typed));
  return typed && m.length === 1 ? m[0] : null;
};
// Does `systemd-run <rest>` run its command in the user's own service manager on this computer, and nowhere else?
// Only when its own options hold the word `--user` and none of `--system`, `-M`/`--machine` (a container or another
// user's manager, `-M root@`), `-H`/`--host` (another computer) or `--uid`/`--gid` (another user). An option it does
// not know is not read further: whether it takes a value cannot be told, so the line is not taken for the user's own
// manager. And a word that leaves it stands nowhere on the line, also after the command it runs (stricter than
// systemd-run itself, which hands those to the command).
const SDRUN_LEAVES = ['system', 'machine', 'host', 'uid', 'gid'];
const leavesAnywhere = (w) => ['--system', '-M', '-H', '--machine', '--host'].includes(w) || /^--(?:machine|host|uid|gid)=/.test(w) || /^-[MH]./.test(w);
function systemdRunOwn(rest) {
  if (rest.some(leavesAnywhere)) return false;
  const seen = new Set();
  let literalUser = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === '--' || !w.startsWith('-') || w === '-') break; // the command it runs
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = sdrunName(w.slice(2, eq < 0 ? undefined : eq));
      if (!name) return false;
      seen.add(name);
      if (w === '--user') literalUser = true;
      if (SDRUN_VALUE.includes(name) && eq < 0) i += 1;
      continue;
    }
    for (let j = 1; j < w.length; j++) {
      const name = SDRUN_SHORT[w[j]];
      if (!name) return false;
      seen.add(name);
      if (SDRUN_VALUE.includes(name)) {
        if (j === w.length - 1) i += 1; // its value is the next word; else the rest of this one
        break;
      }
    }
  }
  return literalUser && !SDRUN_LEAVES.some((n) => seen.has(n));
}

// More ways to publish or release, or to change what is already published (a version taken back or marked, a tag of
// the registry moved, an asset added), each by its own tool; and a call of GitHub's or GitLab's API that is not a
// plain read. → 'release', 'api-write' or null. Written as each tool's documentation is known (npm's own commands
// read from its documentation): the subcommand is a word of the line, wherever the tool's options put it.
const PUBLISHERS = new Set(['poetry', 'uv', 'bun', 'flit', 'hatch', 'pdm', 'rye', 'vsce', 'ovsx', 'lerna', 'changeset', 'deno', 'jsr']);
// The words of a tool's own command (its subcommand first), past its options: an option here takes the next word.
const TOOL_VALUES = new Set(['-C', '--directory', '--project', '-P', '-w', '--workspace', '--prefix', '--cwd', '-R', '--repo', '--registry', '--otp', '-u', '--username', '-p', '--password', '--token', '-t', '--tag', '-r', '--repository', '--index', '--publish-url', '--config-file', '--cache-dir', '-pl', '--projects', '-f', '--file', '-s', '--settings']);
function toolWords(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (isOption(w)) {
      if (TOOL_VALUES.has(w)) i += 1;
      continue;
    }
    out.push(CASE_BLIND ? w.toLowerCase() : w);
  }
  return out;
}
// Does a word name the GraphQL endpoint of `gh`/`glab api`? The bare word `graphql`, or the same reached as a path
// (`/graphql`) or a full URL (`https://api.github.com/graphql`): its scheme and host are dropped and its leading
// slashes stripped, and `api/graphql` (glab's own spelling) counts too.
const isGraphqlEndpoint = (w) => {
  if (typeof w !== 'string' || !w) return false;
  const s = w.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').replace(/^\/+/, '').toLowerCase();
  return s === 'graphql' || s === 'api/graphql';
};
// A gh or glab api call whose address is written with a variable: could its value make the address the GraphQL
// one? `tokens`: the words after the program as the reader made them. The address is the first word behind `api`
// that is neither an option nor an option's value. Of that word only the text before its first variable and after
// its last one is known: it could be the GraphQL address when that text leaves room for it (`$EP`, `"$BASE/graphql"`,
// `api$REST`, `"https://$HOST/graphql"`), and it could not when the text names another path (`repos/$OWNER/$REPO/issues`,
// `search/$KIND`). A word without a variable is not asked here (isGraphqlEndpoint reads it).
const API_VALUE_LONG = new Set(['--field', '--raw-field', '--header', '--method', '--jq', '--template', '--preview', '--hostname', '--cache', '--input']);
function apiAddressMayBeGraphql(tokens) {
  const end = (at) => { let j = at + 1; while (j < tokens.length && tokens[j].glued) j++; return j; }; // behind one shell word
  const holdsVar = (t) => !!(t.vars || t.varAfter);
  let seenApi = false;
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i];
    const next = end(i);
    const wordHasVar = tokens.slice(i, next).some(holdsVar);
    if (isOption(t.word)) {
      let takes = false; // does this option take the next word as its value?
      if (!wordHasVar) {
        if (!seenApi) takes = TOOL_VALUES.has(t.word);
        else if (t.word.startsWith('--')) takes = API_VALUE_LONG.has(t.word);
        else for (let c = 1; c < t.word.length; c++) if ('fFXHpqt'.includes(t.word[c])) { takes = c + 1 === t.word.length; break; }
      }
      i = takes && next < tokens.length ? end(next) : next;
      continue;
    }
    if (!seenApi) {
      if (t.word !== 'api' || wordHasVar) return false;
      seenApi = true;
      i = next;
      continue;
    }
    if (!wordHasVar) return false; // the address is written out
    const last = tokens[next - 1];
    const before = (t.vars ? t.word.slice(0, t.varFirst) : t.word).toLowerCase(); // t holds a variable, or one follows it
    const after = (last.varAfter ? '' : last.vars ? last.word.slice(last.varLast) : last.word).toLowerCase();
    const tailFits = after.length >= 'graphql'.length ? after === 'graphql' || after.endsWith('/graphql') : 'graphql'.endsWith(after);
    const path = before.replace(/^\/+/, '');
    const headFits = /^[a-z][a-z0-9+.-]*:/.test(before) || 'graphql'.startsWith(path) || 'api/graphql'.startsWith(path);
    return tailFits && headFits;
  }
  return false;
}
// Does a gh or glab api call send a field or a body (-f, -F, --field, --raw-field, --input)?
function apiSendsField(rest) {
  return rest.some((w) => {
    if (['--field', '--raw-field', '--input'].some((o) => w === o || w.startsWith(`${o}=`))) return true;
    if (!/^-[^-]/.test(w)) return false;
    for (let c = 1; c < w.length; c++) {
      if (w[c] === 'f' || w[c] === 'F') return true;
      if ('XHpqt'.includes(w[c])) return false;
    }
    return false;
  });
}
function releaseKind(head, rest, argTokens = null) {
  const s = toolWords(rest);
  const [a, b] = s;
  if (head === 'gh' && a === 'release' && ['upload', 'edit', 'delete', 'delete-asset'].includes(b)) return 'release';
  if (head === 'glab' && a === 'release' && ['create', 'upload', 'update', 'delete'].includes(b)) return 'release';
  if (head === 'npm' && (['unpublish', 'deprecate', 'undeprecate'].includes(a) || (['dist-tag', 'dist-tags'].includes(a) && ['add', 'rm'].includes(b)))) return 'release';
  if (PUBLISHERS.has(head) && a === 'publish') return 'release';
  if ((head === 'dart' || head === 'flutter') && a === 'pub' && ['publish', 'lish'].includes(b)) return 'release';
  if (head === 'pod' && a === 'trunk' && b === 'push') return 'release';
  if (head === 'mix' && ['hex.publish', 'hex.retire'].includes(a)) return 'release';
  if ((head === 'dotnet' && a === 'nuget' && b === 'push') || (head === 'nuget' && a === 'push')) return 'release';
  if (head === 'helm' && ['push', 'cm-push'].includes(a)) return 'release';
  if ((head === 'cargo' || head === 'gem') && s.find((w) => !w.startsWith('+')) === 'yank') return 'release';
  if (head === 'semantic-release' || head === 'release-it' || (head === 'goreleaser' && a === 'release')) return 'release';
  if (['docker', 'podman', 'nerdctl'].includes(head) && (a === 'build' || (a === 'buildx' && ['build', 'bake'].includes(b))) && rest.some((w) => w === '--push' || /type=registry/.test(w))) return 'release';
  if (/^mvnw?$/.test(head) && s.some((t) => t === 'deploy' || t.startsWith('deploy:') || /^release:(?:perform|prepare)$/.test(t))) return 'release';
  if (/^gradlew?(?:\.bat)?$/.test(head)) {
    const tasks = rest.filter((w, n) => !isOption(w) && !['-x', '--exclude-task'].includes(rest[n - 1]));
    if (tasks.some((t) => { const n = t.slice(t.lastIndexOf(':') + 1); return n.startsWith('publish') && !/ToMavenLocal$/.test(n); })) return 'release';
  }
  // gh and glab always POST the GraphQL endpoint, and a query and a mutation differ only in the request body, not
  // the HTTP method, so a named `-X GET` cannot be trusted to mean a read there: the call is held whenever a word of
  // it names that endpoint, whatever method is named and wherever the endpoint stands (`gh api -X GET graphql -f
  // query=…`, `gh api -X GET /graphql …`, a full `https://api.github.com/graphql`). A plain REST read with GET still
  // goes through.
  if ((head === 'gh' || head === 'glab') && a === 'api' && (rest.some(isGraphqlEndpoint) || apiWrites(rest))) return 'api-write';
  // The same when the address is a variable whose value may be that endpoint and the call sends a field: a named
  // GET does not make it a read there. A plain read with a variable in its path, and a call whose written text
  // names another path, still go through.
  if ((head === 'gh' || head === 'glab') && a === 'api' && argTokens && apiSendsField(rest) && apiAddressMayBeGraphql(argTokens)) return 'api-write';
  return null;
}
// Is a `gh api` / `glab api` call a write? An input (`--input`, a request body read from a file) always is. A method
// named other than GET or HEAD (-X, --method) is a write; GET and HEAD only read, and their fields (-f, -F, --field,
// --raw-field) are query parameters, not a body, so a field with GET/HEAD named is not a write. With no method named,
// a field makes the call a POST (gh's own default when a field is sent), so it is a write. A method the line does not
// name plainly is read as none. Short options may stand together; -H, -p, -q and -t take a value.
function apiWrites(rest) {
  let method = null; // the method named by -X / --method, if any
  let hasField = false; // -f / -F / --field / --raw-field: a field sent with the call
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (['--input'].some((o) => w === o || w.startsWith(`${o}=`))) return true;
    if (['--field', '--raw-field'].some((o) => w === o || w.startsWith(`${o}=`))) hasField = true;
    else if (w === '--method') method = rest[i + 1] || '';
    else if (w.startsWith('--method=')) method = w.slice('--method='.length);
    else if (/^-[^-]/.test(w)) {
      for (let c = 1; c < w.length; c++) {
        const ch = w[c];
        if (ch === 'f' || ch === 'F') { hasField = true; break; }
        if (ch === 'X') {
          method = c + 1 < w.length ? w.slice(c + 1) : rest[i + 1] || '';
          break;
        }
        if ('Hpqt'.includes(ch)) break;
      }
    }
  }
  const m = method === null ? null : method.toUpperCase();
  if (m !== null) return m !== 'GET' && m !== 'HEAD'; // a named method decides: GET/HEAD read, the rest write
  return hasField; // no method named: a field makes it a POST
}

// Does a command (not its nested texts) name one of the kinds here? → kind name or null.
function kindOfCommand({ admin, head, positionals, rest = [], argTokens = null, platform = process.platform }) {
  if (admin || ADMIN.has(head)) return 'admin';
  // PowerShell's Start-Process with the verb RunAs asks Windows for administrator rights.
  // (`saps` and `start` are its short names; the verb may be joined on with a colon, `-Verb:RunAs`.)
  if (platform === 'win32' && WIN_START_PROCESS.has(head) && rest.some((w, i) => {
    const m = PS_VERB.exec(w);
    return !!m && /^runas$/i.test(m[1] || rest[i + 1] || '');
  })) return 'admin';
  const has = (w) => positionals.includes(w);
  // Two more doors to administrator rights, which ask the system's own authority instead of sudo: a shell or a login
  // in a machine as another user, and a program run by the system's service manager (not the user's own, `--user`,
  // read by systemdRunOwn: `--user --system` and `--user -M root@` reach the system's or root's own manager).
  if (head === 'machinectl' && (has('shell') || has('login'))) return 'admin';
  if (head === 'systemd-run' && !systemdRunOwn(rest)) return 'admin';
  if ((head === 'npm' || head === 'pnpm' || head === 'yarn') && has('publish')) return 'release';
  if (head === 'cargo' && has('publish')) return 'release';
  if (head === 'twine' && has('upload')) return 'release';
  if (head === 'gem' && has('push')) return 'release';
  if ((head === 'docker' || head === 'podman' || head === 'nerdctl') && has('push')) return 'release';
  if (head === 'gh' && has('release') && has('create')) return 'release';
  const rk = releaseKind(head, rest, argTokens);
  if (rk) return rk;
  if (head === 'gh' && has('pr') && (has('create') || has('merge'))) return 'pr';
  if (head === 'glab' && has('mr') && (has('create') || has('merge'))) return 'pr';
  return null;
}

const UNREADABLE = 'unreadable';

// The commands a find line runs through -exec/-execdir/-ok/-okdir, each from just after the action word up to its
// `;` or `+` terminator (find's `{}` placeholder for the matched file is left as a positional word). A find line with
// no such action yields none. So an administrator program a find runs (`find . -exec sudo su ;`) is read, not hidden.
function findExecCmds(cmd) {
  const subs = [];
  for (let i = 0; i < cmd.length; i++) {
    if (!cmd[i].quoted && /^-(?:exec|execdir|ok|okdir)$/.test(cmd[i].word)) {
      const words = [];
      let k = i + 1;
      for (; k < cmd.length && !(!cmd[k].quoted && (cmd[k].word === ';' || cmd[k].word === '+')); k++) words.push(cmd[k]);
      if (words.length) subs.push(words);
      i = k;
    }
  }
  return subs;
}

// Walk the commands on a line, and for a shell with -c or a program that takes a command to run, one level into its
// quoted arguments. `visit(info, net)` is called for each command (headOf); the first truthy result is returned, else
// null, or 'unreadable' when the line cannot be read with certainty. `found`: given at the top, it gets the text of the
// top-level command the result came from (`part`), for the card; a nested hit names the command it is nested in.
// `net` is true where the command was not reached by stepping a passer's own words but found by the net (below).
function walk(line, visit, depth = 0, found = null, platform = process.platform) {
  const commands = readCommands(line);
  if (commands === null) {
    if (found) found.part = line;
    return UNREADABLE;
  }
  const at = (j) => {
    if (found) found.part = commands.line.slice(...commands.spans[j]).trim();
  };
  // What a command runs beside itself, one level in: the words a watch or a find hands on as a command, and the
  // command texts it carries (a shell's -c, a program that takes a command to run, flock's -c, env's -S).
  const win = platform === 'win32';
  // `seen`: the command texts already walked for this command, so a text is read once however many `cmd /c` stand
  // before it (each is a step further in, and read again at each it would cost the product of them all).
  const inside = (cmd, info, net, seen = new Set(), hops = 0) => {
    // A wrapper that runs the rest of its words as a command (`watch sudo su`), or a per-match command (`find …
    // -exec sudo su ;`): an administrator program behind it was invisible, so read it as the wall reads any command,
    // one level in. watch's quoted-string form (`watch 'sudo su'`) is read through `nested` below instead.
    const subs = []; // the words a program hands on as a command
    const texts = []; // a quoted word that IS the command a program runs
    // On Windows: what cmd, PowerShell, start or call run. A quoted word with a blank in it where the command begins
    // is the command's text (read as a text, never as one program's name); cmd knows no single quote, so its text is
    // read without them; a `@` before a cmd command only hides its echo.
    // A slice is read once for a command in each of its two readings (as cmd reads it, and as any other program
    // does), however many ways lead to it: the word it begins at is remembered.
    const runs = (sub, ofCmd, at = sub[0]) => {
      const memo = ofCmd ? (seen.ofCmd ??= new Set()) : seen;
      if (!sub.length || memo.has(at)) return;
      memo.add(at);
      const first = sub[0];
      if (first.quoted && /\s/.test(first.word)) {
        // (cmd also takes a caret away before it reads a word: `"g^sudo whoami"` runs gsudo.)
        texts.push(ofCmd ? first.word.replace(/'/g, '').replace(/\^(.)/g, '$1').replace(/(^|[&|(]\s*)@(?=\S)/g, '$1') : first.word);
        // A quoted path to a program in a folder whose name holds a blank (`"C:\Program Files\gsudo\Current\gsudo.exe"
        // whoami`) is that program: read as the slice too, so its name is seen.
        // Only where its last part is a program by its ending, or one that asks for administrator rights or runs a
        // command text: a text that merely ends in a folder (`"./build.ps1; Get-ChildItem bin/Release"`) names none.
        const last = first.word.split(/[\\/]/).pop();
        if (/^(?:[a-z]:[\\/]|[\\/.])/i.test(first.word) && !/\s/.test(last)
          && (WIN_PROGRAM_END.test(last) || [...ADMIN, ...WIN_ADMIN, 'cmd', ...WIN_SHELLS].includes(baseName(last, platform)))) subs.push(sub);
      } else subs.push(ofCmd && !first.quoted && /^@./.test(first.word) ? [{ ...first, word: first.word.slice(1) }, ...sub.slice(1)] : sub);
    };
    let psAt = -1;
    if (info.head === 'watch') subs.push(...[cmd.slice(stepArgs(cmd, info.headIndex + 1, 'watch'))].filter((s) => s.length));
    else if (info.head === 'find') subs.push(...findExecCmds(cmd));
    else if (win && info.head === 'cmd') {
      // `cmd /c …` and `cmd /k …` run the words after the switch as a command (`cmd /c sudo whoami`).
      const at = cmd.findIndex((t, i) => i > info.headIndex && CMD_RUNS.test(t.word));
      if (at >= 0) {
        const joined = CMD_RUNS.exec(cmd[at].word)[1];
        runs(joined ? [{ ...cmd[at], word: joined, quoted: cmd[at].quoted || /\s/.test(joined) }, ...cmd.slice(at + 1)] : cmd.slice(at + 1), true, joined ? cmd[at] : cmd[at + 1]);
      }
    } else if (win && WIN_SHELLS.has(info.head)) {
      // PowerShell runs the words after `-c` / `-Command` the same way when they are not one quoted text
      // (`powershell -c Start-Process cmd -Verb RunAs`); the shell takes the quotes of a quoted switch away. With
      // neither that nor `-File`, the first word left after its switches is what it runs (`powershell gsudo whoami`,
      // `powershell -ExecutionPolicy Bypass -NoProfile "gsudo whoami"`): a switch that takes no value is one word, a
      // switch known to take one is two (its value is never read as a program), and behind a switch this reader
      // does not know the next word is read both ways, as its value and as the command. Only PowerShell's own
      // switches are read so: from the first word that begins the command on, a `-c` or a `/c` is that command's.
      let k = info.headIndex + 1;
      let file = false;
      while (k < cmd.length) {
        const w = cmd[k].word;
        if (cmd[k].redirect) k++;
        else if (!PS_SWITCH.test(w)) break;
        else if (PS_ENCODED.test(w)) {
          const text = psDecoded(k + 1 < cmd.length ? cmd[k + 1].word : null);
          if (text === null) return UNREADABLE; // a hidden command that cannot be read: held
          texts.push(text);
          file = true; // nothing else of the line is its command
          break;
        } else if (PS_COMMAND.test(w)) {
          psAt = k;
          break;
        } else if (PS_FILE.test(w)) {
          file = true;
          break;
        } else if (PS_BARE.test(w)) k++;
        else if (PS_VALUE.test(w)) k += 2;
        else {
          k++;
          if (k < cmd.length && !cmd[k].redirect && !PS_SWITCH.test(cmd[k].word)) runs(cmd.slice(k++), false);
        }
      }
      const joined = psAt >= 0 ? PS_COMMAND.exec(cmd[psAt].word)[1] : '';
      if (joined) runs([{ ...cmd[psAt], word: joined, quoted: cmd[psAt].quoted || /\s/.test(joined) }, ...cmd.slice(psAt + 1)], false, cmd[psAt]);
      else if (psAt >= 0) runs(cmd.slice(psAt + 1), false);
      else if (!file) runs(cmd.slice(k), false);
    } else if (win && (info.head === 'start' || info.head === 'call')) {
      // cmd's `start ["title"] [/switches] program …` and `call program …` run the program they name.
      let k = info.headIndex + 1;
      if (info.head === 'start' && k < cmd.length && cmd[k].quoted) k++;
      while (k < cmd.length && !cmd[k].quoted && /^\/[a-z]/i.test(cmd[k].word)) k += /^\/d$/i.test(cmd[k].word) ? 2 : 1;
      const target = k < cmd.length ? cmd[k].word : '';
      // (A bare `Release`, `deploy` or `publish` after start is a folder of that name it opens, not a program.)
      const program = !/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && ((!/[\\/]/.test(target) && !/^(?:deploy|release|publish)$/i.test(target)) || WIN_PROGRAM_END.test(target)
        || [...ADMIN, ...WIN_ADMIN, 'cmd', ...WIN_SHELLS].includes(baseName(target, platform)));
      if (info.head === 'call' || program) runs(cmd.slice(k), true);
    }
    for (const sub of subs) {
      const subInfo = headOf(sub, platform);
      const sr = visit(subInfo, net);
      if (sr) return sr;
      // On Windows what such a program runs may itself carry a command (`cmd /c cmd /c gsudo whoami`, `cmd /c
      // powershell -c "gsudo whoami"`, `find . -exec cmd /c gsudo whoami ;`): read further in, as the line's own
      // commands are. Each step is a shorter slice, so it ends; a chain longer than any real line is not read.
      if (win) {
        if (hops >= 64) return UNREADABLE;
        const deeper = inside(sub, subInfo, net, seen, hops + 1);
        if (deeper) return deeper;
      }
    }
    const takesInner = SHELLS.has(info.head) ? cmd.some((t) => isOption(t.word) && !t.word.startsWith('--') && t.word.includes('c'))
      : win && WIN_SHELLS.has(info.head) ? psAt >= 0
        : TAKES_COMMAND.has(info.head) || (win && WIN_TAKES_COMMAND.has(info.head));
    for (const text of new Set([...texts, ...(takesInner ? info.nested : []), ...info.texts])) {
      if (seen.has(text)) continue;
      seen.add(text);
      // A text that held a variable in double quotes reaches its command with the value filled in, which the line
      // never shows (`sh -c "git push origin $B"`): every command read in it is marked as holding a variable.
      const marked = Array.isArray(info.varTexts) && info.varTexts.includes(text);
      const inner = walk(text, marked ? (i, n) => visit({ ...i, hasVars: true }, n) : visit, depth + 1, null, platform);
      if (inner) return inner;
    }
    return null;
  };
  for (const [j, cmd] of commands.entries()) {
    const info = headOf(cmd, platform);
    const r = visit(info, false);
    if (r) {
      at(j);
      return r;
    }
    if (info.headVar) { // the head is a variable: which program would run cannot be read, so held
      at(j);
      return UNREADABLE;
    }
    if (depth >= 4) continue; // a nesting deeper than any real command line: do not recurse for ever
    const deep = inside(cmd, info, false);
    if (deep) {
      at(j);
      return deep;
    }
    // The net. A program that runs its own words as a command has options this reader may not know, so the program
    // behind it can stand further on than the stepping reached (`taskset -c 0,1 sudo su`, `strace -o out git push
    // origin main`, `screen -dm sudo su`, `ssh host sudo reboot`). Every later word where a command of the owner's
    // kinds can begin is read as that command. An administrator program found only this way is one Hoprig could not
    // place with certainty: bashHeldActs marks it `unsure`, and no level lifts it.
    // Not where the program the stepping reached only reads or prints its words: there a later `sudo` is a word it
    // is given, not a program (`timeout 30 grep -rn sudo docs`, `xargs grep -l sudo`, `time echo sudo`).
    if (info.asksOnly || info.firstIndex < 0 || !(runsItsWords(info.first) || info.ran) || PURE_READERS.has(info.head)) continue;
    for (let i = info.firstIndex + 1; i < cmd.length; i++) {
      // (On Windows its own escalators and the programs that run a command text count too: `ssh box gsudo whoami`.)
      const b = baseName(cmd[i].word, platform);
      if (i === info.headIndex || !(NET_HEADS.has(b) || (platform === 'win32' && (WIN_ADMIN.has(b) || b === 'cmd' || WIN_SHELLS.has(b))))) continue;
      const sub = cmd.slice(i);
      const sinfo = headOf(sub, platform);
      const nr = visit(sinfo, true) || inside(sub, sinfo, true);
      if (nr) {
        at(j);
        return nr;
      }
    }
  }
  return null;
}

/**
 * Which kind of the owner's-alone acts that need no context a shell line names (admin, release, pr), or null for an
 * ordinary line, or 'unreadable' for a line that cannot be read with certainty. The kinds that need the repository
 * or the folder (push, merge into the default branch) are decided by wallHeld, which has that context.
 */
export function wallKind(line) {
  return walk(line, (info) => kindOfCommand(info));
}

// git itself, asked locally (git -C cwd): the queries here read refs and config only — they contact no remote. On a
// failure or where git is not there, null, which the readers above turn into "held" (the default branch is not known).
function realGit(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? String(r.stdout).trim() : null;
  } catch {
    return null;
  }
}

// The git subcommand after its global options. -C, --git-dir and --work-tree point the command at another repository,
// which cwd cannot vouch for (`repoElsewhere`). → { name, args, repoElsewhere } or null.
function gitSubcommand(rest) {
  const VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
  let i = 0;
  let repoElsewhere = false;
  while (i < rest.length && rest[i].startsWith('-')) {
    const w = rest[i];
    if (w === '-C' || w === '--git-dir' || w === '--work-tree' || w.startsWith('--git-dir=') || w.startsWith('--work-tree=')) repoElsewhere = true;
    i += VALUE.has(w) ? 2 : 1;
  }
  return i < rest.length ? { name: rest[i], args: rest.slice(i + 1), repoElsewhere } : null;
}

// The remote's default branch at cwd (refs/remotes/<remote>/HEAD → its short name), or null when it is not known.
function defaultBranch(cwd, remote, git) {
  const ref = cwd ? git(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote || 'origin'}/HEAD`]) : null;
  return ref ? ref.replace(/^[^/]+\//, '') : null;
}

// git push's own options (`git push -h`), each written out in full as `--name` (a value after `=` kept), the way git
// reads them: a long name shortened to a prefix that names one option only (`--del`, `--pru`), and one-letter options
// written together (`-ud`, `-uf`; `-o` takes the rest of its word). A `--no-…` form only turns one off and is left
// out; an option git would refuse is kept as it was written.
const PUSH_LONG = ['verbose', 'quiet', 'repo', 'all', 'branches', 'mirror', 'delete', 'tags', 'dry-run', 'porcelain', 'force', 'force-with-lease', 'force-if-includes', 'recurse-submodules', 'thin', 'receive-pack', 'exec', 'set-upstream', 'progress', 'prune', 'verify', 'follow-tags', 'signed', 'atomic', 'push-option', 'ipv4', 'ipv6'];
const PUSH_SHORT = { v: 'verbose', q: 'quiet', d: 'delete', n: 'dry-run', f: 'force', u: 'set-upstream', o: 'push-option', 4: 'ipv4', 6: 'ipv6' };
function pushOptions(opts) {
  const out = [];
  for (const o of opts) {
    if (o.startsWith('--')) {
      const eq = o.indexOf('=');
      const typed = o.slice(2, eq < 0 ? undefined : eq);
      if (typed.startsWith('no-')) continue;
      const hits = PUSH_LONG.includes(typed) ? [typed] : PUSH_LONG.filter((n) => typed && n.startsWith(typed));
      out.push(hits.length === 1 ? `--${hits[0]}${eq < 0 ? '' : o.slice(eq)}` : o);
      continue;
    }
    for (const c of o.slice(1)) {
      if (!PUSH_SHORT[c]) break;
      out.push(`--${PUSH_SHORT[c]}`);
      if (c === 'o') break; // the rest of the word is its value
    }
  }
  return out;
}

// Would `git push <args>` move a default branch or a tag, or delete remote branches? Asked of git, never read from the
// words. → a reason id ('push', 'push-prune') or null. Held outright for --tags/--all/--mirror and a forced push;
// --prune deletes the remote branches not pushed (its own reason); else the default branch and the current branch are
// asked of git.
function pushHeld(cwd, args, git) {
  const g = (a) => (cwd ? git(cwd, a) : null);
  const opts = pushOptions(args.filter((a) => a.startsWith('-')));
  // A pruning push deletes the remote branches yours does not have; --delete/-d, or a refspec with nothing before its
  // colon (`:feature`), deletes the branch it names. No default branch need move for either: held as a delete.
  if (opts.includes('--prune') || opts.includes('--delete') || args.some((a) => a.length > 1 && a.startsWith(':'))) return 'push-prune';
  if (opts.some((o) => ['--tags', '--follow-tags', '--all', '--branches', '--mirror'].includes(o))) return 'push';
  if (opts.some((o) => o === '-f' || o === '--force' || o.startsWith('--force-with-lease') || o.startsWith('--force-if-includes'))) return 'push';
  const positionals = args.filter((a) => !a.startsWith('-'));
  const def = defaultBranch(cwd, positionals[0] || null, git);
  if (!def) return 'push-nodefault'; // the default branch cannot be known: held, with words that say so
  const refspecs = positionals.slice(1);
  if (refspecs.length) {
    return refspecs.some((r) => {
      if (r.startsWith('+')) return true; // a forced refspec
      if (r === ':') return true; // the matching push: every branch both sides have, the default branch too
      if (/(^|:)refs\/tags\//.test(r)) return true;
      const [src, dst] = r.includes(':') ? r.split(':') : [r, r];
      // HEAD (or `@`) names the branch the session stands on: on the default branch it moves the default branch.
      const name = dst.replace(/^refs\/heads\//, '');
      const to = name === 'HEAD' || name === '@' ? g(['symbolic-ref', '--short', 'HEAD']) : name;
      if (to === null || to === def) return true;
      return !r.includes(':') && !!g(['rev-parse', '--verify', `refs/tags/${src.replace(/^refs\/tags\//, '')}`]); // a tag by that name
    }) ? 'push' : null;
  }
  const cur = g(['symbolic-ref', '--short', 'HEAD']); // no refspec: the current branch goes to its upstream
  return cur === null || cur === def ? 'push' : null;
}

// Is a merge or a rebase landing on the default branch (the working copy stands on it)? Asked of git.
function mergeHeld(cwd, git) {
  const cur = cwd ? git(cwd, ['symbolic-ref', '--short', 'HEAD']) : null;
  if (cur === null) return true;
  const ref = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const def = ref ? ref.replace(/^[^/]+\//, '') : cur === 'main' || cur === 'master' ? cur : null;
  return def !== null && cur === def;
}

// A git command that is the owner's alone, with the repository's context. → 'push' | 'merge' | null.
// `dirChanged`: a cd/pushd (or any directory change) ran earlier on the same line, so the folder the command lands in
// is not the event's cwd and the wall cannot read which repository it moves: a push/merge/rebase is then held.
function gitKind(info, cwd, git, dirChanged = false) {
  if (info.head !== 'git') return null;
  const sub = gitSubcommand(info.rest);
  if (!sub) return null;
  const moves = sub.name === 'push' ? 'push' : sub.name === 'merge' || sub.name === 'rebase' ? 'merge' : null;
  if (!moves) return null;
  // git -C/--git-dir/--work-tree, env -C/--chdir, a GIT_DIR-family variable on the command, or a cd/pushd earlier on
  // the line all point the command at a repository the event's cwd does not name: the wall cannot read which branch
  // it would move, so it is held with that reason.
  if (sub.repoElsewhere || dirChanged || info.chdir || info.repoVar) return moves === 'push' ? 'push-elsewhere' : 'merge-elsewhere';
  if (sub.name !== 'push') return mergeHeld(cwd, git) ? 'merge' : null;
  // A variable in the push's words (its remote, its refspec: `git push origin $BRANCH`, `HEAD:$B`, `"$R"`) is filled
  // in only when the line runs, so where the push goes cannot be told: held as a push Hoprig cannot place, unless the
  // words that can be read already hold it for a reason of their own.
  // The variable is then the reason also where no default branch is known: telling Hoprig the default would not free it.
  const r = pushHeld(cwd, sub.args, git);
  if (!info.hasVars) return r;
  if (r === null || r === 'push-nodefault') return 'push-elsewhere';
  // A refspec read as `:branch` may be a dropped variable before its colon (`$B:feature`): whether it deletes is the
  // variable's, so the variable is the reason; a delete written as an option stays a delete.
  const deletes = pushOptions(sub.args.filter((a) => a.startsWith('-'))).some((o) => o === '--prune' || o === '--delete');
  return r === 'push-prune' && !deletes ? 'push-elsewhere' : r;
}

/**
 * Is a tool call held at the act (the owner's alone)? `tool`/`input` are the coding tool's own (the hook event);
 * `cwd` is the folder the shell stands in (the event's cwd); `git` asks git locally (realGit, stubbed in tests).
 * → { kind, reason } or null. A shell line is read for the act (the kinds are shell acts); a file-writing tool is
 * held when it writes inside Hoprig's own folders. A line that cannot be read with certainty is held ('unreadable').
 */
export function wallHeld({ tool, input, cwd = null, git = realGit, places = null } = {}) {
  const p = places ? (typeof places === 'function' ? places() : places) : null;
  // A file-writing tool (the PreToolUse matcher sends Write/Edit/MultiEdit/NotebookEdit here too): a write to
  // Hoprig's own config or state (the run record, the Hands-off mark, the handed hook settings) is the owner's, so a
  // session cannot turn Hands-off on, lift its own stop or take the hook away without his card.
  // One held act carries the whole call in `acts`, so a consumer always sees the full list: Allow runs the whole call.
  const solo = (r) => (r ? { ...r, acts: [r] } : null);
  if (FILE_TOOLS.has(tool)) {
    const fp = input && typeof input === 'object' ? input.file_path || input.notebook_path : null;
    if (typeof fp !== 'string' || !fp) return null;
    if (hitsHoprig(fp, p, cwd)) return solo(heldReason('settings', fp, fp));
    // On Windows a share the wall cannot place or a drive-relative path could name one of Hoprig's own folders: a
    // write there is held (fail closed), as the same path is in a shell line (winUnplaceable).
    if (platformOf(p) === 'win32' && winShareOrDriveRelative(fp)) return solo(heldReason('settings', fp, fp));
    // The session's own edit of a project's own project.json: it names the project's repositories, what it needs and
    // the commands Hoprig runs for it on this computer, so a change to it is the owner's to approve. Shown
    // relative to the session's own folder when it sits inside it, so the card reads at a glance (not a long path).
    // On Windows the system names the file with either separator and in any case.
    const plat = platformOf(p);
    const name = plat === 'win32' ? fp.slice(Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\')) + 1).toLowerCase() : fp.slice(fp.lastIndexOf('/') + 1);
    if (name === 'project.json') {
      const ownOk = p && p.relative && typeof p.own === 'string' && p.own;
      const rel = !ownOk ? fp
        : plat === 'win32' ? (below(fp, p.own, plat) ? path.win32.relative(p.own, fp) : fp)
          : fp.startsWith(`${p.own}/`) ? fp.slice(p.own.length + 1) : fp;
      return solo(heldReason('project', rel, rel));
    }
    return null;
  }
  if (tool !== 'Bash') return null;
  const command = input && typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return null;
  // The kinds that need no context, and git read with its context. A cd/pushd before a git push/merge/rebase makes
  // the repository it lands in unreadable (gitKind dirChanged), so the visitor carries that state across the line.
  let dirChanged = false;
  const found = {};
  const id = walk(command, (info, net) => {
    const k = kindOfCommand(info) || deployKind(info) || gitKind(info, cwd, git, dirChanged) || (editsProjectJson(info) ? 'project' : null);
    // A cd/pushd, an env -C, or a GIT_DIR-family variable set for the rest of the line (a bare assignment or an
    // export) makes any later git push/merge land in a repository the cwd does not name: carry that across the line.
    if (!k && !net && (CHANGES_DIR.has(info.head) || info.chdir || setsRepoVar(info))) dirChanged = true;
    return k;
  }, 0, found, platformOf(p));
  // The acts on this line that are the owner's, in order (bashHeldActs). A kind read across the whole line (above)
  // stays the gate's primary. A delete is judged against the folder the shell really stands in: a cd into the
  // session's own folder is followed, so a delete that lands inside it is not "outside". A touch of Hoprig's own
  // files is also read on the whole command, as a floor that never under-holds.
  let primary = null;
  let acts = null;
  if (id) primary = heldReason(id, shownPart(id, found.part || command, command), command);
  else if (p) { acts = bashHeldActs(command, cwd, git, p); primary = acts[0] || null; }
  if (!primary && p && lineTouchesHoprig(command, p, cwd)) primary = heldReason('settings', partWhere(command, (t) => !movesHome(t, p, cwd) && touchesHoprig(t, p, cwd)), command);
  if (!primary) return null;
  // Allow types Yes to the tool's dialog, which runs the WHOLE line, so the card names every act on it that is the
  // owner's, not only the first (a `git push … && npm publish`, a `sudo … && rm -rf ../x && git push`).
  if (!acts) acts = bashHeldActs(command, cwd, git, p);
  // The primary is the same act as its entry in the list: what the list knows of it (an administrator command with
  // a word that cannot be told) is carried over.
  const own = acts.find((a) => a.part === primary.part && a.why === primary.why);
  if (own && own.unsure) primary = { ...primary, unsure: true };
  const rest = acts.filter((a) => a.part !== primary.part || a.why !== primary.why);
  return { ...primary, acts: [primary, ...rest] };
}

// Where the shell stands after command `cmd` (its text `part`), for judging the next delete. A top-level `cd` to a
// single plain path word is resolved from `folder`; a bare cd, a quoted/variable/glob/`-` target, pushd/popd or an
// env -C leaves the folder unknown (null); a command that is not a folder change leaves `folder` as it was. Only a
// cd that can be read with certainty is followed — everything else keeps a later delete held.
// The cd's target is Bash's text; `folder` is a place the system names, so it is resolved by the system's own rules.
function movedTo(folder, cmd, part, platform = process.platform) {
  const info = headOf(cmd, platform);
  if (!CHANGES_DIR.has(info.head) && !info.chdir) return folder; // not a folder change
  if (folder === null || info.chdir || info.head !== 'cd') return null; // env -C, pushd/popd, or already unknown
  const m = /^cd\s+([^\s"'`$*?[\]~][^\s"'`$*?[\]]*)$/.exec(part);
  // On Windows a Git-Bash drive path (`cd /c/Users/alex`) is the drive folder it names (winReal), not `\\c\Users`.
  return m && !m[1].startsWith('-') ? pathOf(platform).resolve(folder, platform === 'win32' ? winReal(m[1]) : m[1]) : null;
}

// Is command `part` a change of folder to the home folder itself and nothing else, read from `folder`: `cd` or
// `pushd` with one plain target that lands exactly in the home folder (`cd ..` from a project that stands in the
// home folder, `cd /home/alex`)? That is what `cd ~` is, and `cd ~` is no touch of Hoprig's own files: the home
// folder is above them, but a shell that only steps into it changes nothing. What the line does there afterwards
// is read from the home folder (movedForHoprig), so `cd .. && mv .config old` is held as `cd ~ && mv .config old`
// is. Anything else is no such move and is judged as before: an option, a second word, a redirection, a variable,
// a glob, another program (`ls ..`, `mv .. x`), a folder above Hoprig's own that is not the home folder
// (`cd ../.config`), an unknown `folder`.
function movesHome(part, p, folder) {
  const home = p && typeof p.home === 'string' && p.home ? p.home : null;
  if (!home || typeof part !== 'string') return false;
  const platform = platformOf(p);
  // On Windows a session writes the home folder the way the system names it (`cd C:\Users\alex`), which Bash would
  // read without its backslashes: there the words are read with each backslash kept, as wordsOf reads them, and the
  // check that the line is written plainly is made against that reading.
  const winSpell = platform === 'win32' && part.includes('\\');
  const ws = shellWords(winSpell ? part.replace(/\\/g, '\\\\') : part, { home, platform }).filter((w) => w.value !== '' || w.unsure);
  if (ws.length !== 2 || ws.some((w) => w.unsure || w.glob)) return false;
  if ((ws[0].value !== 'cd' && ws[0].value !== 'pushd') || ws[1].value.startsWith('-')) return false;
  if (part.trim() !== `${ws[0].value} ${ws[1].value}` && part.trim() !== `${ws[0].value} ${ws[1].value}/`) return false; // written plainly: no quote, no sign
  const homes = [...new Set([home, realOrSelf(home, platform)])];
  // A target written from the root lands where it says; any other only from a folder that is known.
  const to = placesOf(ws[1].value, typeof folder === 'string' && pathOf(platform).isAbsolute(folder) ? folder : null, platform);
  // One slash at the end names the same folder.
  // On Windows the home folder in its other spelling (`runneradmin` for `RUNNER~1`, or the other way) is the home too.
  const same = (rp, h) => samePlace(rp, h, platform) || (platform === 'win32' && winSameShort(rp, h));
  return to.length > 0 && to.every((rp) => homes.some((h) => same(rp.length > 1 ? rp.replace(/\/+$/, '') : rp, h)));
}

// Does the whole line touch Hoprig's own files (the floor of wallHeld, read from the event's own folder)? The line
// is read at once, with each lone change of folder to the home folder itself written as `cd ~`, which is what it is.
function lineTouchesHoprig(command, p, cwd) {
  const commands = readCommands(command);
  if (!commands) return touchesHoprig(command, p, cwd);
  let out = '';
  let at = 0;
  for (const [a, b] of commands.spans) {
    if (a < at || !movesHome(commands.line.slice(a, b).trim(), p, cwd)) continue;
    out += `${commands.line.slice(at, a)} cd ~ `;
    at = b;
  }
  return touchesHoprig(at ? out + commands.line.slice(at) : command, p, cwd);
}

// Where the shell stands after `cmd` (its text `part`) for the check of Hoprig's own folders. A `cd` OR `pushd` whose
// target can be told — a plain path, `~`, `$HOME`, `${HOME}`, a path with `..` (shellWords fills the home forms in) —
// is followed from `folder`; a bare `cd` goes home. A target that cannot be told (another variable, a substitution, a
// glob, `cd -`), a bare `pushd`/`popd`, an option, or an already-unknown folder leaves it unknown (null), so the line
// is judged as it is today. This follows more than movedTo, the delete's own narrow follow: for the Hoprig check,
// following a change of folder only makes the wall stricter, never freer, so it cannot free a delete held on the base.
function movedForHoprig(folder, part, p) {
  const home = p && typeof p.home === 'string' && p.home ? p.home : null;
  const platform = platformOf(p);
  const ws = shellWords(part, { home, platform }).filter((w) => w.value !== '' || w.unsure);
  if (!ws.length) return folder;
  const head = baseName(ws[0].value);
  if (head !== 'cd' && head !== 'pushd') return folder; // not a folder change
  if (folder === null) return null;
  // On Windows a target written the way the system names it (`cd C:\Users\alex`) is followed as written, backslashes
  // kept (as wordsOf reads it); when that reading gives no single plain target, Bash's reading below is followed.
  if (platform === 'win32' && part.includes('\\')) {
    const kept = shellWords(part.replace(/\\/g, '\\\\'), { home, platform }).filter((w) => w.value !== '' || w.unsure).slice(1);
    if (kept.length === 1 && !kept[0].unsure && !kept[0].glob && !kept[0].value.startsWith('-')) return path.win32.resolve(folder, winReal(kept[0].value));
  }
  const args = ws.slice(1);
  if (!args.length) return head === 'cd' ? home : null; // bare cd → home; bare pushd swaps the stack: unknown
  if (args.length > 1) return null; // an option or more than a lone target: do not try to tell it
  const t = args[0];
  if (t.unsure || t.glob || t.value.startsWith('-')) return null; // a variable, a substitution, a glob, or `cd -`
  // `folder` is a place the system names; on Windows a Git-Bash drive path (`/c/Users/alex`) is read as the drive
  // folder it names (winReal), so a later relative path is placed under it.
  return pathOf(platform).resolve(folder, platform === 'win32' ? winReal(t.value) : t.value);
}

// ---- what an administrator command does beside being one ----
// Programs that only read, behind sudo: naming the home folder or a folder above Hoprig's does not make one of them a
// change of those folders (`sudo ls ~`, `sudo du -sh ~`, `sudo journalctl -u x`). A path INSIDE Hoprig's own folders
// is held for a reader too, as it is without sudo (touchesHoprig: the wall cannot tell a read from a write there).
const ADMIN_READERS = new Set(['ls', 'dir', 'cat', 'tac', 'head', 'tail', 'less', 'more', 'du', 'df', 'stat', 'file', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'tree', 'id', 'whoami', 'groups', 'true', 'false', 'test', 'uname', 'hostname', 'uptime', 'journalctl', 'dmesg', 'lsblk', 'blkid', 'lsof', 'ps', 'pgrep', 'ss', 'netstat', 'readlink', 'realpath', 'md5sum', 'sha1sum', 'sha256sum', 'diff', 'cmp', 'which', 'whereis', 'getent', 'free', 'vmstat', 'lscpu', 'nproc', 'apt-cache', 'dpkg-query']);
// A program that reads only under these first words (`systemctl status x` reads, `systemctl restart x` does not).
const READER_SUBS = Object.freeze({
  systemctl: ['status', 'show', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'cat'],
  apt: ['list', 'show', 'policy', 'search'],
  docker: ['ps', 'logs', 'inspect', 'images', 'version', 'info'],
  ufw: ['status'],
});
// What find can do beside looking: run a program, delete, or write a file.
const FIND_ACTS = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
// Programs that only read or print the words they are given, whoever runs them (the net in walk).
const PURE_READERS = new Set([...ADMIN_READERS, 'echo', 'printf', 'man', 'apropos', 'whatis', 'type', 'help', 'info', 'tldr']);
/** Does `program` with these words after it only read? (The words as readCommands gives them, options included.) */
export function adminReads(program, rest = []) {
  if (ADMIN_READERS.has(program)) return true;
  if (program === 'find') return !rest.some((w) => FIND_ACTS.test(w));
  const subs = READER_SUBS[program];
  const first = rest.find((w) => !isOption(w));
  return !!subs && subs.includes(first);
}
// Programs that destroy what they are pointed at without being a delete mayDelete reads (asking.mjs leaves them out
// on purpose for an ordinary command). Behind sudo they are held like a delete.
const ADMIN_DESTROYERS = new Set(['rmdir', 'unlink', 'shred', 'truncate', 'wipefs', 'blkdiscard', 'mkswap']);
const destroys = (program, rest) => ADMIN_DESTROYERS.has(program) || program.startsWith('mkfs') || (program === 'dd' && rest.some((w) => w.startsWith('of=')));

/**
 * Where a path stands to Hoprig's own folders: 'inside' (one of them, or in one), 'above' (a folder that holds one,
 * all the way up to `/`), or null. Read through its normalised and real places (placesOf), so a `..`, a doubled
 * separator or a link changes nothing. `p.hoprig`: the folders; `cwd`: where a relative path is read from.
 */
export function hoprigRelation(text, p, cwd) {
  const dirs = (p && Array.isArray(p.hoprig) ? p.hoprig : []).filter((d) => typeof d === 'string' && d);
  if (!dirs.length || typeof text !== 'string' || !text) return null;
  const platform = platformOf(p);
  const roots = [...new Set(dirs.flatMap((d) => [d, realOrSelf(d, platform)]))];
  let rel = null;
  for (const rp of placesOf(text, cwd, platform)) {
    if (!pathOf(platform).isAbsolute(rp)) continue;
    for (const d of roots) {
      if (inFolder(rp, d, platform)) return 'inside';
      // On Windows a root (`C:\`, `\`) holds its folders by inFolder itself.
      if (platform === 'win32' ? below(d, rp, platform) : d.startsWith(rp === '/' ? '/' : `${rp}/`)) rel = 'above';
    }
  }
  return rel;
}

// `sudo rm …` as the same delete without sudo, for plainDelete: only the plain prefix (`sudo` or `sudo -n`, one
// space each) is taken off. Any other form gives null, which is never a plain delete.
const withoutSudo = (part) => {
  const m = /^sudo(?: -n)? (rm .*)$/s.exec(part);
  return m ? m[1] : null;
};
// Do all these words surely name places inside the session's own folder? (For a destroyer behind sudo.)
function insideOwn(texts, base) {
  const own = base && typeof base.own === 'string' && base.own ? base.own : base && typeof base.cwd === 'string' ? base.cwd : null;
  const cwd = base && typeof base.cwd === 'string' ? base.cwd : null;
  const platform = platformOf(base);
  const P = pathOf(platform);
  if (!own || !cwd || !P.isAbsolute(own) || !P.isAbsolute(cwd)) return false;
  // On Windows a drive's root as the own folder is no folder a destroyer is plainly inside (as `/` is not elsewhere).
  if (platform === 'win32' && P.parse(P.normalize(own)).root === P.normalize(own)) return false;
  const roots = [...new Set([own, realOrSelf(own, platform)])];
  return texts.every((t) => !t.unsure && !t.glob && placesOf(t.text, cwd, platform).every((rp) => roots.some((d) => below(rp, d, platform))));
}

/**
 * What ONE administrator command (`part`, its words `cmd`) does beside asking for administrator rights:
 *   del       it deletes, or destroys what it is pointed at, and not plainly inside the session's own folder: the
 *             same delete without sudo would be the owner's too ("delete outside");
 *   settings  it names a path in Hoprig's own folders, or (a program that does not only read) a folder that holds
 *             one of them, up to `/`: a move, a change of owner or a write there takes Hoprig's rules with it;
 *   unsure    a program that does not only read is given a word whose value cannot be told from the line (another
 *             variable, `${HOME:?}`, `~name`, a brace list): Hoprig cannot say what it would change.
 * `base`: the places with the folder the shell stands in at this command (null when that is not known).
 */
function behindAdmin(part, cmd, p, cwd, base) {
  const info = headOf(cmd, platformOf(p));
  const out = { del: false, settings: false, unsure: false };
  const home = p && typeof p.home === 'string' && p.home ? p.home : null;
  const texts = pathTexts(wordsOf(part, home, platformOf(p)));
  const where = base && typeof base.cwd === 'string' ? base.cwd : typeof cwd === 'string' ? cwd : null;
  if (mayDelete(part)) out.del = !(base && plainDelete(withoutSudo(part), base));
  else if (destroys(info.head, info.rest)) out.del = !insideOwn(texts, base);
  const reads = adminReads(info.head, info.rest);
  for (const t of texts) {
    if (t.unsure) {
      if (!reads) out.unsure = true;
      continue;
    }
    const rel = hoprigRelation(t.text, p, where);
    // A pattern names the entries of its folder: in one of Hoprig's folders they are inside it; in a folder above
    // one of them, one entry is the way down to it.
    if (rel === 'inside' || (rel === 'above' && !reads)) out.settings = true;
  }
  return out;
}

/** Does a line hold an administrator command that deletes, or destroys what it is pointed at? (For her own tool.) */
export function adminDeletes(line) {
  const commands = readCommands(line);
  if (commands === null) return false; // an unreadable line is refused before this is asked
  return commands.some((cmd, j) => {
    const info = headOf(cmd);
    if (!info.admin) return false;
    return mayDelete(commands.line.slice(...commands.spans[j]).trim()) || destroys(info.head, info.rest);
  });
}

// Every act on a Bash line that is the owner's alone, in the order they run (a kind read from the command or one
// nested in it, a delete outside the folder, a touch of Hoprig's own files), deduped by the command shown. The gate
// is the primary act in wallHeld; this list is for the card, so the owner sees all of what one Allow would run.
function bashHeldActs(command, cwd, git, p) {
  const commands = readCommands(command);
  if (commands === null) return [heldReason(UNREADABLE, command, command)];
  const acts = [];
  const seen = new Set();
  let dirChanged = false;
  // The folder the shell stands in before each command, followed across the line (movedTo): a cd to a single plain
  // path word is resolved; any other folder change (a bare cd, a quoted/variable/glob/`-` target, pushd/popd, env -C)
  // leaves it unknown. A delete is then judged against that folder (plainDelete, which checks it is itself inside the
  // session's own folder): a delete that lands inside the folder is not "outside"; after an unknown move it is held.
  // The shell's folder for judging a delete is the one in `places` (plainDelete reads p.cwd), followed across the
  // line; wallHeld's own cwd argument is not always set — a caller may pass only places.
  let folder = p && typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
  // The same folder, followed for the check of Hoprig's own folders (movedForHoprig): a cd/pushd whose target can be
  // told is followed, so a short path to Hoprig's folders after `cd ~` is read from where the shell then stands.
  let hoprigFolder = typeof cwd === 'string' && cwd ? cwd : folder;
  for (const [j, cmd] of commands.entries()) {
    const part = commands.line.slice(...commands.spans[j]).trim();
    if (!part) continue;
    // A command that is only a redirection's target (`foo &> out`, where `&` ended the command and `> out` begins a
    // fresh one): its span text is a bare file name, which re-walked alone would read as a program (or a head
    // variable for `> "$LOG"`). It runs nothing, so it holds nothing; a touch of Hoprig's own files in it is caught
    // by the whole-command check in wallHeld.
    if (cmd.length && cmd.every((t) => t.redirect)) continue;
    let id = null;
    const behind = []; // the kinds of the commands behind sudo on this command (a push, a release, a pull request)
    const base = folder === null ? null : folder === p.cwd ? p : { ...p, cwd: folder };
    // The visitor sees every command (it never stops) so a cd/env -C before a later push is carried in dirChanged.
    const w = walk(part, (info, net) => {
      const k = kindOfCommand(info) || deployKind(info) || gitKind(info, cwd, git, dirChanged) || (editsProjectJson(info) ? 'project' : null);
      // Behind sudo the command keeps the kind it has without sudo, as an act of its own: Full lifts only the
      // administrator act, so `sudo git push origin main` stays a push to the main branch.
      if (k === 'admin') {
        const plain = { ...info, admin: false };
        const u = kindOfCommand(plain) || deployKind(plain) || gitKind(plain, cwd, git, dirChanged) || (editsProjectJson(plain) ? 'project' : null);
        if (u && u !== 'admin' && !behind.includes(u)) behind.push(u);
      }
      if (k && id === null) id = k;
      // A kind found further on behind an administrator command (the net: `sudo -x y git push origin main`) is an
      // act of its own beside it, like the one read right behind sudo.
      else if (k && net && id === 'admin' && k !== 'admin' && !behind.includes(k)) behind.push(k);
      else if (!k && !net && (CHANGES_DIR.has(info.head) || info.chdir || setsRepoVar(info))) dirChanged = true;
      return null;
    }, 0, null, platformOf(p));
    if (id === null && w === UNREADABLE) id = UNREADABLE; // the command's head is a bare variable (walk), e.g. `$x true`
    if (id === null && p && mayDelete(part) && !(base && plainDelete(part, base))) id = 'delete outside';
    // Held when the command touches Hoprig's folders read from where the shell then stands (a followed cd/pushd) OR
    // from the event's own cwd: following only ADDS holds, so a line held on the base (read from cwd) never goes
    // through after this.
    // A lone change of folder to the home folder itself is no touch (movesHome), in the reading it is one in.
    const touches = (from) => !movesHome(part, p, from) && touchesHoprig(part, p, from);
    if (id === null && p && (touches(hoprigFolder) || touches(cwd))) id = 'settings';
    // On Windows a path the wall cannot place, but that could name one of Hoprig's folders, is held in a command that
    // is not only a read (fail closed).
    if (id === null && p && winUnplaceable(cmd, part, p)) id = 'settings';
    folder = movedTo(folder, cmd, part, platformOf(p)); // where the shell stands for the next command's delete
    hoprigFolder = movedForHoprig(hoprigFolder, part, p); // where it stands for the next command's Hoprig check
    if (id === null) continue;
    const add = (k) => {
      const key = `${k}\u0000${part}`;
      if (seen.has(key)) return;
      seen.add(key);
      acts.push(heldReason(k, shownPart(k, part, command), command));
    };
    add(id);
    // An administrator command never hides what it does: what stands behind sudo is read as the same words without
    // it are, and each thing found is an act of its own. Kept apart, so a reader that lifts administrator acts (her
    // level at Full) still sees the delete and the touch of the files that decide how the session is held, by
    // whatever spelling a path is written. A word whose value cannot be told is marked on the administrator act
    // itself (`unsure`): Full does not lift such a command.
    if (id === 'admin') {
      // An administrator command that stands inside another command's text (`bash -c "sudo …"`, `eval "sudo …"`), or
      // behind a program whose own words the stepping could not place (the net in walk: `taskset -c 0,1 sudo …`,
      // `strace sudo …`), is not read further than that it is one: what it would do cannot be told, so it is marked
      // like a word that cannot be told. Only a command that is itself the administrator command, reached by
      // stepping, is read behind its sudo.
      // Nor is an administrator command that xargs feeds: the words it would run with are not on the line.
      // Nor one a package runner stands beside (`npx sudo …`, `sudo uv run …`): what the runner fetches or loads
      // cannot be told from the line.
      const hi = headOf(cmd, platformOf(p));
      const direct = hi.admin && !hi.fed && !hi.runner;
      const more = direct ? behindAdmin(part, cmd, p, cwd, base) : { unsure: true, del: false, settings: false };
      if (more.unsure) {
        const shown = shownPart('admin', part, command);
        const at = acts.findIndex((a) => a.kind === 'admin' && a.part === shown);
        if (at >= 0) acts[at] = { ...acts[at], unsure: true };
      }
      for (const k of behind) add(k);
      if (more.del) add('delete outside');
      if (more.settings || (p && touchesHoprig(part, p, cwd))) add('settings');
    }
  }
  return acts;
}

// The one thing "Allow everything" still holds (bypassgate.mjs): a removal read FOR CERTAIN as taking away a whole home
// folder, workspace, folder of projects or the root of the disk. It reads `rm` only (sudo and the other passers are
// stepped over; xargs and the runners feed words that are not on the line, so they are not read). Every target must be
// told with certainty: a word with a variable, a command substitution or a brace list is skipped, a glob counts as the
// folder it is matched in (only where that folder is written out), a relative target is read from the shell's folder
// (`places.cwd`), followed across a plain `cd` and given up once that folder cannot be told. A line that cannot be read
// as a whole is no hit: in that mode nothing is held that Hoprig cannot read for certain.
// → 'home' | 'workspace' | 'projects' | 'disk' | null
export function wipesWhole({ command, places = null } = {}) {
  if (typeof command !== 'string') return null;
  const commands = readCommands(command);
  if (commands === null) return null;
  const p = places || {};
  // The system whose names the places are (`p.platform`; a test gives Windows' on another system). On Windows the shell
  // may be Git Bash (`rm`) or PowerShell and cmd (`Remove-Item`, `rd`, `del`): a place is read with Windows' rules
  // (drive, either separator, case, `/c/x`, the long prefix: inFolder) and a drive's top is the disk.
  const platform = platformOf(p);
  const win = platform === 'win32';
  const P = pathOf(platform);
  const isAbs = (s) => typeof s === 'string' && s !== '' && (win ? P.isAbsolute(winReal(s)) : s.startsWith('/'));
  const home = typeof p.home === 'string' && isAbs(p.home) ? p.home : os.homedir();
  const plain = (d) => (win ? d : path.posix.normalize(d).replace(/(.)\/+$/, '$1'));
  const kept = [
    ['home', [home]],
    ['workspace', [p.workspace]],
    ['projects', Array.isArray(p.projects) ? p.projects : []],
  ].map(([kind, list]) => [kind, list.filter(isAbs).flatMap((d) => [d, realOrSelf(d, platform)]).map(plain)]);
  const isRoot = (t) => (win ? P.parse(winReal(t)).root !== '' && winPlace(t) === winPlace(P.parse(winReal(t)).root) : t === '/');
  const holds = (target) => {
    const ts = [target, realOrSelf(target, platform)];
    if (ts.some(isRoot)) return 'disk';
    for (const [kind, ds] of kept) if (ds.some((d) => ts.some((t) => inFolder(d, t, platform)))) return kind;
    return null;
  };
  // What a Windows shell reads as the person's own folder before the words are read: %USERPROFILE%, $env:USERPROFILE,
  // $USERPROFILE and ${USERPROFILE} (and HOME alike), the drive the home is on for %SystemDrive% and $env:SystemDrive.
  const driveOf = /^[A-Za-z]:/.exec(winReal(home));
  const named = (part) => {
    if (!win) return part;
    let t = part.replace(/%(?:USERPROFILE|HOME)%|\$env:(?:USERPROFILE|HOME)\b|\$\{(?:USERPROFILE|HOME)\}|\$(?:USERPROFILE)\b/gi, home);
    if (driveOf) t = t.replace(/%SystemDrive%|\$env:SystemDrive\b/gi, driveOf[0]);
    return t;
  };
  const WIPERS = new Set(win ? ['rm', 'rd', 'rmdir', 'del', 'erase', 'remove-item', 'ri'] : ['rm']);
  const CMD_FLAG = /^\/[A-Za-z?]$/; // cmd's switches (`rd /s /q`), not a place: only for the cmd programs
  let folder = typeof p.cwd === 'string' && isAbs(p.cwd) ? (win ? P.resolve(winReal(p.cwd)) : path.posix.normalize(p.cwd)) : null;
  for (const [j, cmd] of commands.entries()) {
    const part = named(commands.line.slice(...commands.spans[j]).trim());
    if (!part || cmd.every((t) => t.redirect)) continue;
    const info = headOf(cmd, platform);
    const words = (win ? wordsOf(part, home, platform) : shellWords(part, { home })).filter((w) => w.value !== '' || w.unsure);
    const wiper = win ? info.head.toLowerCase().replace(/\.(exe|com|bat|cmd)$/, '') : info.head;
    if (WIPERS.has(wiper) && !info.fed && !info.runner) {
      const nameOf = (w) => (win ? P.basename(winReal(w.value)).toLowerCase().replace(/\.(exe|com|bat|cmd)$/, '') : path.posix.basename(w.value));
      const at = words.findIndex((w) => !w.unsure && nameOf(w) === wiper);
      const cmdProgram = win && ['rd', 'rmdir', 'del', 'erase'].includes(wiper);
      let ending = false;
      for (const w of at < 0 ? [] : words.slice(at + 1)) {
        if (!ending && w.value === '--' && !w.unsure) {
          ending = true;
          continue;
        }
        if (w.unsure) continue;
        let t = w.value;
        if (!ending) {
          // PowerShell's `-Path:C:\x` and `-LiteralPath:C:\x` carry the place in the same word; any other option is skipped
          const named2 = win && /^-(?:literal)?path:(.+)$/i.exec(t);
          if (named2) t = named2[1];
          else if (t.startsWith('-') || (cmdProgram && CMD_FLAG.test(t))) continue;
        }
        if (w.glob) {
          if (typeof w.fixed !== 'string' || (w.fixed !== '' && !/[\\/]$/.test(win ? w.fixed : w.fixed.slice(-1)))) continue;
          t = w.fixed || '.';
        }
        if (win) t = winReal(t).replace(/^([A-Za-z]:)$/, '$1\\'); // a bare drive (`/c`, `C:`) is its top
        if (!isAbs(t)) {
          if (folder === null) continue;
          t = P.resolve(folder, t);
        }
        const hit = holds(plain(P.normalize(t)));
        if (hit) return hit;
      }
    }
    if (info.head === 'cd' && !info.chdir) {
      // a Windows place is read with its backslashes kept (Bash's own reading drops them): one reading, so one word
      const cdWords = win && part.includes('\\') ? shellWords(part.replace(/\\/g, '\\\\'), { home, platform }).filter((x) => x.value !== '' || x.unsure) : words;
      const w = cdWords.length === 2 ? cdWords[1] : null;
      const ok = w && !w.unsure && !w.glob && !w.value.startsWith('-') && (isAbs(w.value) || folder !== null);
      folder = ok ? P.resolve(folder === null ? (win ? '\\' : '/') : folder, win ? winReal(w.value) : w.value) : null;
    } else folder = movedTo(folder, cmd, part, platform);
  }
  return null;
}

// What each hit of wipesWhole is called, and the line a card says when it still shows in "Allow everything".
export const FLOOR_WORDS = Object.freeze({ home: 'home folder', workspace: 'workspace', projects: 'projects folder', disk: 'disk' });
export const floorLine = (kind) => `Held even in Allow everything: this would delete your whole ${FLOOR_WORDS[kind]}, which cannot be undone.`;

// A push or merge Hoprig cannot place gets the shown part expanded (shownPart); other kinds show the command as it is.
function shownPart(id, bare, command) {
  return id === 'push-elsewhere' || id === 'merge-elsewhere' ? withDirContext(command, bare) : bare;
}

// Why Hoprig cannot place a push/merge is usually a folder change earlier on the line. Show from that change up to the
// push, so the card explains itself in a glance. Without a preceding change (`git -C other push …`) the command itself
// already names the other repository, so it is shown unchanged.
function withDirContext(command, pushPart) {
  const commands = readCommands(command);
  if (!commands) return pushPart;
  let from = -1;
  for (const [j, cmd] of commands.entries()) {
    const info = headOf(cmd);
    if (from < 0 && (CHANGES_DIR.has(info.head) || info.chdir || setsRepoVar(info))) from = commands.spans[j][0];
    if (commands.line.slice(...commands.spans[j]).trim() === pushPart) return from >= 0 ? commands.line.slice(from, commands.spans[j][1]).trim() : pushPart;
  }
  return pushPart;
}

// For the card only (the line as a whole decided the hold): the first top-level command that is held by itself, else
// the whole line, which is then shown, whole or plainly cut.
function partWhere(command, held) {
  const commands = readCommands(command);
  if (!commands) return command;
  for (const span of commands.spans) {
    const text = commands.line.slice(...span).trim();
    if (text && held(text)) return text;
  }
  return command;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ---- places, the way the system names them ----
// The path module that names places as `platform` does (on this computer's own platform it is node's own `path`), and
// the platform a set of places is read for (`p.platform`, so a test can give Windows' answers on another system).
const pathOf = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const platformOf = (p) => (p && typeof p.platform === 'string' && p.platform ? p.platform : process.platform);
// A path as Windows resolves its spelling, BEFORE `.`/`..` are worked out (that is left to the caller's
// normalise/resolve, so a `.. ` turned into `..` here is then followed). Three forms path.win32.normalize leaves as
// written:
//   - a Git-Bash / MSYS drive path `/c/x` is the drive path `C:\x` (that is the shell a session may run on Windows);
//   - the extended-length prefix: `\\?\C:\x` is `C:\x`, and `\\?\UNC\srv\sh` is the share `\\srv\sh`;
//   - a trailing dot or space on each path COMPONENT, which Windows drops (`hoprig.`, `hoprig ` → `hoprig`), while
//     `.` and `..` stay the navigation they are (`.. ` is `..`, so it still steps up a folder).
function winReal(s) {
  let w = s.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:').replace(/\//g, '\\');
  // The extended-length prefix (`\\?\C:\x` → `C:\x`, `\\?\UNC\srv\sh` → `\\srv\sh`) and the device namespace of a
  // drive (`\\.\C:\x` → `C:\x`), which name the same place as the plain path; a device name that is not a drive
  // (`\\.\PhysicalDrive0`) is left as the share it looks like, so it stays unplaceable.
  // (`\\.\UNC\srv\sh` is the same share as `\\?\UNC\srv\sh`.)
  w = w.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/^\\\\\.\\([A-Za-z]:)/, '$1');
  return w
    .split('\\')
    .map((c) => {
      // A drive-relative nav (`C:.`, `C:..`) is kept whole: the `..` after a drive is navigation, not a trailing dot
      // to drop, so a drive-relative path is not mistaken for the drive's root.
      const driveNav = /^([A-Za-z]:)(\.\.?)[ ]*$/.exec(c);
      if (driveNav) return driveNav[1] + driveNav[2];
      const nav = /^(\.\.?)[ ]*$/.exec(c);
      return nav ? nav[1] : c.replace(/[. ]+$/, '');
    })
    .join('\\');
}
// An administrative share of a drive (`\\localhost\C$\Users\…`, `\\127.0.0.1\c$\…`, the extended spelling
// `\\?\UNC\localhost\C$\…`, or the computer's own name before `C$`) reaches that drive of the computer it names:
// → the drive path it would be on this one (`C:\Users\…`), or null for any other path. The checks of Hoprig's own
// folders read such a path BOTH ways, so a read of Hoprig's config through a share is held as the plain read is. The
// name before the share is not asked (the computer's own name is not on the line): the wall leans to holding.
function winShareDrive(s) {
  if (typeof s !== 'string' || !s) return null;
  const m = /^\\\\[^\\\s]+\\([A-Za-z])\$(?:\\(.*))?$/s.exec(winReal(s));
  return m ? `${m[1]}:\\${m[2] || ''}` : null;
}
// A path, and on Windows the drive path it reaches when it is written through an administrative share.
const withShareDrive = (fp, platform) => {
  const d = platform === 'win32' ? winShareDrive(fp) : null;
  return d ? [fp, d] : [fp];
};
// A place as Windows compares it: either separator, doubled ones as one, no separator at the end but the root's, the
// spellings winReal reads, and without regard to case.
function winPlace(s) {
  let w = path.win32.normalize(winReal(s));
  const root = path.win32.parse(w).root;
  if (w.length > root.length) w = w.replace(/\\+$/, '');
  return w.toLowerCase();
}
/**
 * Is `place` the folder `folder` or a place inside it, the way the system names places? Elsewhere than Windows exactly
 * as written (`/`, case as it is). On Windows either separator counts, doubled ones are one, `.` and `..` are
 * resolved, and case does not count.
 */
const DRIVE = /^[a-z]:/;
export function inFolder(place, folder, platform = process.platform) {
  if (typeof place !== 'string' || typeof folder !== 'string' || !place || !folder) return false;
  if (platform !== 'win32') return place === folder || place.startsWith(`${folder}/`);
  let a = winPlace(place);
  let b = winPlace(folder);
  // A place written from the root with no drive (`\x`, `/x`) is on the current drive, which path.win32.resolve fills
  // in on Windows: compared with the other's drive left out, so the two spellings meet.
  if (DRIVE.test(a) !== DRIVE.test(b) && (DRIVE.test(a) ? b : a).startsWith('\\')) {
    if (DRIVE.test(a)) a = a.slice(2);
    else b = b.slice(2);
  }
  return a === b || a.startsWith(b.endsWith('\\') ? b : `${b}\\`);
}
// The words of a command for the checks of Hoprig's own folders. Bash takes an unquoted backslash away (`C:\Users`
// reaches the program as `C:Users`), but on Windows a session may write a place the way the system names it, and the
// wall leans to holding: there the words are also read with each backslash kept as written. Only the certain words of
// that second reading are added, so it can add a hold and never takes one away; elsewhere the words are Bash's alone.
function wordsOf(text, home, platform) {
  const words = shellWords(text, { home, platform });
  if (platform !== 'win32' || typeof text !== 'string' || !text.includes('\\')) return words;
  return [...words, ...shellWords(text.replace(/\\/g, '\\\\'), { home, platform }).filter((w) => !w.unsure)];
}
const samePlace = (a, b, platform) => inFolder(a, b, platform) && inFolder(b, a, platform);
const below = (a, b, platform) => inFolder(a, b, platform) && !inFolder(b, a, platform); // strictly inside

// The real location of a path (a symlink followed), or the path itself when it cannot be resolved.
// The disk is asked only for places named the way this computer names them (`platform` its own).
const realOrSelf = (d, platform = process.platform) => {
  if (platform !== process.platform) return d;
  try {
    return fs.realpathSync(d);
  } catch {
    return d;
  }
};

// The absolute places a path could land, for comparison with Hoprig's folders: made absolute against cwd and
// normalised (so a `..` cannot step out of the check), and the real location of its nearest existing ancestor (so a
// symlink anywhere in the path cannot point a write into Hoprig's folders from outside them).
// `platform`: the system whose names these are (its own path rules; the disk is asked only on that system itself).
function placesOf(fp, cwd, platform = process.platform) {
  if (typeof fp !== 'string' || !fp) return [];
  const P = pathOf(platform);
  // On Windows read the path's spelling as the system does before `.`/`..` are resolved below (a `.. ` must become
  // `..` first, a `/c/` or `\\?\` prefix must reduce to the drive path), so the comparison lands on the real folder.
  if (platform === 'win32') fp = winReal(fp);
  const abs = P.isAbsolute(fp) ? P.normalize(fp) : typeof cwd === 'string' && P.isAbsolute(cwd) ? P.resolve(cwd, fp) : null;
  if (!abs) return [fp]; // not known where it lands: compared as it was written
  const out = new Set([abs]);
  if (platform !== process.platform) return [...out];
  let anc = abs;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      out.add(tail.length ? P.join(fs.realpathSync(anc), ...tail) : fs.realpathSync(anc));
      break;
    } catch {
      /* this ancestor does not exist yet: step up */
    }
    const parent = P.dirname(anc);
    if (parent === anc) break;
    tail.unshift(P.basename(anc));
    anc = parent;
  }
  return [...out];
}

// Is a path inside one of Hoprig's own folders (config, state; the run records and hook settings live there)? Read
// through its real, normalised places (placesOf), so neither a `..` nor a symlink slips a write past the folders.
function insideHoprig(fp, p, cwd) {
  const dirs = (p && Array.isArray(p.hoprig) ? p.hoprig : []).filter((d) => typeof d === 'string' && d);
  if (!dirs.length) return false;
  const platform = platformOf(p);
  const roots = [...new Set(dirs.flatMap((d) => [d, realOrSelf(d, platform)]))];
  return withShareDrive(fp, platform).some((one) => placesOf(one, cwd, platform).some((rp) => roots.some((d) => inFolder(rp, d, platform))));
}

// Is a path one of Hoprig's own folders, OR a folder that CONTAINS one of them, up to (and including) the home folder?
// A move, rename, copy, link or delete of such a folder carries Hoprig's config, state, hook or installed program with
// it, so the wall holds it as well. Read through the real, normalised places (placesOf), and bounded by the home folder
// so an ordinary folder that holds no part of Hoprig is never caught.
function aroundHoprig(fp, p, cwd) {
  const dirs = (p && Array.isArray(p.hoprig) ? p.hoprig : []).filter((d) => typeof d === 'string' && d);
  if (!dirs.length) return false;
  const platform = platformOf(p);
  const home = p && typeof p.home === 'string' && p.home ? realOrSelf(p.home, platform) : null;
  if (!home) return false;
  const roots = [...new Set(dirs.flatMap((d) => [d, realOrSelf(d, platform)]))];
  return withShareDrive(fp, platform).some((one) => placesOf(one, cwd, platform).some((rp) => inFolder(rp, home, platform) && roots.some((d) => inFolder(d, rp, platform))));
}

// An 8.3 short name of one path part, as Windows gives it beside a long one (`RUNNER~1`, `CONFIG~1`, `APPDAT~1`,
// `LONGFI~1.TXT`): at most eight characters with its `~<digits>`, and an extension of at most three.
const SHORT_83 = /^([^\s.\\/~]{1,7})~(\d{1,7})(?:\.[^\s.\\/]{1,3})?$/;
const isShort83 = (s) => {
  const m = SHORT_83.exec(s);
  return !!m && m[1].length + 1 + m[2].length <= 8;
};

// Could short part `s` be the 8.3 name of long part `n` (both in lower case)? Windows makes the short name from the
// first letters of the long one, without its dots and blanks (`.config` → `CONFIG~1`, `runneradmin` → `RUNNER~1`),
// or, once a folder holds many alike, from its first two letters and a few hex digits: so the short name begins with
// the long one's first two letters (the wall leans to holding beyond that). Two short names are one only when equal.
// A letter the short form cannot carry (`+,;=[]`, a letter outside its set) is `_` there, which stands for any one.
const winShortFor = (s, n) => {
  if (!isShort83(s) || isShort83(n)) return false;
  const clean = n.replace(/[\s.]/g, '');
  const pre = s.slice(0, s.indexOf('~')).slice(0, 2);
  return pre.length <= clean.length && [...pre].every((c, k) => c === '_' || c === clean[k]);
};
const winSamePart = (a, b) => a === b || winShortFor(a, b) || winShortFor(b, a);
const winStarts = (xs, ys) => ys.length <= xs.length && ys.every((y, k) => winSamePart(xs[k], y)); // xs begins with ys

// Two Windows places that are one folder when a short part on either side stands for the long one at its place.
const winSameShort = (a, b) => {
  const xa = patternParts(a, null, 'win32');
  const xb = patternParts(b, null, 'win32');
  return !!xa && !!xb && xa.length === xb.length && winStarts(xa, xb);
};

// On Windows, where a short part is in play (in the path, in Hoprig's folders or in the home folder), the plain
// comparison cannot tell `RUNNER~1` from `runneradmin`: the long name a short part stands for is not on the line. Such
// a path is compared part by part with each of Hoprig's folders, a short part on either side standing for a long name
// it could be made from (winShortFor): inside one of them, or one of them or a folder above one up to home.
function winShortHits(fp, p, cwd) {
  if (platformOf(p) !== 'win32') return false;
  const dirs = (p && Array.isArray(p.hoprig) ? p.hoprig : []).filter((d) => typeof d === 'string' && d);
  if (!dirs.length) return false;
  const parts = patternParts(fp, cwd, 'win32');
  if (!parts) return false;
  const ds = dirs.map((d) => patternParts(d, null, 'win32')).filter(Boolean);
  const hp = p && typeof p.home === 'string' && p.home ? patternParts(p.home, null, 'win32') : null;
  if (![parts, ...ds, ...(hp ? [hp] : [])].some((xs) => xs.some(isShort83))) return false;
  return ds.some((dp) => winStarts(parts, dp) || (!!hp && winStarts(parts, hp) && winStarts(dp, parts)));
}

// A path that lands inside one of Hoprig's folders, or that is or contains one of them up to home.
const hitsHoprig = (fp, p, cwd) => insideHoprig(fp, p, cwd) || aroundHoprig(fp, p, cwd) || winShortHits(fp, p, cwd);

// On Windows a path word the wall cannot place against Hoprig's folders, but that could be one of them, is held in a
// command that is not ONLY a read (a move, a copy, a delete, a change of mode or owner), never let through — the wall
// leans to holding (fail closed). Three such forms, each a place Hoprig cannot tell from the line:
//   - a drive-relative path (`C:..`, `C:.\x`): read from the current folder ON THAT DRIVE, which is not the shell's
//     own folder and is not named on the line, so it could climb into a Hoprig folder;
//   - a UNC or device path that stays a share after winReal (`\\srv\sh`, `\\localhost\C$\…`, `\\127.0.0.1\c$\…`): a
//     loopback administrative share reaches a local drive (a plain `\\.\C:\…` or `\\?\C:\…` reduced to its
//     drive is placed as usual and is not caught here). A share of a drive (`C$`) is ALSO placed as the drive path it
//     reaches (winShareDrive), so what lands in Hoprig's folders through it is held for a read too;
//   - a part in 8.3 short form (`CONFIG~1`, `HOPRIG~1`): the short name of a long folder, which cannot be expanded
//     from the line, so it could name one of Hoprig's own.
// A Windows path that names a share winReal could not reduce to a drive (a server AND a share name, `\\srv\sh`, so a
// `//` alone, a comment or a cmd switch, is no share), or that is drive-relative as written (`C:` alone or before a
// name, `C:..`, `C:x`, not a separator; a Git-Bash word from the root, `/c` or a cmd switch `/e`, and a text that only
// begins like one, `a: tidy the list`, are not).
function winShareOrDriveRelative(text) {
  const w = winReal(text);
  if (/^\\\\[^\\\s]+\\[^\\\s]/.test(w)) return true;
  return !text.startsWith('/') && /^[A-Za-z]:(?:$|[^\\/\s])/.test(w);
}

function winUnplaceable(cmd, part, p) {
  if (platformOf(p) !== 'win32') return false;
  const info = headOf(cmd, platformOf(p));
  if (adminReads(info.head, info.rest)) return false; // only a read: let it through
  const home = p && typeof p.home === 'string' && p.home ? p.home : null;
  // The Windows spelling of each word (backslashes kept, as the system reads them): Bash's own reading strips an
  // unquoted backslash, which would turn an absolute `C:\Users\…` into a drive-relative-looking `C:Users…`.
  const words = shellWords(part.includes('\\') ? part.replace(/\\/g, '\\\\') : part, { home, platform: 'win32' });
  const cwd = p && typeof p.cwd === 'string' && path.win32.isAbsolute(p.cwd) ? p.cwd : null;
  for (const t of pathTexts(words)) {
    if (t.unsure) continue;
    const w = winReal(t.text);
    if (winShareOrDriveRelative(t.text)) return true;
    // An 8.3 short part in a path that cannot be placed (relative, with no known folder). A placed path is compared
    // part by part with Hoprig's folders (winShortHits); a word with no separator (`HEAD~1`) is no such path here.
    if (!cwd && /[\\/]/.test(t.text) && !path.win32.isAbsolute(w) && w.split('\\').some(isShort83)) return true;
  }
  return false;
}

// Does `command` name `form` (a folder, or its ~ / $HOME spelling) as a whole path token — at a boundary, so
// `~/.config` is caught and a deeper path (`~/.config/hoprig`) still matches through the trailing separator, but
// `~/.configother` is not. A plain substring check caught the longer name too.
const PATH_EDGE = '[\\s;:=&|()<>"\'`]';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Does `command` name `form` as a whole path token at a boundary? `deep` also matches a path below it (form/…), which
// is right for one of Hoprig's own folders (a file inside it counts) but NOT for a folder merely ABOVE one of them,
// where only the folder itself being named (e.g. moved) counts, never an unrelated sibling inside it. Either way a
// lone trailing slash (`~/.local/`) names the same folder, so it matches too — otherwise `rm -rf ~/.local/` slipped past.
// On Windows a separator of the form is either one (doubled too) and the name is matched without regard to case.
const namesPath = (command, form, deep = false, platform = process.platform) => {
  if (platform === 'win32') {
    const sep = '[\\\\/]';
    const body = form.split(/[\\/]+/).map(escapeRe).join(`${sep}+`);
    const after = deep ? `(${sep}|$|${PATH_EDGE})` : `(${sep}+(?:$|${PATH_EDGE})|$|${PATH_EDGE})`;
    return new RegExp(`(^|${PATH_EDGE})${body}${after}`, 'i').test(command);
  }
  const after = deep ? `(/|$|${PATH_EDGE})` : `(/(?:$|${PATH_EDGE})|$|${PATH_EDGE})`;
  return new RegExp(`(^|${PATH_EDGE})${escapeRe(form)}${after}`).test(command);
};

// A HOPRIG_RUN_FILE/CONFIG_DIR/STATE_DIR variable USED as a value (a $ or ${ expansion; an env access in a program:
// process.env.X, os.environ["X"], getenv('X'), ENV["X"], $ENV{X}; printenv X) or SET for a program it starts
// (X=value …). NOT a bare textual mention — a search pattern (`grep HOPRIG_RUN_FILE`), a commit message or source
// text — which is ordinary work on Hoprig's own code and must go through. The value of the variable never reaches
// the line, so the variable is how such a command names Hoprig's own files.
const HOPRIG_VARS = 'HOPRIG_(?:RUN_FILE|CONFIG_DIR|STATE_DIR)';
const HOPRIG_VAR_USE = new RegExp(
  `\\$\\{?${HOPRIG_VARS}\\b` // $VAR, ${VAR}, "$VAR"
    + `|(?:^|[\\s;&|(])${HOPRIG_VARS}=` // VAR=value, set for a program it starts
    + `|[.\\[{(]\\s*['"]?${HOPRIG_VARS}\\b` // process.env.VAR, environ["VAR"], getenv('VAR'), ENV["VAR"], $ENV{VAR}
    + `|\\bprintenv\\s+(?:-0\\s+)?${HOPRIG_VARS}\\b`, // printenv VAR
);

// On Windows Hoprig's own folders sit in %APPDATA% and %LOCALAPPDATA% (src/paths.mjs), and a session names them most
// plainly through those variables or %USERPROFILE%, in each shell's spelling: `$APPDATA`, `${APPDATA}`,
// `$env:APPDATA` and `${env:APPDATA}` (PowerShell), `%APPDATA%` (cmd), in any case. The line is read with each filled in with its Windows
// default under the home folder, written as `$HOME` with forward slashes (so `$USERPROFILE` alone is the home folder
// as `$HOME` is, and no shell takes a separator away), so the checks below place the path. → the line so filled, or
// null when such a variable stands beside a name of Hoprig's and no home is known: held then (fail closed).
const WIN_ENV_DIRS = Object.freeze({ appdata: ['AppData', 'Roaming'], localappdata: ['AppData', 'Local'], userprofile: [] });
// (Also cmd's delayed spelling `!APPDATA!`, and the home folder as cmd spells it in two parts, `%HOMEDRIVE%%HOMEPATH%`.)
const WIN_ENV_USE = /\$\{(?:env:)?(APPDATA|LOCALAPPDATA|USERPROFILE)\}|\$env:(APPDATA|LOCALAPPDATA|USERPROFILE)\b|%(APPDATA|LOCALAPPDATA|USERPROFILE)%|!(APPDATA|LOCALAPPDATA|USERPROFILE)!|\$(APPDATA|LOCALAPPDATA|USERPROFILE)\b/gi;
const WIN_HOME_PARTS = /%HOMEDRIVE%%HOMEPATH%|!HOMEDRIVE!!HOMEPATH!|\$\{?env:HOMEDRIVE\}?\$\{?env:HOMEPATH\}?/gi;
function winEnvFilled(command, p) {
  const uses = new RegExp(`${WIN_ENV_USE.source}|${WIN_HOME_PARTS.source}`, 'i');
  if (!uses.test(command)) return command;
  if (!(p && typeof p.home === 'string' && p.home)) return /hoprig/i.test(command) ? null : command;
  return command.replace(WIN_HOME_PARTS, '${HOME}').replace(WIN_ENV_USE, (...m) => ['${HOME}', ...WIN_ENV_DIRS[(m[1] || m[2] || m[3] || m[4] || m[5]).toLowerCase()]].join('/'));
}

// One of Hoprig's own variables used as a value the way PowerShell and cmd spell it (`$env:HOPRIG_RUN_FILE`,
// `${env:HOPRIG_STATE_DIR}`, `%HOPRIG_CONFIG_DIR%`, `!HOPRIG_RUN_FILE!`); Windows does not tell the case of a
// variable's name apart.
const WIN_HOPRIG_VAR_USE = new RegExp(`\\$\\{?env:${HOPRIG_VARS}\\b|%${HOPRIG_VARS}%|!${HOPRIG_VARS}!`, 'i');

// A line with every administrative share of a drive written as the drive it reaches (`\\localhost\C$\Users` →
// `C:\Users`, with either separator, doubled as a quoted text may hold them, and the `\\?\UNC\` and `\\.\UNC\`
// spellings), so a path through a share that stands INSIDE a command text is matched as the plain path is.
const WIN_SHARE_IN_TEXT = /(^|[\s"'`;|&()<>=,])[\\/]{2,}(?:[?.][\\/]+UNC[\\/]+)?[^\\/\s"'`;|&()<>]+[\\/]+([A-Za-z])\$(?=[\\/]|$|[\s"'`;|&()<>])/gi;
// (A share with nothing after it is the drive's root, never the drive-relative `C:`: written `C:/`, since Bash's
// reading takes a backslash at the end of a word away.)
const winSharesAsDrives = (command) => command.replace(WIN_SHARE_IN_TEXT, (m, before, drive, at) => `${before}${drive}:${/[\\/]/.test(command[at + m.length] || '') ? '' : '/'}`);

// On Windows a path that stands inside a command text (`bash -c "mv C:/Users/RUNNER~1/AppData /tmp/x"`, `bash -c "cat
// /c/Users/alex/.config/hoprig/config.json"`) is no word of its own, so only the match of the text reads it, and that
// match knows one spelling of each folder. Each place such a text names is therefore asked as a path word is
// (hitsHoprig: either separator, a Git-Bash drive, `..`, an 8.3 short part): from a drive, a Git-Bash drive, `~` or
// `$HOME`, up to the next blank and up to the next quote (a name may hold a blank). The home folder itself written as
// `~/` or `$HOME/` is no touch, as it is none for a path word.
const WIN_PATH_START = /(^|[\s"'`;|&()<>=,])(?=[A-Za-z]:[\\/]|\/[A-Za-z]\/|~[\\/]|\$\{?HOME\}?[\\/])/g;
// A place that is a word of its own is read by the word loop; here are read the places inside a quoted word that is
// more than one place (it holds a blank, one of the signs that part a command's words, `"cat</c/Users/…"`, for cmd a
// comma too, or the place begins further in, `'{"path":"C:/…"}'`), and the places outside quotes that stand right
// behind such a sign (`type,C:\Users\…`, `type,"C:\Users\…"`). No real line names more of them than
// WIN_TEXT_PLACES: past that the line is held, not read on.
// A place inside a text is compared as it is written, with Hoprig's folders and their real places: the disk is not
// asked where a link in that place may lead, as it is for a path word (the match of the text never did that either).
// Measured on a real Windows computer of a build service, asking the disk for each of 60 places in one text took
// 750 to 1700 ms (a text read up to its closing quote is one long made-up path, and every part of it was asked);
// the hook that asks has five seconds for a line.
const WIN_TEXT_PLACES = 64;
const TEXT_SIGNS = /[\s<>|;&(),=]/;
const WIN_PLACE_BEHIND_SIGN = /([<>|;&(),])(?=[A-Za-z]:[\\/]|\/[A-Za-z]\/|~[\\/]|\$\{?HOME\}?[\\/])/g;
// A place joined on to a short option (`curl -o/c/Users/…`, `7z x -o"C:/Users/…"`): no word of its own either. A
// quoted word joined on to anything before it is kept in `outside` without its quotes, so it is read here.
const WIN_PLACE_BEHIND_OPTION = /(^|\s)-[A-Za-z](?=[A-Za-z]:[\\/]|\/[A-Za-z]\/|~[\\/]|\$\{?HOME\}?[\\/])/g;
// → { texts: the quoted words, outside: the line with every quoted word blanked out, but one that stands right behind
// a sign kept without its quotes (cmd reads `type,"C:\x"` as `type "C:\x"`) }
function quotedTexts(command) {
  const texts = [];
  let outside = '';
  let q = null;
  let from = 0;
  let cut = 0;
  const take = (to) => {
    const text = command.slice(from, to);
    texts.push(text);
    const glued = from >= 2 && /\S/.test(command[from - 2]); // joined on to what stands before it: a sign, an option
    outside += `${command.slice(cut, from - 1)}${glued ? `${text}  ` : ` ${' '.repeat(text.length)} `}`;
    cut = Math.min(command.length, to + 1);
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q === null) {
      if (c === '\\') i++;
      else if (c === '"' || c === "'") {
        q = c;
        from = i + 1;
      }
    } else if (c === '\\' && q === '"') i++;
    else if (c === q) {
      take(i);
      q = null;
    }
  }
  if (q !== null) take(command.length); // a quote left open: read to the end
  return { texts, outside: outside + command.slice(cut) };
}
function winTextHits(command, p, cwd) {
  if (platformOf(p) !== 'win32') return false;
  const home = p && typeof p.home === 'string' && p.home ? p.home : null;
  const dirs = (p && Array.isArray(p.hoprig) ? p.hoprig : []).filter((d) => typeof d === 'string' && d);
  if (!dirs.length) return false;
  const roots = [...new Set(dirs.flatMap((d) => [d, realOrSelf(d, 'win32')]))];
  const homes = home ? [...new Set([home, realOrSelf(home, 'win32')])] : [];
  const from = typeof cwd === 'string' && path.win32.isAbsolute(cwd) ? cwd : null;
  // In one of Hoprig's folders, one of them, or a folder that holds one up to home (insideHoprig and aroundHoprig, as
  // written), or the same through an 8.3 short part (winShortHits, which asks no disk).
  const hits = (t) => winShortHits(t, p, cwd) || withShareDrive(t, 'win32').some((one) => {
    const w = winReal(one);
    const abs = path.win32.isAbsolute(w) ? path.win32.normalize(w) : from ? path.win32.resolve(from, w) : null;
    if (!abs) return false;
    return roots.some((d) => inFolder(abs, d, 'win32')) || (homes.some((h) => inFolder(abs, h, 'win32')) && roots.some((d) => inFolder(d, abs, 'win32')));
  });
  const asked = new Set();
  let places = 0;
  const { texts, outside } = quotedTexts(command);
  const read = (text, starts) => {
    for (const m of text.matchAll(starts)) {
      if (starts === WIN_PATH_START && m.index === 0 && !TEXT_SIGNS.test(text)) continue; // a word of its own: the word loop reads it
      if (++places > WIN_TEXT_PLACES) return true;
      const rest = text.slice(m.index + m[0].length);
      for (const e of new Set([rest.search(/[\s"'`;|&()<>,]/), rest.search(/[\s"'`;|&()<>]/), rest.search(/["'`;|&<>]/)])) {
        let t = e < 0 ? rest : rest.slice(0, e);
        if (/^(?:~|\$)/.test(t)) {
          if (!home) continue;
          t = t.replace(/^(?:~|\$\{?HOME\}?)/, home);
          if (samePlace(t, home, 'win32') || winSameShort(t, home)) continue;
        }
        if (!t || asked.has(t)) continue;
        asked.add(t);
        if (hits(t)) return true;
      }
    }
    return false;
  };
  return texts.some((text) => read(text, WIN_PATH_START)) || read(outside, WIN_PLACE_BEHIND_SIGN) || read(outside, WIN_PLACE_BEHIND_OPTION);
}

// Does a shell line move, write or otherwise touch Hoprig's own files? Held three ways, because the value of a
// variable or of ~ never reaches the line: (1) by USING a HOPRIG_* variable as a value or SETTING it for a program
// it starts (HOPRIG_VAR_USE — not a bare mention in a search or a commit message); (2) by a literal path in those
// folders, their real location, or their ~/$HOME form, and the folders above them up to home; (3) by any path
// argument that, resolved against cwd, lands inside them (a `..` or a plain relative path). The wall leans to
// holding: a value use that only reads these files is held too, since the reader cannot tell a read from a write
// with certainty and a session poking at the rules it runs under is the owner's.
function touchesHoprig(command, p, cwd, sharesRead = false) {
  if (HOPRIG_VAR_USE.test(command)) return true;
  if (platformOf(p) === 'win32') {
    if (WIN_HOPRIG_VAR_USE.test(command)) return true;
    const filled = winEnvFilled(command, p);
    if (filled === null) return true; // a Windows folder variable the wall cannot fill in, beside a name of Hoprig's
    command = filled;
    // The same line with each share of a drive written as that drive: what it then touches, it touches.
    if (!sharesRead) {
      const drives = winSharesAsDrives(command);
      if (drives !== command && touchesHoprig(drives, p, cwd, true)) return true;
    }
  }
  const dirs = (p && Array.isArray(p.hoprig) ? p.hoprig : []).filter((d) => typeof d === 'string' && d);
  if (!dirs.length) return false;
  const home = p && typeof p.home === 'string' && p.home ? p.home : null;
  const platform = platformOf(p);
  // Hoprig's own folders (a file inside one counts: `deep`), and the folders ABOVE them up to home (only the folder
  // itself being named counts, e.g. a move of it, never an unrelated sibling inside it). Both the configured path and
  // its real location.
  const own = new Set();
  const above = new Set();
  for (const d0 of dirs) {
    for (const base of new Set([d0, realOrSelf(d0, platform)])) {
      own.add(base);
      // (On Windows also where home and this folder each come in another of the two spellings: aboveUpToHome.)
      if (home) for (const a of aboveUpToHome(base, home, platform)) above.add(a);
    }
  }
  // A folder by its literal path and, for one below home, its ~ and $HOME spellings (a bare ~ or $HOME, for home
  // itself, is skipped: it would catch an ordinary command that merely names the home folder). On Windows the part
  // below home is matched with either separator (namesPath), as a command may write it either way.
  const named = (d, deep) => {
    if (namesPath(command, d, deep, platform)) return true;
    // On Windows the folder below home may be spelled with an 8.3 part where home is long, or the other way
    // (`C:\Users\RUNNER~1\AppData\…` beside `C:\Users\runneradmin`): its parts below home are read part by part.
    const winRest = () => {
      const dp = patternParts(d, null, 'win32');
      const hp = patternParts(home, null, 'win32');
      return dp && hp && dp.length > hp.length && winStarts(dp, hp) ? `\\${dp.slice(hp.length).join('\\')}` : null;
    };
    const s = !home ? null : below(d, home, platform) ? (platform === 'win32' ? `\\${path.win32.relative(home, d)}` : d.slice(home.length)) // e.g. "/.config/hoprig"
      : platform === 'win32' ? winRest() : null;
    if (s && ['~', '$HOME', '${HOME}'].some((h) => namesPath(command, `${h}${s}`, deep, platform))) return true;
    return false;
  };
  for (const d of own) if (named(d, true)) return true;
  for (const d of above) if (named(d, false)) return true;
  // A path argument that resolves to, into or around one of Hoprig's folders, each word read as the shell hands it
  // to the program (shellWords: `~`, `$HOME`, quotes, a doubled separator, `.` and `..` are one folder however it is
  // written). A word whose value cannot be told is left to the string match above; a pattern counts where the
  // folder it is matched in is one of Hoprig's own. The home folder ITSELF written as `~` or `$HOME` is not a touch
  // for an ordinary command (it would hold a plain `cd ~`): what an administrator command does to it is read by
  // behindAdmin.
  const homeReal = home ? realOrSelf(home, platform) : null;
  for (const t of pathTexts(wordsOf(command, home, platform))) {
    if (t.unsure) continue;
    if (t.glob) {
      if (insideHoprig(t.text, p, cwd)) return true;
      continue;
    }
    // A bare word (no separator) is resolved against the folder the shell stands in too: after a `cd` the wall
    // follows (`cd ~ && mv .config old`), `.config` is the folder above Hoprig's own, so its move is held. Resolved
    // against an ordinary folder a bare word lands nowhere near Hoprig, so hitsHoprig leaves it through.
    if (t.home && placesOf(t.text, cwd, platform).some((rp) => samePlace(rp, home, platform) || samePlace(rp, homeReal, platform))) continue;
    if (hitsHoprig(t.text, p, cwd)) return true;
  }
  if (globTouchesHoprig(command, p, cwd)) return true;
  if (winTextHits(command, p, cwd)) return true;
  return false;
}

// ---- a wildcard or a brace list that could name one of Hoprig's own folders ----
// A word with a wildcard (`*`, `?`, `[...]`) or a brace list ({a,b}) does not spell out the path it names, so it is
// compared part by part with each of Hoprig's own folders and with the folders above them (up to home): where a
// plain path the pattern could stand for would be held today, the pattern is held too. A pattern part that is a
// wildcard is matched as able to begin with a dot (a session may turn on `dotglob`), so `*` could name `.config`
// — where in doubt, the wall holds.

// One path component against a glob part (`*`, `?`, `[...]` as in the shell; a leading dot is NOT special here, so a
// wildcard may match a dotfile). A part with no wildcard matches only an equal name.
function globPartMatches(pat, name) {
  if (!/[*?[]/.test(pat)) return pat === name;
  let re = '^';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const close = pat.indexOf(']', i + 1);
      if (close < 0) { re += '\\['; continue; }
      re += `[${pat.slice(i + 1, close).replace(/^!/, '^')}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(`${re}$`).test(name); } catch { return true; } // a pattern this reader cannot form: held
}

// Expand a word's simple comma brace lists (`{a,b}`) into the plain alternatives; a brace that is not such a list is
// left as text (a Hoprig folder name has no brace, so it never matches one).
function braceExpand(s, depth = 0) {
  if (depth > 6) return [s];
  const i = s.indexOf('{');
  if (i < 0) return [s];
  const j = s.indexOf('}', i + 1);
  if (j < 0) return [s];
  const inner = s.slice(i + 1, j);
  if (!inner.includes(',') || inner.includes('/')) return braceExpand(s.slice(j + 1), depth + 1).map((r) => s.slice(0, j + 1) + r);
  return inner.split(',').flatMap((a) => braceExpand(s.slice(0, i) + a + s.slice(j + 1), depth + 1));
}

// A path (its wildcard parts kept) as absolute components, `.` and `..` resolved; null when it cannot be placed.
// On Windows a place names its parts with either separator and without regard to case, so both sides are split on
// either and compared in lower case there.
function patternParts(patt, cwd, platform = process.platform) {
  const win = platform === 'win32';
  const rooted = (s) => (win ? path.win32.isAbsolute(s) : s.startsWith('/'));
  let abs;
  if (rooted(patt)) abs = patt;
  else if (typeof cwd === 'string' && rooted(cwd)) abs = `${cwd}/${patt}`;
  else return null;
  // A `/c/` or `\\?\` prefix, and a trailing dot/space, as the system reads them: of the folder the pattern is read
  // from too, so it is spelled as the folders it is compared with (patternNames). An administrative share of a drive
  // is read as the drive path it reaches (winShareDrive), so a pattern or a short part written through it is compared
  // with Hoprig's folders as the plain spelling is.
  if (win) abs = winShareDrive(abs) || winReal(abs);
  const out = [];
  for (const part of abs.split(win ? /[\\/]/ : '/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(win ? part.toLowerCase() : part);
  }
  return out;
}

// Could the pattern (its components) name `target` — for an own folder (`deep`) the folder itself or a path inside
// it, for a folder above it only the folder itself?
function patternNames(patParts, target, deep, platform = process.platform) {
  const win = platform === 'win32';
  // On Windows the folder is read with the same spelling rules as the pattern (patternParts), so a `/w/…` named both
  // ways meets itself.
  const t = (win ? winReal(target) : target).split(win ? /[\\/]/ : '/').filter((s) => s && s !== '.').map((s) => (win ? s.toLowerCase() : s));
  if (patParts.length < t.length || (!deep && patParts.length !== t.length)) return false;
  // On Windows a part with `~<digit>` may be a volume's 8.3 short name (`RUNNER~1` for `runneradmin`), which cannot be
  // expanded here: such a part, on either side, could be the other (the wall leans to holding).
  const short = (s) => win && /~\d/.test(s);
  return t.every((part, k) => short(part) || short(patParts[k]) || globPartMatches(patParts[k], part));
}

// The folders above `dir`, nearest first, up to and including `home` (none when `dir` is not below home).
function foldersUpToHome(dir, home, platform) {
  const P = pathOf(platform);
  const out = [];
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    const parent = P.dirname(cur);
    if (parent === cur || !inFolder(parent, home, platform)) break;
    out.push(parent);
    if (samePlace(parent, home, platform)) break;
    cur = parent;
  }
  return out;
}

// On Windows the home folder and Hoprig's folders may each come in another of the two spellings (`C:\Users\runneradmin`
// beside `C:\Users\RUNNER~1\AppData\…`: the system gives os.homedir() and %APPDATA% apart). The plain walk up
// (foldersUpToHome) then finds no folder above, since neither spelling is inside the other as written: here the two
// are compared part by part, a short part standing for the long one it could be made from (winStarts), and the
// folders above `dir` up to and including home are given in `dir`'s own spelling.
function winFoldersUpToHome(dir, home) {
  const dp = patternParts(dir, null, 'win32');
  const hp = patternParts(home, null, 'win32');
  if (!dp || !hp || dp.length <= hp.length || !winStarts(dp, hp)) return [];
  const out = [];
  for (let n = dp.length - 1; n >= hp.length; n--) out.push(dp.slice(0, n).join('\\'));
  return out;
}

// The folders above `dir` up to and including home: the plain walk, and on Windows, where that finds none, the walk
// part by part (the two spellings).
function aboveUpToHome(dir, home, platform) {
  const plain = foldersUpToHome(dir, home, platform);
  return plain.length || platform !== 'win32' ? plain : winFoldersUpToHome(dir, home);
}

// Does a wildcard or brace-list word of `command` name one of Hoprig's own folders, a file in one, or (as the folder
// itself) a folder above one of them, up to home? Read through the real place of each folder too, as the plain-path
// check is. A word with an unresolvable `$` reference is left alone (its folder cannot be told); a `$HOME`/`~` is
// filled in by shellWords, so a pattern written from the home folder is placed like any other.
function globTouchesHoprig(command, p, cwd) {
  const dirs = (p && Array.isArray(p.hoprig) ? p.hoprig : []).filter((d) => typeof d === 'string' && d);
  if (!dirs.length) return false;
  const home = p && typeof p.home === 'string' && p.home ? p.home : null;
  const platform = platformOf(p);
  const own = [...new Set(dirs.flatMap((d) => [d, realOrSelf(d, platform)]))];
  const above = new Set();
  if (home) for (const d0 of own) for (const a of aboveUpToHome(d0, home, platform)) above.add(a);
  for (const w of wordsOf(command, home, platform)) {
    // On Windows a program expands a wildcard itself (Bash hands a quoted `*` on as it is), so there a quoted word with
    // `*` or `?` is a pattern too (`cat "C:\Users\alex\AppData\Roaming\hop*\config.json"`).
    const isGlob = (w.glob || (platform === 'win32' && /[*?]/.test(w.value))) && !w.unsure;
    const isBrace = w.unsure && (w.home || !w.vars) && /\{[^{}]*,[^{}]*\}/.test(w.value);
    if (!isGlob && !isBrace) continue;
    let t = w.value;
    const eq = t.indexOf('=');
    if (t.startsWith('-')) { if (eq < 0) continue; t = t.slice(eq + 1); } // an option, not a path
    else if (eq > 0 && !t.slice(0, eq).includes('/')) t = t.slice(eq + 1); // NAME=value: the value may be a path
    for (const one of braceExpand(t)) {
      const pp = patternParts(one, cwd, platform);
      if (!pp) continue;
      if (own.some((d) => patternNames(pp, d, true, platform))) return true;
      for (const d of above) if (patternNames(pp, d, false, platform)) return true;
    }
  }
  return false;
}

// A reason id (from the readers, or 'unreadable' from walk) → { kind (the coarse group shown on the card and kept in
// the record), reason (the plain words shown) }. Fine-grained ids share a coarse kind so the card groups them.
const COARSE = Object.freeze({ 'push-prune': 'push', 'push-elsewhere': 'push', 'push-nodefault': 'push', 'merge-elsewhere': 'merge' });
// `part`: what of the call is the owner's (the command of a longer line that was held, or the file a tool would write);
// `whole`: the whole command or file, so the card can say the part is only a part of it.
const heldReason = (id, part = '', whole = '') => ({ kind: COARSE[id] || id, why: WALL_REASON[id] ? id : UNREADABLE, reason: WALL_REASON[id] || WALL_REASON.unreadable, part, partOf: !!part && part !== whole });

// What the card says first: which of his acts it is, in a few plain words (one per reason id of WALL_REASON).
export const WALL_TITLE = Object.freeze({
  admin: 'Administrator rights',
  release: 'Publishing or a release',
  pr: 'A pull request',
  'api-write': 'A direct call to GitHub or GitLab',
  push: 'A push to the main branch or a tag',
  'push-prune': 'A push that deletes branches',
  'push-elsewhere': 'A push Hoprig cannot place',
  'push-nodefault': 'A push Hoprig cannot check',
  merge: 'A merge into the main branch',
  'merge-elsewhere': 'A merge Hoprig cannot place',
  'delete outside': 'A delete outside the session\'s folder',
  deploy: 'A deploy',
  project: 'A change to project.json',
  settings: 'Hoprig\'s own files',
  unreadable: 'A command Hoprig cannot read',
});

// What the card and the terminal say: why this is his, in plain words.
export const WALL_REASON = Object.freeze({
  admin: 'This asks for administrator rights, which stay yours even with Hands-off on.',
  release: 'This would publish or release, or change what is already published, which stays yours even with Hands-off on.',
  pr: 'This would open or merge a pull request, which stays yours even with Hands-off on.',
  'api-write': 'This calls GitHub or GitLab directly in a way that can change something there, and Hoprig cannot tell what it would change, so it is left to you.',
  push: 'This would move a default branch or a tag, which stays yours even with Hands-off on.',
  'push-prune': 'This would delete remote branches, by name or with a pruning push, which stays yours even with Hands-off on.',
  'push-elsewhere': 'Hoprig cannot tell where this push would go: the line changes folder or points git at another repository before it, or a variable names where it goes. So it is left to you.',
  'push-nodefault': 'Hoprig cannot tell which branch is the default of this repository, so it holds every push here. Run `git remote set-head origin -a` once so it can tell; then a push to a branch that is not the default goes through.',
  merge: 'This would merge or rebase into the default branch, which stays yours even with Hands-off on.',
  'merge-elsewhere': 'The line changes folder, or points git at another repository, before this merge, so Hoprig cannot tell which project it would land on, and it is left to you.',
  'delete outside': 'This would delete outside the session\'s own folder, which stays yours even with Hands-off on.',
  deploy: 'This runs a deploy, release or publish script, which stays yours even with Hands-off on.',
  project: 'This creates or changes the project\'s own project.json, which you approve, so it stays yours even with Hands-off on.',
  settings: 'This reads or changes the rules Hoprig runs the session under, which stays yours even with Hands-off on.',
  unreadable: 'Hoprig could not read this command with certainty, so it is left to you.',
});
