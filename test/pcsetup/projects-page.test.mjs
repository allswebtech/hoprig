// The Workspace and project pages: the git state in words a person understands, and the routes behind the step pages (New
// project and Get an existing project run as background jobs that never ask, with a preview first), Sync's result
// per repository with what is left as a kind the page explains, and the projects folder change. Skills: the
// suggestions for "Just for me".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-page-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Just enough of a browser for the page's modules to load (nothing is drawn here).
globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { gitWords, jobOutcome, placeOfLabel, placesOf, projectWords, projectsOf } = await import('../../web/projects.js');
const { pcsetupFeature, tildeText, todoKind } = await import('../../src/pcsetup/feature.mjs');

test('git state in plain words: branch, changes not saved to git, not on GitHub yet, to upload / download, up to date', () => {
  const s = (o) => ({ ok: true, branch: 'main', changes: 0, ahead: 0, behind: 0, upstream: true, ...o });
  assert.equal(gitWords(s({ upstream: false })), 'branch main · not on GitHub yet');
  assert.equal(gitWords(s({ changes: 3, upstream: false })), 'branch main · 3 changes not saved to git · not on GitHub yet');
  assert.equal(gitWords(s({})), 'branch main · up to date');
  assert.equal(gitWords(s({ ahead: 1, behind: 2 })), 'branch main · 1 saved change to upload · 2 new changes to download');
  assert.equal(gitWords({ ok: false, error: 'not cloned' }), 'not downloaded to this computer yet');
  for (const w of [gitWords(s({ upstream: false })), gitWords(s({ ahead: 1 }))]) assert.doesNotMatch(w, /upstream|push|pull|ahead|behind/, 'no git jargon');

  const d = {
    workspaces: [{ id: 'shop', name: 'shop', dir: '/p/shop', memories: {}, repos: [s({ rel: '.', upstream: false }), s({ rel: 'code/shop-web', changes: 2, upstream: false })] }],
    repos: [{ ...s({}), id: 'blog', rel: 'blog', dir: '/p/blog' }],
  };
  const list = projectsOf(d);
  assert.deepEqual(list.map((p) => [p.id, p.workspace, p.repos.map((r) => r.label)]), [['blog', false, ['blog']], ['shop', true, ['shop', 'shop-web']]]);
  assert.equal(projectWords(list[1]), '2 repositories · 2 changes not saved to git');
  assert.equal(projectWords({ repos: [s({ upstream: false }), s({ upstream: false })] }), '2 repositories · not on GitHub yet');
  assert.equal(projectWords({ repos: [s({}), s({})] }), '2 repositories · all up to date');
});

test('with groups in the map: each project carries its place, and the page knows the places in order', () => {
  const d = {
    projectsDir: '/p',
    places: [{ id: '', dir: '/p' }, { id: 'client-work', dir: '/w/client-work', members: 'own', group: 'client-work' }],
    workspaces: [{ id: 'client-work/shop', place: 'client-work', name: 'shop', dir: '/w/client-work/shop', memories: {}, repos: [] }, { id: 'shop', name: 'shop', dir: '/p/shop', memories: {}, repos: [] }],
    repos: [{ id: 'client-work/notes', place: 'client-work', rel: 'notes', dir: '/w/client-work/notes', ok: true }],
  };
  const list = projectsOf(d);
  assert.deepEqual(list.map((p) => [p.id, p.place]), [['client-work/notes', 'client-work'], ['client-work/shop', 'client-work'], ['shop', '']]);
  assert.deepEqual(placesOf(d).map((p) => p.id), ['', 'client-work']);
  assert.deepEqual(placesOf({ projectsDir: '/p', workspaces: [], repos: [] }), [{ id: '', dir: '/p' }], 'an older computer: the projects folder only');
  assert.equal(placeOfLabel('kits/packs/blog'), 'kits/packs');
  assert.equal(placeOfLabel('shop'), '');
});

test('the home folder is written as ~ in what the page shows; other paths that only start the same stay', () => {
  assert.equal(tildeText('git -C "/home/ann/projects/x" push', '/home/ann'), 'git -C ~/"projects/x" push', 'copied into a shell, the ~ still expands');
  assert.equal(tildeText("cd '/home/ann' && ls", '/home/ann'), 'cd ~ && ls');
  assert.equal(tildeText('✓ created /home/ann/p (built-in)', '/home/ann'), '✓ created ~/p (built-in)');
  assert.equal(tildeText('in /home/ann', '/home/ann'), 'in ~');
  assert.equal(tildeText('/home/anna/x', '/home/ann'), '/home/anna/x');
  assert.equal(tildeText('C:\\Users\\ann\\p', 'C:\\Users\\ann'), '~\\p');
});

