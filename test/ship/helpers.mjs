// A temporary computer for the go-live tests: its own home, settings, state and workspace, a git identity of its own,
// and TRAPS first on the PATH. sudo, npm, systemctl, loginctl, apt-get, brew and ssh write down that they were called
// and fail; git fails loudly on `push` and passes every other call to the real git. A test reads `trapped()` at its
// end: nothing of Go live may ever reach one of them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealedPath } from '../seal.mjs';

const TRAPS = ['sudo', 'npm', 'systemctl', 'loginctl', 'apt-get', 'brew', 'ssh'];

/** The real git's full path (found before the traps go on the PATH). */
function realGit() {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, 'git');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  throw new Error('no git on the PATH');
}

export function tempShip(name = 'ship') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hoprig-${name}-`)));
  const home = path.join(root, 'home');
  const ws = path.join(home, 'Workspace');
  const projects = path.join(ws, 'projects');
  const server = path.join(root, 'server');
  const traps = path.join(root, 'traps');
  const trapLog = path.join(root, 'trapped.log');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(traps);
  const git = realGit();
  for (const t of TRAPS) fs.writeFileSync(path.join(traps, t), `#!/bin/sh\necho "${t} $*" >> '${trapLog}'\necho "trap: ${t} must not run here" >&2\nexit 97\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(traps, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ]; then echo "git $*" >> '${trapLog}'; echo "trap: git push must not run here" >&2; exit 97; fi; done\nexec '${git}' "$@"\n`, { mode: 0o755 });
  const gitcfg = path.join(root, 'gitconfig');
  fs.writeFileSync(gitcfg, '[user]\n\tname = Test Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  Object.assign(process.env, {
    HOME: home,
    HOPRIG_CONFIG_DIR: path.join(root, 'config'),
    HOPRIG_STATE_DIR: path.join(root, 'state'),
    HOPRIG_PROFILES_DIR: path.join(root, 'profiles'),
    HOPRIG_WORKSPACE_DIR: ws,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GIT_CONFIG_GLOBAL: gitcfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // These tests' traps first (a temporary folder), then the runner's seal, then the computer's folders.
    PATH: sealedPath([traps, ...String(process.env.PATH || '').split(path.delimiter)]),
  });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  /** A repository at `dir` with one commit, and a bare "server" beside it as its origin (set up with the real git). */
  const repo = (dir, files = { 'README.md': '# repo\n' }) => {
    const bare = path.join(server, `${path.basename(dir)}.git`);
    fs.mkdirSync(bare, { recursive: true });
    execFileSync(git, ['init', '-q', '--bare', '-b', 'main', bare]);
    fs.mkdirSync(dir, { recursive: true });
    run(dir, 'init', '-q', '-b', 'main');
    write(dir, files);
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', 'Start');
    run(dir, 'remote', 'add', 'origin', bare);
    execFileSync(git, ['-C', dir, 'push', '-q', '-u', 'origin', 'main'], { stdio: 'ignore' });
    return bare;
  };
  /** A branch `name` from main with `files` committed (the owner's checkout goes back to main after). */
  const branch = (dir, name, files, message = `Task ${name}`) => {
    run(dir, 'checkout', '-q', '-b', name, 'main');
    write(dir, files);
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', message);
    run(dir, 'checkout', '-q', 'main');
  };
  const trapped = () => {
    try {
      return fs.readFileSync(trapLog, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { root, home, ws, projects, server, traps, git: run, repo, branch, trapped, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write files { 'rel/path': content } below `dir`. */
export function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, typeof content === 'string' && rel.endsWith('.sh') ? { mode: 0o755 } : undefined);
  }
  return dir;
}

/**
 * The owner's checkout as it is, to compare before and after: HEAD, every ref, the index, the stash, the config, every
 * file but .git with its bytes.
 */
export function checkoutState(dir) {
  const g = (...a) => {
    try {
      return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return '';
    }
  };
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (d === dir && e.name === '.git') continue;
      if (e.isDirectory()) walk(p);
      else files[path.relative(dir, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return {
    head: g('rev-parse', 'HEAD'),
    sym: g('symbolic-ref', '-q', 'HEAD'),
    refs: g('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/stash'),
    index: g('ls-files', '-s'),
    config: fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'),
    files,
  };
}
