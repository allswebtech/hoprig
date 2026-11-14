// A temporary home for the workspace tests: its own HOME, settings, state and Claude folder, and a git identity
// of its own (never the real one's).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempHome(name = 'ws') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hoprig-${name}-`)));
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const gitcfg = path.join(root, 'gitconfig');
  fs.writeFileSync(gitcfg, '[user]\n\tname = Test Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  Object.assign(process.env, {
    HOME: home,
    HOPRIG_CONFIG_DIR: path.join(root, 'config'),
    HOPRIG_STATE_DIR: path.join(root, 'state'),
    HOPRIG_PROFILES_DIR: path.join(root, 'profiles'),
    CLAUDE_CONFIG_DIR: claude,
    GIT_CONFIG_GLOBAL: gitcfg,
    GIT_CONFIG_NOSYSTEM: '1',
  });
  delete process.env.HOPRIG_WORKSPACE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  return { root, home, claude, ws: path.join(home, 'Workspace'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write files { 'rel/path': content } below `dir`. */
export function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
