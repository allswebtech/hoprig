// New session's small shared parts: the "Starting <coding tool>…" state of a session just started (Home, the session
// screens) and the words of a folder. The popup itself is newsession-popup.js; `#/new` opens it over Home (app.js).
import { TOOL_NAMES, cardTool, h, isCodingCard } from './lib.js';

/**
 * Sessions this page just started or moved to another account: until the coding tool reports itself (a few seconds),
 * they read "Starting Claude Code…" (or the tool's name) instead of "Terminal" (Home, session.js).
 */
const justStarted = new Map(); // key → { at, tool }
const keyOf = (machineName, name) => `${machineName || ''}/${name}`;
export const markStarting = (machineName, name, tool = 'claude') => justStarted.set(keyOf(machineName, name), { at: Date.now(), tool });
const started = (s, machineName = s.machine) => justStarted.get(keyOf(machineName, s.name)) || { at: 0, tool: 'claude' };
export const isStarting = (s, machineName = s.machine) => !isCodingCard(s) && !s.startFailed && !s.startStopped && Date.now() - started(s, machineName).at < 30_000;
/** "Starting Claude Code…": the coding tool that was started, by its own name (s: the card, when known). */
export const startingPill = (s = null) => {
  const tool = s ? started(s).tool || cardTool(s) : 'claude';
  return h('span.pill.st-starting', h('span.dot'), `Starting ${TOOL_NAMES[tool] || 'Claude Code'}…`);
};

export { folderSub, outsideProjects, runningIn } from './newsession-words.js';
