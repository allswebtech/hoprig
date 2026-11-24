// The one door for reads of a folder's git state (src/gitread.mjs), against a real repository whose own settings name
// programs (test/fixtures/hostile-repo.mjs): each kind of read starts none of them and still answers right; a
// submodule's own settings do not reach a status or a diff either; the caller's GIT_* and the caller's own arguments
// cannot take a guard back; a settings read answers with the folder's own value; a read whose folder settings cannot
// be listed, or that this git cannot guard, is refused and not run; a command that changes a repository is no read; a
// signature check, however it is spelled, starts none of the folder's signature programs (the fixed settings alone
// see to it); cat-file is a content read; each read takes only its own long options, named whole.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hostileRepo } from './fixtures/hostile-repo.mjs';

const { FIXED, LONG_OPTIONS, REFUSED, REFUSED_MANY, REFUSED_OLD, gitRead, overridesFor, readCommand, readEnv } = await import('../src/gitread.mjs');

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
  assert.match((await read(['log', '-1'])).stdout, /^commit [0-9a-f]+\n/, 'git\'s own default format, not the folder\'s (it has %G?)');
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

test('a merge commit\'s diff never merges its parents again: the folder\'s merge driver does not run', { skip }, async () => {
  const dir = path.join(root, 'merged');
  const ran = path.join(root, 'merge-driver-ran');
  const driver = path.join(root, 'merge-driver');
  fs.writeFileSync(driver, `#!/bin/sh\n: > '${ran}'\ncat "$2" > "$1"\n`, { mode: 0o755 });
  fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, env, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt merge=evil\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'side');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'side\n');
  g('commit', '-qam', 'side');
  g('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'main\n');
  g('commit', '-qam', 'main');
  g('config', 'merge.evil.driver', `${driver} %A %B %O`);
  g('merge', '-q', '-m', 'merged', 'side');
  fs.rmSync(ran, { force: true });
  // "remerge": -m shows a merge commit by merging its parents again, and that merge starts the folder's driver.
  g('config', 'log.diffMerges', 'remerge');
  for (const args of [['log', '-m', '-p', '-1'], ['show', '-m', 'HEAD'], ['log', '-m', '--name-only', '-1']]) {
    const r = await gitRead(dir, args, { env });
    assert.equal(r.ok, true, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(fs.existsSync(ran), false, `git ${args.join(' ')} started the folder's merge driver`);
  }
  assert.equal((await gitRead(dir, ['show', '--remerge-diff', 'HEAD'], { env }).catch((e) => e)).message, 'a read cannot ask for --remerge-diff');
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
  assert.equal(readEnv({ PATH: '/nowhere', GIT_DIR: '/x', LC_ALL: 'C', SECRET_TOKEN: 'x' }).PATH, '/nowhere'); // seal: a value no program is started with
  assert.deepEqual(Object.keys(readEnv({ PATH: '/p', GIT_DIR: '/x', LC_ALL: 'C', SECRET_TOKEN: 'x' })).filter((k) => !k.startsWith('GIT_')).sort(), ['LC_ALL', 'PATH']); // seal: a value no program is started with
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
  const r = await gitRead(root, ['status'], { env: { ...env, PATH: '/old-git' }, run: old.run }); // seal: its runner is a stand-in
  assert.deepEqual([r.ok, r.refused, r.stderr], [false, true, REFUSED_OLD]);
  assert.equal(old.calls.filter((a) => a.includes('status')).length, 0, 'the read itself did not run');
  // A plain driver name alone needs no version: the -c override works on every git.
  const plain = runAs('2.30.2');
  const p = await readCommand(root, ['status'], { env: { ...env, PATH: '/old-git-2' }, run: async (argv) => (plain.calls.push(argv), { ok: true, stdout: 'local\0filter.plain.clean\0' }) }); // seal: its runner is a stand-in
  assert.ok(p.argv.join(' ').includes('-c filter.plain.clean= '));
  assert.equal(plain.calls.length, 1, 'only the listing');
  // A newer git: the version is read once per PATH.
  const neu = runAs('2.53.0');
  for (let i = 0; i < 2; i++) assert.equal((await readCommand(root, ['diff'], { env: { ...env, PATH: '/new-git' }, run: neu.run })).refused, undefined); // seal: its runner is a stand-in
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

test('only git\'s own reads go through: a write, a program, an alias or another folder is no read', async () => {
  const run = async () => ({ ok: true, stdout: '' });
  const writes = [
    ['commit', '-m', 'x'], ['-c', 'core.quotePath=false', 'add', '.'], ['restore', 'x'], ['fetch'], ['push'],
    // Not on the old list of writes, and each one passed: a new tag or branch, a moved HEAD, a folder's difftool,
    // gpg for a signature, a word the folder's settings make an alias, blame (fails on an emptied filter).
    ['tag', 'newtag'], ['branch', 'newbranch'], ['symbolic-ref', 'HEAD', 'refs/heads/zzz'], ['symbolic-ref', '-d', 'HEAD'],
    ['symbolic-ref', '--', 'HEAD', 'refs/heads/zzz'], ['difftool', '-y'], ['difftool', '--no-prompt', '--tool=x'],
    ['verify-commit', 'HEAD'], ['evilalias'], ['blame', 'a.txt'], ['whatchanged'], [],
    ['remote', 'add', 'x', 'y'], ['remote', 'show', 'origin'], ['remote', '-v', 'update'],
    ['config', 'core.hooksPath', '.githooks'], ['config', '-e'], ['config', '--get', 'x', '--add', 'y'], ['config', '--file=/etc/x', '--list'],
    ['config', '--global', 'set', 'x', 'y'], ['config', 'set', 'x', 'y'],
  ];
  for (const args of writes) await assert.rejects(readCommand(root, args, { env, run }), /not a read/, args.join(' '));
  await assert.rejects(readCommand(root, ['--git-dir=/x', 'status'], { env }), /dir only/);
  await assert.rejects(readCommand(root, ['-C', '/x', 'status'], { env }), /dir only/);
  await assert.rejects(readCommand(root, ['--exec-path', '/x', 'status'], { env }), /dir only/);
  await assert.rejects(readCommand(root, ['--paginate', 'status'], { env }), /cannot ask/);
  for (const args of [['cat-file', '--filters', 'HEAD:a'], ['cat-file', '--textconv', 'HEAD:a'], ['cat-file', '--batch', '--filt']]) {
    await assert.rejects(readCommand(root, args, { env, run }), /cannot ask/, args.join(' '));
  }
  // The reads the dashboard makes all go through.
  const reads = [
    ['rev-parse', '--show-toplevel', '--show-prefix'], ['symbolic-ref', '--short', '-q', 'HEAD'], ['remote'], ['remote', '-v'],
    ['remote', 'get-url', 'origin'], ['config', '--get', 'remote.origin.url'], ['config', 'get', 'core.hooksPath'],
    ['rev-list', '--left-right', '--count', 'HEAD...x'], ['merge-base', '--is-ancestor', 'a', 'HEAD'], ['cat-file', '-s', 'HEAD:a'],
    ['for-each-ref', '--format=%(refname)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)', 'refs/heads'],
    ['--literal-pathspecs', 'log', '-z', '--format=%H%x00%h%x00%an%x00%at%x00%s', '-n', '5', '--', 'a'],
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.'], ['diff', '--cached', '--no-renames', '--name-only', '-z'],
    ['ls-files', '-co', '--exclude-standard'], ['grep', '-n', '--column', '-I', '-z', '--untracked', '--max-count', '5', '-i', '-F', '-e', 'x', '--', '.'],
    ['diff', '--text'], ['rev-list', '--filter=blob:none', 'HEAD'], ['log', '--pretty=oneline'], ['log', '--format=tformat:%s'],
    // Every other read a module under src makes.
    ['rev-parse', 'HEAD'], ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], ['rev-parse', '--verify', '-q', 'HEAD'],
    ['status', '--porcelain', '--untracked-files=no'], ['status', '--porcelain', '--', 'MAP.json'], ['diff', '--cached', '--quiet'], ['diff', '--cached', '--quiet', '--', 'a'],
    ['status', '--porcelain=v1', '-b', '--untracked-files=all', '--', '.', ':(exclude,glob)**/node_modules/**'], ['log', '--format=%s'], ['log', '-1', '--format=%h%x00%s'],
    ['cat-file', 'blob', 'HEAD:a'], ['symbolic-ref', '--short', '-q', 'HEAD'], ['ls-files', '-co', '--exclude-standard'],
    ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '--', '.'], ['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', 'a'],
    ['grep', '-n', '--column', '-I', '-z', '--untracked', '--exclude-standard', '--max-count', '5', '-P', '-w', '-e', 'x', '--', '.'],
    ['diff', '--cached', '--no-renames', '--name-only', '-z', '--', '.'], ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'],
  ];
  for (const args of reads) assert.ok((await readCommand(root, args, { env, run })).argv, args.join(' '));
});

