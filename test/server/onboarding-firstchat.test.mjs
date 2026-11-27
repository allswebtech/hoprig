// POST /api/onboarding/first-chat: the first project is a folder my-first-project in the projects folder, made once
// ("-2" when the name is taken), nowhere else, and the first run is marked done. Owner only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('onboarding-firstchat');
test.after(box.cleanup);
const ON = await import('../../src/setup/onboarding.mjs');
const { loadConfig } = await import('../../src/config.mjs');

const projects = path.join(box.root, 'where-projects-live');
function feature(authed = true) {
  const f = ON.onboardingFeature({ authed: () => authed, readJson: async () => ({}), backend: { list: async () => [] }, deck: {} }, { projectsDir: () => projects });
  const [, , fn] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/onboarding/first-chat'));
  return () => fn({ headers: {} });
}

test('the folder is made in the projects folder, with nothing in it, and the first run is marked done', async () => {
  const call = feature();
  assert.equal(loadConfig().server.getStartedDismissed === true, false);
  const r = await call();
  assert.deepEqual(r, { dir: path.join(projects, 'my-first-project'), name: 'my-first-project' });
  assert.ok(fs.statSync(r.dir).isDirectory());
  assert.deepEqual(fs.readdirSync(r.dir), [], 'no git, no file');
  assert.equal(loadConfig().server.getStartedDismissed, true);
});

test('a name that is taken gets -2, then -3; a folder that is there is never touched', async () => {
  const call = feature();
  fs.writeFileSync(path.join(projects, 'my-first-project', 'keep.txt'), 'mine');
  assert.equal((await call()).name, 'my-first-project-2');
  assert.equal((await call()).name, 'my-first-project-3');
  assert.equal(fs.readFileSync(path.join(projects, 'my-first-project', 'keep.txt'), 'utf8'), 'mine');
  // Every one of them is directly inside the projects folder.
  assert.deepEqual(fs.readdirSync(projects).sort(), ['my-first-project', 'my-first-project-2', 'my-first-project-3']);
});

test('owner only', async () => {
  await assert.rejects(feature(false)(), (e) => e.status === 403);
});
