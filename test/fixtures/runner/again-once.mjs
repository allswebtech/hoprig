// For test/runner.test.mjs (--again): a flake. Its second test fails the first time the file runs and passes every
// time after, by a mark it leaves in its temporary folder (the test hands each run a folder of its own as TMPDIR), as a
// timing-sensitive test on a loaded runner does. Each run of the file adds a line to again-once.runs there, so the test
// counts how often it ran; its first test leaves a timer running, as a file that still holds something open does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

fs.appendFileSync(path.join(os.tmpdir(), 'again-once.runs'), 'run\n');
const mark = path.join(os.tmpdir(), 'again-once.mark');

test('passes every time, with a timer left running', () => {
  setInterval(() => {}, 1000);
});
test('fails on its first run only', () => {
  if (fs.existsSync(mark)) return;
  fs.writeFileSync(mark, '');
  throw new Error('made-up failure of the first run only\nits second line');
});
