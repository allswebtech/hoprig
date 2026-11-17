// Project workspaces with real git in a scratch folder: the template, the manifest (and understanding a project
// without one), memory links (never losing a file), and sync (fast-forward and push only).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcsetup-ws-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
// The scratch git settings, as ~/.gitconfig of the scratch home: git older than 2.32 (Debian 11) does not know
// GIT_CONFIG_GLOBAL and would find no name and e-mail to commit with.
const gitcfg = path.join(home, '.gitconfig');
const remotes = path.join(tmp, 'remotes');
fs.mkdirSync(remotes);
// "https://git.test/<owner>/<repo>.git" goes to a bare repository in the scratch folder, so the addresses look
// like a real host's and pass the validators, but nothing leaves this computer.
fs.writeFileSync(gitcfg, `[user]\n\tname = Test Dev\n\temail = dev@example.com\n[init]\n\tdefaultBranch = main\n[url "${remotes}/"]\n\tinsteadOf = https://git.test/\n[protocol "file"]\n\tallow = always\n`);
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', HOME: home, HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state') });
const W = await import('../../src/pcsetup/workspace.mjs');
const { cloneRepo } = await import('../../src/pcsetup/projects.mjs');

const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const bare = (name) => {
  const d = path.join(remotes, 'team', `${name}.git`);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', d]);
  return `https://git.test/team/${name}.git`;
};

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('manifest validator refuses paths out of the project, bad addresses and unknown keys', () => {
  const ok = { name: 'shop', repos: [{ dir: 'code/shop-web', url: 'https://github.com/o/shop-web.git' }], memories: { '.': 'ai_brain/claude-memory' } };
  assert.equal(W.validateManifest(ok).ok, true);
  for (const bad of [
    { ...ok, extra: 1 }, { ...ok, name: '../x' }, { ...ok, repos: [{ dir: '../evil', url: ok.repos[0].url }] }, { ...ok, repos: [{ dir: '/etc', url: ok.repos[0].url }] },
    { ...ok, repos: [{ dir: 'code/x', url: 'file:///etc' }] }, { ...ok, repos: [{ dir: 'code/x', url: ok.repos[0].url, branch: '--force' }] },
    { ...ok, memories: { '.': '../../.ssh' } }, { ...ok, memories: { '/abs': 'ai_brain/m' } }, { ...ok, repos: [{ dir: 'no-ai/x', url: ok.repos[0].url }] },
  ]) assert.equal(W.validateManifest(bad).ok, false, JSON.stringify(bad));
});

