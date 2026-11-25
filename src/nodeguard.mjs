// The check every start of the command makes first (bin/hoprig.mjs imports this file before anything else, so the
// check runs before any other module of Hoprig does). The floor and why it is that version: src/nodefloor.mjs, the
// only module loaded before the check (it imports nothing).
import { MIN_NODE, MIN_NODE_MAJOR, MIN_NODE_TEXT, belowFloor, installLine } from './nodefloor.mjs';

export { MIN_NODE, MIN_NODE_MAJOR, MIN_NODE_TEXT };

/**
 * null when `version` ("24.13.1" or "v24.13.1") is new enough, else one plain sentence: the version Hoprig needs, the
 * one that runs, and the line that installs the newest long-term release of Node.js (the installer of this system).
 */
export function tooOld(version = process.versions.node, platform = process.platform) {
  if (!belowFloor(version)) return null;
  return `Hoprig needs Node.js ${MIN_NODE_TEXT} or newer, and this computer runs Node.js ${String(version).replace(/^v/, '')}; to update it, run this line, which installs the newest long-term release of Node.js and Hoprig with it:  ${installLine(platform)}`;
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
