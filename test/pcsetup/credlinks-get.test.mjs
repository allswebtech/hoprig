// Credential links made by a fresh clone's finish step (hoprig get) and by `hoprig workspace link`, each with
// --dry-run checked against a whole-home snapshot (dryrun-fixture.mjs: every path, size, mode, time, inode, content
// hash and the refs of every repository): a dry run changes nothing, the real run makes the link.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from './dryrun-fixture.mjs';

const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const ws = await import('../../src/workspace/cli.mjs');
const get = (args) => runCli((a, o) => getMain(a, o), args);
const workspace = (args) => runCli((a, o) => ws.main(a, o), args);

/** The credentials folder of the world, with one file per project. */
function credsFolder(w) {
  const c = path.join(w.ws, 'credentials');
  for (const [rel, text] of [['blog/blog.env', 'DB=blog-secret\n'], ['shop/api.env', 'API_KEY=shop-secret\n']]) {
    fs.mkdirSync(path.dirname(path.join(c, rel)), { recursive: true });
    fs.writeFileSync(path.join(c, rel), text);
  }
  fs.chmodSync(c, 0o700);
  return c;
}

/** blog's parent on the "server" gets a credential link (its .gitignore ignores the place). */
function blogWithLink(w) {
  const seed = path.join(w.root, 'seed', 'blog-links');
  w.sh(w.root, 'clone', '-q', gh('blog-workspace'), seed);
  const pj = JSON.parse(fs.readFileSync(path.join(seed, 'project.json'), 'utf8'));
  pj.credentials = { '.env.local': 'blog/blog.env' };
  fs.writeFileSync(path.join(seed, 'project.json'), `${JSON.stringify(pj, null, 2)}\n`);
  fs.appendFileSync(path.join(seed, '.gitignore'), '/.env.local\n');
  w.sh(seed, 'commit', '-q', '-am', 'credential link');
  w.sh(seed, 'push', '-q');
  fs.rmSync(seed, { recursive: true, force: true });
}

test('get of a project whose project.json names a link: --dry-run changes nothing, get makes it', async (tc) => {
  const w = await dryWorld(tc, 'credget');
  credsFolder(w);
  blogWithLink(w);
  const d = await w.unchanged('get blog --dry-run', () => get(['blog', '--dry-run']));
  assert.equal(d.code, 0, d.text);
  // Not here yet: a dry run clones nothing, so it names the links as part of what a fresh clone gets.
  assert.match(d.text, /set it up: .*the credential links its project\.json names/);
  const real = await w.changed('get blog', () => get(['blog', '--yes']));
  assert.equal(real.r.code, 0, real.r.text);
  const link = path.join(w.projects, 'blog', '.env.local');
  assert.equal(path.isAbsolute(fs.readlinkSync(link)), false);
  assert.equal(fs.readFileSync(link, 'utf8'), 'DB=blog-secret\n');
  assert.equal(w.sh(path.join(w.projects, 'blog'), 'status', '--porcelain'), '', 'the link is ignored by the project');
  assert.equal(real.r.text.includes('blog-secret'), false, 'no value in the output');
});

test('get while the credentials folder is not here: the link waits, and workspace link makes it later', async (tc) => {
  const w = await dryWorld(tc, 'credwait');
  blogWithLink(w);
  const r = await get(['blog', '--yes']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /blog\/\.env\.local → credentials\/blog\/blog\.env: waiting for the credentials/);
  assert.equal(fs.lstatSync(path.join(w.projects, 'blog', '.env.local'), { throwIfNoEntry: false }), undefined, 'nothing made in its place');
  credsFolder(w);
  const d = await w.unchanged('workspace link --dry-run', () => workspace(['link', '--dry-run']));
  assert.match(d.text, /blog\/\.env\.local → credentials\/blog\/blog\.env: would link/);
  const l = await workspace(['link', '--yes']);
  assert.match(l.text, /blog\/\.env\.local → credentials\/blog\/blog\.env: linked now/);
  assert.equal(fs.readFileSync(path.join(w.projects, 'blog', '.env.local'), 'utf8'), 'DB=blog-secret\n');
});

