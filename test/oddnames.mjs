// Whether the disk of the test's temporary folder takes a file name that is not UTF-8. Linux takes any bytes; APFS
// and HFS+ (macOS) refuse such a name with EILSEQ, so it cannot exist on a Mac's disk. A test that covers such names
// with others skips only those names when the disk refuses them, with ODD_NAMES_SKIP as its reason.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ODD_NAMES_SKIP = 'this disk refuses a file name that is not UTF-8 (EILSEQ, as APFS on macOS does): such a name cannot exist here';

/**
 * True when a name with the byte 0xFF can be made in `dir` (a fresh folder under os.tmpdir() when none is given).
 * `write` makes the file (handed in by the helper's own test); any error other than EILSEQ is thrown.
 */
export function oddNamesWork({ dir = null, write = fs.writeFileSync } = {}) {
  const at = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'oddnames-'));
  try {
    write(Buffer.concat([Buffer.from(`${at}/probe-`), Buffer.from([0xff])]), '');
    return true;
  } catch (e) {
    if (e && e.code === 'EILSEQ') return false;
    throw e;
  } finally {
    if (!dir) fs.rmSync(at, { recursive: true, force: true });
  }
}

/** The skip option for a case that cannot exist without such names: false where the disk takes them, else the reason. */
export const oddNamesSkip = () => !oddNamesWork() && ODD_NAMES_SKIP;
