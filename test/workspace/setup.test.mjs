// The workspace on a temporary home: status, setup that creates only what is missing (and never touches what is
// there or Claude Code's folder), an existing computer adopted as it is, the projects folder default, and the
// link step (merge and back up, never overwrite).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome, writeTree } from './helpers.mjs';

const t = tempHome('ws-setup');
test.after(() => t.cleanup());
const { workspaceStatus, workspaceRoot, TREE } = await import('../../src/workspace/layout.mjs');
const { workspaceSetup } = await import('../../src/workspace/setup.mjs');
const { planLink, applyLink } = await import('../../src/workspace/link.mjs');
const { projectsDir } = await import('../../src/pcsetup/projects.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const posix = process.platform !== 'win32';
const ui = () => {
  const out = [];
  return { out, ui: makeUi({ interactive: false, write: (s) => out.push(s) }) };
};
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

test('a new install: everything missing, nothing created by status, projects default to <workspace>/projects', () => {
  const st = workspaceStatus();
  assert.equal(st.dir, t.ws);
  assert.equal(st.source, 'default');
  assert.equal(st.exists, false);
  assert.deepEqual(st.folders.map((f) => f.rel), ['ai_brain', 'projects', 'credentials', 'development', 'git', 'database/postgresql', 'database/mysql', 'backups']);
  assert.ok(st.folders.every((f) => !f.exists && f.purpose.length > 10));
  assert.equal(st.projectsDir, path.join(t.ws, 'projects'));
  assert.equal(projectsDir(), path.join(t.ws, 'projects'));
  assert.equal(st.projectsInWorkspace, true);
  assert.equal(fs.existsSync(t.ws), false);
});

test('setup --dry-run says what it would make and makes nothing', async () => {
  const r = await workspaceSetup({ dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.did.length >= TREE.length);
  assert.equal(fs.existsSync(t.ws), false);
});

test('setup creates the tree, a private credentials folder, the brain scaffold with a first commit; ~/.claude untouched', async () => {
  const r = await workspaceSetup();
  for (const f of TREE) assert.ok(fs.statSync(path.join(t.ws, f.rel)).isDirectory(), f.rel);
  const cred = path.join(t.ws, 'credentials');
  if (posix) assert.equal(fs.statSync(cred).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(path.join(cred, 'README.md'), 'utf8'), /never put in git/);
  const brain = path.join(t.ws, 'ai_brain');
  for (const f of ['BRAIN.md', 'learnings.md', 'active_context.md', 'daily_logs', 'claude-memory/home', 'skills', 'scripts', 'claude/CLAUDE.md', '.gitignore']) assert.ok(fs.existsSync(path.join(brain, f)), f);
  assert.match(fs.readFileSync(path.join(brain, 'claude', 'CLAUDE.md'), 'utf8'), /^# Working rules/);
  assert.deepEqual(r.git, { done: true });
  assert.equal(execFileSync('git', ['-C', brain, 'log', '--format=%s'], { encoding: 'utf8' }).trim(), 'Start the AI brain');
  assert.equal(fs.existsSync(t.claude), false, 'setup never touches the Claude folder');
  const st = workspaceStatus();
  assert.ok(st.folders.every((f) => f.exists));
  assert.equal(st.brain.git, true);
});

test('running setup again changes nothing', async () => {
  const before = snapshot(t.ws);
  const r = await workspaceSetup();
  assert.deepEqual(r.did, []);
  assert.equal(r.git, null);
  assert.deepEqual(snapshot(t.ws), before);
});

test('an existing tree is adopted as it is: its own brain, a loose credentials folder, a file in the way', async () => {
  const other = path.join(t.root, 'Other');
  writeTree(other, { 'ai_brain/notes/mine.md': 'my own structure\n', 'ai_brain/README.md': 'mine\n', 'credentials/x/.env': 'A=1\n', backups: 'a file, not a folder' });
  execFileSync('git', ['init', '-q', path.join(other, 'ai_brain')]);
  if (posix) fs.chmodSync(path.join(other, 'credentials'), 0o755);
  process.env.HOPRIG_WORKSPACE_DIR = other;
  try {
    assert.deepEqual(workspaceRoot(), { dir: other, source: 'env' });
    const before = snapshot(path.join(other, 'ai_brain'));
    const st = workspaceStatus();
    assert.equal(st.brain.git, true);
    if (posix) assert.match(st.folders.find((f) => f.id === 'credentials').warning, /chmod 700/);
    assert.equal(st.folders.find((f) => f.id === 'backups').kind, 'file');
    const r = await workspaceSetup();
    assert.equal(r.git, null, 'no git init in a brain that exists');
    assert.ok(!r.did.some((d) => /ai_brain|credentials|backups/.test(d.path)), JSON.stringify(r.did));
    assert.deepEqual(snapshot(path.join(other, 'ai_brain')), before);
    assert.equal(fs.existsSync(path.join(other, 'ai_brain', 'BRAIN.md')), false);
    if (posix) assert.equal(fs.statSync(path.join(other, 'credentials')).mode & 0o777, 0o755, 'an existing folder is only reported');
    assert.equal(fs.readFileSync(path.join(other, 'backups'), 'utf8'), 'a file, not a folder');
    assert.ok(fs.statSync(path.join(other, 'development')).isDirectory());
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
  }
});

test('the projects folder: a choice made before stays; ~/projects of an earlier install stays; the setting moves the workspace', async () => {
  const fresh = path.join(t.root, 'fresh');
  saveConfig({ workspaceDir: fresh });
  assert.equal(workspaceRoot().source, 'setting');
  assert.equal(projectsDir(), path.join(fresh, 'projects'));
  fs.mkdirSync(path.join(t.home, 'projects'));
  assert.equal(projectsDir(), path.join(t.home, 'projects'), 'an earlier install keeps ~/projects');
  const r = await workspaceSetup({ dryRun: true });
  assert.ok(r.left.some((l) => /your projects stay in/.test(l.why)));
  assert.ok(!r.did.some((d) => d.path.endsWith('/projects')));
  saveConfig({ projectsDir: path.join(t.root, 'chosen') });
  assert.equal(projectsDir(), path.join(t.root, 'chosen'));
  assert.equal(workspaceStatus().projectsInWorkspace, false);
  saveConfig({ workspaceDir: undefined, projectsDir: undefined });
  fs.rmdirSync(path.join(t.home, 'projects'));
});

test('link: shows the plan, links into the brain, merges and backs up, never overwrites; dry run changes nothing', () => {
  const brain = path.join(t.ws, 'ai_brain');
  // What Claude Code already has: a skill (one name taken in the brain with other text), home memory.
  writeTree(t.claude, { 'skills/mine/SKILL.md': 'mine', 'skills/both/SKILL.md': 'claude side' });
  writeTree(brain, { 'skills/both/SKILL.md': 'brain side' });
  const slug = t.home.replace(/[^A-Za-z0-9]/g, '-');
  writeTree(path.join(t.claude, 'projects', slug, 'memory'), { 'MEMORY.md': '- [a](a.md)\n', 'a.md': 'remember a\n' });
  fs.writeFileSync(path.join(t.claude, 'CLAUDE.md'), 'my own global rules\n');
  const before = snapshot(t.claude);
  const plan = planLink();
  assert.deepEqual(plan.map((p) => [p.id, p.action]), [['rules', 'conflict'], ['skills', 'merge'], ['memory', 'merge']]);
  assert.match(plan[0].why, /differs/);
  assert.deepEqual(snapshot(t.claude), before, 'planning changes nothing');

  const done = applyLink();
  assert.ok(done.every((d) => !d.error), JSON.stringify(done));
  assert.equal(fs.readFileSync(path.join(t.claude, 'CLAUDE.md'), 'utf8'), 'my own global rules\n', 'a file that exists is never overwritten');
  assert.equal(fs.lstatSync(path.join(t.claude, 'CLAUDE.md')).isSymbolicLink(), false);
  assert.equal(fs.realpathSync(path.join(t.claude, 'skills')), fs.realpathSync(path.join(brain, 'skills')));
  assert.equal(fs.readFileSync(path.join(brain, 'skills', 'both', 'SKILL.md'), 'utf8'), 'brain side');
  assert.ok(fs.readdirSync(path.join(brain, 'skills', 'both')).some((n) => /^SKILL\.from-.*\.md$/.test(n)), 'the other text is kept under a new name');
  assert.equal(fs.readFileSync(path.join(brain, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'mine');
  assert.ok(fs.readdirSync(t.claude).some((n) => n.startsWith('skills.backup-')));
  assert.equal(fs.readFileSync(path.join(brain, 'claude-memory', 'home', 'a.md'), 'utf8'), 'remember a\n');
  assert.equal(fs.realpathSync(path.join(t.claude, 'projects', slug, 'memory')), fs.realpathSync(path.join(brain, 'claude-memory', 'home')));

  // The owner moves their rules into the brain; then the rules file links too, after a backup.
  fs.writeFileSync(path.join(brain, 'claude', 'CLAUDE.md'), 'my own global rules\n');
  assert.equal(planLink()[0].action, 'backup');
  applyLink();
  assert.equal(fs.realpathSync(path.join(t.claude, 'CLAUDE.md')), fs.realpathSync(path.join(brain, 'claude', 'CLAUDE.md')));
  assert.deepEqual(planLink().map((p) => p.action), ['already', 'already', 'already']);
});

test('link adopts a rules file when the brain has none, and leaves a link to elsewhere alone', () => {
  const other = path.join(t.root, 'adopt');
  const claude = path.join(other, 'claude');
  const brain = path.join(other, 'brain');
  writeTree(claude, { 'CLAUDE.md': 'rules from before\n' });
  fs.mkdirSync(brain, { recursive: true });
  fs.mkdirSync(path.join(other, 'elsewhere'));
  fs.symlinkSync(path.join(other, 'elsewhere'), path.join(claude, 'skills'));
  const plan = planLink({ base: claude, brain, home: t.home });
  assert.deepEqual(plan.map((p) => p.action), ['adopt', 'conflict', 'link']);
  applyLink({ base: claude, brain, home: t.home });
  assert.equal(fs.readFileSync(path.join(brain, 'claude', 'CLAUDE.md'), 'utf8'), 'rules from before\n');
  assert.equal(fs.lstatSync(path.join(claude, 'CLAUDE.md')).isSymbolicLink(), true);
  assert.ok(fs.readdirSync(claude).some((n) => n.startsWith('CLAUDE.md.backup-')));
  assert.equal(fs.readlinkSync(path.join(claude, 'skills')), path.join(other, 'elsewhere'), 'a link to somewhere else is left alone');
});

test('CLI: status --json, setup --dry-run, link --dry-run, bad options', async () => {
  let out = '';
  assert.equal(await main(['status', '--json'], { ui: ui().ui, write: (s) => (out += s) }), 0);
  assert.equal(JSON.parse(out).dir, t.ws);
  const a = ui();
  assert.equal(await main(['setup', '--dry-run'], { ui: a.ui }), 0);
  assert.match(a.out.join(''), /nothing is missing/);
  const b = ui();
  assert.equal(await main(['link', '--dry-run'], { ui: b.ui }), 0);
  assert.match(b.out.join(''), /already linked/);
  assert.equal(await main(['setup', '--force'], { ui: ui().ui }), 2);
  assert.equal(await main(['nope'], { ui: ui().ui }), 2);
});
