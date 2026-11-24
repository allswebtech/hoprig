// The check every start of the command makes first (bin/hoprig.mjs imports this file before anything else, so the
// check runs before any other module of Hoprig does). The floor and why it is that version: src/nodefloor.mjs, the
// only module loaded before the check (it imports nothing).
import { MIN_NODE, MIN_NODE_MAJOR, MIN_NODE_TEXT, belowFloor } from './nodefloor.mjs';

export { MIN_NODE, MIN_NODE_MAJOR, MIN_NODE_TEXT };

/** null when `version` ("22.11.0" or "v22.11.0") is new enough, else the plain sentence that says what to do. */
export function tooOld(version = process.versions.node) {
  if (!belowFloor(version)) return null;
  return `Hoprig needs Node.js ${MIN_NODE_TEXT} or newer; this is Node.js ${String(version).replace(/^v/, '')}. Install Node.js ${MIN_NODE_TEXT} or newer (https://nodejs.org), then run hoprig again.`;
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
