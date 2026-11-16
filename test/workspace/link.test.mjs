// Linking Claude Code's folder into the AI brain from the page (GET/POST /api/workspace/link over link.mjs), on
// temporary folders only: every action kind, a conflict left alone with its reason, a second run "already linked",
// the route behind the login with its input checked and no full path in its answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome, writeTree } from './helpers.mjs';

const t = tempHome('ws-link');
test.after(() => t.cleanup());
const { planLink, applyLink, planWords } = await import('../../src/workspace/link.mjs');
const { projectSlug } = await import('../../src/sessions.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const posix = process.platform !== 'win32';
let n = 0;
/** A fresh set of folders: { base, brain, home } plus the memory link's place. */
function place() {
  const root = path.join(t.root, `p${++n}`);
  const o = { base: path.join(root, 'claude'), brain: path.join(root, 'brain'), home: path.join(root, 'home') };
  for (const d of Object.values(o)) fs.mkdirSync(d, { recursive: true });
  return { ...o, mem: path.join(o.base, 'projects', projectSlug(o.home), 'memory') };
}

test('every action kind, in plain words, and a second run is already linked', { skip: !posix && 'links need rights on Windows' }, () => {
  // link (memory: nothing there), merge (skills: a real folder), backup (rules: the same text as the brain's)
  const a = place();
  writeTree(a.brain, { 'claude/CLAUDE.md': 'rules\n', 'skills/one/SKILL.md': 'one' });
  writeTree(a.base, { 'CLAUDE.md': 'rules\n', 'skills/mine/SKILL.md': 'mine' });
  const plan = planLink(a);
  assert.deepEqual(plan.map((p) => [p.id, p.action]), [['rules', 'backup'], ['skills', 'merge'], ['memory', 'link']]);
  assert.deepEqual(plan.map(planWords), [
    'it has the same text as the brain\'s, so it is kept as a backup and linked',
    'its files are merged into the brain, with a backup of the folder kept',
    'a new link',
  ]);
  const done = applyLink({ ...a, now: new Date('2026-11-16T10:00:00Z') });
  assert.ok(done.every((d) => d.done && !d.error), JSON.stringify(done));
  assert.equal(fs.realpathSync(path.join(a.base, 'skills')), fs.realpathSync(path.join(a.brain, 'skills')));
  assert.equal(fs.readFileSync(path.join(a.brain, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'mine', 'the folder\'s skill is in the brain now');
  assert.ok(fs.readdirSync(a.base).some((x) => x.startsWith('skills.backup-')), 'the folder is kept as a backup');
  assert.ok(fs.readdirSync(a.base).some((x) => x.startsWith('CLAUDE.md.backup-')), 'the rules file is kept as a backup');
  assert.equal(fs.realpathSync(a.mem), fs.realpathSync(path.join(a.brain, 'claude-memory', 'home')));
  // A second run changes nothing.
  const again = applyLink(a);
  assert.deepEqual(again.map((d) => [d.action, d.done]), [['already', 'already linked'], ['already', 'already linked'], ['already', 'already linked']]);
  assert.equal(planWords(again[0]), 'already linked');

  // adopt: a rules file and none in the brain
  const b = place();
  writeTree(b.base, { 'CLAUDE.md': 'from before\n' });
  assert.equal(planLink(b)[0].action, 'adopt');
  assert.equal(planWords(planLink(b)[0]), 'the rules file is moved into the brain, with a backup kept');
  assert.ok(!applyLink(b)[0].error);
  assert.equal(fs.readFileSync(path.join(b.brain, 'claude', 'CLAUDE.md'), 'utf8'), 'from before\n');
  assert.equal(fs.lstatSync(path.join(b.base, 'CLAUDE.md')).isSymbolicLink(), true);
});

test('a conflict is left alone and says why', { skip: !posix && 'links need rights on Windows' }, () => {
  const c = place();
  writeTree(c.brain, { 'claude/CLAUDE.md': 'brain rules\n' });
  writeTree(c.base, { 'CLAUDE.md': 'my other rules\n' });
  fs.mkdirSync(path.join(c.base, '..', 'elsewhere'));
  fs.symlinkSync(path.join(c.base, '..', 'elsewhere'), path.join(c.base, 'skills'));
  const plan = planLink(c);
  assert.deepEqual(plan.map((p) => p.action), ['conflict', 'conflict', 'link']);
  assert.match(planWords(plan[0]), /^left alone, because it differs from the brain's/);
  assert.match(planWords(plan[1]), /^left alone, because it is a link to /);
  const done = applyLink(c);
  assert.deepEqual(done.map((d) => d.done), ['left alone', 'left alone', 'linked']);
  assert.equal(fs.readFileSync(path.join(c.base, 'CLAUDE.md'), 'utf8'), 'my other rules\n', 'never overwritten');
  assert.equal(fs.readlinkSync(path.join(c.base, 'skills')), path.join(c.base, '..', 'elsewhere'), 'the other link stays');
});

test('the route: login, Tia refused, the plan, then the result, then already linked; no full path back', { skip: !posix && 'links need rights on Windows' }, async () => {
  const r = place();
  writeTree(r.brain, { 'claude/CLAUDE.md': 'rules\n', 'skills/one/SKILL.md': 'one' });
  writeTree(r.base, { 'skills/mine/SKILL.md': 'mine' });
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, workspace: { link: { base: r.base, brain: r.brain, home: r.home } } });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${origin}/api/workspace/link`)).status, 401);
    assert.equal((await fetch(`${origin}/api/workspace/link`, { headers: { Authorization: 'Bearer tia_0123456789abcdef' } })).status, 401);
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = (body, o = origin) => fetch(`${origin}/api/workspace/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o, Cookie: cookie }, body: JSON.stringify(body) });

    const plan = await (await fetch(`${origin}/api/workspace/link`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(plan.entries.map((e) => [e.id, e.action]), [['rules', 'link'], ['skills', 'merge'], ['memory', 'link']]);
    assert.equal(plan.brain, true);
    assert.equal(plan.todo, 3);
    assert.equal(plan.already, false);
    assert.ok(plan.entries.every((e) => typeof e.words === 'string' && e.words.length > 5));
    assert.equal(fs.lstatSync(path.join(r.base, 'skills')).isSymbolicLink(), false, 'GET changes nothing');

    assert.equal((await post({}, 'http://evil.example')).status, 403, 'another site cannot do it');
    assert.equal((await post({ base: '/' })).status, 400, 'nothing else is taken: no folder from the browser');
    const done = await (await post({})).json();
    assert.ok(done.entries.every((e) => e.done && !e.error), JSON.stringify(done));
    assert.match(done.entries[1].done, /^moved 1 file in, then linked/);
    assert.equal(fs.realpathSync(path.join(r.base, 'skills')), fs.realpathSync(path.join(r.brain, 'skills')));

    const again = await (await post({})).json();
    assert.equal(again.already, true);
    assert.equal(again.todo, 0);
    assert.ok(again.entries.every((e) => e.done === 'already linked'));
    // Only the short forms of the paths go to the page (these temp folders are not under the home, so they
    // show in full: the point is that only the fields the page needs are sent).
    assert.deepEqual(Object.keys(again.entries[0]).sort(), ['action', 'done', 'id', 'link', 'target', 'tool', 'tools', 'what', 'words']);
    assert.deepEqual(again.tools, [{ id: 'claude', name: 'Claude Code', state: 'linked', todo: 0, left: 0 }]);
  } finally {
    await app.close();
  }
});

