// The git stand-in of a test's traps on Windows (test/ship/helpers.mjs, test/mission/helpers.mjs,
// test/adopt/fixture.mjs). On Linux and macOS each helper writes its own `#!/bin/sh` script, which the kernel starts with
// the arguments as they are. On Windows the test seal starts such a script through Git for Windows' sh
// (tools/test-seal.cjs windowsStandIn), and that sh is handed no argument list: its runtime reads one Windows command
// line, splits it again and expands every unquoted word that holds a brace or a wildcard as a pattern (Node quotes a
// word only when it holds a space, a tab or a quote). `HEAD^{tree}` then reaches git as `HEAD^tree`: in the public
// Windows run every go-live test said "git cannot say what the merged tree is" (src/ship/check.mjs treeIdOf), and the
// helper's journal check (`<commit>^{commit}`) refused every journal. That is read from the failures and from how the
// runtime starts a program; no Windows computer was at hand to watch it. sh also rewrites what looks like a POSIX path
// when it starts git.exe. So on Windows the stand-in is a Node script: the seal starts it through this Node, which gets
// the arguments as they were given, and it starts git.exe with exactly those, without a shell. What it refuses, the
// lines it writes to the trap log, its words on stderr and its exit code are the shell script's.
import fs from 'node:fs';
import path from 'node:path';

/** Windows: the first git.exe on `PATH` as Windows finds it (sh's `which git` answers a path of its own world). */
export const gitExeOnPath = (PATH = process.env.PATH || process.env.Path || '') => String(PATH).split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'git.exe')).find((f) => fs.existsSync(f));

/**
 * Write the git stand-in to `file`: `git` the real git's full path, `log` the trap log, `refuse` the git commands that
 * must not run, `every` (true: each call is written to the log as `git <args>` first), `line` the log line of a refused
 * call and `say` its words on stderr ({a} is the refused word, {args} all arguments joined by one space, as sh's $*),
 * `code` its exit code, `shell` the helper's own shell script (written as it is on every other system).
 */
export function writeGitStandIn(file, { git, log, refuse = ['push'], every = false, line, say, code = 97, shell, platform = process.platform }) {
  if (platform !== 'win32') {
    fs.writeFileSync(file, shell, { mode: 0o755 });
    return;
  }
  const src = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `const LOG = ${JSON.stringify(log)};`,
    "const fill = (t, a) => t.replace(/\\{a\\}/g, () => a).replace(/\\{args\\}/g, () => args.join(' '));",
    `if (${JSON.stringify(!!every)}) fs.appendFileSync(LOG, \`git \${args.join(' ')}\\n\`);`,
    `const hit = args.find((a) => ${JSON.stringify(refuse)}.includes(a));`,
    'if (hit !== undefined) {',
    `  fs.appendFileSync(LOG, fill(${JSON.stringify(line)}, hit) + '\\n');`,
    `  process.stderr.write(fill(${JSON.stringify(say)}, hit) + '\\n');`,
    `  process.exit(${Number(code)});`,
    '}',
    `const r = spawnSync(${JSON.stringify(git)}, args, { stdio: 'inherit', windowsHide: true });`,
    'if (r.error) { process.stderr.write(`git stand-in: ${r.error.message}\\n`); process.exit(127); }',
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n');
  fs.writeFileSync(file, src, { mode: 0o755 });
}
