// What the editor never shows or changes, whatever the request: files that hold a sign-in (Claude Code's stored
// sign-in, the providers' folder), private folders (also inside a folder that is deleted or moved, and through an
// include pattern of a search), git's own folders (as the opened folder too: a .git folder, a bare repository, a
// separate git directory), a repository whose top is outside the roots, staged files Source Control does not show,
// and a regular expression that would take the server's thread for good.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor-protect');
test.after(() => box.cleanup());

const { isPrivateName, isGitName, resolveIn, rootOf } = await import('../../src/editor/paths.mjs');
const { readFile, remove, rename, tree, versions, writeFile } = await import('../../src/editor/files.mjs');
const { LIMITS, listFiles, search } = await import('../../src/editor/search.mjs');
const { commit, diffSides, gitStatus, repoOf, stage } = await import('../../src/editor/git.mjs');
const { which } = await import('../../src/setup/system.mjs');

const top = fs.realpathSync(box.root);
const roots = [top];
const put = (abs, text = 'x\n') => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
const status = (e) => ({ status: e.status, code: e.details && e.details.code });
const refused = async (fn, want) => {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'refused');
  assert.equal(err.status, want, err.message);
  return err;
};
const engines = [...(which('rg') ? ['rg'] : []), 'walk'];

// ---------- files that hold a sign-in ----------
const claudeP = path.join(top, 'claude-p'); // a provider's own Claude Code folder
put(path.join(box.claude, '.credentials.json'), '{"token":"fake-sign-in-123"}\n');
put(path.join(box.claude, 'CLAUDE.md'), 'my rules\n');
put(path.join(claudeP, '.credentials.json'), '{"token":"fake-sign-in-456"}\n');
put(path.join(box.profiles, 'work.env'), `ANTHROPIC_API_KEY=fake-sign-in-789\nCLAUDE_CONFIG_DIR=${claudeP}\n`);
// Claude Code's default sign-in in ~/.claude, while CLAUDE_CONFIG_DIR (set by the sandbox) names another folder.
process.env.HOME = box.home;
put(path.join(box.home, '.claude', '.credentials.json'), '{"token":"fake-sign-in-000"}\n');

test('a file with a sign-in is never read, listed, found, changed or a folder to open', async () => {
  const c = path.relative(top, box.claude);
  const h = path.relative(top, box.home);
  for (const [root, rel] of [[top, `${c}/.credentials.json`], [box.claude, '.credentials.json'], [top, `${h}/.claude/.credentials.json`], [box.home, '.claude/.credentials.json'], [top, 'claude-p/.credentials.json'], [top, `${path.relative(top, box.profiles)}/work.env`]]) {
    await refused(() => readFile(root, rel, roots), 403);
    await refused(() => writeFile(root, rel, 'x', '0123456789abcdef', roots), 403);
  }
  await refused(() => rootOf(box.profiles, roots), 403);
  assert.equal(readFile(box.claude, 'CLAUDE.md', roots).text, 'my rules\n', 'the rest of the Claude folder opens');
  assert.ok(!tree(box.claude, '', roots).entries.some((e) => e.name === '.credentials.json'));
  assert.ok(!tree(top, '', roots).entries.some((e) => e.name === path.basename(box.profiles)));
  for (const engine of engines) {
    const r = await search(top, { q: 'fake-sign-in' }, roots, { engine });
    assert.deepEqual(r.matches, [], engine);
  }
  const all = (await listFiles(top, roots)).files;
  assert.ok(!all.some((p) => /credentials|work\.env/.test(p)), all.join(' '));
  await refused(() => remove(top, c, true, roots), 403);
  assert.ok(fs.existsSync(path.join(box.claude, '.credentials.json')));
  assert.deepEqual(versions(box.claude, ['.credentials.json', 'CLAUDE.md'], roots).versions['.credentials.json'], undefined);
});

// ---------- private folders ----------
test('a folder that holds a private folder at any depth is neither deleted nor moved (the Explorer shows it empty)', async () => {
  const proj = path.join(top, 'proj');
  put(path.join(proj, 'docs', 'no-ai', 'n.md'), 'mine\n');
  put(path.join(proj, 'deep', 'a', 'b', 'ignore', 'x.md'), 'mine\n');
  assert.deepEqual(tree(proj, 'docs', roots).entries, []);
  for (const dir of ['docs', 'deep']) {
    const e = await refused(() => remove(proj, dir, true, roots), 403);
    assert.equal(status(e).code, 'holds-protected');
    await refused(() => rename(proj, dir, `${dir}2`, roots), 403);
  }
  assert.ok(fs.existsSync(path.join(proj, 'docs', 'no-ai', 'n.md')) && fs.existsSync(path.join(proj, 'deep', 'a', 'b', 'ignore', 'x.md')));
  put(path.join(proj, 'plain', 'x.md'));
  assert.deepEqual(remove(proj, 'plain', true, roots), { path: 'plain', deleted: true }, 'a folder without one goes');
});

