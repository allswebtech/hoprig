// `hoprig drop`: every refusal, one case each, on a temporary home. A refusal names the repository (relative to the
// workspace), the exact thing found and the command that resolves it; the project stays, byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Q, assert, dropOn, dropWorld, reset, treeOf } from './dropfix.mjs';

const w = await dropWorld('refuse');
test.after(() => w.cleanup());
const [A] = w.computers;
const api = () => path.join(A.shop, 'code', 'shop-api');
const web = () => path.join(A.shop, 'code', 'shop-web');
const API = 'projects/shop/code/shop-api';

/** Set the case up, drop: refused with `re`, nothing of the project changed; then `undo` and the drop goes through. */
async function refused(setup, re, { undo = null, cmd = null } = {}) {
  await reset(A);
  await setup();
  const before = treeOf(A.shop, w.sh);
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, re);
  if (cmd) assert.match(r.text, cmd);
  assert.match(r.text, /nothing was dropped/);
  assert.deepEqual(treeOf(A.shop, w.sh), before, 'nothing of the project changed');
  const chk = await dropOn(A, ['shop', '--check']);
  assert.equal(chk.code, 1);
  assert.match(chk.text, re, '--check says the same');
  if (undo) {
    await undo();
    const again = await dropOn(A, ['shop']);
    assert.equal(again.code, 0, again.text);
  }
  return r;
}

test('a stash refuses, with git stash list', async () => {
  await refused(() => {
    fs.writeFileSync(path.join(api(), 'README.md'), 'aside\n');
    w.sh(api(), 'stash', '-q');
  }, new RegExp(`${API}: a stash with 1 entry \\(work set aside, in no branch\\)`), { cmd: new RegExp(`git -C \\S+shop-api${Q} stash list`), undo: () => w.sh(api(), 'stash', 'drop', '-q') });
});

test('a merge in progress refuses, with git merge --abort', async () => {
  await refused(() => {
    w.sh(api(), 'switch', '-q', '-c', 'other');
    w.commit(api(), 'README.md', 'other\n');
    w.sh(api(), 'switch', '-q', 'main');
    w.commit(api(), 'README.md', 'main\n');
    try {
      w.sh(api(), 'merge', 'other');
    } catch {
      /* the conflict: a merge under way */
    }
  }, new RegExp(`${API}: a merge is under way: finish it and commit, or stop it`), { cmd: /merge --abort/ });
});

test('a detached HEAD with a commit of its own refuses, with git switch -c', async () => {
  await refused(() => {
    w.sh(api(), 'switch', '-q', '--detach');
    w.commit(api(), 'lost.txt', 'mine\n');
  }, /HEAD is detached \(on no branch\) and has 1 commit that is on no branch and not on the git server/, { cmd: /switch -c '<new branch name>'/ });
});

test('a diverged branch refuses: never forced', async () => {
  await refused(() => {
    w.sh(api(), 'switch', '-q', '-c', 'feat');
    w.commit(api(), 'f.txt', 'one\n');
    w.sh(api(), 'push', '-q', '-u', 'origin', 'feat');
    const other = w.clone(w.u.api, path.join(w.root, 'other-api'));
    w.sh(other, 'switch', '-q', 'feat');
    w.commit(other, 'f.txt', 'theirs\n');
    w.sh(other, 'push', '-q');
    w.sh(api(), 'commit', '-q', '--amend', '-m', 'rewritten');
    w.sh(api(), 'switch', '-q', 'main');
  }, new RegExp(`${API}: feat and its branch on the git server have both moved \\(1 commit only here\\)`));
});

test('a branch whose server copy is gone, with commits of its own, refuses and is never pushed back', async () => {
  await refused(() => {
    w.sh(api(), 'switch', '-q', '-c', 'old');
    w.commit(api(), 'o.txt', 'one\n');
    w.sh(api(), 'push', '-q', '-u', 'origin', 'old');
    w.commit(api(), 'o.txt', 'two\n');
    w.sh(api(), 'switch', '-q', 'main');
    w.sh(path.join(w.server, 'team', 'shop-api.git'), 'branch', '-D', 'old');
  }, /old has 2 commits only here, and its branch on the git server was removed, so drop does not put it back/);
  assert.equal(w.sh(path.join(w.server, 'team', 'shop-api.git'), 'branch', '--list', 'old'), '', 'not put back');
});

test('a tag only here refuses: drop never pushes a tag, it gives the command', async () => {
  await refused(() => w.sh(api(), 'tag', 'v1.0'), /tag v1\.0 is only on this computer \(drop never pushes a tag: it can be a release\)/, { cmd: /push origin refs\/tags\/v1\.0/, undo: () => w.sh(api(), 'push', '-q', 'origin', 'refs/tags/v1.0') });
});

