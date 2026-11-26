// A place with a naming rule (kits/builds in the { find: true } world of dryrun-fixture.mjs): `workspace find` lists
// what the hosting site (the stand-in for gh, with an organisation) has that fits and the map has not, and what does not
// fit; --add and --place-it write the map only; `get <word> --in <place>` fetches a project that only the hosting site
// has, and writes nothing into a parent without project.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SHELL_STANDINS } from '../seal.mjs';
import { dryWorld, runCli } from './dryrun-fixture.mjs';

const ws = await import('../../src/workspace/cli.mjs');
const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const { projectSlug } = await import('../../src/sessions.mjs');

const workspace = (args, o) => runCli((a, x) => ws.main(a, x), args, o);
const jsonOf = (r) => JSON.parse(r.text.slice(r.text.indexOf('{')));
const find = { find: true };
const mapOf = (w) => JSON.parse(fs.readFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), 'utf8'));
/** Only the map (and its folder's time, as the file is replaced) changed. */
const onlyMap = (diff) => diff.split('\n').filter(Boolean).every((l) => /^changed home\/Workspace\/ai_brain(\/workspace\.json)?:/.test(l));

test('workspace find lists both projects with their code repositories and folders, and the misfits as "does not fit"', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'find', find);
  const r = await w.unchanged('workspace find --json', () => workspace(['find', '--in', 'kits/builds', '--json']));
  assert.equal(r.code, 0, r.text);
  const f = jsonOf(r);
  assert.deepEqual(f.owners, ['alex', 'team']);
  assert.deepEqual(f.found.map((p) => [p.ref, p.parent, p.code.map((c) => c.name), p.skipped.map((c) => c.name)]), [
    ['kits/builds/alpha-shop', 'alex/shop-alpha-project', ['shop-alpha-app', 'shop-alpha-web'], ['shop-alpha-old-api']],
    ['kits/builds/beta-blog', 'team/blog-beta-project', ['blog-beta-api', 'blog-beta-app', 'blog-beta-web'], []],
  ]);
  assert.deepEqual(f.misfits.map((m) => m.repo).sort(), ['alex/a-b-c-project', 'alex/shop-alpha', 'alex/shop-alpha-old-api', 'alex/zine-gamma-app']);
  const text = await w.unchanged('workspace find', () => workspace(['find', '--in', 'kits/builds']));
  assert.match(text.text, /alpha-shop .*alex\/shop-alpha-project .*code: shop-alpha-app, shop-alpha-web/);
  assert.match(text.text, /Does not fit/);
  assert.match(text.text, /alex\/shop-alpha +has the shape of .* without its fixed part "-project"/);
  // A place without a rule, and one that is not in the map.
  const none = await w.unchanged('workspace find --in clients', () => workspace(['find', '--in', 'clients']));
  assert.equal(none.code, 1);
  assert.match(none.text, /clients has no naming rule/);
  const nowhere = await w.unchanged('workspace find --in nowhere', () => workspace(['find', '--in', 'nowhere', '--json']));
  assert.equal(nowhere.code, 1);
  assert.match(jsonOf(nowhere).error, /not a group or a held folder/);
});

