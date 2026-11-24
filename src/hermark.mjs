// The mark the dashboard writes when it starts a session as Tia's, and removes when the session ends. It is the ONE
// thing src/hook.mjs sessionByTia reads to decide whether a session is hers: below
// Full, a session she started holds an administrator command as the owner's card. Written by the dashboard alone, in
// the state folder beside the handed hook settings (hookSettingsDir, a sibling of the run record) — never in the run
// record or the session's own folder, both of which a command of the session can write. The state folder is Hoprig's
// own (hook.mjs places(): the wall protects configDir/stateDir), so a session running in a workspace repo cannot
// write or delete the mark; marking a session hers only ADDS the owner's card, so the mark could never lift a hold.
//
// herMarkFile MUST compute the same path as src/hook.mjs sessionByTia (kept inline there so the hook stays small);
// test/assistant/hermark.test.mjs holds the two equal.
import fs from 'node:fs';
import path from 'node:path';
import { hookSettingsDir } from './paths.mjs';

/** The mark path for a run record file: a `.tia` sibling of the handed hook settings, in the state folder. */
export function herMarkFile(runFile) {
  return path.join(hookSettingsDir(), `${path.basename(runFile)}.tia`);
}

/** The dashboard marks a session it started as Tia's. Returns the mark path written. */
export function markHers(runFile) {
  const file = herMarkFile(runFile);
  fs.mkdirSync(hookSettingsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ byTia: true })}\n`, { mode: 0o600 });
  return file;
}

/**
 * Did the dashboard mark the run of `runFile` hers? Read where it wrote the mark, never from the run record. A move
 * of the session (server/deck.mjs move) reads it to start the new run as hers too. No record id: not hers.
 */
export function isMarkedHers(runFile) {
  if (!runFile || path.basename(runFile) === '.json') return false;
  try {
    return JSON.parse(fs.readFileSync(herMarkFile(runFile), 'utf8')).byTia === true;
  } catch {
    return false;
  }
}

/** The mark of a session that has ended; gone already is no error. */
export function unmarkHers(runFile) {
  try {
    fs.unlinkSync(herMarkFile(runFile));
  } catch {
    /* already gone */
  }
}
