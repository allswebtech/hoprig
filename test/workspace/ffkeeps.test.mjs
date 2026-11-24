// A fast-forward never removes what git ignores. A group's repository ignores its members and a project's parent its
// code/ folder; each is a repository of its own there, with uncommitted work and commits not pushed yet. When the
// group's (or the parent's) repository starts to track a path over one of them, a plain fast-forward deletes it. Sync
// refuses that, changes nothing, and says what is in the way. Temporary homes and local bare repositories only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-ffkeeps');
test.after(() => w.cleanup());
for (const n of ['brain', 'shop', 'web', 'kits', 'acme']) w.bare(n);
const B = w.computer('b');
B.use();
process.env.HOPRIG_WORKSPACE_DIR = B.ws;
const { saveConfig } = await import('../../src/config.mjs');
saveConfig({ projectsDir: B.projects });
const seedOf = (n, files) => {
  const s = w.clone(w.url(n), path.join(w.root, `seed-${n}`));
  for (const [r, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(s, r)), { recursive: true });
    fs.writeFileSync(path.join(s, r), t);
  }
  w.sh(s, 'add', '-A');
  w.sh(s, 'commit', '-qm', 'seed');
  w.sh(s, 'push', '-q', 'origin', 'main');
  return s;
};
/** The seed starts to track `rel` as a link (over what the computer has there). */
const trackOver = (s, rel) => {
  fs.mkdirSync(path.dirname(path.join(s, rel)), { recursive: true });
  fs.symlinkSync('../README.md', path.join(s, rel));
  w.sh(s, 'add', '-f', rel);
  w.sh(s, 'commit', '-qm', `track ${rel}`);
  w.sh(s, 'push', '-q', 'origin', 'main');
};
const busy = (repo) => {
  fs.writeFileSync(path.join(repo, 'WORK.md'), 'uncommitted\n');
  return w.commit(repo, 'UNPUSHED.md', 'not pushed\n');
};

test('a parent that starts to track code/web: the code repository and its work stay, the pull waits with what is in the way', async () => {
  const s = seedOf('shop', { 'project.json': JSON.stringify({ name: 'shop', repos: [{ dir: 'code/web', url: w.url('web') }] }), '.gitignore': '/code/\n' });
  const shop = w.clone(w.url('shop'), path.join(B.projects, 'shop'));
  const web = w.clone(w.url('web'), path.join(shop, 'code', 'web'));
  const head = busy(web);
  trackOver(s, 'code/web');
  const { syncWorkspace } = await import('../../src/pcsetup/workspace.mjs');
  const r = await syncWorkspace(shop, { push: false });
  const parent = r.repos.find((x) => x.rel === '.');
  assert.deepEqual(parent.did, []);
  assert.match(parent.todo[0].why, /1 to pull, but the incoming commits put files where code\/web is here, which this repository does not track/);
  assert.match(parent.todo[0].command, /merge --ff-only --no-overwrite-ignore/);
  assert.ok(fs.lstatSync(path.join(shop, 'code', 'web')).isDirectory(), 'still a folder');
  assert.ok(fs.existsSync(path.join(web, 'WORK.md')), 'the uncommitted work stays');
  assert.equal(w.sh(web, 'rev-parse', 'HEAD'), head, 'the commit not pushed stays');
});

test('a group whose repository starts to track a member\'s path: the unattended round keeps the member and its work', async () => {
  w.clone(w.url('brain'), path.join(B.ws, 'ai_brain'));
  const s = seedOf('kits', { '.gitignore': '/builds/*/\n' });
  const kits = w.clone(w.url('kits'), path.join(B.ws, 'kits'));
  const acme = w.clone(w.url('acme'), path.join(kits, 'builds', 'acme'));
  const head = busy(acme);
  const M = await import('../../src/workspace/map.mjs');
  M.writeMap({ version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'kits', url: w.url('kits'), holds: [{ dir: 'builds' }] }], projects: [{ name: 'acme', in: 'kits/builds', url: w.url('acme'), repos: [] }], others: [] }, B.ws);
  trackOver(s, 'builds/acme');
  const { syncAll } = await import('../../src/workspace/sync.mjs');
  const r = await syncAll({ dir: B.ws, projects: B.projects, push: true });
  const k = r.repos.find((x) => x.label === 'kits');
  assert.deepEqual(k.did, []);
  assert.match(k.todo[0].why, /put files where builds\/acme is here/);
  assert.ok(fs.lstatSync(acme).isDirectory());
  assert.ok(fs.existsSync(path.join(acme, 'WORK.md')));
  assert.equal(w.sh(acme, 'rev-parse', 'HEAD'), head);
});

