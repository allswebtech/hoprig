// The naming rule of a place (findrule.mjs), pure: the check refuses a pattern whose parts cannot be told apart, and
// the sorting of a hosting site's repositories finds each project with its code repositories and folder, and lists
// what does not fit exactly as "does not fit", never guessed.
import assert from 'node:assert/strict';
import test from 'node:test';

const F = await import('../../src/workspace/findrule.mjs');
const { validateMap } = await import('../../src/workspace/mapcheck.mjs');

const RULE = { parent: '{project}-{product}-project', code: '{project}-{product}-*', folder: '{product}-{project}', make: ['code', 'apps'], skip: ['old'] };
const rule = () => {
  const c = F.compileFind(RULE);
  assert.equal(c.ok, true, (c.errors || []).join('; '));
  return c.rule;
};
const errs = (f) => {
  const c = F.compileFind(f);
  assert.equal(c.ok, false, `accepted: ${JSON.stringify(f)}`);
  return c.errors.join('; ');
};

test('the check: a good rule passes and is kept as written; make and skip have their defaults', () => {
  const r = rule();
  assert.deepEqual(r.words, ['project', 'product']);
  assert.deepEqual(r.raw, RULE);
  const plain = F.compileFind({ parent: '{name}-site', folder: '{name}' });
  assert.equal(plain.ok, true, (plain.errors || []).join('; '));
  assert.deepEqual(plain.rule.make, ['code']);
  assert.deepEqual(plain.rule.skip, []);
});

test('the check refuses what cannot be told apart, or is no pattern at all', () => {
  assert.match(errs({ parent: '{a}{b}-project', folder: '{a}-{b}' }), /nothing between them/);
  assert.match(errs({ parent: '{a}.{b}-project', folder: '{a}-{b}' }), /around "\." cannot be told apart/);
  assert.match(errs({ parent: '{a}-{b}-project', code: '{a}-{b}*', folder: '{a}-{b}' }), /nothing between them/);
  assert.match(errs({ parent: '{a}-{b}-{c}-project', folder: '{a}-{b}-{c}' }), /one or two placeholders/);
  assert.match(errs({ parent: '{a}-{b}', folder: '{a}-{b}' }), /needs a fixed part/);
  assert.match(errs({ parent: '{a}-{a}-x', folder: '{a}' }), /used twice/);
  assert.match(errs({ parent: '{a}-x', code: '{a}-*-*', folder: '{a}' }), /"\*" is used twice/);
  assert.match(errs({ parent: '{a}-*-x', folder: '{a}' }), /"find.parent" has no "\*"/);
  assert.match(errs({ parent: '{a}-{b}-x', folder: '{a}' }), /uses every placeholder/);
  assert.match(errs({ parent: '{a}-x', folder: '{a}-{c}' }), /\{c\} is not a placeholder of "parent"/);
  assert.match(errs({ parent: '{a}-x', folder: '{a}', code: '{z}-*' }), /\{z\} is not a placeholder/);
  assert.match(errs({ parent: '{1a}-x', folder: '{1a}' }), /not a placeholder/);
  assert.match(errs({ parent: '{a-x', folder: '{a}' }), /pattern of a name|brace/);
  assert.match(errs({ parent: '../{a}', folder: '{a}' }), /pattern of a name/);
  assert.match(errs({ folder: '{a}' }), /needs "parent"/);
  assert.match(errs({ parent: '{a}-x', folder: '{a}', make: ['../x'] }), /"find.make"/);
  assert.match(errs({ parent: '{a}-x', folder: '{a}', make: ['no-ai'] }), /"find.make"/);
  assert.match(errs({ parent: '{a}-x', folder: '{a}', skip: ['o ld'] }), /"find.skip"/);
  assert.match(errs({ parent: '{a}-x', folder: '{a}', other: 1 }), /unknown key "other"/);
});

test('the map\'s check uses it: a bad rule on a held folder is refused with its reason, a good one kept', () => {
  const map = (find) => ({ version: 2, brain: { url: null }, groups: [{ dir: 'kits', url: 'https://github.com/alex/kits.git', holds: [{ dir: 'builds', find }] }], projects: [], others: [] });
  const ok = validateMap(map(RULE));
  assert.equal(ok.ok, true, (ok.errors || []).join('; '));
  assert.deepEqual(ok.map.groups[0].holds[0].find, RULE);
  const bad = validateMap(map({ parent: '{a}{b}-project', folder: '{a}-{b}' }));
  assert.match(bad.errors.join('; '), /kits\/builds: "find.parent": two parts with nothing between them/);
  assert.equal(F.ruleOf(ok.map, 'kits/builds').raw.parent, RULE.parent);
  assert.equal(F.ruleOf(ok.map, 'kits'), null);
  assert.equal(F.ruleOf(ok.map, ''), null);
});

