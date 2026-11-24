// The lowest Node.js Hoprig supports, in one place: 22.11.0, the first long-term-support release of Node 22 ("Jod",
// 29 Oct 2024). The guard every start of the command makes (src/nodeguard.mjs), doctor's line, the test runner, the
// installers and the package's "engines" all say this one version.
//
// Why 22: Node 20 (past its end of life since April 2026) aborts with a crash report when the terminal it runs in is
// closed under it (it cannot set back a terminal that is gone), and a terminal window or an SSH connection closed by
// hand took a Node 20 launcher down that way. Why 22.11 and not 22.0: a release of 22 from before its long-term
// support began is not one to run a release on, and on 22.0 a copy of a folder failed on a file name that is not
// UTF-8 and the test runner lacked what the suite proves its results with (a summary of each file, from 22.10).
// No imports: src/nodeguard.mjs loads this before anything else of Hoprig.

export const MIN_NODE = '22.11.0';
/** The floor as a person reads it: "22.11". */
export const MIN_NODE_TEXT = MIN_NODE.replace(/\.0$/, '');
export const MIN_NODE_MAJOR = Number(MIN_NODE.split('.')[0]);

/** True when `version` ("22.11.0" or "v22.11.0") is older than MIN_NODE, or cannot be read (never taken for new enough). */
export function belowFloor(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return true;
  const [a, b, c] = m.slice(1).map(Number);
  const [x, y, z] = MIN_NODE.split('.').map(Number);
  return a !== x ? a < x : b !== y ? b < y : c < z;
}
