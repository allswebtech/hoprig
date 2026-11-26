// `hoprig drop` killed at every step (the run stops right after it), then run again: nothing is lost, nothing half made
// is left, and `hoprig get` works after each. And the second check before the removal really runs: something that
// comes between the acts and the removal keeps the project here.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Q, assert, dropOn, dropWorld, getOn, onServer, owner, reset, serverHeads } from './dropfix.mjs';

const w = await dropWorld('kill');
test.after(() => w.cleanup());
const [A] = w.computers;
const api = () => path.join(A.shop, 'code', 'shop-api');
const web = () => path.join(A.shop, 'code', 'shop-web');
const bare = (r) => path.join(w.server, 'team', `${r}.git`);

/** A project with one thing of each kind drop acts on, named after `tag` (each run its own); → what must reach the server. */
async function busyProject(tag) {
  await reset(A);
  w.sh(web(), 'switch', '-q', '-c', `idea-${tag}`);
  const idea = w.commit(web(), `idea-${tag}.txt`, 'mine\n');
  w.sh(web(), 'switch', '-q', 'main');
  const release = w.commit(api(), `release-${tag}.txt`, 'ship\n'); // only on the default branch: pushed as wip/ (answer 2)
  fs.writeFileSync(path.join(web(), `draft-${tag}.txt`), `not committed ${tag}\n`); // work: saved on a wip/ branch (yes)
  fs.writeFileSync(path.join(A.shop, 'ai_brain', 'claude-memory', `note-${tag}.md`), `learned ${tag}\n`); // memory: committed
  return { tag, idea, release };
}

const has = (repo, test) => Object.keys(serverHeads(w, repo)).some((n) => {
  try {
    return test(n);
  } catch {
    return false;
  }
});

/** Everything that existed is on the git server: the branch, the default branch's commit, the work, the memory. */
function allOnServer(k) {
  assert.equal(onServer(w, 'shop-web', `refs/heads/idea-${k.tag}`), k.idea, 'the branch');
  assert.ok(has('shop-api', (n) => n.startsWith('wip/') && (w.sh(bare('shop-api'), 'merge-base', '--is-ancestor', k.release, n), true)), 'the default branch\'s commit, on a wip/ branch');
  assert.ok(has('shop-web', (n) => n.startsWith('wip/') && w.sh(bare('shop-web'), 'show', `${n}:draft-${k.tag}.txt`) === `not committed ${k.tag}`), 'the work, on a wip/ branch');
  assert.ok(has('shop-workspace', (n) => w.sh(bare('shop-workspace'), 'show', `${n}:ai_brain/claude-memory/note-${k.tag}.md`) === `learned ${k.tag}`), 'the memory');
}

const nothingLeft = () => assert.deepEqual(fs.existsSync(A.projects) ? fs.readdirSync(A.projects).filter((n) => n.startsWith('.shop.')) : [], [], 'nothing half made left');

for (const step of ['fetch', 'memory', 'wip-commit', 'wip', 'push', 'check', 'rename', 'link', 'file', 'delete']) {
  test(`killed right after "${step}": the next drop ends right, nothing is lost, and get works`, async () => {
    const k = await busyProject(step);
    const kill = Object.assign(new Error(`killed after ${step}`), { killed: true });
    await assert.rejects(dropOn(A, ['shop'], { answers: owner('shop', '2'), onStep: (s) => {
      if (s === step) throw kill;
    } }), /killed after/);
    if (['rename', 'link', 'file'].includes(step)) {
      // The folder was renamed aside: status names it with the command that finishes it, and changes nothing.
      const { main } = await import('../../src/workspace/cli.mjs');
      let text = '';
      const { makeUi } = await import('../../src/setup/ui.mjs');
      A.use();
      await main(['status'], { ui: makeUi({ interactive: false, write: (s) => (text += s) }), write: (s) => (text += s) });
      assert.match(text, /\.shop\.dropping-\d{8}-\d{6} {2}a drop that was cut off \(it had passed its whole check\): finish it with {2}hoprig drop shop/);
    }
    const again = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
    assert.equal(again.code, 0, again.text);
    assert.equal(fs.existsSync(A.shop), false);
    nothingLeft();
    allOnServer(k);
    const g = await getOn(A, ['shop']);
    assert.equal(g.code, 0, g.text);
    assert.ok(fs.existsSync(path.join(web(), 'README.md')));
  });
}

