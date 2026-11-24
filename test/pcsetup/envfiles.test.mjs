// `project setup` makes no .env in a repository that already has another .env* file (.env.local, .env.production):
// a project that ran before loads those, and a new .env beside them can change what it loads. The dry run and the
// run say the same, and the run changes nothing in the home (a whole-home snapshot).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from '../workspace/helpers.mjs';

const t = tempHome('envfiles');
process.env.HOPRIG_WORKSPACE_DIR = t.ws;
test.after(() => t.cleanup());
const { projectSetup } = await import('../../src/pcsetup/project.mjs');
const { projectNeeds, otherEnvFiles } = await import('../../src/pcsetup/projects.mjs');
const { quietUi } = await import('./dryrun-fixture.mjs');

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = e.isSymbolicLink() ? `-> ${fs.readlinkSync(p)}` : crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

const shop = path.join(t.ws, 'projects', 'shop');
fs.mkdirSync(shop, { recursive: true });
fs.writeFileSync(path.join(shop, 'project.json'), JSON.stringify({ name: 'shop', repos: [], memories: {} }));
fs.writeFileSync(path.join(shop, '.env.example'), 'KEY=\n');
fs.writeFileSync(path.join(shop, '.env.local'), 'KEY=mine\n');
fs.writeFileSync(path.join(shop, '.env.production'), 'KEY=live\n');
// A project is a git repository of its own (the identity is the test home's).
execFileSync('git', ['-C', shop, 'init', '-q', '-b', 'main']);
execFileSync('git', ['-C', shop, 'add', 'project.json', '.env.example']);
execFileSync('git', ['-C', shop, 'commit', '-q', '-m', 'shop']);

test('other .env files: the example is not copied, by the plan and by the copy', () => {
  assert.deepEqual(otherEnvFiles(shop), ['.env.local', '.env.production']);
  assert.equal(projectNeeds(shop, { has: () => true }).envExample, false);
});

test('project setup, dry run and run: no .env, the same words, nothing in the home changed', async () => {
  const before = snapshot(t.root);
  const dry = await quietUi();
  assert.equal(await projectSetup(['shop', '--dry-run'], { ui: dry, runner: async () => assert.fail('nothing runs') }), 0, dry.text());
  const run = await quietUi();
  assert.equal(await projectSetup(['shop', '--yes'], { ui: run, runner: async () => assert.fail('nothing runs') }), 0);
  assert.equal(fs.existsSync(path.join(shop, '.env')), false);
  for (const ui of [dry, run]) {
    assert.doesNotMatch(ui.text(), /copy \.env\.example to \.env/);
    assert.match(ui.text(), /nothing to set up/);
  }
  assert.deepEqual(snapshot(t.root), before);
});

test('without other .env files the example is still copied', () => {
  const lone = path.join(t.root, 'lone');
  fs.mkdirSync(lone);
  fs.writeFileSync(path.join(lone, '.env.example'), 'KEY=\n');
  assert.equal(projectNeeds(lone, { has: () => true }).envExample, true);
});