test('a caller\'s own arguments cannot take a guard back', async () => {
  const run = async () => ({ ok: true, stdout: '' });
  const no = [
    ['log', '-p', '--textconv'], ['diff', '--ext-diff'], ['show', '--ignore-submodules=none'], ['diff', '--output=/tmp/x'],
    ['grep', '-O', 'x'], ['grep', '-nOsh', 'x'], ['grep', '--open-files-in-pager=sh', 'x'], ['ls-files', '--recurse-submodules'],
    ['-c', 'core.fsmonitor=/x', 'status'], ['-c', 'core.hooksPath=/x', 'diff'], ['-c', 'diff.x.textconv=/x', 'log'],
    // A submodule looked into again: its own clean filter and diff command ran.
    ['status', '--no-ignore-submodules'], ['status', '--ignore-sub=none'], ['status', '--no-ig'], ['ls-files', '--recurse-s'],
    ['diff', '--submodule=diff', 'HEAD~1'], ['show', '--submodule=diff', 'HEAD'], ['log', '-1', '-p', '--submodule=diff'], ['diff', '--submodule'],
    // A signature check: the folder's gpg.program ran.
    ['log', '-1', '--show-signature'], ['show', '-s', '--show-signature', 'HEAD'], ['log', '-1', '--format=%G?'],
    ['log', '-1', '--pretty=format:%GS'], ['rev-list', '--format=%GK', 'HEAD'], ['for-each-ref', '--format=%(signature)'],
    ['log', '-1', '--pretty=evil'], ['log', '--format=mine'],
    // Abbreviations of the guarded options, and git's help (a man page or a browser the folder may name).
    ['diff', '--textc'], ['diff', '--ext-d'], ['grep', '--open-f'], ['log', '--show-sig'], ['diff', '--out=x'], ['log', '--help'],
  ];
  for (const args of no) await assert.rejects(readCommand(root, args, { env, run }), /cannot ask|no setting/, args.join(' '));
  // Allowed: the one caller setting in use, the user's own text as grep's pattern or a path after "--", the guard's
  // own value.
  for (const args of [['-c', 'core.quotePath=false', 'ls-files'], ['grep', '-e', '--textconv'], ['grep', '-e', '-nO'], ['log', '--', '--ext-diff'], ['status', '--ignore-submodules=all']]) {
    assert.ok((await readCommand(root, args, { env, run })).argv, args.join(' '));
  }
});

