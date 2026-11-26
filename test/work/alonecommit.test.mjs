// The commit the dashboard makes for a run that has no git of its own (src/work/alonecommit.mjs): one commit of
// exactly the bytes in the run's worktree, with nothing of the repository's own started for it. Real git, in a
// temporary folder, with settings of the test's own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-alonecommit-'));
fs.writeFileSync(path.join(tmp, 'gitconfig'), '[user]\n\tname = Test Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.HOME);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { commitRun, gitEntryOf, steersTools } = await import('../../src/work/alonecommit.mjs');

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const text = (cwd, ...a) => git(cwd, ...a).toString().trim();
let n = 0;
/** A repository with two files on main, and a linked worktree of it on a branch of its own (as a run gets one). */
function made({ config = [] } = {}) {
  n += 1;
  const top = path.join(tmp, `repo-${n}`);
  const dir = path.join(tmp, `tree-${n}`);
  fs.mkdirSync(top);
  git(top, 'init', '-q', '-b', 'main');
  for (const [k, v] of config) git(top, 'config', k, v);
  fs.writeFileSync(path.join(top, 'README.md'), '# a project\n');
  fs.writeFileSync(path.join(top, 'old.txt'), 'old\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'Start');
  git(top, 'worktree', 'add', '-q', '-b', 'work/task', dir, 'HEAD');
  return { top, dir, main: text(top, 'rev-parse', 'main'), entry: gitEntryOf(dir) };
}
const canary = (top) => path.join(top, 'CANARY');
/** A program of the repository's own that would leave a file behind if it were ever started. */
const leavesCanary = (top) => `#!/bin/sh\necho started >> '${canary(top)}'\nexit 0\n`;

test('one commit of exactly the bytes in the folder, on the run\'s own branch; the index follows and nothing else moves', async () => {
  const r = made({ config: [['core.autocrlf', 'true']] }); // the owner's setting would rewrite line endings on a "git add"
  const bytes = Buffer.from('one\r\ntwo\r\n\x00three');
  fs.mkdirSync(path.join(r.dir, 'src'));
  fs.writeFileSync(path.join(r.dir, 'src', 'new file.txt'), bytes);
  fs.writeFileSync(path.join(r.dir, 'README.md'), '# a project\n\nchanged\r\n');
  fs.rmSync(path.join(r.dir, 'old.txt'));
  const c = await commitRun(r.dir, { message: 'Work on "the task"', gitEntry: r.entry });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.match(c.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual([...c.files].sort(), ['README.md', 'old.txt', 'src/new file.txt']);
  assert.equal(text(r.top, 'rev-parse', 'work/task'), c.sha, 'the run\'s branch stands on the commit');
  assert.equal(text(r.top, 'rev-parse', 'main'), r.main, 'the default branch did not move');
  assert.equal(text(r.top, 'rev-list', '--count', `${r.main}..work/task`), '1', 'one commit');
  assert.equal(text(r.top, 'log', '-1', '--format=%s', c.sha), 'Work on "the task"');
  assert.deepEqual(git(r.top, 'cat-file', 'blob', `${c.sha}:src/new file.txt`), bytes, 'the bytes as they are in the folder, line endings and all');
  assert.equal(git(r.top, 'cat-file', 'blob', `${c.sha}:README.md`).toString(), '# a project\n\nchanged\r\n');
  assert.equal(text(r.top, 'ls-tree', '-r', '--name-only', c.sha), 'README.md\nsrc/new file.txt', 'the file that is gone is gone from the commit');
  assert.equal(text(r.dir, 'diff', '--cached', '--name-only', c.sha), '', 'the worktree\'s index is the commit');
  // Nothing changed since: no second commit.
  const again = await commitRun(r.dir, { message: 'again', gitEntry: r.entry });
  assert.deepEqual({ ok: again.ok, sha: again.sha }, { ok: true, sha: null });
  assert.equal(text(r.top, 'rev-parse', 'work/task'), c.sha);
});

test('no program of the repository is started for it: not a hook, not a filter its settings name, not a file-system monitor', async () => {
  const r = made();
  const hooks = path.join(r.top, '.git', 'hooks');
  for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'post-checkout']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\necho ${h} >> '${canary(r.top)}'\n`, { mode: 0o755 });
  }
  const prog = path.join(r.top, 'prog.sh');
  fs.writeFileSync(prog, leavesCanary(r.top), { mode: 0o755 });
  git(r.top, 'config', 'filter.mine.clean', prog);
  git(r.top, 'config', 'filter.mine.smudge', prog);
  git(r.top, 'config', 'diff.mine.textconv', prog);
  git(r.top, 'config', 'diff.external', prog);
  git(r.top, 'config', 'core.fsmonitor', prog);
  // What a run could write itself: an attributes file that names those programs for every file.
  fs.writeFileSync(path.join(r.dir, '.gitattributes'), '* filter=mine diff=mine\n');
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'plain\n');
  fs.rmSync(canary(r.top), { force: true }); // what the set-up itself may have started does not count
  const c = await commitRun(r.dir, { message: 'Work', gitEntry: r.entry });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(fs.existsSync(canary(r.top)), false, `a program of the repository was started: ${fs.existsSync(canary(r.top)) ? fs.readFileSync(canary(r.top), 'utf8') : ''}`);
  assert.equal(git(r.top, '-c', 'core.fsmonitor=false', 'cat-file', 'blob', `${c.sha}:a.txt`).toString(), 'plain\n');
  assert.deepEqual([...c.files].sort(), ['.gitattributes', 'a.txt']);
});

test('a worktree whose own git entry is not as the dashboard made it is not committed', async () => {
  const r = made();
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'x\n');
  // As if a run had pointed the folder at a repository of its own making.
  const other = path.join(tmp, `other-${n}`);
  fs.mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  // Changed in place: Git for Windows marks a worktree's .git file hidden, and Windows refuses a new write of a hidden
  // file (EPERM) but not a change of it.
  const fd = fs.openSync(path.join(r.dir, '.git'), 'r+');
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, `gitdir: ${path.join(other, '.git')}\n`, 0);
  } finally {
    fs.closeSync(fd);
  }
  const c = await commitRun(r.dir, { message: 'Work', gitEntry: r.entry });
  assert.equal(c.ok, false);
  assert.match(c.why, /git entry is not as the dashboard made it/);
  assert.equal(text(r.top, 'rev-parse', 'work/task'), r.main, 'nothing was committed');
  assert.equal(gitEntryOf(path.join(tmp, 'no-such-folder')), null);
});

test('a folder with a repository of its own is left out and named; the files that tell a coding tool what to do are named', async () => {
  const r = made();
  const inner = path.join(r.dir, 'vendor', 'lib');
  fs.mkdirSync(inner, { recursive: true });
  git(inner, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(inner, 'x.txt'), 'x\n');
  git(inner, 'add', '-A');
  git(inner, 'commit', '-q', '-m', 'Inner');
  fs.mkdirSync(path.join(r.dir, 'docs'));
  fs.mkdirSync(path.join(r.dir, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'CLAUDE.md'), '# words for the next session\n');
  fs.writeFileSync(path.join(r.dir, 'docs', 'AGENTS.md'), '# more\n');
  fs.writeFileSync(path.join(r.dir, '.cursor', 'rules', 'x.md'), 'x\n');
  fs.writeFileSync(path.join(r.dir, 'docs', 'guide.md'), 'plain\n');
  const c = await commitRun(r.dir, { message: 'Work', gitEntry: r.entry });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(c.skipped, ['vendor/lib/']);
  assert.deepEqual([...c.steers].sort(), ['.cursor/rules/x.md', 'CLAUDE.md', 'docs/AGENTS.md']);
  assert.ok(!text(r.top, 'ls-tree', '-r', '--name-only', c.sha).includes('vendor'), 'the inner repository is not in the commit');
  for (const p of ['CLAUDE.md', 'a/CLAUDE.local.md', 'AGENTS.md', 'x/GEMINI.md', '.mcp.json', '.claude/settings.json', '.claude/skills/a/SKILL.md', '.github/copilot-instructions.md', '.cursorrules']) assert.equal(steersTools(p), true, p);
  for (const p of ['README.md', 'docs/claude.md.txt', 'src/agents.js', 'notes/CLAUDE.md.bak', 'claude/x.md']) assert.equal(steersTools(p), false, p);
});