test('templates: placeholders in names and text; nothing may land outside the project; no links out', () => {
  const dest = path.join(tmp, 'tpl-out', 'acme');
  W.writeTemplate(dest, [...W.builtinFiles(), { rel: 'docs/{{project}}.md', kind: 'file', data: 'About {{Project}}' }], 'acme');
  assert.match(fs.readFileSync(path.join(dest, 'AGENTS.md'), 'utf8'), /^# Acme/);
  assert.equal(fs.readFileSync(path.join(dest, 'docs/acme.md'), 'utf8'), 'About Acme');
  assert.equal(fs.readFileSync(path.join(dest, 'code/.gitignore'), 'utf8'), '*\n!.gitignore\n');
  assert.match(fs.readFileSync(path.join(dest, '.gitignore'), 'utf8'), /^\/code\/\*\n!\/code\/.gitignore/);
  assert.throws(() => W.writeTemplate(dest, [], 'acme'), /already exists/);
  assert.throws(() => W.writeTemplate(path.join(tmp, 'tpl-out', 'b'), [{ rel: '../escape.txt', kind: 'file', data: 'x' }], 'b'), /outside the project/);
  assert.throws(() => W.writeTemplate(path.join(tmp, 'tpl-out', 'c'), [{ rel: '{{project}}/../../x', kind: 'file', data: 'x' }], '..'), /outside the project/);
  const src = path.join(tmp, 'tpl-src');
  fs.mkdirSync(path.join(src, 'no-ai'), { recursive: true });
  fs.writeFileSync(path.join(src, 'no-ai', 'private.md'), 'never read');
  fs.writeFileSync(path.join(src, 'README.md'), '# {{project}}');
  fs.symlinkSync('README.md', path.join(src, 'inside-link'));
  const files = W.readTemplate(src);
  assert.deepEqual(files.map((f) => f.rel).sort(), ['README.md', 'inside-link']);
  fs.symlinkSync('/etc/passwd', path.join(src, 'evil'));
  assert.throws(() => W.readTemplate(src), /points outside the template/);
});

test('memory links: a real folder\'s files are merged in (never overwritten), the old folder kept; then already / conflict', () => {
  const root = path.join(tmp, 'memproj');
  fs.mkdirSync(path.join(root, 'ai_brain', 'claude-memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ai_brain', 'claude-memory', 'a.md'), 'repo version');
  const base = path.join(tmp, 'claude');
  const slug = root.replace(/[^A-Za-z0-9]/g, '-');
  const local = path.join(base, 'projects', slug, 'memory');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'a.md'), 'local version');
  fs.writeFileSync(path.join(local, 'b.md'), 'only local');
  const now = new Date('2026-11-14T10:20:30Z');
  const r = W.linkMemories(root, { '.': 'ai_brain/claude-memory' }, { base, now });
  assert.match(r[0].done, /moved 2 files in, then linked/);
  assert.equal(fs.readlinkSync(local), path.join(root, 'ai_brain', 'claude-memory'));
  assert.equal(fs.readFileSync(path.join(root, 'ai_brain/claude-memory/a.md'), 'utf8'), 'repo version');
  assert.equal(fs.readFileSync(path.join(root, 'ai_brain/claude-memory/a.from-20261114-102030.md'), 'utf8'), 'local version');
  assert.equal(fs.readFileSync(path.join(root, 'ai_brain/claude-memory/b.md'), 'utf8'), 'only local');
  assert.equal(fs.readFileSync(`${local}.backup-20261114-102030/a.md`, 'utf8'), 'local version');
  assert.equal(W.linkMemories(root, { '.': 'ai_brain/claude-memory' }, { base })[0].done, 'already');
  fs.unlinkSync(local);
  fs.symlinkSync(tmp, local);
  const c = W.linkMemories(root, { '.': 'ai_brain/claude-memory' }, { base })[0];
  assert.equal(c.done, 'conflict');
  assert.equal(fs.readlinkSync(local), tmp); // left alone
});

test('a project without project.json is understood from its folders and ai_brain/claude-memory.json', async () => {
  const root = path.join(tmp, 'legacy');
  fs.mkdirSync(path.join(root, 'ai_brain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ai_brain', 'claude-memory.json'), JSON.stringify({ note: 'kept', memories: { '.': 'ai_brain/claude-memory', 'code/legacy-web': 'ai_brain/claude-memory-web' } }));
  sh(tmp, 'init', '-q', root);
  for (const n of ['legacy-web', 'legacy-app']) {
    const d = path.join(root, 'code', n);
    fs.mkdirSync(d, { recursive: true });
    sh(tmp, 'init', '-q', d);
    sh(d, 'remote', 'add', 'origin', `https://x-access-token:secret@github.com/team/${n}.git`);
  }
  fs.mkdirSync(path.join(root, 'code', 'no-ai'), { recursive: true });
  const m = await W.readManifest(root);
  assert.equal(m.source, 'found');
  assert.deepEqual(m.manifest.repos, [{ dir: 'code/legacy-app', url: 'https://github.com/team/legacy-app.git' }, { dir: 'code/legacy-web', url: 'https://github.com/team/legacy-web.git' }]);
  assert.deepEqual(m.manifest.memories, { '.': 'ai_brain/claude-memory', 'code/legacy-web': 'ai_brain/claude-memory-web' });
  assert.ok(!JSON.stringify(m).includes('secret'));
  // Writing the manifest keeps the owner's file and its other keys.
  W.writeManifest(root, { ...m.manifest, memories: { '.': 'ai_brain/claude-memory' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'ai_brain/claude-memory.json'), 'utf8')), { note: 'kept', memories: { '.': 'ai_brain/claude-memory' } });
  assert.deepEqual(W.listWorkspaces(tmp), [root]);
});

