// A push that would move a default branch or a tag, and a merge or rebase onto the default branch, are
// held. git is asked locally (refs and config only, no remote is contacted) for the current branch, the push
// target and the remote's default branch; the command's words are never trusted for that. An unknown default
// branch is held. A push of a work branch and ordinary git commands go through.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');
const { heldLine } = await import('../src/askcard.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallgit-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
const git = (args) => {
  const r = spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
spawnSync('git', ['init', '-b', 'main', work], { encoding: 'utf8' });
git(['config', 'user.email', 'alex@example.com']);
git(['config', 'user.name', 'Alex']);
git(['commit', '--allow-empty', '-m', 'init']);
const sha = git(['rev-parse', 'HEAD']);
git(['remote', 'add', 'origin', path.join(tmp, 'server.git')]); // a local stand-in; no push is ever run
git(['update-ref', 'refs/remotes/origin/main', sha]);
git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
git(['tag', 'v1.0.0']);
git(['branch', 'feature']);

// A second repository made with `git init` + `git remote add` but no origin/HEAD: its default branch is not known.
const nodef = path.join(tmp, 'nodef');
fs.mkdirSync(nodef, { recursive: true });
const ngit = (args) => { const r = spawnSync('git', ['-C', nodef, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
spawnSync('git', ['init', '-b', 'main', nodef], { encoding: 'utf8' });
ngit(['config', 'user.email', 'alex@example.com']);
ngit(['config', 'user.name', 'Alex']);
ngit(['commit', '--allow-empty', '-m', 'init']);
ngit(['remote', 'add', 'origin', path.join(tmp, 'server2.git')]); // no origin/HEAD is set

const kind = (cmd) => { const h = wallHeld({ tool: 'Bash', input: { command: cmd }, cwd: work }); return h ? h.kind : null; };

test('on the default branch: pushing or landing on it, a tag, a forced or a deleting push are held', () => {
  const HELD = [
    'git push origin main', 'git push', 'git push --tags', 'git push origin v1.0.0',
    'git push -f origin feature', 'git push --force origin feature', 'git push origin +feature:main',
    'git push origin --delete main', 'git push origin HEAD:main', 'git push --mirror', 'git push --all origin',
    'cd src && git push origin main', 'sh -c "git push origin main"',
  ];
  for (const c of HELD) assert.equal(kind(c), 'push', c);
  assert.equal(kind('git merge feature'), 'merge');
  assert.equal(kind('git rebase feature'), 'merge');
});

test('a work-branch push and ordinary git go through', () => {
  const THROUGH = [
    'git push origin feature', 'git push origin HEAD:feature',
    'git fetch', 'git status', 'git commit -am fix', 'git log --oneline', 'git pull', 'git diff',
    'git add -A', 'git checkout -b other', 'git branch -d feature',
  ];
  for (const c of THROUGH) assert.equal(kind(c), null, c);
  // A push that deletes a work branch on the remote by name is held as the pruning push is.
  assert.equal(kind('git push origin --delete feature'), 'push');
});

test('on a work branch: a plain push and a merge of the default go through; naming the default still holds', () => {
  git(['checkout', 'feature']);
  assert.equal(kind('git push'), null); // the current branch (feature) goes to its upstream
  assert.equal(kind('git push origin feature'), null);
  assert.equal(kind('git merge main'), null); // merging INTO feature, not into the default
  assert.equal(kind('git push origin main'), 'push'); // naming the default branch holds wherever you stand
  git(['checkout', 'main']);
});

test('git is asked, not the words: an unknown default branch is held', () => {
  // A stub git that knows no default branch: the push cannot be judged, so it is held.
  const stub = () => null;
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'git push origin main' }, cwd: '/nowhere', git: stub }).kind, 'push');
  // A stub that answers the default and a non-default current branch: a plain push goes through.
  const ok = (cwd, a) => (a[0] === 'symbolic-ref' && a[2] === 'refs/remotes/origin/HEAD' ? 'origin/main' : a[2] === 'HEAD' ? 'topic' : null);
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'git push' }, cwd: '/x', git: ok }), null);
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'git push origin main' }, cwd: '/x', git: ok }).kind, 'push');
});

