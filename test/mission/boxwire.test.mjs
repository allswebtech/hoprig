// A task's tests in the REAL box, through the real gate (src/mission/gate.mjs, boxed.mjs): a throw-away project in this
// test's own temporary folder, with one dependency the test writes itself (a tiny made-up package, no install), its
// main checkout's node_modules, and a real git worktree of a task's branch. The folders the box gets are the product's
// own; the dependencies reach the tests through a link the product makes for the run and takes away after it. Every
// "secret" is a made-up file here; every listener is one this test opened. A computer without a box skips these.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boxwire-')));
process.env.HOPRIG_STATE_DIR = path.join(root, 'state'); // the product's records of its links: this test's own
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const { gate } = await import('../../src/mission/gate.mjs');
const { box } = await import('../../src/mission/seam.mjs');
const { DEPS, hidden, needDirs, recordedLinks } = await import('../../src/mission/boxed.mjs');
const { boxCheck } = await import('../../src/box/box.mjs');
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

const TEST = [process.execPath, 'check.cjs'];
let n = 0;

/**
 * A project `top` (main checkout, with node_modules/tiny), and a worktree of the branch work/<name> that adds
 * check.cjs (`script`). `ignore`: the project's .gitignore names node_modules (most projects do).
 * → { top, tree, base, branch, deps }
 */
function project(name, script, { ignore = true } = {}) {
  n += 1;
  const top = path.join(root, `${name}-${n}`);
  fs.mkdirSync(top);
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 'a@example.com');
  git(top, 'config', 'user.name', 'a');
  fs.writeFileSync(path.join(top, 'package.json'), '{ "name": "shop", "private": true }\n');
  if (ignore) fs.writeFileSync(path.join(top, '.gitignore'), 'node_modules\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'base');
  const base = git(top, 'rev-parse', 'HEAD').trim();
  const deps = path.join(top, DEPS);
  fs.mkdirSync(path.join(deps, 'tiny'), { recursive: true });
  fs.writeFileSync(path.join(deps, 'tiny', 'package.json'), '{ "name": "tiny", "main": "index.js" }\n');
  fs.writeFileSync(path.join(deps, 'tiny', 'index.js'), 'module.exports = (a, b) => a + b;\n');
  const branch = `work/${name}-${n}`;
  const tree = path.join(root, 'trees', `${name}-${n}`);
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  git(top, 'worktree', 'add', '-q', '-b', branch, tree, 'HEAD');
  fs.writeFileSync(path.join(tree, 'check.cjs'), script);
  git(tree, 'add', '-A');
  git(tree, 'commit', '-qm', 'the task');
  return { top, tree, base, branch, deps };
}
const run = (p, extra = {}) => gate({ check: 'tests', top: p.top, tree: p.tree, base: p.base, branch: p.branch, brief: 'Files: check.cjs', test: TEST, box: box(), ...extra });
const said = (g) => g.words.join('; ');
/** The tests ran in the box and passed: not "not run", which would pass a check of ok alone. */
const ranAndPassed = (g, what) => {
  assert.equal(g.testsNotRun, undefined, `${what}: the tests must have run: ${said(g)}`);
  assert.equal(g.ok, true, `${what}: ${said(g)}`);
  assert.match(said(g), /the tests passed/, what);
};
const noLink = (p) => {
  assert.equal(fs.existsSync(path.join(p.tree, DEPS)) || isLink(path.join(p.tree, DEPS)), false, 'the link is taken away after the run');
  assert.equal(recordedLinks()[p.tree], undefined, 'and its record with it');
};
const isLink = (f) => {
  try {
    return fs.lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
};

const USES_TINY = "const add = require('tiny');\nif (add(2, 3) !== 5) process.exit(4);\nconsole.log('tiny works');\n";

test('in the real box: the tests of a task pass, with the project\'s own dependency; the link is gone after', { skip, timeout: 60_000 }, async () => {
  const p = project('pass', USES_TINY);
  const g = await run(p);
  assert.equal(g.ok, true, said(g));
  assert.equal(g.testsNotRun, undefined, said(g));
  assert.match(said(g), /the tests passed/);
  noLink(p);
  assert.deepEqual(fs.readdirSync(p.deps), ['tiny'], 'the main checkout\'s node_modules is as it was');
});

test('in the real box: the same tests are not run when the check says no', { skip, timeout: 60_000 }, async () => {
  const mark = path.join(root, 'ran-when-no');
  const p = project('no', `require('fs').writeFileSync(${JSON.stringify(mark)}, 'ran');\n`);
  const no = { check: async () => ({ ok: false, why: 'the self-test failed' }), run: box().run };
  const g = await run(p, { box: no });
  assert.equal(g.testsNotRun, true, said(g));
  assert.equal(fs.existsSync(mark), false, 'nothing ran');
  assert.equal(isLink(path.join(p.tree, DEPS)), false, 'no link was made for a run that did not happen');
});

test('in the real box: a made-up secret in a made-up home cannot be read: "no such file"', { skip, timeout: 60_000 }, async () => {
  const secret = path.join(root, 'home', 'alex', '.config', 'secret.txt');
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, 'made-up secret');
  const p = project('secret', `try { require('fs').readFileSync(${JSON.stringify(secret)}); console.log('READ'); process.exit(9); } catch (e) { console.log(e.code); process.exit(e.code === 'ENOENT' ? 0 : 8); }\n`);
  ranAndPassed(await run(p), 'the read must end in "no such file"');
});

