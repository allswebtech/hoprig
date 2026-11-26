// `hoprig drop` loses nothing that is only here, also where it is easy to miss: a repository inside build output or a
// submodule, files under a build/ folder of test data, a change git hides (skip-worktree, assume-unchanged), refs other
// than branches and tags (git notes), a private folder the project tracks, and a folder that cannot be written.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert, dropOn, dropWorld, getOn, owner, reset } from './dropfix.mjs';

const w = await dropWorld('safe');
test.after(() => w.cleanup());
const [A] = w.computers;
const api = () => path.join(A.shop, 'code', 'shop-api');
const API = 'projects/shop/code/shop-api';
/** The bare repositories of the server that have commit `sha`. */
const serversWith = (sha) => fs.readdirSync(path.join(w.server, 'team')).filter((n) => {
  try {
    w.sh(path.join(w.server, 'team', n), 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
});

test('an ignored test-data/ whose files lie only under a build/ folder in it is on the typed list, never removed without it', async () => {
  await reset(A);
  fs.mkdirSync(path.join(A.shop, 'test-data', 'build'), { recursive: true });
  fs.writeFileSync(path.join(A.shop, 'test-data', 'build', 'customers.sql'), 'insert\n');
  const chk = await dropOn(A, ['shop', '--check']);
  assert.equal(chk.code, 1, chk.text);
  assert.match(chk.text, /projects\/shop\/test-data\/ {2}test data, 7 B, 1 file/);
  const none = await dropOn(A, ['shop']); // no terminal: refused with the list
  assert.equal(none.code, 1, none.text);
  assert.ok(fs.existsSync(path.join(A.shop, 'test-data', 'build', 'customers.sql')));
});

test('a repository inside build output (an ignored dist/, a build/ git does not ignore) is checked: one without a git server refuses', async () => {
  for (const [where, ignored] of [['dist/tool', true], ['build/lib', false]]) {
    await reset(A);
    const n = path.join(api(), ...where.split('/'));
    fs.mkdirSync(n, { recursive: true });
    w.sh(n, 'init', '-q', '-b', 'main');
    const sha = w.commit(n, 'mine.txt', 'only here\n');
    let isIgnored = true;
    try {
      w.sh(api(), 'check-ignore', '-q', where.split('/')[0]);
    } catch {
      isIgnored = false;
    }
    assert.equal(isIgnored, ignored, 'the case is set up as named');
    const r = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
    assert.equal(r.code, 1, `${where} (ignored: ${ignored}): ${r.text}`);
    assert.match(r.text, new RegExp(`${API}/${where}: it has no git server \\(no remote named origin\\)`));
    assert.ok(fs.existsSync(path.join(n, 'mine.txt')), 'nothing removed');
    assert.deepEqual(serversWith(sha), [], 'and nothing of it was sent anywhere as a gitlink');
  }
});

test('a submodule under vendor/ with a commit only here: that commit reaches its own git server before the project goes', async () => {
  await reset(A);
  const u = w.bare('vendlib');
  w.sh(api(), 'submodule', 'add', '-q', u, 'vendor/lib');
  w.sh(api(), 'commit', '-q', '-m', 'add the library');
  w.sh(api(), 'push', '-q');
  const lib = path.join(api(), 'vendor', 'lib');
  const sha = w.commit(lib, 'own.txt', 'only here\n');
  const chk = await dropOn(A, ['shop', '--check', '--json']);
  // A repository's label is written with / on every system (drop.mjs repoLabel).
  assert.ok(chk.json.projects[0].asks.some((a) => a.ask === 'default branch' && a.repo === `${API}/vendor/lib`), JSON.stringify(chk.json.projects[0].asks));
  const r = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
  assert.equal(r.code, 0, r.text);
  assert.ok(serversWith(sha).includes('vendlib.git'), 'the submodule\'s commit is on its git server');
});

test('an edit to a tracked file git is told not to look at (skip-worktree, assume-unchanged) refuses, with the command that shows it again', async () => {
  for (const [flag, file, undo] of [['--skip-worktree', 'README.md', '--no-skip-worktree'], ['--assume-unchanged', '.gitignore', '--no-assume-unchanged']]) {
    await reset(A);
    w.sh(api(), 'update-index', flag, file);
    const clean = await dropOn(A, ['shop', '--check']);
    assert.equal(clean.code, 0, `the flag alone is no edit: ${clean.text}`);
    fs.appendFileSync(path.join(api(), file), 'my local edit\n');
    assert.equal(w.sh(api(), 'status', '--porcelain'), '', 'git status does not show it');
    const r = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
    assert.equal(r.code, 1, `${flag}: ${r.text}`);
    assert.match(r.text, new RegExp(`${API}: ${file.replace('.', '\\.')} has an edit only here that git does not show`));
    assert.match(r.text, new RegExp(`update-index ${undo} -- ${file.replace('.', '\\.')}`));
    assert.match(fs.readFileSync(path.join(api(), file), 'utf8'), /my local edit/, 'the edit stays');
    w.sh(api(), 'update-index', undo, file);
    w.sh(api(), 'checkout', '--', file);
  }
});

test('a private folder the project tracks: clean, it is not listed; changed, it refuses; not in git, it is listed under true words', async () => {
  await reset(A);
  w.commit(A.shop, 'ignore/notes.md', 'v1\n');
  w.sh(A.shop, 'push', '-q');
  const clean = await dropOn(A, ['shop', '--check']);
  assert.equal(clean.code, 0, `tracked and clean: on the server, nothing to confirm: ${clean.text}`);
  fs.writeFileSync(path.join(A.shop, 'ignore', 'notes.md'), 'v2 not committed\n');
  const r = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /projects\/shop: the private folder ignore\/ has changes not committed \(Hoprig does not look into it\): commit and push them yourself/);
  assert.doesNotMatch(r.text, /notes\.md/, 'no name inside it is shown');
  assert.equal(fs.readFileSync(path.join(A.shop, 'ignore', 'notes.md'), 'utf8'), 'v2 not committed\n');
  w.sh(A.shop, 'checkout', '--', 'ignore');
  fs.writeFileSync(path.join(A.shop, 'ignore', 'new.md'), 'untracked beside tracked\n');
  assert.equal((await dropOn(A, ['shop'], { answers: owner('shop', '2') })).code, 1, 'an untracked file beside tracked ones refuses too');
  fs.rmSync(path.join(A.shop, 'ignore', 'new.md'));
  // A private folder that is not in git at all: listed for the typed confirmation, with words that are true.
  fs.mkdirSync(path.join(api(), 'no-ai'));
  fs.writeFileSync(path.join(api(), 'no-ai', 'x.md'), 'mine\n');
  const chk = await dropOn(A, ['shop', '--check']);
  assert.equal(chk.code, 1, chk.text);
  assert.match(chk.text, /Private folders Hoprig does not look into: whatever in them is not committed and pushed is lost with the project:\n\s+projects\/shop\/code\/shop-api\/no-ai\/ {2}private folder, not in git/);
  assert.doesNotMatch(chk.text, /Files git ignores/, 'it is not called ignored');
  const ok = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
  assert.equal(ok.code, 0, ok.text);
});

test('a read-only folder in the project (a tool\'s cache) is deleted with it; get works after', async () => {
  await reset(A);
  const ro = path.join(api(), 'dist', 'cache', 'mod');
  fs.mkdirSync(ro, { recursive: true });
  fs.writeFileSync(path.join(ro, 'f.txt'), 'x\n');
  fs.chmodSync(ro, 0o555);
  fs.chmodSync(path.dirname(ro), 0o555);
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /dropped: it is in the workspace map/);
  assert.deepEqual(fs.readdirSync(A.projects).filter((n) => n.startsWith('.shop')), [], 'nothing left');
  const g = await getOn(A, ['shop']);
  assert.equal(g.code, 0, g.text);
});

