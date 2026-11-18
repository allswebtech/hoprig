// A project folder of the map that is here but leads out through a link (an owner's project kept on another disk,
// before he names the link) is "not followed", never "not on this computer": status, status --json, doctor and
// workspace map say so with the mylink command, and none of them counts it as missing or suggests restore. Temporary
// homes and local bare repositories only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-mapnotfollowed');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { workspaceChecks } = await import('../../src/workspace/doctor.mjs');
const { saveConfig } = await import('../../src/config.mjs');

const A = w.computer('alex');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
saveConfig({ projectsDir: A.projects });
w.clone(w.bare('brain'), path.join(A.ws, 'ai_brain'));
w.clone(w.bare('shop'), path.join(A.projects, 'shop'));
const away = w.clone(w.bare('handbook'), path.join(A.home, 'elsewhere', 'handbook'));
fs.symlinkSync(away, path.join(A.projects, 'handbook'));
M.writeMap({ version: 2, brain: { url: w.url('brain') }, projects: [{ name: 'shop', url: w.url('shop'), repos: [] }, { name: 'handbook', url: w.url('handbook'), repos: [] }], others: [] }, A.ws);

test('a project folder behind a link that leads out: not followed, with the mylink command; never missing, never restore', { skip: process.platform === 'win32' && 'links need rights on Windows' }, async () => {
  const link = path.join(A.projects, 'handbook');
  let json = '';
  await main(['status', '--json'], { ui: (await quietUi()).ui, write: (s) => (json += s) });
  const s = JSON.parse(json);
  const e = s.map.entries.find((x) => x.label === 'handbook');
  assert.equal(e.state, 'notFollowed');
  assert.match(e.fix, new RegExp(`if it is yours: {2}hoprig workspace mylink add ${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(s.map.counts.missing, undefined, 'nothing is counted as missing');
  const q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.match(q.text(), /handbook .*behind a link that leads out: not followed .*hoprig workspace mylink add/);
  assert.doesNotMatch(q.text(), /handbook .*not on this computer/);
  const d = (await workspaceChecks()).find((c) => c.id === 'workspace-map');
  assert.match(d.detail || d.message || JSON.stringify(d), /1 behind a link that leads out \(not followed\)/);
  assert.doesNotMatch(JSON.stringify(d), /not on this computer|workspace restore/);
  assert.match(JSON.stringify(d), /hoprig workspace mylink add/);
  const m = await quietUi();
  await main(['map', '--dry-run'], { ui: m.ui, write: () => {} });
  assert.match(m.text(), /in the map and here, behind a link that leads out .*: handbook/);
  assert.doesNotMatch(m.text(), /not on this computer \(kept.*handbook/);
});
