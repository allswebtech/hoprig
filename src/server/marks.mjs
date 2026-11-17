// A start's mark (deck.mjs noteLaunch): an empty file the terminal removes when it is back at its own shell, with the
// launcher ended or never started (backends: the line typed into the shell removes it after the launcher; on Windows
// the built-in terminal removes it when its command exits). Kept with the run records; listRuns reads only *.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sweepLaunches } from '../launchfile.mjs';
import { runsDir } from '../paths.mjs';

const PREFIX = '.start-';
// Older than this when a dashboard starts: an earlier dashboard's (this one notes its own starts afresh).
const LEFT_MS = 10 * 60_000;

export function newMark() {
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  const file = path.join(runsDir(), `${PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(file, '', { mode: 0o600 });
  return file;
}

export const dropMark = (file) => file && fs.rmSync(file, { force: true });

/**
 * The marks an earlier dashboard left behind: it stopped while a terminal's launcher ran (a built-in terminal's shell
 * ends with it before it runs its removal), and its notes went with it. No dashboard reads them, so they go.
 */
export function sweepMarks(now = Date.now()) {
  sweepLaunches(now); // and the launch files nobody used (the line typed, then Ctrl+C): they hold first messages
  let names;
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    return;
  }
  for (const f of names) {
    if (!f.startsWith(PREFIX)) continue;
    const file = path.join(runsDir(), f);
    try {
      if (now - fs.statSync(file).mtimeMs > LEFT_MS) fs.rmSync(file, { force: true });
    } catch {
      /* gone meanwhile */
    }
  }
}
