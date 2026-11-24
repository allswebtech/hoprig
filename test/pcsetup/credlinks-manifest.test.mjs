// The "credentials" key of project.json (credential links): where the link is, relative to the project, and what it
// points at, relative to the credentials folder. Each entry is checked strictly; a refused one is named and left out,
// never a refusal of the whole file. writeManifest keeps the key as the file has it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { CRED_LINKS_MAX, checkCredLinks, validateManifest, writeManifest } = await import('../../src/pcsetup/workspace.mjs');
const { linkLine } = await import('../../src/workspace/credlinks.mjs');

test('a plain link is kept, as a file or a folder target', () => {
  const v = validateManifest({ name: 'shop', repos: [], credentials: { 'code/shop/.env.local': 'shop/shop.env.local', 'code/shop/cred': 'shop/keys' } });
  assert.equal(v.ok, true);
  assert.deepEqual(v.manifest.credentials, { 'code/shop/.env.local': 'shop/shop.env.local', 'code/shop/cred': 'shop/keys' });
  assert.equal(v.manifest.credentialsRefused, undefined);
  assert.deepEqual(v.warnings, []);
});

test('a project.json without the key has none', () => {
  const v = validateManifest({ name: 'shop', repos: [] });
  assert.equal(v.ok, true);
  assert.equal('credentials' in v.manifest, false);
});

test('every path that could leave its folder or reach git is refused, and named', () => {
  const bad = {
    '../outside': 'shop/a', '/abs/place': 'shop/a', 'a//b': 'shop/a', './a': 'shop/a', 'a/./b': 'shop/a', '': 'shop/a',
    '.git/config': 'shop/a', 'code/x/.GIT/hooks/pre-commit': 'shop/a', 'project.json': 'shop/a', 'PROJECT.JSON': 'shop/a',
    'no-ai/x': 'shop/a', 'a\\b': 'shop/a', 'C:/x': 'shop/a', 'é/x': 'shop/a', 'a b': 'shop/a',
    p1: '../x', p2: '/etc/passwd', p3: 'a//b', p4: '.git/config', p5: '', p6: 'x/..', p7: 7,
  };
  const v = validateManifest({ name: 'shop', repos: [], credentials: bad });
  assert.equal(v.ok, true, 'the file is still read');
  assert.deepEqual(v.manifest.credentials, {}, 'nothing refused is kept');
  assert.equal(v.manifest.credentialsRefused.length, Object.keys(bad).length);
  for (const r of v.manifest.credentialsRefused) assert.match(r.why, /^its (place|target) (is|has) /, JSON.stringify(r));
  assert.ok(v.warnings.every((w) => w.startsWith('credentials: ')));
});

test('a place that is another link\'s place, or inside it, is refused (any letter case)', () => {
  const c = checkCredLinks({ 'code/x/.env': 'a/one', 'code/X/.ENV': 'a/two', 'code/x/.env/inner': 'a/three', 'cred': 'a/dir', 'cred/sub': 'a/four' });
  assert.deepEqual(Object.keys(c.links), ['code/x/.env', 'cred']);
  assert.equal(c.refused.length, 3);
});

test('not an object: refused as a whole, the project still read', () => {
  for (const v of [[], 'x', 3, null]) {
    const r = validateManifest({ name: 'shop', repos: [], credentials: v });
    assert.equal(r.ok, true);
    assert.deepEqual(r.manifest.credentials, {});
    assert.match(r.warnings[0], /must be an object/);
  }
});

test(`more than ${CRED_LINKS_MAX} links: the rest is refused in one line`, () => {
  const many = Object.fromEntries(Array.from({ length: CRED_LINKS_MAX + 5 }, (_, i) => [`code/x/f${i}`, `x/f${i}`]));
  const c = checkCredLinks(many);
  assert.equal(Object.keys(c.links).length, CRED_LINKS_MAX);
  assert.equal(c.refused.length, 1);
  assert.match(c.refused[0].why, /^5 more links than the 200 one project may have: left out$/);
  // 20000 entries: still one refusal and one warning.
  const huge = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`code/x/f${i}`, `x/f${i}`]));
  const v = validateManifest({ name: 'shop', repos: [], credentials: huge });
  assert.equal(v.manifest.credentialsRefused.length, 1);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /19800 more links/);
  // As workspace link, status and get print it: one line for the project, no arrow between two empty paths.
  assert.equal(linkLine({ ...v.manifest.credentialsRefused[0], state: 'refused' }, 'shop'), 'shop: credentials: refused: 19800 more links than the 200 one project may have: left out');
});

test('writeManifest keeps the credentials key as the file has it', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-credkey-')));
  try {
    const creds = { 'code/shop/.env.local': 'shop/shop.env.local' };
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: 'shop', repos: [], memories: {}, credentials: creds }, null, 2));
    const v = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')));
    writeManifest(root, { ...v.manifest, repos: [{ dir: 'code/shop', url: 'https://github.com/example/shop.git' }] }, { root, dir: root, projects: root });
    const back = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
    assert.deepEqual(back.credentials, creds);
    assert.equal(back.credentialsRefused, undefined, 'what the reader adds is never written');
    assert.equal(back.repos.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an older reader (that does not know the key) keeps it as an unknown key', async () => {
  // The released reader's rule: a key it does not know is kept and reported, never a refusal. Its validateManifest
  // is this one without "credentials" among the known keys: the file stays readable and the key stays in the file.
  const src = fs.readFileSync(new URL('../../src/pcsetup/workspace.mjs', import.meta.url), 'utf8');
  assert.match(src, /const keep = \(k\) => !\['__proto__', 'constructor', 'prototype'\]\.includes\(k\);/, 'unknown keys are kept');
  const v = validateManifest({ name: 'shop', repos: [], credentials: { a: 'b' }, later: { x: 1 } });
  assert.equal(v.ok, true);
  assert.deepEqual(v.unknown, ['later']);
});
