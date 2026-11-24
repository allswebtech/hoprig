// A session cannot take away the folders Hoprig relies on. A move, rename, copy, link or delete
// whose target is one of Hoprig's own folders OR any folder ABOVE one of them, up to the home folder, is held — so
// `mv ~/.config …` or `mv ~/.local/state …` cannot carry Hoprig's config, state, hook or installed program out from
// under it. A folder that holds no part of Hoprig, and a name that only shares a prefix, go through.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallabove-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
// Hoprig's folders nested the way they really sit under a home folder, so there are real ancestors between them.
const cfg = path.join(home, '.config', 'hoprig');
const state = path.join(home, '.local', 'state', 'hoprig');
const shop = path.join(home, 'work', 'shop');
for (const d of [cfg, state, shop, path.join(home, 'projects'), path.join(home, '.configother')]) fs.mkdirSync(d, { recursive: true });

const places = { cwd: shop, home, workspace: path.join(home, 'work'), projects: [path.join(home, 'projects')], hoprig: [cfg, state], own: shop, relative: true };
const held = (cmd) => wallHeld({ tool: 'Bash', input: { command: cmd }, cwd: shop, places });

test('a move or copy of a folder ABOVE one of Hoprig\'s folders, by absolute path, is held', () => {
  assert.equal(held(`mv ${path.join(home, '.config')} /tmp/x`).kind, 'settings');
  assert.equal(held(`mv ${path.join(home, '.local')} /tmp/x`).kind, 'settings');
  assert.equal(held(`cp -r ${path.join(home, '.local', 'state')} /tmp/x`).kind, 'settings');
  assert.equal(held(`mv ${home} /tmp/x`).kind, 'settings'); // the home folder itself
});

test('the same in the ~ and $HOME spellings is held', () => {
  assert.equal(held('mv ~/.config /tmp/x').kind, 'settings');
  assert.equal(held('cp -r ~/.local/state /tmp/x').kind, 'settings');
  assert.equal(held('mv $HOME/.config /tmp/x').kind, 'settings');
  assert.equal(held('mv ${HOME}/.local /tmp/x').kind, 'settings');
});

test('a folder that holds no part of Hoprig, or a name that only shares a prefix, goes through', () => {
  assert.equal(held(`mv ${path.join(home, 'projects')} /tmp/x`), null);
  assert.equal(held(`mv ${path.join(home, '.configother')} /tmp/x`), null); // prefix of .config, but not an ancestor
  assert.equal(held('mv ~/projects /tmp/x'), null);
  assert.equal(held('cp -r ~/.configother /tmp/x'), null);
  assert.equal(held('ls -la && cat README.md'), null);
});

test('a path below home that merely starts with the home string is not held as "the home folder"', () => {
  // The home folder is held only when named itself, never when a child of it is named (that would hold everything).
  assert.equal(held(`cat ${path.join(home, 'work', 'shop', 'notes.md')}`), null);
  assert.equal(held(`mv ${path.join(home, 'work')} /tmp/x`), null); // holds no part of Hoprig
});