test('git notes only here refuse: drop gives the push; once pushed, the drop goes through', async () => {
  await refused(() => w.sh(api(), 'notes', 'add', '-m', 'a review note', 'HEAD'), new RegExp(`${API}: refs/notes/commits is only on this computer \\(1 commit not on the git server\\) \\(git notes\\)`), { cmd: new RegExp(`git -C \\S+shop-api${Q} push origin refs/notes/commits`), undo: () => w.sh(api(), 'push', '-q', 'origin', 'refs/notes/commits') });
});

test('git notes only here refuse also with a git older than 2.42 (no for-each-ref --exclude); a refs list that cannot be read refuses', async () => {
  const { askServer, checkRepo } = await import('../../src/workspace/dropcheck.mjs');
  const { capture } = await import('../../src/setup/system.mjs');
  await reset(A);
  // A note of its own words: the test before pushed 'a review note' on this same HEAD, and git names a commit by its
  // content and its time, so the same note within the same second IS that commit, already on the git server.
  w.sh(api(), 'notes', 'add', '-m', 'a review note, read by an older git', 'HEAD');
  const server = await askServer({ ...A.ctx, root: A.shop }, api());
  const failing = (when) => (argv, o) => (argv.includes('for-each-ref') && when(argv) ? Promise.resolve({ ok: false, code: 129, stdout: '', stderr: 'error: unknown option', error: null }) : capture(argv, o));
  // A git older than 2.42 fails for-each-ref with --exclude (exit 129), as this runner does.
  const old = await checkRepo(api(), { label: API, repos: [api()], server, run: failing((a) => a.some((x) => x.startsWith('--exclude'))) });
  assert.ok(old.refusals.some((r) => /^refs\/notes\/commits is only on this computer/.test(r.what)), JSON.stringify(old.refusals));
  // The list of every ref fails: refused, never taken for "no other refs".
  const none = await checkRepo(api(), { label: API, repos: [api()], server, run: failing((a) => a.includes('--format=%(refname)')) });
  assert.ok(none.refusals.some((r) => /its refs \(git notes and the like\) could not be listed/.test(r.what)), JSON.stringify(none.refusals));
});

test('a repository inside the project without a git server refuses', async () => {
  await refused(() => {
    const n = path.join(A.shop, 'tools', 'local');
    fs.mkdirSync(n, { recursive: true });
    w.sh(n, 'init', '-q');
    w.commit(n, 'x.txt', 'only here\n');
    fs.appendFileSync(path.join(A.shop, '.gitignore'), 'tools/\n');
    w.sh(A.shop, 'commit', '-q', '-am', 'ignore tools');
    w.sh(A.shop, 'push', '-q');
  }, /projects\/shop\/tools\/local: it has no git server \(no remote named origin\), so all of it exists only here/);
});

test('a linked worktree with work in it refuses; a clean one outside the project refuses with git worktree remove', async () => {
  const wt = path.join(A.shop, 'code', 'wt');
  await refused(() => {
    w.sh(api(), 'worktree', 'add', '-q', '-b', 'side', wt);
    w.sh(wt, 'push', '-q', '-u', 'origin', 'side');
    fs.writeFileSync(path.join(wt, 'README.md'), 'busy\n');
  }, /projects\/shop\/code\/wt: a linked worktree with work in it \(1 changed file\)/);
  const out = path.join(w.root, 'outside-wt');
  await refused(() => {
    w.sh(api(), 'worktree', 'add', '-q', '--detach', out);
  }, new RegExp(`${API}: a linked worktree of it is at ${out.replace(/[\\/.^$*+?()[\]{}|]/g, '\\$&')}, outside the project`), { cmd: /worktree remove/, undo: () => w.sh(api(), 'worktree', 'remove', out) });
});

test('Claude Code\'s memory as a real folder for a folder of the project refuses: it is in no git', async () => {
  await refused(() => {
    const { projectSlug } = { projectSlug: (c) => c.replace(/[^A-Za-z0-9]/g, '-') };
    const d = path.join(A.claude, 'projects', projectSlug(web()), 'memory');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'MEMORY.md'), '# only here\n');
  }, /projects\/shop\/code\/shop-web: Claude Code's memory for it is a real folder \(.*1 file\), in no git/);
});

test('several names: each on its own; a refusal does not stop the next, the exit is 1', async () => {
  await reset(A);
  w.sh(api(), 'tag', 'v9');
  const r = await dropOn(A, ['shop', 'blog', 'nope', '--json']);
  assert.equal(r.code, 1);
  const by = Object.fromEntries(r.json.projects.map((p) => [p.spec, p.result]));
  assert.deepEqual(by, { shop: 'refused', blog: 'not here', nope: 'refused' });
  assert.match(r.json.projects[2].refusals[0].what, /no project "nope" in the map/);
  assert.equal(r.json.mode, 'drop');
  w.sh(api(), 'tag', '-d', 'v9');
});
