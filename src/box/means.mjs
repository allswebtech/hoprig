// The means of the box on this computer: a program at a fixed absolute path, owned by root and not writable by group
// or others, never found through PATH (a session can put a program of its own first on PATH, or write a file it
// names). Tests that need a broken or missing means pass `stat` to findMeans, never a variable or a file.
import fs from 'node:fs';
import path from 'node:path';

export const LINUX_MEANS = ['/usr/bin/bwrap', '/bin/bwrap'];
export const MAC_MEANS = ['/usr/bin/sandbox-exec'];

/** Why `file` (resolved) cannot be trusted as the means, or '' when it can: root's own, written by root only. */
function untrusted(file, stat) {
  let st;
  try {
    st = stat(file);
  } catch {
    return 'missing';
  }
  if (!st.isFile()) return `${file} is not a program file`;
  if (st.uid !== 0) return `${file} is not owned by root`;
  if (st.mode & 0o022) return `${file} can be changed by others than root`;
  const dir = stat(path.dirname(file));
  if (dir.uid !== 0 || dir.mode & 0o022) return `the folder of ${file} can be changed by others than root`;
  return '';
}

/**
 * The means for `platform`: { kind, file } when one is there and can be trusted, else { kind: null, why, step }:
 * `why` one line, `step` the one step that would help, as words (never run).
 */
export function findMeans(platform = process.platform, { stat = fs.statSync, real = fs.realpathSync } = {}) {
  if (platform === 'win32') return { kind: null, why: 'the box is not offered on Windows: work that needs it runs on a Linux or Mac computer of yours', step: '' };
  if (platform === 'darwin') {
    let file;
    try {
      file = real(MAC_MEANS[0]);
    } catch {
      return { kind: null, why: 'sandbox-exec is not on this Mac', step: '' };
    }
    const why = untrusted(file, stat);
    if (why) return { kind: null, why: `sandbox-exec cannot be trusted here: ${why}`, step: '' };
    return { kind: 'sandbox-exec', file };
  }
  if (platform === 'linux') {
    const seen = [];
    for (const p of LINUX_MEANS) {
      let file;
      try {
        file = real(p);
      } catch {
        continue;
      }
      const why = untrusted(file, stat);
      if (!why) return { kind: 'bwrap', file };
      if (why !== 'missing') seen.push(why);
    }
    if (seen.length) return { kind: null, why: `bubblewrap cannot be trusted here: ${seen[0]}`, step: 'reinstall bubblewrap from the system\'s packages' };
    return { kind: null, why: 'bubblewrap is not installed', step: 'install bubblewrap (for example: sudo apt install bubblewrap)' };
  }
  return { kind: null, why: `this system (${platform}) has no box in Hoprig yet`, step: '' };
}
