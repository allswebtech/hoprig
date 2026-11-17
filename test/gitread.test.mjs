// The one door for reads of a folder's git state (src/gitread.mjs), against a real repository whose own settings name
// programs (test/fixtures/hostile-repo.mjs): each kind of read starts none of them and still answers right; a
// submodule's own settings do not reach a status or a diff either; the caller's GIT_* and the caller's own arguments
// cannot take a guard back; a settings read answers with the folder's own value; a read whose folder settings cannot
// be listed, or that this git cannot guard, is refused and not run; a command that changes a repository is no read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hostileRepo } from './fixtures/hostile-repo.mjs';

const { FIXED, REFUSED, REFUSED_MANY, REFUSED_OLD, gitRead, overridesFor, readCommand, readEnv } = await import('../src/gitread.mjs');

const posix = process.platform !== 'win32';
const skip = !posix && 'the programs are shell scripts';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitread-test-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const marks = path.join(root, 'marks');
const h = posix ? hostileRepo(path.join(root, 'cloned'), marks) : null;
// The tests' own global settings: none (the owner's would be in force in the dashboard).
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global') };

async function read(args, o = {}) {
  h.clear();
  const r = await gitRead(h.dir, args, { env, ...o });
  assert.deepEqual(h.ran(), [], `git ${args.join(' ')} started a program the folder's settings name`);
  return r;
}

test('status, ls-files, diff, show, log, grep, cat-file and branch reads start none of the folder\'s programs', { skip }, async () => {
  const st = await read(['status', '--porcelain']);
  assert.equal(st.stdout, ' M a.txt\n?? new.txt\n', 'b.txt and c.md hold the same text: not changed');
  assert.equal((await read(['ls-files', '-co', '--exclude-standard'])).stdout.split('\n').filter(Boolean).sort().join(' '), '.gitattributes a.txt b.txt c.md gone.txt new.txt');
  const d = await read(['diff']);
  assert.equal(d.ok, true, d.stderr);
  assert.match(d.stdout, /^\+two$/m, 'the change itself, not an external tool\'s or a converter\'s output');
  const lp = await read(['log', '-1', '-p', '--', 'a.txt']);
  assert.equal(lp.ok, true, lp.stderr);
  assert.match(lp.stdout, /^\+one$/m);
  assert.match((await read(['show', '--stat', 'HEAD'])).stdout, /signed/);
  assert.equal((await read(['log', '-1', '--format=%s'])).stdout.trim(), 'signed', 'no signature check, so no gpg program');
  assert.equal((await read(['grep', '--untracked', '-n', 'two'])).stdout, 'a.txt:2:two\n');
  const gone = await read(['cat-file', '-s', 'HEAD:gone.txt']);
  assert.equal(gone.ok, false, 'a missing object is not fetched from the folder\'s remote');
  assert.equal((await read(['symbolic-ref', '--short', 'HEAD'])).stdout.trim(), 'main');
  assert.equal((await read(['config', '--get', 'remote.origin.url'])).stdout.trim(), h.bin);
  // A settings read answers with the folder's own value, not the reader's fixed one.
  assert.equal((await read(['config', '--get', 'core.hooksPath'])).stdout.trim(), path.join(h.bin, 'hooks'));
  assert.equal((await read(['config', '--get', 'core.fsmonitor'])).stdout.trim(), path.join(h.bin, 'fsmonitor'));
});

test('a submodule\'s own filter does not run in a status of the repository around it', { skip }, async () => {
  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent);
  const g = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: parent, env, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  const sub = hostileRepo(path.join(parent, 'sub'), path.join(root, 'sub-marks'));
  g('add', 'sub');
  g('commit', '-qm', 'with a submodule');
  // The parent asks for a submodule's changes as a diff: git would run that diff inside it, with its own drivers.
  g('config', 'diff.submodule', 'diff');
  const reads = [
    ['status', '--porcelain'], ['diff'], ['diff', 'HEAD'], ['diff', '--cached'], ['show', 'HEAD'], ['log', '-1', '-p'],
    ['diff-files', '-p'], ['diff-index', '-p', 'HEAD'], ['diff-tree', '-p', 'HEAD'],
  ];
  for (const args of reads) {
    sub.clear();
    const r = await gitRead(parent, args, { env });
    assert.equal(r.ok, true, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(sub.ran(), [], `git ${args.join(' ')} started a program the submodule's settings name`);
  }
});

