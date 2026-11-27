// The mark the dashboard writes when it starts a terminal session in "Allow everything" (bypassgate.mjs ALL), and
// removes when the session ends: a `.all` sibling of the handed hook settings, like the Tia mark (hermark.mjs). It is
// read only at a MOVE or a RESTORE of the session (server/deck.mjs move, automation/feature.mjs), to start the new run
// in the mode again, and only while the switch and the acknowledgement allow it. The running session's own hook never
// reads it: that takes the mode from its process environment (hook.mjs allOn), which the launcher sets from the launch
// file and which no command of the session can set on the coding tool.
import fs from 'node:fs';
import path from 'node:path';
import { hookSettingsDir } from './paths.mjs';

/** The mark path for a run record file. */
export function allMarkFile(runFile) {
  return path.join(hookSettingsDir(), `${path.basename(runFile)}.all`);
}

/** The launcher marks the run it starts in Allow everything. Returns the mark path written. */
export function markAll(runFile) {
  const file = allMarkFile(runFile);
  fs.mkdirSync(hookSettingsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ all: true })}\n`, { mode: 0o600 });
  return file;
}

/** Did the dashboard's launcher mark the run of `runFile`? Read where it wrote the mark, never from the run record. */
export function isMarkedAll(runFile) {
  if (!runFile || path.basename(runFile) === '.json') return false;
  try {
    return JSON.parse(fs.readFileSync(allMarkFile(runFile), 'utf8')).all === true;
  } catch {
    return false;
  }
}

/** The mark of a session that has ended; gone already is no error. */
export function unmarkAll(runFile) {
  try {
    fs.unlinkSync(allMarkFile(runFile));
  } catch {
    /* already gone */
  }
}