// The read as the reader composes it (fixed settings, the folder's drivers set to nothing, the guards it adds), but
// with the caller's words after the command put on without the argument check: what the fixed settings alone stop.
async function unchecked(cmd, words) {
  const c = await readCommand(h.dir, [cmd], { env });
  assert.ok(c.argv, c.refused);
  h.clear();
  const r = spawnSync(c.argv[0], [...c.argv.slice(1), ...words], { env: c.env, encoding: 'utf8', timeout: 15_000 });
  return { ...r, ran: h.ran() };
}

// Each spelling of a signature check that got past the first argument check and started the folder's gpg program
// (git 2.53), and the same checks on commits signed the two other ways and through a tag.
const SIGNATURE_READS = [
  ['log', '-1', '--format=%+G?'], ['log', '-1', '--format=%-G?'], ['log', '-1', '--format=% G?'], ['log', '-1', '--format=%<(5)%+G?'],
  ['show', '-s', '--pretty=tformat:%+GS', 'HEAD'], ['rev-list', '-1', '--format=%+G?', 'HEAD'],
  ['for-each-ref', '--format=%(*signature)'], ['for-each-ref', '--format=%(signature:grade)'], ['for-each-ref', '--format=%(if)%(signature)%(then)s%(end)'],
  ['for-each-ref', '--sort=signature'], ['for-each-ref', '--sort=-signature:grade'], ['for-each-ref', '--sort=*signature'], ['for-each-ref', '--sort', 'signature'],
  ['log', '-1', '--format=%G?', 'ssh-signed'], ['log', '-1', '--format=%G?', 'x509-signed'], ['log', '-1', '--format=%G?', 'v1'],
  ['log', '-1', '--show-signature', 'ssh-signed'], ['show', '-s', '--show-signature', 'x509-signed'], ['for-each-ref', '--format=%(signature)', 'refs/tags'],
];