test('workspace find --add writes both into the map and clones nothing; --place-it records a misfit under the folder named', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'findadd', find);
  await w.unchanged('workspace find --add --dry-run', () => workspace(['find', '--in', 'kits/builds', '--add', '--dry-run']));
  const add = await w.changed('workspace find --add', () => workspace(['find', '--in', 'kits/builds', '--add', '--json']));
  assert.equal(add.r.code, 0, add.r.text);
  assert.deepEqual(jsonOf(add.r).added, ['kits/builds/alpha-shop', 'kits/builds/beta-blog']);
  assert.ok(onlyMap(add.diff), `only the map may change:\n${add.diff}`);
  const entry = mapOf(w).projects.find((p) => p.in === 'kits/builds' && p.name === 'alpha-shop');
  assert.deepEqual(entry, { name: 'alpha-shop', in: 'kits/builds', url: 'https://github.com/alex/shop-alpha-project.git', repos: [{ dir: 'code/shop-alpha-app', url: 'https://github.com/alex/shop-alpha-app.git' }, { dir: 'code/shop-alpha-web', url: 'https://github.com/alex/shop-alpha-web.git' }] });
  // Run again: nothing new; both are "in the map already".
  const again = await w.unchanged('workspace find --add, again', () => workspace(['find', '--in', 'kits/builds', '--add', '--json']));
  assert.deepEqual(jsonOf(again).added, []);
  const listed = jsonOf(await workspace(['find', '--in', 'kits/builds', '--json']));
  assert.deepEqual(listed.inMap.sort(), ['kits/builds/alpha-shop', 'kits/builds/beta-blog']);
  // A misfit, placed by the owner: in the map under that folder, never listed again; nothing cloned.
  await w.unchanged('find --place-it --dry-run', () => workspace(['find', '--in', 'kits/builds', '--place-it', 'zine-gamma', 'gamma-zine', '--dry-run']));
  const nope = await w.unchanged('find --place-it of a repository that is not there', () => workspace(['find', '--in', 'kits/builds', '--place-it', 'zine-gamma', 'gamma-zine']));
  assert.equal(nope.code, 1);
  assert.match(nope.text, /no repository "zine-gamma"/);
  const placed = await w.changed('find --place-it', () => workspace(['find', '--in', 'kits/builds', '--place-it', 'alex/a-b-c-project', 'c-ab', '--json']));
  assert.equal(placed.r.code, 0, placed.r.text);
  assert.ok(onlyMap(placed.diff), placed.diff);
  assert.deepEqual(jsonOf(placed.r).entry, { name: 'c-ab', in: 'kits/builds', url: 'https://github.com/alex/a-b-c-project.git', repos: [] });
  const after = jsonOf(await workspace(['find', '--in', 'kits/builds', '--json']));
  assert.ok(!after.misfits.some((m) => m.repo === 'alex/a-b-c-project'), 'placed once: not asked about again');
  const twice = await w.unchanged('find --place-it into a folder the map has', () => workspace(['find', '--in', 'kits/builds', '--place-it', 'shop-alpha', 'c-ab']));
  assert.match(twice.text, /kits\/builds\/c-ab is in the map already/);
});

const get = (args, o) => runCli((a, x) => getMain(a, x), args, o);
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
/** A parent repository only the hosting site has, in an account of the world. */
const onServer = (w, owner, repo, files = { 'README.md': `# ${repo}\n` }) => {
  const seed = path.join(w.root, 'seed', owner, repo);
  fs.mkdirSync(seed, { recursive: true });
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(seed, f), t);
  w.sh(seed, 'init', '-q', '-b', 'main');
  w.sh(seed, 'add', '-A');
  w.sh(seed, 'commit', '-q', '-m', 'start');
  w.sh(w.root, 'clone', '-q', '--bare', seed, path.join(w.server, owner, `${repo}.git`));
};
/** Nothing of Hoprig's in a project of a place with a naming rule: no project.json, .env, hooks setting; git status clean. */
const untouched = (w, root) => {
  assert.equal(w.sh(root, 'status', '--porcelain', '--untracked-files=all'), '', 'the parent\'s working tree is clean');
  assert.ok(!exists(path.join(root, 'project.json')), 'no project.json');
  assert.throws(() => w.sh(root, 'config', '--get', 'core.hooksPath'), 'no hooks setting');
  for (const d of fs.readdirSync(path.join(root, 'code'))) assert.ok(!exists(path.join(root, 'code', d, '.env')), `no .env in code/${d}`);
};

