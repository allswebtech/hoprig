// A "git server" of local bare repositories and "computers" that are temporary homes, for the map, restore and
// sync tests. Addresses look like a real server's (https://git.example.test/team/<name>.git) and pass the address
// parser; git's insteadOf turns them into the local bare repositories, so nothing leaves this computer.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function gitWorld(name = 'ws-git') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hoprig-${name}-`)));
  const server = path.join(root, 'server');
  fs.mkdirSync(server, { recursive: true });
  const gitcfg = path.join(root, 'gitconfig');
  fs.writeFileSync(gitcfg, `[user]\n\tname = Test Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[url "${server}/"]\n\tinsteadOf = https://git.example.test/\n[protocol "file"]\n\tallow = always\n`);
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  delete process.env.HOPRIG_WORKSPACE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;

  const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const url = (n) => `https://git.example.test/team/${n}.git`;
  /** A bare repository on the "server" with one commit (a README), or empty. */
  const bare = (n, { empty = false } = {}) => {
    const d = path.join(server, 'team', `${n}.git`);
    fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', d]);
    if (!empty) {
      const w = fs.mkdtempSync(path.join(root, 'seed-'));
      sh(w, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(w, 'README.md'), `# ${n}\n`);
      sh(w, 'add', '-A');
      sh(w, 'commit', '-q', '-m', `Start ${n}`);
      sh(w, 'push', '-q', d, 'main');
      fs.rmSync(w, { recursive: true, force: true });
    }
    return url(n);
  };
  /** A computer: its own home, settings, state and Claude folder. use() makes it the current one. */
  const computer = (n) => {
    const home = path.join(root, n);
    const c = {
      home,
      ws: path.join(home, 'Workspace'),
      projects: path.join(home, 'Workspace', 'projects'),
      claude: path.join(home, '.claude'),
      env: { HOME: home, HOPRIG_CONFIG_DIR: path.join(home, '.config', 'hoprig'), HOPRIG_STATE_DIR: path.join(home, '.state'), HOPRIG_PROFILES_DIR: path.join(home, '.profiles'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    };
    fs.mkdirSync(home, { recursive: true });
    c.use = () => Object.assign(process.env, c.env);
    return c;
  };
  const commit = (dir, file, text, msg = `change ${file}`) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', msg);
    return sh(dir, 'rev-parse', 'HEAD');
  };
  const clone = (u, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    execFileSync('git', ['clone', '-q', u, dest], { stdio: 'ignore' });
    return dest;
  };
  return { root, server, sh, url, bare, computer, commit, clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A non-interactive setup ui that keeps what it says. */
export async function quietUi() {
  const { makeUi } = await import('../../src/setup/ui.mjs');
  let text = '';
  const ui = makeUi({ interactive: false, write: (s) => (text += s) });
  return { ui, text: () => text };
}
