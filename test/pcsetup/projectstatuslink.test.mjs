// `hoprig project status <name>` for a project folder that is there but leads out through a link (the owner's project
// on another disk, not named yet) says it is not followed, with the mylink command, never "no projects named".
// Temporary homes and local bare repositories only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from '../workspace/gitfix.mjs';

const w = gitWorld('ws-projectstatuslink');
test.after(() => w.cleanup());
const A = w.computer('alex');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const { saveConfig } = await import('../../src/config.mjs');
const { projectStatus } = await import('../../src/pcsetup/project.mjs');
saveConfig({ projectsDir: A.projects });
w.clone(w.bare('shop'), path.join(A.projects, 'shop'));
const away = w.clone(w.bare('handbook'), path.join(A.home, 'elsewhere', 'handbook'));
fs.symlinkSync(away, path.join(A.projects, 'handbook'));

test('project status of a folder behind a link: not followed, with the command; a name that is nowhere: none', { skip: process.platform === 'win32' && 'links need rights on Windows' }, async () => {
  const link = path.join(A.projects, 'handbook');
  let q = await quietUi();
  const code = await projectStatus(['handbook'], { ui: q.ui, write: () => {} });
  assert.equal(code, 1);
  assert.ok(q.text().includes(`handbook: not followed: ${link} leaves its folder through a link; if it is yours:  hoprig workspace mylink add ${link}`), q.text());
  assert.doesNotMatch(q.text(), /No projects/);
  q = await quietUi();
  assert.equal(await projectStatus(['nowhere'], { ui: q.ui, write: () => {} }), 0);
  assert.match(q.text(), /No projects in .* named nowhere/);
  q = await quietUi();
  assert.equal(await projectStatus(['shop'], { ui: q.ui, write: () => {} }), 0);
  assert.match(q.text(), /shop/);
});
