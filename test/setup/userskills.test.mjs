// The skills meant for the user (firstrun.mjs userSkills): added without a question only on a first run; where some of
// Hoprig's skills are there already, a missing one is asked about at a terminal and left alone without one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox, skillMd, writeTree } from '../skillhub/helpers.mjs';

const box = sandbox('setup-userskills');
test.after(() => box.cleanup());
const { userSkills } = await import('../../src/setup/firstrun.mjs');
const { loadCatalog } = await import('../../src/skillhub/catalog.mjs');

test('a computer that has one of the skills: a missing one is not added without a question', async () => {
  const user = loadCatalog().entries.filter((e) => e.scope === 'user');
  assert.ok(user.length >= 2);
  const dir = path.join(box.claude, 'skills');
  writeTree(dir, { [`${user[0].skill}/SKILL.md`]: skillMd(user[0].skill) });
  const asked = [];
  const ui = { interactive: false, yes: false, say: () => {}, confirm: async (q) => (asked.push(q), false) };
  const r = await userSkills({ ui });
  assert.deepEqual(r.added, []);
  assert.ok(asked.length >= 1, 'it asked');
  assert.deepEqual(fs.readdirSync(dir).sort(), [user[0].skill]);
});