test('sync: what is left gets a kind the page explains in words', () => {
  assert.equal(todoKind('main has no upstream'), 'not-online');
  assert.equal(todoKind('main and its upstream have both moved (1 ahead, 2 behind)'), 'diverged');
  assert.equal(todoKind('2 to pull, but there are 1 uncommitted changes'), 'pull-blocked');
  assert.equal(todoKind('1 to pull, but the incoming commits put files where builds/acme is here, which this repository does not track (another repository, perhaps): nothing was changed; move it away first, then'), 'kept-back', 'not "commit your changes": the owner changed nothing');
  assert.equal(todoKind('1 to get from box2, but those commits put files where code/web is here, which this repository does not track (another repository, perhaps): nothing was changed, and your 2 uncommitted changes stay where they are; move it away first, then'), 'kept-back');
  assert.equal(todoKind('3 uncommitted changes'), 'uncommitted');
  assert.equal(todoKind('fetch failed: could not resolve host'), 'fetch-failed');
  assert.equal(todoKind('push failed: denied'), 'push-failed');
  assert.equal(todoKind('something new'), 'other');
});

const pdir = path.join(tmp, 'projects');
function harness(over = {}, { caller } = {}) {
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [], create: async () => {} }, deck: { launcher: () => ['node', 'x'] }, ...(caller ? { caller: () => caller } : {}) };
  const f = pcsetupFeature(sctx, { sys: { platform: 'linux', has: () => false, run: async () => ({ ok: false, stdout: '', stderr: '' }), env: process.env, home: process.env.HOME }, projectsDir: () => pdir, run: async () => ({ ok: false, stdout: '', stderr: '' }), ...over });
  const call = async (method, p, body, headers = {}) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Object.assign(Readable.from([]), { body, headers }), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  const job = async () => {
    for (let i = 0; i < 100; i++) {
      const j = await call('GET', '/api/pcsetup/job?from=0');
      if (!j.running) return j;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('job did not end');
  };
  return { call, job };
}

test('New project: a preview first (nothing made), then a background job that never asks; its error is plain words', async () => {
  fs.mkdirSync(path.join(pdir, 'taken'), { recursive: true });
  const seen = [];
  const { call, job } = harness({
    projectNew: async (args, { ui }) => {
      seen.push({ args, interactive: ui.interactive });
      ui.line('fail', 'git does not know your name and e-mail yet');
      ui.line('ok', `created ${path.join(os.homedir(), 'projects', 'shop')}`);
      return 1;
    },
  });
  const pv = await call('GET', '/api/pcsetup/project/preview?name=shop');
  assert.equal(pv.dir, path.join(pdir, 'shop'));
  assert.equal(pv.exists, false);
  assert.equal(pv.template, 'built-in');
  assert.ok(pv.files.includes('AGENTS.md') && pv.files.includes('code/.gitignore'));
  assert.ok(!pv.files.some((f) => f.startsWith('.claude/skills/') || f === 'docs/brief.md'), 'without a brief: no skill and no brief');
  const withBrief = (await call('GET', '/api/pcsetup/project/preview?name=shop&brief=1')).files;
  for (const f of ['.claude/skills/new-project/SKILL.md', '.claude/skills/.hoprig-skills.json', 'docs/brief.md']) assert.ok(withBrief.includes(f), `with a brief: ${f}`);
  assert.equal(withBrief.length, pv.files.length + withBrief.filter((f) => f.startsWith('.claude/skills/')).length + 1);
  assert.equal(pv.github.signedIn, false);
  assert.equal(fs.existsSync(pv.dir), false, 'the preview makes nothing');
  assert.equal((await call('GET', '/api/pcsetup/project/preview?name=taken')).exists, true);
  await assert.rejects(call('GET', '/api/pcsetup/project/preview?name=../x'), /project name/);
  await assert.rejects(call('POST', '/api/pcsetup/project/new', { name: 'taken' }), /already there/);

  const r = await call('POST', '/api/pcsetup/project/new', { name: 'shop' });
  assert.deepEqual(r, { started: true, name: 'shop', dir: path.join(pdir, 'shop') });
  const j = await job();
  assert.deepEqual(seen, [{ args: ['shop', '--no-github'], interactive: false }], 'GitHub only when chosen; nothing is asked');
  assert.equal(j.result.ok, false);
  assert.equal(j.result.error, 'git does not know your name and e-mail yet');
  assert.equal(j.result.data.made, false);
  assert.ok(j.lines.some((l) => l.includes('created ~/projects/shop')) && !j.lines.join('\n').includes(os.homedir()), 'the output shows ~');
  await call('POST', '/api/pcsetup/project/new', { name: 'shop2', github: true });
  await job();
  assert.deepEqual(seen[1].args, ['shop2', '--github']);
});

