// Find in files: each of the three engines (ripgrep, git grep, the plain walk) finds the same things and skips the
// same things (git's folder, packages, private folders, binary files), the include and exclude patterns, a bad
// regular expression, the limits and the time limit. Also once over the route of a sandboxed dashboard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { sealedPath } from '../seal.mjs';

const box = sandbox('editor-search');
test.after(() => box.cleanup());

const { FILES_MAX, LIMITS, listFiles, runLines, search } = await import('../../src/editor/search.mjs');
const { globRe } = await import('../../src/editor/walk.mjs');
const { which } = await import('../../src/setup/system.mjs');

const projects = path.join(box.root, 'projects');
const repo = path.join(projects, 'repo');
const plain = path.join(projects, 'plain');
const roots = [fs.realpathSync(box.root)];
const files = {
  'src/app.js': 'const Needle = 1;\n// needle in a comment\n',
  'src/deep/ü file.md': 'Une aiguille: needle\n',
  'docs/readme.md': 'no match here\nneedles and pins\n',
  'node_modules/pkg/index.js': 'needle in a package\n',
  'no-ai/private.md': 'needle in a private folder\n',
  'sub/no-ai/private.md': 'needle deeper in a private folder\n',
  '.hidden/conf.txt': 'needle in a dot folder\n',
};
for (const dir of [repo, plain]) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]));
}
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['add', 'src', 'docs'], { cwd: repo }); // tracked and untracked files both count

// A PATH with git and without ripgrep (on most systems both live in the same folder).
const bin = path.join(box.root, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(which('git'), path.join(bin, 'git'));
// Windows starts no link named git without .exe: there the PATH is git's own folder (Git\cmd holds no ripgrep), and
// the one PATH key (Windows names it Path) is this one.
const noRg = process.platform === 'win32'
  ? { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')), PATH: sealedPath([path.dirname(which('git'))]) }
  : { ...process.env, PATH: bin };
const engines = [...(which('rg') ? [['rg', repo]] : []), ['git', repo], ['walk', plain]];
const found = (r) => r.matches.map((m) => `${m.path}:${m.line}:${m.col}`).sort();

for (const [engine, dir] of engines) {
  test(`${engine}: finds case-insensitively, skips packages, private folders, git's folder and binary files`, async () => {
    const r = await search(dir, { q: 'needle' }, roots, { engine });
    assert.equal(r.engine, engine);
    assert.deepEqual(found(r), ['.hidden/conf.txt:1:1', 'docs/readme.md:2:1', 'src/app.js:1:7', 'src/app.js:2:4', 'src/deep/ü file.md:1:15']);
    assert.equal(r.matches.find((m) => m.path === 'src/app.js' && m.line === 1).text, 'const Needle = 1;');
  });

  test(`${engine}: case, whole word, regular expressions, include and exclude`, async () => {
    assert.deepEqual(found(await search(dir, { q: 'Needle', caseSensitive: true }, roots, { engine })), ['src/app.js:1:7']);
    assert.deepEqual(found(await search(dir, { q: 'needle', word: true }, roots, { engine })).length, 4, 'not "needles"');
    assert.deepEqual(found(await search(dir, { q: 'need(le|les) and', regex: true }, roots, { engine })), ['docs/readme.md:2:1']);
    assert.deepEqual(found(await search(dir, { q: 'needle', include: '*.md' }, roots, { engine })), ['docs/readme.md:2:1', 'src/deep/ü file.md:1:15']);
    assert.deepEqual(found(await search(dir, { q: 'needle', exclude: 'src/**, .hidden' }, roots, { engine })), ['docs/readme.md:2:1']);
    assert.deepEqual(found(await search(dir, { q: 'need.e' }, roots, { engine })), [], 'a plain search takes the dot literally');
  });
}

test('each engine answers with the version of every file it found something in (Replace All saves over it)', async () => {
  const { versionOf } = await import('../../src/editor/files.mjs');
  for (const [engine, dir] of engines) {
    const r = await search(dir, { q: 'needle' }, roots, { engine });
    const paths = [...new Set(r.matches.map((m) => m.path))].sort();
    assert.deepEqual(Object.keys(r.versions).sort(), paths, engine);
    for (const p of paths) assert.equal(r.versions[p], versionOf(fs.readFileSync(path.join(dir, p))), `${engine}: ${p}`);
  }
});

test('the versions are read without holding the server: no matched file is read whole on the main thread', async () => {
  const many = path.join(plain, 'many-files');
  fs.mkdirSync(many);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), `${'x'.repeat(4096)}\nneedle\n`);
  // A whole file read and hashed in one go held the server (finding: 300 files of 1 MB, 500 ms); the small checks of
  // a hit's folder (paths.mjs showable) stay as they were.
  const sync = [];
  const keep = { readFileSync: fs.readFileSync };
  fs.readFileSync = (f, ...a) => (String(f).includes('many-files') && sync.push(String(f)), keep.readFileSync(f, ...a));
  try {
    // ripgrep runs as its own program and the walk in a worker: only the versions are read on the main thread.
    for (const engine of [...(which('rg') ? ['rg'] : []), 'walk']) {
      const r = await search(plain, { q: 'needle', include: 'many-files/**' }, roots, { engine });
      assert.equal(Object.keys(r.versions).length, 20, engine);
    }
    assert.deepEqual(sync, []);
  } finally {
    Object.assign(fs, keep);
    fs.rmSync(many, { recursive: true, force: true });
  }
});

