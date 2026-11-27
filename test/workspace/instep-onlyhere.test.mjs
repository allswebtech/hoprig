// The check of what is only on this computer counts nothing of Hoprig's own: the safety copies of the map's rule
// (refs/hoprig/kept), the untouched starting credentials folder that was set aside, and this computer's own file
// that `hoprig get` writes (it is committed at once, as drop does).
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert, dropWorld, getOn } from './dropfix.mjs';

const w = await dropWorld('instep-onlyhere', { labels: ['desk'] });
test.after(() => w.cleanup());
const [D] = w.computers;
const { leaveCheck } = await import('../../src/workspace/leave.mjs');
const { CREDENTIALS_README } = await import('../../src/workspace/setup.mjs');
const homeLook = async () => ({ items: [], asks: [], outside: [], notChecked: [] });
const look = () => leaveCheck({ dir: D.ws, projects: D.projects, home: D.home, homeLook, cheap: true });
const said = (r) => JSON.stringify(r.items.map((i) => `${i.where} ${i.what}`), null, 1);

test('get commits this computer\'s file at once, so the brain holds nothing only here', async () => {
  D.use();
  w.sh(D.brain, 'add', '-A');
  try {
    w.sh(D.brain, 'commit', '-q', '-m', 'the label file');
  } catch {
    /* nothing to commit */
  }
  w.sh(D.brain, 'push', '-q', '-u', 'origin', 'main');
  const got = await getOn(D, ['shop']);
  assert.equal(got.code, 0, got.text);
  assert.equal(w.sh(D.brain, 'status', '--porcelain', '--', 'computers'), '', 'the file is committed');
  assert.match(w.sh(D.brain, 'log', '-1', '--format=%s'), /workspace map/i);
});

test('the map rule\'s safety copy and the set-aside starting credentials folder are not counted', async () => {
  D.use();
  w.sh(D.brain, 'push', '-q'); // what get committed goes up: the brain holds nothing of the owner's
  const own = w.commit(D.brain, 'x-kept.txt', 'an old commit the rule replaced\n', 'Update AI memory');
  w.sh(D.brain, 'update-ref', 'refs/hoprig/kept/old', own);
  w.sh(D.brain, 'reset', '-q', '--hard', 'origin/main');
  const aside = path.join(D.ws, 'credentials.unused-20261127-0900');
  fs.mkdirSync(aside, { recursive: true });
  fs.writeFileSync(path.join(aside, 'README.md'), CREDENTIALS_README);
  const r = await look();
  assert.deepEqual(r.items, [], said(r));
});

test('a set-aside credentials folder the owner put something into IS counted', async () => {
  D.use();
  fs.writeFileSync(path.join(D.ws, 'credentials.unused-20261127-0900', 'mine.txt'), 'something of mine\n');
  const r = await look();
  assert.ok(r.items.some((i) => /credentials\.unused/.test(i.where)), said(r));
});

test('a ref of the owner\'s own under another name is still counted', async () => {
  D.use();
  fs.rmSync(path.join(D.ws, 'credentials.unused-20261127-0900'), { recursive: true, force: true });
  const own = w.commit(D.brain, 'y.txt', 'mine\n', 'My own note');
  w.sh(D.brain, 'update-ref', 'refs/notes/mine', own);
  w.sh(D.brain, 'reset', '-q', '--hard', 'origin/main');
  const r = await look();
  assert.ok(r.items.some((i) => /refs\/notes\/mine/.test(i.what)), said(r));
});
