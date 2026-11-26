// A temporary computer for the mission tests (test/work/helpers.mjs tempWork), with TRAPS first on PATH: sudo, npm,
// systemctl, loginctl, apt-get, brew, ssh and curl fail loudly and write their name to a trap log, and git refuses a push
// (every other git command goes to the real git). They are armed by arm(), after the test made its repositories and
// their local bare "servers" (that first push is the test's own). The stand-in coding tool is fixtures/fake-tool.mjs.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitExeOnPath, writeGitStandIn } from '../ship/gitstandin.mjs';
import { tempWork } from '../work/helpers.mjs';

export const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-tool.mjs');
export const TRAPPED = ['sudo', 'npm', 'systemctl', 'loginctl', 'apt-get', 'brew', 'ssh', 'curl'];

// A stand-in for the real box (seam.box()): it runs the gate's test command here, so the mission
// tests can exercise a passing and a failing gate. The real box runs with no network and without the owner's home;
// this stand-in has neither guard (a test runs OK or failing commands in a temporary home), it only stands in for
// runBoxed so the gate's decide-logic can be tested. A test of the no-box path passes box: null instead.
export const standInBox = {
  check: () => ({ ok: true, kind: 'standin' }),
  run: (argv, { cwd, timeoutMs } = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: 'utf8' });
    return { ok: r.status != null, code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.slice(0, 4000), timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
  },
};

export function missionHome(name) {
  const t = tempWork(name);
  const bin = path.join(t.root, 'traps');
  const trapLog = path.join(t.root, 'traps.log');
  fs.mkdirSync(bin, { recursive: true });
  const realGit = process.platform === 'win32' ? gitExeOnPath() || 'git' : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  for (const n of TRAPPED) {
    fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "${n} $*" >> "${trapLog}"\necho "TRAP: ${n} was called" >&2\nexit 99\n`, { mode: 0o755 });
  }
  // On Windows a Node script with the same answers (../ship/gitstandin.mjs: the sh there would change its arguments).
  writeGitStandIn(path.join(bin, 'git'), {
    git: realGit, log: trapLog, refuse: ['push'], line: 'git push {args}', say: 'TRAP: git push', code: 99,
    shell: `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ]; then echo "git push $*" >> "${trapLog}"; echo "TRAP: git push" >&2; exit 99; fi; done\nexec "${realGit}" "$@"\n`,
  });
  const arm = () => {
    if (!process.env.PATH.startsWith(`${bin}${path.delimiter}`)) process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  };
  const trapped = () => (fs.existsSync(trapLog) ? fs.readFileSync(trapLog, 'utf8') : '');
  return { ...t, bin, arm, trapped };
}
