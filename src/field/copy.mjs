// "Also write each report into this folder" (Settings → Field reports; off by default): for the owner's own computers,
// a folder of his (for instance in his private notes repository) that gathers the reports of each of them. Only the
// report's own file is written there, atomically (a temporary file of the report's name, then renamed), never anything
// else, and never over a file that is there already. A folder that is gone or not writable is left alone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { onReportMade } from './report.mjs';
import { readFieldSettings } from './settings.mjs';

/** Write one report's text into `dir` as <time>-<id>.json. → true when written. Never throws. */
export function copyReport(dir, r, text) {
  try {
    if (!dir || !path.isAbsolute(dir)) return false;
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    const name = `${r.time.replace(/[-:]/g, '')}-${r.id}.json`;
    const tmp = path.join(dir, `.${name}.${crypto.randomBytes(3).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
      fs.linkSync(tmp, path.join(dir, name)); // never over a file that is there: link fails when the name is taken
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

onReportMade((r, text) => {
  const { copyDir } = readFieldSettings();
  if (copyDir) copyReport(copyDir, r, text);
});
