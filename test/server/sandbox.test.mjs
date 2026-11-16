// The test sandbox (helpers.mjs) keeps a test dashboard apart from the session that runs the tests: no run record of
// that session, and no GitHub sign-in of the person (Setup reads it with `gh auth status`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

test('a sandbox drops the running session\'s run file and any GitHub sign-in', async (t) => {
  process.env.HOPRIG_RUN_FILE = '/somewhere/real.json';
  process.env.HOPRIG_TERM_ID = 't-real';
  process.env.GH_TOKEN = 'not-a-real-token';
  const box = sandbox('sandbox');
  t.after(() => box.cleanup());
  assert.equal(process.env.HOPRIG_RUN_FILE, undefined);
  assert.equal(process.env.HOPRIG_TERM_ID, undefined);
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.ok(process.env.GH_CONFIG_DIR.startsWith(box.root + path.sep));
  // With GitHub's command on this computer: Setup's own check finds nobody signed in.
  if (spawnSync('gh', ['--version']).status !== 0) return t.skip('gh is not installed');
  const { gitState } = await import('../../src/workspace/gitstep.mjs');
  const st = await gitState({ dir: box.workspace });
  assert.deepEqual([st.gh.installed, st.gh.signedIn, st.gh.account], [true, false, null]);
});
