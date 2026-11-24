// Plan with AI opens on the provider a new session would start on, also before a project is chosen, so the sheet never
// opens on "Choose one" with a grey Plan button.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-plandefault');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { planRunner } = await import('../../src/work/planai.mjs');

t.repo(t.brain, { 'README.md': '# brain\n', 'work/tasks.json': '{\n  "items": []\n}\n' });
t.repo(`${t.projects}/shop`, { 'README.md': '# shop\n' });
const cfg = { work: { ownerId: 'alex' } };
saveConfig(cfg);
writeProfile('sub', { label: 'Main' });

test('no project chosen yet: the provider is the new-session default, asked without a folder', async () => {
  const asked = [];
  const planner = planRunner({ config: () => cfg, chat: { open() {}, peek() {}, follow() { return () => {}; }, turnEnd: () => null }, defaultProvider: async (dir, last, tool) => { asked.push([dir, last, tool]); return 'sub'; } });
  const ch = await planner.choices({});
  assert.equal(ch.project, null);
  assert.equal(ch.provider, 'sub');
  assert.deepEqual(asked, [[null, null, 'claude']]);
  const withProject = await planner.choices({ project: 'shop' });
  assert.equal(withProject.provider, 'sub');
  assert.match(String(asked[1][0]), /shop$/, 'with a project, its folder is asked as before');
});
