// A Claude Code folder reached through a link into an opened folder (dotfiles kept in a repository: ~/.claude, or a
// provider's CLAUDE_CONFIG_DIR, is a link to a folder inside it) keeps its sign-in out of the editor also before
// Claude Code has written it: a file that does not exist yet is judged by the real place of its nearest folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('editor-secret-link');
test.after(() => box.cleanup());

const top = fs.realpathSync(box.root);
const roots = [top];
const dotfiles = path.join(top, 'dotfiles');
fs.mkdirSync(path.join(dotfiles, 'claude'), { recursive: true });
fs.mkdirSync(path.join(dotfiles, 'claude-work'), { recursive: true });
fs.mkdirSync(box.home, { recursive: true });
// ~/.claude is a link into the opened folder; a provider's Claude Code folder is one too, named through its link.
fs.symlinkSync(path.join(dotfiles, 'claude'), path.join(box.home, '.claude'));
fs.symlinkSync(path.join(dotfiles, 'claude-work'), path.join(top, 'claude-work-link'));
fs.mkdirSync(box.profiles, { recursive: true });
fs.writeFileSync(path.join(box.profiles, 'work.env'), `CLAUDE_CONFIG_DIR=${path.join(top, 'claude-work-link')}\n`);
process.env.HOME = box.home;

const { readFile, writeFile } = await import('../../src/editor/files.mjs');

test('a sign-in file that does not exist yet, in a Claude Code folder linked into the opened folder, cannot be written', { skip: process.platform === 'win32' && 'a link to a folder needs rights of its own on Windows' }, async () => {
  for (const rel of ['dotfiles/claude/.credentials.json', 'dotfiles/claude/.claude.json', 'dotfiles/claude-work/.credentials.json', 'claude-work-link/.credentials.json']) {
    let err = null;
    try {
      writeFile(top, rel, '{"token":"planted"}', null, roots);
    } catch (e) {
      err = e;
    }
    assert.equal(err && err.status, 403, `${rel}: ${err ? err.message : 'written'}`);
    assert.equal(fs.existsSync(path.join(top, rel)), false, `${rel} was not written`);
  }
  // Once Claude Code has written it, it stays out of reach as before.
  fs.writeFileSync(path.join(dotfiles, 'claude', '.credentials.json'), '{"token":"fake-sign-in-1"}');
  assert.throws(() => readFile(top, 'dotfiles/claude/.credentials.json', roots), (e) => e.status === 403);
  // An ordinary file next to it is the owner's to change.
  writeFile(top, 'dotfiles/claude/CLAUDE.md', 'my rules\n', null, roots);
  assert.equal(fs.readFileSync(path.join(dotfiles, 'claude', 'CLAUDE.md'), 'utf8'), 'my rules\n');
});
