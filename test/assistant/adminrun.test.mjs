// Running ONE administrator command of Tia's (src/assistant/adminrun.mjs), with a fake sudo on PATH: it reads the
// password from its input, checks it against a test password and only prints what it would run (nothing real is run,
// the real sudo is never called — the runner's seal would trap it). The password must never reach a command line, the
// returned output or any field returned here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealedPath } from '../seal.mjs';

const POSIX = process.platform !== 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-adminrun-'));
const bin = path.join(tmp, 'bin');
const argsLog = path.join(tmp, 'sudo-args.log');
const PASSWORD = 'Test pw 9#x';
fs.mkdirSync(bin, { recursive: true });
// The fake sudo: `-n` runs with no password (a NOPASSWD account); `-S` reads one line and compares it, then prints
// what it would run — and (like a careless program) the password it was given, so the scrubbing is tested too.
fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
printf '%s\\n' "$*" >> "${argsLog}"
if [ "$1" = "-n" ]; then shift; [ "$1" = "--" ] && shift; echo "would run: $*"; exit 0; fi
if [ "$1" = "-S" ]; then
  IFS= read -r pw
  if [ "$pw" != "${PASSWORD}" ]; then echo "Sorry, try again." >&2; echo "sudo: 1 incorrect password attempt" >&2; exit 1; fi
  shift 4; [ "$1" = "--" ] && shift
  echo "would run: $*"
  echo "the password was $pw"
  exit 0
fi
exit 3
`, { mode: 0o755 });
process.env.PATH = sealedPath(`${bin}${path.delimiter}${process.env.PATH}`);
const { sudoArgv, runAdmin } = await import('../../src/assistant/adminrun.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the exact sudo argv: sudo and one program with its arguments; sudo\'s own flags dropped', () => {
  assert.deepEqual(sudoArgv('sudo apt-get install -y jq'), { argv: ['sudo', 'apt-get', 'install', '-y', 'jq'] });
  // -E is stepped over (asAdmin re-adds the auth flags; a flag kept here would be read as the program after `--`)
  assert.deepEqual(sudoArgv('sudo -E tee /tmp/x'), { argv: ['sudo', 'tee', '/tmp/x'] });
  // the program is the word as it was written (a full path is kept)
  assert.deepEqual(sudoArgv('sudo /usr/bin/apt-get update'), { argv: ['sudo', '/usr/bin/apt-get', 'update'] });
});

test('a refused form, a non-plain form or a joined line is refused, not run', () => {
  assert.ok('refuse' in sudoArgv('sudo -i'), 'a login shell');
  assert.ok('refuse' in sudoArgv('su -'), 'a non-sudo escalator');
  assert.ok('refuse' in sudoArgv('sudo -u bob id'), 'an option the reader cannot step over');
  assert.ok('refuse' in sudoArgv('sudo'), 'no program');
  assert.ok('refuse' in sudoArgv('echo hi && sudo apt-get update'), 'a line that joins two commands');
  assert.ok('refuse' in sudoArgv('sudo visudo'), 'an account/editor tool (refused at every level)');
  const r = sudoArgv('sudo -i');
  assert.equal(typeof r.refuse.id, 'string');
  assert.equal(typeof r.refuse.why, 'string');
});

test('runAdmin: the password through the input (-S -k -p ...), checked first, scrubbed, in no returned field', { skip: !POSIX && 'the fake sudo is a shell script' }, async () => {
  fs.writeFileSync(argsLog, '');
  const { argv } = sudoArgv('sudo apt-get install -y jq');
  const r = await runAdmin({ argv, password: PASSWORD });
  assert.equal(r.ran, true);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('would run: apt-get install -y jq'), r.output);
  assert.ok(r.output.includes('the password was ••••'), 'a program that prints it is scrubbed');
  assert.ok(!r.output.includes(PASSWORD), 'the password is not in the output');
  assert.ok(!JSON.stringify(r).includes(PASSWORD), 'the password is in no field returned');
  const argLines = fs.readFileSync(argsLog, 'utf8').trim().split('\n');
  // The password was checked first (`sudo … -- true`), then the command ran, both `-S -k -p '' --`.
  assert.ok(argLines.includes('-S -k -p  -- true'), argLines.join('\n'));
  assert.ok(argLines.includes('-S -k -p  -- apt-get install -y jq'), argLines.join('\n'));
  assert.ok(!fs.readFileSync(argsLog, 'utf8').includes(PASSWORD), 'the password is never on a command line');
});

test('a wrong password runs nothing and says so; an account that may not use sudo is said once', { skip: !POSIX && 'the fake sudo is a shell script' }, async () => {
  fs.writeFileSync(argsLog, '');
  const { argv } = sudoArgv('sudo apt-get install -y jq');
  const bad = await runAdmin({ argv, password: 'not the password' });
  assert.deepEqual(bad, { ran: false, ok: false, code: null, output: '', wrong: true, notAllowed: false });
  assert.ok(!fs.readFileSync(argsLog, 'utf8').includes('would run'), 'the command never ran after a wrong password');
  // An account not in the sudoers file: said once (notAllowed), nothing ran. A stub runner stands in for that sudo.
  const run = async (_argv, o = {}) => { (o.onLine || (() => {}))('user is not in the sudoers file.'); return { ok: false, code: 1, output: 'user is not in the sudoers file.' }; };
  const na = await runAdmin({ argv, password: 'anything', run });
  assert.deepEqual(na, { ran: false, ok: false, code: null, output: '', wrong: false, notAllowed: true });
});

test('a NOPASSWD account runs `sudo -n` with no password and no check', { skip: !POSIX && 'the fake sudo is a shell script' }, async () => {
  fs.writeFileSync(argsLog, '');
  const { argv } = sudoArgv('sudo apt-get install -y jq');
  const r = await runAdmin({ argv, password: '' });
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('would run: apt-get install -y jq'), r.output);
  const argLines = fs.readFileSync(argsLog, 'utf8').trim().split('\n');
  assert.ok(argLines.includes('-n -- apt-get install -y jq'), argLines.join('\n'));
  assert.ok(!argLines.some((l) => l.includes(' -- true')), 'no password check when none is needed');
});
