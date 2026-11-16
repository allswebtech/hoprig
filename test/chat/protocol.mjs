// The Claude Code engine's protocol for the tests, in one place: its arguments and lines (claude-lines.mjs), its
// parser (claude-parse.mjs: parseLine gives the events of one line to a fresh parser) and transcript reader.
import { ClaudeParser } from '../../src/chat/engines/claude-parse.mjs';
import { readTranscript } from '../../src/chat/engines/claude-transcript.mjs';

export * from '../../src/chat/engines/claude-lines.mjs';
export { newTodos, todoStep, toolKind, toolTitle } from '../../src/chat/engines/claude-parse.mjs';
export { clipDiff, clipInput, clipText } from '../../src/chat/events.mjs';
export const parseLine = (l) => new ClaudeParser().line(l);
/** Lines through one parser, as one process gives them. */
export const parseLines = (lines) => {
  const p = new ClaudeParser();
  return lines.flatMap((l) => p.line(l));
};
export const transcriptEvents = readTranscript;
