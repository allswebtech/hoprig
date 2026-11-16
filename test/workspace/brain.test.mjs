// The AI brain view on a temporary home: what the index lists, and the refusals (each a test): nothing outside the
// roots (no "..", no absolute path, no link out), private folders never listed, opened or counted, credentials,
// dot-files, .env and key files and anything not plain text never returned, secrets masked, size capped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome, writeTree } from './helpers.mjs';

const t = tempHome('ws-brain');
test.after(() => t.cleanup());
const { brainIndex, brainRead } = await import('../../src/workspace/brain.mjs');
const { checkFile, MAX_BYTES } = await import('../../src/workspace/guard.mjs');

const brain = path.join(t.ws, 'ai_brain');
const projects = path.join(t.ws, 'projects');
const slug = t.home.replace(/[^A-Za-z0-9]/g, '-');
const outside = writeTree(path.join(t.root, 'outside'), { 'secret.md': 'OUTSIDE-TEXT\n', 'skill/SKILL.md': '---\nname: far\ndescription: far away\n---\n' });
const mem = (name, desc, type) => `---\nname: ${name}\ndescription: ${desc}\ntype: ${type}\n---\n\nbody\n`;

writeTree(brain, {
  'BRAIN.md': '# AI brain\n',
  'learnings.md': '# Learnings\n- token in a note: ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop0123456789\n',
  'active_context.md': '# Now\n',
  'PENDING.md': '# Pending\n- the Mac\n',
  'claude/CLAUDE.md': '# Rules\n',
  'daily_logs/2026-11-12.md': 'day one\n',
  'daily_logs/2026-11-14.md': 'day three\n',
  'daily_logs/2026-11-13.md': 'day two\n',
  'daily_logs/picture.png': 'not text',
  'skills/tidy/SKILL.md': '---\nname: tidy\ndescription: Keep the code tidy.\n---\n# tidy\n',
  'skills/no-ai/SKILL.md': '---\nname: hidden\ndescription: never\n---\n',
  'claude-memory/home/.gitkeep': '',
  'no-ai/diary.md': 'PRIVATE-NOTE\n',
  'ignore/x.md': 'PRIVATE-NOTE\n',
  'ai-ignore-dir/x.md': 'PRIVATE-NOTE\n',
  'credentials/keys.md': 'CRED-TEXT\n',
  '.env': 'A=1\n',
  'big.md': 'x'.repeat(MAX_BYTES + 5000),
  'binary.md': 'text\0with a NUL',
  'id_ed25519.md': 'KEY\n',
});
fs.symlinkSync(path.join(outside, 'secret.md'), path.join(brain, 'daily_logs', '2026-11-11.md'));
fs.symlinkSync(path.join(outside, 'skill'), path.join(brain, 'skills', 'far'));
// Claude Code's folder: the global rules link into the brain, its rules/ folder, skills, the home memory.
fs.mkdirSync(t.claude, { recursive: true });
fs.symlinkSync(path.join(brain, 'claude', 'CLAUDE.md'), path.join(t.claude, 'CLAUDE.md'));
writeTree(t.claude, {
  'rules/hoprig-working-rules.md': '# Working rules\n',
  'skills/commit/SKILL.md': '---\nname: commit\ndescription: Write commit messages.\n---\n',
  [`projects/${slug}/memory/MEMORY.md`]: '- [Prefs](prefs.md)\n',
  [`projects/${slug}/memory/prefs.md`]: mem('Prefs', 'How the owner likes to work', 'user'),
  [`projects/${slug}/memory/no-ai/x.md`]: 'PRIVATE-NOTE\n',
});
// A project parent, and one whose memory folder is a link out of the project.
writeTree(path.join(projects, 'shop'), {
  'AGENTS.md': '# Shop\n',
  'decisions.md': '# Decisions\n',
  'ai_brain/learnings.md': '# L\n',
  'ai_brain/active_context.md': '# A\n',
  'ai_brain/claude-memory/MEMORY.md': '- [Stack](stack.md)\n',
  'ai_brain/claude-memory/stack.md': mem('Stack', 'Next.js and Postgres', 'project'),
  'ai_brain/claude-memory/.hidden.md': 'HIDDEN\n',
  'no-ai/plan.md': 'PRIVATE-NOTE\n',
  'project.json': JSON.stringify({ name: 'shop', repos: [], memories: { '.': 'ai_brain/claude-memory' } }),
});
writeTree(path.join(projects, 'leaky'), { 'AGENTS.md': '# Leaky\n', 'ai_brain/learnings.md': '# L\n' });
fs.symlinkSync(outside, path.join(projects, 'leaky', 'ai_brain', 'claude-memory'));
writeTree(path.join(projects, 'no-ai'), { 'AGENTS.md': 'PRIVATE-NOTE\n' });

const ids = (x) => JSON.stringify(x).match(/"id":"[^"]*"/g).map((s) => s.slice(6, -1));

