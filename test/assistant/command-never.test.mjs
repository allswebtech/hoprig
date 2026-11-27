// run_command is a card tool, so a line that deletes work or reads the credentials folder must be refused BEFORE a card
// is staged: both are in the never list (delete-work, credentials), where there is no card and no tool for her.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmdnever-')));
const cred = path.join(home, 'credentials');
fs.mkdirSync(path.join(cred, 'shop'), { recursive: true });
process.env.HOPRIG_WORKSPACE_DIR = home; // the list of secret places is read once per process: one workspace for the file
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const { hisAloneCommand, run_command } = await import('../../src/assistant/owner-tools.mjs');

test('a line that deletes or rewrites work is the owner\'s own step, in every spelling', () => {
  for (const c of [
    'git reset --hard HEAD', 'git -C /p reset --soft HEAD~1', 'git rebase master', 'git clean -fdx', 'git branch -D master', 'git branch --delete old',
    'git filter-branch --all', 'git update-ref -d refs/heads/x', 'git worktree remove ../w', 'git push origin :old', 'git push --delete origin old',
    'rm -rf .git', 'rm notes.txt', 'rmdir old', 'shred -u key', 'find . -name "*.log" -delete', 'ls && rm -r build', 'FOO=1 rm a',
    "bash -c 'rm -rf build'", 'sh -c "git reset --hard"', 'xargs rm < list.txt', 'unlink x',
  ]) assert.ok(hisAloneCommand(c), c);
  for (const c of ['git status', 'git log --oneline -5', 'git branch --list', 'git diff', 'ls -la', 'grep -rn format src', 'df -h', 'git -C /p status']) assert.equal(hisAloneCommand(c), null, c);
});

test('run_command refuses a command line or a folder inside the credentials folder before any card', async () => {
  {
    assert.throws(() => run_command.check({ command: 'ls', folder: path.join(cred, 'shop') }), /credentials|sign-in/);
    assert.throws(() => run_command.check({ command: `cat ${path.join(cred, 'shop', 'key.env')}`, folder: home }), /credentials|sign-in/);
    assert.throws(() => run_command.check({ command: `sudo cat ${path.join(cred, 'shop', 'key.env')}`, folder: home }), /credentials|sign-in/, 'an administrator line is read first for the credentials folder');
    assert.doesNotThrow(() => run_command.check({ command: 'ls', folder: home }));
  }
});

test('start_chat in the credentials folder is refused before a card, as start_session is', async () => {
  const { start_chat } = await import('../../src/assistant/chats.mjs');
  assert.throws(() => start_chat.check({ folder: path.join(cred, 'shop'), message: 'hi' }), /credentials|sign-in/);
  assert.doesNotThrow(() => start_chat.check({ folder: path.join(home, 'projects', 'shop'), message: 'hi' }));
});
