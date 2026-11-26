// Fixtures for the skills manager: a sandbox (its own Claude folder, state and config under the OS temp folder),
// throw-away projects, skill folders and local git repositories (file:// URLs, so no network is needed).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

export { sandbox };

/** Write files { 'rel/path': content } below `dir`. */
export function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

export const skillMd = (name, body = 'Do the task carefully.\n', extra = '') => `---\nname: ${name}\ndescription: A ${name} skill for tests.\n${extra}---\n\n# ${name}\n\n${body}`;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A git repository with `files`, one commit. Returns { dir, url, commit(files?) → new commit id, head() }. */
export function gitRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  // Let the shallow fetch of a commit id work over file:// as it does on GitHub.
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(dir, 'config', 'uploadpack.allowFilter', 'true');
  const commit = (more = {}, remove = []) => {
    writeTree(dir, more);
    for (const r of remove) fs.rmSync(path.join(dir, r), { force: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change', '--allow-empty');
    return git(dir, 'rev-parse', 'HEAD');
  };
  const first = commit(files);
  // A file:// address Git reads on every system: file:///C:/… on Windows, file:///tmp/… elsewhere.
  return { dir, url: pathToFileURL(dir).href, first, commit, head: () => git(dir, 'rev-parse', 'HEAD'), git: (...a) => git(dir, ...a) };
}

/** A UI for runSkillsStep / the CLI that records what it said and answers questions from a list. */
export function fakeUi(answers = []) {
  const said = [];
  const asked = [];
  return { said, asked, say: (l) => said.push(String(l)), confirm: async (q) => (asked.push(q), Boolean(answers.shift())) };
}