test('matching: a parent\'s words, its folder, the folder\'s words back, a code repository and an excluded word', () => {
  const r = rule();
  assert.deepEqual(F.parentWords(r, 'shop-alpha-project'), { project: 'shop', product: 'alpha' });
  assert.equal(F.parentWords(r, 'a-b-c-project'), null, 'another count of hyphens');
  assert.equal(F.parentWords(r, 'shop-alpha'), null, 'no fixed ending');
  assert.equal(F.folderOf(r, { project: 'shop', product: 'alpha' }), 'alpha-shop');
  assert.deepEqual(F.folderWords(r, 'alpha-shop'), { product: 'alpha', project: 'shop' });
  assert.equal(F.folderWords(r, 'alpha'), null);
  const w = { project: 'shop', product: 'alpha' };
  assert.deepEqual(F.codeFit(r, w, 'shop-alpha-app'), { fits: true });
  assert.deepEqual(F.codeFit(r, w, 'shop-alpha-old-api'), { fits: true, skipped: 'old' });
  assert.deepEqual(F.codeFit(r, w, 'shop-alpha-gold-api'), { fits: true }, 'a word, not a part of one');
  assert.deepEqual(F.codeFit(r, w, 'shop-alpha'), { fits: false });
  assert.deepEqual(F.codeFit(r, w, 'blog-beta-app'), { fits: false });
  assert.equal(F.wordFits(w, 'Shop'), true);
  assert.equal(F.wordFits(w, 'alpha'), true);
  assert.equal(F.wordFits(w, 'sho'), false);
});

test('sorting a hosting site: both projects with their code repositories and folders, the misfits as "does not fit"', () => {
  const repo = (owner, name) => ({ owner, name, url: `https://github.com/${owner}/${name}.git` });
  const repos = [
    ...['shop-alpha-project', 'shop-alpha-app', 'shop-alpha-web', 'shop-alpha-old-api', 'shop-alpha', 'a-b-c-project', 'notes', 'zine-gamma-app'].map((n) => repo('alex', n)),
    ...['blog-beta-project', 'blog-beta-app', 'blog-beta-web', 'blog-beta-api'].map((n) => repo('team', n)),
    repo('team', 'shop-alpha-docs'), // another account: not a code repository of alex's shop-alpha-project
  ];
  const s = F.sortRepos(rule(), repos);
  const brief = s.projects.map((p) => ({ parent: `${p.parent.owner}/${p.parent.name}`, folder: p.folder, code: p.code.map((c) => c.name), skipped: p.skipped.map((c) => c.name) }));
  assert.deepEqual(brief, [
    { parent: 'alex/shop-alpha-project', folder: 'alpha-shop', code: ['shop-alpha-app', 'shop-alpha-web'], skipped: ['shop-alpha-old-api'] },
    { parent: 'team/blog-beta-project', folder: 'beta-blog', code: ['blog-beta-api', 'blog-beta-app', 'blog-beta-web'], skipped: [] },
  ]);
  const mis = Object.fromEntries(s.misfits.map((m) => [`${m.repo.owner}/${m.repo.name}`, m.why]));
  assert.deepEqual(Object.keys(mis).sort(), ['alex/a-b-c-project', 'alex/shop-alpha', 'alex/shop-alpha-old-api', 'alex/zine-gamma-app', 'team/shop-alpha-docs'].sort());
  assert.match(mis['alex/a-b-c-project'], /another count of hyphens/);
  assert.match(mis['alex/shop-alpha'], /without its fixed part "-project"/);
  assert.match(mis['alex/shop-alpha-old-api'], /the word "old"/);
  assert.match(mis['alex/zine-gamma-app'], /no parent zine-gamma-project/);
  assert.match(mis['team/shop-alpha-docs'], /no parent shop-alpha-project/, 'a parent in another account does not take it');
  assert.ok(!mis['alex/notes'], 'a repository that has nothing to do with the place is not listed');
});

