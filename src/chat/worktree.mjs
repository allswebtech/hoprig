// A chat on a git worktree of its own ("Worktree" in New session's options): a new branch and a copy of the project's
// files under <project>/.claude/worktrees/<name> (where Claude Code's own --worktree puts it, branch worktree-<name>),
// so the chat's changes stay apart from the main checkout. The chat then runs IN that folder, so its history, its
// Branch row and a later restart all find it there. Made by git itself; nothing is committed.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const git = (cwd, args) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? null : String(out).trim()));
});

const LINE = '.claude/worktrees/';

/** The line in the repository's own local exclude file (its common git folder's info/exclude: a tracked file of his is never
 * changed), once, his other lines as they are. → true when it is there. */
async function hideFromGit(top) {
  try {
    const common = await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common) return false;
    const file = path.join(common, 'info', 'exclude');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* none yet */
    }
    if (text.split(/\r?\n/).some((l) => l.trim() === LINE || l.trim() === `/${LINE}` || l.trim() === '.claude/worktrees' || l.trim() === '/.claude/worktrees')) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${LINE}\n`);
    return true;
  } catch {
    return false;
  }
}

/** → { dir, branch, name, note? } of the new worktree, or { why } (a sentence: not a git folder, git said no). */
export async function makeWorktree(dir) {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return { why: 'this folder is not a git repository, so Worktree was left out' };
  const hidden = await hideFromGit(top);
  const name = `chat-${crypto.randomBytes(3).toString('hex')}`;
  const made = path.join(top, '.claude', 'worktrees', name);
  const branch = `worktree-${name}`;
  const done = await git(top, ['worktree', 'add', '-b', branch, made]);
  if (done === null) return { why: 'git could not make a worktree here (does the repository have a first commit?), so Worktree was left out' };
  // Where the chat was opened inside the repository (a subfolder), the same place in the worktree.
  // git names the top by its real path (on a Mac /var is a link to /private/var), so the folder is compared by its real path too.
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* not there: the name as given */
  }
  const rel = path.relative(top, real);
  const target = rel && !rel.startsWith('..') ? path.join(made, rel) : made;
  // The copy holds the tracked files only: a folder the repository ignores or has not committed is not in it, and a chat
  // opened there would find no folder. Then the worktree and its branch are taken away again.
  if (!fs.existsSync(target)) {
    await git(top, ['worktree', 'remove', '--force', made]);
    await git(top, ['branch', '-D', branch]);
    return { why: 'this folder is not among the repository\'s files, so Worktree was left out' };
  }
  return { dir: target, branch, name, ...(hidden ? {} : { note: 'Hoprig could not keep the worktree folder out of the project\'s git changes: add .claude/worktrees/ to .git/info/exclude yourself.' }) };
}
