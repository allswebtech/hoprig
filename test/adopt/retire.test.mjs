// hoprig adopt verify and retire, and the command's own words: verify sees one changed byte in a copy; retire is
// refused without a terminal, with another name, and after the original changed; a private folder is never removed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { tempHome, writeTree } from '../workspace/helpers.mjs';
import { allOf, git, madeUpComputer, repo, traps } from './fixture.mjs';
import { makePlan, planFile, readPlan, writePlan } from '../../src/adopt/plan.mjs';
import { applyPlan } from '../../src/adopt/apply.mjs';
import { NO_TERMINAL, retireProject, verifyProject } from '../../src/adopt/retire.mjs';
import { main, usualPlaces } from '../../src/adopt/cli.mjs';
import { makeUi } from '../../src/setup/ui.mjs';
import { oddNamesSkip } from '../oddnames.mjs';

let t, m, projects, ws, trap;
const who = { name: 'Alex', email: 'alex@example.invalid' };
const arrange = async (name) => {
  writePlan(await makePlan(m.dirs[name], { projects, home: t.home, claude: t.claude }));
  const r = await applyPlan(name, { projects, workspace: ws, identity: who });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
};
// Set up before the first test by a top-level await, not an async root before(): below Node 22.2 such a hook is not
// awaited by the tests (nodejs/node#52791), so they ran before it ended.
await (async () => {
  t = tempHome('adopt-retire');
  ws = path.join(t.home, 'Workspace');
  projects = path.join(ws, 'projects');
  process.env.HOPRIG_WORKSPACE_DIR = ws;
  fs.mkdirSync(projects, { recursive: true });
  m = madeUpComputer(t);
  trap = traps(t.root);
  await arrange('blog');
  await arrange('notes');
})();
after(() => t.cleanup());

test('verify proves the copy again, and sees one byte changed in it', async () => {
  assert.ok((await verifyProject('blog', { projects })).every((l) => l.ok));
  const f = path.join(projects, 'blog', 'code', 'api', 'go.mod');
  const was = fs.readFileSync(f);
  fs.writeFileSync(f, 'module apj\n');
  fs.utimesSync(f, fs.statSync(path.join(m.dirs.blog, 'api', 'go.mod')).atime, fs.statSync(path.join(m.dirs.blog, 'api', 'go.mod')).mtime);
  const lines = await verifyProject('blog', { projects });
  assert.ok(lines.some((l) => l.what === 'files' && !l.ok && l.words.includes('go.mod')), JSON.stringify(lines.filter((l) => !l.ok)));
  fs.writeFileSync(f, was);
});