test('a code pattern holds every placeholder of the parent: else every repository of the account would be one project\'s code', () => {
  for (const code of ['*', 'x-*', '{project}-*', '{product}-x-*']) assert.match(errs({ ...RULE, code }), /"find\.code" uses every placeholder of "parent"/, code);
  // What the review saw: code "{project}-*" gave beta's repositories to alpha by the order of the list.
  const ok = F.compileFind({ ...RULE, code: '{project}-{product}-*' });
  assert.equal(ok.ok, true);
  const s = F.sortRepos(ok.rule, ['shop-alpha-project', 'shop-beta-project', 'shop-alpha-app', 'shop-beta-app', 'shop-beta-web'].map((name) => ({ owner: 'alex', name, url: `https://github.com/alex/${name}.git` })));
  assert.deepEqual(s.projects.map((p) => [p.folder, p.code.map((c) => c.name)]), [['alpha-shop', ['shop-alpha-app']], ['beta-shop', ['shop-beta-app', 'shop-beta-web']]]);
});

test('a placeholder is a plain lower-case word, never a name every object has; nothing reads an object\'s prototype', () => {
  for (const w of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'Project', 'my_word']) {
    assert.match(errs({ parent: `{${w}}-project`, folder: `{${w}}` }), /is not a placeholder/, w);
    const m = { version: 2, brain: { url: null }, groups: [{ dir: 'kits', url: 'https://git.example.test/team/kits.git', holds: [{ dir: 'builds', find: { parent: `{${w}}-project`, folder: `{${w}}` } }] }], projects: [], others: [] };
    assert.equal(validateMap(m).ok, false, `the map check refuses {${w}}`);
  }
  const r = rule();
  assert.equal(F.fillIn(r.folder, { project: 'shop', product: 'alpha' }), 'alpha-shop');
  assert.deepEqual(F.parentWords(r, 'toString-constructor-project'), { project: 'toString', product: 'constructor' }, 'words that are such names are only data');
  assert.deepEqual(F.codeFit(r, Object.assign(Object.create(null), { project: 'shop', product: 'alpha' }), 'shop-alpha-app'), { fits: true });
});

test('make: plain names, never ai_brain, each once whatever its letter case', () => {
  assert.match(errs({ ...RULE, make: ['ai_brain'] }), /not ai_brain/);
  assert.match(errs({ ...RULE, make: ['AI_Brain'] }), /not ai_brain/);
  assert.match(errs({ ...RULE, make: ['CODE', 'code'] }), /each once whatever its letter case/);
  assert.equal(F.compileFind({ ...RULE, make: ['code', 'Apps'] }).ok, true);
});

test('the map check: two names in one place that differ only in case, and one address twice in a place with a rule, are refused when written', () => {
  const base = () => ({ version: 2, brain: { url: null }, groups: [{ dir: 'kits', url: 'https://git.example.test/team/kits.git', holds: [{ dir: 'builds', find: RULE }, { dir: 'other' }] }], others: [] });
  const u = (n) => `https://github.com/alex/${n}.git`;
  const caseTwins = { ...base(), projects: [{ name: 'alpha-shop', in: 'kits/builds', url: u('shop-alpha-project'), repos: [] }, { name: 'Alpha-shop', in: 'kits/builds', url: u('x-project'), repos: [] }] };
  assert.equal(validateMap(caseTwins).ok, true, 'read: the owner can still see and fix it');
  assert.match(validateMap(caseTwins, { write: true }).errors.join(' '), /differ only in letter case/);
  const sameAddress = { ...base(), projects: [{ name: 'alpha-shop', in: 'kits/builds', url: u('shop-alpha-project'), repos: [] }, { name: 'second', in: 'kits/builds', url: u('shop-alpha-project'), repos: [] }] };
  assert.match(validateMap(sameAddress, { write: true }).errors.join(' '), /same address: in a place with a naming rule one repository is in the map once/);
  // Without a rule two names may keep one address (two clones someone keeps), as before.
  const noRule = { ...base(), projects: [{ name: 'a', in: 'kits/other', url: u('a'), repos: [] }, { name: 'a-copy', in: 'kits/other', url: u('a'), repos: [] }] };
  assert.equal(validateMap(noRule, { write: true }).ok, true);
});