test('every coding tool that is on: Codex and OpenCode read the same rules and skills; OpenCode names the rules folder and memory index; one Memory section', { skip: !posix && 'links need rights on Windows' }, () => {
  const a = place();
  const homes = { codex: path.join(a.home, '.codex'), opencode: path.join(a.home, '.config', 'opencode') };
  const all = { ...a, homes, tools: ['claude', 'codex', 'opencode'] };
  writeTree(a.brain, { 'skills/one/SKILL.md': 'one' });
  writeTree(a.base, { 'CLAUDE.md': 'my rules\n' }); // adopted into the brain: the Memory section is planned after it
  writeTree(homes.opencode, { 'opencode.json': JSON.stringify({ model: 'x/y', instructions: ['mine.md'] }) });
  const plan = planLink(all);
  assert.deepEqual(plan.map((p) => [p.id, p.action, p.tools.join('+')]), [
    ['rules', 'adopt', 'claude'], ['skills', 'link', 'claude'], ['memory', 'link', 'claude'],
    ['codex:rules', 'conflict', 'codex'], ['codex:skills', 'link', 'codex+opencode'],
    ['opencode:rules', 'conflict', 'opencode'], ['opencode:instructions', 'link', 'opencode'],
    ['memory-note', 'conflict', 'codex+opencode'],
  ], 'nothing in the brain yet: the other rules links wait for the adopted file');
  assert.equal(plan[4].what, 'your skills, for Codex and OpenCode');
  assert.equal(planWords(plan[6]), `${path.join(a.base, 'rules')}/*.md and ai_brain/claude-memory/MEMORY.md added to its "instructions"`);
  // Done in order, each planned again just before: the adopted rules file is there for the others.
  const done = applyLink({ ...all, now: new Date('2026-11-16T10:00:00Z') });
  assert.ok(done.every((d) => d.done && !d.error), JSON.stringify(done.map((d) => [d.id, d.action, d.done, d.error])));
  const rules = path.join(a.brain, 'claude', 'CLAUDE.md');
  for (const l of [path.join(a.base, 'CLAUDE.md'), path.join(homes.codex, 'AGENTS.md'), path.join(homes.opencode, 'AGENTS.md')]) assert.equal(fs.realpathSync(l), fs.realpathSync(rules), l);
  assert.equal(fs.realpathSync(path.join(a.home, '.agents', 'skills')), fs.realpathSync(path.join(a.brain, 'skills')));
  const oc = JSON.parse(fs.readFileSync(path.join(homes.opencode, 'opencode.json'), 'utf8'));
  assert.deepEqual(oc, { model: 'x/y', instructions: ['mine.md', `${path.join(a.base, 'rules')}/*.md`, 'ai_brain/claude-memory/MEMORY.md'] }, 'the owner\'s keys stay');
  assert.ok(fs.readdirSync(homes.opencode).some((f) => f.startsWith('opencode.json.backup-')), 'the old settings are kept');
  const text = fs.readFileSync(rules, 'utf8');
  assert.ok(text.startsWith('my rules\n\n<!-- hoprig: memory'), 'the section goes after the owner\'s text');
  assert.match(text, /ai_brain\/claude-memory\/` \(in the project's own folder\); `MEMORY\.md` there is\nthe index/);
  // A second run: everything already, the section once.
  const again = applyLink(all);
  assert.deepEqual(again.map((d) => d.action), Array(8).fill('already'));
  assert.equal(fs.readFileSync(rules, 'utf8').split('<!-- hoprig: memory').length, 2);
  // Only Claude Code on: its three entries, no Memory section.
  assert.deepEqual(planLink({ ...a, tools: ['claude'] }).map((p) => p.id), ['rules', 'skills', 'memory']);
  // OpenCode alone: its own skills entry.
  assert.deepEqual(planLink({ ...a, homes, tools: ['opencode'] }).map((p) => p.id), ['opencode:rules', 'opencode:skills', 'opencode:instructions', 'memory-note']);
});

test('settings OpenCode keeps in a form Hoprig does not write, and a different Codex rules file, are left alone', { skip: !posix && 'links need rights on Windows' }, () => {
  const a = place();
  const homes = { codex: path.join(a.home, '.codex'), opencode: path.join(a.home, '.config', 'opencode') };
  writeTree(a.brain, { 'claude/CLAUDE.md': 'brain rules\n' });
  writeTree(homes.codex, { 'AGENTS.md': 'codex only rules\n' });
  const o = { ...a, homes, tools: ['codex', 'opencode'] };
  const cases = [
    [{ 'opencode.jsonc': '{ // mine\n}' }, /opencode\.jsonc \(with comments\)/],
    [{ 'opencode.json': '{ not json' }, /not a settings file Hoprig can read/],
    [{ 'opencode.json': '{"instructions":"one.md"}' }, /its "instructions" is not a list/],
  ];
  for (const [files, why] of cases) {
    fs.rmSync(homes.opencode, { recursive: true, force: true });
    writeTree(homes.opencode, files);
    const before = Object.fromEntries(Object.keys(files).map((f) => [f, fs.readFileSync(path.join(homes.opencode, f), 'utf8')]));
    const ins = applyLink(o).find((d) => d.id === 'opencode:instructions');
    assert.equal(ins.action, 'conflict');
    assert.match(ins.why, why);
    for (const [f, t] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(homes.opencode, f), 'utf8'), t, 'never changed');
  }
  const cx = planLink(o).find((p) => p.id === 'codex:rules');
  assert.equal(cx.action, 'conflict');
  assert.match(cx.why, /differs from the brain's/);
  assert.equal(fs.readFileSync(path.join(homes.codex, 'AGENTS.md'), 'utf8'), 'codex only rules\n');
});