test('get shop --in kits/builds: the look-up, then kits/builds/alpha-shop with its code repositories, apps/, the old one left out, nothing written into it', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule', find);
  const dry = await w.unchanged('get shop --in kits/builds --dry-run', () => get(['shop', '--in', 'kits/builds', '--dry-run']));
  assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, /parent +https:\/\/github\.com\/alex\/shop-alpha-project\.git/);
  assert.match(dry.text, /left out +shop-alpha-old-api \(the word "old"\)/);
  assert.match(dry.text, /\(dry run\) would clone .*shop-alpha-project\.git into .*[\\/]kits[\\/]builds[\\/]alpha-shop .*code\/shop-alpha-app, code\/shop-alpha-web.*make code\/ and apps\/.*nothing is written into it/);
  await w.unchanged('get shop --in kits/builds --dry-run --json', () => get(['shop', '--in', 'kits/builds', '--dry-run', '--json']));
  const real = await w.changed('get shop --in kits/builds', () => get(['shop', '--in', 'kits/builds', '--json']));
  assert.equal(real.r.code, 0, real.r.text);
  const out = jsonOf(real.r).projects[0];
  assert.equal(out.result, 'cloned');
  assert.deepEqual(out.found, { parent: 'alex/shop-alpha-project', code: ['shop-alpha-app', 'shop-alpha-web'], skipped: ['shop-alpha-old-api'] });
  const root = path.join(w.groups.builds, 'alpha-shop');
  assert.equal(out.dir, root);
  assert.ok(exists(path.join(root, 'code', 'shop-alpha-app', '.git')));
  assert.ok(exists(path.join(root, 'code', 'shop-alpha-web', '.git')));
  assert.ok(!exists(path.join(root, 'code', 'shop-alpha-old-api')), 'the word the rule leaves out');
  assert.ok(fs.statSync(path.join(root, 'apps')).isDirectory(), 'the folders the rule names');
  untouched(w, root);
  assert.equal(w.sh(w.groups.kits, 'status', '--porcelain', '--untracked-files=all'), '', 'the group\'s repository takes no member');
  const entry = mapOf(w).projects.find((p) => p.in === 'kits/builds' && p.name === 'alpha-shop');
  assert.equal(entry.url, 'https://github.com/alex/shop-alpha-project.git');
  assert.deepEqual(entry.repos.map((r) => r.dir), ['code/shop-alpha-app', 'code/shop-alpha-web']);
  // Its memory: the group's (it has none of its own); the link is in Claude Code's folder, not in the project.
  assert.equal(fs.realpathSync(path.join(w.home, '.claude', 'projects', projectSlug(root), 'memory')), fs.realpathSync(path.join(w.groups.kits, 'ai_brain', 'claude-memory')));
  // Again, by its place and folder: here, still nothing written.
  const again = await get(['kits/builds/alpha-shop', '--json']);
  assert.equal(again.code, 0, again.text);
  assert.equal(jsonOf(again).projects[0].result, 'here');
  untouched(w, root);
});