test('a signature check is refused however it is spelled', { skip }, async () => {
  for (const args of SIGNATURE_READS) await assert.rejects(readCommand(h.dir, args, { env }), /cannot ask/, args.join(' '));
  h.clear();
  assert.deepEqual(h.ran(), []);
});

test('the fixed settings alone stop every signature program of the folder: the read answers that nothing was checked', { skip }, async () => {
  for (const args of SIGNATURE_READS) {
    const r = await unchecked(args[0], args.slice(1));
    assert.deepEqual(r.ran, [], `git ${args.join(' ')} started a program the folder's settings name`);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  }
  // git's own answer when no program could check the signature: N (none could be checked) for OpenPGP and X.509;
  // for SSH, git 2.53 says B.
  const grade = async (ref) => (await unchecked('log', ['-1', '--format=%G?', ref])).stdout.trim();
  assert.deepEqual([await grade('HEAD'), await grade('v1'), await grade('x509-signed'), await grade('ssh-signed')], ['N', 'N', 'N', 'B']);
  assert.equal((await unchecked('log', ['-1', '--format=%s', 'HEAD'])).stdout.trim(), 'signed', 'the read itself answers');
  // The alternate object store's refs: the folder's command for listing them does not start either.
  for (const [cmd, words] of [['log', ['--alternate-refs', '-1', '--format=%s']], ['rev-list', ['--alternate-refs', '--count', 'HEAD']]]) {
    const r = await unchecked(cmd, words);
    assert.deepEqual(r.ran, [], `git ${cmd} ${words.join(' ')} started a program the folder's settings name`);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('cat-file is a content read: --text is git\'s --textconv, and the folder\'s converters and filters are nothing for it', { skip }, async () => {
  for (const args of [['cat-file', '--text', 'HEAD:a.txt'], ['cat-file', '--text', '--path=a.txt', 'HEAD'], ['cat-file', '--textconv', 'HEAD:a.txt'], ['cat-file', '--filters', 'HEAD:a.txt']]) {
    await assert.rejects(readCommand(h.dir, args, { env }), /cannot ask/, args.join(' '));
  }
  assert.equal((await read(['cat-file', '-p', 'HEAD:a.txt'])).stdout, 'one\n');
  // Without the argument check: nothing of the folder's runs; a filter set to nothing passes the stored text through,
  // a converter set to nothing makes git stop with its own error.
  for (const words of [['--filters', 'HEAD:a.txt'], ['--filters', '--path=a.txt', 'HEAD:a.txt'], ['--text', 'HEAD:a.txt'], ['--textconv', 'HEAD:a.txt'], ['--text', '--path=a.txt', 'HEAD:a.txt']]) {
    const r = await unchecked('cat-file', words);
    assert.deepEqual(r.ran, [], `git cat-file ${words.join(' ')} started a program the folder's settings name`);
    if (words[0] === '--filters') assert.deepEqual([r.status, r.stdout], [0, 'one\n'], r.stderr);
  }
});

test('each read takes only its own long options, named whole: an abbreviation or another command\'s option is refused', async () => {
  const run = async () => ({ ok: true, stdout: '' });
  const no = [
    ['cat-file', '--tex', 'HEAD:a'], ['cat-file', '--path=a', 'HEAD'], ['cat-file', '--batch', '--filt'], ['status', '--porc'], ['status', '--cached'],
    ['ls-files', '--exclude-st'], ['grep', '--untrack', 'x'], ['grep', '--max-count', '-1', 'x'], ['for-each-ref', '--form=%(refname)'],
    ['merge-base', '--is-anc', 'a', 'b'], ['log', '--alternate-refs'], ['rev-list', '--alternate-refs', 'HEAD'], ['log', '--end-of-options', 'x'],
    ['diff', '--no-index', 'a', 'b'], ['rev-parse', '--resolve-git-dir', 'x'], ['symbolic-ref', '--delete', 'HEAD'], ['remote', '--verb'],
    ['status', '--short=x'], ['grep', '--max-count'],
  ];
  for (const args of no) await assert.rejects(readCommand(root, args, { env, run }), /cannot ask/, args.join(' '));
  const repo = path.join(root, 'whole-names');
  execFileSync('git', ['init', '-q', repo], { env });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'], { env, cwd: repo });
  // In the commands whose options git takes by any unique start (parse-options), every name on the reader's list is
  // a whole name of that command in this git, so it can never stand for another option.
  const listed = (cmd, sub = []) => new Set(execFileSync('git', [cmd, ...sub, '--git-completion-helper-all'], { env, cwd: repo }).toString().split(/\s+/).map((w) => w.replace(/=$/, '')));
  for (const cmd of ['status', 'ls-files', 'grep', 'cat-file', 'for-each-ref', 'merge-base', 'symbolic-ref']) {
    const own = listed(cmd);
    for (const name of LONG_OPTIONS.get(cmd).keys()) assert.ok(own.has(name), `git ${cmd} has no option named ${name}`);
  }
  const remote = new Set([...listed('remote'), ...listed('remote', ['get-url'])]);
  for (const name of LONG_OPTIONS.get('remote').keys()) assert.ok(remote.has(name), `git remote has no option named ${name}`);
  // The others take only whole names: an abbreviation is an error of git's own.
  for (const args of [['log', '--max-count=1'], ['show', '--name-only'], ['diff', '--cached'], ['rev-list', '--count', 'HEAD'], ['diff-tree', '--name-only', 'HEAD'], ['diff-index', '--cached', 'HEAD'], ['diff-files', '--name-only']]) {
    assert.equal(spawnSync('git', args, { env, cwd: repo }).status, 0, `the whole name works: ${args.join(' ')}`);
  }
  for (const args of [['log', '--max-cou=1'], ['show', '--name-on'], ['diff', '--cach'], ['rev-list', '--cou', 'HEAD'], ['diff-tree', '--name-on', 'HEAD'], ['diff-index', '--cach', 'HEAD'], ['diff-files', '--name-on']]) {
    assert.notEqual(spawnSync('git', args, { env, cwd: repo }).status, 0, args.join(' '));
  }
});
