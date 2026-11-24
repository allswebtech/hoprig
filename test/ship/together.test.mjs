// Put together (src/ship/together.mjs): the picked task branches merge in the owner's order into work/<name>-all in a
// worktree of Hoprig's own; a conflict stops there with the merge in progress and says which tasks meet in which
// files; "Go on" is refused until the merge is committed without conflict markers, then merges the next branch. The
// owner's checkout never moves (HEAD, index, files, branches, stash, config). A name in use is refused unless it is
// the same open put-together.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkoutState, tempShip, write } from './helpers.mjs';

const t = tempShip('ship-together');
test.after(() => t.cleanup());
const { candidates, putTogether, goOn, conflictBrief, togetherId, readTogether, noteSession, DEVELOPER_ROLE } = await import('../../src/ship/together.mjs');
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'app.js': 'const price = 1;\n' });
t.branch(shop, 'work/cart', { 'cart.js': 'export const cart = [];\n' }, 'Add a cart');
t.branch(shop, 'work/price-a', { 'app.js': 'const price = 2;\n' }, 'Price two');
t.branch(shop, 'feature/price-b', { 'app.js': 'const price = 3;\n' }, 'Price three');
t.git(shop, 'stash', 'list');
write(shop, { 'notes.txt': 'not committed\n' }); // the owner's own work in progress stays as it is

test('the picker lists the branches not in main, work/ first, with the titles Work knows', async () => {
  const c = await candidates(shop, { titles: { 'work/cart': 'Add a cart to the shop' } });
  assert.equal(c.base, 'main');
  assert.deepEqual(c.branches.map((b) => b.name), ['work/cart', 'work/price-a', 'feature/price-b']);
  assert.equal(c.branches[0].title, 'Add a cart to the shop');
  assert.equal(c.branches[0].commits, 1);
});

test('three branches, one conflict: it stops, says who meets where, Go on waits for a clean commit', async () => {
  const before = checkoutState(shop);
  const r = await putTogether(shop, { name: 'tuesday', branches: ['work/cart', 'work/price-a', 'feature/price-b'], titles: { 'work/price-a': 'Price two' } });
  assert.equal(r.branch, 'work/tuesday-all');
  assert.ok(r.dir.startsWith(fs.realpathSync(process.env.HOPRIG_STATE_DIR)));
  assert.deepEqual(r.done.map((d) => d.branch), ['work/cart', 'work/price-a']);
  assert.equal(r.conflict.branch, 'feature/price-b');
  assert.deepEqual(r.conflict.files, ['app.js']);
  assert.deepEqual(r.conflict.meets, [{ branch: 'work/price-a', files: ['app.js'] }]);
  assert.equal(r.finished, false);
  // The merge is left in progress, never forced.
  assert.ok(fs.existsSync(path.join(t.git(r.dir, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD')));
  assert.match(fs.readFileSync(path.join(r.dir, 'app.js'), 'utf8'), /<<<<<<< /);
  const brief = conflictBrief(r);
  assert.ok(brief.startsWith(DEVELOPER_ROLE));
  assert.match(brief, /feature\/price-b/);
  assert.match(brief, /work\/price-a \("Price two"\) also changed: app\.js/);
  await assert.rejects(goOn(r.id), (e) => e.status === 409 && /not finished/.test(e.message));

  // A session that commits with the markers still in: refused.
  execFileSync('git', ['-C', r.dir, 'commit', '-q', '-a', '--no-edit']);
  await assert.rejects(goOn(r.id), (e) => e.status === 409 && /markers/.test(e.message));
  // Resolved for real: both meant something; the merge is amended clean.
  fs.writeFileSync(path.join(r.dir, 'app.js'), 'const price = 3; // two, then three\n');
  execFileSync('git', ['-C', r.dir, 'commit', '-q', '-a', '--amend', '--no-edit']);
  const done = await goOn(r.id);
  assert.equal(done.finished, true);
  assert.deepEqual(done.done.map((d) => [d.branch, !!d.resolved]), [['work/cart', false], ['work/price-a', false], ['feature/price-b', true]]);
  const log = t.git(shop, 'log', '--format=%s', 'work/tuesday-all');
  assert.match(log, /Put together: work\/cart/);
  assert.equal(t.git(shop, 'rev-list', '--count', '--merges', 'main..work/tuesday-all'), '3', 'every merge is --no-ff');
  // main and the owner's checkout did not move.
  assert.deepEqual({ ...checkoutState(shop), refs: null }, { ...before, refs: null });
  const refs = (s) => s.refs.split('\n').filter((l) => !l.startsWith('refs/heads/work/tuesday-all '));
  assert.deepEqual(refs(checkoutState(shop)), refs(before));
  assert.deepEqual(t.trapped(), []);
});

test('a name in use is refused unless it is the same open put-together', async () => {
  const again = await putTogether(shop, { name: 'tuesday', branches: ['work/cart', 'work/price-a', 'feature/price-b'] });
  assert.equal(again.id, togetherId(shop, 'tuesday'));
  assert.equal(again.finished, true);
  await assert.rejects(putTogether(shop, { name: 'tuesday', branches: ['work/cart'] }), (e) => e.details.code === 'name-used');
  t.git(shop, 'branch', 'work/mine-all', 'main');
  await assert.rejects(putTogether(shop, { name: 'mine', branches: ['work/cart'] }), (e) => e.details.code === 'name-used');
  await assert.rejects(putTogether(shop, { name: 'x', branches: ['main'] }), /not a finished task branch/);
  await assert.rejects(putTogether(shop, { name: 'x', branches: ['--orphan'] }), /not a finished task branch/);
  await assert.rejects(putTogether(shop, { name: 'Bad Name', branches: ['work/cart'] }), /short word/);
});

test('a conflict is handed to one session only', async () => {
  t.branch(shop, 'work/price-c', { 'app.js': 'const price = 4;\n' }, 'Price four');
  const r = await putTogether(shop, { name: 'wednesday', branches: ['work/price-a', 'work/price-c'] });
  assert.equal(r.conflict.branch, 'work/price-c');
  noteSession(r.id, 'chat-1');
  assert.throws(() => noteSession(r.id, 'chat-2'), (e) => e.details.code === 'handed');
  assert.equal(readTogether(r.id).conflict.session, 'chat-1');
});

test('Go on pressed twice at once merges once', async () => {
  t.branch(shop, 'work/one-more', { 'more.txt': 'more\n' }, 'One more');
  t.branch(shop, 'work/price-d', { 'app.js': 'const price = 5;\n' }, 'Price five');
  const r = await putTogether(shop, { name: 'thursday', branches: ['work/price-a', 'work/price-d', 'work/one-more'] });
  assert.equal(r.conflict.branch, 'work/price-d');
  fs.writeFileSync(path.join(r.dir, 'app.js'), 'const price = 5;\n');
  execFileSync('git', ['-C', r.dir, 'commit', '-q', '-a', '--no-edit']);
  const both = await Promise.allSettled([goOn(r.id), goOn(r.id)]);
  assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1, 'one goes on');
  assert.equal(both.find((x) => x.status === 'rejected').reason.status, 409);
  const after = readTogether(r.id);
  assert.equal(after.finished, true);
  assert.deepEqual(after.done.map((d) => d.branch), ['work/price-a', 'work/price-d', 'work/one-more']);
  assert.equal(t.git(shop, 'rev-list', '--count', '--merges', 'main..work/thursday-all'), '3');
});
