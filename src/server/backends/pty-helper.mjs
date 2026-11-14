// node-pty starts programs on macOS and Linux through a small helper binary (spawn-helper) next to its native
// module. Its install script is what marks that file executable; when the package manager skips install scripts
// (newer npm does until they are approved) the file stays non-executable and every spawn fails with a bare
// "posix_spawnp failed". Setting the bit ourselves, once, before the first spawn makes that failure go away.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

let checked = false;

export function ensureSpawnHelper() {
  if (checked || process.platform === 'win32') return;
  checked = true;
  let root;
  try {
    root = path.resolve(path.dirname(createRequire(import.meta.url).resolve('node-pty')), '..');
  } catch {
    return; // node-pty itself is missing: its own import error says so
  }
  for (const dir of [path.join('prebuilds', `${process.platform}-${process.arch}`), path.join('build', 'Release')]) {
    const file = path.join(root, dir, 'spawn-helper');
    try {
      const { mode } = fs.statSync(file);
      if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
    } catch {
      /* not there, or not ours to change (a root-owned global install): spawning will report it */
    }
  }
}
