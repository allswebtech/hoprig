// The one thing Hoprig answers by itself in bypass mode (src/asking.mjs plainDelete): a command line that is plainly a
// delete inside the folder it runs in. An allow-list read by a strict reader: these tests hold it to "no" for every
// spelling of a delete Claude Code stops for that is not plainly inside, and to "yes" for the ordinary ones.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { bypassAllows, plainDelete, projectFolders } = await import('../src/asking.mjs');
const D = await import('./fixtures/deletes.mjs');

const HOME = '/home/alex';
const WS = '/home/alex/Workspace';
const PROJECT = '/home/alex/Workspace/p';
const IN = { home: HOME, workspace: WS, cwd: PROJECT };

const STOPPED = D.STOPPED;
const ORDINARY = D.ordinary(PROJECT);

test('a delete in a repository\'s own .git folder is no plain delete, wherever it stands in the path and however it is written', () => {
  for (const command of ['rm -rf .git', 'rm -rf .git/objects/*', 'rm -rf ./.git', 'rm -rf sub/.git/*', `rm -rf ${PROJECT}/.git`, 'rm -rf build .git', 'rm -rf .GIT/hooks', 'rm -rf ".git"/refs']) {
    assert.equal(plainDelete(command, IN), false, command);
    assert.equal(bypassAllows({ mode: 'bypassPermissions', tool: 'Bash', input: { command }, places: IN }), false, command);
  }
  for (const command of ['rm -rf .github/old', 'rm -rf git/tmp', 'rm -rf .gitignore.bak']) assert.equal(plainDelete(command, IN), true, command);
});

test('every line of the review keeps Claude Code\'s question: the fourteen that delete the home or the disk, and the four of "the folder it runs in or above"', () => {
  for (const command of STOPPED) {
    for (const cwd of [PROJECT, HOME, WS, '/', '/tmp', null]) assert.equal(plainDelete(command, { ...IN, cwd }), false, `${JSON.stringify(command)} in ${cwd}`);
    assert.equal(bypassAllows({ mode: 'bypassPermissions', tool: 'Bash', input: { command }, places: IN }), false, command);
  }
});

test('an ordinary delete inside a project is answered there, and nowhere else: not from the home, the workspace, /, /tmp or an unknown folder', () => {
  for (const command of ORDINARY) {
    assert.equal(plainDelete(command, IN), true, command);
    assert.equal(bypassAllows({ mode: 'bypassPermissions', tool: 'Bash', input: { command }, places: IN }), true, command);
    for (const cwd of [HOME, WS, '/', '/tmp', '/home', '/home/bob', null, '', 'p', `${PROJECT}/`, '/home/alex/Workspace/./p', 'C:\\Users\\alex\\p']) {
      assert.equal(plainDelete(command, { ...IN, cwd }), false, `${command} in ${cwd}`);
    }
  }
  // Any other folder that is none of those may hold a plain delete.
  assert.equal(plainDelete('rm -rf dist', { ...IN, cwd: '/srv/app' }), true);
  assert.equal(plainDelete('rm -rf dist', { ...IN, cwd: '/tmp/x' }), true);
  // Folders that hold the home or workspace folder count as those (a home of another user too), in any letter case.
  for (const cwd of ['/home/ALEX', '/home/alex/workspace', '/Users/alex']) assert.equal(plainDelete('rm -rf dist', { ...IN, cwd, ...(cwd.startsWith('/Users') ? { home: '/Users/bob' } : {}) }), false, cwd);
  assert.equal(plainDelete('rm -rf dist', { ...IN, home: null }), false, 'the home folder must be known');
});