test('get <place>/<folder> of a project only the hosting site has, two fits for one word asked once (an error without a terminal), a word that fits nothing', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule2', find);
  onServer(w, 'team', 'shop-delta-project', { 'README.md': '# delta\n', '.gitignore': '/code/\n/apps/\n' });
  const json = await w.unchanged('get shop --in kits/builds --json (two fit)', () => get(['shop', '--in', 'kits/builds', '--json']), { reports: 1 });
  assert.equal(json.code, 1);
  const r = jsonOf(json).projects[0];
  assert.equal(r.result, 'refused');
  assert.deepEqual(r.choices, ['kits/builds/alpha-shop', 'kits/builds/delta-shop']);
  const dry = await w.unchanged('get shop --in kits/builds --dry-run (two fit)', () => get(['shop', '--in', 'kits/builds', '--dry-run']));
  assert.equal(dry.code, 1);
  assert.match(dry.text, /fits 2 projects \(alex\/shop-alpha-project → kits\/builds\/alpha-shop, team\/shop-delta-project → kits\/builds\/delta-shop\)/);
  const none = await w.unchanged('get zine --in kits/builds', () => get(['zine', '--in', 'kits/builds']), { reports: 1 });
  assert.equal(none.code, 1);
  assert.match(none.text, /no repository in alex, team fits .* for "zine"\. These do not fit the rule: alex\/zine-gamma-app/);
  // At a terminal: one question, the choice; it is the yes.
  const asked = await w.changed('get shop --in kits/builds, choosing', () => get(['shop', '--in', 'kits/builds'], { interactive: true, answers: (q) => (q.trim() === '>' ? '2' : 'n') }));
  assert.equal(asked.r.code, 0, asked.r.text);
  assert.equal(asked.r.ui.asked.length, 1, `asked: ${asked.r.ui.asked.join(' | ')}`);
  assert.match(asked.r.text, /fits 2 projects .*Which one\?/);
  assert.ok(exists(path.join(w.groups.builds, 'delta-shop', '.git')));
  untouched(w, path.join(w.groups.builds, 'delta-shop'));
  // By its place and folder, not in the map yet.
  const byFolder = await w.changed('get kits/builds/beta-blog', () => get(['kits/builds/beta-blog']));
  assert.equal(byFolder.r.code, 0, byFolder.r.text);
  assert.ok(exists(path.join(w.groups.builds, 'beta-blog', 'code', 'blog-beta-api', '.git')));
  untouched(w, path.join(w.groups.builds, 'beta-blog'));
  // One fit at a terminal: asked once, and no is no.
  const no = await w.unchanged('get alpha --in kits/builds, answered no', () => get(['alpha', '--in', 'kits/builds'], { interactive: true, answers: () => 'n' }), { reports: 1 });
  assert.equal(no.code, 1);
  assert.equal(no.ui.asked.length, 1);
});

test('a plain group without a rule: get still writes project.json after asking; a project another tool made in a place with a rule is seen by the next scan', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule3', find);
  const plain = await w.changed('get alex/shop-alpha --in clients', () => get(['alex/shop-alpha', '--in', 'clients'], { interactive: true, answers: () => 'y' }));
  assert.equal(plain.r.code, 0, plain.r.text);
  assert.ok(plain.r.ui.asked.some((q) => /Clone all of them into code\//.test(q)), plain.r.ui.asked.join(' | '));
  assert.ok(exists(path.join(w.groups.clients, 'shop-alpha', 'project.json')), 'the existing behaviour stays');
  // Another tool makes kits/builds/beta-blog with git alone; the next scan writes it into the map, and nothing into it.
  const root = path.join(w.groups.builds, 'beta-blog');
  w.sh(w.root, 'clone', '-q', 'https://github.com/team/blog-beta-project.git', root);
  for (const c of ['blog-beta-api', 'blog-beta-app']) w.sh(w.root, 'clone', '-q', `https://github.com/team/${c}.git`, path.join(root, 'code', c));
  const scan = await workspace(['map']);
  assert.equal(scan.code, 0, scan.text);
  const entry = mapOf(w).projects.find((p) => p.in === 'kits/builds' && p.name === 'beta-blog');
  assert.equal(entry.url, 'https://github.com/team/blog-beta-project.git');
  assert.deepEqual(entry.repos.map((r) => r.dir), ['code/blog-beta-api', 'code/blog-beta-app']);
  assert.equal(w.sh(root, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.ok(!exists(path.join(root, 'project.json')));
});

test('restore of a project of a place with a naming rule writes nothing into it either', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule4', find);
  await workspace(['find', '--in', 'kits/builds', '--add']);
  const r = await workspace(['restore', 'https://github.com/alex/brain.git', '--with-projects', '--yes']);
  assert.equal(r.code, 0, r.text);
  const root = path.join(w.groups.builds, 'alpha-shop');
  assert.ok(exists(path.join(root, 'code', 'shop-alpha-app', '.git')));
  assert.ok(fs.statSync(path.join(root, 'apps')).isDirectory());
  untouched(w, root);
  untouched(w, path.join(w.groups.builds, 'beta-blog'));
});

// ---- the review's cases for the naming rule and the look-up ----

test('get <owner/name> or <git address> --in a place with a rule follows the rule: its folder, its code repositories, the map entry', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-spec', find);
  const r = await w.changed('get alex/shop-alpha-project --in kits/builds', () => get(['alex/shop-alpha-project', '--in', 'kits/builds', '--json']));
  assert.equal(r.r.code, 0, r.r.text);
  const out = jsonOf(r.r).projects[0];
  assert.deepEqual([out.result, out.folder, out.dir], ['cloned', 'alpha-shop', path.join(w.groups.builds, 'alpha-shop')]);
  assert.ok(exists(path.join(w.groups.builds, 'alpha-shop', 'code', 'shop-alpha-app', '.git')));
  assert.deepEqual(mapOf(w).projects.find((p) => p.name === 'alpha-shop').repos.map((x) => x.dir), ['code/shop-alpha-app', 'code/shop-alpha-web']);
  untouched(w, path.join(w.groups.builds, 'alpha-shop'));
  const a = await w.changed('get <address> --in kits/builds', () => get(['https://github.com/team/blog-beta-project.git', '--in', 'kits/builds', '--json']));
  assert.equal(a.r.code, 0, a.r.text);
  assert.equal(jsonOf(a.r).projects[0].folder, 'beta-blog');
  assert.deepEqual(mapOf(w).projects.find((p) => p.name === 'beta-blog').repos.map((x) => x.dir), ['code/blog-beta-api', 'code/blog-beta-app', 'code/blog-beta-web']);
  // One that does not fit the rule is refused plainly, and nothing changes.
  const no = await w.unchanged('get alex/zine-gamma-app --in kits/builds', () => get(['alex/zine-gamma-app', '--in', 'kits/builds']), { reports: 1 });
  assert.equal(no.code, 1);
  assert.match(no.text, /alex\/zine-gamma-app does not fit the naming rule of kits\/builds \(\{project\}-\{product\}-project\)/);
});

test('get <bare repository name> --in a place with a rule is that repository', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-bare', find);
  const r = await w.changed('get shop-alpha-project --in kits/builds', () => get(['shop-alpha-project', '--in', 'kits/builds', '--json']));
  assert.equal(r.r.code, 0, r.r.text);
  assert.equal(jsonOf(r.r).projects[0].folder, 'alpha-shop');
});