test('New project with no git name and e-mail anywhere: the preview asks the page for them, and the typed ones reach the first commit', async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  const empty = path.join(tmp, 'empty-gitconfig');
  fs.writeFileSync(empty, '');
  process.env.GIT_CONFIG_GLOBAL = empty;
  try {
    const seen = [];
    const { call, job } = harness({ projectNew: async (args) => (seen.push(args), 0) });
    assert.equal((await call('GET', '/api/pcsetup/project/preview?name=idshop')).askIdentity, true);
    await assert.rejects(call('POST', '/api/pcsetup/project/new', { name: 'idshop', gitName: 'Alex Lee', gitEmail: 'not an address' }), /e-mail address/);
    await assert.rejects(call('POST', '/api/pcsetup/project/new', { name: 'idshop', gitName: 'two\nlines', gitEmail: 'alex@example.com' }), /name for commits/);
    await call('POST', '/api/pcsetup/project/new', { name: 'idshop', gitName: 'Alex Lee', gitEmail: 'alex@example.com' });
    await job();
    assert.deepEqual(seen[0], ['idshop', '--no-github', '--git-name', 'Alex Lee', '--git-email', 'alex@example.com']);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = saved;
  }
  assert.equal((await harness({}).call('GET', '/api/pcsetup/project/preview?name=idshop')).askIdentity, false, 'git knows them: nothing is asked');
});

test('New project with a brief: the brief is checked before the job, then given to it unchanged with the kind\'s hint and the scope', async () => {
  const seen = [];
  const { call, job } = harness({
    projectNew: async (args, o) => {
      seen.push({ args, brief: o.brief });
      return 0;
    },
  });
  const brief = 'A booking site for many salons.\r\nCustomers pay online.';
  await call('POST', '/api/pcsetup/project/new', { name: 'salons', brief, kind: 'multi-tenant', scope: 'setup' });
  await job();
  assert.deepEqual(seen[0], { args: ['salons', '--no-github', '--kind', 'multi-tenant', '--scope', 'setup'], brief });
  for (const [body, re] of [
    [{ name: 'x1', brief: 'Hidden\u200b here' }, /cannot be seen/],
    [{ name: 'x6', brief: 'A shop.\u2028Customers pay.' }, (e) => /cannot be seen/.test(e.message) && e.details.clean === 'A shop.\nCustomers pay.'],
    [{ name: 'x2', brief, kind: 'game' }, /the kind is one of/],
    [{ name: 'x3', brief, scope: 'all' }, /the scope is one of/],
    [{ name: 'x4', kind: 'cli' }, /go with a brief/],
    [{ name: 'x5', scope: 'setup' }, /go with a brief/],
  ]) await assert.rejects(call('POST', '/api/pcsetup/project/new', body), re, JSON.stringify(body));
  assert.equal(seen.length, 1, 'a refused brief, kind or scope starts no job');
});

test('Get an existing project and Add a repository: checked input, a job, no password prompt on the server', async () => {
  let env = null;
  const { call, job } = harness({
    cloneProject: async (spec, { runner }) => {
      await runner(['git', 'clone'], {});
      return /octo\/app/.test(spec) ? 0 : 1;
    },
    stream: async (argv, o) => {
      env = o.env;
      return { ok: true };
    },
    projectAdd: async (args) => (args[1] === 'web' ? 0 : 1),
  });
  await assert.rejects(call('POST', '/api/pcsetup/project/clone', { spec: '--upload-pack=x' }), /Git address/);
  for (const spec of ['octo/.x', 'octo/-rf', 'octo/no-ai']) await assert.rejects(call('POST', '/api/pcsetup/project/clone', { spec }), /does not make a folder name/, spec);
  assert.deepEqual(await call('POST', '/api/pcsetup/project/clone', { spec: 'octo/app' }), { started: true, name: 'app', dir: path.join(pdir, 'app') });
  assert.equal((await job()).result.ok, true);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  await assert.rejects(call('POST', '/api/pcsetup/project/add', { name: 'nope', repo: 'web' }), /no such project/);
  fs.mkdirSync(path.join(pdir, 'shopx', '.git'), { recursive: true });
  await assert.rejects(call('POST', '/api/pcsetup/project/add', { name: 'shopx', repo: '../x' }), /repository name/);
  await call('POST', '/api/pcsetup/project/add', { name: 'shopx', repo: 'web' });
  assert.equal((await job()).result.ok, true);
});