test('a line longer than its excerpt says how many matches it has: Replace All writes them all', async () => {
  const text = `price ${'x'.repeat(600)} price end, price\n`;
  for (const [engine, dir] of engines) fs.writeFileSync(path.join(dir, 'long.txt'), text);
  try {
    for (const [engine, dir] of engines) {
      const r = await search(dir, { q: 'price', include: 'long.txt' }, roots, { engine });
      assert.equal(r.matches.length, 1, engine);
      assert.ok(r.matches[0].text.length <= LIMITS.text, engine);
      assert.equal(r.matches[0].count, 3, `${engine}: the whole line's matches, not the excerpt's`);
      const short = await search(dir, { q: 'needle', include: 'docs/**' }, roots, { engine });
      assert.equal(short.matches[0].count, undefined, `${engine}: a whole line needs no count`);
    }
  } finally {
    for (const [, dir] of engines) fs.rmSync(path.join(dir, 'long.txt'), { force: true });
  }
});

test('the walk: Match Whole Word finds a word with a non-ASCII letter, as ripgrep and git grep do', async () => {
  fs.writeFileSync(path.join(plain, 'cafe.txt'), 'café au lait, cafés\n');
  try {
    assert.deepEqual(found(await search(plain, { q: 'café', word: true }, roots, { engine: 'walk' })), ['cafe.txt:1:1']);
  } finally {
    fs.rmSync(path.join(plain, 'cafe.txt'), { force: true });
  }
});

test('Match Whole Word: a word that goes on with a combining mark is another word, in the walk as in ripgrep', async () => {
  fs.writeFileSync(path.join(plain, 'hindi.txt'), 'कम है\nकमी है\n');
  fs.writeFileSync(path.join(plain, 'nfd.txt'), 'cafe au lait\ncafe\u0301 noir\n');
  try {
    for (const engine of ['walk', ...(which('rg') ? ['rg'] : [])]) {
      assert.deepEqual(found(await search(plain, { q: 'कम', word: true }, roots, { engine })), ['hindi.txt:1:1'], engine);
      assert.deepEqual(found(await search(plain, { q: 'cafe', word: true }, roots, { engine })), ['nfd.txt:1:1'], engine);
    }
  } finally {
    for (const f of ['hindi.txt', 'nfd.txt']) fs.rmSync(path.join(plain, f), { force: true });
  }
});

