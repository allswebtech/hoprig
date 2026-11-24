// Traps for the computers part's tests: a folder of programs named like the real system's (ssh, ssh-keyscan, sudo, systemctl,
// loginctl, launchctl, npm) that write down how they were called and fail loudly. A test puts its own stand-ins first
// on PATH and this folder right after them, so a call that misses its stand-in reaches a trap, never the real program,
// and `check()` fails the test by name. The runner's seal (tools/test-traps.mjs, test/seal.mjs) stays behind them: it
// traps more names, and ssh-keyscan, which it does not trap, is caught here.
import fs from 'node:fs';
import path from 'node:path';
import { sealedPath } from '../seal.mjs';

export const TRAPPED = ['ssh', 'ssh-keyscan', 'sudo', 'systemctl', 'loginctl', 'launchctl', 'npm'];

export function traps(root) {
  const dir = path.join(root, 'traps');
  const log = path.join(root, 'traps.log');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(log, '');
  for (const name of TRAPPED) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\necho "TRAP: the real ${name} was reached" >&2\nexit 97\n`, { mode: 0o755 });
  }
  return {
    dir,
    // The search path: the stand-ins first, then these traps, then the runner's own traps (sealedPath), then the
    // system's folders for sh, node and the like.
    path: (...first) => sealedPath([...first, dir, '/usr/bin', '/bin']),
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    check() {
      const c = this.calls();
      if (c.length) throw new Error(`a trap was reached, the real program would have run: ${c.join(' | ')}`);
    },
  };
}