test('Get an existing project: the folder is the project\'s name; one here under another name is shown with its mv', async () => {
  const { call, job } = harness({
    cloneProject: async (spec, { onDone }) => {
      if (/old/.test(spec)) {
        onDone({ ok: true, result: 'misnamed', folder: 'old', dir: path.join(pdir, 'old'), here: path.join(pdir, 'old-workspace'), mv: 'mv a b', message: 'it is here already, as old-workspace' });
        return 0;
      }
      fs.mkdirSync(path.join(pdir, 'website', '.git'), { recursive: true });
      onDone({ ok: true, result: 'cloned', folder: 'website', dir: path.join(pdir, 'website') });
      return 0;
    },
  });
  // what the page shows first: the repository's name without "-workspace"; then the job's own folder
  assert.deepEqual(await call('POST', '/api/pcsetup/project/clone', { spec: 'octo/site-workspace' }), { started: true, name: 'site', dir: path.join(pdir, 'site') });
  const j = await job();
  assert.equal(j.result.ok, true);
  assert.deepEqual(j.result.data, { name: 'website', dir: path.join(pdir, 'website'), made: true });
  fs.mkdirSync(path.join(pdir, 'old-workspace', '.git'), { recursive: true });
  await call('POST', '/api/pcsetup/project/clone', { spec: 'octo/old-workspace' });
  const m = await job();
  assert.equal(m.result.ok, false);
  assert.match(m.result.error, /here already, as old-workspace/);
  assert.deepEqual(m.result.data, { name: 'old-workspace', dir: path.join(pdir, 'old-workspace'), made: false, mv: 'mv a b', fix: 'mv a b' }); // made: never of a folder this run did not place
  // the page: a project here under another name needs the owner (the mv), never "done"
  assert.equal(jobOutcome(m.result), 'needs-you');
  assert.equal(jobOutcome(j.result), 'done');
  assert.equal(jobOutcome({ ok: false, error: 'clone failed', data: { made: false } }), 'failed');
});

test('Get an existing project whose folder name is taken: the job names the temporary folder, not the one in the way', async () => {
  const temp = path.join(pdir, '.hoprig-clone-site-workspace-abc123');
  const { call, job } = harness({
    cloneProject: async (spec, { onDone }) => {
      fs.mkdirSync(path.join(pdir, 'website', '.git'), { recursive: true }); // someone else's repository is in the way
      fs.mkdirSync(path.join(temp, '.git'), { recursive: true });
      onDone({ ok: false, result: 'taken', folder: 'website', dir: path.join(pdir, 'website'), temp, fix: 'mv x y', message: 'website is taken by another folder, so the clone was left in a temporary folder' });
      return 1;
    },
  });
  await call('POST', '/api/pcsetup/project/clone', { spec: 'octo/site-workspace' });
  const j = await job();
  assert.equal(j.result.ok, false);
  assert.match(j.result.error, /taken by another folder/);
  assert.deepEqual(j.result.data, { name: '.hoprig-clone-site-workspace-abc123', dir: temp, made: true, placed: false, fix: 'mv x y' });
  assert.equal(jobOutcome(j.result), 'needs-you');
});

test('Get an existing project whose folder holds another repository: it needs the owner, and no folder of it is shown as made', async () => {
  for (const fix of ['mv x y', undefined]) {
    const { call, job } = harness({
      cloneProject: async (spec, { onDone }) => {
        fs.mkdirSync(path.join(pdir, 'shop', '.git'), { recursive: true }); // a clone of another repository is in the way
        onDone({ ok: false, result: 'taken', folder: 'shop', dir: path.join(pdir, 'shop'), ...(fix ? { fix } : {}), message: `${path.join(pdir, 'shop')} is in the way: it is a clone of https://github.com/bob/thing.git` });
        return 1;
      },
    });
    await call('POST', '/api/pcsetup/project/clone', { spec: 'alex/shop-workspace' });
    const j = await job();
    assert.equal(j.result.ok, false);
    assert.deepEqual(j.result.data, { made: false, placed: false, fix: fix || j.result.error });
    assert.equal(jobOutcome(j.result), 'needs-you');
  }
  // another run has it: the folder that was there is not "made" by this one
  const { call, job } = harness({ cloneProject: async (spec, { onDone }) => (onDone({ ok: false, result: 'busy', folder: 'shop', dir: path.join(pdir, 'shop'), message: 'shop is being fetched by another run' }), 1) });
  await call('POST', '/api/pcsetup/project/clone', { spec: 'alex/shop-workspace' });
  const b = await job();
  assert.equal(b.result.data.made, false);
  assert.equal(jobOutcome(b.result), 'failed');
});