test('end to end: new project + child pushed; cloned elsewhere; memory written on one side shows on the other after sync', async () => {
  const A = path.join(tmp, 'A');
  const B = path.join(tmp, 'B');
  const parentUrl = bare('shop');
  const childUrl = bare('shop-web');
  // side A: the project from the built-in template, one code repository, both pushed
  const root = W.writeTemplate(path.join(A, 'shop'), W.builtinFiles(), 'shop');
  const child = path.join(root, 'code', 'shop-web');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'index.js'), '');
  assert.deepEqual(await W.initRepo(child, 'Start shop-web'), { ok: true });
  sh(child, 'remote', 'add', 'origin', childUrl);
  sh(child, 'push', '-q', '-u', 'origin', 'main');
  W.writeManifest(root, { name: 'shop', repos: [{ dir: 'code/shop-web', url: childUrl }], memories: { '.': 'ai_brain/claude-memory' } });
  assert.deepEqual(await W.initRepo(root, 'Start shop'), { ok: true });
  assert.equal(sh(root, 'ls-files', 'code'), 'code/.gitignore'); // the child is not in the parent
  sh(root, 'remote', 'add', 'origin', parentUrl);
  sh(root, 'push', '-q', '-u', 'origin', 'main');
  const baseA = path.join(tmp, 'claudeA');
  W.linkMemories(root, { '.': 'ai_brain/claude-memory' }, { base: baseA });

  // side B: the parent, then every child from the manifest, then the memory link
  const c = await cloneRepo({ url: parentUrl, name: 'shop' }, B, {});
  assert.equal(c.ok, true);
  const rootB = c.dest;
  const { manifest, source } = await W.readManifest(rootB);
  assert.equal(source, 'project.json');
  for (const r of manifest.repos) assert.equal((await cloneRepo({ url: r.url, name: path.basename(r.dir) }, path.dirname(path.join(rootB, r.dir)), {})).ok, true);
  assert.ok(fs.existsSync(path.join(rootB, 'code/shop-web/index.js')));
  const baseB = path.join(tmp, 'claudeB');
  W.linkMemories(rootB, manifest.memories, { base: baseB });

  // Claude on side A writes a memory; sync --memory commits only that and pushes; side B pulls it
  const memA = path.join(baseA, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  fs.writeFileSync(path.join(memA, 'user_prefs.md'), 'prefers small commits');
  fs.writeFileSync(path.join(root, 'notes-not-memory.md'), 'not to be committed');
  const sA = await W.syncWorkspace(root, { memory: true });
  assert.deepEqual(sA.memory, { committed: true });
  assert.deepEqual(sA.repos[0].did, ['pushed 1']);
  assert.equal(sh(root, 'status', '--porcelain'), '?? notes-not-memory.md'); // only the memory was committed
  const sB = await W.syncWorkspace(rootB);
  assert.deepEqual(sB.repos[0].did, ['pulled 1']);
  const memB = path.join(baseB, 'projects', rootB.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  assert.equal(fs.readFileSync(path.join(memB, 'user_prefs.md'), 'utf8'), 'prefers small commits');

  // both sides moved: never merged or rebased by itself, the command is given
  fs.writeFileSync(path.join(root, 'decisions.md'), 'A');
  sh(root, 'commit', '-qam', 'A');
  sh(root, 'push', '-q');
  fs.writeFileSync(path.join(rootB, 'docs', 'README.md'), 'B');
  sh(rootB, 'commit', '-qam', 'B');
  const head = sh(rootB, 'rev-parse', 'HEAD');
  const d = await W.syncRepo(rootB, '.');
  assert.deepEqual(d.did, []);
  assert.match(d.todo[0].why, /both moved \(1 ahead, 1 behind\)/);
  assert.match(d.todo[0].command, /pull --rebase/);
  assert.equal(sh(rootB, 'rev-parse', 'HEAD'), head);

  const st = await W.workspaceState(rootB);
  assert.deepEqual(st.repos.map((r) => [r.rel, r.ok, r.ahead, r.behind]), [['.', true, 1, 1], ['code/shop-web', true, 0, 0]]);
});

