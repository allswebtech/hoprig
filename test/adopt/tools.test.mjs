// What comes along with a project: the coding tool's conversations under the new folder's key and its memory into
// the project's own memory folder (the old ones stay); another tool's skill as a pointer, its rules file and hook named
// for the owner (never run, never dropped); the old path where it bites in the copy (a credential helper in
// .git/config); and the count of secret-shaped values, never a value. Also hoprig sessions move on its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { tempHome, writeTree } from '../workspace/helpers.mjs';
import { git, madeUpComputer, traps } from './fixture.mjs';
import { makePlan, writePlan } from '../../src/adopt/plan.mjs';
import { applyPlan } from '../../src/adopt/apply.mjs';
import { sessionsMain } from '../../src/adopt/cli.mjs';
import { makeUi } from '../../src/setup/ui.mjs';
import { projectSlug, sessionsIn } from '../../src/sessions.mjs';
import { ODD_NAMES_SKIP, oddNamesWork } from '../oddnames.mjs';

let t, m, projects, ws, trap, r;
const ID = '11111111-2222-4333-8444-555555555555';
// Set up before the first test by a top-level await, not an async root before(): below Node 22.2 such a hook is not
// awaited by the tests (nodejs/node#52791), so they ran before it ended.
await (async () => {
  t = tempHome('adopt-tools');
  ws = path.join(t.home, 'Workspace');
  projects = path.join(ws, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  m = madeUpComputer(t);
  trap = traps(t.root);
  // A secret-shaped value in a tracked file of tools (made up), and a hook script that would leave a mark if run.
  writeTree(m.dirs.tools, { 'config.js': 'export const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";\n', '.kiro/hooks/run.sh': `#!/bin/sh\ntouch ${t.root}/HOOK-RAN\n` });
  fs.chmodSync(path.join(m.dirs.tools, '.kiro/hooks/run.sh'), 0o755);
  git(m.dirs.tools, 'add', '-A');
  git(m.dirs.tools, 'commit', '-qm', 'config');
  writePlan(await makePlan(m.dirs.tools, { projects, home: t.home, claude: t.claude }));
  r = await applyPlan('tools', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
})();
after(() => t.cleanup());

test('the coding tool\'s conversations are copied under the new folder\'s key and read from there; the old ones stay', () => {
  const copy = path.join(projects, 'tools', 'code', 'tools');
  assert.deepEqual(sessionsIn(copy).map((s) => s.id), [ID]);
  assert.deepEqual(sessionsIn(m.dirs.tools).map((s) => s.id), [ID], 'the old conversation is still there');
  assert.equal(fs.readFileSync(sessionsIn(copy)[0].file, 'utf8'), fs.readFileSync(sessionsIn(m.dirs.tools)[0].file, 'utf8'));
});

test('its memory goes into the project\'s own memory folder, and the old memory stays', () => {
  assert.equal(fs.readFileSync(path.join(projects, 'tools', 'ai_brain', 'claude-memory', 'MEMORY.md'), 'utf8'), '- the series is weekly\n');
  assert.ok(fs.existsSync(path.join(t.claude, 'projects', projectSlug(m.dirs.tools), 'memory', 'MEMORY.md')));
});

test('another tool\'s skill becomes a pointer; its rules file and hook are named for the owner, never run or dropped', () => {
  const ptr = fs.readFileSync(path.join(projects, 'tools', '.claude', 'skills', 'series', 'SKILL.md'), 'utf8');
  assert.match(ptr, /^---\nname: series\ndescription: Makes a made-up series\.\n---/);
  assert.match(ptr, /`code\/tools\/\.kiro\/skills\/series\/`/);
  assert.ok(fs.existsSync(path.join(projects, 'tools', 'code', 'tools', '.kiro', 'skills', 'series', 'SKILL.md')), 'the skill itself came along');
  assert.ok(r.needs.some((n) => n.kind === 'rules' && n.words.startsWith('code/tools/.kiro/steering/about.md')));
  assert.ok(r.needs.some((n) => n.kind === 'hook' && n.words.startsWith('code/tools/.kiro/hooks/guard.json')));
  assert.ok(r.needs.some((n) => n.kind === 'hook' && n.words.startsWith('code/tools/.kiro/hooks/run.sh')));
  assert.ok(fs.existsSync(path.join(projects, 'tools', 'code', 'tools', '.kiro', 'hooks', 'run.sh')), 'the hook is kept');
  assert.ok(!fs.existsSync(path.join(t.root, 'HOOK-RAN')), 'no hook ran');
  assert.ok(fs.existsSync(path.join(m.dirs.tools, '.kiro', 'hooks', 'guard.json')), 'nothing of the other tool was removed');
});

test('the old path where it bites: the copy\'s credential helper in .git/config is said with its file and line', () => {
  const n = r.needs.find((x) => x.kind === 'old path' && x.words.startsWith('code/tools/.git/config:'));
  assert.ok(n, JSON.stringify(r.needs));
  const line = Number(/:(\d+) /.exec(n.words)[1]);
  assert.match(fs.readFileSync(path.join(projects, 'tools', 'code', 'tools', '.git', 'config'), 'utf8').split('\n')[line - 1], /helper/);
});

test('secrets: their count is said, never a value', () => {
  const s = r.lines.find((l) => l.what === 'secrets');
  assert.match(s.words, /^1 secret-shaped value in files a first push would take, tracked or not \(code\/tools: config\.js \(1\)\)/);
  assert.ok(!JSON.stringify(r).includes('ghp_abcdef'));
  assert.deepEqual(trap.trapped(), []);
});

test('secrets: a private folder\'s tracked files are not read, and nothing in it is named', async () => {
  const { secretCount } = await import('../../src/adopt/secrets.mjs');
  const d = path.join(t.root, 'keys-repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  writeTree(d, { 'README.md': '# x\n', 'no-ai/keys-of-alex.txt': 'key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"\n', 'deep/Ignore/more.txt': 'key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"\n' });
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'tracked private');
  const c = await secretCount(d);
  assert.deepEqual(c, { total: 0, files: [] });
  assert.ok(!JSON.stringify(c).includes('keys-of-alex'));
});

test('secrets: an untracked file that is not ignored is searched (a first push would take it); an ignored one is not', async () => {
  const { secretCount } = await import('../../src/adopt/secrets.mjs');
  const d = path.join(t.root, 'untracked-repo');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  writeTree(d, { 'README.md': '# x\n', '.gitignore': '.env\n' });
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'clean');
  writeTree(d, { 'config.json': '{ "token": "ghp_0123456789abcdefghij0123456789abcdef" }\n', '.env': 'TOKEN=ghp_0123456789abcdefghij0123456789abcdef\n' });
  const c = await secretCount(d);
  assert.deepEqual(c, { total: 1, files: ['config.json (1)'] });
});

test('the secret search covers each linked worktree, outside the repository and inside it', async () => {
  const press = path.join(m.place, 'press');
  const web = path.join(press, 'web');
  fs.mkdirSync(web, { recursive: true });
  git(web, 'init', '-q', '-b', 'main');
  writeTree(web, { 'package.json': '{}\n' });
  git(web, 'add', '-A');
  git(web, 'commit', '-qm', 'one');
  git(web, 'worktree', 'add', '-q', '-b', 'feature', path.join(press, 'web-feature'));
  git(web, 'worktree', 'add', '-q', '-b', 'fix', path.join(web, 'wt-fix'));
  writeTree(press, { 'web-feature/config.json': '{ "token": "ghp_0123456789abcdefghij0123456789abcdef" }\n', 'web/wt-fix/keys.txt': 'key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"\n' });
  writePlan(await makePlan(press, { projects, home: t.home, claude: t.claude }));
  const a = await applyPlan('press', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(a.ok, JSON.stringify(a.lines.filter((l) => !l.ok)));
  const line = a.lines.find((l) => l.what === 'secrets').words;
  assert.match(line, /^2 secret-shaped values/, line);
  assert.ok(line.includes('code/web.web-feature: config.json (1)') && line.includes('code/web/wt-fix: keys.txt (1)'), line);
  assert.ok(a.needs.some((n) => n.kind === 'secrets' && n.words.startsWith('2 ')), JSON.stringify(a.needs));
  assert.ok(!JSON.stringify(a).includes('ghp_'), 'no value is shown');
});

test('an untracked folder inside a repository that is another project is named in the plan and in what needs him', async () => {
  const d = path.join(m.place, 'alpha');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  writeTree(d, { 'README.md': '# alpha\n', 'package.json': '{}\n' });
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'one');
  fs.mkdirSync(path.join(d, 'vendored'));
  git(path.join(d, 'vendored'), 'init', '-q', '-b', 'main');
  writeTree(d, { 'vendored/package.json': '{}\n', 'vendored/.env': 'T=1\n', 'loose/notes.txt': 'n\n', 'no-ai/x/package.json': '{}\n' });
  const p = await makePlan(d, { projects, home: t.home, claude: t.claude });
  assert.deepEqual(p.nested, ['vendored'], 'another project inside is named; a plain folder and a private folder are not');
  writePlan(p);
  const a = await applyPlan('alpha', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(a.ok, JSON.stringify(a.lines.filter((l) => !l.ok)));
  assert.ok(a.needs.some((n) => n.kind === 'another project inside' && n.words.startsWith('code/alpha/vendored:')), JSON.stringify(a.needs));
});

test('an untracked folder that holds another project further down is named by the folder that holds it', async () => {
  const d = path.join(m.place, 'gamma');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  writeTree(d, { 'README.md': '# gamma\n' });
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'one');
  fs.mkdirSync(path.join(d, 'third_party', 'vendored'), { recursive: true });
  git(path.join(d, 'third_party', 'vendored'), 'init', '-q', '-b', 'main');
  writeTree(d, { 'third_party/vendored/package.json': '{}\n', 'extras/a/b/go.mod': 'module x\n', 'loose/x/notes.txt': 'n\n', 'hidden/no-ai/package.json': '{}\n', 'deps/node_modules/q/package.json': '{}\n' });
  const p = await makePlan(d, { projects, home: t.home, claude: t.claude });
  assert.deepEqual(p.nested, ['extras/a/b', 'third_party/vendored'], 'a private folder and installed packages are not looked into');
});

test('every project inside an untracked folder is named, also below a folder whose name is not UTF-8', async (tc) => {
  const d = path.join(m.place, 'delta');
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  writeTree(d, { 'README.md': '# delta\n', 'third_party/alpha/package.json': '{}\n', 'third_party/beta/package.json': '{}\n', 'third_party/alpha/inner/go.mod': 'module inner\n' });
  git(d, 'add', 'README.md');
  git(d, 'commit', '-qm', 'one');
  // The folder whose name is not UTF-8 only where the disk takes such a name (APFS refuses it: ODD_NAMES_SKIP).
  const oddOk = oddNamesWork();
  if (oddOk) {
    const odd = Buffer.concat([Buffer.from(`${d}/extern/x-`), Buffer.from([0xff])]);
    fs.mkdirSync(path.join(d, 'extern'));
    fs.mkdirSync(odd);
    fs.mkdirSync(Buffer.concat([odd, Buffer.from('/other')]));
    fs.writeFileSync(Buffer.concat([odd, Buffer.from('/other/package.json')]), '{}\n');
  } else tc.diagnostic(`the case below a folder whose name is not UTF-8 is skipped: ${ODD_NAMES_SKIP}`);
  const p = await makePlan(d, { projects, home: t.home, claude: t.claude });
  assert.deepEqual(p.nested.slice().sort(), [...(oddOk ? ['extern/x-\udcff/other'] : []), 'third_party/alpha', 'third_party/beta'], 'both of third_party, the one below the odd name; alpha/inner is alpha\'s own');
});

test('hoprig sessions move copies with a compare, keeps the old ones, and leaves a different file alone', async () => {
  const from = path.join(t.root, 'old-place');
  const to = path.join(t.root, 'new-place');
  writeTree(path.join(t.claude, 'projects', projectSlug(from)), { [`${ID}.jsonl`]: '{"a":1}\n', 'memory/x.md': 'm\n' });
  const said = [];
  const ui = makeUi({ interactive: false, write: (s) => said.push(s) });
  assert.equal(await sessionsMain(['move', from, to, '--dry-run'], { ui }), 0);
  assert.equal(sessionsIn(to).length, 0, 'a dry run copies nothing');
  assert.equal(await sessionsMain(['move', from, to], { ui }), 0);
  assert.deepEqual(sessionsIn(to).map((s) => s.id), [ID]);
  assert.equal(sessionsIn(from).length, 1);
  assert.ok(!fs.existsSync(path.join(t.claude, 'projects', projectSlug(to), 'memory')), 'the memory is not a conversation');
  fs.writeFileSync(path.join(t.claude, 'projects', projectSlug(from), `${ID}.jsonl`), '{"a":2}\n');
  assert.equal(await sessionsMain(['move', from, to], { ui }), 1);
  assert.equal(fs.readFileSync(sessionsIn(to)[0].file, 'utf8'), '{"a":1}\n', 'a file there already is never overwritten');
  assert.match(said.join(''), /differs: left as it is/);
});