test('sync --with another computer: a parent there that tracks code/web leaves the code repository here and its work', async () => {
  // The other computer's checkout of site, one commit ahead, that tracks code/web as a file (over the code repository here).
  w.bare('site');
  seedOf('site', { '.gitignore': '/code/\n' });
  const peer = w.clone(w.url('site'), path.join(w.root, 'peer-site'));
  const here = w.clone(w.url('site'), path.join(B.projects, 'site'));
  const web = w.clone(w.url('web'), path.join(here, 'code', 'web'));
  const head = busy(web);
  trackOver(peer, 'code/web');
  const { pullFrom } = await import('../../src/workspace/peer.mjs');
  const r = await pullFrom(here, peer, 'box2', undefined, { at: { root: here, dir: B.ws, projects: B.projects } });
  assert.deepEqual(r.did, []);
  assert.match(r.todo[0].why, /1 to get from box2, but those commits put files where code\/web is here/);
  assert.match(r.todo[0].command, /merge --ff-only --no-overwrite-ignore/);
  assert.ok(fs.lstatSync(web).isDirectory(), 'still a folder');
  assert.ok(fs.existsSync(path.join(web, 'WORK.md')), 'the uncommitted work stays');
  assert.equal(w.sh(web, 'rev-parse', 'HEAD'), head, 'the commit not pushed stays');
});

test('an unrelated uncommitted change does not hide what is in the way: no stash is suggested, the change stays in the folder', async () => {
  w.bare('desk');
  const s = seedOf('desk', { '.gitignore': '/code/\n', 'README.md': 'desk\n' });
  const desk = w.clone(w.url('desk'), path.join(B.projects, 'desk'));
  const web = w.clone(w.url('web'), path.join(desk, 'code', 'web'));
  busy(web);
  fs.writeFileSync(path.join(desk, 'README.md'), 'desk, edited here\n');
  trackOver(s, 'code/web');
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  const r = await syncRepo(desk, '.', undefined, { push: false });
  assert.match(r.todo[0].why, /1 to pull, but the incoming commits put files where code\/web is here, which this repository does not track .*nothing was changed, and your 1 uncommitted change stays where it is; move it away first/);
  assert.doesNotMatch(r.todo[0].command, /stash/, 'a stash would only hide the change: the fast-forward is refused all the same');
  assert.equal(fs.readFileSync(path.join(desk, 'README.md'), 'utf8'), 'desk, edited here\n');
  assert.equal(w.sh(desk, 'stash', 'list'), '');
  assert.ok(fs.existsSync(path.join(web, 'WORK.md')));

  // The same from another computer (sync --with).
  w.bare('desk2');
  seedOf('desk2', { '.gitignore': '/code/\n', 'README.md': 'desk\n' });
  const peer = w.clone(w.url('desk2'), path.join(w.root, 'peer-desk2'));
  const here = w.clone(w.url('desk2'), path.join(B.projects, 'desk2'));
  const web2 = w.clone(w.url('web'), path.join(here, 'code', 'web'));
  busy(web2);
  fs.writeFileSync(path.join(here, 'README.md'), 'desk, edited here\n');
  trackOver(peer, 'code/web');
  const { pullFrom } = await import('../../src/workspace/peer.mjs');
  const p = await pullFrom(here, peer, 'box2', undefined, { at: { root: here, dir: B.ws, projects: B.projects } });
  assert.match(p.todo[0].why, /1 to get from box2, but those commits put files where code\/web is here.*and your 1 uncommitted change stays where it is; move it away first/);
  assert.doesNotMatch(p.todo[0].command, /stash/);
  assert.equal(fs.readFileSync(path.join(here, 'README.md'), 'utf8'), 'desk, edited here\n');
  assert.ok(fs.existsSync(path.join(web2, 'WORK.md')));
});