test('a get by rule whose clone fails leaves the map as it was, and its retry is hoprig get <place>/<folder>', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-fail', find);
  const objects = path.join(w.server, 'team', 'blog-beta-project.git', 'objects');
  fs.rmSync(objects, { recursive: true });
  fs.mkdirSync(objects);
  const before = fs.readFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), 'utf8');
  const r = await get(['blog', '--in', 'kits/builds', '--json']);
  assert.equal(r.code, 1);
  const out = jsonOf(r).projects[0];
  assert.equal(out.result, 'failed');
  assert.match(out.message, /retry: hoprig get kits\/builds\/beta-blog$/);
  assert.equal(fs.readFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), 'utf8'), before, 'no entry for what no computer has');
});

test('one folder in a place whatever its letter case, one address once: find --add, --place-it and get by rule', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-once', find);
  await workspace(['find', '--in', 'kits/builds', '--add']);
  // The same address under a second folder: refused, naming the entry it has.
  const again = await w.unchanged('find --place-it of an address the map has', () => workspace(['find', '--in', 'kits/builds', '--place-it', 'alex/shop-alpha-project', 'second']));
  assert.equal(again.code, 1);
  assert.match(again.text, /alex\/shop-alpha-project is in the map already, as kits\/builds\/alpha-shop: one repository is in the map once/);
  // A folder that differs only in letter case from the map's: never a second project there.
  const m = mapOf(w);
  m.projects = m.projects.filter((p) => p.name !== 'beta-blog').concat([{ name: 'Beta-Blog', in: 'kits/builds', url: 'https://github.com/alex/x-other-project.git', repos: [] }]);
  fs.writeFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), JSON.stringify(m, null, 2) + '\n');
  const g = await w.unchanged('get blog --in kits/builds (a case twin in the map)', () => get(['blog', '--in', 'kits/builds', '--json']), { reports: 1 });
  assert.equal(g.code, 1);
  assert.match(jsonOf(g).projects[0].message, /kits\/builds\/Beta-Blog is in the map already for another repository .*: beta-blog would be the same folder/);
  const add = await w.unchanged('find --add with a case twin in the map', () => workspace(['find', '--in', 'kits/builds', '--add', '--json']));
  assert.deepEqual(jsonOf(add).added, [], 'beta-blog counts as in the map');
});