test('Match Whole Word is ripgrep\'s word in every engine, and the page replaces exactly the lines it lists', async () => {
  const page = await import('../../web/editor/search.js');
  const cases = [
    ['fa.txt', 'می گویم\nمی‌خواهم\n', 'می', ['fa.txt:1:1']], // a Persian word joined by U+200C is one word
    ['hi.txt', 'क्‍ष है\nक् है\n', 'क्', ['hi.txt:2:1']], // a Hindi word with a joiner (U+200D)
    ['sup.txt', '10 m² floor\n10 m floor\n', 'm', ['sup.txt:1:4', 'sup.txt:2:4']], // "²" is not a decimal digit
    ['us.txt', 'price_list price\n', 'price', ['us.txt:1:12']], // "_" belongs to the word
    ['ascii.txt', 'needle needles\n', 'needle', ['ascii.txt:1:1']], // plain ASCII as before
  ];
  for (const [, dir] of engines) for (const [f, text] of cases) fs.writeFileSync(path.join(dir, f), text);
  try {
    for (const [engine, dir] of engines) {
      for (const [f, text, q, want] of cases) {
        const o = { q, word: true, regex: false, caseSensitive: false };
        assert.deepEqual(found(await search(dir, { q, word: true, include: f }, roots, { engine })), want, `${engine}: ${f}`);
        // Listed and replaced, or neither: the page's replace changes exactly the listed lines.
        const changed = text.split('\n').map((l, i) => (page.hitsIn(l, o).length ? `${f}:${i + 1}` : null)).filter(Boolean);
        assert.deepEqual(changed, want.map((w) => w.split(':').slice(0, 2).join(':')), `page: ${f}`);
      }
    }
  } finally {
    for (const [, dir] of engines) for (const [f] of cases) fs.rmSync(path.join(dir, f), { force: true });
  }
});

test('Match Whole Word is ripgrep\'s \\w, the same in the page and the server; the server loads nothing of web/', async () => {
  const page = await import('../../web/editor/words.js');
  const server = await import('../../src/editor/words.mjs');
  assert.equal(page.WORD_CHAR, '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]');
  assert.equal(server.WORD_CHAR, page.WORD_CHAR);
  for (const o of [{ q: 'a.b(c', regex: false, word: true }, { q: 'x+', regex: true, word: true }, { q: 'm²', regex: false, word: false }, { q: '$1\\', regex: true, word: false }]) {
    assert.equal(server.patternSource(o), page.patternSource(o), JSON.stringify(o));
  }
  assert.equal(server.patternSource.toString(), page.patternSource.toString());
  assert.equal(server.escapeRe.toString(), page.escapeRe.toString());
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.match(src('../../web/editor/search.js'), /from '\.\/words\.js'/);
  assert.match(src('../../src/editor/search.mjs'), /from '\.\/words\.mjs'/);
  for (const f of ['../../web/editor/search.js', '../../src/editor/search.mjs']) assert.doesNotMatch(src(f), /\\\\p\{/, `${f} has no word class of its own`);
  for (const f of fs.readdirSync(new URL('../../src/editor/', import.meta.url))) assert.doesNotMatch(src(`../../src/editor/${f}`), /from '[./]*web\//, `${f} imports a file of the page`);
});

test('the engine is picked by what is there: git grep in a repository without ripgrep, else the walk', async () => {
  assert.equal(which('rg', noRg), null);
  assert.equal((await search(repo, { q: 'needle' }, roots, { env: noRg })).engine, 'git');
  assert.equal((await search(plain, { q: 'needle' }, roots, { env: noRg })).engine, 'walk');
  if (which('rg')) assert.equal((await search(plain, { q: 'needle' }, roots)).engine, 'rg');
});

test('bad requests: an empty or too long query, a bad expression, a folder outside the roots', async () => {
  await assert.rejects(search(repo, { q: '' }, roots), { status: 400 });
  await assert.rejects(search(repo, { q: 'x'.repeat(501) }, roots), { status: 400 });
  await assert.rejects(search(repo, { q: '(', regex: true }, roots), { status: 400 });
  await assert.rejects(search(repo, { q: 'x', include: '-x' }, roots), { status: 400 });
  await assert.rejects(search('/', { q: 'x' }, roots), { status: 403 });
});

test('the limits: the match cap marks the result truncated; the time limit stops a program and a walk', async () => {
  fs.writeFileSync(path.join(plain, 'many.txt'), 'needle\n'.repeat(40));
  fs.writeFileSync(path.join(repo, 'many.txt'), 'needle\n'.repeat(40));
  const keep = { ...LIMITS };
  try {
    LIMITS.matches = 10;
    for (const [engine, dir] of engines) {
      const r = await search(dir, { q: 'needle' }, roots, { engine });
      assert.deepEqual([r.matches.length, r.truncated], [10, true], engine);
    }
    LIMITS.ms = 300;
    const t0 = Date.now();
    const r = await runLines([process.execPath, '-e', 'setInterval(() => console.log("x"), 5)'], { cwd: plain, env: process.env, onLine: () => true });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 5000, 'killed at the time limit');
    LIMITS.ms = 1;
    assert.equal((await search(plain, { q: 'needle' }, roots, { engine: 'walk' })).timedOut, true);
  } finally {
    Object.assign(LIMITS, keep);
  }
  const long = await search(plain, { q: 'needle' }, roots, { engine: 'walk' });
  assert.ok(long.matches.every((m) => m.text.length <= LIMITS.text));
});

test('the file list for quick open: git\'s files in a repository, a walk elsewhere; the same folders skipped', async () => {
  const want = ['.hidden/conf.txt', 'blob.bin', 'docs/readme.md', 'many.txt', 'src/app.js', 'src/deep/ü file.md'];
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'x');
  fs.writeFileSync(path.join(repo, '-opt.txt'), 'x');
  fs.writeFileSync(path.join(plain, '-opt.txt'), 'x');
  try {
    assert.deepEqual((await listFiles(repo, roots)).files, ['.gitignore', ...want].sort(), 'ignored files and "-" names are left out');
    assert.deepEqual((await listFiles(plain, roots)).files, want);
    await assert.rejects(listFiles('/', roots), { status: 403 });
    assert.ok(FILES_MAX >= 10_000);
  } finally {
    for (const f of ['.gitignore', 'ignored.log', '-opt.txt']) fs.rmSync(path.join(repo, f), { force: true });
    fs.rmSync(path.join(plain, '-opt.txt'), { force: true });
  }
});

