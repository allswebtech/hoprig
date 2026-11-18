// The strict check of the map's version 2 (mapcheck.mjs): groups, "in", and the keys a later Hoprig fills in. The map
// comes from a repository, so every rule refuses a bad shape on its own; a map that fails is not used.
import assert from 'node:assert/strict';
import test from 'node:test';

const { validateMap, refOf } = await import('../../src/workspace/mapcheck.mjs');
const { normalizeMap } = await import('../../src/workspace/map.mjs');

const U = (n) => `https://git.example.test/team/${n}.git`;
const good = () => ({
  version: 2,
  brain: { url: U('brain') },
  groups: [
    { dir: 'client-work' },
    { dir: 'kits', url: U('kits'), memories: { '.': 'ai_brain/claude-memory' }, holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds' }] },
  ],
  projects: [
    { name: 'shop', url: U('shop-workspace'), repos: [{ dir: 'code/shop', url: U('shop') }] },
    { name: 'shop', in: 'client-work', url: U('acme-shop'), repos: [] },
    { name: 'blog', in: 'kits/packs', url: null, repos: [{ dir: 'code/blog-theme', url: U('blog-theme') }] },
    { name: 'blog', in: 'kits/builds', url: U('blog-build'), repos: [] },
  ],
  others: [{ dir: 'git/mirror', url: U('mirror') }],
  skip: ['client-work/old'],
});
const errorsOf = (m, o) => {
  const v = validateMap(m, o);
  assert.equal(v.ok, false, `refused: ${JSON.stringify(m).slice(0, 300)}`);
  return v.errors.join(' | ');
};
const withGroup = (g) => ({ ...good(), groups: [g], projects: [] });

test('a good version-2 map passes, keeps groups and "in", and one name may be in two places', () => {
  const v = validateMap(good(), { write: true });
  assert.equal(v.ok, true, (v.errors || []).join('; '));
  assert.equal(v.map.version, 2);
  assert.deepEqual(v.map.groups.map((g) => g.dir), ['client-work', 'kits']);
  assert.deepEqual(v.map.projects.map(refOf), ['shop', 'client-work/shop', 'kits/packs/blog', 'kits/builds/blog']);
  assert.deepEqual(validateMap(normalizeMap(v.map)).map.projects.map(refOf).sort(), v.map.projects.map(refOf).sort());
});

test('rule: "version" is 1 or 2', () => {
  assert.match(errorsOf({ ...good(), version: 3 }), /"version" must be 1 or 2/);
});

test('rule: a version-1 map has no groups and no "in" (the upgrade comes first)', () => {
  assert.match(errorsOf({ version: 1, brain: { url: null }, projects: [], others: [], groups: [] }), /unknown key "groups".*--upgrade/);
  assert.match(errorsOf({ version: 1, brain: { url: null }, projects: [{ name: 'x', in: 'client-work', url: null, repos: [] }], others: [] }), /each project is/);
});

test('rule: a group has only the keys the map knows', () => {
  assert.match(errorsOf(withGroup({ dir: 'client-work', colour: 'red' })), /a group is \{ dir/);
});

test('rule: a group\'s folder has no ".."', () => {
  assert.match(errorsOf(withGroup({ dir: '../elsewhere' })), /folder inside the workspace/);
  assert.match(errorsOf(withGroup({ dir: 'client-work/../../x' })), /folder inside the workspace/);
});

test('rule: a group\'s folder is not a full path', () => {
  assert.match(errorsOf(withGroup({ dir: '/srv/client-work' })), /folder inside the workspace/);
});

test('rule: a group\'s folder is none of the folders the map never looks into', () => {
  for (const d of ['no-ai', 'stuff/ignore', '.hidden', 'node_modules', 'credentials']) assert.match(errorsOf(withGroup({ dir: d })), /folder inside the workspace/, d);
});

test('rule: a group is not one of the workspace\'s own folders, nor inside one or around the projects folder', () => {
  for (const d of ['projects', 'projects/clients', 'ai_brain', 'development/x', 'git', 'backups']) assert.match(errorsOf(withGroup({ dir: d })), /workspace's own folders/, d);
  assert.match(errorsOf({ ...withGroup({ dir: 'work' }), config: { projectsDir: 'work/projects' } }), /workspace's own folders/);
});

test('rule: two groups are never in one folder or one inside the other', () => {
  assert.match(errorsOf({ ...good(), projects: [], groups: [{ dir: 'client-work' }, { dir: 'client-work' }] }), /one group inside another/);
  assert.match(errorsOf({ ...good(), projects: [], groups: [{ dir: 'client-work' }, { dir: 'client-work/big' }] }), /one group inside another/);
});

test('rule: a group\'s address is a git address with nothing secret in it', () => {
  assert.match(errorsOf(withGroup({ dir: 'kits', url: 'file:///etc' })), /group "kits"/);
  const v = validateMap(withGroup({ dir: 'kits', url: 'https://alex:hunter2@git.example.test/team/kits.git' }));
  assert.equal(v.ok, true, 'a user name and password are taken out, as for every address');
  assert.equal(v.map.groups[0].url, U('kits'));
});

test('rule: only a group that is a repository keeps memory', () => {
  assert.match(errorsOf(withGroup({ dir: 'client-work', memories: { '.': 'ai_brain/claude-memory' } })), /"memories" needs "url"/);
  assert.match(errorsOf(withGroup({ dir: 'kits', url: U('kits'), memories: { '.': '../x' } })), /memory folders inside it/);
});

test('rule: only a group that is a repository holds named folders', () => {
  assert.match(errorsOf(withGroup({ dir: 'client-work', holds: [{ dir: 'packs' }] })), /"holds" needs "url"/);
});

test('rule: a held folder is one plain folder name, named once, and its "parent" is "group" or left out', () => {
  const g = (holds) => withGroup({ dir: 'kits', url: U('kits'), holds });
  for (const d of ['a/b', '..', '.x', 'no-ai', 'ai_brain', 'code']) assert.match(errorsOf(g([{ dir: d }])), /one plain folder name/, d);
  assert.match(errorsOf(g([{ dir: 'packs' }, { dir: 'packs' }])), /named twice/);
  assert.match(errorsOf(g([{ dir: 'packs', parent: 'own' }])), /"parent" is "group"/);
  assert.match(errorsOf(g([{ dir: 'packs', size: 1 }])), /a held folder is/);
});

test('rule: a project\'s "in" is a folder inside the workspace', () => {
  for (const at of ['../x', '/srv/x', 'client-work/../x', 'no-ai/x']) {
    assert.match(errorsOf({ ...good(), projects: [{ name: 'p', in: at, url: null, repos: [] }] }), /"in" must be a folder inside the workspace/, at);
  }
});

test('rule: "in" names a declared group or held folder (never a group that keeps its members in held folders)', () => {
  assert.match(errorsOf({ ...good(), projects: [{ name: 'p', in: 'elsewhere', url: null, repos: [] }] }), /not a group or a held folder/);
  assert.match(errorsOf({ ...good(), projects: [{ name: 'p', in: 'kits', url: null, repos: [] }] }), /not a group or a held folder/);
  assert.match(errorsOf({ ...good(), projects: [{ name: 'p', in: 'kits/other', url: null, repos: [] }] }), /not a group or a held folder/);
});

test('rule: a member that comes with the group\'s repository has no address of its own', () => {
  assert.match(errorsOf({ ...good(), projects: [{ name: 'p', in: 'kits/packs', url: U('p'), repos: [] }] }), /no address of its own/);
});

test('rule: a name is unique in its place', () => {
  const m = good();
  m.projects.push({ name: 'shop', in: 'client-work', url: null, repos: [] });
  assert.match(errorsOf(m), /"client-work\/shop" is in the map twice/);
});

test('a project of the projects folder may have the name of a group\'s folder: two different folders', () => {
  assert.equal(validateMap({ ...good(), projects: [{ name: 'client-work', url: null, repos: [] }] }, { write: true }).ok, true);
});

test('rule: another repository is never where a group, its held folder or a member is; elsewhere in a group it may be', () => {
  assert.match(errorsOf({ ...good(), others: [{ dir: 'client-work/tool', url: null }] }), /never where a project of a group is/);
  assert.match(errorsOf({ ...good(), others: [{ dir: 'kits', url: null }] }), /never where a group's folder is/);
  assert.match(errorsOf({ ...good(), others: [{ dir: 'kits/builds', url: null }] }), /never a group's held folder/);
  assert.match(errorsOf({ ...good(), others: [{ dir: 'kits/packs/blog/code/x', url: null }] }), /inside a project that comes with its group/);
  for (const ok of ['kits/tools/lint', 'client-work/misc/foo']) assert.equal(validateMap({ ...good(), others: [{ dir: ok, url: null }] }).ok, true, `${ok}: no member, so another repository`);
});

test('rule: the same repository address in two places is refused when the map is written (one project, one place)', () => {
  const m = good();
  m.projects.push({ name: 'shop2', in: 'client-work', url: U('shop-workspace'), repos: [] });
  assert.equal(validateMap(m).ok, true, 'read: the map is used, so the owner can see and fix it');
  assert.match(errorsOf(m, { write: true }), /same address: one project is in one place only/);
  const g = good();
  g.projects.push({ name: 'k', in: 'client-work', url: U('kits'), repos: [] });
  assert.match(errorsOf(g, { write: true }), /same address/);
  const forms = good();
  forms.projects = [{ name: 'a', url: 'https://github.com/Example/Shop.git', repos: [] }, { name: 'b', in: 'client-work', url: 'git@github.com:example/shop', repos: [] }];
  assert.match(errorsOf(forms, { write: true }), /same address/, 'the one rule for an address: ssh and https, any case on the usual hosting sites');
  const same = good();
  same.projects.push({ name: 'shop-copy', url: U('shop-workspace'), repos: [] });
  assert.equal(validateMap(same, { write: true }).ok, true, 'two names in one place may keep one address (two clones), as in version 1');
});

test('rule: the skip list names projects as <place>/<name> and stays a list of folders', () => {
  assert.match(errorsOf({ ...good(), skip: ['../x'] }), /"skip" is a list/);
  assert.equal(validateMap({ ...good(), skip: ['kits/builds/blog', 'shop/code/shop'] }).ok, true);
});

test('rule: the keys a later step fills in are accepted only where they belong, and only in their shape', () => {
  const ok = { ...good(), credentials: { url: U('keys') }, storage: { main: { kind: 's3', endpoint: 'https://store.example.test', bucket: 'files' } } };
  ok.groups[1].tool = { name: 'kit', run: 'kit.sh', needs: ['git'] };
  ok.groups[1].holds[1].find = { parent: '{project}-{product}-project', folder: '{product}-{project}' };
  ok.projects[0].needs = ['kits/packs/blog'];
  const v = validateMap(ok);
  assert.equal(v.ok, true, (v.errors || []).join('; '));
  assert.deepEqual(v.map.groups[1].tool, { name: 'kit', run: 'kit.sh', needs: ['git'] }, 'kept as it is');
  assert.match(errorsOf({ ...good(), credentials: { url: 'file:///x' } }), /credentials/);
  assert.match(errorsOf({ ...good(), storage: { main: { kind: 's3', endpoint: 'http://store.example.test' } } }), /"storage"/);
  assert.match(errorsOf({ ...good(), storage: { main: { kind: 's3', endpoint: 'https://alex:pw@store.example.test' } } }), /"storage"/);
  assert.match(errorsOf(withGroup({ dir: 'kits', url: U('kits'), tool: { name: 'kit', run: '../kit.sh' } })), /"tool" is/);
  assert.match(errorsOf(withGroup({ dir: 'client-work', tool: { name: 'kit', run: 'kit.sh' } })), /only a group that is a repository has a tool/);
  assert.match(errorsOf(withGroup({ dir: 'kits', url: U('kits'), holds: [{ dir: 'b', find: { parent: 'a b' } }] })), /kits\/b: "find\.parent" is a pattern/);
  assert.match(errorsOf(withGroup({ dir: 'kits', url: U('kits'), holds: [{ dir: 'b', parent: 'group', find: { parent: '{a}-x', folder: '{a}' } }] })), /kits\/b: its members come with the group's repository, so it has no naming rule/);
  assert.match(errorsOf({ ...good(), projects: [{ name: 'x', url: null, repos: [], needs: ['../y'] }] }), /"needs" is a list/);
  assert.match(errorsOf({ version: 1, brain: { url: null }, projects: [], others: [], credentials: { url: U('keys') } }), /unknown key "credentials"/);
  assert.match(errorsOf({ version: 1, brain: { url: null }, projects: [{ name: 'x', url: null, repos: [], needs: [] }], others: [] }), /each project is/);
});

test('rule: the map holds a folder written one way only (no trailing or doubled "/", no "." part)', () => {
  for (const d of ['client-work/', 'a//b', './client-work', 'a/./b']) {
    assert.match(errorsOf(withGroup({ dir: d })), /folder inside the workspace/, d);
    assert.match(errorsOf({ ...good(), projects: [{ name: 'p', in: d, url: null, repos: [] }] }), /"in" must be a folder inside the workspace/, d);
  }
  assert.match(errorsOf({ ...good(), others: [{ dir: 'git/tool/', url: null }] }), /not a folder of the workspace/);
  assert.match(errorsOf({ ...good(), skip: ['client-work//shop'] }), /"skip" is a list/);
});

test('rule: reserved names are compared without letter case (on a file system that ignores case they are the real folders)', () => {
  for (const d of ['Credentials', 'No-AI', 'Projects', 'AI_Brain', 'x/Node_Modules', 'Development/x']) assert.equal(validateMap(withGroup({ dir: d })).ok, false, d);
  for (const h of ['Code', 'AI_BRAIN', 'No-Ai']) assert.equal(validateMap(withGroup({ dir: 'kits', url: U('kits'), holds: [{ dir: h }] })).ok, false, h);
  assert.equal(validateMap({ ...good(), projects: [{ name: 'p', in: 'Client-Work/No-AI', url: null, repos: [] }] }).ok, false);
  for (const o of ['AI_Brain/x', 'Projects/x', 'Credentials/k', 'git/IGNORE/x']) assert.equal(validateMap({ ...good(), others: [{ dir: o, url: null }] }).ok, false, o);
  assert.equal(validateMap({ ...good(), groups: [{ dir: 'Client-Work' }, { dir: 'client-work' }], projects: [] }).ok, false, 'one folder on such a file system');
});

test('rule: no part of a folder starts with "-" (it would read as an option)', () => {
  for (const d of ['-x', '--upload-pack', 'a/-b']) {
    assert.match(errorsOf(withGroup({ dir: d })), /folder inside the workspace/, d);
    assert.match(errorsOf({ ...good(), projects: [{ name: 'p', in: d, url: null, repos: [] }] }), /"in" must be a folder/, d);
  }
});

test('rule: held folders and the places of other repositories are compared without letter case', () => {
  assert.match(errorsOf(withGroup({ dir: 'kits', url: U('kits'), holds: [{ dir: 'builds' }, { dir: 'Builds' }] })), /held folder "Builds" is named twice/);
  assert.match(errorsOf({ ...good(), others: [{ dir: 'Kits/builds', url: null }] }), /never a group's held folder/);
  assert.match(errorsOf({ ...good(), others: [{ dir: 'kits/BUILDS/blog', url: null }] }), /never where a project of a group is/);
  assert.match(errorsOf({ ...good(), others: [{ dir: 'KITS', url: null }] }), /never where a group's folder is/);
});

test('rule: a repository\'s folder is written one way, named once, and is never code or ai_brain itself', () => {
  const withRepos = (repos) => ({ ...good(), projects: [{ name: 'shop', url: U('shop-workspace'), repos }] });
  const r = (dir) => ({ dir, url: U('shop') });
  assert.match(errorsOf(withRepos([r('code/x'), r('code//x')])), /written one way/);
  assert.match(errorsOf(withRepos([r('code/x'), r('code/x/')])), /written one way/);
  assert.match(errorsOf(withRepos([r('code/x'), r('code/./x')])), /written one way|each repository is/);
  assert.match(errorsOf(withRepos([r('code/x'), r('code/X')])), /the same folder is named twice/);
  assert.match(errorsOf(withRepos([r('code')])), /never code or ai_brain itself/);
  assert.match(errorsOf(withRepos([r('AI_BRAIN')])), /never code or ai_brain itself/);
  assert.equal(validateMap(withRepos([r('code/x'), r('code/y'), r('tools/z')])).ok, true);
});

test('rule: a group\'s tool is never named hop or hoprig, and its run is a file inside the group written one way', () => {
  const t = (tool) => withGroup({ dir: 'kits', url: U('kits'), tool });
  assert.match(errorsOf(t({ name: 'hop', run: 'kit.sh' })), /Hoprig's own command/);
  assert.match(errorsOf(t({ name: 'hoprig', run: 'kit.sh' })), /Hoprig's own command/);
  assert.match(errorsOf(t({ name: 'kit', run: 'bin//kit.sh' })), /"tool" is|written one way/);
  assert.match(errorsOf(t({ name: 'kit', run: '../kit.sh' })), /"tool" is/);
  assert.equal(validateMap(t({ name: 'kit', run: 'bin/kit.sh', needs: ['git'], needsOn: { mac: ['pod'] } })).ok, true);
});
