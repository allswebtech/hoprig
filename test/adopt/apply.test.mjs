// hoprig adopt plan and apply on a made-up computer with four projects: a plan is a file in Hoprig's state folder,
// a dry run writes nothing, apply copies (never moves) and proves each copy, a mismatch removes only what it made,
// and a folder that changed since its plan asks for a new one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { tempHome, writeTree } from '../workspace/helpers.mjs';
import { allOf, git, madeUpComputer, repo, snapshot, traps } from './fixture.mjs';
import { makePlan, planFile, readPlan, writePlan } from '../../src/adopt/plan.mjs';
import { RUN_TOKEN, applyPlan } from '../../src/adopt/apply.mjs';
import { treeOf } from '../../src/adopt/proof.mjs';
import { oddNamesSkip } from '../oddnames.mjs';

let t, m, projects, ws, trap;
const opts = () => ({ projects, home: t.home, claude: t.claude });
before(() => {
  t = tempHome('adopt-apply');
  ws = path.join(t.home, 'Workspace');
  projects = path.join(ws, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  m = madeUpComputer(t);
  trap = traps(t.root);
});
after(() => t.cleanup());

const plan = async (name) => {
  const p = await makePlan(m.dirs[name], opts());
  writePlan(p);
  return p;
};

test('a plan names where each thing goes, what stays, what would break, and writes only its own file', async () => {
  const before = allOf(m.place, ws, t.claude);
  const p = await plan('blog');
  assert.deepEqual(allOf(m.place, ws, t.claude), before, 'nothing changed outside Hoprig\'s state folder');
  assert.ok(planFile('blog').startsWith(process.env.HOPRIG_STATE_DIR));
  assert.deepEqual(p.repos.map((r) => [r.rel, r.to]).sort(), [['api', 'code/api'], ['web', 'code/web']]);
  assert.equal(p.repos.find((r) => r.rel === 'web').worktrees[0].to, 'code/web.web-feature');
  const where = Object.fromEntries(p.neighbours.map((n) => [n.from, n.to]));
  assert.equal(where['deploy.sh'], 'scripts/deploy.sh');
  assert.equal(where.backups, 'test-data/backups');
  assert.equal(where['plan.md'], 'ai_brain/notes/plan.md');
  assert.ok(!('web-feature' in where), 'the worktree comes with its repository');
  assert.ok(p.breaks.some((b) => b.file === 'deploy.sh' && b.line === 2), 'the script that names the old folder is listed with its line');
  const tools = await plan('tools');
  assert.deepEqual(tools.tools.skills.map((s) => s.name), ['series']);
  assert.ok(tools.tools.hooks.some((h) => h.file === '.kiro/hooks/guard.json'));
  assert.ok(tools.tools.rules.some((r) => r.file === '.kiro/steering/about.md'));
  assert.ok(tools.breaks.some((b) => b.file === '.git/config'), 'the credential helper with a full path is found');
  assert.deepEqual(tools.sessions.map((s) => [s.tool, s.count]), [['Claude Code', 1], ['Kiro', 1]]);
  const notes = await plan('notes');
  assert.equal(notes.privates, 0, 'a private folder inside a repository travels with it');
  assert.ok(!JSON.stringify(notes).includes('private.txt'), 'nothing in a private folder is named');
});

test('a private neighbour\'s copy line says its contents are not checked and a special file is not copied', async () => {
  const shed = path.join(m.place, 'shed');
  repo(path.join(shed, 'web'), null, { 'a.txt': 'a\n' });
  writeTree(shed, { 'No-AI/hidden-name.txt': 'p\n' });
  writePlan(await makePlan(shed, opts()));
  const r = await applyPlan('shed', { projects, workspace: ws, dryRun: true, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  const l = r.lines.find((x) => x.what === 'copy' && x.words.includes('No-AI'));
  assert.ok(l && /contents are not checked/.test(l.words) && /pipe, is not copied/.test(l.words) && !/whole/.test(l.words), JSON.stringify(l));
});

test('hard-linked files are said to be copied as separate files', async () => {
  const pair = repo(path.join(m.place, 'linked'), null, { 'hard1.txt': 'same\n' });
  fs.linkSync(path.join(pair, 'hard1.txt'), path.join(pair, 'hard2.txt'));
  writePlan(await makePlan(pair, opts()));
  const r = await applyPlan('linked', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  const l = r.lines.find((x) => x.what === 'links');
  assert.ok(l && l.warn && /2 hard-linked files were copied as separate files/.test(l.words), JSON.stringify(r.lines.map((x) => x.what)));
});

test('a dry run writes nothing anywhere: the places, the workspace, the coding tool\'s folder, the plans', async () => {
  await plan('notes');
  const before = allOf(m.place, ws, t.claude, process.env.HOPRIG_STATE_DIR);
  const r = await applyPlan('notes', { projects, workspace: ws, dryRun: true, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok && r.lines.length);
  assert.deepEqual(allOf(m.place, ws, t.claude, process.env.HOPRIG_STATE_DIR), before);
  const recent = r.lines.find((l) => l.what === 'recent');
  assert.ok(recent && recent.warn, 'files changed within the hour are a warning, not a passed step');
});

test('apply copies a repository whole and proves it; the original is untouched', async () => {
  await plan('blog');
  const before = allOf(m.place, m.server);
  const said = [];
  const r = await applyPlan('blog', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' }, say: (l) => said.push(l) });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  assert.deepEqual(allOf(m.place, m.server), before, 'the originals and the server are as they were');
  for (const w of ['HEAD', 'refs', 'status', 'diff', 'stash', 'remote', 'worktrees', 'files', 'fsck']) assert.ok(said.some((l) => l.what === w && l.ok), `a proof line for ${w}`);
  assert.ok(said.some((l) => l.what === 'recent' && l.warn), 'the real apply says it too, as a warning');
  const root = path.join(projects, 'blog');
  assert.equal(git(path.join(root, 'code', 'web'), 'stash', 'list').split('\n').length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'code', 'web.web-feature', 'src', 'a.js'), 'utf8'), 'work in the worktree\n');
  assert.equal(git(path.join(root, 'code', 'web.web-feature'), 'rev-parse', '--show-toplevel'), path.join(root, 'code', 'web.web-feature'));
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /\| `.*blog\/deploy\.sh` \| `scripts\/deploy\.sh` \|/);
  assert.equal(git(root, 'log', '--format=%an <%ae>'), 'Alex <alex@example.invalid>');
  assert.ok(r.needs.some((n) => n.kind === 'old path' && n.words.startsWith('scripts/deploy.sh:2 ')), 'the copied script that names the old folder is said with its file and line');
  assert.deepEqual(trap.trapped(), []);
});

test('the private folder travels whole and is not entered; ignored .env files come along', async () => {
  const r = await applyPlan('notes', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  const c = path.join(projects, 'notes', 'code', 'notes');
  assert.equal(fs.readFileSync(path.join(c, '.env'), 'utf8'), 'TOKEN=made-up\n');
  assert.equal(fs.readFileSync(path.join(c, 'no-ai', 'private.txt'), 'utf8'), 'made-up private words\n');
  assert.ok(!JSON.stringify(r).includes('private.txt'));
  assert.equal(git(c, 'status', '--porcelain'), git(m.dirs.notes, 'status', '--porcelain'), 'the uncommitted work is still uncommitted, as in the original');
  const files = r.lines.find((l) => l.what === 'files');
  assert.match(files.words, /1 private folder copied but not looked into: its contents are not checked/, 'it says what is known, not "whole"');
  assert.match(git(c, 'status', '--porcelain'), /^ ?M app\.py$/m);
});

test('a copy that differs from its original stops apply, which removes only what it made', async () => {
  await plan('tools');
  const before = allOf(m.place);
  const r = await applyPlan('tools', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' }, hooks: { afterCopy: (cs) => fs.appendFileSync(path.join(cs[0].to, 'package.json'), ' ') } });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.what === 'files' && !l.ok));
  assert.ok(r.lines.some((l) => l.what === 'undone'));
  assert.ok(!fs.existsSync(path.join(projects, 'tools')));
  assert.deepEqual(allOf(m.place), before);
});

test('a folder that changed since its plan asks for a new plan', async () => {
  await plan('shop');
  writeTree(m.dirs.shop, { 'code/shop/new.txt': 'x\n' });
  await assert.rejects(applyPlan('shop', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } }), { code: 'ECHANGED' });
  fs.rmSync(path.join(m.dirs.shop, 'code/shop/new.txt'));
  git(path.join(m.dirs.shop, 'code', 'shop'), 'commit', '-q', '--allow-empty', '-m', 'later');
  await assert.rejects(applyPlan('shop', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } }), { code: 'ECHANGED' });
  assert.ok(!fs.existsSync(path.join(projects, 'shop')));
});

test('the fingerprint compares content: an edit of the same size in the same second is a change, a touch is none', async () => {
  const pkg = repo(path.join(m.place, 'same'), null, { 'README.md': '# same\n' });
  writeTree(pkg, { 'notes.txt': 'abc\n' });
  writePlan(await makePlan(pkg, opts()));
  const f = path.join(pkg, 'notes.txt');
  const st = fs.statSync(f);
  fs.utimesSync(f, st.atime, new Date(st.mtimeMs + 5000));
  const who = { name: 'Alex', email: 'alex@example.invalid' };
  const dry = await applyPlan('same', { projects, workspace: ws, identity: who, dryRun: true });
  assert.ok(dry.ok, 'a touch alone is no change');
  fs.writeFileSync(f, 'abd\n');
  fs.utimesSync(f, st.atime, st.mtime);
  await assert.rejects(applyPlan('same', { projects, workspace: ws, identity: who }), { code: 'ECHANGED' }, 'same size, same time, another content');
  assert.ok(!fs.existsSync(path.join(projects, 'same')));
});

test('an apply that was stopped partway is said as such, and only its half-made folder is removed when asked', async () => {
  const pkg = repo(path.join(m.place, 'halt'), null, { 'README.md': '# halt\n' });
  writePlan(await makePlan(pkg, opts()));
  // What a killed run leaves: its marker naming the folder and the run's token, and that folder half made, with the
  // same token in it.
  const root = path.join(projects, 'halt');
  const marker = path.join(process.env.HOPRIG_STATE_DIR, 'adopt', 'halt.applying');
  writeTree(root, { 'code/halt/README.md': '# ha', [RUN_TOKEN]: 'tok-1\n' });
  fs.writeFileSync(marker, `${root}\n\n\ntok-1\n`);
  const before = allOf(pkg);
  const who = { name: 'Alex', email: 'alex@example.invalid' };
  await assert.rejects(applyPlan('halt', { projects, workspace: ws, identity: who }), (e) => e.code === 'ESTOPPED' && /stopped partway/.test(e.message) && /--clean-stopped/.test(e.message));
  await assert.rejects(applyPlan('halt', { projects, workspace: ws, identity: who, dryRun: true, cleanStopped: true }), { code: 'ESTOPPED' }, 'a dry run removes nothing');
  assert.ok(fs.existsSync(path.join(root, 'code', 'halt', 'README.md')));
  const r = await applyPlan('halt', { projects, workspace: ws, identity: who, cleanStopped: true });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  assert.equal(fs.readFileSync(path.join(root, 'code', 'halt', 'README.md'), 'utf8'), '# halt\n');
  assert.ok(!fs.existsSync(marker));
  assert.ok(!fs.existsSync(path.join(root, RUN_TOKEN)), 'a finished run leaves no token');
  assert.deepEqual(allOf(pkg), before, 'the original is untouched');
  // A run that is still alive (another process) is no stopped run: its folder is never removed, and the words say
  // how to go on when none runs.
  const { spawn } = await import('node:child_process');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(marker, `${root}\n${other.pid}\n`);
    await assert.rejects(applyPlan('halt', { projects, workspace: ws, identity: who, cleanStopped: true }), (e) => e.code === 'ERUNNING' && e.message.includes(`remove ${marker}`));
    assert.ok(fs.existsSync(path.join(root, 'project.json')));
  } finally {
    other.kill();
    fs.rmSync(marker, { force: true });
  }
  // A folder that is there without a marker of a stopped run is never removed, also with the flag.
  await assert.rejects(applyPlan('halt', { projects, workspace: ws, identity: who, cleanStopped: true }), { code: 'EEXISTS' });
  assert.ok(fs.existsSync(path.join(root, 'project.json')));
});

