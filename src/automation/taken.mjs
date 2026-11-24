// "Continue here" in a chat ends the terminal that ran its conversation (src/chat/handoff.mjs take). The restore
// after a restart must not open that terminal on the conversation again, also when the dashboard ends a moment after
// the press, before any tick has seen the terminal as a plain shell. So take() writes the take-over down here BEFORE
// it ends the terminal, and the restore reads it at the dashboard's start (restore.mjs decide, `taken`).
//
// Stored in <state>/automation/taken.json: [{ tool, conversation, runId }], the run id of the terminal's run record
// (the restore remembers each session's run id). An entry goes when a start has used it, or when a later tick sees
// a terminal run that conversation again under another run; never by the clock. Read fresh each time (no cache):
// take() and the automations write it from the same process, each read-change-write synchronous.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { writeAtomic } from './store.mjs';

const MAX = 200; // a bound on a file nobody reads by hand; a start empties it
const word = (s) => typeof s === 'string' && s.length > 0 && s.length <= 120;
const ok = (e) => Boolean(e) && word(e.tool) && word(e.conversation) && word(e.runId);
const same = (a, b) => a.tool === b.tool && a.conversation === b.conversation && a.runId === b.runId;

export const takenFile = (base = stateDir()) => path.join(base, 'automation', 'taken.json');

/** The take-overs written down, [] when there are none (or the file is unreadable). */
export function readTaken(file = takenFile()) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v.filter(ok).map(({ tool, conversation, runId }) => ({ tool, conversation, runId })) : [];
  } catch {
    return [];
  }
}

export function writeTaken(list, file = takenFile()) {
  writeAtomic(file, list.filter(ok).slice(-MAX));
}

/**
 * Write down that the terminal of run `runId` lost conversation `conversation` of `tool` to a chat. Returns the
 * function that takes it back (the terminal did not stop after all). Nothing is written without a run id.
 */
export function noteTaken({ tool, conversation, runId }, file = takenFile()) {
  const e = { tool, conversation, runId };
  if (!ok(e)) return () => {};
  writeTaken([...readTaken(file).filter((x) => !same(x, e)), e], file);
  return () => writeTaken(readTaken(file).filter((x) => !same(x, e)), file);
}