test('in the real box: a listener this test opened outside cannot be reached', { skip, timeout: 60_000 }, async (t) => {
  let reached = 0;
  const srv = net.createServer((s) => {
    reached += 1;
    s.end('hello');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const p = project('net', `const s = require('net').connect(${port}, '127.0.0.1');\ns.on('connect', () => { console.log('REACHED'); process.exit(9); });\ns.on('error', (e) => { console.log(e.code); process.exit(0); });\n`);
  ranAndPassed(await run(p), 'the connection must be refused');
  assert.equal(reached, 0, 'nothing reached the listener');
});

test('in the real box: a test command that writes outside the worktree writes nothing outside', { skip, timeout: 60_000 }, async () => {
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const p = project('write', `const fs = require('fs');\nfor (const f of [${JSON.stringify(path.join(outside, 'x.txt'))}, ${JSON.stringify(path.join(root, 'top-level.txt'))}, require('path').join(require('os').homedir(), 'y.txt')]) { try { fs.mkdirSync(require('path').dirname(f), { recursive: true }); fs.writeFileSync(f, 'written'); } catch {} }\ntry { fs.writeFileSync('node_modules/tiny/added.js', 'x'); } catch {}\n`);
  ranAndPassed(await run(p), 'the writes outside fail quietly');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside');
  assert.equal(fs.existsSync(path.join(root, 'top-level.txt')), false);
  assert.deepEqual(fs.readdirSync(path.join(p.deps, 'tiny')).sort(), ['index.js', 'package.json'], 'the project\'s dependencies are read only inside');
  noLink(p);
});

// What the session left under the dependencies' name: a link to a made-up private folder, a folder of its own, a file.
// None is followed, replaced or named for the box; nothing outside the worktree and the real dependencies is read or
// written. The test reads and writes through that name and says what it saw.
const THROUGH = "const fs = require('fs');\nlet read = 'none';\ntry { read = fs.readFileSync('node_modules/secret.txt', 'utf8'); } catch (e) { read = e.code; }\ntry { fs.writeFileSync('node_modules/written.txt', 'x'); } catch {}\nconsole.log('read:', read);\nprocess.exit(read === 'made-up private' ? 9 : 0);\n";

test('in the real box: node_modules the session left as a link to a private folder is never followed', { skip, timeout: 60_000 }, async () => {
  const priv = path.join(root, 'private');
  fs.mkdirSync(priv, { recursive: true });
  fs.writeFileSync(path.join(priv, 'secret.txt'), 'made-up private');
  const p = project('own-link', THROUGH);
  fs.symlinkSync(priv, path.join(p.tree, DEPS));
  const g = await run(p);
  ranAndPassed(g, 'the private folder must not be read');
  assert.match(said(g), /had its own node_modules/);
  assert.equal(fs.readlinkSync(path.join(p.tree, DEPS)), priv, 'the session\'s own link is left as it was');
  assert.deepEqual(fs.readdirSync(priv), ['secret.txt'], 'nothing was written in the private folder');
  assert.equal(recordedLinks()[p.tree], undefined, 'no link of the product\'s was recorded');
  assert.deepEqual(fs.readdirSync(path.join(p.deps, 'tiny')).sort(), ['index.js', 'package.json']);
});

test('in the real box: node_modules the session left as a folder or a file is used as it is, never replaced', { skip, timeout: 60_000 }, async () => {
  const folder = project('own-folder', THROUGH);
  fs.mkdirSync(path.join(folder.tree, DEPS));
  const g1 = await run(folder);
  ranAndPassed(g1, 'its own folder');
  assert.match(said(g1), /had its own node_modules/);
  assert.ok(fs.lstatSync(path.join(folder.tree, DEPS)).isDirectory(), 'its folder is still a folder');
  assert.deepEqual(fs.readdirSync(path.join(folder.tree, DEPS)), ['written.txt'], 'what the tests wrote stays inside the worktree');
  const file = project('own-file', THROUGH);
  fs.writeFileSync(path.join(file.tree, DEPS), 'a file\n');
  const g2 = await run(file);
  ranAndPassed(g2, 'its own file');
  assert.match(said(g2), /had its own node_modules/);
  assert.equal(fs.readFileSync(path.join(file.tree, DEPS), 'utf8'), 'a file\n', 'its file is as it was');
  for (const p of [folder, file]) {
    assert.equal(recordedLinks()[p.tree], undefined);
    assert.deepEqual(fs.readdirSync(path.join(p.deps, 'tiny')).sort(), ['index.js', 'package.json'], 'the real dependencies are untouched');
  }
});

test('the dashboard died between making the link and taking it away: the next gate cleans up first, then counts nothing', { skip, timeout: 60_000 }, async () => {
  // No .gitignore: a link left behind would count as an uncommitted file.
  const p = project('died', USES_TINY, { ignore: false });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid; // a process that has ended
  fs.mkdirSync(process.env.HOPRIG_STATE_DIR, { recursive: true });
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-links.json');
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...before, [p.tree]: { target: p.deps, pid: dead, ident: null } }));
  fs.symlinkSync(p.deps, path.join(p.tree, DEPS));
  const g = await run(p);
  ranAndPassed(g, 'the left link is not an uncommitted file of the session\'s');
  assert.doesNotMatch(said(g), /had its own node_modules/);
  noLink(p);
});

