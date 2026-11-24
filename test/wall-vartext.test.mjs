// A HOPRIG_* variable is the owner's only where a command USES it as a value or SETS it for a
// program it starts — not where the name merely appears in text (a search pattern, a commit message, source). A
// Hands-off session working on Hoprig's own code (where these names are everywhere) must not stop at every grep or
// commit. The reader cannot tell a value read from a value write with certainty, so a value use is held either way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-vartext-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const cfg = path.join(home, '.config', 'hoprig');
const state = path.join(home, '.local', 'state', 'hoprig');
const shop = path.join(home, 'work', 'shop');
for (const d of [cfg, state, shop]) fs.mkdirSync(d, { recursive: true });
const places = { cwd: shop, home, workspace: path.join(home, 'work'), projects: [path.join(home, 'projects')], hoprig: [cfg, state], own: shop, relative: true };
const held = (cmd) => wallHeld({ tool: 'Bash', input: { command: cmd }, cwd: shop, places });

test('a HOPRIG_* variable used as a value or set for a program is held', () => {
  assert.equal(held('cat $HOPRIG_RUN_FILE').kind, 'settings');
  assert.equal(held('cat "${HOPRIG_STATE_DIR}/x"').kind, 'settings');
  assert.equal(held('HOPRIG_CONFIG_DIR=/tmp/evil hoprig run').kind, 'settings');
  assert.equal(held('node -e "fs.writeFileSync(process.env.HOPRIG_RUN_FILE, 1)"').kind, 'settings');
  assert.equal(held('python3 -c \'import os; print(os.environ["HOPRIG_CONFIG_DIR"])\'').kind, 'settings');
  assert.equal(held('ruby -e \'puts ENV["HOPRIG_STATE_DIR"]\'').kind, 'settings');
  assert.equal(held('printenv HOPRIG_STATE_DIR').kind, 'settings');
});

test('the same variable NAMED only in a text (a search, a commit message, an echoed string) goes through', () => {
  assert.equal(held('grep -rn HOPRIG_RUN_FILE src'), null);
  assert.equal(held('rg HOPRIG_CONFIG_DIR'), null);
  assert.equal(held("git commit -m 'hook: read HOPRIG_STATE_DIR once'"), null);
  assert.equal(held('git commit -m "set HOPRIG_RUN_FILE for the hook"'), null);
  assert.equal(held('echo "see HOPRIG_RUN_FILE in the docs"'), null);
  assert.equal(held('printenv | grep HOPRIG_RUN_FILE'), null);
});

test('an ordinary command with none of these goes through', () => {
  assert.equal(held('npm test'), null);
  assert.equal(held('git status && ls -la'), null);
});