test('an uncommitted change in a file the incoming commits change: stash, fast-forward, stash pop is suggested and works', async () => {
  w.bare('memo');
  const s = seedOf('memo', { 'README.md': 'one\ntwo\nthree\n' });
  const here = w.clone(w.url('memo'), path.join(w.root, 'memo-b'));
  fs.writeFileSync(path.join(here, 'README.md'), 'one\ntwo\nthree\nmine\n');
  fs.writeFileSync(path.join(s, 'README.md'), 'theirs\ntwo\nthree\n');
  w.sh(s, 'commit', '-qam', 'theirs');
  w.sh(s, 'push', '-q', 'origin', 'main');
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  const r = await syncRepo(here, '.', undefined, { push: false });
  assert.equal(r.todo[0].why, '1 to pull, but there are 1 uncommitted changes in the same files');
  const { todoKind } = await import('../../src/pcsetup/feature.mjs');
  assert.equal(todoKind(r.todo[0].why), 'pull-blocked');
  assert.match(r.todo[0].command, /stash && .* merge --ff-only --no-overwrite-ignore .* && .* stash pop/);
  execFileSync('bash', ['-c', r.todo[0].command]);
  assert.equal(fs.readFileSync(path.join(here, 'README.md'), 'utf8'), 'theirs\ntwo\nthree\nmine\n', 'both: theirs pulled, the change back');
});

test('a tracked file changed here that git status does not show (marked to be left alone): the reason, the file and the next step, never a bare "failed"', async () => {
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  const { todoKind } = await import('../../src/pcsetup/feature.mjs');
  for (const mark of ['--skip-worktree', '--assume-unchanged']) {
    const n = `marked${mark.replace(/\W/g, '')}`;
    w.bare(n);
    const s = seedOf(n, { 'notes/plan.txt': 'one\n', 'README.md': 'a\n' });
    const here = w.clone(w.url(n), path.join(w.root, `${n}-b`));
    fs.writeFileSync(path.join(here, 'notes', 'plan.txt'), 'one\nmine\n');
    w.sh(here, 'update-index', mark, 'notes/plan.txt');
    assert.equal(w.sh(here, 'status', '--porcelain'), '', 'git status shows no change');
    fs.writeFileSync(path.join(s, 'notes', 'plan.txt'), 'theirs\n');
    w.sh(s, 'commit', '-qam', 'theirs');
    w.sh(s, 'push', '-q', 'origin', 'main');
    const head = w.sh(here, 'rev-parse', 'HEAD');
    const r = await syncRepo(here, '.', undefined, { push: false });
    assert.deepEqual(r.did, [], mark);
    assert.match(r.todo[0].why, /^1 to pull, but notes\/plan\.txt is changed here and by the incoming commits\. git status does not show it: most likely marked "assume unchanged" or "skip worktree"/, mark);
    assert.match(r.todo[0].why, /Nothing was changed; take the mark off, then commit it or put it aside\.$/, mark);
    assert.equal(todoKind(r.todo[0].why), 'pull-blocked');
    assert.equal(w.sh(here, 'rev-parse', 'HEAD'), head, 'nothing moved');
    assert.equal(fs.readFileSync(path.join(here, 'notes', 'plan.txt'), 'utf8'), 'one\nmine\n', 'his change is as it was');
    // The step it names works: the mark off, then the change is one git status shows, and stash, fast-forward, pop go through.
    assert.match(r.todo[0].command, /update-index --no-assume-unchanged -- notes\/plan\.txt && .* update-index --no-skip-worktree -- notes\/plan\.txt && .* status/);
    execFileSync('bash', ['-c', r.todo[0].command]);
    const again = await syncRepo(here, '.', undefined, { push: false });
    assert.equal(again.todo[0].why, '1 to pull, but there are 1 uncommitted changes in the same files', mark);
  }
});