test('a git command pointed at another repository with -C cannot be vouched for, so it is held', () => {
  assert.equal(kind('git -C /other push origin topic'), 'push');
});

const held = (cmd, cwd = work) => wallHeld({ tool: 'Bash', input: { command: cmd }, cwd });

test('a push or merge after a directory change lands in an unknown repository, so it is held', () => {
  // The git command runs in the folder the cd reached, not the event's cwd, so which branch it moves is unreadable.
  assert.equal(kind('cd src && git push origin feature'), 'push'); // a work-branch push that would go through in `work`
  assert.equal(kind('cd /tmp && git push'), 'push');
  assert.equal(kind('pushd ../other && git merge feature'), 'merge');
  assert.equal(kind('(cd ../other && git push origin feature)'), 'push');
  assert.equal(kind('cd src && sh -c "git push origin feature"'), 'push');
  // A cd AFTER the push: the push already ran where the shell stood, so it is judged there (feature != default).
  assert.equal(kind('git push origin feature && cd ..'), null);
});

test('each held git command carries its own true reason', () => {
  assert.match(held('git merge feature').reason, /merge or rebase/i); // not the push reason
  assert.match(held('git rebase feature').reason, /merge or rebase/i);
  assert.match(held('git push --prune origin feature').reason, /prune|delete remote/i); // prune, not "move a default branch"
  assert.match(held('git -C ../other push origin topic').reason, /another repository|which project/i);
  assert.match(held('git -C ../other merge feature').reason, /another repository|which project/i);
  assert.match(held('cd ../other && git push origin feature').reason, /another repository|which project/i);
  assert.match(held('git push origin main').reason, /default branch or a tag/i);
});

test('git pointed at another repository by env -C, a GIT_DIR variable, an export or builtin cd is held (finding 3)', () => {
  // On a work branch a plain `git push` goes through, so only the redirection to another repository can hold these.
  git(['checkout', 'feature']);
  const ELSEWHERE = [
    'env -C /other git push',
    'env --chdir=/other git push origin feature',
    'env -C . git push origin main', // the value of -C was taken as the command's head before the fix
    'GIT_DIR=/other/.git GIT_WORK_TREE=/other git push',
    'export GIT_DIR=/other/.git; git push',
    'builtin cd /other && git push',
  ];
  for (const c of ELSEWHERE) assert.equal(kind(c), 'push', c);
  for (const c of ELSEWHERE) assert.match(held(c).reason, /another repository|which project/i, c);
  // env with an option that is not a directory change does not over-hold: a work-branch push still goes through.
  assert.equal(kind('env -u FOO git push origin feature'), null);
  git(['checkout', 'main']);
});

test('a repository with no known default branch: every push held, named truly, with the one command that fixes it', () => {
  const held = (cmd) => wallHeld({ tool: 'Bash', input: { command: cmd }, cwd: nodef });
  for (const cmd of ['git push origin main', 'git push', 'git push origin feature', 'git push -u origin feature']) {
    const h = held(cmd);
    assert.ok(h, cmd);
    assert.equal(h.kind, 'push', cmd); // grouped under push on the card
    assert.equal(h.why, 'push-nodefault', cmd); // but its own words, not "would move a default branch"
    assert.match(h.reason, /cannot tell which branch is the default/, cmd);
    assert.match(h.reason, /git remote set-head origin -a/, cmd);
    assert.doesNotMatch(h.reason, /would move a default branch/, cmd);
  }
  // The tool's dialog line (heldLine) says the same, including the command that fixes it.
  const line = heldLine(held('git push origin main'));
  assert.match(line, /git remote set-head origin -a/);
});
