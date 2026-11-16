// Find in files: each of the three engines (ripgrep, git grep, the plain walk) finds the same things and skips the
// same things (git's folder, packages, private folders, binary files), the include and exclude patterns, a bad
// regular expression, the limits and the time limit. Also once over the route of a sandboxed dashboard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor-search');
test.after(() => box.cleanup());

const { LIMITS, globRe, runLines, search } = await import('../../src/editor/search.mjs');
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
const noRg = { ...process.env, PATH: bin };
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
    LIMITS.ms = -1;
    assert.equal((await search(plain, { q: 'needle' }, roots, { engine: 'walk' })).timedOut, true);
  } finally {
    Object.assign(LIMITS, keep);
  }
  const long = await search(plain, { q: 'needle' }, roots, { engine: 'walk' });
  assert.ok(long.matches.every((m) => m.text.length <= LIMITS.text));
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
