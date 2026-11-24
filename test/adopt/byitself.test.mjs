// Nothing of hoprig adopt runs, looks or copies by itself: a real dashboard start and three of its upkeep ticks, in
// a home that holds a made-up computer with projects (its usual place ~/code among them). Every path of the home is
// the same afterwards in the scanned place, and no git command ever named it; no plan file is written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { allOf, madeUpComputer, traps } from './fixture.mjs';

test('a dashboard start and three ticks never look at, plan or copy the projects of this computer', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async () => {
  const box = sandbox('adopt-byitself');
  process.env.HOME = box.home;
  const m = madeUpComputer({ root: box.home, home: box.home, claude: box.claude });
  const trap = traps(box.root);
  const before = allOf(m.place, m.server, box.claude);
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `adopt-byitself-${process.pid}` });
  try {
    await app.listen(0, '127.0.0.1');
    for (let i = 0; i < 3; i++) await app.watcher.tick();
  } finally {
    await app.close();
  }
  try {
    assert.deepEqual(allOf(m.place, m.server, box.claude), before, 'the projects, their server and the coding tool\'s folder are as they were');
    assert.ok(!fs.existsSync(path.join(box.state, 'adopt')), 'no plan and no record of an arrange');
    assert.ok(!fs.readdirSync(path.join(box.workspace)).includes('projects') || fs.readdirSync(path.join(box.workspace, 'projects')).length === 0, 'nothing was arranged into the workspace');
    assert.deepEqual(trap.calls().filter((l) => l.includes(m.place)), [], 'no git command named the scanned place');
    assert.deepEqual(trap.trapped().filter((l) => !/^TRAP gh auth status/.test(l)), [], 'nothing pushed, fetched or installed');
  } finally {
    box.cleanup();
  }
});