test('a leftover that cannot be deleted is named with the command; get does not throw', { skip: process.platform === 'win32' && 'a folder is not made read-only by chmod on Windows' }, async () => {
  await reset(A);
  await assert.rejects(dropOn(A, ['shop'], { onStep: (st) => {
    if (st === 'rename') throw new Error('killed');
  } }));
  const away = fs.readdirSync(A.projects).find((n) => n.startsWith('.shop.dropping-'));
  fs.chmodSync(A.projects, 0o555); // the folder it lies in cannot be written: the delete fails
  let g;
  try {
    g = await getOn(A, ['shop']);
  } finally {
    fs.chmodSync(A.projects, 0o755);
  }
  assert.match(g.text, new RegExp(`${away.replace(/\./g, '\\.')}: left by a drop that was cut off, it passed its check again but it could not be deleted \\(.*\\): delete it yourself\\n\\s+chmod -R u\\+w \\S+ && rm -rf \\S+`));
  assert.ok(fs.existsSync(path.join(A.projects, away)));
  const d = await dropOn(A, ['shop']);
  assert.equal(d.code, 0, d.text);
  assert.deepEqual(fs.readdirSync(A.projects).filter((n) => n.startsWith('.shop')), [], 'the next drop finishes it');
});

test('a repository inside that the map does not name: the drop names it with its address (no credentials), since get does not clone it', async () => {
  await reset(A);
  const u = w.bare('local-tool');
  const n = path.join(A.shop, 'tools', 'local');
  w.clone(u, n);
  w.sh(n, 'remote', 'set-url', 'origin', u.replace('https://', 'https://someone:s3cret@'));
  w.sh(n, 'config', `url.${w.server}/.insteadOf`, 'https://someone:s3cret@git.example.test/'); // still the local server
  fs.appendFileSync(path.join(A.shop, '.git', 'info', 'exclude'), 'tools/\n');
  const chk = await dropOn(A, ['shop', '--check']);
  assert.match(chk.text, /projects\/shop\/tools\/local is a repository of its own on its git server \(https:\/\/git\.example\.test\/team\/local-tool\.git\), and hoprig get does not clone it/);
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /projects\/shop\/tools\/local is a repository of its own/);
  assert.doesNotMatch(r.text + chk.text, /s3cret|someone/, 'no credentials shown');
});

