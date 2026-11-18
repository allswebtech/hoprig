// A temporary computer for the Work tests: its own home, settings, state and workspace (an AI brain and two
// projects, each a git repository with a local bare "server"), and a git identity of its own (never the real one's).
// fixtures/deadlines.json is a list in the planning tool's shape with made-up names, written exactly as that tool
// writes it (two spaces, a final newline), with keys Work does not know ("x-color", "flags", "gateOf", "updated").
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deadlines.json');

export function tempWork(name = 'work') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hoprig-${name}-`)));
  const home = path.join(root, 'home');
  const ws = path.join(home, 'Workspace');
  const brain = path.join(ws, 'ai_brain');
  const projects = path.join(ws, 'projects');
  const server = path.join(root, 'server');
  fs.mkdirSync(home, { recursive: true });
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
  });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  /** A repository at `dir` with one commit, pushed to its own bare "server" repository (its upstream). */
  const repo = (dir, files = { 'README.md': '# repo\n' }) => {
    const bare = path.join(server, `${path.basename(dir)}.git`);
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Start');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    return bare;
  };
  /** Another clone of the server repository (another computer), to move the server on. */
  const otherClone = (bare) => {
    const d = fs.mkdtempSync(path.join(root, 'other-'));
    execFileSync('git', ['clone', '-q', bare, d], { stdio: 'ignore' });
    return d;
  };
  return { root, home, ws, brain, projects, server, git, repo, otherClone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write files { 'rel/path': content } below `dir`. */
export function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