test('the caller\'s GIT_* never reach git: another repository, an external diff, settings of its own', { skip }, async () => {
  const other = path.join(root, 'other');
  execFileSync('git', ['init', '-q', '-b', 'other', other], { env });
  const ext = path.join(h.bin, 'external');
  const loud = {
    ...env, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_EXTERNAL_DIFF: ext, GIT_PAGER: ext,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: path.join(h.bin, 'fsmonitor'),
    GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${path.join(h.bin, 'fsmonitor')}'`,
  };
  const c = await readCommand(h.dir, ['diff'], { env: loud });
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_PARAMETERS']) assert.equal(c.env[k], undefined, k);
  assert.equal(c.env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_GLOBAL, 'the owner\'s own global settings stay');
  assert.equal(c.env.PATH, env.PATH);
  const d = await read(['diff'], { env: loud });
  assert.match(d.stdout, /^\+two$/m, 'the folder named, not the caller\'s GIT_DIR');
  assert.equal((await read(['symbolic-ref', '--short', 'HEAD'], { env: loud })).stdout.trim(), 'main');
  // A PATH the caller hands in is the one git is found on.
  assert.equal(readEnv({ PATH: '/nowhere', GIT_DIR: '/x', LC_ALL: 'C', SECRET_TOKEN: 'x' }).PATH, '/nowhere');
  assert.deepEqual(Object.keys(readEnv({ PATH: '/p', GIT_DIR: '/x', LC_ALL: 'C', SECRET_TOKEN: 'x' })).filter((k) => !k.startsWith('GIT_')).sort(), ['LC_ALL', 'PATH']);
});

test('the fixed settings come on the command line, the drivers from the folder\'s own list', async () => {
  const c = await readCommand(root, ['status'], { env, run: async () => ({ ok: true, stdout: 'global\0filter.mine.clean\0local\0filter.a=b.clean\0worktree\0diff.x.textconv\0local\0core.bare\0' }) });
  const argv = c.argv.join(' ');
  for (const f of FIXED) assert.ok(argv.includes(`-c ${f}`), f);
  assert.ok(c.argv.includes('--ignore-submodules=dirty'));
  // Drivers with a plain name go on the command line, which every git reads; the one whose name holds "=" in the
  // environment (this git is new enough: the version is looked up once).
  assert.ok(argv.includes('-c diff.x.textconv= '), argv);
  assert.ok(!argv.includes('filter.mine'), 'the owner\'s global filter stays in force');
  const keys = Object.keys(c.env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => [c.env[k], c.env[k.replace('KEY', 'VALUE')]]);
  assert.deepEqual(keys, [['filter.a=b.clean', ''], ['filter.a=b.required', 'false']]);
  assert.equal(c.env.GIT_CONFIG_COUNT, '2');
  assert.deepEqual(overridesFor(['filter.Up.Dot.process', 'diff.external', 'merge.x.driver']), [['filter.Up.Dot.process', ''], ['filter.Up.Dot.required', 'false'], ['diff.external', '']]);
  const d = await readCommand(root, ['--literal-pathspecs', 'log', '-p'], { env, run: async () => ({ ok: true, stdout: '' }) });
  assert.deepEqual(d.argv.slice(-6), ['--literal-pathspecs', 'log', '--ignore-submodules=dirty', '--no-ext-diff', '--no-textconv', '-p']);
  assert.equal(d.env.GIT_CONFIG_COUNT, undefined, 'no driver: nothing in the environment');
  // A read that compares no contents lists nothing first.
  let listed = 0;
  await readCommand(root, ['rev-parse', 'HEAD'], { env, run: async () => (listed++, { ok: true, stdout: '' }) });
  assert.equal(listed, 0);
});

