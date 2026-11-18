// Loaded into each test file's own process (`node --test` hands its --import to them). Such a process sends its
// results to the runner through a pipe, and with --test-force-exit it ends as soon as the last result is handed over:
// where that pipe does not block (a socket pair on Linux, any pipe on macOS) the last result was sometimes lost, so a
// file's last test, its failure message included, was missing from the report. Writes that block are never lost.
if (process.env.NODE_TEST_CONTEXT) {
  for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);
}
