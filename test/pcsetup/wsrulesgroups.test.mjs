// The generated "Your workspace" section after groups are added (wsrules.mjs): a group add writes nothing a coding tool
// reads; written with the owner's yes, the section holds each of his groups once, between its first and its closing
// marker line; written twice, still once each, and nothing after the closing line is Hoprig's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from '../workspace/gitfix.mjs';

const w = gitWorld('ws-rules-groups');
test.after(() => w.cleanup());
const C = w.computer('desk');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const S = await import('../../src/pcsetup/wsrules.mjs');
const M = await import('../../src/workspace/map.mjs');
const { groupAdd } = await import('../../src/workspace/groupcmd.mjs');
const { saveConfig } = await import('../../src/config.mjs');

test('after a group is added and the text written with his yes: each group once, between the marker lines; twice: the same', async () => {
  w.bare('brain');
  w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
  fs.mkdirSync(C.projects, { recursive: true });
  saveConfig({ projectsDir: C.projects });
  M.writeMap({ version: 2, brain: { url: w.url('brain') }, projects: [], others: [] }, C.ws);
  const file = S.workspaceRulesFile();
  for (const g of ['kits', 'client-work']) {
    fs.mkdirSync(path.join(C.ws, g), { recursive: true });
    await groupAdd(g, { dir: C.ws, projects: C.projects });
  }
  assert.equal(fs.existsSync(file), false, 'a group add itself writes nothing a coding tool reads');
  const write = async () => S.writeWorkspaceRules({ text: (await S.currentWorkspaceRules({ dir: C.ws, projects: C.projects })).text });
  assert.equal((await write()).changed, true);
  const once = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(path.join(C.ws, 'more'), { recursive: true });
  await groupAdd('more', { dir: C.ws, projects: C.projects });
  await write();
  await write();
  const t = fs.readFileSync(file, 'utf8');
  const lines = t.split('\n');
  assert.equal(lines[0], S.FIRST_LINE);
  assert.equal(lines.filter((l) => l === S.FIRST_LINE).length, 1, 'one opening line');
  assert.equal(lines.filter((l) => l === S.LAST_LINE).length, 1, 'one closing line');
  const end = lines.indexOf(S.LAST_LINE);
  assert.deepEqual(lines.slice(end + 1).filter(Boolean), [], 'nothing after the closing line');
  for (const g of ['kits', 'client-work', 'more']) {
    assert.equal(lines.filter((l) => l.startsWith(`- \`${g}/\``)).length, 1, `${g} once`);
    assert.ok(lines.findIndex((l) => l.startsWith(`- \`${g}/\``)) < end, `${g} before the closing line`);
  }
  assert.ok(once.includes(S.LAST_LINE));
});