test('git older than 2.31 ignores GIT_CONFIG_COUNT: a driver it cannot switch off refuses the read', async () => {
  const listing = 'local\0filter.a=b.clean\0local\0filter.plain.clean\0';
  const runAs = (version) => {
    const calls = [];
    return { calls, run: async (argv) => (calls.push(argv), argv[1] === '--version' ? { ok: true, stdout: `git version ${version}\n` } : { ok: true, stdout: listing }) };
  };
  const old = runAs('2.30.2');
  const r = await gitRead(root, ['status'], { env: { ...env, PATH: '/old-git' }, run: old.run });
  assert.deepEqual([r.ok, r.refused, r.stderr], [false, true, REFUSED_OLD]);
  assert.equal(old.calls.filter((a) => a.includes('status')).length, 0, 'the read itself did not run');
  // A plain driver name alone needs no version: the -c override works on every git.
  const plain = runAs('2.30.2');
  const p = await readCommand(root, ['status'], { env: { ...env, PATH: '/old-git-2' }, run: async (argv) => (plain.calls.push(argv), { ok: true, stdout: 'local\0filter.plain.clean\0' }) });
  assert.ok(p.argv.join(' ').includes('-c filter.plain.clean= '));
  assert.equal(plain.calls.length, 1, 'only the listing');
  // A newer git: the version is read once per PATH.
  const neu = runAs('2.53.0');
  for (let i = 0; i < 2; i++) assert.equal((await readCommand(root, ['diff'], { env: { ...env, PATH: '/new-git' }, run: neu.run })).refused, undefined);
  assert.equal(neu.calls.filter((a) => a[1] === '--version').length, 1);
  // A folder that names hundreds of drivers is no project.
  const many = Array.from({ length: 300 }, (_, i) => `local\0diff.d${i}.textconv\0`).join('');
  assert.equal((await readCommand(root, ['diff'], { env, run: async () => ({ ok: true, stdout: many }) })).refused, REFUSED_MANY);
});

test('when the folder\'s settings cannot be listed, the read is refused and not run', async () => {
  const calls = [];
  const run = async (argv) => (calls.push(argv), { ok: false, code: 128, stdout: '', stderr: 'fatal: bad config line 1' });
  const r = await gitRead(root, ['status', '--porcelain'], { env, run });
  assert.deepEqual([r.ok, r.refused, r.stderr], [false, true, REFUSED]);
  assert.equal(calls.length, 1, 'only the listing ran');
  assert.ok(calls[0].includes('config') && calls[0].includes('--list'));
  // A folder that is not there is no refusal: git's own words.
  const gone = await gitRead(path.join(root, 'not-here'), ['status'], { env });
  assert.equal(gone.ok, false);
  assert.notEqual(gone.stderr, REFUSED);
});

test('a command that changes a repository, or names another folder, is no read', async () => {
  for (const args of [['commit', '-m', 'x'], ['-c', 'core.quotePath=false', 'add', '.'], ['restore', 'x'], ['fetch'], ['push']]) {
    await assert.rejects(readCommand(root, args, { env }), /not a read/, args.join(' '));
  }
  await assert.rejects(readCommand(root, ['--git-dir=/x', 'status'], { env }), /dir only/);
  await assert.rejects(readCommand(root, ['-C', '/x', 'status'], { env }), /dir only/);
  await assert.rejects(readCommand(root, ['cat-file', '--filters', 'HEAD:a'], { env }), /never asks/);
  await assert.rejects(readCommand(root, ['config', 'core.hooksPath', '.githooks'], { env }), /not a read/);
  await assert.rejects(readCommand(root, ['blame', 'a.txt'], { env }), /not offered/);
});

test('a caller\'s own arguments cannot take a guard back', async () => {
  const run = async () => ({ ok: true, stdout: '' });
  const no = [
    ['log', '-p', '--textconv'], ['diff', '--ext-diff'], ['show', '--ignore-submodules=none'], ['diff', '--output=/tmp/x'],
    ['grep', '-O', 'x'], ['grep', '--open-files-in-pager=sh', 'x'], ['ls-files', '--recurse-submodules'],
    ['-c', 'core.fsmonitor=/x', 'status'], ['-c', 'core.hooksPath=/x', 'diff'], ['-c', 'diff.x.textconv=/x', 'log'],
  ];
  for (const args of no) await assert.rejects(readCommand(root, args, { env, run }), /cannot ask|no setting/, args.join(' '));
  // Allowed: the one caller setting in use, and the user's own text as grep's pattern or a path after "--".
  for (const args of [['-c', 'core.quotePath=false', 'ls-files'], ['grep', '-e', '--textconv'], ['log', '--', '--ext-diff']]) {
    assert.ok((await readCommand(root, args, { env, run })).argv, args.join(' '));
  }
});
