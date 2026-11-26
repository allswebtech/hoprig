// Replacing a file by a whole new one, so that a reader never sees half a file: the new text is written to a
// temporary file beside it (`<name>.<pid>.tmp`), which is then renamed over the name in one step. Free of other imports
// on purpose: config.mjs (imported by almost everything) and runfile.mjs (loaded by the hook Claude Code starts for
// every tool call) use it.
//
// On Windows a file that another process holds open at that moment (a second dashboard or a command reading the same
// state file, a hook reading the settings, a virus scan of a file just written) refuses to be read or replaced with
// EPERM, EACCES or EBUSY until it lets go: measured on a Windows runner, a rename over a file another handle was
// reading answered EPERM every time. Such a step is tried again there for up to BUSY_MS, with naps of 5 to 15 ms. On
// other systems those errors are no moment and stand as they are: the step runs once.
import fs from 'node:fs';

export const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const BUSY_MS = 1000;
const nap = new Int32Array(new SharedArrayBuffer(4));

/** `step()`, tried again on Windows while it answers a busy code, for up to a second. `platform`: for the tests. */
export function patiently(step, platform = process.platform) {
  const until = Date.now() + BUSY_MS;
  for (;;) {
    try {
      return step();
    } catch (e) {
      if (platform !== 'win32' || !BUSY.has(e?.code) || Date.now() > until) throw e;
      Atomics.wait(nap, 0, 0, 5 + Math.floor(Math.random() * 10));
    }
  }
}

// A rename that still failed leaves no temporary file behind (best effort); its error is thrown as it is.
const dropTmp = (tmp) => {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* best effort */
  }
};

/** Rename the written `tmp` over `name`, patiently (above). `platform` and `rename`: for the tests. */
export function replaceFile(tmp, name, { platform = process.platform, rename = fs.renameSync } = {}) {
  try {
    patiently(() => rename(tmp, name), platform);
  } catch (e) {
    dropTmp(tmp);
    throw e;
  }
}

