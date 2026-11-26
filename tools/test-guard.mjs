// A reporter for tools/test.mjs that keeps count instead of printing: per test file, the results that arrived and the
// file's own summary (what the file says it ran, the last thing its process sends). tools/test.mjs compares the two
// after the run, for every file it started: a file whose summary never came, or whose results do not add up to it,
// lost results on the way (a process that ended before its pipe was read, a test that ended the process) and fails
// the run by name. Without this a run could say "fail 0" with tests, failing ones too, never counted.
//
// HOPRIG_TEST_SLOW_READER=<ms> makes this reporter hold the runner that long at each event: the runner then reads its
// files' pipes slowly, as on a busy computer (test/runner.test.mjs uses it to show that no result is lost then).

import { resolve } from 'node:path';

const slow = Number(process.env.HOPRIG_TEST_SLOW_READER) || 0;

/**
 * A failing result of a file (a test, a suite or the runner's line for the whole file): `red` counts each, and the
 * first ten are kept by name with the first three lines of their message (a suite that failed only because a test in
 * it did is not repeated), so tools/test.mjs --again can say which tests failed in a file it runs once more. A todo
 * test that fails is sent as a failure too, but fails no run: it is not counted.
 */
function failing(f, d) {
  if (d.todo !== undefined && d.todo !== false) return;
  f.red++;
  const err = d.details?.error;
  if (err?.failureType === 'subtestsFailed' || f.fails.length >= 10) return;
  const cause = err?.cause ?? err;
  const text = cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause ?? '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
  f.fails.push({ name: String(d.name), message: lines.length ? lines : ['(no message)'] });
}

export default async function* count(source) {
  const files = {};
  // from, to: when the first and the last event of a file arrived (the home guard names the files that ran when a
  // path of the real home was written).
  const of = (file) => {
    const f = (files[file] ??= { results: 0, failed: 0, red: 0, fails: [], suites: 0, asFile: null, asFileMs: null, summary: null, from: Date.now(), to: 0 });
    f.to = Date.now();
    return f;
  };
  for await (const event of source) {
    if (slow) {
      const until = performance.now() + slow;
      while (performance.now() < until); // holds the runner's one thread, as a busy computer does
    }
    const d = event.data || {};
    if (typeof d.file !== 'string') continue;
    if (event.type === 'test:summary') of(d.file).summary = d.counts;
    else if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (event.type === 'test:fail') failing(of(d.file), d);
      // The runner's own line for a whole file (a file that ended without results of its own is one such line).
      // (Its name is the file as the runner was given it, relative where it was given so: the same file.)
      if (d.nesting === 0 && (d.name === d.file || resolve(String(d.name)) === resolve(d.file))) {
        of(d.file).asFile = event.type === 'test:pass' ? 'pass' : 'fail';
        of(d.file).asFileMs = typeof d.details?.duration_ms === 'number' ? d.details.duration_ms : null; // how long its process ran
      } else if (d.details?.type === 'suite') of(d.file).suites++;
      else {
        of(d.file).results++;
        if (event.type === 'test:fail') of(d.file).failed++; // a failing test of the file itself: never rescued (tools/test.mjs)
      }
    }
  }
  yield `${JSON.stringify(files)}\n`;
}