test('a repository renamed on the hosting site is not added again', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-rename', find);
  await workspace(['find', '--in', 'kits/builds', '--add']);
  const o = path.join(w.server, 'alex');
  fs.renameSync(path.join(o, 'shop-alpha-project.git'), path.join(o, 'shop-alfa-project.git'));
  fs.symlinkSync(path.join(o, 'shop-alfa-project.git'), path.join(o, 'shop-alpha-project.git'));
  fs.writeFileSync(path.join(o, 'renamed.json'), JSON.stringify({ 'shop-alpha-project': 'shop-alfa-project' }));
  const r = await w.unchanged('find --add after a rename', () => workspace(['find', '--in', 'kits/builds', '--add', '--json']));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(jsonOf(r).added, []);
  assert.ok(jsonOf(await workspace(['find', '--in', 'kits/builds', '--json'])).inMap.includes('kits/builds/alpha-shop'));
});

test('get --in checks the place before any look-up; on a map of version 1 the refusal says groups need the upgrade', async (tc) => {
  const w = await dryWorld(tc, 'getrule-v1');
  const r = await w.unchanged('get nothere --in projects --dry-run', () => get(['nothere', '--in', 'projects', '--dry-run']));
  assert.equal(r.code, 1);
  assert.match(r.text, /"projects" is not a group or a held folder of the workspace map \(groups need a map of version 2: {2}hoprig workspace map --upgrade\)/);
  assert.doesNotMatch(r.text, /no repository/, 'the hosting site was not asked');
});

test('an organisation whose login starts with "-" is never passed to gh', async () => {
  const { githubOwners } = await import('../../src/pcsetup/workspace.mjs');
  const run = async (argv) => ({ ok: true, stdout: argv.includes('user/orgs') ? '-help\n--json\nteam\n' : 'alex\n' });
  assert.deepEqual(await githubOwners(run), ['alex', 'team']);
});

test('a get by rule whose code repository fails to clone keeps it in the map, and the retry fetches it', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-codefail', find);
  const broken = path.join(w.server, 'team', 'blog-beta-api.git');
  fs.rmSync(path.join(broken, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(broken, 'objects'));
  const r = await get(['blog', '--in', 'kits/builds', '--json']);
  const out = jsonOf(r).projects[0];
  assert.deepEqual([r.code, out.result, out.ok], [1, 'cloned', false]);
  const entry = () => mapOf(w).projects.find((p) => p.in === 'kits/builds' && p.name === 'beta-blog');
  assert.deepEqual(entry().repos.map((x) => x.dir).sort(), ['code/blog-beta-api', 'code/blog-beta-app', 'code/blog-beta-web'], 'the map has every code repository the rule found');
  // The server is repaired: the retry the message names clones what is missing.
  fs.rmSync(broken, { recursive: true });
  w.sh(w.root, 'clone', '-q', '--bare', path.join(w.server, 'team', 'blog-beta-app.git'), broken);
  const again = await get(['kits/builds/beta-blog', '--json']);
  assert.equal(again.code, 0, again.text);
  assert.ok(fs.existsSync(path.join(w.groups.builds, 'beta-blog', 'code', 'blog-beta-api', '.git')), 'cloned by the retry');
  assert.ok(entry().repos.some((x) => x.dir === 'code/blog-beta-api'));
});

