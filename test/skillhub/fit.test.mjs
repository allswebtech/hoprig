// Skills that fit a project's technology (src/skillhub/fit.mjs): the low-risk rule, the order "find before create" (a
// skill of his own is named and not copied; a low-risk catalog skill at its reviewed version goes in through review and
// approve, with Undo; anything else waits), a refusal that changes nothing, and the first-code fit (once, only with the
// choice on). The catalog entries are the test's own, fetched from local git repositories: never the network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gitRepo, sandbox, skillMd, writeTree } from './helpers.mjs';

const box = sandbox('skills-fit');
test.after(() => box.cleanup());
const fit = await import('../../src/skillhub/fit.mjs');
const hub = await import('../../src/skillhub/hub.mjs');
const { listInstalled, scopeOf } = await import('../../src/skillhub/store.mjs');
const { skillhubFeature } = await import('../../src/skillhub/feature.mjs');

const allowed = (real) => real === box.home || real.startsWith(`${box.home}${path.sep}`);
/** Every path below `dir` with its kind and content hash. */
function tree(dir) {
  const out = {};
  const walk = (rel) => {
    let list;
    try {
      list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        out[r] = 'dir';
        walk(r);
      } else out[r] = d.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex') : 'other';
    }
  };
  walk('');
  return out;
}

const repo = gitRepo(path.join(box.root, 'skills-repo'), {
  'next-tips/SKILL.md': skillMd('next-tips', 'Prefer server components.\n'),
  'next-script/SKILL.md': skillMd('next-script'),
  'next-script/run.sh': 'echo hello\n',
  'next-newer/SKILL.md': skillMd('next-newer'),
});
const later = repo.commit({ 'next-newer/SKILL.md': skillMd('next-newer', 'A newer text nobody reviewed.\n') });
const entry = (id, more = {}) => ({ id, skill: id, for: `The ${id} skill, for a test.`, license: 'MIT', repo: 'example/skills', path: id, commit: repo.first, signals: ['npm:next'], ...more });
const ENTRIES = [
  entry('next-tips'),
  entry('next-script'),
  entry('next-tool', { tool: { id: 'x', bin: 'x', npm: 'x', versionArgs: ['--version'] } }),
  entry('next-newer'),
  entry('flutter-only', { signals: ['pub:flutter'] }),
  entry('for-everyone', { signals: ['always'] }),
];
// The stand-in for hub.prepare(<catalog id>): the entry's folder from the local repository, at the commit it names
// (next-newer: a later one, as a skill from outside the catalog's reviewed version would be).
const prepare = (e, o) => hub.prepare(`${repo.url}#${e.path}`, { ...o, commit: e.id === 'next-newer' ? later : e.commit });
const userSkills = path.join(box.claude, 'skills');
writeTree(userSkills, { 'next-patterns/SKILL.md': skillMd('next-patterns'), 'writing/SKILL.md': skillMd('writing') });

const review = (o = {}) => ({ files: [{ path: 'SKILL.md', kind: 'text', mode: 0o644, size: 40 }], skillMd: skillMd('x'), findings: [], total: 40, catalog: null, ...o });

test('low-risk: text files only, nothing to run, no link, no tool asked for or needed, a clean scan, small', () => {
  assert.deepEqual(fit.lowRisk(review()), { ok: true, why: [] });
  assert.equal(fit.lowRisk(review({ files: [...review().files, { path: 'notes.txt', kind: 'text', mode: 0o644, size: 3 }] })).ok, true, '.txt is text too');
  const no = (r, e, re) => {
    const got = fit.lowRisk(r, e);
    assert.equal(got.ok, false, String(re));
    assert.match(got.why.join('; '), re);
  };
  no(review({ files: [...review().files, { path: 'run.sh', kind: 'script', mode: 0o644, size: 9 }] }), null, /run\.sh is not a text file/);
  no(review({ files: [...review().files, { path: 'tool.md', kind: 'text', mode: 0o755, size: 9 }] }), null, /tool\.md can be run/);
  no(review({ files: [...review().files, { path: 'more.md', kind: 'symlink', mode: 0, size: 0, link: 'SKILL.md' }] }), null, /more\.md is a link/);
  no(review({ files: [...review().files, { path: 'logo.png', kind: 'asset', mode: 0o644, size: 9 }] }), null, /logo\.png is not a text file/);
  no(review({ skillMd: skillMd('x', 'Body.\n', 'allowed-tools: Bash\n') }), null, /asks for allowed-tools/);
  no(review({ skillMd: skillMd('x', 'Body.\n', 'tools: [web]\n') }), null, /asks for tools/);
  no(review(), { tool: { id: 't' } }, /needs a tool/);
  no(review(), { tools: ['t'] }, /needs a tool/);
  no(review({ findings: [{ rule: 'network', severity: 'low' }] }), null, /the scan found 1 thing/);
  no(review({ total: fit.LOW_RISK.bytes + 1 }), null, /bigger than/);
  no(review({ files: Array.from({ length: fit.LOW_RISK.files + 1 }, (_, i) => ({ path: `f${i}.md`, kind: 'text', mode: 0o644, size: 1 })) }), null, /bigger than/);
  no(review({ files: [] }), null, /no files/);
});