test('from a folder that holds projects no delete is plain: `rm -rf shop/*/*` there empties a whole project', () => {
  const projects = ['/home/alex/Workspace/projects', '/srv/code'];
  const at = (cwd, command = 'rm -rf shop/*/*') => plainDelete(command, { ...IN, projects, cwd });
  for (const cwd of [...projects, '/home/alex/Workspace/PROJECTS', '/srv']) {
    assert.equal(at(cwd), false, cwd);
    assert.equal(at(cwd, 'rm -rf shop'), false, cwd);
    assert.equal(at(cwd, `rm -rf ${cwd}/shop/*`), false, `absolute, ${cwd}`);
  }
  // Inside a project it is answered as before, and a folder beside the projects folder is any other folder.
  for (const cwd of ['/home/alex/Workspace/projects/shop', '/srv/code/shop/web', '/home/alex/Workspace/projects2']) assert.equal(at(cwd), true, cwd);
  // A link to the projects folder counts as that folder.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-projects-')));
  try {
    fs.mkdirSync(path.join(base, 'real', 'projects', 'shop'), { recursive: true });
    fs.symlinkSync(path.join(base, 'real', 'projects'), path.join(base, 'link'));
    assert.equal(plainDelete('rm -rf shop/*', { ...IN, projects: [path.join(base, 'real', 'projects')], cwd: path.join(base, 'link') }), false);
    assert.equal(plainDelete('rm -rf shop/*', { ...IN, projects: [path.join(base, 'link')], cwd: path.join(base, 'real', 'projects') }), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  assert.equal(bypassAllows({ mode: 'bypassPermissions', tool: 'Bash', input: { command: 'rm -rf shop/*/*' }, places: { ...IN, projects, cwd: projects[1] } }), false);
});

test('from inside a repository\'s history no delete is plain: a folder with a part named .git, or a git folder itself (a bare repository too)', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-gitdir-')));
  try {
    const proj = path.join(base, 'shop');
    for (const d of ['.git/objects/ab', 'bare.git/objects', 'other/objects', 'sub']) fs.mkdirSync(path.join(proj, d), { recursive: true });
    fs.writeFileSync(path.join(proj, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(proj, 'bare.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.symlinkSync(path.join(proj, '.git'), path.join(proj, 'history'));
    const at = (cwd) => plainDelete('rm -rf objects/*/*', { ...IN, cwd });
    for (const cwd of [path.join(proj, '.git'), path.join(proj, '.git', 'objects'), path.join(proj, '.GIT'), path.join(proj, 'bare.git'), path.join(proj, 'history')]) assert.equal(at(cwd), false, cwd);
    // Text alone counts too, where the folder does not exist on this computer.
    assert.equal(at('/home/alex/Workspace/p/.git/objects'), false);
    // A folder with an objects folder but no HEAD is any folder; a project's own folders as before.
    for (const cwd of [path.join(proj, 'other'), path.join(proj, 'sub'), proj]) assert.equal(at(cwd), true, cwd);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('on disk: a target that is, or holds, a repository is no plain delete, nor one through a link; ordinary ones are, and a missing one', { skip: process.platform === 'win32' && 'links' }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-ondisk-')));
  try {
    const proj = path.join(base, 'proj');
    const mk = (...ds) => ds.forEach((d) => fs.mkdirSync(path.join(proj, d), { recursive: true }));
    mk('.git', 'code/repoA/.git', 'code/repoB', 'code/nested/deeper/repoC/.git', 'group/g1/repoD/.git', 'mods/m1', 'dist/x', 'build', 'tmp/a/b', 'deep/a/b/c/d/repoE/.git');
    fs.writeFileSync(path.join(proj, 'code/repoB/.git'), 'gitdir: /elsewhere/.git/worktrees/repoB\n'); // a worktree
    fs.writeFileSync(path.join(proj, 'mods/m1/.git'), 'gitdir: ../../.git/modules/m1\n'); // a submodule
    fs.writeFileSync(path.join(proj, 'build/a.o'), '');
    fs.writeFileSync(path.join(proj, 'tmp/a/b/f'), '');
    fs.mkdirSync(path.join(base, 'outside'));
    fs.symlinkSync(path.join(base, 'outside'), path.join(proj, 'out'));
    fs.symlinkSync(path.join(proj, 'dist'), path.join(proj, 'inl'));
    for (let i = 0; i < 2100; i++) fs.mkdirSync(path.join(proj, 'huge', `d${i}`), { recursive: true });
    const at = (command, cwd = proj) => plainDelete(command, { ...IN, cwd });
    for (const command of [
      'rm -rf code', 'rm -rf code/*', 'rm -rf code/*/*', 'rm -rf code/repoA', 'rm -rf code/repoB', 'rm -rf code/nested', 'rm -rf group', 'rm -rf group/*', 'rm -rf mods',
      'rm -rf mods/m1', 'rm -rf huge', 'rm -rf out/x', 'rm -rf out/*', 'rm -rf out/', 'rm -rf inl/x', `rm -rf ${proj}/code/*/*`, 'rm -rf dist && rm -rf code',
      'rm -rf deep', // a repository five levels below: looked for all the way down
    ]) assert.equal(at(command), false, command);
    for (const command of ['rm -rf dist', 'rm -rf build/*.o', 'rm -rf tmp/*/*', 'rm -rf out', 'rm -rf inl', 'rm -rf missing/*/*', 'rm -rf code/repoA/node_modules', `rm -rf ${proj}/dist`]) {
      assert.equal(at(command), true, command);
    }
    // From a folder of repositories, each of them is a whole project.
    assert.equal(at('rm -rf repoA', path.join(proj, 'code')), false);
    assert.equal(at('rm -rf g1/*', path.join(proj, 'group')), false);
    // * could match .git under an option of the shell (dotglob): judged as a superset, that is no plain delete.
    assert.equal(at('rm -rf repoA/*/*', path.join(proj, 'code')), false);
    // A repository deeper than three levels below the fixed part is found where the glob leads to it.
    assert.equal(at('rm -rf deep/*/*/*/*/repoE'), false);
    assert.equal(at('rm -rf deep/*/*/*/*/*'), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('what the shell hands to rm is judged: a glob through a link, a repository found by a glob, =word, **, a huge folder, a mount', { skip: process.platform === 'win32' && 'links' }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-expand-')));
  try {
    const proj = path.join(base, 'proj');
    fs.mkdirSync(path.join(proj, 'a', 'real'), { recursive: true });
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside', 'x'), '');
    fs.symlinkSync('../../outside', path.join(proj, 'a', 'l'));
    fs.mkdirSync(path.join(proj, 'deep', 'a', 'b', 'c', 'd', 'proj', '.git'), { recursive: true });
    const at = (command, cwd = proj) => plainDelete(command, { ...IN, cwd });
    // A glob that matches a link, with the path going on after it (GNU rm deletes a link's contents for a/l/).
    for (const command of ['rm -rf a/*/x', 'rm -rf a/*/', 'rm -rf a/*/*', 'rm -rf a/?/x', `rm -rf ${proj}/a/*/x`, 'rm -rf a/l/']) assert.equal(at(command), false, command);
    for (const command of ['rm -rf a/*', 'rm -rf a/l', 'rm -rf a/real/*']) assert.equal(at(command), true, command);
    // A repository deeper than three levels, reached by the glob; ** at any depth; zsh's =word.
    for (const command of ['rm -rf deep/*/*/*/*/proj', 'rm -rf deep/**/proj', 'rm -rf deep/a/**', 'rm -rf =node', 'rm -rf =x/y']) assert.equal(at(command), false, command);
    // One folder too big to read within the budget: no, and soon.
    const huge = path.join(proj, 'huge');
    fs.mkdirSync(huge);
    for (let i = 0; i < 21000; i++) fs.writeFileSync(path.join(huge, `f${i}`), '');
    const t = performance.now();
    assert.equal(at('rm -rf huge/*'), false);
    assert.ok(performance.now() - t < 1000, `${(performance.now() - t).toFixed(0)} ms`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  // A mount inside the folder (where this computer has one under a folder that may hold plain deletes).
  let mounts = [];
  try {
    mounts = fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
  } catch {
    /* no /proc */
  }
  const m = mounts.find((p) => {
    const parent = path.dirname(p);
    try {
      return parent.split('/').length >= 3 && !p.includes('\\') && fs.statSync(p).dev !== fs.statSync(parent).dev;
    } catch {
      return false;
    }
  });
  if (m) assert.equal(plainDelete(`rm -rf ${path.basename(m)}`, { ...IN, cwd: path.dirname(m) }), false, m);
});

test('a bare repository is seen: from a folder inside one, and as a target or held by one', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-bare-')));
  try {
    const mirror = path.join(base, 'mirrors', 'shop.git');
    for (const d of ['objects/pack', 'refs/heads']) fs.mkdirSync(path.join(mirror, d), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(base, 'mirrors', 'plain', 'x'), { recursive: true });
    // From inside it: the path has no part named .git, and objects or refs has no HEAD of its own.
    for (const cwd of [path.join(mirror, 'objects'), path.join(mirror, 'objects', 'pack'), path.join(mirror, 'refs')]) assert.equal(plainDelete('rm -rf pack/*', { ...IN, cwd }), false, cwd);
    // As a target, or in a folder of mirrors.
    for (const command of ['rm -rf mirrors/*', 'rm -rf mirrors', 'rm -rf mirrors/shop.git']) assert.equal(plainDelete(command, { ...IN, cwd: base }), false, command);
    assert.equal(plainDelete('rm -rf mirrors/plain/*', { ...IN, cwd: base }), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('on disk, a .git entry counts in any letter case', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-gitcase-')));
  try {
    fs.mkdirSync(path.join(base, 'code', 'shop', '.GIT'), { recursive: true });
    fs.mkdirSync(path.join(base, 'code', 'web', '.Git'), { recursive: true });
    for (const command of ['rm -rf code', 'rm -rf code/*', 'rm -rf code/shop']) assert.equal(plainDelete(command, { ...IN, cwd: base }), false, command);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the folders that hold projects: the chosen one, the default, the earlier default, and the one the workspace map names', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-projmap-')));
  try {
    const ws = path.join(base, 'ws');
    const home = path.join(base, 'home');
    assert.deepEqual(projectFolders({ workspace: ws, home, chosen: '/srv/code' }), ['/srv/code', path.join(ws, 'projects'), path.join(home, 'projects')]);
    fs.mkdirSync(path.join(ws, 'ai_brain'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'ai_brain', 'workspace.json'), JSON.stringify({ version: 1, config: { projectsDir: 'work/repos' }, projects: [] }));
    assert.deepEqual(projectFolders({ workspace: ws, home }), [path.join(ws, 'projects'), path.join(ws, 'work', 'repos'), path.join(home, 'projects')]);
    // Only a plain file of a map's size is read: not a larger one, not a link, not a folder.
    fs.writeFileSync(path.join(ws, 'ai_brain', 'workspace.json'), JSON.stringify({ config: { projectsDir: 'big' }, pad: 'x'.repeat(1024 * 1024) }));
    assert.deepEqual(projectFolders({ workspace: ws, home }), [path.join(ws, 'projects'), path.join(home, 'projects')], 'over 1 MB');
    fs.rmSync(path.join(ws, 'ai_brain', 'workspace.json'));
    fs.writeFileSync(path.join(base, 'elsewhere.json'), JSON.stringify({ config: { projectsDir: 'linked' } }));
    fs.symlinkSync(path.join(base, 'elsewhere.json'), path.join(ws, 'ai_brain', 'workspace.json'));
    assert.deepEqual(projectFolders({ workspace: ws, home }), [path.join(ws, 'projects'), path.join(home, 'projects')], 'a link');
    fs.rmSync(path.join(ws, 'ai_brain', 'workspace.json'));
    // What is read is the file that was checked: the open descriptor, not the path again (a file swapped in between
    // the check and the read stands here for a read by the path).
    fs.writeFileSync(path.join(ws, 'ai_brain', 'workspace.json'), JSON.stringify({ config: { projectsDir: 'checked' } }));
    const byPath = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => (String(p).endsWith('workspace.json') ? JSON.stringify({ config: { projectsDir: 'swapped' } }) : byPath(p, ...rest));
    try {
      assert.deepEqual(projectFolders({ workspace: ws, home }), [path.join(ws, 'projects'), path.join(ws, 'checked'), path.join(home, 'projects')]);
    } finally {
      fs.readFileSync = byPath;
    }
    fs.rmSync(path.join(ws, 'ai_brain', 'workspace.json'));
    // A FIFO in its place: not waited on (it would block the dashboard).
    if (process.platform !== 'win32') {
      spawnSync('mkfifo', [path.join(ws, 'ai_brain', 'workspace.json')]);
      const t = performance.now();
      assert.deepEqual(projectFolders({ workspace: ws, home }), [path.join(ws, 'projects'), path.join(home, 'projects')], 'a FIFO');
      assert.ok(performance.now() - t < 1000);
      fs.rmSync(path.join(ws, 'ai_brain', 'workspace.json'));
    }
    fs.writeFileSync(path.join(ws, 'ai_brain', 'workspace.json'), '{ not json');
    assert.deepEqual(projectFolders({ workspace: ws, home, chosen: 'relative/no' }), [path.join(ws, 'projects'), path.join(home, 'projects')]);
    assert.deepEqual(projectFolders(), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('where the shell\'s folder is not known (a chat), only an absolute target inside the session\'s folder is answered', () => {
  const chat = { ...IN, relative: false };
  assert.equal(plainDelete('rm -rf t1/*/*', chat), false);
  assert.equal(plainDelete(`rm -rf ${PROJECT}/t1/*/*`, chat), true);
  assert.equal(plainDelete(`rm -rf ${PROJECT}/build && rm -rf dist`, chat), false);
});

test('the reader says no to what it does not know', () => {
  for (const command of [
    'rm -rf *', 'rm -rf ./*', 'rm -rf */x', 'rm -rf ?', 'rm -rf t1/..', 'rm -rf t1/../x', 'rm -rf t1/./x', 'rm -rf ././x', 'rm -rf t1//x', 'rm -rf t1/.*/x', 'rm -rf t1/.?',
    `rm -rf ${PROJECT}`, `rm -rf ${PROJECT}/`, `rm -rf ${PROJECT}/*`, `rm -rf ${PROJECT}/../x`, `rm -rf ${PROJECT}x/y`, `rm -rf ${WS}/q/x`, 'rm -rf /etc/x',
    'rm -rf', 'rm -rf --', 'rm -i a', 'rm -rfi a', 'rm --no-preserve-root a', 'rm --interactive=never a', 'rm -rf -x', 'rm -rf -', 'rm -rf ""', "rm ''",
    'rm a & rm b', 'rm a | true', 'rm a || rm b', 'rm a; ', 'rm a;; rm b', '; rm a', 'rm a && ', 'rm "a', "rm 'a", 'rm -rf a2>/dev/null', 'rm a 2>/dev/null 2>/dev/null',
    'rm a || true 2>/dev/null', 'rm a || true || true', 'rm a || true rm b', 'rm a 2> /dev/null', 'rm a >/dev/null', 'rm a 2>&1', 'rm a #x', "rm -rf 'a\tb'",
    'rm "a\'b"', 'rm a\nrm b', 'rm a\rb', 'rm a\u0000', 'rm "$x"', 'rm a b c ~', 'rm build $X', 'echo a; rm b', 'rm a; ls', 'sudo rm a', 'RM a', 'rm', 'rmdir a',
    'git rm -r a', 'rm{,} a', 'rm a{,b}', 'rm [ab]', 'rm a!', 'rm (a)', 'rm a\u00a0b', 'rm a\u2028b', 'rm -rf \\-x', 'rm -rf `x`',
  ]) assert.equal(plainDelete(command, IN), false, JSON.stringify(command));
  for (const bad of [null, undefined, 7, {}, ['rm a']]) assert.equal(plainDelete(bad, IN), false);
  assert.equal(plainDelete(`rm -rf ${'a/'.repeat(997)}b`, IN), false, 'longer than 2,000 characters');
  assert.equal(plainDelete(`rm -rf ${'a/'.repeat(995)}b`, IN), true, 'just under');
});

test('the reader is fast on any input: a 200 KB line and the worst shapes of 2,000 characters take well under 50 ms', () => {
  const shapes = [
    `rm -rf ${'a/'.repeat(100000)}`, `rm -rf ${'~'.repeat(200000)}`, // over the length cap
    `rm -rf ${"'a'".repeat(664)}`, `rm -rf "${'a '.repeat(995)}`, `rm ${'a '.repeat(995)}`, `rm a${'; rm a'.repeat(330)}`, `rm a${' && rm a'.repeat(220)}`,
    `rm a${' 2>/dev/null || true; rm a'.repeat(70)}`, `rm -rf ${'t/*'.repeat(660)}`, `rm ${"''".repeat(995)}`, `rm -${'r'.repeat(1990)} a`,
    `rm a ${'>/dev/null      '.repeat(120)}`,
  ];
  for (const command of shapes) {
    const t = performance.now();
    for (let i = 0; i < 10; i++) plainDelete(command, IN);
    const ms = (performance.now() - t) / 10;
    assert.ok(ms < 50, `${command.slice(0, 30)}…: ${ms.toFixed(2)} ms`);
  }
});

// ---------- the property test ----------

// Building blocks of lines, each marked plain (the reader may answer a line made only of plain blocks) or not.
// A fixed seed: the same ten thousand lines every run.
const rnd = (n) => Math.floor(rand() * n);
let seed = 20261117;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[rnd(list.length)];

function blocks(base, box, proj) {
  const P = (...xs) => xs.map((x) => [x, true]);
  const N = (...xs) => xs.map((x) => [x, false]);
  return {
    before: [...P('', '', '', ''), ...N('timeout 5 ', 'stdbuf -o0 ', 'sudo ', 'env ', 'X=1 ', 'command ', 'exec ', 'nice ', 'cd .. && ', 'cd / ; ', 'cd ~ && ', 'cd t1 && ', 'eval ', 'bash -c ', '( ', '{ ', '! ')],
    name: [...P('rm', 'rm', 'rm'), ...N("r''m", '"r"m', 'r\\m', '\\rm', '/bin/rm', '$R', 'RM', 'rm\\', "'rm'", 'rmdir', 'git rm', 'echo rm')],
    option: [...P('-rf', '-r', '-f', '-rfv', '-fr', '-R', '--force', '--recursive', '', ''), ...N('-i', '--no-preserve-root', '-I', '-rf=', '-x', '--preserve-root=all', '-')],
    target: [
      ...P('dist', 't1/*/*', 'node_modules', '"my dir"', "'a b'/c", 'dist/', './dist', './t1/*', 't1/?', 'd"is"t', 'a,b', 'x=y', 'n@m+1:2%', `${proj}/dist`, `${proj}/t1/*/*`, `"${proj}/my dir"`, 'lnk'),
      // On disk (plainOnDisk): a folder that holds a repository, and a link that leads out of the folder.
      ...N('nested', 'nested/*', 'nested/*/*', './nested/inner', `${proj}/nested/*`, 'lnk/marker-beside', 'lnk/*', 'lnk/', `${proj}/lnk/*`),
      ...N('.', '..', '*', './*', '?', '*/x', '~', '~/x', '$HOME', '$DIR', '"$DIR"/*', '$(pwd)', '`pwd`', '${X:-.}', '../marker-beside', 't1/../..', 't1/.*/..', 't1/.*/.*',
        '/', '/*', proj, `${proj}/`, `${proj}/*`, `${proj}/..`, `${proj}/./..`, box, `${box}/marker-beside`, `${base}/marker-above`, '.*', 't1/.*', '..?', '{a,..}', '[.][.]',
        'x\\ ..', '"..', "'.'", '""', 'a\\', `${proj}x`, `${proj}//x`, '~+', '-- ..', 't1/../../marker-beside', `"${box}"/*`, '$1', '!$', '%1/..'),
    ],
    end: [...P('', '', '', ' 2>/dev/null', ' >/dev/null 2>&1', ' || true', ' 2>/dev/null || true'), ...N(' > x', ' >/dev/null', ' # c', ' 2>&1', ' || rm -rf ..', ' | true', ' &', ')', ' }')],
    sep: [...P(' && ', '; ', ' ;', '&&'), ...N(' | ', ' & ', '\n', ' || ', ' ;; ', '\\\n', ' && cd .. && ')],
  };
}

function line(b) {
  let plain = true;
  // A plain block most of the time, so that enough whole lines come out plain; a dangerous one otherwise.
  const take = (list) => {
    const want = rand() < 0.85;
    const [text, ok] = pick(list.filter(([, k]) => k === want));
    plain &&= ok;
    return text;
  };
  const cmds = [];
  for (let c = 1 + rnd(3); c > 0; c--) {
    const words = [take(b.before) + take(b.name)];
    for (let o = rnd(3); o > 0; o--) words.push(take(b.option));
    for (let t = 1 + rnd(3); t > 0; t--) words.push(take(b.target));
    cmds.push(words.filter(Boolean).join(' ') + take(b.end));
  }
  let text = cmds[0];
  for (const c of cmds.slice(1)) text += take(b.sep) + c;
  return { text, plain };
}

test('ten thousand random lines from the dangerous building blocks: exactly the plain ones are answered, and none of those deletes a marker beside or above the folder or in a nested repository', { skip: process.platform === 'win32' && 'needs a POSIX shell and rm' }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-plain-')));
  try {
    const box = path.join(base, 'box');
    const proj = path.join(box, 'proj');
    const b = blocks(base, box, proj);
    // The tree the lines are judged against, laid out as each run's copy (runLines).
    for (const d of ['t1/a', 'dist', 'node_modules', 'my dir', 'a b', 'nested/inner/.git']) fs.mkdirSync(path.join(proj, d), { recursive: true });
    fs.symlinkSync(box, path.join(proj, 'lnk'));
    const places = { home: HOME, workspace: WS, cwd: proj };
    const answered = [];
    for (let i = 0; i < 10000; i++) {
      const { text, plain } = line(b);
      const yes = plainDelete(text, places);
      assert.equal(yes, plain, `${yes ? 'answered although not plain' : 'plain but not answered'}: ${JSON.stringify(text)}`);
      if (yes) answered.push(text);
    }
    assert.ok(answered.length > 1000, `enough answered lines to run: ${answered.length}`);
    // Every answered line runs with the real rm, in a fresh tree each time, from the folder it was judged for: four
    // shells side by side, each with its own tree laid out the same way (base/marker-above, box/marker-beside, box/proj).
    const shards = [0, 1, 2, 3].map((n) => answered.filter((_, i) => i % 4 === n));
    const outs = await Promise.all(shards.map((lines, n) => runLines(lines, path.join(base, `s${n}`), { base, box, proj })));
    assert.deepEqual(outs.flatMap((o) => o.split('\n').filter((l) => l.startsWith('REMOVED'))), [], 'no marker was removed');
    assert.equal(outs.reduce((sum, o) => sum + Number(/ran (\d+)/.exec(o)[1]), 0), answered.length);
    process.stdout.write(`# property: 10000 lines tried, ${answered.length} answered and run with the real rm, 0 markers removed\n`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const q = (p) => `'${p.replace(/'/g, "'\\''")}'`;

// Runs each line from its own copy of the tree under `root` (what a line before removed is made again, markers too, a
// repository nested in the folder and a link that leads out of it); the lines name the paths of `at` (the tree they
// were judged for), which are moved to the copy by text. Prints "REMOVED: line" for a line after which a marker is gone.
function runLines(lines, root, at) {
  const box = path.join(root, 'box');
  const proj = path.join(box, 'proj');
  const moved = lines.map((l) => l.split(at.base).join(root));
  const script = [
    'n=0; while IFS= read -r L; do',
    `  mkdir -p ${q(proj)}/t1/a ${q(proj)}/dist ${q(proj)}/node_modules ${q(proj)}/"my dir" ${q(proj)}/"a b" ${q(proj)}/nested/inner/.git`,
    `  : > ${q(root)}/marker-above; : > ${q(box)}/marker-beside; : > ${q(proj)}/t1/a/f; : > ${q(proj)}/nested/inner/.git/marker-repo`,
    `  [ -L ${q(proj)}/lnk ] || ln -s ${q(box)} ${q(proj)}/lnk`,
    `  (cd ${q(proj)} && eval "$L") </dev/null >/dev/null 2>&1`,
    `  if [ ! -e ${q(root)}/marker-above ] || [ ! -e ${q(box)}/marker-beside ] || [ ! -e ${q(proj)}/nested/inner/.git/marker-repo ]; then echo "REMOVED: $L"; fi`,
    '  n=$((n+1)); done; echo "ran $n"',
  ].join('\n');
  fs.mkdirSync(root, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn('bash', ['--norc', '--noprofile', '-c', script], { env: { PATH: process.env.PATH, HOME: path.join(root, 'nohome'), LC_ALL: 'C.UTF-8' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`bash ended with ${code}`))));
    p.stdin.end(moved.join('\n') + '\n');
  });
}
