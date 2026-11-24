// hoprig adopt scan: Look changes nothing, never enters a private folder and never fetches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { tempHome, writeTree } from '../workspace/helpers.mjs';
import { git, madeUpComputer, repo, snapshot, traps } from './fixture.mjs';
import { noSignIn, scanPlaces } from '../../src/adopt/scan.mjs';

let t, place, trap;
before(() => {
  t = tempHome('adopt-scan');
  place = path.join(t.root, 'code');
  const server = path.join(t.root, 'server');
  const shop = repo(path.join(place, 'shop'), path.join(server, 'shop.git'), { 'package.json': '{}\n', 'src/a.js': 'a\n' });
  writeTree(shop, { 'src/a.js': 'changed\n', 'new.txt': 'n\n', 'node_modules/x/index.js': 'x'.repeat(5000) });
  git(shop, 'branch', 'feature');
  writeTree(path.join(place, 'shop'), { 'no-ai/secret-plan.txt': 'made-up private words\n' });
  // A tracked file whose time moved but not its content: a plain `git status` would rewrite the index for it.
  const blog = repo(path.join(place, 'blog'), null, { 'go.mod': 'module blog\n' });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(blog, 'go.mod'), later, later);
  writeTree(place, { 'notes/todo.txt': 'not a project\n', 'Ignore/private-name.txt': 'p\n' });
  trap = traps(t.root);
});
after(() => t.cleanup());

test('scan changes nothing in the scanned place: every path, size, mode, mtime and hash, the index and refs equal', async () => {
  const beforeSnap = snapshot(place);
  const r = await scanPlaces([place]);
  assert.equal(r.projects.length, 2);
  assert.deepEqual(snapshot(place), beforeSnap);
  assert.deepEqual(trap.trapped(), [], 'no trapped program ran');
  assert.ok(!trap.calls().some((l) => /\bfetch\b/.test(l)), 'a scan never fetches');
});

test('scan states the counts of each repository, without dependency folders and as of the last fetch', async () => {
  const r = await scanPlaces([place]);
  const shop = r.projects.find((p) => p.name === 'shop');
  const s = shop.repos[0];
  assert.equal(s.branch, 'main');
  assert.equal(s.uncommitted, 2);
  assert.equal(s.otherBranches, 1);
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  const sum = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.name === 'node_modules' || e.name === 'no-ai' ? 0 : e.isDirectory() ? sum(path.join(d, e.name)) : fs.lstatSync(path.join(d, e.name)).size), 0);
  assert.equal(s.bytes, sum(shop.dir), 'the size is every file but those in node_modules and the private folder');
  assert.equal(s.remote, path.join(t.root, 'server', 'shop.git'));
  assert.equal(shop.privates, 1);
  assert.ok(!r.projects.some((p) => p.name === 'notes'), 'a folder without a sign is not a project');
});

test('a private folder is never entered and nothing in it is named', async () => {
  const r = await scanPlaces([place]);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('secret-plan'), 'no name from inside no-ai');
  assert.ok(!text.includes('private-name'), 'no name from inside a private folder of another case');
  assert.ok(!text.includes('no-ai') && !/"Ignore"/.test(text), 'the private folder itself is counted, not named');
  assert.equal(r.privates, 1, 'the place\'s own private folder is counted');
});

test('a file that differs in line endings only is counted apart from the real changes, and nothing is written', async () => {
  const u = tempHome('adopt-scan-eol');
  try {
    const p = path.join(u.root, 'code');
    const r = repo(path.join(p, 'eol'), null, { 'crlf.txt': 'a\r\nb\r\n', 'lf.txt': 'a\nb\n', 'real.txt': 'x\n', 'package.json': '{}\n' });
    git(r, 'config', 'core.autocrlf', 'true');
    writeTree(r, { 'crlf.txt': 'a\nb\n', 'lf.txt': 'a\r\nb\r\n', 'real.txt': 'y\n' });
    const before = snapshot(p);
    const f = (await scanPlaces([p])).projects[0].repos[0];
    // What git add -A would stage (seen with git itself): real.txt, and crlf.txt, whose index blob holds CRs that the
    // LF file no longer has. lf.txt is stored as the index has it: line endings only.
    assert.deepEqual([f.uncommitted, f.eolOnly], [2, 1], 'real.txt and crlf.txt really changed; lf.txt differs in line endings only');
    assert.deepEqual(snapshot(p), before, 'the index and the files are as they were');
    const { repoWords } = await import('../../src/adopt/cli.mjs');
    assert.match(repoWords(f), /2 uncommitted changes .*1 file that git shows as changed but that differs in line endings only/);
  } finally {
    u.cleanup();
  }
});