test('a private folder under apps/ or vendor/ that the project tracks is asked about: an edit not committed refuses; one git ignores (a package called "ignore") goes', async () => {
  await reset(A);
  for (const rel of ['apps/web/no-ai/notes.md', 'vendor/kit/ignore/notes.md']) {
    w.commit(api(), rel, 'v1\n');
    w.sh(api(), 'push', '-q');
    fs.writeFileSync(path.join(api(), ...rel.split('/')), 'v2 not committed\n');
    assert.equal(w.sh(api(), 'status', '--porcelain', '--', ':(exclude,glob)**/no-ai/**', ':(exclude,glob)**/ignore/**'), '', 'the status drop reads leaves it out');
    const r = await dropOn(A, ['shop'], { answers: owner('shop', '2') });
    assert.equal(r.code, 1, `${rel}: ${r.text}`);
    assert.match(r.text, new RegExp(`${API}: the private folder ${path.posix.dirname(rel)}/ has changes not committed \\(Hoprig does not look into it\\)`));
    assert.doesNotMatch(r.text, /notes\.md/, 'no name inside it is shown');
    assert.equal(fs.readFileSync(path.join(api(), ...rel.split('/')), 'utf8'), 'v2 not committed\n', 'the edit stays');
    w.sh(api(), 'checkout', '--', rel);
  }
  // An installed package named like a private folder, in a node_modules/ git ignores: made again, no question.
  fs.mkdirSync(path.join(api(), 'node_modules', 'ignore'), { recursive: true });
  fs.writeFileSync(path.join(api(), 'node_modules', 'ignore', 'index.js'), 'module.exports = 1;\n');
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
});

test('a repository whose list of tracked files is over 8 MB is checked: an edit git does not show is still found', async () => {
  const { checkRepo } = await import('../../src/workspace/dropcheck.mjs');
  const { execFileSync } = await import('node:child_process');
  const big = path.join(w.root, 'big');
  const deep = path.join(big, 'a'.repeat(200), 'b'.repeat(200));
  fs.mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 20_000; i++) fs.writeFileSync(path.join(deep, `f${i}`), '');
  fs.writeFileSync(path.join(big, 'local.cfg'), 'committed\n');
  w.sh(big, 'init', '-q', '-b', 'main');
  // Git for Windows passes by a path over 260 characters (these are about 470) without core.longpaths: the many files
  // would not be added at all, and the case would not be the one named.
  if (process.platform === 'win32') w.sh(big, 'config', 'core.longpaths', 'true');
  w.sh(big, 'add', '-A');
  w.sh(big, 'commit', '-q', '-m', 'many files');
  const size = execFileSync('git', ['-C', big, 'ls-files', '-v', '-s', '-z'], { maxBuffer: 64 << 20 }).length;
  assert.ok(size > 8 << 20, `the case is set up as named: ${size} bytes`);
  w.sh(big, 'update-index', '--skip-worktree', 'local.cfg');
  fs.writeFileSync(path.join(big, 'local.cfg'), 'my local edit\n');
  const c = await checkRepo(big, { label: 'big', repos: [big] });
  const what = c.refusals.map((r) => r.what);
  assert.ok(!what.some((x) => /tracked files could not be listed/.test(x)), what.join('\n'));
  assert.ok(what.some((x) => /^local\.cfg has an edit only here that git does not show/.test(x)), what.join('\n'));
  fs.rmSync(big, { recursive: true, force: true });
});