test('the run\'s token stays in its folder until the done record is written, so a run killed after the copy is still known', async () => {
  const pkg = repo(path.join(m.place, 'late'), null, { 'README.md': '# late\n' });
  writePlan(await makePlan(pkg, opts()));
  const seen = [];
  const r = await applyPlan('late', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' }, hooks: { beforeDone: (root) => seen.push(fs.existsSync(path.join(root, RUN_TOKEN))) } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  assert.deepEqual(seen, [true], 'after the memory, sessions and pointers the token is still there');
  assert.ok(!fs.existsSync(path.join(projects, 'late', RUN_TOKEN)), 'a finished run leaves no token');
});

test('a stale marker never makes a folder the owner made afterwards a half-made copy', async () => {
  const pkg = repo(path.join(m.place, 'cafe'), null, { 'README.md': '# cafe\n' });
  writePlan(await makePlan(pkg, opts()));
  const root = path.join(projects, 'cafe');
  const marker = path.join(process.env.HOPRIG_STATE_DIR, 'adopt', 'cafe.applying');
  const who = { name: 'Alex', email: 'alex@example.invalid' };
  // The killed run's marker; its half-made folder went by hand; the owner made his own there and worked in it.
  fs.writeFileSync(marker, `${root}\n999999999\n\ntok-2\n`);
  writeTree(root, { 'AGENTS.md': '# my own cafe\n', 'work.txt': 'a week of made-up work\n' });
  for (const cleanStopped of [false, true]) {
    await assert.rejects(applyPlan('cafe', { projects, workspace: ws, identity: who, cleanStopped }), (e) => e.code === 'EEXISTS' && e.message.includes(marker) && /remove it yourself, then remove/.test(e.message) && /originals were not touched/.test(e.message));
  }
  // Also when his folder holds a token of another run.
  fs.writeFileSync(path.join(root, RUN_TOKEN), 'tok-other\n');
  await assert.rejects(applyPlan('cafe', { projects, workspace: ws, identity: who, cleanStopped: true }), { code: 'EEXISTS' });
  assert.equal(fs.readFileSync(path.join(root, 'work.txt'), 'utf8'), 'a week of made-up work\n', 'his work stays');
  fs.rmSync(root, { recursive: true });
  fs.rmSync(marker, { force: true });
});

test('a marker whose pid now belongs to another living process does not block apply for ever', { skip: process.platform !== 'linux' && 'the identity of another process is read from /proc here' }, async () => {
  const pkg = repo(path.join(m.place, 'kiosk'), null, { 'README.md': '# kiosk\n' });
  writePlan(await makePlan(pkg, opts()));
  const root = path.join(projects, 'kiosk');
  const marker = path.join(process.env.HOPRIG_STATE_DIR, 'adopt', 'kiosk.applying');
  const { spawn } = await import('node:child_process');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    // The killed run's pid, handed out again to an unrelated process: the identity it recorded is not that process's.
    const { system } = await import('../../src/procid.mjs');
    fs.writeFileSync(marker, `${root}\n${other.pid}\n${system.self()}\ntok-3\n`);
    const r = await applyPlan('kiosk', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
    assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
    assert.ok(!fs.existsSync(marker));
  } finally {
    other.kill();
  }
});

test('two applies of one project at once: one arranges it, the other is refused and removes nothing', async () => {
  const files = {};
  for (let i = 0; i < 400; i++) files[`src/f${i}.txt`] = `line ${i}\n`;
  const pkg = repo(path.join(m.place, 'twin'), null, files);
  writePlan(await makePlan(pkg, opts()));
  const who = { name: 'Alex', email: 'alex@example.invalid' };
  const runs = await Promise.allSettled([0, 1].map(() => applyPlan('twin', { projects, workspace: ws, identity: who })));
  assert.equal(runs.filter((x) => x.status === 'fulfilled' && x.value.ok).length, 1, JSON.stringify(runs.map((x) => x.status === 'fulfilled' ? x.value.lines.filter((l) => !l.ok || l.what === 'undone') : `${x.reason.code} ${x.reason.message}`)));
  const refused = runs.find((x) => x.status === 'rejected');
  assert.ok(refused && ['ERUNNING', 'EEXISTS'].includes(refused.reason.code), String(refused?.reason?.message));
  assert.equal(fs.readdirSync(path.join(projects, 'twin', 'code', 'twin', 'src')).length, 400, 'the arranged copy is whole');
  // The same from two processes (the terminal and the dashboard).
  const child = path.join(t.root, 'apply-child.mjs');
  fs.writeFileSync(child, `const { applyPlan } = await import(${JSON.stringify(new URL('../../src/adopt/apply.mjs', import.meta.url).href)});
try { const r = await applyPlan('twin2', { projects: ${JSON.stringify(projects)}, workspace: ${JSON.stringify(ws)}, identity: { name: 'Alex', email: 'alex@example.invalid' } }); console.log(r.ok ? 'ok' : 'failed ' + JSON.stringify(r.lines.filter((l) => !l.ok))); } catch (e) { console.log('threw ' + e.code + ' ' + e.message); }\n`);
  const pkg2 = repo(path.join(m.place, 'twin2'), null, files);
  writePlan(await makePlan(pkg2, opts()));
  const { spawn } = await import('node:child_process');
  const one = () => new Promise((res) => {
    const c = spawn(process.execPath, [child], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.stderr.on('data', (d) => (o += d));
    c.on('close', () => res(o.trim()));
  });
  const outs = await Promise.all([one(), one()]);
  assert.equal(outs.filter((o) => o === 'ok').length, 1, outs.join('\n'));
  assert.ok(outs.some((o) => /^threw (ERUNNING|EEXISTS) /.test(o)), outs.join('\n'));
  assert.equal(fs.readdirSync(path.join(projects, 'twin2', 'code', 'twin2', 'src')).length, 400);
  assert.ok(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'adopt', 'twin2.done.json')));
});

