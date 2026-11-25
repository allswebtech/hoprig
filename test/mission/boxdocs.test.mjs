// The words of the box in missions: docs/BOX.md says what the product itself runs in the box, and docs/WORK.md
// (Missions) says where a task's tests run, how the dependencies reach them, what "Accept by itself" needs and what his
// two presses mean. Code and documents say the same thing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GATE_MS, PRINTED_CHARS, PRINTED_LINES } from '../../src/mission/gate.mjs';
import { PATHS_MAX, RUNS_MAX, TOTAL_MS } from '../../src/mission/boxtool.mjs';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const read = (f) => fs.readFileSync(path.join(docs, f), 'utf8').replace(/\s+/g, ' ');

test('BOX.md says what Hoprig itself runs in the box', () => {
  assert.match(read('BOX.md'), /What Hoprig itself runs in the box: a mission's tests gate, and your own "Run the tests in the box"/);
});

test('WORK.md (Missions) says where the tests run, how the dependencies reach them, and what each press means', () => {
  const m = read('WORK.md').split('## Missions')[1] || '';
  assert.match(m, /never runs a session's test code by itself outside the \*\*box\*\*/);
  assert.match(m, /in the box, no network/);
  assert.match(m, /Nothing is installed/);
  assert.match(m, /link `node_modules` the product makes in the worktree only when nothing is there/);
  assert.match(m, /never followed or replaced/);
  assert.match(m, new RegExp(`last ${PRINTED_LINES} lines the tests printed \\(at most ${PRINTED_CHARS.toLocaleString('en-US')} characters`));
  assert.match(m, /for the tester only when its tests ran in the box and passed/);
  assert.match(m, /\*\*Run them outside the box\*\* is a second, separate step that asks you first/);
  assert.match(m, /a need folder goes to it only when nothing in it is kept from the session's own tools/);
  assert.match(m, /Files the tests leave in the worktree do not pass the check/);
  assert.match(m, /lying in its worktree untracked, changed or ignored, gets no reviewer session/);
  assert.match(m, /"Tests passed in the box: …"/);
  assert.match(m, /taken only from your own page, never with another computer's token/);
  assert.doesNotMatch(m, /There is no box on this computer yet/, 'the old words, from before the box was wired, are gone');
});

test('BOX.md and WORK.md say what a session\'s own tool runs, with the limits the code holds', () => {
  assert.match(read('BOX.md'), /A mission's session may also run the project's own test command there while it works, through its one tool `run_tests`, never a command of its own/);
  const m = read('WORK.md').split('## Missions')[1] || '';
  assert.match(m, new RegExp(`a list of at most ${PATHS_MAX} paths inside the worktree`));
  assert.match(m, new RegExp(`one run as long as the check's \\(${GATE_MS / 60_000} minutes\\), ${RUNS_MAX} runs and ${TOTAL_MS / 60_000} minutes of runs per session`));
  assert.match(m, /\*\*It is not the check\*\*/);
  assert.match(m, /"Accept by itself" follows the check's own run alone/);
  assert.match(m, /`mission-box-runs\.jsonl`/);
  assert.match(m, /With missions off, no box, no test command, a review, or a role whose role file names nothing it runs \(a writer, a researcher, a reviewer\), the session starts as before/);
  assert.match(m, /\*\*Hoprig's wall reads every command first\*\*/);
  assert.match(m, new RegExp(`${RUNS_MAX} runs and ${TOTAL_MS / 60_000} minutes of runs per\\s+session for all kinds together`));
});
