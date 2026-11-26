// A drop of a project that has credential links (project.json "credentials", made by hoprig get from the workspace's
// credentials folder). A link that is provably one (a symbolic link project.json names, pointing to the very place it
// names: get's own check, credlinks.mjs) goes without a word, since get makes it again: --check says how many go, never
// a target. The credentials folder itself is never touched (every path, mode, time, inode and hash of it, and the refs
// of its repository, are the same after), and a get afterwards makes the links again. What only looks like one stays
// on the typed list: a real file where the link should be, a link that points elsewhere, a link project.json does not
// name, and a folder at a place project.json names.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert, dropOn, dropWorld, getOn, reset } from './dropfix.mjs';

const w = await dropWorld('creds');
test.after(() => w.cleanup());
const [A] = w.computers;
const creds = path.join(A.ws, 'credentials');
const api = () => path.join(A.shop, 'code', 'shop-api');
const links = () => [path.join(A.shop, '.env'), path.join(api(), '.env')];
const PLACES = ['projects/shop/.env', 'projects/shop/code/shop-api/.env'];
const re = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const snap = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      out[path.relative(dir, p)] = [st.mode, st.size, st.mtimeMs, st.ino, st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : st.isSymbolicLink() ? fs.readlinkSync(p) : 'dir'];
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  out['refs:'] = execFileSync('git', ['-C', dir, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' });
  return out;
};

// Once: the credentials folder (a repository of its own, credrepo.mjs) with the files, and project.json naming a link in
// the parent (.env, ignored there) and one in a code repository (.env, ignored there); then a real get makes them.
let ready = null;
const setUp = () => (ready ||= (async () => {
  fs.mkdirSync(path.join(creds, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(creds, 'shop', 'shop.env'), 'TOKEN=parent\n');
  fs.writeFileSync(path.join(creds, 'shop', 'api.env'), 'TOKEN=api\n');
  fs.writeFileSync(path.join(creds, 'shop', 'other.env'), 'TOKEN=other\n');
  w.sh(creds, 'init', '-q', '-b', 'main');
  w.sh(creds, 'add', '-A');
  w.sh(creds, 'commit', '-q', '-m', 'keys');
  const seed = path.join(w.root, 'seed-shop');
  w.sh(seed, 'pull', '-q');
  const pj = JSON.parse(fs.readFileSync(path.join(seed, 'project.json'), 'utf8'));
  w.commit(seed, 'project.json', JSON.stringify({ ...pj, credentials: { '.env': 'shop/shop.env', 'code/shop-api/.env': 'shop/api.env' } }, null, 2) + '\n');
  w.sh(seed, 'push', '-q');
  const g = await getOn(A, ['shop']);
  assert.equal(g.code, 0, g.text);
})());
const madeByGet = () => {
  for (const l of links()) assert.ok(fs.lstatSync(l).isSymbolicLink(), `${l} is a link made by get`);
};

test('provable credential links go without a word and without a terminal; --check counts them; the credentials folder is never touched; get makes them again', async () => {
  await setUp();
  madeByGet();
  assert.equal(fs.readFileSync(links()[1], 'utf8'), 'TOKEN=api\n');
  const before = snap(creds);
  const chk = await dropOn(A, ['shop', '--check']);
  assert.equal(chk.code, 0, chk.text);
  assert.match(chk.text, /nothing of it exists only here/);
  assert.match(chk.text, /drop would take away 2 credential links that project\.json names \(only the links: the credentials stay in their folder\), and hoprig get makes them again/);
  for (const p of PLACES) assert.doesNotMatch(chk.text, new RegExp(`${re(p)} `), `${p} is not on the typed list`);
  assert.doesNotMatch(chk.text, /TOKEN|shop\.env|api\.env|Files git ignores/, 'no target, no content, no list');
  const dry = await dropOn(A, ['shop', '--dry-run']);
  assert.match(dry.text, /\(dry run\) drop would take away 2 credential links/);
  const d = await dropOn(A, ['shop']); // no terminal: nothing to ask
  assert.equal(d.code, 0, d.text);
  assert.equal(fs.existsSync(A.shop), false, 'the project and its links are gone');
  for (const l of links()) assert.throws(() => fs.lstatSync(l), { code: 'ENOENT' });
  assert.deepEqual(snap(creds), before, 'the credentials folder is exactly as it was');

  // get brings the project back with its links.
  const again = await getOn(A, ['shop']);
  assert.equal(again.code, 0, again.text);
  madeByGet();
  assert.equal(fs.readFileSync(links()[0], 'utf8'), 'TOKEN=parent\n');
  assert.deepEqual(snap(creds), before);
});

test('what only looks like a credential link stays on the typed list: a real file there, a link elsewhere, a link project.json does not name, a folder there', async () => {
  await setUp();
  const CASES = [
    { what: 'a real file where the link should be', touched: 0, count: 1, listed: /projects\/shop\/\.env {2}\.env file, 7 B/,
      make: () => { fs.unlinkSync(links()[0]); fs.writeFileSync(links()[0], 'MINE=1\n'); } },
    { what: 'a link that points elsewhere in the credentials folder', touched: 1, count: 1, listed: /projects\/shop\/code\/shop-api\/\.env {2}link \(only the link goes/,
      make: () => { fs.unlinkSync(links()[1]); fs.symlinkSync(path.relative(api(), path.join(creds, 'shop', 'other.env')), links()[1]); } },
    { what: 'a link project.json does not name', touched: null, count: 2, listed: /projects\/shop\/code\/shop-api\/deploy\.pem {2}link \(only the link goes/,
      make: () => fs.symlinkSync(path.relative(api(), path.join(creds, 'shop', 'api.env')), path.join(api(), 'deploy.pem')) },
    { what: 'a folder at a place project.json names', touched: 0, count: 1, listed: /projects\/shop\/\.env\/ {2}folder, 2 B, 1 file/,
      make: () => { fs.unlinkSync(links()[0]); fs.mkdirSync(links()[0]); fs.writeFileSync(path.join(links()[0], 'mine.txt'), 'x\n'); } },
  ];
  for (const c of CASES) {
    await reset(A);
    madeByGet();
    const before = snap(creds);
    c.make();
    const chk = await dropOn(A, ['shop', '--check']);
    assert.equal(chk.code, 1, `${c.what}: ${chk.text}`);
    assert.match(chk.text, c.listed, `${c.what}: ${chk.text}`);
    assert.match(chk.text, new RegExp(`drop would take away ${c.count} credential links? that project\\.json names`), `${c.what}: the provable one still goes`);
    PLACES.forEach((p, i) => {
      if (i !== c.touched) assert.doesNotMatch(chk.text, new RegExp(`${re(p)} `), `${c.what}: the untouched ${p} is not listed`);
    });
    const d = await dropOn(A, ['shop']);
    assert.equal(d.code, 1, `${c.what}: without a terminal it is kept: ${d.text}`);
    assert.ok(fs.existsSync(A.shop), `${c.what}: kept`);
    assert.deepEqual(snap(creds), before, `${c.what}: the credentials folder is untouched`);
  }
});