test('workspace link on a project that is here: a link in a code repository; over a real file refused and named', async (tc) => {
  const w = await dryWorld(tc, 'credlink');
  credsFolder(w);
  const pjFile = path.join(w.shop, 'project.json');
  const pj = JSON.parse(fs.readFileSync(pjFile, 'utf8'));
  pj.credentials = { 'code/shop-api/.env': 'shop/api.env', 'AGENTS.md': 'shop/api.env' };
  fs.writeFileSync(pjFile, `${JSON.stringify(pj, null, 2)}\n`);
  await new Promise((r) => setTimeout(r, 20));
  const d = await w.unchanged('workspace link --dry-run', () => workspace(['link', '--dry-run']));
  assert.match(d.text, /shop\/code\/shop-api\/\.env → credentials\/shop\/api\.env: would link/);
  assert.match(d.text, /shop\/AGENTS\.md → credentials\/shop\/api\.env: not made: .*AGENTS\.md is a real file/);
  const r = await workspace(['link', '--yes']);
  assert.equal(r.code, 1, 'a link that is refused is a non-zero exit');
  assert.equal(fs.readFileSync(path.join(w.shop, 'code', 'shop-api', '.env'), 'utf8'), 'API_KEY=shop-secret\n');
  assert.equal(fs.readFileSync(path.join(w.shop, 'AGENTS.md'), 'utf8'), '# shop\n', 'never replaced');
  assert.equal(w.sh(path.join(w.shop, 'code', 'shop-api'), 'status', '--porcelain'), '');
  assert.equal(r.text.includes('shop-secret'), false);
  // Run again: the right link is left as it is.
  const again = await workspace(['link', '--yes']);
  assert.match(again.text, /shop\/code\/shop-api\/\.env → credentials\/shop\/api\.env: linked$/m);
});

test('get while the credentials are not here, then the credentials arrive: the next get makes the link', async (tc) => {
  const w = await dryWorld(tc, 'crednext');
  blogWithLink(w);
  const g1 = await get(['blog', '--yes']);
  assert.equal(g1.code, 0, g1.text);
  assert.match(g1.text, /blog\/\.env\.local → credentials\/blog\/blog\.env: waiting for the credentials/);
  credsFolder(w);
  const d = await w.unchanged('get blog --dry-run (here already)', () => get(['blog', '--dry-run']));
  assert.equal(d.code, 0, d.text);
  const g2 = await get(['blog', '--yes']);
  assert.equal(g2.code, 0, g2.text);
  const link = path.join(w.projects, 'blog', '.env.local');
  assert.equal(fs.readFileSync(link, 'utf8'), 'DB=blog-secret\n', g2.text);
  assert.equal(path.isAbsolute(fs.readlinkSync(link)), false);
  assert.match(g2.text, /blog\/\.env\.local → credentials\/blog\/blog\.env: linked now/);
  assert.doesNotMatch(g2.text, /would also link blog\/\.env\.local/);
  assert.equal(g2.text.includes('blog-secret'), false);
  // A third get: the right link is left as it is.
  const g3 = await get(['blog', '--yes']);
  assert.equal(g3.code, 0, g3.text);
  assert.equal(fs.readFileSync(link, 'utf8'), 'DB=blog-secret\n');
});

test('workspace link with a cut-off credentials clone: the link waits and the exit is 0', async (tc) => {
  const w = await dryWorld(tc, 'credcut');
  const pjFile = path.join(w.shop, 'project.json');
  const pj = JSON.parse(fs.readFileSync(pjFile, 'utf8'));
  pj.credentials = { 'code/shop-api/.env': 'shop/api.env' };
  fs.writeFileSync(pjFile, `${JSON.stringify(pj, null, 2)}\n`);
  const c = path.join(w.ws, 'credentials');
  fs.mkdirSync(c, { mode: 0o700 });
  w.sh(c, 'init', '-q', '-b', 'main'); // what a clone killed while it fetched leaves: .git, no commit, no index
  fs.rmSync(path.join(c, '.git', 'index'), { force: true });
  await new Promise((r) => setTimeout(r, 20));
  const d = await w.unchanged('workspace link --dry-run', () => workspace(['link', '--dry-run']));
  assert.match(d.text, /shop\/code\/shop-api\/\.env → credentials\/shop\/api\.env: waiting for the credentials/);
  assert.doesNotMatch(d.text, /not made: its target is not in the credentials folder/);
  assert.equal(d.code, 0, d.text);
  const s = await w.unchanged('workspace status', () => workspace(['status']));
  assert.match(s.text, /shop\/code\/shop-api\/\.env → credentials\/shop\/api\.env: waiting for the credentials/);
});