test('retire is refused without a terminal, with another name or another case, and removes nothing', async () => {
  const before = allOf(m.place);
  assert.deepEqual(await retireProject('blog', { projects, ask: null }), { ok: false, refused: true, removed: [], words: NO_TERMINAL });
  for (const typed of ['Blog', 'blo', '', null, ' blog x']) assert.equal((await retireProject('blog', { projects, ask: async () => typed })).ok, false, String(typed));
  const out = [];
  const code = await main(['retire', 'blog'], { ui: makeUi({ interactive: false, write: (s) => out.push(s) }), write: (s) => out.push(s) });
  assert.equal(code, 1);
  assert.match(out.join(''), /needs the project's name typed on a terminal/);
  assert.deepEqual(allOf(m.place), before);
});

test('retire is refused when the original changed since its copy', async () => {
  writeTree(m.dirs.notes, { 'later.txt': 'written after the copy\n' });
  const before = allOf(m.place);
  const r = await retireProject('notes', { projects, ask: async () => 'notes' });
  assert.equal(r.ok, false);
  assert.match(r.words, /changed since it was copied/);
  assert.deepEqual(allOf(m.place), before);
});

test('retire with the typed name removes the originals that were copied; a private folder and what stays remain', async () => {
  writeTree(m.dirs.blog, { 'no-ai/mine.txt': 'made-up\n' });
  writePlan(await makePlan(m.dirs.blog, { projects, home: t.home, claude: t.claude }));
  fs.rmSync(path.join(projects, 'blog'), { recursive: true, force: true });
  await applyPlan('blog', { projects, workspace: ws, identity: who });
  const r = await retireProject('blog', { projects, ask: async () => 'blog' });
  assert.ok(r.ok, r.words);
  assert.ok(!fs.existsSync(path.join(m.dirs.blog, 'web')) && !fs.existsSync(path.join(m.dirs.blog, 'web-feature')) && !fs.existsSync(path.join(m.dirs.blog, 'deploy.sh')));
  assert.equal(fs.readFileSync(path.join(m.dirs.blog, 'no-ai', 'mine.txt'), 'utf8'), 'made-up\n', 'a private folder is never removed');
  assert.ok(fs.existsSync(path.join(projects, 'blog', 'code', 'web', '.git')));
  assert.deepEqual(trap.trapped(), []);
});

test('retire keeps a private folder inside a repository that was copied whole, with a file written in it after apply', async () => {
  // A project folder that is itself the repository, with a private folder in it (git-ignored): the case where the
  // whole repository is one "go" path.
  const diary = repo(path.join(m.place, 'diary'), null, { '.gitignore': 'no-ai/\n', 'README.md': '# diary\n' });
  writeTree(diary, { 'no-ai/day-one.txt': 'made-up\n', 'src/deep/no-ai/inner.txt': 'made-up\n' });
  m.dirs.diary = diary;
  await arrange('diary');
  writeTree(diary, { 'no-ai/after-apply.txt': 'written after the copy\n' });
  const said = [];
  const r = await retireProject('diary', { projects, ask: async () => 'diary', say: (s) => said.push(s) });
  assert.ok(r.ok, r.words);
  assert.equal(fs.readFileSync(path.join(diary, 'no-ai', 'after-apply.txt'), 'utf8'), 'written after the copy\n', 'a file of the private folder that the copy does not have survives');
  assert.equal(fs.readFileSync(path.join(diary, 'no-ai', 'day-one.txt'), 'utf8'), 'made-up\n');
  assert.equal(fs.readFileSync(path.join(diary, 'src', 'deep', 'no-ai', 'inner.txt'), 'utf8'), 'made-up\n', 'a private folder deeper down stays too');
  assert.deepEqual(fs.readdirSync(diary).sort(), ['no-ai', 'src'], 'everything else of the repository went');
  assert.deepEqual(fs.readdirSync(path.join(diary, 'src')), ['deep']);
  assert.ok(said.some((l) => l.startsWith('These stay')), said.join('\n'));
  assert.ok(said.some((l) => l.includes(path.join(diary, 'no-ai')) && /a private folder/.test(l)), 'the private folder is named as staying');
  assert.ok(!said.join('\n').includes('after-apply') && !said.join('\n').includes('inner.txt'), 'nothing in it is named');
  assert.ok(fs.existsSync(path.join(projects, 'diary', 'code', 'diary', '.git')));
});

test('retire finds a private folder below a folder whose name is not UTF-8, and removes an entry whose name is not', { skip: oddNamesSkip() }, async () => {
  const ledger = repo(path.join(m.place, 'ledger'), null, { 'README.md': '# ledger\n' });
  const b = (...parts) => Buffer.concat(parts.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
  const odd = b(ledger, '/notes-', Buffer.from([0xff]));
  fs.mkdirSync(b(odd, '/no-ai'), { recursive: true });
  fs.writeFileSync(b(odd, '/no-ai/diary.txt'), 'made-up\n');
  fs.writeFileSync(b(odd, '/loose.txt'), 'goes\n');
  fs.writeFileSync(b(ledger, '/x', Buffer.from([0xfe]), '.txt'), 'goes too\n');
  m.dirs.ledger = ledger;
  await arrange('ledger');
  fs.writeFileSync(b(odd, '/no-ai/after.txt'), 'written after the copy\n');
  const said = [];
  const r = await retireProject('ledger', { projects, ask: async () => 'ledger', say: (s) => said.push(s) });
  assert.ok(r.ok, r.words);
  assert.equal(fs.readFileSync(b(odd, '/no-ai/after.txt'), 'utf8'), 'written after the copy\n', 'the private folder below the odd name stays, with what was written after apply');
  assert.ok(said.some((l) => l.startsWith('These stay')) && said.some((l) => /all but the private folder/.test(l)), said.join('\n'));
  assert.deepEqual(fs.readdirSync(Buffer.from(ledger), { encoding: 'buffer' }).map((n) => n.toString('latin1')), [odd.subarray(ledger.length + 1).toString('latin1')], 'the entry whose name is not UTF-8 went; only the way to the private folder is left');
  assert.deepEqual(fs.readdirSync(odd), ['no-ai'], 'the odd folder holds only its private folder now');
});

test('retire refuses while a copy still borrows objects from an original\'s store', async () => {
  const pair = path.join(m.place, 'pair');
  repo(path.join(pair, 'api'), null, { 'a.txt': 'a\n' });
  git(pair, 'clone', '-q', '--shared', path.join(pair, 'api'), 'web');
  m.dirs.pair = pair;
  await arrange('pair');
  // As a copy of an older apply had it: its alternates still name the original's store.
  fs.writeFileSync(path.join(projects, 'pair', 'code', 'web', '.git', 'objects', 'info', 'alternates'), `${path.join(pair, 'api', '.git', 'objects')}\n`);
  const before = allOf(pair);
  const r = await retireProject('pair', { projects, ask: async () => 'pair' });
  assert.equal(r.ok, false);
  assert.match(r.words, /borrows objects from/);
  assert.deepEqual(allOf(pair), before, 'nothing was removed');
});

test('retire refuses while another project\'s clone borrows objects from an original, and names --shared clones elsewhere', async () => {
  const lend = path.join(m.place, 'lend');
  repo(path.join(lend, 'api'), null, { 'go.mod': 'module api\n' });
  m.dirs.lend = lend;
  await arrange('lend');
  // Another project of the same place, not arranged: a clone --shared of the original.
  git(m.place, 'clone', '-q', '--shared', path.join(lend, 'api'), path.join('borrow', 'mirror'));
  const before = allOf(lend);
  const said = [];
  const r = await retireProject('lend', { projects, ask: async () => 'lend', say: (s) => said.push(s) });
  assert.equal(r.ok, false);
  assert.ok(r.words.includes(path.join(m.place, 'borrow', 'mirror')) && /git repack -a -d/.test(r.words), r.words);
  assert.deepEqual(allOf(lend), before, 'nothing was removed');
  assert.ok(git(path.join(m.place, 'borrow', 'mirror'), 'log', '--oneline').length > 0, 'the clone still works');
  // Made to stand alone, as the words say: then retire goes on, and says what a clone outside the place needs.
  git(path.join(m.place, 'borrow', 'mirror'), 'repack', '-q', '-a', '-d');
  fs.rmSync(path.join(m.place, 'borrow', 'mirror', '.git', 'objects', 'info', 'alternates'));
  const r2 = await retireProject('lend', { projects, ask: async () => 'lend', say: (s) => said.push(s) });
  assert.ok(r2.ok, r2.words);
  assert.ok(said.some((l) => /--shared/.test(l) && /git repack -a -d/.test(l)), said.join('\n'));
  assert.ok(git(path.join(m.place, 'borrow', 'mirror'), 'log', '--oneline').length > 0);
});

test('an edited plan may not name a folder outside its repositories as a worktree', async () => {
  writePlan(await makePlan(m.dirs.tools, { projects, home: t.home, claude: t.claude }));
  const p = JSON.parse(fs.readFileSync(planFile('tools'), 'utf8'));
  p.repos[0].worktrees = [{ from: path.join(t.home, '.ssh'), to: 'code/keys', inside: false }];
  fs.writeFileSync(planFile('tools'), JSON.stringify(p));
  assert.throws(() => readPlan('tools', { projects }), { code: 'EPLAN' });
});

test('a usual place reached by two names is proposed once: Code and code on a disk that ignores case (macOS)', () => {
  // Two real folders here (Linux tells the case apart); the stat handed in answers for `Code` what the disk answers for
  // `code`, as a case-folding disk does. A link is proposed once as well.
  const home = path.join(t.root, 'casehome');
  writeTree(home, { 'code/a.txt': 'a\n', 'Code/b.txt': 'b\n', 'projects/c.txt': 'c\n' });
  // On a disk that ignores case itself (a Mac's), `code` and `Code` are one folder already and the link's name is
  // taken: the pair cannot be made, and the disk's own answer is the proof.
  const folds = fs.readdirSync(home).filter((n) => n.toLowerCase() === 'code').length === 1;
  if (!folds) fs.symlinkSync('projects', path.join(home, 'Projects'));
  const folding = (p, o) => fs.statSync(p.replace(/Code$/, 'code'), o);
  assert.deepEqual(usualPlaces(home, 'linux', { stat: folding }), [path.join(home, 'code'), path.join(home, 'projects')]);
  assert.deepEqual(usualPlaces(home, 'linux'), folds ? [path.join(home, 'code'), path.join(home, 'projects')] : [path.join(home, 'code'), path.join(home, 'Code'), path.join(home, 'projects')], 'two folders of their own are two places');
});

test('a file system that gives no inode numbers (0) keeps two folders of their own as two places', () => {
  const home = path.join(t.root, 'noinohome');
  writeTree(home, { 'code/a.txt': 'a\n', 'projects/c.txt': 'c\n' });
  const noIno = (p, o) => {
    // By the name as it is written: a disk that ignores case would answer for `Code` too, and with no inode
    // numbers nothing could tell that it is the same folder.
    if (!fs.readdirSync(path.dirname(p)).includes(path.basename(p))) throw Object.assign(new Error('no such folder'), { code: 'ENOENT' });
    const s = fs.statSync(p, o);
    return { dev: 0n, ino: 0n, isDirectory: () => s.isDirectory() };
  };
  assert.deepEqual(usualPlaces(home, 'linux', { stat: noIno }), [path.join(home, 'code'), path.join(home, 'projects')]);
});

test('scan without a folder named looks at nothing: it only proposes the usual places', async () => {
  writeTree(t.home, { 'code/shop/package.json': '{}\n' });
  const out = [];
  assert.equal(await main(['scan', '--json'], { write: (s) => out.push(s) }), 0);
  const j = JSON.parse(out.join(''));
  assert.deepEqual(j.projects, []);
  assert.deepEqual(j.proposed, [path.join(t.home, 'code')]);
  assert.ok(!out.join('').includes('package.json'));
});
