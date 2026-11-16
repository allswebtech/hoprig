// Reading and writing one run record (see runs.mjs for what it holds). Kept apart from runs.mjs and free of other
// imports on purpose: the hook (hook.mjs) is started by Claude Code many times per session, and every module it
// loads is time Claude waits.
import fs from 'node:fs';

export function readRun(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Replace the record in one step (a reader never sees half a file). */
export function writeRun(file, run) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The run's "tell me about tool calls" mark (hook.mjs: wantsToolNews). Claude Code's shell looks for this file
 * before it starts the hook after a batch of tool calls, so a session that is plainly working starts nothing.
 */
export const watchFile = (file) => `${file}.watch`;