test('an edited plan that points outside the project is refused', async () => {
  const p = await plan('blog');
  for (const bad of [{ ...p, neighbours: [{ from: 'plan.md', kind: 'note', to: '../../escape.md' }] }, { ...p, repos: [{ ...p.repos[0], to: '/tmp/x' }] }, { ...p, to: path.join(t.root, 'elsewhere') }, { ...p, neighbours: [{ from: '../x', kind: 'note', to: 'docs/x' }] }, { ...p, extra: 1 }]) {
    fs.writeFileSync(planFile('blog'), JSON.stringify(bad));
    assert.throws(() => readPlan('blog', { projects }), { code: 'EPLAN' });
  }
});

test('a repository that borrows objects (clone --shared) gets the copy\'s store; one outside the project fails the proof', async () => {
  const pair = path.join(m.place, 'pair');
  repo(path.join(pair, 'api'), null, { 'a.txt': 'a\n' });
  git(pair, 'clone', '-q', '--shared', path.join(pair, 'api'), 'web');
  const p = await makePlan(pair, opts());
  writePlan(p);
  const before = allOf(pair);
  const r = await applyPlan('pair', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  assert.deepEqual(allOf(pair), before, 'the original\'s alternates file is not changed');
  const alt = fs.readFileSync(path.join(projects, 'pair', 'code', 'web', '.git', 'objects', 'info', 'alternates'), 'utf8').trim();
  assert.equal(alt, path.join(projects, 'pair', 'code', 'api', '.git', 'objects'), 'the copy borrows from the copy');
  assert.ok(r.lines.some((l) => l.what === 'objects' && l.ok));
  // A store outside the project: the copy would break when it goes, so the proof fails and the run is undone.
  const lone = path.join(m.place, 'lone');
  repo(path.join(t.root, 'elsewhere', 'base'), null, { 'b.txt': 'b\n' });
  fs.mkdirSync(lone, { recursive: true });
  git(lone, 'clone', '-q', '--shared', path.join(t.root, 'elsewhere', 'base'), 'site');
  writePlan(await makePlan(lone, opts()));
  const r2 = await applyPlan('lone', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.equal(r2.ok, false);
  assert.ok(r2.lines.some((l) => l.what === 'objects' && !l.ok && /outside the new folder/.test(l.words)), JSON.stringify(r2.lines));
  assert.ok(!fs.existsSync(path.join(projects, 'lone')));
});

test('what lies beside a nested repository is planned at its level: placed, or named as staying', async () => {
  const site = path.join(m.place, 'site');
  repo(path.join(site, 'apps', 'web'), null, { 'a.txt': 'a\n' });
  writeTree(site, { 'apps/PLAN-notes.md': '# the plan\n', 'apps/assets/logo.svg': '<svg/>\n' });
  const p = await makePlan(site, opts());
  writePlan(p);
  const where = Object.fromEntries(p.neighbours.map((n) => [n.from, n.to]));
  assert.equal(where['apps/PLAN-notes.md'], 'ai_brain/notes/apps/PLAN-notes.md', 'a note beside the repository goes to its place');
  assert.ok('apps/assets' in where && where['apps/assets'] === null, 'a folder beside it is named, as staying');
  assert.deepEqual(readPlan('site', { projects }).neighbours.map((n) => n.from).sort(), ['apps/PLAN-notes.md', 'apps/assets']);
  const r = await applyPlan('site', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  assert.equal(fs.readFileSync(path.join(projects, 'site', 'ai_brain', 'notes', 'apps', 'PLAN-notes.md'), 'utf8'), '# the plan\n');
  const { scanPlaces } = await import('../../src/adopt/scan.mjs');
  const found = (await scanPlaces([m.place])).projects.find((x) => x.name === 'site');
  assert.deepEqual(found.neighbours, ['apps/PLAN-notes.md', 'apps/assets'], 'the scan names them too');
  const { retireProject } = await import('../../src/adopt/retire.mjs');
  const said = [];
  const rt = await retireProject('site', { projects, ask: async () => 'site', say: (l) => said.push(l) });
  assert.ok(rt.ok, rt.words);
  assert.ok(said.some((l) => l.includes(path.join(site, 'apps', 'assets'))), 'retire says the folder beside it stays');
  assert.deepEqual(fs.readdirSync(path.join(site, 'apps')), ['assets'], 'only what stays is left');
});

test('a plan may not name a neighbour through a link or below a private folder', async () => {
  const p = await plan('blog');
  for (const from of ['no-ai/x', 'a/../b', '.git/config', 'backups/../../x']) {
    fs.writeFileSync(planFile('blog'), JSON.stringify({ ...p, neighbours: [{ from, kind: 'note', to: 'docs/x' }] }));
    assert.throws(() => readPlan('blog', { projects }), { code: 'EPLAN' }, from);
  }
  fs.symlinkSync(path.join(t.root), path.join(m.dirs.blog, 'out-link'));
  fs.writeFileSync(planFile('blog'), JSON.stringify({ ...p, neighbours: [{ from: 'out-link/home', kind: 'other', to: 'docs/home' }] }));
  assert.throws(() => readPlan('blog', { projects }), { code: 'EPLAN' }, 'through a link');
  fs.rmSync(path.join(m.dirs.blog, 'out-link'));
  writePlan(p);
});

/** A project already in the layout, with a worktree outside its folder and its own rules, brain, scripts and docs. */
function layoutProject(name = 'store', { worktree = true } = {}) {
  const store = path.join(m.place, name);
  writeTree(store, { 'AGENTS.md': `# ${name} rules of alex\n`, 'project.json': `{ "name": "${name}", "repos": [] }\n`, 'ai_brain/notes/learned.md': 'learned\n', 'ai_brain/learnings.md': 'his learnings\n', 'scripts/deploy.sh': 'echo deploy\n', 'docs/design.md': '# design\n', 'docs/README.md': '# his docs\n' });
  const code = repo(path.join(store, 'code', name), null, { 'a.txt': 'a\n' });
  if (worktree) git(code, 'worktree', 'add', '-q', '-b', 'hot', path.join(t.root, 'elsewhere', `${name}-hot`));
  return store;
}

test('a project in the layout with a worktree outside it: the worktree goes beside its repository, and the proof holds', async () => {
  const store = layoutProject();
  const p = await makePlan(store, opts());
  writePlan(p);
  assert.equal(p.layout, true);
  assert.deepEqual(p.repos.map((r) => [r.rel, r.to]), [['code/store', 'code/store']]);
  assert.equal(p.repos[0].worktrees[0].to, 'code/store.store-hot', 'not code/code/…');
  const r = await applyPlan('store', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  const wt = path.join(projects, 'store', 'code', 'store.store-hot');
  assert.equal(git(wt, 'rev-parse', '--show-toplevel'), wt, 'the copied worktree is linked to the copied repository');
});

test('a project in the layout brings its own rules, brain, scripts and docs; where the template has the same file, both are kept', async () => {
  const den = layoutProject('den', { worktree: false });
  const p = await makePlan(den, opts());
  writePlan(p);
  const where = Object.fromEntries(p.neighbours.map((n) => [n.from, n.to]));
  assert.equal(where.scripts, 'scripts');
  assert.equal(where['ai_brain/notes'], 'ai_brain/notes');
  assert.equal(where['docs/design.md'], 'docs/design.md');
  assert.equal(where['AGENTS.md'], 'from-the-old-folder/AGENTS.md');
  assert.equal(where['project.json'], 'from-the-old-folder/project.json');
  assert.equal(where['ai_brain/learnings.md'], 'from-the-old-folder/ai_brain/learnings.md');
  assert.equal(where['docs/README.md'], 'from-the-old-folder/docs/README.md');
  const r = await applyPlan('den', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  const root = path.join(projects, 'den');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.equal(read('scripts/deploy.sh'), 'echo deploy\n');
  assert.equal(read('ai_brain/notes/learned.md'), 'learned\n');
  assert.equal(read('docs/design.md'), '# design\n');
  assert.equal(read('from-the-old-folder/AGENTS.md'), '# den rules of alex\n');
  assert.equal(read('from-the-old-folder/ai_brain/learnings.md'), 'his learnings\n');
  assert.ok(r.needs.some((n) => n.kind === 'rules' && n.words.startsWith('from-the-old-folder/AGENTS.md')), 'his old rules file is named to read with him');
});

test('a project in the layout whose parent is itself a repository: its repositories are planned and arranged, its own history stays', async () => {
  const cafe = path.join(m.place, 'bistro');
  writeTree(cafe, { 'AGENTS.md': '# Bistro rules\n', 'project.json': '{ "name": "bistro", "repos": [] }\n', '.gitignore': 'code/*\n!code/.gitignore\n', 'code/.gitignore': '*\n!.gitignore\n', 'ai_brain/learnings.md': 'learned\n' });
  git(cafe, 'init', '-q', '-b', 'main');
  git(cafe, 'add', '-A');
  git(cafe, 'commit', '-qm', 'parent');
  repo(path.join(cafe, 'code', 'bistro'), null, { 'index.html': 'hi\n' });
  const p = await makePlan(cafe, opts());
  assert.ok(p.layout);
  assert.deepEqual(p.repos.map((r) => [r.rel, r.to]), [['code/bistro', 'code/bistro']]);
  assert.ok(p.notes.some((n) => /own git history/.test(n)), JSON.stringify(p.notes));
  writePlan(p);
  const before = allOf(cafe);
  const r = await applyPlan('bistro', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
  assert.equal(fs.readFileSync(path.join(projects, 'bistro', 'code', 'bistro', 'index.html'), 'utf8'), 'hi\n');
  assert.equal(fs.readFileSync(path.join(projects, 'bistro', 'from-the-old-folder', 'AGENTS.md'), 'utf8'), '# Bistro rules\n');
  assert.deepEqual(allOf(cafe), before, 'the original is untouched');
  const { retirePlan } = await import('../../src/adopt/retire.mjs');
  const rp = await retirePlan('bistro', { projects });
  assert.ok(!rp.go.includes(cafe) && rp.stay.some((s) => s.path === path.join(cafe, '.git')), JSON.stringify(rp.stay));
});

test('a file whose name is not UTF-8 is in the proof: a change to it in the copy stops apply', { skip: oddNamesSkip() }, async () => {
  const odd = repo(path.join(m.place, 'odd'), null, { 'README.md': '# odd\n' });
  const bad = (dir) => Buffer.concat([Buffer.from(`${dir}/bad`), Buffer.from([0xff, 0xfe]), Buffer.from('name.txt')]);
  fs.writeFileSync(bad(odd), 'one\n');
  const l = treeOf(odd);
  assert.equal(Object.keys(l.entries).filter((k) => k.includes('name.txt')).length, 1, 'the odd name is an entry of the listing');
  writePlan(await makePlan(odd, opts()));
  const r = await applyPlan('odd', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' }, hooks: { afterCopy: (cs) => {
    const f = bad(cs[0].to);
    const st = fs.statSync(f);
    fs.writeFileSync(f, 'two\n');
    fs.utimesSync(f, st.atime, st.mtime);
  } } });
  assert.equal(r.ok, false, 'the changed file is seen');
  assert.ok(r.lines.some((l) => l.what === 'files' && !l.ok), JSON.stringify(r.lines.filter((x) => !x.ok)));
});

test('the proof\'s listing counts a private folder, in any case, and names nothing in it', () => {
  const d = path.join(t.root, 'listing');
  writeTree(d, { 'a.txt': 'a\n', 'deep/no-ai/inner-name.txt': 'p\n', 'Ignore/other-name.txt': 'p\n' });
  const l = treeOf(d);
  assert.equal(l.privates, 2);
  assert.ok(!JSON.stringify(l).includes('inner-name') && !JSON.stringify(l).includes('other-name'));
});

test('a neighbour that would land on a folder of the template is refused by the plan, before anything is made or copied', async () => {
  // A project of its own (the others of this file are applied by earlier tests).
  const atelier = repo(path.join(m.place, 'atelier'), null, { 'README.md': '# atelier\n' });
  const p = await makePlan(atelier, opts());
  writePlan(p);
  writeTree(path.join(atelier, 'design-notes'), { 'one.md': 'one\n' });
  const before = allOf(atelier, ws, t.claude);
  // An edited plan: the folder goes onto docs, which Hoprig's template makes in the new project folder.
  fs.writeFileSync(planFile('atelier'), JSON.stringify({ ...p, neighbours: [...p.neighbours, { from: 'design-notes', kind: 'other', to: 'docs' }] }));
  const words = 'docs is a folder of the template: the plan must put design-notes elsewhere';
  assert.throws(() => readPlan('atelier', { projects }), (e) => e.code === 'EPLAN' && e.message.endsWith(words), 'the plan says so itself');
  await assert.rejects(applyPlan('atelier', { projects, workspace: ws, identity: { name: 'Alex', email: 'alex@example.invalid' } }), (e) => e.code === 'EPLAN' && e.message === `the plan is not one apply takes: ${words}`);
  assert.equal(fs.existsSync(path.join(projects, 'atelier')), false, 'no new project folder is made');
  assert.deepEqual(allOf(atelier, ws, t.claude), before, 'the original and the workspace are untouched');
});