test('the order: his own skill is named and not copied; a low-risk catalog skill goes in with its record and Undo; the rest waits', async () => {
  const dir = writeTree(path.join(box.home, 'shop'), { 'package.json': JSON.stringify({ dependencies: { next: '16.0.1' } }) });
  const userBefore = tree(userSkills);
  const r = await fit.fitProject({ dir, allowed, entries: ENTRIES, prepare });
  assert.equal(r.code, true);
  assert.deepEqual(r.mine.map((m) => m.name), ['next-patterns'], 'his own skill whose name holds the technology');
  assert.match(r.mine[0].why[0], /package\.json has next 16\.0\.1/);
  assert.deepEqual(tree(userSkills), userBefore, 'his own skills are not touched');
  assert.ok(!fs.existsSync(path.join(dir, '.claude/skills/next-patterns')), 'and not copied into the project');
  assert.deepEqual(r.added.map((a) => a.name), ['next-tips'], 'the low-risk one at its reviewed version');
  const listed = listInstalled(scopeOf({ project: dir })).find((s) => s.name === 'next-tips');
  assert.ok(listed && listed.managed, 'installed with its record');
  assert.equal(listed.source.commit, repo.first);
  assert.deepEqual(r.waiting.map((w) => w.name).sort(), ['next-newer', 'next-script', 'next-tool']);
  const why = Object.fromEntries(r.waiting.map((w) => [w.name, w.reasons.join('; ')]));
  assert.match(why['next-script'], /run\.sh is not a text file/);
  assert.match(why['next-tool'], /needs a tool/);
  assert.match(why['next-newer'], /not the version the catalog reviewed/, 'a version from outside the reviewed one never goes in by itself');
  for (const n of ['next-script', 'next-tool', 'next-newer', 'flutter-only', 'for-everyone']) assert.ok(!fs.existsSync(path.join(dir, '.claude/skills', n)), `${n} is not in the project`);
  assert.ok(!r.waiting.some((w) => w.name === 'flutter-only') && !r.added.some((w) => w.name === 'for-everyone'), 'only what fits its technology');
  // The lists the page shows, and Undo (the page's Remove, kept for undo; undo brings it back).
  fit.recordFit(dir, r, { firstCode: r.code });
  assert.equal(fit.fitLists(dir, { allowed }).added[0].here, true);
  hub.remove('next-tips', { project: dir }, { allowed });
  assert.ok(!fs.existsSync(path.join(dir, '.claude/skills/next-tips')), 'Undo takes it out');
  assert.equal(fit.fitLists(dir, { allowed }).added[0].here, false);
  hub.undo('next-tips', { project: dir }, { allowed });
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/next-tips/SKILL.md')), 'and it can be put back');
  // Run again: what is in the project is not offered twice.
  const again = await fit.fitProject({ dir, allowed, entries: ENTRIES, prepare });
  assert.deepEqual(again.added, []);
});

test('a refusal changes nothing: a folder outside the dashboard\'s, and a fit where everything waits', async () => {
  const outside = writeTree(path.join(box.root, 'elsewhere'), { 'package.json': JSON.stringify({ dependencies: { next: '1' } }) });
  const before = tree(box.root);
  await assert.rejects(fit.fitProject({ dir: outside, allowed, entries: ENTRIES, prepare }), /outside the folders/);
  assert.deepEqual(tree(box.root), before, 'the whole temporary home is as it was');
  const dir = writeTree(path.join(box.home, 'waits'), { 'package.json': JSON.stringify({ dependencies: { next: '1' } }) });
  const proj = tree(dir);
  const user = tree(userSkills);
  const r = await fit.fitProject({ dir, allowed, entries: ENTRIES.filter((e) => e.id !== 'next-tips'), prepare });
  assert.deepEqual(r.added, []);
  assert.deepEqual(tree(dir), proj, 'nothing written into the project');
  assert.deepEqual(tree(userSkills), user);
  assert.deepEqual(fs.readdirSync(path.join(box.state, 'skillhub', 'quarantine')), [], 'no review left behind');
});