test('a link at that name that is not the recorded one is left as it is', { skip, timeout: 60_000 }, async () => {
  const p = project('other-link', USES_TINY);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-links.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...before, [p.tree]: { target: p.deps, pid: dead, ident: null } }));
  fs.symlinkSync(elsewhere, path.join(p.tree, DEPS));
  await run(p);
  assert.equal(fs.readlinkSync(path.join(p.tree, DEPS)), elsewhere, 'a link of another target is never removed');
});

test('the folders the box gets are the product\'s: the worktree to write, the real dependencies to read, never the brief\'s', async () => {
  const p = project('folders', USES_TINY);
  const seen = [];
  const spy = { check: async () => ({ ok: true }), run: async (argv, opts) => {
    seen.push({ opts, link: fs.readlinkSync(path.join(p.tree, DEPS)) });
    return { ok: true, code: 0, out: '', timedOut: false };
  } };
  const g = await run(p, { box: spy, brief: `Files: check.cjs\nRead: /etc\nWrite: ${root}\nnode_modules: ${os.homedir()}` });
  assert.equal(g.ok, true, said(g));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].opts.write, [p.tree], 'write: the worktree alone');
  assert.deepEqual(seen[0].opts.read, [fs.realpathSync(p.deps)], 'read: the main checkout\'s node_modules, by its real path');
  assert.equal(seen[0].opts.cwd, p.tree);
  assert.equal(seen[0].link, fs.realpathSync(p.deps), 'the link the product made points at the real path');
  noLink(p);
});