test('project names and specs', () => {
  assert.deepEqual(W.parseProjectSpec('shop'), { name: 'shop' });
  assert.deepEqual(W.parseProjectSpec('team/shop'), { url: 'https://github.com/team/shop.git', owner: 'team', name: 'shop' });
  assert.equal(W.parseProjectSpec('../x'), null);
  assert.equal(W.parseProjectSpec('file:///x'), null);
});

test('status never looks into a private folder (no-ai, ignore, ai-ignore-dir) and takes no lock', async () => {
  const root = path.join(tmp, 'private');
  fs.mkdirSync(path.join(root, 'no-ai'), { recursive: true });
  fs.mkdirSync(path.join(root, 'code', 'x', 'ai-ignore-dir'), { recursive: true });
  sh(tmp, 'init', '-q', root);
  fs.writeFileSync(path.join(root, 'no-ai', 'notes.md'), 'private');
  fs.writeFileSync(path.join(root, 'code', 'x', 'ai-ignore-dir', 'n.md'), 'private');
  fs.writeFileSync(path.join(root, 'visible.md'), 'x');
  // Installed packages that .gitignore does not cover are left out as well, as the code editor leaves them out.
  fs.mkdirSync(path.join(root, 'web', 'node_modules', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'node_modules', 'lib', 'a.js'), 'x');
  fs.writeFileSync(path.join(root, 'web', 'node_modules', 'lib', 'b.js'), 'x');
  const s = await W.repoInfo(root);
  assert.equal(s.changes, 1); // only visible.md
  const { STATUS_ARGS } = await import('../../src/pcsetup/projects.mjs');
  const { readCommand } = await import('../../src/gitread.mjs');
  const fold = process.platform === 'darwin' || process.platform === 'win32' ? ',icase' : '';
  assert.deepEqual(STATUS_ARGS.slice(-4), ['no-ai', 'ignore', 'ai-ignore-dir', 'node_modules'].map((d) => `:(exclude,glob${fold})**/${d}/**`));
  assert.equal((await readCommand(root, STATUS_ARGS)).env.GIT_OPTIONAL_LOCKS, '0');
});

test('project new without a git name and e-mail stops before anything is written', async () => {
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const pathx = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { binFile } = await import('../../src/paths.mjs');
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'hop-noid-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: pathx.join(home, 'cfg'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: pathx.join(home, 'gitconfig'),
    HOPRIG_CONFIG_DIR: pathx.join(home, 'c'), HOPRIG_STATE_DIR: pathx.join(home, 's'), CLAUDE_CONFIG_DIR: pathx.join(home, 'claude') };
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[k];
  const r = spawnSync(process.execPath, [binFile(), 'project', 'new', 'shop', '--no-github'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /git config --global user\.name/);
  for (const where of [['projects'], ['Workspace', 'projects']]) assert.equal(fsx.existsSync(pathx.join(home, ...where, 'shop')), false, 'no half-made project folder is left behind');
  fsx.rmSync(home, { recursive: true, force: true });
});

test('useHooks turns on .githooks when the repository has that folder and no hooks path of its own', async () => {
  const dir = path.join(tmp, 'hooks-repo');
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  sh(tmp, 'init', '-q', '-b', 'main', dir);
  assert.equal(await W.useHooks(dir), true);
  assert.equal(sh(dir, 'config', '--local', '--get', 'core.hooksPath'), '.githooks');
  // A hooks path the repository already has is kept.
  sh(dir, 'config', 'core.hooksPath', 'tools/hooks');
  assert.equal(await W.useHooks(dir), false);
  assert.equal(sh(dir, 'config', '--local', '--get', 'core.hooksPath'), 'tools/hooks');
  // No .githooks folder: nothing set.
  const plain = path.join(tmp, 'hooks-none');
  sh(tmp, 'init', '-q', '-b', 'main', plain);
  assert.equal(await W.useHooks(plain), false);
  assert.throws(() => sh(plain, 'config', '--local', '--get', 'core.hooksPath'));
});
