// The git stand-in of the go-live, mission and adopt traps (test/ship/gitstandin.mjs). On Windows the test seal starts a
// `#!/bin/sh` stand-in through Git for Windows' sh, which splits its command line again and expands braces and
// wildcards: `HEAD^{tree}` reached git changed, and 25 go-live tests said "git cannot say what the merged tree is". There
// the stand-in is a Node script that hands git.exe the arguments exactly as given and refuses the same calls. Windows is
// given here as an argument, and a recorder stands in for git.exe, so this runs on every system.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeGitStandIn } from './gitstandin.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-git-standin-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const seen = path.join(root, 'seen.json');
const recorder = path.join(root, 'recorder');
// The recorder writes the arguments it got and ends with the code its first argument names, else 0.
fs.writeFileSync(recorder, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write('out\\n');\nprocess.exit(process.argv[2] === 'code' ? Number(process.argv[3]) : 0);\n`, { mode: 0o755 });
const calls = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const run = (file, args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });
// Words sh would change: braces, wildcards, a variable, the null device, a POSIX-looking path, a space, a quote, a backslash.
const TRICKY = ['rev-parse', '--verify', 'HEAD^{tree}', '*', '?', '[ab]', '$HOME', '-c', 'core.hooksPath=\\\\.\\nul', '/c/x', 'a b', 'say "hi"', 'back\\slash', ''];

test('Windows: the stand-in is a Node script that hands git every argument as it was given', () => {
  const log = path.join(root, 'ship.log');
  const file = path.join(root, 'git-ship');
  writeGitStandIn(file, { git: recorder, log, refuse: ['push'], line: 'git {args}', say: 'trap: git push must not run here', code: 97, shell: '#!/bin/sh\n', platform: 'win32' });
  assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], '#!/usr/bin/env node', 'the seal starts it through Node, no sh in between');
  const r = run(file, TRICKY);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'out\n', "git's output comes through");
  assert.deepEqual(calls().at(-1), TRICKY);
  assert.equal(run(file, ['code', '3']).status, 3, "git's exit code comes through");
  assert.equal(fs.existsSync(log), false, 'a call that is let through leaves no trap line');
});

test('Windows: a push is refused as the shell script refuses it, git never starts', () => {
  const log = path.join(root, 'push.log');
  const file = path.join(root, 'git-push');
  writeGitStandIn(file, { git: recorder, log, refuse: ['push'], line: 'git {args}', say: 'trap: git push must not run here', code: 97, shell: '#!/bin/sh\n', platform: 'win32' });
  const before = calls().length;
  const r = run(file, ['-C', 'C:\\x', 'push', '-q', 'origin', '$1']);
  assert.equal(r.status, 97);
  assert.equal(r.stderr, 'trap: git push must not run here\n');
  assert.equal(fs.readFileSync(log, 'utf8'), 'git -C C:\\x push -q origin $1\n', 'the line of sh: git $*');
  assert.equal(calls().length, before, 'the real git was not started');
});

test('Windows: the adopt shape logs every call and refuses each of its words with that word', () => {
  const log = path.join(root, 'adopt.log');
  const file = path.join(root, 'git-adopt');
  writeGitStandIn(file, { git: recorder, log, every: true, refuse: ['push', 'fetch', 'pull', 'ls-remote'], line: 'TRAP git {a}', say: 'trap: git {a} must not run in this test', code: 97, shell: '#!/bin/sh\n', platform: 'win32' });
  assert.equal(run(file, ['status', '--short']).status, 0);
  const r = run(file, ['fetch', 'origin']);
  assert.equal(r.status, 97);
  assert.equal(r.stderr, 'trap: git fetch must not run in this test\n');
  assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), ['git status --short', 'git fetch origin', 'TRAP git fetch']);
});

test('Linux and macOS: the helper\'s own shell script is written exactly', () => {
  const file = path.join(root, 'git-sh');
  const shell = '#!/bin/sh\nexec git "$@"\n';
  for (const platform of ['linux', 'darwin']) {
    writeGitStandIn(file, { git: recorder, log: path.join(root, 'sh.log'), line: 'x', say: 'x', shell, platform });
    assert.equal(fs.readFileSync(file, 'utf8'), shell);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  }
});
