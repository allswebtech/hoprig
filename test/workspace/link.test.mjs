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
    assert.deepEqual(Object.keys(again.entries[0]).sort(), ['action', 'done', 'id', 'link', 'target', 'what', 'words']);
  } finally {
    await app.close();
  }
});
