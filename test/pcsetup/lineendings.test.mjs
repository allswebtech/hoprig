// A count of uncommitted changes counts what really differs: a tracked file that git status lists but neither git diff
// nor git diff --cached shows (its line endings only, under core.autocrlf on Windows) is counted apart as "line endings
// only". Made-up answers of git through the reader (gitread.mjs); the same code on every system.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repoState } from '../../src/pcsetup/projects.mjs';

/** A made-up git: `status` and `diff` (and `diff --cached`) answer as given; records what was asked. */
function fakeGit({ status, work = '', staged = '' }) {
  const asked = [];
  const run = async (argv) => {
    const i = argv.findIndex((a) => a === 'status' || a === 'diff' || a === 'config');
    const sub = argv[i];
    // The reader first asks the repository's own settings (gitread.mjs): none set here.
    if (sub === 'config') return { ok: true, code: 0, stdout: '', stderr: '' };
    asked.push(sub === 'diff' && argv.includes('--cached') ? 'diff --cached' : sub);
    if (sub === 'status') return { ok: true, code: 0, stdout: status, stderr: '' };
    if (sub === 'diff') return { ok: true, code: 0, stdout: argv.includes('--cached') ? staged : work, stderr: '' };
    return { ok: false, code: 1, stdout: '', stderr: 'no' };
  };
  return { run, asked };
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lineendings-'));
execFileSync('git', ['-C', DIR, 'init', '-q']);
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('a file in status but in no diff is "line endings only", not a change', async () => {
  const g = fakeGit({ status: '## main...origin/main\n M README.md\n M src/app.js\n?? new.txt\n', work: 'src/app.js\0' });
  const s = await repoState(DIR, g.run);
  assert.equal(s.ok, true);
  assert.equal(s.changes, 2, 'src/app.js and the new file');
  assert.equal(s.lineEndings, 1, 'README.md');
  assert.deepEqual(g.asked.sort(), ['diff', 'diff --cached', 'status']);
});

test('staged changes count; only new files: diff is never asked', async () => {
  let s = await repoState(DIR, fakeGit({ status: '## main\nM  a.txt\n M b.txt\n', staged: 'a.txt\0', work: 'b.txt\0' }).run);
  assert.deepEqual([s.changes, s.lineEndings], [2, 0]);
  const g = fakeGit({ status: '## main\n?? x\n?? y\n' });
  s = await repoState(DIR, g.run);
  assert.deepEqual([s.changes, s.lineEndings], [2, 0]);
  assert.deepEqual(g.asked, ['status']);
});
