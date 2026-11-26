// A project's needs and a session's extra folders (src/workspace/needs.mjs): the one decision of what may be an extra
// folder, and what a session gets for each one. Throw-away workspace: `shop` needs `kits/parts` (needsfix.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { needsWorld } from './needsfix.mjs';

const N = await import('../../src/workspace/needs.mjs');
const W = await import('../../src/pcsetup/workspace.mjs');
// A folder as a rule of the coding tool names it (on Windows its POSIX form, `C:\a` → `/c/a`; elsewhere the path itself).
const { ruleForm } = await import('../../src/workspace/needswalk.mjs');

test('project.json: "needs" is a known key, each name checked; a path or an odd name is named and left out, never a refusal', () => {
  const v = W.validateManifest({ name: 'shop', repos: [], memories: {}, needs: ['kits/parts', '../x', '/etc', 'kits/parts', 'a b', 7] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.manifest.needs, ['kits/parts']);
  assert.equal(v.warnings.filter((w) => w.startsWith('needs: ')).length, 4);
  assert.ok(!v.warnings.some((w) => /unknown key "needs"/.test(w)));
  const many = W.validateManifest({ name: 'shop', needs: Array.from({ length: 70 }, (_, i) => `p${i}`) });
  assert.equal(many.manifest.needs.length, W.NEEDS_MAX);
  assert.ok(many.warnings.some((w) => /20 more needs/.test(w)));
  assert.equal(W.validateManifest({ name: 'shop', needs: 'kits/parts' }).ok, true, 'not a list: a warning, not a refusal');
});

test('rule 1 and 6: what an extra folder may be, by any spelling', async () => {
  const w = needsWorld('needs-names');
  try {
    const self = fs.realpathSync(w.shop);
    const at = (n) => N.extraFolder(n, { map: w.map, ctx: w.ctx, self });
    const ok = await at('kits/parts');
    assert.equal(ok.ok, true);
    assert.equal(ok.dir, fs.realpathSync(w.parts));
    assert.equal((await at('blog')).ok, true, 'a project of the projects folder');
    assert.equal((await at('projects/blog')).ok, true);
    for (const bad of ['credentials', 'Credentials', 'credentials/shop', 'kits/credentials', 'ai_brain', 'AI_BRAIN', '../credentials', './kits/parts', 'kits/parts/', '/etc', 'kits//parts', `${w.ws}/kits/parts`, 'kits/no-ai', 'tools', 'kits/../credentials', '', null, 'shop', 'projects/shop', 'nothing-here']) {
      const r = await at(bad);
      assert.equal(r.ok, false, String(bad));
      assert.ok(r.why && r.why.length > 10, String(bad));
    }
    assert.match((await at('tools')).why, /"tools" is a group as a whole: name one project of it \(tools\/<name>\)/);
    assert.match((await at('kits')).why, /name one project of it \(kits\/<name>, such as kits\/parts\)/);
    assert.match((await at('shop')).why, /session's own folder/);
    assert.match((await at('nothing-here')).why, /has no project "nothing-here"/);
    // In the map, not here: refused with the get.
    const docs = await at('docs');
    assert.equal(docs.here, false);
    assert.equal(docs.fix, 'hoprig get docs');
    // A project folder that is a link into the credentials folder, or out of the workspace: never opened.
    fs.renameSync(path.join(w.projects, 'blog'), path.join(w.root, 'blog-away'));
    fs.symlinkSync(path.join(w.root, 'blog-away'), path.join(w.projects, 'blog'));
    assert.equal((await at('blog')).ok, false, 'a link out of the workspace');
    fs.rmSync(path.join(w.projects, 'blog'));
    fs.symlinkSync(path.join(w.ws, 'credentials'), path.join(w.projects, 'blog'));
    const c = await at('blog');
    assert.equal(c.ok, false);
    assert.match(c.why, /link|credentials/);
  } finally {
    w.cleanup();
  }
});

test('rule 3: a session in shop gets kits/parts; a need not here is named with its get, never fetched', async () => {
  const w = needsWorld('needs-session', { shopNeeds: ['kits/parts', 'docs', 'credentials', 'shop'] });
  try {
    const ex = await N.sessionExtras(path.join(w.shop, 'code'), { dir: w.ws, projects: w.projects });
    assert.equal(ex.project, 'shop');
    assert.deepEqual(ex.refs, ['kits/parts']);
    assert.deepEqual(ex.dirs, [fs.realpathSync(w.parts)]);
    assert.deepEqual(ex.missing, [{ ref: 'docs', fix: 'hoprig get docs', of: 'shop' }]);
    assert.equal(ex.warnings.length, 2, 'credentials and itself: warnings, never a stop');
    assert.deepEqual(ex.refused, []);
    const note = N.startNote(ex).join('\n');
    assert.match(note, /extra folders to read \(its file tools cannot write there; a shell command still could\): kits\/parts/);
    assert.match(note, /shop needs docs, which is not on this computer \(nothing is fetched\): hoprig get docs/);
    assert.ok(!fs.existsSync(path.join(w.projects, 'docs')), 'nothing fetched');
    // A folder of no project, and no needs: nothing.
    const none = await N.sessionExtras(w.root, { dir: w.ws, projects: w.projects });
    assert.deepEqual(none.dirs, []);
  } finally {
    w.cleanup();
  }
});

test('rule 7: --with gives one more entry for one session; a name not here or refused stops the start with why', async () => {
  const w = needsWorld('needs-with', { shopNeeds: [] });
  try {
    const before = fs.readFileSync(path.join(w.shop, 'project.json'), 'utf8');
    const ex = await N.sessionExtras(w.shop, { withs: ['kits/parts', 'blog'], dir: w.ws, projects: w.projects });
    assert.deepEqual(ex.refs, ['kits/parts', 'blog']);
    assert.deepEqual(ex.refused, []);
    assert.equal(fs.readFileSync(path.join(w.shop, 'project.json'), 'utf8'), before, 'nothing written to project.json');
    const no = await N.sessionExtras(w.shop, { withs: ['docs', 'credentials', '../credentials'], dir: w.ws, projects: w.projects });
    assert.deepEqual(no.dirs, []);
    assert.equal(no.refused.length, 3);
    assert.match(no.refused[0], /hoprig get docs/);
    const lots = await N.sessionExtras(w.shop, { withs: Array.from({ length: 11 }, () => 'blog'), dir: w.ws, projects: w.projects });
    assert.ok(lots.refused.some((r) => /at most 10/.test(r)));
  } finally {
    w.cleanup();
  }
});

test('rules 4 and 5: the settings an extra folder brings: no writing, its private folders, credential links and own deny rules; never its allow rules', async () => {
  const w = needsWorld('needs-settings');
  try {
    const dir = fs.realpathSync(w.parts);
    const d = ruleForm(dir);
    const s = await N.extraSettings([dir], { dir: w.ws });
    assert.deepEqual(s.additionalDirectories, [dir]);
    for (const r of [`Edit(/${d}/**)`, `Write(/${d}/**)`, `NotebookEdit(/${d}/**)`, `Read(/${d}/ai-ignore-dir/**)`, `Read(/${d}/**/no-ai/**)`, `Read(/${d}/.env)`, `Read(/${d}/deep/keys)`, `Read(/${d}/deep/keys/**)`, `Read(/${d}/hidden/**)`, `Read(/${d}/notes.txt)`]) {
      assert.ok(s.deny.includes(r), r);
    }
    assert.ok(s.deny.every((r) => r.startsWith('Edit(//') || r.startsWith('Write(//') || r.startsWith('NotebookEdit(//') || r.startsWith('Read(//')), 'every rule names the folder by its absolute path');
    assert.ok(!JSON.stringify(s).includes('Bash(rm'), 'its allow rules never travel');
    assert.ok(!JSON.stringify(s).includes('allow'), 'no allow at all');
    // Added to the settings Hoprig hands the session, keeping what is there.
    const merged = N.withExtras({ hooks: { a: 1 }, permissions: { allow: ['Bash(ls)'] } }, s);
    assert.deepEqual(merged.hooks, { a: 1 });
    assert.deepEqual(merged.permissions.allow, ['Bash(ls)']);
    assert.equal(merged.permissions.deny.length, s.deny.length);
    assert.equal(N.withExtras({ x: 1 }, null).x, 1);
    // Re-basing: a rule that climbs out covers the whole folder; one that is not for files is not taken.
    assert.deepEqual(N.rebase('Read(../../x)', '/a/b'), ['Read(//a/b/**)']);
    assert.equal(N.rebase('Bash(curl:*)', '/a/b'), null);
    assert.deepEqual(N.rebase('Read', '/a/b'), ['Read(//a/b/**)']);
  } finally {
    w.cleanup();
  }
});

test('get and status: what is missing, a need of a need named with whose it is, a loop ends', async () => {
  const w = needsWorld('needs-get', { shopNeeds: ['kits/parts', 'docs'], partsNeeds: ['blog', 'shop', 'docs'] });
  try {
    // parts says it needs blog (here), shop (the one asking: a loop) and docs (not here, named once)
    fs.rmSync(path.join(w.projects, 'blog'), { recursive: true });
    const g = await N.needsToGet(w.shop, 'shop', { map: w.map, ctx: w.ctx });
    assert.deepEqual(g.needs, ['kits/parts', 'docs']);
    assert.deepEqual(g.missing, [{ name: 'docs', of: 'shop' }, { name: 'blog', of: 'kits/parts' }]);
    const st = await N.needsHere({ dir: w.ws, projects: w.projects });
    const shop = st.find((x) => x.project === 'shop');
    assert.deepEqual(shop.missingNeeds, [{ name: 'docs', fix: 'hoprig get docs' }]);
    const parts = st.find((x) => x.project === 'kits/parts');
    assert.deepEqual(parts.missingNeeds.map((x) => x.name).sort(), ['blog', 'docs']);
    assert.equal(parts.refused.length, 0, 'shop is a project of the map: a loop, not a refusal');
  } finally {
    w.cleanup();
  }
});

test('rule 8: which projects here need an entry (direct needs only)', async () => {
  const w = needsWorld('needs-by', { shopNeeds: ['kits/parts'], partsNeeds: ['blog'] });
  try {
    assert.deepEqual(await N.neededBy('kits/parts', { ctx: w.ctx }), ['shop']);
    assert.deepEqual(await N.neededBy('blog', { ctx: w.ctx }), ['kits/parts']);
    assert.deepEqual(await N.neededBy('shop', { ctx: w.ctx }), []);
    fs.rmSync(w.shop, { recursive: true });
    assert.deepEqual(await N.neededBy('kits/parts', { ctx: w.ctx }), [], 'a project not on this computer does not count');
  } finally {
    w.cleanup();
  }
});

test('"Also open": what may be ticked, the project\'s own needs shown as included', async () => {
  const w = needsWorld('needs-choices', { shopNeeds: ['kits/parts', 'docs'] });
  try {
    const c = await N.extraChoices(w.shop, { dir: w.ws, projects: w.projects });
    assert.equal(c.project, 'shop');
    assert.deepEqual(c.needs, [{ name: 'kits/parts', here: true, accepted: true }, { name: 'docs', here: false, accepted: true, fix: 'hoprig get docs' }]);
    fs.writeFileSync(path.join(w.shop, 'project.json'), JSON.stringify({ name: 'shop', repos: [], memories: {}, needs: ['credentials'] }));
    const r = await N.extraChoices(w.shop, { dir: w.ws, projects: w.projects });
    assert.equal(r.needs[0].name, 'credentials');
    assert.equal(r.needs[0].here, false);
    assert.match(r.needs[0].why, /credentials folder/, 'a refused need says why');
    assert.deepEqual(c.choices, ['blog']);
  } finally {
    w.cleanup();
  }
});

test('rule 6: a need with a link to the workspace root, the credentials folder, the brain, or a folder holding a credential link is refused, naming the link', async () => {
  const w = needsWorld('needs-links');
  try {
    const self = fs.realpathSync(w.shop);
    const at = () => N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self });
    assert.equal((await at()).ok, true, 'its own credential links (to a file, to a folder inside the credentials folder) are allowed');
    const tries = [
      ['up', w.ws, /its link up leads to a folder that holds the credentials folder/],
      ['keys', path.join(w.ws, 'credentials'), /its link keys leads to the credentials folder/],
      ['mem', path.join(w.ws, 'ai_brain'), /its link mem leads to the AI brain/],
    ];
    for (const [name, to, re] of tries) {
      const l = path.join(w.parts, name);
      fs.symlinkSync(to, l);
      const r = await at();
      assert.equal(r.ok, false, name);
      assert.match(r.why, re);
      fs.rmSync(l);
    }
    // A link to a folder outside the need that itself holds a link into the credentials folder.
    fs.mkdirSync(path.join(w.ws, 'shared-conf'));
    fs.symlinkSync(path.join(w.ws, 'credentials', 'shop', 'key.txt'), path.join(w.ws, 'shared-conf', '.env'));
    fs.symlinkSync(path.join(w.ws, 'shared-conf'), path.join(w.parts, 'conf'));
    const r = await at();
    assert.equal(r.ok, false);
    assert.match(r.why, /its link conf\/\.env leads into the credentials folder/);
    const ex = await N.sessionExtras(w.shop, { dir: w.ws, projects: w.projects });
    assert.deepEqual(ex.dirs, [], 'the session gets no extra folder');
    assert.ok(ex.warnings.some((x) => /conf\/\.env/.test(x)), 'the start says why');
    const no = await N.sessionExtras(w.shop, { withs: ['kits/parts'], dir: w.ws, projects: w.projects });
    assert.match(no.refused.join(' '), /conf\/\.env/, '--with is refused the same way');
    // The settings, should a link change after the decision: Read is closed on the whole folder.
    const s = await N.extraSettings([fs.realpathSync(w.parts)], { dir: w.ws });
    assert.ok(s.deny.includes(`Read(/${ruleForm(fs.realpathSync(w.parts))}/**)`));
  } finally {
    w.cleanup();
  }
});