test('the needs\' folders: only absolute folders outside the worktree, as a session gets them', async () => {
  const tree = path.join(root, 'needs-tree');
  fs.mkdirSync(tree, { recursive: true });
  const other = path.join(root, 'needs-other');
  fs.mkdirSync(other, { recursive: true });
  const extras = async () => ({ dirs: [other, tree, path.join(tree, 'sub'), 'relative', root] });
  const settings = async () => ({ deny: [] });
  assert.deepEqual((await needDirs(root, tree, { extras, settings })).dirs, [other], 'the worktree, a folder inside it or around it, and a relative name are never named');
  assert.deepEqual((await needDirs(root, tree, { extras: async () => { throw new Error('no map'); }, settings })).dirs, []);
});

test('a need folder goes to the box only when it shows nothing the session is denied to read', async () => {
  const tree = path.join(root, 'deny-tree');
  fs.mkdirSync(tree, { recursive: true });
  const outside = path.join(root, 'deny-outside.txt');
  fs.writeFileSync(outside, 'made-up key\n');
  const make = (name, files = {}, links = {}) => {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), c);
    }
    for (const [f, to] of Object.entries(links)) fs.symlinkSync(to, path.join(d, f));
    return d;
  };
  const plain = make('deny-plain', { 'README.md': 'x\n', '.env': 'MADE_UP_KEY=1\n' }); // a credential place that is a plain file
  const dangles = make('deny-link', { 'README.md': 'x\n' }, { '.env': outside }); // a link out of every folder the box gets
  const missing = make('deny-missing', { 'README.md': 'x\n' }); // the rule names nothing that is there
  const pattern = make('deny-pattern', { 'README.md': 'x\n' }); // a rule at any depth: the box cannot tell
  const priv = make('deny-private', { 'a/ai-ignore-dir/note.txt': 'private\n' }); // a private folder deep inside
  const dirs = [plain, dangles, missing, pattern, priv];
  const extras = async () => ({ dirs, refs: ['plain', 'link', 'missing', 'pattern', 'private'] });
  // The rules name a folder as needs.mjs writes them: on Windows in its POSIX form (ruleForm: C:\\a as /c/a).
  const { ruleForm } = await import('../../src/workspace/needswalk.mjs');
  const settings = async ([dir]) => {
    const d = ruleForm(dir);
    return { deny: [`Edit(/${d}/**)`, ...(dir === pattern ? [`Read(/${d}/**/notes.txt)`] : [`Read(/${d}/.env)`, `Read(/${d}/.env/**)`])] };
  };
  const r = await needDirs(root, tree, { extras, settings });
  assert.deepEqual(r.dirs, [dangles, missing], 'only the folders in which the box shows nothing denied');
  assert.deepEqual(r.left, ['plain: its session may not read some of its files', 'pattern: its session may not read some of its files', 'private: it holds a private folder']);
  // The real rules of a session (needs.mjs extraSettings), on the same folder: a plain file under a credential place.
  const { extraSettings } = await import('../../src/workspace/needs.mjs');
  const real = await needDirs(root, tree, { extras: async () => ({ dirs: [missing], refs: ['missing'] }), settings: extraSettings });
  assert.deepEqual(real.dirs, [missing], 'a folder whose real rules name nothing there goes to the box');
});

test('on Windows the rules name a need folder in their POSIX form (C:\\w\\need as /c/w/need), and the box reads them so', async () => {
  const { PRIVATE_DIRS } = await import('../../src/pcsetup/projects.mjs');
  const d = 'C:\\w\\need';
  const rd = '/c/w/need'; // as needs.mjs extraSettings writes it on Windows
  const own = PRIVATE_DIRS.flatMap((p) => [`Read(/${rd}/${p})`, `Read(/${rd}/${p}/**)`, `Read(/${rd}/**/${p})`, `Read(/${rd}/**/${p}/**)`]);
  assert.equal(hidden(d, ['Edit(/' + rd + '/**)', ...own], [d], 'win32'), '', 'its own private-folder rules alone hide nothing');
  assert.equal(hidden(d, [...own, `Read(/${rd}/.env)`, `Read(/${rd}/.env/**)`], [d], 'win32'), '', 'a credential place that is not there hides nothing');
  assert.equal(hidden(d, [...own, `Read(/${rd}/**/notes.txt)`], [d], 'win32'), 'its session may not read some of its files', 'a pattern still does');
  assert.equal(hidden(d, ['Read(//server/share/x)'], [d], 'win32'), 'its session may not read some of its files', 'a rule with no drive cannot be placed: it hides');
});