test('the same inside a private folder: the folder and a count, never the file\'s name, for the owner and for an assistant alike', async () => {
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  w.bare('private');
  const s = seedOf('private', { 'ignore/working-notes.txt': 'one\n', 'docs/no-ai/plan-b.md': 'one\n', 'README.md': 'a\n' });
  const here = w.clone(w.url('private'), path.join(w.root, 'private-b'));
  for (const f of ['ignore/working-notes.txt', 'docs/no-ai/plan-b.md', 'README.md']) {
    fs.appendFileSync(path.join(here, f), 'mine\n');
    w.sh(here, 'update-index', '--skip-worktree', f);
    fs.writeFileSync(path.join(s, f), 'theirs\n');
  }
  w.sh(s, 'commit', '-qam', 'theirs');
  w.sh(s, 'push', '-q', 'origin', 'main');
  const r = await syncRepo(here, '.', undefined, { push: false });
  const said = `${r.todo[0].why} ${r.todo[0].command}`;
  assert.match(r.todo[0].why, /^1 to pull, but README\.md, 1 file in your private folder docs\/no-ai\/, 1 file in your private folder ignore\/ are changed here and by the incoming commits/);
  assert.ok(!/working-notes|plan-b/.test(said), 'no name from a private folder');
  assert.match(r.todo[0].why, /Run the command in your own terminal to see the names: git lists them and changes nothing while it refuses\.$/);
  assert.match(r.todo[0].command, /merge --ff-only --no-overwrite-ignore/);
  assert.ok(!/update-index/.test(r.todo[0].command), 'no command that would have to name them');
  const { withoutPrivateNames } = await import('../../src/pcsetup/workspace.mjs');
  assert.equal(withoutPrivateNames("error: Entry 'ignore/working-notes.txt' not uptodate. Cannot merge."), 'error: Entry a file in your private folder ignore/ not uptodate. Cannot merge.');
});

test('a fast-forward git refuses for another reason: git\'s own reason is said, never a bare "failed"', async () => {
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  w.bare('locked');
  const s = seedOf('locked', { 'README.md': 'a\n' });
  const here = w.clone(w.url('locked'), path.join(w.root, 'locked-b'));
  fs.writeFileSync(path.join(s, 'README.md'), 'theirs\n');
  w.sh(s, 'commit', '-qam', 'theirs');
  w.sh(s, 'push', '-q', 'origin', 'main');
  w.sh(here, 'fetch', '-q');
  fs.writeFileSync(path.join(here, '.git', 'index.lock'), ''); // as another git process holds it, or left one behind
  const r = await syncRepo(here, '.', undefined, { push: false });
  fs.rmSync(path.join(here, '.git', 'index.lock'));
  const why = r.todo.map((t) => t.why).join(' | ');
  assert.match(why, /fast-forward failed: Unable to create .*index\.lock.*File exists/);
  assert.ok(!/fast-forward failed(?: \||$)/.test(why), 'never without its reason');
});