test('Sync: per repository what was done and what is left, for the page to say in words', async () => {
  fs.mkdirSync(path.join(pdir, 'synced', '.git'), { recursive: true });
  const { call, job } = harness({
    syncWorkspace: async () => ({ memory: null, repos: [{ rel: '.', did: ['pushed 2'], todo: [] }, { rel: 'code/web', did: [], todo: [{ why: '1 uncommitted change', command: `git -C "${os.homedir()}/p/web" status` }] }] }),
  });
  await call('POST', '/api/pcsetup/project/sync', { name: 'synced' });
  const j = await job();
  assert.equal(j.result.ok, false, 'something is left for the owner');
  assert.deepEqual(j.result.data.repos, [
    { rel: '.', did: [{ kind: 'pushed', count: 2 }], todo: [] },
    { rel: 'code/web', did: [], todo: [{ kind: 'uncommitted', why: '1 uncommitted change', command: 'git -C ~/"p/web" status' }] },
  ]);
  assert.ok(j.lines.some((l) => l.includes('git -C ~/"p/web" status')), 'the output shows ~, not the home folder');
  assert.ok(!JSON.stringify(j).includes(os.homedir()), 'no home folder (and so no user name) anywhere in the answer');
});

test('the list shows a project\'s code repositories even when project.json does not name them', async () => {
  const root = path.join(pdir, 'withkids');
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  try {
    fs.mkdirSync(path.join(root, 'code', 'withkids-web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: 'withkids', repos: [] }));
    git(root, 'init', '-q', '-b', 'main');
    git(path.join(root, 'code', 'withkids-web'), 'init', '-q', '-b', 'main');
  } catch {
    return; // no git here: nothing to show
  }
  const { capture } = await import('../../src/setup/system.mjs');
  const { call } = harness({ run: capture });
  const d = await call('GET', '/api/pcsetup/projects');
  const w = d.workspaces.find((x) => x.id === 'withkids');
  assert.deepEqual(w.repos.map((r) => r.rel), ['.', 'code/withkids-web']);
});

test('projects folder: a full path or ~/…, made when missing; anything else is refused', async () => {
  const saved = [];
  const { call } = harness({ rememberDir: (d) => saved.push(d) });
  await assert.rejects(call('POST', '/api/pcsetup/projects-dir', { dir: 'relative/x' }), /full folder path/);
  await assert.rejects(call('POST', '/api/pcsetup/projects-dir', { dir: '/' }), /full folder path/);
  await assert.rejects(call('POST', '/api/pcsetup/projects-dir', { dir: '~/a/../b' }), /full folder path/);
  const r = await call('POST', '/api/pcsetup/projects-dir', { dir: '~/code-here' });
  assert.equal(r.projectsDir, path.join(os.homedir(), 'code-here'));
  assert.ok(fs.statSync(r.projectsDir).isDirectory());
  assert.deepEqual(saved, [r.projectsDir]);
});

test('Skills for "Just for me": the catalog\'s skills meant for every project, marked when installed', async () => {
  const { skillhubFeature } = await import('../../src/skillhub/feature.mjs');
  const f = skillhubFeature({ config: () => ({ server: { roots: [process.env.HOME] } }), readJson: async () => ({}), notify: async () => ({}) });
  const [, , fn] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/skillhub/suggest'));
  const r = await fn({ headers: {} }, null, new URLSearchParams());
  assert.equal(r.project, null);
  assert.ok(r.suggestions.length >= 1);
  assert.ok(r.suggestions.every((s) => s.scope === 'user' && typeof s.installed === 'boolean'));
  assert.ok(r.suggestions.some((s) => s.id === 'hoprig'));
});

// Publishing is the owner's own press: a project sync through Tia's door (or relayed as hers from a hub) never pushes.
test('Sync through Tia\'s door never pushes; from the owner\'s page it does', async () => {
  fs.mkdirSync(path.join(pdir, 'synced', '.git'), { recursive: true });
  const seen = [];
  const syncWorkspace = async (root, o) => (seen.push(o.push), { memory: null, repos: [] });
  for (const [caller, headers, want] of [['self', {}, false], ['computer', { 'x-hoprig-self': '1' }, false], ['page', {}, true]]) {
    const { call, job } = harness({ syncWorkspace }, { caller });
    await call('POST', '/api/pcsetup/project/sync', { name: 'synced' }, headers);
    await job();
    assert.equal(seen.at(-1), want, `${caller}: push ${seen.at(-1)}`);
  }
});
