// The words around a code repository that is not here: the command is a real one (hoprig get <project>), the restore
// dry run does not say a project is missing when only a code repository of it is, and status does not tell an owner
// whose brain is behind to add a folder that the map may have already.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert, dropWorld, getOn } from './dropfix.mjs';
import { quietUi } from './gitfix.mjs';

const w = await dropWorld('instep-words', { labels: ['desk'] });
test.after(() => w.cleanup());
const [D] = w.computers;
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { main } = await import('../../src/workspace/cli.mjs');

test('a code repository that is not here: sync names `hoprig get shop`, never a literal dots', async () => {
  const r = await getOn(D, ['shop']);
  assert.equal(r.code, 0, r.text);
  D.use();
  fs.rmSync(path.join(D.shop, 'code', 'shop-web'), { recursive: true, force: true });
  const s = await syncAll({ dir: D.ws, projects: D.projects, only: 'shop' });
  const todo = s.repos.flatMap((x) => x.todo).find((t) => /not cloned/.test(t.why));
  assert.ok(todo, JSON.stringify(s.repos));
  assert.equal(todo.command, 'hoprig get shop');
  assert.doesNotMatch(JSON.stringify(s), /…|\.\.\./);
});

test('the restore dry run: shop is here, one code repository is missing', async () => {
  D.use();
  const { ui, text } = await quietUi();
  const r = await restoreWorkspace(w.u.brain, { ui, dryRun: true, dir: D.ws, projects: D.projects });
  assert.deepEqual(r.codeMissing, { shop: 1 });
  assert.ok(!(r.notHere || []).includes('shop'), JSON.stringify(r.notHere));
  assert.ok((r.notHere || []).includes('blog'), 'a project that is not here at all is still said so');
});

test('status: a folder the map lacks, while the brain here is behind, is not told to be added', async () => {
  D.use();
  const peer = w.clone(w.u.brain, path.join(w.root, 'peer-brain'));
  w.commit(peer, 'more.md', 'a new commit on the git server\n');
  w.sh(peer, 'push', '-q');
  w.sh(D.brain, 'fetch', '-q');
  fs.mkdirSync(path.join(D.projects, 'stray'), { recursive: true });
  w.sh(path.join(D.projects, 'stray'), 'init', '-q');
  w.commit(path.join(D.projects, 'stray'), 'a.txt', 'x\n');
  let out = '';
  const q = await quietUi();
  await main(['status'], { ui: q.ui, write: (x) => (out += x) });
  const t = q.text() + out;
  assert.match(t, /stray[^\n]*the AI brain here is behind its git server/);
  assert.doesNotMatch(t, /stray[^\n]*add it with/);
});