test('rule 6: a link in .git or node_modules of the need is checked too (git keeps links, so a cloned need can carry one)', async () => {
  const w = needsWorld('needs-links-hidden');
  try {
    const self = fs.realpathSync(w.shop);
    const at = () => N.extraFolder('kits/parts', { map: w.map, ctx: w.ctx, self });
    const tries = [
      ['node_modules/up', w.ws, /its link node_modules\/up leads to a folder that holds the credentials folder/],
      ['.git/up', w.home, /its link \.git\/up leads to a folder that holds the credentials folder/],
    ];
    for (const [rel, to, re] of tries) {
      const l = path.join(w.parts, rel);
      fs.mkdirSync(path.dirname(l), { recursive: true });
      fs.symlinkSync(to, l);
      const r = await at();
      assert.equal(r.ok, false, rel);
      assert.match(r.why, re, rel);
      fs.rmSync(l);
    }
  } finally {
    w.cleanup();
  }
});

test('rule 5: a deny rule of the need without a slash holds at any depth, as in the need\'s own session', async () => {
  // Claude Code reads Read(secret.txt) like .gitignore: secret.txt anywhere below the project. Re-based onto the extra
  // folder it must keep that meaning, or kits/parts/sub/secret.txt is readable from shop's session.
  assert.deepEqual(N.rebase('Read(secret.txt)', '/a/b'), ['Read(//a/b/secret.txt)', 'Read(//a/b/**/secret.txt)']);
  assert.deepEqual(N.rebase('Read(*.pem)', '/a/b'), ['Read(//a/b/*.pem)', 'Read(//a/b/**/*.pem)']);
  assert.deepEqual(N.rebase('Read(hidden/)', '/a/b'), ['Read(//a/b/hidden/)', 'Read(//a/b/**/hidden/)']);
  // A "/" in it (also ./p and /p, the project's top) keeps it anchored there.
  assert.deepEqual(N.rebase('Read(/top.txt)', '/a/b'), ['Read(//a/b/top.txt)']);
  assert.deepEqual(N.rebase('Read(./hidden/**)', '/a/b'), ['Read(//a/b/hidden/**)']);
  assert.deepEqual(N.rebase('Read(a/b.txt)', '/a/b'), ['Read(//a/b/a/b.txt)']);
  const w = needsWorld('needs-anydepth');
  try {
    const d = fs.realpathSync(w.parts);
    const s = await N.extraSettings([d], { dir: w.ws });
    assert.ok(s.deny.includes(`Read(/${ruleForm(d)}/**/notes.txt)`), 'settings.local.json\'s Read(notes.txt) at any depth');
  } finally {
    w.cleanup();
  }
});
