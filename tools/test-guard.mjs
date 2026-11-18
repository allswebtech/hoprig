// A reporter for tools/test.mjs that keeps count instead of printing: per test file, the results that arrived and the
// file's own summary (what the file says it ran, the last thing its process sends). tools/test.mjs compares the two
// after the run, for every file it started: a file whose summary never came, or whose results do not add up to it,
// lost results on the way (a process that ended before its pipe was read, a test that ended the process) and fails
// the run by name. Without this a run could say "fail 0" with tests, failing ones too, never counted.
//
// HOPRIG_TEST_SLOW_READER=<ms> makes this reporter hold the runner that long at each event: the runner then reads its
// files' pipes slowly, as on a busy computer (test/runner.test.mjs uses it to show that no result is lost then).

const slow = Number(process.env.HOPRIG_TEST_SLOW_READER) || 0;

export default async function* count(source) {
  const files = {};
  const of = (file) => (files[file] ??= { results: 0, suites: 0, asFile: null, summary: null });
  for await (const event of source) {
    if (slow) {
      const until = performance.now() + slow;
      while (performance.now() < until); // holds the runner's one thread, as a busy computer does
    }
    const d = event.data || {};
    if (typeof d.file !== 'string') continue;
    if (event.type === 'test:summary') of(d.file).summary = d.counts;
    else if (event.type === 'test:pass' || event.type === 'test:fail') {
      // The runner's own line for a whole file (a file that ended without results of its own is one such line).
      if (d.nesting === 0 && d.name === d.file) of(d.file).asFile = event.type === 'test:pass' ? 'pass' : 'fail';
      else if (d.details?.type === 'suite') of(d.file).suites++;
      else of(d.file).results++;
    }
  }
  yield `${JSON.stringify(files)}\n`;
}
