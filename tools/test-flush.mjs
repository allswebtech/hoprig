import { relative } from 'node:path';

// Loaded into each test file's own process (`node --test` hands its --import to them). Such a process sends its
// results to the runner through a pipe, and with --test-force-exit it ends as soon as the last result is handed over:
// where that pipe does not block (a socket pair on Linux, any pipe on macOS) the last result was sometimes lost, so a
// file's last test, its failure message included, was missing from the report. Writes that block are never lost.
// A file that tools/test.mjs --again runs once more by itself is no child of `node --test` and ends the same way
// (--test-force-exit, its report on a pipe): HOPRIG_TEST_ALONE says so.
if (process.env.NODE_TEST_CONTEXT || process.env.HOPRIG_TEST_ALONE === '1') {
  for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);
}

// Each test file's process says which file it is, so a trap of tools/test-traps.mjs that it reaches names it. Its
// children inherit the name.
if (process.env.NODE_TEST_CONTEXT && process.argv[1] && !process.env.HOPRIG_TEST_FILE) {
  const rel = relative(process.cwd(), process.argv[1]);
  process.env.HOPRIG_TEST_FILE = rel && !rel.startsWith('..') ? rel.split('\\').join('/') : process.argv[1];
}