test('one organisation GitHub does not list (single sign-on): the look-up uses the other accounts and names it', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-sso', find);
  process.env.FAKE_GH_SAML = 'team'; // the stand-in refuses team's list as GitHub does under single sign-on
  tc.after(() => delete process.env.FAKE_GH_SAML);
  const f = await w.unchanged('find with one account not listed', () => workspace(['find', '--in', 'kits/builds', '--json']));
  assert.equal(f.code, 0, f.text);
  const j = jsonOf(f);
  assert.deepEqual(j.owners, ['alex']);
  assert.match(j.unlisted[0].why, /GitHub did not list the repositories of team: GraphQL: Resource protected by organization SAML enforcement/);
  assert.ok(j.found.some((p) => p.folder === 'alpha-shop'), 'the own account\'s project is found');
  const plain = await workspace(['find', '--in', 'kits/builds']);
  assert.match(plain.text, /GitHub did not list the repositories of team: .*: its repositories were not looked at/);
  const g = await get(['shop', '--in', 'kits/builds', '--json']);
  assert.equal(g.code, 0, g.text);
  assert.equal(jsonOf(g).projects[0].result, 'cloned');
  // A repository named in that account: its own reason, not "no such repository".
  const t = await w.unchanged('get team/… --in with team not listed', () => get(['team/blog-beta-project', '--in', 'kits/builds', '--json']), { reports: 1 });
  assert.equal(t.code, 1);
  assert.match(jsonOf(t).projects[0].message, /GitHub did not list the repositories of team/);
});

test('an address on another host in a place with a naming rule is refused, never matched to the GitHub repository of that name', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-host', find);
  for (const addr of ['https://gitlab.example.com/alex/shop-alpha-project.git', 'git@gitlab.example.com:alex/shop-alpha-project.git', 'https://notgithub.com/alex/shop-alpha-project.git']) {
    const dry = await w.unchanged(`get ${addr} --in --dry-run`, () => get([addr, '--in', 'kits/builds', '--dry-run']));
    assert.equal(dry.code, 1, dry.text);
    assert.match(dry.text, /is not on GitHub, and a place with a naming rule looks its projects up on GitHub: nothing was fetched/);
    const r = await w.unchanged(`get ${addr} --in`, () => get([addr, '--in', 'kits/builds', '--json']), { reports: 1 });
    assert.equal(r.code, 1);
    assert.equal(jsonOf(r).projects[0].result, 'refused');
  }
  assert.ok(!fs.existsSync(path.join(w.groups.builds, 'alpha-shop')));
  // The GitHub address of the same repository is still fetched by the rule.
  const ok = await get(['https://github.com/alex/shop-alpha-project.git', '--in', 'kits/builds', '--json']);
  assert.equal(jsonOf(ok).projects[0].result, 'cloned', ok.text);
});

test('two parents in two accounts that give one folder: the refusal suggests owner/name, and that command fetches it', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-twoowners', find);
  const seed = path.join(w.root, 'seed', 'team', 'shop-alpha-project');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'README.md'), '# other\n');
  w.sh(seed, 'init', '-q', '-b', 'main');
  w.sh(seed, 'add', '-A');
  w.sh(seed, 'commit', '-q', '-m', 'start');
  w.sh(w.root, 'clone', '-q', '--bare', seed, path.join(w.server, 'team', 'shop-alpha-project.git'));
  const a = await w.unchanged('get shop --in (two parents, one folder)', () => get(['shop', '--in', 'kits/builds', '--json']), { reports: 1 });
  const o = jsonOf(a).projects[0];
  assert.equal(a.code, 1);
  assert.deepEqual(o.choices.sort(), ['alex/shop-alpha-project', 'team/shop-alpha-project']);
  assert.match(o.message, /name the repository, for example {2}hoprig get (alex|team)\/shop-alpha-project --in kits\/builds/);
  const c = await get([o.choices.find((x) => x.startsWith('team/')), '--in', 'kits/builds', '--json']);
  assert.deepEqual([c.code, jsonOf(c).projects[0].result], [0, 'cloned'], c.text);
  assert.equal(w.sh(path.join(w.groups.builds, 'alpha-shop'), 'remote', 'get-url', 'origin').trim().endsWith('team/shop-alpha-project.git'), true);
});