test('moved on both sides, and the server tracks a member\'s path: the merge or rebase it suggests is preceded by what it would delete', async () => {
  // A merge or a rebase replaces what git ignores (--no-overwrite-ignore guards only a fast-forward): checked here
  // by running the suggested merge in a copy.
  w.bare('tools');
  const s = seedOf('tools', { '.gitignore': '/builds/*/\n' });
  const tools = w.clone(w.url('tools'), path.join(w.root, 'tools-b'));
  w.bare('acme1'); // a member of its own: the group test above pushes acme
  const acme = w.clone(w.url('acme1'), path.join(tools, 'builds', 'acme'));
  busy(acme);
  w.commit(tools, 'LOCAL.md', 'here\n');
  trackOver(s, 'builds/acme');
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  const r = await syncRepo(tools, '.', undefined, { push: false });
  const dry = await syncRepo(tools, '.', undefined, { push: false, dryRun: true }); // the server's commit is here now: counted
  for (const x of [r, dry]) {
    assert.match(x.todo[0].why, /main and its upstream have both moved \(1 ahead, 1 behind\), and the server's commits put files where builds\/acme is here, which this repository does not track .*a merge or a rebase would delete it; move it away first/);
  }
  const { todoKind } = await import('../../src/pcsetup/feature.mjs');
  assert.equal(todoKind(r.todo[0].why), 'kept-back', 'the page offers no merge session for it');
  assert.ok(fs.existsSync(path.join(acme, 'WORK.md')), 'sync itself changed nothing');
  const copy = path.join(w.root, 'tools-copy');
  fs.cpSync(tools, copy, { recursive: true, verbatimSymlinks: true });
  w.sh(copy, 'merge', '-q', '--no-overwrite-ignore', '--no-edit', 'origin/main');
  assert.ok(fs.lstatSync(path.join(copy, 'builds', 'acme')).isSymbolicLink(), 'the merge it would otherwise suggest deletes the member');

  // Nothing in the way: the plain words, as before.
  w.bare('tools2');
  const s2 = seedOf('tools2', { '.gitignore': '/builds/*/\n' });
  const t2 = w.clone(w.url('tools2'), path.join(w.root, 'tools2-b'));
  w.clone(w.url('acme1'), path.join(t2, 'builds', 'acme'));
  w.commit(t2, 'LOCAL.md', 'here\n');
  w.commit(s2, 'THEIRS.md', 'there\n');
  w.sh(s2, 'push', '-q', 'origin', 'main');
  const plain = await syncRepo(t2, '.', undefined, { push: false });
  assert.equal(plain.todo[0].why, 'main and its upstream have both moved (1 ahead, 1 behind)');

  // From another computer (sync --with).
  w.bare('tools3');
  seedOf('tools3', { '.gitignore': '/builds/*/\n' });
  const peer = w.clone(w.url('tools3'), path.join(w.root, 'peer-tools3'));
  const here = w.clone(w.url('tools3'), path.join(B.projects, 'tools3'));
  w.bare('acme3');
  const acme3 = w.clone(w.url('acme3'), path.join(here, 'builds', 'acme'));
  busy(acme3);
  w.commit(here, 'LOCAL.md', 'here\n');
  trackOver(peer, 'builds/acme');
  const { pullFrom } = await import('../../src/workspace/peer.mjs');
  const p = await pullFrom(here, peer, 'box2', undefined, { at: { root: here, dir: B.ws, projects: B.projects } });
  assert.match(p.todo[0].why, /main here and on box2 have both moved \(1 here, 1 there\), and those commits put files where builds\/acme is here.*a merge or a rebase would delete it; move it away first/);
  assert.ok(fs.existsSync(path.join(acme3, 'WORK.md')));
});

test('in the way also: an ignored file here where the other side needs a folder', async () => {
  w.bare('notes');
  const s = seedOf('notes', { '.gitignore': '/cache\n' });
  const here = w.clone(w.url('notes'), path.join(w.root, 'notes-b'));
  fs.writeFileSync(path.join(here, 'cache'), 'kept here\n');
  w.commit(here, 'LOCAL.md', 'here\n');
  fs.mkdirSync(path.join(s, 'cache'));
  fs.writeFileSync(path.join(s, 'cache', 'x.md'), 'theirs\n');
  w.sh(s, 'add', '-f', 'cache/x.md');
  w.sh(s, 'commit', '-qm', 'cache as a folder');
  w.sh(s, 'push', '-q', 'origin', 'main');
  const { inTheWay } = await import('../../src/pcsetup/intheway.mjs');
  w.sh(here, 'fetch', '-q');
  assert.deepEqual(await inTheWay(here, 'origin/main'), { deleted: 'cache', refused: '' }, 'git ignores it: a merge deletes it');
  assert.deepEqual(await inTheWay(here, 'HEAD'), { deleted: '', refused: '' }, 'nothing of their own: nothing in the way');
});

test('held back for both reasons at once: what is in the way is moved away, a tracked file changed on both sides is named in its own sentence', async () => {
  // git refuses with two lists in one go: the tracked README.md changed here, and the member it would delete.
  w.bare('mixed');
  const s = seedOf('mixed', { '.gitignore': '/builds/*/\n', 'README.md': 'one\n' });
  const here = w.clone(w.url('mixed'), path.join(w.root, 'mixed-b'));
  w.bare('acme4');
  const acme = w.clone(w.url('acme4'), path.join(here, 'builds', 'acme'));
  busy(acme);
  fs.writeFileSync(path.join(here, 'README.md'), 'one\nmine\n');
  fs.writeFileSync(path.join(s, 'README.md'), 'one\ntheirs\n');
  w.sh(s, 'add', 'README.md');
  trackOver(s, 'builds/acme');
  const { syncRepo, keptBack, changedToo } = await import('../../src/pcsetup/workspace.mjs');
  const { todoKind } = await import('../../src/pcsetup/feature.mjs');
  const r = await syncRepo(here, '.', undefined, { push: false });
  const why = r.todo[0].why;
  assert.match(why, /^1 to pull, but the incoming commits put files where builds\/acme is here, which this repository does not track \(another repository, perhaps\): nothing was changed, and your 1 uncommitted change stays where it is; move it away first\. They also change README\.md, which this repository tracks and you have changed here: commit those changes or put them aside \(git stash\) first; that file is not to be moved away\. Then$/);
  assert.doesNotMatch(why, /where [^:]*README\.md[^:]* is here/, 'the tracked, changed file is never called something this repository does not track');
  assert.equal(todoKind(why), 'kept-back');
  assert.doesNotMatch(r.todo[0].command, /stash/);
  assert.equal(fs.readFileSync(path.join(here, 'README.md'), 'utf8'), 'one\nmine\n', 'the change stays');
  assert.equal(w.sh(here, 'stash', 'list'), '');
  assert.ok(fs.existsSync(path.join(acme, 'WORK.md')));

  // The same from another computer (sync --with).
  const { pullFrom } = await import('../../src/workspace/peer.mjs');
  const peer = w.clone(w.url('mixed'), path.join(w.root, 'peer-mixed'));
  const p = await pullFrom(here, peer, 'box2', undefined, { at: { root: here } });
  assert.match(p.todo[0].why, /^1 to get from box2, but those commits put files where builds\/acme is here, .*move it away first\. They also change README\.md, which this repository tracks and you have changed here: .*Then$/);

  // git's own words for each case alone and for both: the lists are read under their own headers.
  const mixed = { ok: false, stderr: 'error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md\n\tdocs/a.md\nPlease commit your changes or stash them before you merge.\nerror: Updating the following directories would lose untracked files in them:\n\tbuilds/acme\n\nAborting\n', stdout: 'Updating 5bff0ec..e1e97c0\n' };
  assert.equal(keptBack(mixed), 'builds/acme');
  assert.equal(changedToo(mixed), 'README.md, docs/a.md');
  const untracked = { ok: false, stderr: 'error: The following untracked working tree files would be overwritten by merge:\n\tnotes.txt\nPlease move or remove them before you merge.\nAborting\n' };
  assert.equal(keptBack(untracked), 'notes.txt');
  assert.equal(changedToo(untracked), '');
  const tracked = { ok: false, stderr: 'error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md\nPlease commit your changes or stash them before you merge.\nAborting\n' };
  assert.equal(keptBack(tracked), '', 'only tracked files changed: not held back, the stash advice follows');
  assert.equal(changedToo(tracked), 'README.md');
  const { keptWords } = await import('../../src/pcsetup/workspace.mjs');
  assert.match(keptWords('notes.txt', '', 0), /move it away first, then$/);
  assert.match(keptWords('builds/acme', 'README.md, docs/a.md', 2), /and your 2 uncommitted changes stay where they are; move it away first\. They also change README\.md, docs\/a\.md, .*those files are not to be moved away\. Then$/);
});

test('moved on both sides over an untracked file git does not ignore: it is in the way and git refuses, never "would delete"', async () => {
  w.bare('pad');
  const s = seedOf('pad', { '.gitignore': '/builds/*/\n' });
  const here = w.clone(w.url('pad'), path.join(w.root, 'pad-b'));
  w.commit(here, 'LOCAL.md', 'here\n');
  fs.writeFileSync(path.join(here, 'notes.txt'), 'mine\n'); // after the commit (it adds all): untracked, not ignored
  w.commit(s, 'notes.txt', 'theirs\n');
  w.sh(s, 'push', '-q', 'origin', 'main');
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  const r = await syncRepo(here, '.', undefined, { push: false });
  assert.equal(r.todo[0].why, 'main and its upstream have both moved (1 ahead, 1 behind), and the server\'s commits put files where notes.txt is here, which this repository does not track: it is in the way, and git refuses a merge or a rebase until it is moved away; move it away first, then');
  const { todoKind } = await import('../../src/pcsetup/feature.mjs');
  assert.equal(todoKind(r.todo[0].why), 'kept-back');
  // What git does: it refuses, and the file stays.
  assert.throws(() => execFileSync('git', ['-C', here, 'merge', '-q', '--no-edit', 'origin/main'], { stdio: 'pipe' }), /untracked working tree files would be overwritten/);
  assert.equal(fs.readFileSync(path.join(here, 'notes.txt'), 'utf8'), 'mine\n');

  // Both at once: a member git ignores (deleted) and the untracked file (refused), each with its own words.
  w.bare('acme5');
  const acme = w.clone(w.url('acme5'), path.join(here, 'builds', 'acme'));
  busy(acme);
  trackOver(s, 'builds/acme');
  const both = await syncRepo(here, '.', undefined, { push: false });
  assert.equal(both.todo[0].why, 'main and its upstream have both moved (1 ahead, 2 behind), and the server\'s commits put files where builds/acme is here, which this repository does not track (another repository, perhaps): a merge or a rebase would delete it; and where notes.txt is here, which this repository does not track: it is in the way, and git refuses a merge or a rebase until it is moved away; move both away first, then');

  // From another computer (sync --with): the same words.
  const { pullFrom } = await import('../../src/workspace/peer.mjs');
  const peer = w.clone(w.url('pad'), path.join(w.root, 'peer-pad'));
  const p = await pullFrom(here, peer, 'box2', undefined, { at: { root: here } });
  assert.match(p.todo[0].why, /have both moved \(1 here, 2 there\), and those commits put files where builds\/acme is here, .*would delete it; and where notes\.txt is here, which this repository does not track: it is in the way, and git refuses/);

  const { inTheWayWords } = await import('../../src/pcsetup/intheway.mjs');
  assert.equal(inTheWayWords({ deleted: '', refused: '' }, 'x'), '');
  assert.match(inTheWayWords({ deleted: '', refused: 'a.txt, b.txt' }, 'those commits'), /: they are in the way, and git refuses a merge or a rebase until they are moved away; move them away first, then$/);
  assert.match(inTheWayWords({ deleted: 'a, b, c, d, e and 2 more', refused: '' }, 'those commits'), /would delete them; move them away first, then$/);
});

test('a dry run looks for what is in the way against the server\'s commit when it is here, also with a stale upstream ref', async () => {
  // The server's commit came by address (FETCH_HEAD), not through origin: origin/main still points to the old commit.
  w.bare('bench');
  const s = seedOf('bench', { '.gitignore': '/builds/*/\n' });
  const here = w.clone(w.url('bench'), path.join(w.root, 'bench-b'));
  w.bare('acme6');
  const acme = w.clone(w.url('acme6'), path.join(here, 'builds', 'acme'));
  busy(acme);
  w.commit(here, 'LOCAL.md', 'here\n');
  trackOver(s, 'builds/acme');
  w.sh(here, 'fetch', '-q', w.url('bench'), 'main');
  const stale = w.sh(here, 'rev-parse', 'origin/main');
  assert.notEqual(stale, w.sh(here, 'rev-parse', 'FETCH_HEAD'), 'the upstream ref is stale');
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  const dry = await syncRepo(here, '.', undefined, { push: false, dryRun: true });
  assert.match(dry.todo[0].why, /^main and its upstream have both moved \(1 ahead, 1 behind\), and the server's commits put files where builds\/acme is here, .*a merge or a rebase would delete it; move it away first, then$/);
  assert.equal(w.sh(here, 'rev-parse', 'origin/main'), stale, 'a dry run fetches nothing');
  assert.ok(fs.existsSync(path.join(acme, 'WORK.md')));
});
