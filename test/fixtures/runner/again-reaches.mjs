// For test/runner.test.mjs (--again): a flake that also reaches a trapped program, on its first run (the one that
// fails) or on its second (which passes): again-reaches.when in its temporary folder (TMPDIR, the test's own) says
// which, "first" or "second". Either way the seal marks it, and such a file is never rescued by its second run. Each
// run adds a line to again-reaches.runs there.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

fs.appendFileSync(path.join(os.tmpdir(), 'again-reaches.runs'), 'run\n');
const mark = path.join(os.tmpdir(), 'again-reaches.mark');
const when = fs.readFileSync(path.join(os.tmpdir(), 'again-reaches.when'), 'utf8').trim();

test('fails on its first run only, and reaches sudo on one of its runs', () => {
  const first = !fs.existsSync(mark);
  if (when === (first ? 'first' : 'second')) spawnSync('sudo', ['made-up-again'], { stdio: 'ignore' });
  if (!first) return;
  fs.writeFileSync(mark, '');
  throw new Error('made-up failure of the first run only');
});
