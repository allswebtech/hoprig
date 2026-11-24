// The one thing Hoprig answers by itself in bypass mode (src/asking.mjs plainDelete): a command line that is plainly a
// delete inside the folder it runs in. An allow-list read by a strict reader: these tests hold it to "no" for every
// spelling of a delete Claude Code stops for that is not plainly inside, and to "yes" for the ordinary ones.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sealed } from './seal.mjs';

const { bypassAllows, plainDelete, projectFolders } = await import('../src/asking.mjs');
const D = await import('./fixtures/deletes.mjs');
const { SHARE, scaled } = await import('./plainjudge.mjs');

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

test('the shell must stand in the session\'s own folder: in another folder the session was given (a need, "Also open", an added folder) no delete is plain', () => {
  const OWN = PROJECT;
  const OTHER = '/home/alex/Workspace/blog';
  const NEED = '/home/alex/Workspace/kits/parts';
  for (const command of ['rm -rf build', 'rm -rf src', 'rm -f a.txt', 'rm -rf dist/*']) {
    // In its own folder, and below it: as before.
    for (const cwd of [OWN, `${OWN}/web`]) {
      assert.equal(plainDelete(command, { ...IN, cwd, own: OWN }), true, `${command} in ${cwd}`);
      assert.equal(bypassAllows({ mode: 'bypassPermissions', tool: 'Bash', input: { command }, places: { ...IN, cwd, own: OWN } }), true, `${command} in ${cwd}`);
    }
    // The shell stands in another project, in a need, beside or above the session's folder: the owner's to answer.
    for (const cwd of [OTHER, NEED, `${OTHER}/web`, `${OWN}-old`, WS]) {
      assert.equal(plainDelete(command, { ...IN, cwd, own: OWN }), false, `${command} in ${cwd}`);
      assert.equal(bypassAllows({ mode: 'bypassPermissions', tool: 'Bash', input: { command }, places: { ...IN, cwd, own: OWN } }), false, `${command} in ${cwd}`);
    }
    // The caller should know where the session was started and does not: nothing is plain. A caller that does not say
    // (undefined) is read as before.
    assert.equal(plainDelete(command, { ...IN, own: null }), false, command);
    assert.equal(plainDelete(command, { ...IN, own: '' }), false, command);
    assert.equal(plainDelete(command, { ...IN, own: 'relative/p' }), false, command);
    assert.equal(plainDelete(command, { ...IN }), true, command);
  }
  // A folder that only differs in case may be the same one: compared as the other folders are.
  assert.equal(plainDelete('rm -rf build', { ...IN, cwd: PROJECT, own: PROJECT.toUpperCase() }), true);
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

test('Hoprig\'s own config and state folders are never a plain delete, wherever the shell stands: a bypass session cannot remove its run record, the hook settings or the config', () => {
  const cfg = '/home/alex/.config/hoprig';
  const state = '/home/alex/.local/state/hoprig';
  const hoprig = [cfg, state];
  for (const [cwd, command] of [
    [cfg, 'rm config.json'],
    [cfg, 'rm -rf profiles'],
    [path.join(state, 'runs'), 'rm -f run-abc.json'],
    [path.join(state, 'hook-settings'), 'rm -f run-abc.json'],
    [state, 'rm -rf runs hook-settings'],
    [path.join(state, 'runs', 'sub'), 'rm -rf x'],
    // From a folder above one of them a target can name it.
    ['/home/alex/.config', 'rm -rf hoprig'],
    ['/home/alex/.config', 'rm hoprig/config.json'],
    ['/home/alex/.config', `rm ${cfg}/config.json`],
    ['/home/alex/.local/state', 'rm -rf hoprig'],
    ['/home/alex/.local/state', 'rm -f hoprig/runs/run-abc.json'],
    ['/home/alex/.local', 'rm -rf state/hoprig/hook-settings'],
  ]) {
    assert.equal(plainDelete(command, { ...IN, hoprig, cwd }), false, `${command} in ${cwd}`);
    assert.equal(bypassAllows({ mode: 'bypassPermissions', tool: 'Bash', input: { command }, places: { ...IN, hoprig, cwd } }), false, `${command} in ${cwd}`);
  }
  // The rule is a path boundary, not a string prefix: a folder that merely begins with the same letters may hold one.
  assert.equal(plainDelete('rm -rf dist', { ...IN, hoprig, cwd: '/home/alex/.config/hoprigx' }), true);
  assert.equal(plainDelete('rm -rf dist', { ...IN, hoprig, cwd: '/home/alex/.conf' }), true);
  // A folder beside them (not above, not below) is unchanged.
  assert.equal(plainDelete('rm -rf dist', { ...IN, hoprig, cwd: '/home/alex/.config/other' }), true);
  // Config and state in folders of their own (a container's HOPRIG_STATE_DIR=/srv/data/state): the folder that holds them.
  const own = ['/srv/data/config', '/srv/data/state'];
  for (const command of ['rm -rf state', 'rm -rf config/profiles', 'rm -f state/runs/run-abc.json']) {
    assert.equal(plainDelete(command, { ...IN, hoprig: own, cwd: '/srv/data' }), false, command);
  }
  assert.equal(plainDelete('rm -rf dist', { ...IN, hoprig: own, cwd: '/srv/app' }), true);
  // And an ordinary folder that is none of Hoprig's own is unchanged.
  assert.equal(plainDelete('rm -rf dist', { ...IN, hoprig, cwd: '/srv/app' }), true);
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

test('a disk that tells neither case nor normal form (macOS): a git folder in any case, a home folder in any normal form', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-caseblind-')));
  try {
    // There git asks for HEAD and gets head: a folder with head and Objects is a bare repository.
    fs.mkdirSync(path.join(base, 'code', 'mirror', 'Objects'), { recursive: true });
    fs.writeFileSync(path.join(base, 'code', 'mirror', 'head'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(base, 'code', 'wt'), { recursive: true });
    for (const f of ['Head', 'CommonDir']) fs.writeFileSync(path.join(base, 'code', 'wt', f), '');
    for (const command of ['rm -rf code', 'rm -rf code/*', 'rm -rf code/mirror', 'rm -rf code/wt']) assert.equal(plainDelete(command, { ...IN, cwd: base }), false, command);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  // A home folder written with é as one sign, the shell's folder with e and an accent: the same folder there.
  const nfc = '/home/josé';
  const nfd = '/home/josé';
  for (const [home, cwd] of [[nfc, nfd], [nfd, nfc], [nfc, `${nfd}/Workspace`.toUpperCase()]]) {
    assert.equal(plainDelete('rm -rf dist', { home, workspace: `${home}/Workspace`, cwd }), false, JSON.stringify([home, cwd]));
  }
  assert.equal(plainDelete('rm -rf dist', { home: nfc, workspace: `${nfc}/Workspace`, cwd: `${nfd}/Workspace/p` }), true, 'a project inside');
});

test('a word that begins with - after a target is no plain delete: BSD rm (macOS) deletes it as a name, GNU rm reads it as an option', { skip: process.platform === 'win32' && 'needs rm' }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-lateopt-')));
  try {
    const proj = path.join(base, 'proj');
    // A folder named like an option that holds a repository, beside ordinary folders.
    for (const d of ['-rf/shop/.git', '-x/cache', 'build', 'out']) fs.mkdirSync(path.join(proj, d), { recursive: true });
    const at = (command) => plainDelete(command, { ...IN, cwd: proj });
    for (const command of ['rm -r build -rf', 'rm -rf build "-rf"', "rm -rf out '-rf' build", 'rm build -- -rf', 'rm -rf build -- -x', 'rm -R build/* -rf out/*', 'rm -rf build -f', 'rm -rf build -']) {
      assert.equal(at(command), false, command);
    }
    // After --, a name that begins with - is a target on every rm, and judged like any other.
    assert.equal(at('rm -rf -- -rf'), false, 'holds a repository');
    assert.equal(at('rm -rf -- -x build'), true);
    assert.equal(at('rm -rf -- build -x'), true);
    // Which reading the rm of this computer takes is shown, not assumed: either way the rule above holds.
    const r = spawnSync('rm', ['-r', 'build', '-rf'], { cwd: proj, encoding: 'utf8' });
    const took = fs.existsSync(path.join(proj, '-rf')) ? 'an option (GNU)' : 'a name (BSD)';
    process.stdout.write(`# this rm read a -rf after a target as ${took}${r.stderr ? `: ${r.stderr.trim()}` : ''}\n`);
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

// A unit of work to measure the computer by, in this process and at this moment (a CI runner is slower, and slower still
// while other tests run beside it): what the reader does per character, over an ordinary line of 2,000 characters,
// and 1,000 looks at a path that is not there (what the look does per target). About 6 ms on a desktop of 2026.
function unit(dir) {
  const t = performance.now();
  const line = 'rm -rf dist/a b/c '.repeat(111);
  let n = 0;
  for (const c of line) n += /^[\p{L}\p{Nd}._\-/*?@+,=:%]$/u.test(c) ? 1 : 0;
  for (let i = 0; i < 1000; i++) {
    try {
      fs.statSync(path.join(dir, `none${i}`));
    } catch {
      n++;
    }
  }
  return n ? performance.now() - t : 0;
}

test('the reader is fast on any input: a 200 KB line and the worst shapes of 2,000 characters take well under ten units of work (50 ms on a desktop)', (t) => {
  // Its folders lie in the temporary folder and do not exist: on macOS /home is an automounter's folder, where every
  // look at a missing path asks the automounter (milliseconds each), and this test took six minutes there.
  const base = path.join(fs.realpathSync(os.tmpdir()), `hoprig-reader-${process.pid}`, 'home', 'alex');
  const here = { home: base, workspace: path.join(base, 'Workspace'), cwd: path.join(base, 'Workspace', 'p') };
  if (process.platform === 'darwin') {
    const look = (dir) => {
      const s = performance.now();
      for (let i = 0; i < 50; i++) fs.existsSync(path.join(dir, `none${i}`));
      return ((performance.now() - s) / 50).toFixed(3);
    };
    t.diagnostic(`a look at a missing path: ${look(PROJECT)} ms under /home, ${look(here.cwd)} ms in the temporary folder`);
  }
  const shapes = [
    `rm -rf ${'a/'.repeat(100000)}`, `rm -rf ${'~'.repeat(200000)}`, // over the length cap
    `rm -rf ${"'a'".repeat(664)}`, `rm -rf "${'a '.repeat(995)}`, `rm ${'a '.repeat(995)}`, `rm a${'; rm a'.repeat(330)}`, `rm a${' && rm a'.repeat(220)}`,
    `rm a${' 2>/dev/null || true; rm a'.repeat(70)}`, `rm -rf ${'t/*'.repeat(660)}`, `rm ${"''".repeat(995)}`, `rm -${'r'.repeat(1990)} a`,
    `rm a ${'>/dev/null      '.repeat(120)}`,
  ];
  // The bound is ten units, measured around each shape (the larger of the two): 50 ms or so on a desktop, and as much
  // more as the computer is slower at that moment. The worst shape takes under two units.
  unit(here.cwd);
  for (const command of shapes) {
    const before = unit(here.cwd);
    const start = performance.now();
    for (let i = 0; i < 10; i++) plainDelete(command, here);
    const ms = (performance.now() - start) / 10;
    const u = Math.max(before, unit(here.cwd));
    assert.ok(ms < 10 * u, `${command.slice(0, 30)}…: ${ms.toFixed(2)} ms, ${(ms / u).toFixed(1)} units of ${u.toFixed(2)} ms (bound 10) on ${process.platform}`);
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
    // A word that begins with - after the first target: BSD rm takes it as a name (a folder -rf holds a repository).
    if (rand() < 0.06) {
      words.splice(words.findIndex((w, i) => i > 0 && !b.option.some(([o]) => o === w)) + 1, 0, pick(['-rf', '-r', '--', '-f', '"-rf"']));
      plain = false;
    }
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
    for (const d of ['t1/a', 'dist', 'node_modules', 'my dir', 'a b', 'nested/inner/.git', '-rf/inner/.git']) fs.mkdirSync(path.join(proj, d), { recursive: true });
    fs.symlinkSync(box, path.join(proj, 'lnk'));
    const places = { home: HOME, workspace: WS, cwd: proj };
    const answered = [];
    const LINES = scaled(10000);
    const wrong = [];
    for (let i = 0; i < LINES; i++) {
      const { text, plain } = line(b);
      const yes = plainDelete(text, places);
      if (yes !== plain) wrong.push(`${yes ? 'answered although not plain' : 'plain but not answered'}: ${JSON.stringify(text)}`);
      if (yes) answered.push(text);
    }
    // Every line judged wrongly is said before the assertion (a log then shows all of them, not only the first).
    if (wrong.length) process.stdout.write(`${wrong.map((w) => `# ${w}`).join('\n')}\n`);
    assert.deepEqual(wrong, []);
    assert.ok(answered.length > LINES / 10, `enough answered lines to run: ${answered.length}`);
    // Every answered line runs with the real rm, in a fresh tree each time, from the folder it was judged for: four
    // shells side by side, each with its own tree laid out the same way (base/marker-above, box/marker-beside, box/proj).
    const shards = [0, 1, 2, 3].map((n) => answered.filter((_, i) => i % 4 === n));
    const outs = await Promise.all(shards.map((lines, n) => runLines(lines, path.join(base, `s${n}`), { base, box, proj })));
    const removed = outs.flatMap((o) => o.split('\n').filter((l) => l.startsWith('REMOVED')));
    if (removed.length) process.stdout.write(`${removed.map((l) => `# ${l}`).join('\n')}\n`); // all of them, before the assertion
    assert.deepEqual(removed, [], 'no marker was removed');
    assert.equal(outs.reduce((sum, o) => sum + Number(/ran (\d+)/.exec(o)[1]), 0), answered.length);
    process.stdout.write(`# property on ${process.platform}${SHARE < 1 ? ` (${SHARE} of the full size, a CI runner)` : ''}: ${LINES} lines tried, ${answered.length} answered and run with the real rm, 0 markers removed\n`);
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
    `  mkdir -p ${q(proj)}/t1/a ${q(proj)}/dist ${q(proj)}/node_modules ${q(proj)}/"my dir" ${q(proj)}/"a b" ${q(proj)}/nested/inner/.git ${q(proj)}/-rf/inner/.git`,
    `  : > ${q(root)}/marker-above; : > ${q(box)}/marker-beside; : > ${q(proj)}/t1/a/f; : > ${q(proj)}/nested/inner/.git/marker-repo; : > ${q(proj)}/-rf/inner/.git/marker-repo`,
    `  [ -L ${q(proj)}/lnk ] || ln -s ${q(box)} ${q(proj)}/lnk`,
    `  (cd ${q(proj)} && eval "$L") </dev/null >/dev/null 2>&1`,
    `  if [ ! -e ${q(root)}/marker-above ] || [ ! -e ${q(box)}/marker-beside ] || [ ! -e ${q(proj)}/nested/inner/.git/marker-repo ] || [ ! -e ${q(proj)}/-rf/inner/.git/marker-repo ]; then echo "REMOVED: $L"; fi`,
    '  n=$((n+1)); done; echo "ran $n"',
  ].join('\n');
  fs.mkdirSync(root, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn('bash', ['--norc', '--noprofile', '-c', script], { env: sealed({ PATH: process.env.PATH, HOME: path.join(root, 'nohome'), LC_ALL: 'C.UTF-8' }) });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`bash ended with ${code}`))));
    p.stdin.end(moved.join('\n') + '\n');
  });
}
