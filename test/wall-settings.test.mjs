// A session cannot change the rules it runs under. A move, a copy, a redirect, a write or any touch of
// Hoprig's own files (its config and state: the run record, the Hands-off mark, the handed hook settings) is held,
// whether named by a literal path in those folders or by the HOPRIG_* env vars the session is handed — not only a
// delete (the hold for deletes covers those). The file-writing tools are held the same way. So a session cannot turn Hands-off
// on, lift its own stop or take the hook away without the owner's card.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallset-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const shop = path.join(tmp, 'shop');
const cfg = path.join(tmp, 'config');
const state = path.join(tmp, 'state');
const runs = path.join(state, 'runs');
for (const d of [shop, cfg, runs]) fs.mkdirSync(d, { recursive: true });
const runFile = path.join(runs, 'r1.json');

const places = { cwd: shop, home: tmp, workspace: path.join(tmp, 'ws'), projects: [path.join(tmp, 'projects')], hoprig: [cfg, state], own: shop, relative: true };
const bash = (cmd) => wallHeld({ tool: 'Bash', input: { command: cmd }, places });
const bashC = (cmd) => wallHeld({ tool: 'Bash', input: { command: cmd }, cwd: shop, places });

test('a move of the run record or its mark is held by the HOPRIG env var the session is handed', () => {
  // Before this, `mv $HOPRIG_RUN_FILE.handsoff …` went through (mv is no delete), switching the wall off.
  assert.equal(bash('mv "$HOPRIG_RUN_FILE.handsoff" /tmp/x').kind, 'settings');
  assert.equal(bash('mv $HOPRIG_RUN_FILE.handsoff /tmp/x').kind, 'settings');
  assert.equal(bash('cp $HOPRIG_RUN_FILE /tmp/copy').kind, 'settings');
  assert.equal(bash('echo on > "$HOPRIG_CONFIG_DIR/config.json"').kind, 'settings');
  assert.match(bash('mv $HOPRIG_RUN_FILE.handsoff /tmp/x').reason, /rules Hoprig runs the session under/i);
});

test('a move of those files by their literal path inside Hoprig\'s folders is held too', () => {
  assert.equal(bash(`mv ${runFile}.handsoff /tmp/x`).kind, 'settings');
  assert.equal(bash(`mv ${runFile} /tmp/x`).kind, 'settings');
  assert.equal(bash(`ln -sf /dev/null ${path.join(cfg, 'config.json')}`).kind, 'settings');
});

test('a file-writing tool that writes inside Hoprig\'s folders is held; one elsewhere goes through', () => {
  assert.equal(wallHeld({ tool: 'Write', input: { file_path: path.join(cfg, 'config.json'), content: '{}' }, places }).kind, 'settings');
  assert.equal(wallHeld({ tool: 'Edit', input: { file_path: path.join(runs, 'r1.json') }, places }).kind, 'settings');
  assert.equal(wallHeld({ tool: 'NotebookEdit', input: { notebook_path: path.join(state, 'x.ipynb') }, places }).kind, 'settings');
  assert.equal(wallHeld({ tool: 'Write', input: { file_path: path.join(shop, 'notes.md'), content: 'x' }, places }), null);
});

test('an ordinary command, and a write in the session\'s own folder, are not held', () => {
  assert.equal(bash('npm test'), null);
  assert.equal(bash('git status'), null);
  assert.equal(bash('cat README.md && echo done'), null);
  assert.equal(bash(`cat ${path.join(shop, 'notes.md')}`), null);
});

// The hold must not be slipped by a form other than a literal $HOPRIG_* or a literal
// absolute path. A `..` or a symlink in a file-tool path, a HOPRIG_* variable named in any way, and the folders in
// their ~ or $HOME form or by a relative path are all held.
test('a file-tool write with .. or through a symlink cannot slip past the folders', () => {
  assert.equal(wallHeld({ tool: 'Write', input: { file_path: `${shop}/../state/runs/r1.json`, content: '{}' }, cwd: shop, places }).kind, 'settings');
  const link = path.join(shop, 'h');
  try { fs.symlinkSync(state, link); } catch { /* already there */ }
  assert.equal(wallHeld({ tool: 'Write', input: { file_path: path.join(link, 'runs', 'r1.json'), content: '{}' }, cwd: shop, places }).kind, 'settings');
  assert.equal(wallHeld({ tool: 'Write', input: { file_path: path.join(shop, 'src', 'index.js'), content: 'x' }, cwd: shop, places }), null);
});

test('a shell line names Hoprig\'s files by a HOPRIG_* variable in any form, not only $HOPRIG_', () => {
  assert.equal(bashC('node -e "require(\'fs\').unlinkSync(process.env.HOPRIG_RUN_FILE)"').kind, 'settings');
  assert.equal(bashC('python3 -c \'import os; os.rename(os.environ["HOPRIG_RUN_FILE"], "/tmp/x")\'').kind, 'settings');
  assert.equal(bashC('printenv HOPRIG_STATE_DIR | cat').kind, 'settings');
  assert.equal(bashC('echo "$HOPRIG_CONFIG_DIR"').kind, 'settings');
});

test('a shell line names Hoprig\'s folders by their ~ or $HOME form, or by a relative path', () => {
  assert.equal(bashC('echo on > ~/config/config.json').kind, 'settings');
  assert.equal(bashC('cat $HOME/state/runs/r1.json').kind, 'settings');
  assert.equal(bashC(`mv ${shop}/../state/runs/r1.json /tmp/x`).kind, 'settings');
  assert.equal(bashC('npm run build'), null);
  assert.equal(bashC('cat ./README.md && echo done'), null);
});

test('a read of Hoprig\'s own files is held, with a reason that fits a read, not only a change (finding 7)', () => {
  const r = bashC('cat "$HOPRIG_RUN_FILE"');
  assert.equal(r.kind, 'settings');
  assert.match(r.reason, /reads or changes/i); // not the old "This would change the rules…", false for a read
  // The env fix of finding 3 also closes the env-option evasion this finding named.
  assert.equal(bashC('env -u FOO sudo true').kind, 'admin');
  assert.equal(bashC('env -u FOO npm publish').kind, 'release');
});