test('a drop cut off after its rename is finished by get, which then gets the project again', async () => {
  await busyProject('byget');
  await assert.rejects(dropOn(A, ['shop'], { answers: owner('shop', '2'), onStep: (s) => {
    if (s === 'rename') throw new Error('killed');
  } }));
  const g = await getOn(A, ['shop']);
  assert.equal(g.code, 0, g.text);
  assert.match(g.text, /a drop that was cut off is finished/);
  nothingLeft();
  assert.ok(fs.existsSync(path.join(api(), 'README.md')));
  const links = fs.readdirSync(path.join(A.claude, 'projects')).filter((n) => fs.lstatSync(path.join(A.claude, 'projects', n, 'memory'), { throwIfNoEntry: false })?.isSymbolicLink());
  assert.ok(links.length, 'get made the memory link again (the drop\'s finish took only the old one)');
});

test('the second check runs: a file that comes between the acts and the removal keeps the project here', async () => {
  await reset(A);
  w.sh(web(), 'switch', '-q', '-c', 'late');
  w.commit(web(), 'late.txt', 'x\n');
  w.sh(web(), 'switch', '-q', 'main');
  const r = await dropOn(A, ['shop'], { onStep: (s) => {
    if (s === 'check') fs.writeFileSync(path.join(api(), 'came-late.txt'), 'only here\n');
  } });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /after the pushes, still only here: projects\/shop\/code\/shop-api: 1 file not committed/);
  assert.ok(fs.existsSync(path.join(api(), 'came-late.txt')), 'nothing removed');
  assert.ok(onServer(w, 'shop-web', 'refs/heads/late'), 'what was pushed stays pushed');
});

test('work done in the renamed folder after a cut is never deleted: get and drop keep the folder and name it', async () => {
  await reset(A);
  await assert.rejects(dropOn(A, ['shop'], { onStep: (s) => {
    if (s === 'rename') throw new Error('killed');
  } }));
  const away = path.join(A.projects, fs.readdirSync(A.projects).find((n) => n.startsWith('.shop.dropping-')));
  // A terminal open in the project follows the rename: the owner commits there, and leaves an edit.
  const later = w.commit(path.join(away, 'code', 'shop-api'), 'later.txt', 'work after the cut\n');
  fs.writeFileSync(path.join(away, 'code', 'shop-web', 'README.md'), 'an edit after the cut\n');
  const g = await getOn(A, ['shop']);
  assert.equal(g.code, 0, g.text);
  assert.match(g.text, /\.shop\.dropping-\d{8}-\d{6}: left by a drop that was cut off, it holds what is not on the git server now \(.*\), so it is kept: push that from there, then hoprig drop shop finishes it/);
  assert.doesNotMatch(g.text, /take the folder back/, 'get clones shop right after: the folder cannot be taken back under that name');
  assert.equal(w.sh(path.join(away, 'code', 'shop-api'), 'rev-parse', 'HEAD'), later, 'the commit is still here');
  assert.ok(fs.existsSync(path.join(A.shop, 'README.md')), 'get went on and got the project');
  const d = await dropOn(A, ['shop']);
  assert.equal(d.code, 1, d.text);
  assert.match(d.text, /projects\/\.shop\.dropping-\d{8}-\d{6}: left by a drop that was cut off/);
  assert.doesNotMatch(d.text, /take the folder back/, 'shop is on disk again: it cannot be taken back under that name');
  assert.ok(fs.existsSync(away), 'drop keeps it too');
  // Pushed and undone there, the next drop finishes it.
  w.sh(path.join(away, 'code', 'shop-api'), 'push', '-q');
  w.sh(path.join(away, 'code', 'shop-web'), 'checkout', '--', 'README.md');
  const again = await dropOn(A, ['shop']);
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /finished projects\/\.shop\.dropping-\d{8}-\d{6}, left by a drop that was cut off \(its whole check passed again\)/);
  nothingLeft();
  assert.equal(onServer(w, 'shop-api', 'refs/heads/main'), later);
});

