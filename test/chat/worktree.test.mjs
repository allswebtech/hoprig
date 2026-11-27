import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeWorktree } from '../../src/chat/worktree.mjs';

const run = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();

test('Worktree: a git folder gets a new branch in a folder of its own, a plain folder is left as it is', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wt-'));
  try {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.match((await makeWorktree(plain)).why, /not a git repository/);

    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    run(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'x');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'first');

    // (a repository without a first commit: git says no, and the answer is a sentence, never a throw)
    const w = await makeWorktree(repo);
    assert.ok(!w.why, w.why);
    assert.equal(path.dirname(w.dir), path.join(fs.realpathSync(repo), '.claude', 'worktrees'));
    assert.equal(run(w.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), w.branch);
    assert.match(w.branch, /^worktree-chat-[0-9a-f]{6}$/);

    const sub = await makeWorktree(path.join(repo, 'src'));
    assert.ok(sub.dir.endsWith(path.join(sub.name, 'src')), 'opened in a subfolder: the same subfolder of the worktree');
    assert.ok(fs.existsSync(path.join(sub.dir, 'a.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Worktree: a folder the repository does not track is left out with a sentence, and nothing is left behind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wt-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'ignored'), { recursive: true });
    run(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'first');
    const w = await makeWorktree(path.join(repo, 'ignored'));
    assert.equal(w.dir, undefined, 'no folder that does not exist');
    assert.match(w.why, /not among the repository's files/);
    assert.equal(run(repo, 'worktree', 'list').split('\n').length, 1, 'the worktree is removed again');
    assert.equal(run(repo, 'branch', '--list', 'worktree-*'), '', 'and its branch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Worktree: the project\'s git does not list the worktree folder, and his own exclude lines stay, once-only line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wt-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    run(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'first');
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, '# mine\nscratch/\n');
    const w1 = await makeWorktree(repo);
    assert.ok(!w1.why, w1.why);
    assert.equal(run(repo, 'status', '--porcelain'), '', 'nothing new in the project');
    const w2 = await makeWorktree(repo);
    assert.ok(!w2.why, w2.why);
    assert.equal(run(repo, 'status', '--porcelain'), '');
    const lines = fs.readFileSync(exclude, 'utf8').split('\n');
    assert.deepEqual(lines, ['# mine', 'scratch/', '.claude/worktrees/', ''], 'his lines kept, ours once');
    // No info folder yet, and a worktree opened from another worktree: the common folder is used.
    const repo2 = path.join(root, 'repo2');
    fs.mkdirSync(repo2);
    run(repo2, 'init', '-q');
    fs.writeFileSync(path.join(repo2, 'a.txt'), 'x');
    run(repo2, 'add', '.');
    run(repo2, 'commit', '-q', '-m', 'first');
    fs.rmSync(path.join(repo2, '.git', 'info'), { recursive: true, force: true });
    const w3 = await makeWorktree(repo2);
    assert.ok(!w3.why, w3.why);
    assert.equal(run(repo2, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(repo2, '.git', 'info', 'exclude'), 'utf8'), '.claude/worktrees/\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