test('line endings only is what git add would store as it is: a turned-around CRLF file and a CRLF file without autocrlf are real changes', async () => {
  const u = tempHome('adopt-scan-eol2');
  try {
    const p = path.join(u.root, 'code');
    // Committed as they were (autocrlf off), then autocrlf on and each file's line endings turned around: git add
    // stores lf.txt as the index has it, but crlf.txt (its index blob holds CR) as a new blob.
    const r = repo(path.join(p, 'eol'), null, { 'crlf.txt': 'a\r\nb\r\n', 'lf.txt': 'a\nb\n', 'package.json': '{}\n' });
    git(r, 'config', 'core.autocrlf', 'true');
    writeTree(r, { 'crlf.txt': 'a\nb\n', 'lf.txt': 'a\r\nb\r\n' });
    // No autocrlf at all: a file committed with LF and now CRLF is stored with its CRs.
    const q = repo(path.join(p, 'plain'), null, { 'a.txt': 'one\ntwo\n', 'package.json': '{}\n' });
    writeTree(q, { 'a.txt': 'one\r\ntwo\r\n' });
    // A text attribute converts without autocrlf; -text never does.
    const w = repo(path.join(p, 'attrs'), null, { '.gitattributes': '*.txt text\n*.dat -text\n', 'b.txt': 'x\ny\n', 'c.dat': 'x\ny\n', 'package.json': '{}\n' });
    writeTree(w, { 'b.txt': 'x\r\ny\r\n', 'c.dat': 'x\r\ny\r\n' });
    const before = snapshot(p);
    const facts = Object.fromEntries((await scanPlaces([p])).projects.map((x) => [x.name, x.repos[0]]));
    assert.deepEqual([facts.eol.uncommitted, facts.eol.eolOnly], [1, 1], 'crlf.txt is a real change, lf.txt line endings only');
    assert.deepEqual([facts.plain.uncommitted, facts.plain.eolOnly], [1, 0], 'without autocrlf a CRLF file is a real change');
    assert.deepEqual([facts.attrs.uncommitted, facts.attrs.eolOnly], [1, 1], 'b.txt (text) line endings only, c.dat (-text) a real change');
    assert.deepEqual(snapshot(p), before, 'nothing was written');
  } finally {
    u.cleanup();
  }
});

test('a file git does not treat as text (a lone CR) is never "line endings only", as git add itself shows', async () => {
  const u = tempHome('adopt-scan-eol3');
  try {
    const p = path.join(u.root, 'code');
    // Committed with a lone CR while autocrlf was off, then autocrlf on and every LF made CRLF: git sees the file as
    // not text (ls-files --eol: -text), converts nothing on add, and stores the new bytes: a real change.
    const r = repo(path.join(p, 'cr'), null, { 'cr.txt': 'a\nb\rc\n', 'ok.txt': 'x\ny\n', 'package.json': '{}\n' });
    git(r, 'config', 'core.autocrlf', 'true');
    writeTree(r, { 'cr.txt': 'a\r\nb\rc\r\n', 'ok.txt': 'x\r\ny\r\n' });
    const before = snapshot(p);
    const facts = (await scanPlaces([p])).projects.find((x) => x.name === 'cr').repos[0];
    assert.deepEqual(snapshot(p), before, 'nothing was written');
    // What git add would really record, asked of a copy (never of the original).
    const copy = path.join(u.root, 'copy');
    fs.cpSync(r, copy, { recursive: true });
    git(copy, 'add', '-A');
    const staged = git(copy, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
    assert.deepEqual(staged, ['cr.txt'], 'git itself stores cr.txt anew and ok.txt as it was');
    assert.deepEqual([facts.uncommitted, facts.eolOnly], [staged.length, 1], 'cr.txt is a real change, ok.txt line endings only');
  } finally {
    u.cleanup();
  }
});

test('a parent in the layout that is a repository: its own .git is no neighbour, its code/ repository is found', async () => {
  const u = tempHome('adopt-scan-layout');
  try {
    const p = path.join(u.root, 'code');
    const cafe = path.join(p, 'cafe');
    writeTree(cafe, { 'AGENTS.md': '# Cafe\n', 'project.json': '{ "name": "cafe", "repos": [] }\n', 'code/.gitignore': '*\n!.gitignore\n', 'notes.md': 'n\n' });
    git(cafe, 'init', '-q', '-b', 'main');
    git(cafe, 'add', '-A');
    git(cafe, 'commit', '-qm', 'parent');
    repo(path.join(cafe, 'code', 'cafe'), null, { 'index.html': 'hi\n' });
    const found = (await scanPlaces([p])).projects.find((x) => x.name === 'cafe');
    assert.equal(found.layout, true);
    assert.deepEqual(found.repos.map((r) => path.relative(cafe, r.dir)), [path.join('code', 'cafe')]);
    assert.ok(!found.neighbours.includes('.git'), JSON.stringify(found.neighbours));
  } finally {
    u.cleanup();
  }
});

test('a remote is shown without its sign-in part', () => {
  assert.equal(noSignIn('https://alex:tok123@git.example.com/shop.git'), 'https://git.example.com/shop.git');
  assert.equal(noSignIn('ssh://git@git.example.com/shop.git'), 'ssh://git.example.com/shop.git');
  assert.equal(noSignIn('/srv/shop.git'), '/srv/shop.git');
});

test('a linked worktree is counted under its repository, and a project that is its repository has no neighbours', async () => {
  const u = tempHome('adopt-scan-wt');
  try {
    const m = madeUpComputer(u);
    const r = await scanPlaces([m.place]);
    const blog = r.projects.find((p) => p.name === 'blog');
    assert.deepEqual(blog.repos.map((x) => path.basename(x.dir)).sort(), ['api', 'web']);
    assert.equal(blog.repos.find((x) => x.dir.endsWith('web')).worktrees, 1);
    assert.deepEqual(blog.neighbours, ['backups', 'deploy.sh', 'plan.md']);
    assert.deepEqual(r.projects.find((p) => p.name === 'notes').neighbours, []);
  } finally {
    u.cleanup();
  }
});