test('in the real box: the words say "in the box, no network"; a test that needs the network fails and the words say why', { skip, timeout: 60_000 }, async () => {
  const p = project('words', USES_TINY);
  const g = await run(p, { test: [process.execPath, 'check.cjs'] });
  assert.ok(g.words.includes('the tests passed (node check.cjs, in the box, no network)'), said(g));
  assert.equal(g.boxed, true);
  assert.match(g.printed, /tiny works/, 'what the tests printed is kept');
  const netp = project('needs-net', "require('dns').lookup('registry.example.com', (e) => { console.log(e ? `no network: ${e.code}` : 'resolved'); process.exit(e ? 1 : 0); });\n");
  const red = await run(netp);
  assert.equal(red.ok, false, said(red));
  assert.equal(red.boxed, true, 'they ran, in the box');
  assert.match(said(red), /they ran in the box, with no network/);
  assert.match(red.printed, /no network: /);
});

test('in the real box: a timeout ends the tests, and the words say how long they were given', { skip, timeout: 60_000 }, async () => {
  const p = project('slow', 'setTimeout(() => {}, 60_000);\n');
  const g = await run(p, { timeoutMs: 1500 });
  assert.equal(g.ok, false, said(g));
  assert.match(said(g), /did not end in time \(node check\.cjs, in the box, stopped after 2 seconds\)/);
  noLink(p);
});

test('in the real box: a test command that cannot start is "not run", with the box\'s why, never a failure of the work', { skip, timeout: 60_000 }, async () => {
  const p = project('nostart', USES_TINY);
  const g = await run(p, { test: [path.join(root, 'no-such-program'), 'test'] });
  assert.equal(g.ok, true, said(g));
  assert.equal(g.testsNotRun, true, said(g));
  assert.equal(g.boxed, undefined);
  assert.match(said(g), /tests not run: yours to check \(the box did not start: the command could not be started/);
  assert.ok(!said(g).includes(root), `no path of this computer: ${said(g)}`);
  noLink(p);
});

test('a link left by a dashboard that died does not keep the worktree at Accept, also under a "node_modules/" ignore line', async () => {
  // "node_modules/" (with the slash) ignores a folder of that name, never a link: git counts the link as untracked.
  const { treeFor, releaseTree, keptTree } = await import('../../src/work/alonegit.mjs');
  n += 1;
  const top = path.join(root, `slash-${n}`);
  fs.mkdirSync(top);
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 'a@example.com');
  git(top, 'config', 'user.name', 'a');
  fs.writeFileSync(path.join(top, '.gitignore'), 'node_modules/\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'base');
  const deps = path.join(top, DEPS);
  fs.mkdirSync(path.join(deps, 'tiny'), { recursive: true });
  const { dir: tree } = await treeFor(top, 'work/slash');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'mission-links.json');
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...before, [tree]: { target: deps, pid: dead, ident: null } }));
  fs.symlinkSync(deps, path.join(tree, DEPS));
  assert.equal(git(tree, 'status', '--porcelain', '--untracked-files=all'), '?? node_modules\n', 'the link is untracked for git, as the slash line leaves it');
  const r = await releaseTree(top, 'work/slash');
  assert.deepEqual(r, { removed: true }, 'the product\'s own left link does not keep the worktree');
  assert.equal(keptTree(top, 'work/slash'), null);
  assert.equal(recordedLinks()[tree], undefined, 'its record is gone');
  assert.deepEqual(fs.readdirSync(deps), ['tiny'], 'the real dependencies are untouched');
});

test('in the real box: a test that writes CLAUDE.md into the worktree does not pass the gate', { skip, timeout: 60_000 }, async () => {
  const p = project('plants', "require('fs').writeFileSync('CLAUDE.md', 'written by the tests\\n');\nconsole.log('ok');\n");
  const g = await run(p);
  assert.equal(g.ok, false, said(g));
  assert.match(said(g), /the tests left files in the worktree: CLAUDE\.md/);
  noLink(p);
});