test('a leftover whose delete stopped partway (its git folders gone) is kept with words that say so and the delete command, never "push from there"', async () => {
  for (const gone of [['.git', 'code/shop-api/.git', 'code/shop-web/.git']]) {
    await reset(A);
    await assert.rejects(dropOn(A, ['shop'], { onStep: (s) => {
      if (s === 'rename') throw new Error('killed');
    } }));
    const away = path.join(A.projects, fs.readdirSync(A.projects).find((n) => n.startsWith('.shop.dropping-')));
    for (const g of gone) fs.rmSync(path.join(away, ...g.split('/')), { recursive: true, force: true });
    // The delete command as this system's shell reads it (dropacts.mjs deleteCommand: PowerShell on Windows).
    const { deleteCommand } = await import('../../src/workspace/dropacts.mjs');
    const words = new RegExp(`\\.shop\\.dropping-\\d{8}-\\d{6}: left by a drop that was cut off, and a delete of it stopped partway: its git folders are gone, so nothing in it can be pushed or checked any more, and it is kept: look at it first and copy out what you still need, then delete it yourself\\n\\s+${deleteCommand(away).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const g = await getOn(A, ['shop']);
    assert.equal(g.code, 0, g.text);
    assert.match(g.text, words, `${gone.join(' ')}: ${g.text}`);
    assert.doesNotMatch(g.text, /push that from there|git -C \S+dropping\S+ status/);
    const d = await dropOn(A, ['shop']);
    assert.equal(d.code, 1, d.text);
    assert.match(d.text, words, d.text);
    assert.ok(fs.existsSync(path.join(away, 'README.md')), 'kept: nothing deleted without the owner');
    fs.rmSync(away, { recursive: true, force: true });
  }
});

test('a leftover whose delete stopped partway where some parts still have their git folder: those are named with git status, never rm -rf, and a commit only there can still be pushed', async () => {
  // The last look's case D: the top's .git gone, a commit made in code/shop-api after the cut; and the other way round.
  for (const { gone, commitIn, goneWords, aliveWords } of [
    { gone: ['.git'], commitIn: 'code/shop-api', goneWords: 'its folder lost its git folder', aliveWords: 'code/shop-api and code/shop-web still have their git folders' },
    { gone: ['code/shop-api/.git'], commitIn: 'code/shop-web', goneWords: 'code/shop-api lost its git folder', aliveWords: 'its folder and code/shop-web still have their git folders' },
  ]) {
    await reset(A);
    await assert.rejects(dropOn(A, ['shop'], { onStep: (s) => {
      if (s === 'rename') throw new Error('killed');
    } }));
    const away = path.join(A.projects, fs.readdirSync(A.projects).find((n) => n.startsWith('.shop.dropping-')));
    for (const g of gone) fs.rmSync(path.join(away, ...g.split('/')), { recursive: true, force: true });
    const later = w.commit(path.join(away, ...commitIn.split('/')), 'later.txt', 'after the cut\n');
    for (const r of [await getOn(A, ['shop']), await dropOn(A, ['shop'])]) {
      assert.match(r.text, new RegExp(`\\.shop\\.dropping-\\d{8}-\\d{6}: left by a drop that was cut off, and a delete of it stopped partway: ${goneWords}, so nothing there can be pushed or checked any more; ${aliveWords}, so what is only there can still be pushed`), `${gone}: ${r.text}`);
      assert.doesNotMatch(r.text, /nothing in it can be pushed|rm -rf|Remove-HoprigTree/, `${gone}: never the delete for what can still be pushed`);
      assert.match(r.text, new RegExp(`git -C \\S+dropping\\S+/${commitIn.replace('/', '\\/')}${Q} status`), `${gone}: ${r.text}`);
      assert.doesNotMatch(r.text, /take the folder back/);
    }
    assert.ok(fs.existsSync(path.join(away, 'README.md')), 'kept: nothing deleted without the owner');
    // Following the words keeps the commit: the push works from there.
    w.sh(path.join(away, ...commitIn.split('/')), 'push', '-q', 'origin', 'HEAD:refs/heads/kept');
    assert.equal(onServer(w, commitIn.split('/').pop(), 'refs/heads/kept'), later);
    fs.rmSync(away, { recursive: true, force: true });
  }
});
