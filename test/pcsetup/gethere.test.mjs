// `hoprig get` of a project that is already on the computer changes nothing inside it without asking: it says what a
// fresh clone would have set up and is missing there (a .env from .env.example, git hooks, the memory link, installs)
// and the command that does it (`hoprig project setup <name>`); at a terminal it asks for each one, and Enter leaves
// it. A code repository that is missing is cloned and set up like a fresh clone; a fresh clone of the whole project
// still gets everything. The world is dryrun-fixture.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { changes, gh, makeWorld, quietUi, snapshot } from './dryrun-fixture.mjs';

const { getProject } = await import('../../src/pcsetup/getproject.mjs');
const exists = (p) => fs.existsSync(p);
const inside = (w, diff, dir) => diff.split('\n').filter((l) => l && l.split(' ')[1].startsWith(`${path.relative(w.root, dir)}/`));

async function world(tc, name) {
  const w = await makeWorld(name);
  tc.after(() => w.cleanup());
  return w;
}

test('get of a project that is here, without a terminal: nothing inside it changes; what is missing is said with the command', async (tc) => {
  const w = await world(tc, 'here');
  for (const yes of [false, true]) {
    const ui = await quietUi({ yes });
    const before = snapshot(w);
    const r = await getProject('shop', { ui, dir: w.projects });
    assert.equal(r.result, 'here', ui.text());
    assert.equal(r.ok, true);
    const diff = changes(before, snapshot(w));
    assert.deepEqual(inside(w, diff, w.shop), [], `${yes ? '--yes: ' : ''}the project was changed:\n${diff}`);
    assert.deepEqual(inside(w, diff, path.join(w.home, '.claude')), [], 'no memory link was made');
    assert.match(ui.text(), /shop was already here, so nothing in it was changed\. A fresh clone would also link Claude Code's memory for the project to ai_brain\/claude-memory; use the git hooks in \.githooks for shop; use the git hooks in \.githooks for shop\/code\/shop-api; copy \.env\.example to \.env in shop\/code\/shop-api; run npm install in shop\/code\/shop-web\. To do that: {2}hoprig project setup shop/);
  }
});

test('get of a project that is here, at a terminal: each item is asked, Enter leaves it, y does that one only', async (tc) => {
  const w = await world(tc, 'ask');
  const ui = await quietUi({ interactive: true, answers: (q) => (/copy \.env\.example/.test(q) ? 'y' : '') });
  await getProject('shop', { ui, dir: w.projects });
  assert.deepEqual(ui.asked.map((q) => q.trim().replace(/ \(y\/N\)$/, '')), [
    'shop was already here: link Claude Code\'s memory for the project to ai_brain/claude-memory?',
    'shop was already here: use the git hooks in .githooks for shop?',
    'shop was already here: use the git hooks in .githooks for shop/code/shop-api?',
    'shop was already here: copy .env.example to .env in shop/code/shop-api?',
    'shop was already here: run npm install in shop/code/shop-web?',
  ]);
  assert.ok(exists(path.join(w.shop, 'code', 'shop-api', '.env')), 'the one answered with y');
  assert.equal(fs.readdirSync(path.join(w.home)).includes('.claude'), false, 'no memory link');
  assert.throws(() => w.sh(w.shop, 'config', '--get', 'core.hooksPath'), 'no hooks path');
  assert.ok(!exists(path.join(w.shop, 'code', 'shop-web', 'node_modules')));
  assert.doesNotMatch(ui.text(), /To do that/, 'nothing is left to say: each was asked');
});

test('get of a project that is here with a code repository missing: that one is cloned and set up, the rest is not touched', async (tc) => {
  const w = await world(tc, 'missing');
  fs.rmSync(path.join(w.shop, 'code', 'shop-api'), { recursive: true, force: true });
  const ui = await quietUi();
  const r = await getProject('shop', { ui, dir: w.projects });
  assert.deepEqual(r.repos, [{ dir: 'code/shop-api', result: 'cloned' }, { dir: 'code/shop-web', result: 'here' }]);
  const api = path.join(w.shop, 'code', 'shop-api');
  assert.ok(exists(path.join(api, '.env')), 'the code repository this run cloned gets its .env');
  assert.equal(w.sh(api, 'config', '--get', 'core.hooksPath'), '.githooks');
  assert.throws(() => w.sh(w.shop, 'config', '--get', 'core.hooksPath'), 'the parent that was here is not changed');
  assert.match(ui.text(), /shop was already here, so nothing in it was changed\. A fresh clone would also link .*use the git hooks in \.githooks for shop; run npm install in shop\/code\/shop-web\. To do that/);
});

test('a fresh clone still gets everything set up', async (tc) => {
  const w = await world(tc, 'fresh');
  const ui = await quietUi();
  const r = await getProject('blog', { ui, dir: w.projects });
  assert.equal(r.result, 'cloned', ui.text());
  const blog = path.join(w.projects, 'blog');
  assert.ok(exists(path.join(blog, 'code', 'blog-app', '.env')));
  const links = fs.readdirSync(path.join(w.home, '.claude', 'projects'));
  assert.equal(links.length, 1);
  assert.equal(fs.realpathSync(path.join(w.home, '.claude', 'projects', links[0], 'memory')), path.join(blog, 'ai_brain', 'claude-memory'));
  assert.doesNotMatch(ui.text(), /was already here/);
});

test('pc clone of a repository that is here: no .env made in it, no install run in it', async (tc) => {
  const w = await world(tc, 'pcclone');
  const { projectsStep } = await import('../../src/pcsetup/setup.mjs');
  const ran = [];
  const ui = await quietUi({ yes: true });
  const sys = { home: w.home, has: () => true };
  const r = await projectsStep(ui, sys, { recipe: { projectsDir: path.join(w.shop, 'code'), repos: [gh('shop-api'), gh('shop-web')] }, runner: async (argv) => (ran.push(argv), { ok: true }), remember: () => {} });
  assert.deepEqual(r.cloned, []);
  assert.ok(!exists(path.join(w.shop, 'code', 'shop-api', '.env')), ui.text());
  assert.deepEqual(ran, [], 'nothing was run in them');
});