test('the first-code fit: once a project has code, once, and only when its choice is on; the choice is kept in Hoprig\'s state', async () => {
  const empty = writeTree(path.join(box.home, 'fresh'), { 'AGENTS.md': '# Rules\n' });
  const off = writeTree(path.join(box.home, 'off'), { 'package.json': '{"dependencies":{"next":"1"}}' });
  const seen = [];
  const stub = async ({ dir }) => (seen.push(dir), { project: dir, at: 'now', code: true, mine: [], added: [], waiting: [] });
  assert.deepEqual(fit.fitChoice(empty), { fit: false, firstCode: false, last: null }, 'off unless chosen');
  fit.setFitChoice(empty, true);
  fit.setFitChoice(off, false);
  assert.ok(!fs.existsSync(path.join(empty, '.claude')) && fs.existsSync(path.join(box.state, 'skillhub', 'fit.json')), 'in the state, never in the project');
  assert.deepEqual(await fit.firstCodeFits({ allowed, fit: stub }), []);
  assert.deepEqual(seen, [], 'no code yet: nothing');
  writeTree(empty, { 'package.json': JSON.stringify({ dependencies: { next: '16.0.1' } }) });
  await fit.firstCodeFits({ allowed, fit: stub });
  assert.deepEqual(seen, [fs.realpathSync(empty)], 'once it has code');
  assert.equal(fit.fitChoice(empty).firstCode, true);
  await fit.firstCodeFits({ allowed, fit: stub });
  assert.equal(seen.length, 1, 'and only once');
  assert.ok(!seen.includes(fs.realpathSync(off)), 'never with the choice off');
  // Through the skills feature's hourly look (a block of its own beside the weekly check).
  const other = writeTree(path.join(box.home, 'other'), { 'go.mod': 'module example.com/x\n\ngo 1.22\n' });
  fit.setFitChoice(other, true);
  const f = skillhubFeature({ config: () => ({ server: { roots: [box.home] } }), readJson: async (q) => q.body || {}, notify: async () => ({}) }, { fit: stub });
  await f.firstCodeFit();
  assert.deepEqual(seen.slice(1), [fs.realpathSync(other)]);
});

test('the routes: the lists, and the switch (owner only, true or false, inside the dashboard\'s folders)', async () => {
  const f = skillhubFeature({ config: () => ({ server: { roots: [box.home] } }), readJson: async (q) => q.body || {}, notify: async () => ({}) });
  const call = async (method, p, body, headers = {}) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Object.assign(Readable.from([]), { body, headers }), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  const dir = path.join(box.home, 'shop');
  const lists = await call('GET', `/api/skillhub/fit?project=${encodeURIComponent(dir)}`);
  assert.equal(lists.fit, false, 'shop was fitted by hand above; its choice was never switched on');
  assert.deepEqual(lists.added.map((a) => [a.name, a.here]), [['next-tips', true]]);
  assert.deepEqual(lists.mine.map((m) => m.name), ['next-patterns']);
  assert.equal((await call('POST', '/api/skillhub/fit/choice', { project: dir, fit: true })).fit, true);
  assert.equal(fit.fitChoice(dir).fit, true);
  assert.equal((await call('POST', '/api/skillhub/fit/choice', { project: dir, fit: false })).fit, false);
  await assert.rejects(call('POST', '/api/skillhub/fit/choice', { project: dir, fit: 'yes' }), /fit is true or false/);
  await assert.rejects(call('POST', '/api/skillhub/fit/choice', { project: path.join(box.root, 'elsewhere'), fit: true }), /outside the folders/);
  await assert.rejects(call('POST', '/api/skillhub/fit/choice', { project: dir, fit: true }, { authorization: 'Bearer tia_0123456789abcdef' }), /owner only/);
  await assert.rejects(call('GET', '/api/skillhub/fit?project=relative/x'), /absolute folder path/);
  assert.equal(fit.fitChoice(dir).fit, false, 'the refused ones changed nothing');
});