test('private names without regard to case where the disk ignores case (macOS, Windows)', () => {
  assert.equal(isPrivateName('NO-AI', true), true);
  assert.equal(isPrivateName('Ignore', true), true);
  assert.equal(isGitName('.GIT', true), true);
  assert.equal(isPrivateName('NO-AI', false), false, 'a disk that tells case apart: another folder');
  assert.equal(isPrivateName('no-ai', false), true);
});

test('find in files: an include pattern never brings back private folders or packages, and never leaves the folder', async () => {
  const proj = path.join(top, 'srch');
  put(path.join(proj, 'src', 'a.md'), 'secretword\n');
  put(path.join(proj, 'no-ai', 'notes.md'), 'secretword\n');
  put(path.join(proj, 'src', 'node_modules', 'x.md'), 'secretword\n');
  put(path.join(top, 'outside.md'), 'secretword\n');
  git(proj, 'init', '-q');
  const repoEngines = [...engines, 'git'];
  for (const engine of repoEngines) {
    for (const include of ['*', '**', 'node_modules,node_modules/**', 'no-ai,no-ai/**', '**/no-ai/**']) {
      const r = await search(proj, { q: 'secretword', include }, roots, { engine });
      assert.deepEqual(r.matches.map((m) => m.path).filter((p) => p !== 'src/a.md'), [], `${engine} include=${include}`);
    }
    for (const bad of ['../**', '../outside.md', 'src/../..', '/etc/**', ':(top)**', '!src']) {
      await refused(() => search(path.join(proj, 'src'), { q: 'secretword', include: bad }, roots, { engine }), 400);
      await refused(() => search(path.join(proj, 'src'), { q: 'secretword', exclude: bad }, roots, { engine }), 400);
    }
  }
});

test('the plain walk runs off the server\'s thread: a runaway regular expression is ended at the time limit', async () => {
  const dir = path.join(top, 'redos');
  put(path.join(dir, 'a.txt'), `${'a'.repeat(34)}!\n`);
  const keep = LIMITS.ms;
  LIMITS.ms = 1500;
  let ticks = 0;
  const tick = setInterval(() => ticks++, 100);
  try {
    const t0 = Date.now();
    const r = await search(dir, { q: '(a+)+$', regex: true }, roots, { engine: 'walk' });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 6000, `ended in ${Date.now() - t0} ms`);
    assert.ok(ticks >= 8, `the server's thread kept running (${ticks} ticks)`);
  } finally {
    clearInterval(tick);
    LIMITS.ms = keep;
  }
});

// ---------- git's own folders ----------
test('git\'s own folder is never the opened folder or a path: .git, a bare repository, a separate git directory', async () => {
  const proj = path.join(top, 'gitroot');
  fs.mkdirSync(proj);
  git(proj, 'init', '-q');
  await refused(() => rootOf(path.join(proj, '.git'), roots), 403);
  await refused(() => rootOf(path.join(proj, '.git', 'hooks'), roots), 403);
  await refused(() => writeFile(path.join(proj, '.git'), 'config', '[core]\n\tfsmonitor = "touch x"\n', null, roots), 403);
  await refused(() => readFile(proj, '.git/config', roots), 403);
  await refused(() => resolveIn(proj, '.git/hooks/pre-commit', roots, { mode: 'new' }), 403);
  git(top, 'init', '-q', '--bare', 'bare.git');
  await refused(() => rootOf(path.join(top, 'bare.git'), roots), 403);
  await refused(() => rootOf(path.join(top, 'bare.git', 'hooks'), roots), 403);
  await refused(() => readFile(top, 'bare.git/config', roots), 403);
  git(top, 'init', '-q', `--separate-git-dir=${path.join(top, 'gd')}`, 'wt');
  await refused(() => rootOf(path.join(top, 'gd'), roots), 403);
  await refused(() => writeFile(top, 'gd/hooks/pre-commit', '#!/bin/sh\n', null, roots), 403);
  assert.equal(rootOf(path.join(top, 'wt'), roots), path.join(top, 'wt'), 'its working folder opens');
});