test('the dashboard\'s and Tia\'s get of <place>/<folder> that only the hosting site has fetches it by the rule', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-dash', find);
  const { cloneProject } = await import('../../src/pcsetup/project.mjs');
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const lines = [];
  const ui = makeUi({ interactive: false, write: (s) => lines.push(String(s)) });
  let got = null;
  const code = await cloneProject('kits/builds/beta-blog', { ui, onDone: (r) => (got = r) });
  assert.equal(code, 0, lines.join(''));
  assert.deepEqual([got.result, got.found && got.found.parent], ['cloned', 'team/blog-beta-project']);
  assert.ok(fs.existsSync(path.join(w.groups.builds, 'beta-blog', '.git')));
  assert.ok(mapOf(w).projects.some((p) => p.in === 'kits/builds' && p.name === 'beta-blog'), 'its entry is in the map');
  // The route the page and Tia call accepts such a name and says where it goes.
  const { Readable } = await import('node:stream');
  const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [], create: async () => {} }, deck: { launcher: () => ['node', 'x'] } };
  let started = null;
  const f = pcsetupFeature(sctx, { sys: { platform: 'linux', has: () => false, run: async () => ({ ok: false, stdout: '', stderr: '' }), env: process.env, home: process.env.HOME }, projectsDir: () => w.projects, run: async () => ({ ok: false, stdout: '', stderr: '' }), cloneProject: async (spec) => ((started = spec), 0) });
  const [, , route] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/pcsetup/project/clone'));
  const r = await route(Object.assign(Readable.from([]), { body: { spec: 'kits/builds/alpha-shop' } }));
  assert.deepEqual([r.started, r.name, r.place, r.dir], [true, 'alpha-shop', 'kits/builds', path.join(w.groups.builds, 'alpha-shop')]);
  for (let i = 0; i < 100 && started === null; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(started, 'kits/builds/alpha-shop');
});

test('find --add and --place-it leave out a code repository the map has under another project', SHELL_STANDINS, async (tc) => {
  const w = await dryWorld(tc, 'getrule-codeonce', find);
  const m = mapOf(w);
  m.projects.find((p) => p.name === 'shop').repos.push({ dir: 'code/shop-alpha-app', url: 'https://github.com/alex/shop-alpha-app.git' });
  fs.writeFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), JSON.stringify(m, null, 2) + '\n');
  const count = () => mapOf(w).projects.flatMap((p) => [p.url, ...(p.repos || []).map((x) => x.url)]).filter((u) => /shop-alpha-app\.git$/.test(u || '')).length;
  const dry = await w.unchanged('find --add --dry-run', () => workspace(['find', '--in', 'kits/builds', '--add', '--dry-run', '--json']));
  assert.ok(jsonOf(dry).notAdded.some((n) => n.repo === 'alex/shop-alpha-app' && /in the map already, as shop\/code\/shop-alpha-app/.test(n.why)), dry.text);
  const r = await workspace(['find', '--in', 'kits/builds', '--add', '--json']);
  assert.ok(jsonOf(r).added.includes('kits/builds/alpha-shop'));
  assert.equal(count(), 1, 'the address is in the map once');
  const plain = await workspace(['find', '--in', 'kits/builds', '--add']);
  assert.equal(plain.code, 0);
  // --place-it: the same rule for the code repositories it records.
  const m2 = mapOf(w);
  m2.projects = m2.projects.filter((p) => p.name !== 'alpha-shop');
  fs.writeFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), JSON.stringify(m2, null, 2) + '\n');
  const p = await workspace(['find', '--in', 'kits/builds', '--place-it', 'alex/shop-alpha-project', 'alpha-shop', '--json']);
  assert.equal(p.code, 0, p.text);
  assert.ok(!jsonOf(p).entry.repos.some((x) => /shop-alpha-app/.test(x.url)));
  assert.equal(count(), 1);
});
