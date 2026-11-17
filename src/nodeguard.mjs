// The lowest Node.js that Hoprig runs on, and the check every start of the command makes first (bin/hoprig.mjs
// imports this file before anything else, so the check runs before any other module of Hoprig does).
//
// Why 22: Node 20 (past its end of life since April 2026) aborts with a crash report when the terminal it runs in is
// closed under it (it cannot set back a terminal that is gone). Hoprig ends its own programs before it closes a
// terminal, but a terminal window or an SSH connection closed by hand still took a Node 20 launcher down that way.
// No imports: nothing else is loaded before the check.

export const MIN_NODE_MAJOR = 22;

/** null when `version` ("22.1.0" or "v22.1.0") is new enough, else the plain sentence that says what to do. */
export function tooOld(version = process.versions.node) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return null;
  return `Hoprig needs Node.js ${MIN_NODE_MAJOR} or newer; this is Node.js ${String(version).replace(/^v/, '')}. Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org), then run hoprig again.`;
}

/** On a Node.js that is too old: the sentence on stderr and exit code 1. */
export function guard(version = process.versions.node, { write = (s) => process.stderr.write(s), exit = (code) => process.exit(code) } = {}) {
  const why = tooOld(version);
  if (!why) return true;
  write(`${why}\n`);
  exit(1);
  return false;
}

guard();