test('glob patterns as VS Code reads them', () => {
  assert.ok(globRe('*.md').test('a/b/c.md'));
  assert.ok(!globRe('*.md').test('a/b/c.mdx'));
  assert.ok(globRe('src/**').test('src/a/b.js'));
  assert.ok(!globRe('src/**').test('lib/src/a.js'));
  assert.ok(globRe('dist').test('a/dist/x.js'));
});

test('over the route of a sandboxed dashboard', async () => {
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { passwordHash: await hashPassword('pw'), port: 1, roots: [projects] } });
  const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
  const app = createServer({ backend, watch: false, dashboardFile: false, machines: { claudeVersion: async () => null }, editor: { cleanup: false } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const ask = (o) => fetch(`${base}/api/code/search?${new URLSearchParams(o)}`, { headers: { Cookie: cookie } }).then(async (r) => ({ status: r.status, json: await r.json() }));
    let r = await ask({ root: repo, q: 'NEEDLE', case: '1' });
    assert.deepEqual([r.status, r.json.matches.length], [200, 0]);
    r = await ask({ root: repo, q: 'needle', include: '*.md' });
    assert.deepEqual(r.json.matches.map((m) => m.path).sort(), ['docs/readme.md', 'src/deep/ü file.md']);
    assert.equal((await ask({ root: repo, q: '(', regex: 'true' })).status, 400);
  } finally {
    await app.close();
  }
});

test('a dashboard started with GIT_DIR set still searches and lists the opened folder\'s own repository', async () => {
  const other = path.join(box.root, 'other-repo');
  fs.mkdirSync(other);
  execFileSync('git', ['init', '-q'], { cwd: other });
  const env = { ...process.env, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other };
  assert.ok((await listFiles(repo, roots, { env })).files.includes('src/app.js'));
  const r = await search(repo, { q: 'needle' }, roots, { env, engine: 'git' });
  assert.ok(r.matches.some((m) => m.path === 'src/app.js'));
});