test('the index lists what there is: global rules, brain files, daily logs newest first, skills, memory, projects', () => {
  const ix = brainIndex();
  assert.equal(ix.brain.exists, true);
  assert.equal(ix.global.rules.id, 'global:rules');
  assert.equal(ix.global.linked, true);
  assert.equal(ix.global.inBrain, true);
  assert.deepEqual(ix.global.more.map((i) => i.title), ['hoprig-working-rules.md']);
  for (const k of ['about', 'learnings', 'activeContext', 'pending', 'rules']) assert.ok(ix.brain[k] && ix.brain[k].id, k);
  assert.deepEqual(ix.dailyLogs.items.map((i) => i.date), ['2026-11-14', '2026-11-13', '2026-11-12']);
  assert.equal(ix.dailyLogs.count, 3);
  assert.deepEqual(ix.skills.items.map((s) => [s.name, s.description, s.where]), [['commit', 'Write commit messages.', 'claude'], ['tidy', 'Keep the code tidy.', 'brain']]);
  assert.deepEqual([ix.skills.count, ix.skills.used, ix.skills.brainOnly], [2, 1, 1], 'what Claude Code loads, apart from what is only in the brain');
  assert.deepEqual(ix.memory.home.items.map((m) => [m.name, m.type]), [['MEMORY', 'index'], ['Prefs', 'user']]);
  assert.equal(ix.memory.home.items[1].description, 'How the owner likes to work');
  assert.deepEqual(ix.projects.map((p) => p.name), ['leaky', 'shop']);
  const shop = ix.projects.find((p) => p.name === 'shop');
  for (const k of ['agents', 'decisions', 'learnings', 'activeContext']) assert.ok(shop[k].id, k);
  assert.deepEqual(shop.memory.items.map((m) => [m.name, m.type, m.folder]), [['MEMORY', 'index', 'ai_brain/claude-memory'], ['Stack', 'project', 'ai_brain/claude-memory']]);
  assert.ok(Date.parse(shop.memory.items[1].modified));
});

test('private folders are never listed, opened or counted', () => {
  const text = JSON.stringify(brainIndex());
  for (const bad of ['no-ai', 'ai-ignore-dir', '"ignore', 'hidden', 'PRIVATE-NOTE']) assert.ok(!text.includes(bad), bad);
  assert.equal(brainIndex().projects.length, 2, 'a projects/no-ai folder is not a project');
  for (const id of ['brain:no-ai/diary.md', 'log:no-ai', 'pmem:shop:0:no-ai', 'skill:brain:no-ai', 'mem:home:no-ai']) assert.throws(() => brainRead(id), (e) => [400, 404].includes(e.status), id);
});

test('nothing outside the roots: no "..", no absolute path, no link that leads out', () => {
  const ix = brainIndex();
  const text = JSON.stringify(ix);
  assert.ok(!text.includes('OUTSIDE') && !text.includes('2026-11-11') && !text.includes('far away'), 'links out are not listed');
  assert.equal(ix.projects.find((p) => p.name === 'leaky').memory.count, 0, 'a memory folder linked out of its project is not read');
  for (const id of ['../outside/secret.md', '/etc/passwd', 'brain:../../outside/secret.md', 'log:2026-11-11.md', 'skill:brain:far', `brain:${path.join(t.root, 'outside', 'secret.md')}`, 'brain:learnings.md\0', '']) {
    assert.throws(() => brainRead(id), (e) => [400, 404].includes(e.status), JSON.stringify(id));
  }
  // The guard itself, for a path someone could build: refused however it is written.
  assert.equal(checkFile(path.join(brain, '..', 'outside', 'secret.md'), brain).ok, false);
  assert.equal(checkFile(path.join(brain, 'daily_logs', '2026-11-11.md'), brain).why, 'a link that leads outside the brain');
  assert.equal(checkFile('relative/learnings.md', brain).ok, false);
});

test('credentials, dot-files, .env, key files and anything not plain text are never returned', () => {
  const text = JSON.stringify(brainIndex());
  for (const bad of ['credentials', 'CRED-TEXT', '.env', 'id_ed25519', 'picture.png', '.hidden', '.gitkeep']) assert.ok(!text.includes(bad), bad);
  for (const rel of ['credentials/keys.md', '.env', 'id_ed25519.md', 'daily_logs/picture.png']) assert.equal(checkFile(path.join(brain, rel), brain).ok, false, rel);
  assert.throws(() => brainRead('brain:binary.md'), (e) => e.status === 404, 'not in the index');
});

test('reading: only ids from the index; secrets masked; size capped with a cut flag; NUL means not text', async () => {
  const learn = brainRead('brain:learnings');
  assert.equal(learn.file.startsWith('~'), true);
  assert.ok(!learn.text.includes('sk-ant-api03'), 'a key in a note is masked');
  assert.equal(learn.masked, true);
  assert.equal(brainRead('global:rules').text, '# Rules\n');
  assert.match(brainRead('pmem:shop:0:stack.md').text, /Next\.js/);
  assert.match(brainRead('mem:home:prefs.md').text, /How the owner/);
  const { readChecked } = await import('../../src/workspace/guard.mjs');
  const big = readChecked(path.join(brain, 'big.md'), brain);
  assert.equal(big.cut, true);
  assert.equal(big.text.length, MAX_BYTES);
  assert.throws(() => readChecked(path.join(brain, 'binary.md'), brain), (e) => e.status === 415);
});

test('a computer without a brain: an empty index, no error', () => {
  const ix = brainIndex({ dir: path.join(t.root, 'none'), base: path.join(t.root, 'no-claude'), projects: path.join(t.root, 'none', 'projects') });
  assert.equal(ix.brain.exists, false);
  assert.equal(ix.global.rules, null);
  assert.deepEqual([ix.skills.count, ix.dailyLogs.count, ix.memory.home.count, ix.projects.length], [0, 0, 0, 0]);
  assert.throws(() => brainRead('brain:learnings', { dir: path.join(t.root, 'none'), base: path.join(t.root, 'no-claude') }), (e) => e.status === 404);
});

test('every id in the index can be read, and nothing else', () => {
  const ix = brainIndex();
  for (const id of ids(ix)) assert.equal(typeof brainRead(id).text, 'string', id);
});
