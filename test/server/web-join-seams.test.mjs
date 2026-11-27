// The seams between the Work page and the Computers pages (joined): the Operator's computers box sits in this
// computer's Overview, the old Team address lands on Plans, and Tia's switches are reached from Settings, Tia.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

test('the computers box of the Operator is a part of this computer\'s Overview, drawn once', () => {
  const pc = src('pc.js');
  assert.match(pc, /import \{ roomsPart \} from '\.\/operator-rooms\.js'/);
  const overview = pc.slice(pc.indexOf('function overview(ctx)'), pc.indexOf('const diskRow'));
  assert.match(overview, /roomsPart\(/, 'Overview draws the box');
  assert.match(overview, /machine\.current/, 'only on this computer: the list is this hub\'s');
  assert.match(overview, /computer-more[\s\S]*rooms/, 'it sits inside the closed fold, not on the first screen');
  assert.ok(overview.indexOf('roomsPart(') < overview.indexOf('const paint'), 'made once, not at every repaint');
});

test('no page link still names the Team tab: Plans holds the missions, Settings, Tia her switches', () => {
  const mission = src('mission.js');
  assert.doesNotMatch(mission, /href: '#\/work\/team'/);
  assert.match(mission, /href: '#\/settings\/tia'/, 'her switches are linked from the Tia part of Settings');
  assert.match(src('app.js'), /'#\/work\/team'/, 'the old address is still a known page that is sent on');
  assert.match(src('work.js'), /OLD_ADDRESSES = \{ today: 'tasks', golive: 'tasks', team: 'plans' \}/);
});
