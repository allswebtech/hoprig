// The release proof that a lost computer costs nothing (tools/lostcomputer.mjs, RELEASING.md): a workspace with work
// in progress on home A, the upkeep and a drop, the whole-computer check, home A deleted, home B restored from the
// stand-in git server only, and every repository compared. Each run takes 8 to 15 seconds; the file about half a minute.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PREFIX, REFUSED, main, report } from '../../tools/lostcomputer.mjs';

const RUN_MS = 300_000;
const NOTES = '~/Workspace/projects/notes/code/notes-app';
const BLOG = '~/Workspace/projects/blog/code/blog-site';
const ours = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX)).sort();

test('home B has everything home A had, except the work the check named before home A was deleted', { timeout: RUN_MS }, async () => {
  const r = await main();
  const words = report(r);
  assert.equal(r.refused, undefined, words);
  assert.equal(r.onlyNamed, true, words);
  assert.equal(r.equal, true, words);
  // What differs is exactly the work that was never pushed: the commit on notes-app's main and blog-site's change.
  const named = [...new Set(r.differences.map((d) => d.named))].sort();
  assert.deepEqual(named, [`branch:${NOTES}:main`, `work:${BLOG}`], words);
  assert.ok(r.differences.some((d) => d.where === NOTES && d.kind === 'branch' && /src\/today\.js is not on the second home/.test(d.what)), words);
  assert.ok(r.differences.some((d) => d.where === BLOG && d.kind === 'work' && /README\.md/.test(d.what)), words);
  // Everything pushed is equal: the branch the upkeep pushed, the dropped project, the brain's memory with its new file.
  assert.ok(!r.differences.some((d) => /shop|ai_brain|credentials|kits/.test(d.where)), words);
  assert.match(words, /feature\/login/, 'the upkeep pushed the other branch');
  assert.match(words, /hoprig drop shop: dropped/);
  assert.ok(r.compared.branches >= 12 && r.compared.memoryFiles >= 3, JSON.stringify(r.compared));
  assert.deepEqual(ours(), [], 'the run removed its folders');
});

test('a tracked file changed after the check is a difference nobody named', { timeout: RUN_MS }, async () => {
  const core = '~/Workspace/kits/packs/tool/code/tool-core';
  const r = await main({ afterCheck: ({ ws }) => fs.writeFileSync(path.join(ws, 'kits', 'packs', 'tool', 'code', 'tool-core', 'README.md'), '# changed after the check\n') });
  const words = report(r);
  assert.equal(r.onlyNamed, false, words);
  assert.equal(r.equal, false, words);
  const not = r.differences.filter((d) => !d.named);
  assert.deepEqual(not.map((d) => [d.where, d.what]), [[core, 'not committed: README.md']], words);
  assert.match(words, /SOMETHING WOULD BE LOST: 1 differences/);
});

test('outside the runner it refuses in one sentence and makes no folder', async () => {
  const before = ours();
  const env = { ...process.env };
  delete env.HOPRIG_TEST_TRAPS;
  const r = await main({ env });
  assert.equal(r.refused, REFUSED);
  assert.equal(r.equal, false);
  assert.deepEqual(ours(), before);
  // The account's own home, named as each system names it (Windows reads USERPROFILE and the two app folders).
  const own = os.userInfo().homedir;
  const home = await main({ env: { ...process.env, HOME: own, USERPROFILE: own, APPDATA: path.join(own, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(own, 'AppData', 'Local') } });
  assert.equal(home.refused, REFUSED, 'the account\'s own home is refused too');
  assert.deepEqual(ours(), before);
});