test('a repository whose top is outside the roots does not count (the home folder kept as a repository)', async () => {
  const outer = path.join(top, 'outer');
  fs.mkdirSync(path.join(outer, 'projects', 'p'), { recursive: true });
  git(outer, 'init', '-q');
  const inner = [fs.realpathSync(path.join(outer, 'projects'))];
  const p = path.join(outer, 'projects', 'p');
  assert.equal((await repoOf(p, inner)).top, null);
  assert.equal((await gitStatus(p, inner)).repo, false);
  const e = await refused(() => commit(p, 'x', undefined, inner), 409);
  assert.equal(status(e).code, 'not-a-repo');
  assert.equal((await repoOf(p, roots)).top, outer, 'inside the roots it is one');
});

// ---------- what a commit takes ----------
test('a commit is refused while the index holds staged files Source Control does not show', async () => {
  const repo = path.join(top, 'scope');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(path.join(repo, 'sub', 'a.txt'));
  put(path.join(repo, 'outside.txt'));
  put(path.join(repo, 'docs', 'no-ai', 'staged.md'), 'mine\n');
  // Before the first commit too: nothing is compared with a HEAD that is not there.
  git(repo, 'add', 'sub/a.txt', 'outside.txt', 'docs/no-ai/staged.md');
  let e = await refused(() => commit(path.join(repo, 'sub'), 'from the editor', undefined, roots), 409);
  assert.equal(status(e).code, 'staged-elsewhere');
  assert.match(e.message, /private folder/);
  assert.doesNotMatch(e.message, /staged\.md/, 'a private file is not named');
  git(repo, 'rm', '-q', '--cached', 'docs/no-ai/staged.md');
  e = await refused(() => commit(path.join(repo, 'sub'), 'from the editor', undefined, roots), 409);
  assert.equal(status(e).code, 'staged-elsewhere');
  assert.match(e.message, /1 staged file is not shown here/);
  assert.equal(git(repo, 'rev-list', '--all').trim(), '', 'nothing was committed');
  const r = await commit(repo, 'from the top', undefined, roots);
  assert.equal(r.subject, 'from the top');
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['outside.txt', 'sub/a.txt']);
  e = await refused(() => commit(repo, 'again', undefined, roots), 409);
  assert.equal(status(e).code, 'nothing-staged');
});

test('stage, unstage and discard take files, not folders (a folder would take in what is not shown)', async () => {
  const repo = path.join(top, 'scope');
  put(path.join(repo, 'docs', 'no-ai', 'more.md'), 'mine\n');
  put(path.join(repo, 'docs', 'x.md'));
  await refused(() => stage(repo, ['docs'], roots), 400);
  assert.equal(git(repo, 'diff', '--cached', '--name-only').trim(), '');
  await stage(repo, ['docs/x.md'], roots);
  assert.equal(git(repo, 'diff', '--cached', '--name-only').trim(), 'docs/x.md');
  await refused(() => diffSides(repo, 'docs/no-ai/more.md', false, roots), 403);
});

test('a staged rename counts by both its names: a source outside the folder or in a private one stops the commit', async () => {
  const repo = path.join(top, 'renames');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(path.join(repo, 'outside', 'x.txt'), 'moved from outside\n');
  put(path.join(repo, 'docs', 'no-ai', 'n.md'), 'mine\n');
  put(path.join(repo, 'sub', 'keep.txt'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'first');
  // (a) Opened on sub/: only "x.txt" is shown, but the commit would also delete outside/x.txt.
  git(repo, 'mv', 'outside/x.txt', 'sub/x.txt');
  let e = await refused(() => commit(path.join(repo, 'sub'), 'move in', undefined, roots), 409);
  assert.equal(status(e).code, 'staged-elsewhere');
  assert.match(e.message, /1 staged file is not shown here/);
  git(repo, 'reset', '-q');
  git(repo, 'checkout', '-q', '--', '.');
  fs.rmSync(path.join(repo, 'sub', 'x.txt'));
  // (b) Opened on the top: "moved.md" is shown, but its source is in a private folder.
  git(repo, 'mv', 'docs/no-ai/n.md', 'moved.md');
  e = await refused(() => commit(repo, 'move out', undefined, roots), 409);
  assert.equal(status(e).code, 'staged-elsewhere');
  assert.match(e.message, /private folder/);
  // (c) A plain removal from the private folder is refused the same way.
  git(repo, 'reset', '-q');
  fs.rmSync(path.join(repo, 'moved.md'));
  git(repo, 'rm', '-q', '--cached', 'docs/no-ai/n.md');
  e = await refused(() => commit(repo, 'remove', undefined, roots), 409);
  assert.match(e.message, /private folder/);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed');
});
