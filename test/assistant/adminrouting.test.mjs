// An administrator command of Tia's never reaches the plain shell: run_command's run routes it through the
// administrator path (ops.runAdmin → src/assistant/adminrun.mjs runAdmin → sudo -S -k -p '' -- …, the password to
// sudo's input), the construction of src/pcsetup/admin.mjs, and the machine-gated route (runHere) never does an
// administrator run at all (the levels Ask and Full of docs/OPERATOR.md). The run path is safe by construction: an
// administrator command here is run as administrator or refused, never given to the shell. The actual sudo run and
// its scrubbing are proven end to end through the suite's seal with a stand-in sudo below; the primitive itself is
// proven in adminrun.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealedPath } from '../seal.mjs';

const POSIX = process.platform !== 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-adminrouting-'));
const bin = path.join(tmp, 'bin');
const root = path.join(tmp, 'work');
const argsLog = path.join(tmp, 'sudo-args.log');
const PASSWORD = 'Route pw 7#q';
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(root, { recursive: true });
// The stand-in sudo (a made-up program, first on PATH, the seal traps the real one): `-n` runs with no password; `-S`
// reads one line and compares it, then prints what it would run and (like a careless program) the password, so the
// scrubbing is tested too.
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
const { run_command } = await import('../../src/assistant/owner-tools.mjs');
const { createOps } = await import('../../src/assistant/ops.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fake ops that records runAdmin / runCommand so the routing is seen without running anything.
function spyOps() {
  const calls = [];
  return {
    calls,
    async runAdmin(a) { calls.push({ op: 'runAdmin', a }); return { ran: true, ok: true, code: 0, output: 'ok', wrong: false, notAllowed: false }; },
    async runCommand(a) { calls.push({ op: 'runCommand', a }); return { code: 0, output: `ran: ${a.command}`, timedOut: false }; },
  };
}

test('an administrator command routes to ops.runAdmin with the exact argv and the one-shot password, never to the shell', async () => {
  const ops = spyOps();
  const r = await run_command.run(ops, { command: 'sudo apt-get install -y jq' }, { adminPassword: PASSWORD });
  const admin = ops.calls.filter((c) => c.op === 'runAdmin');
  assert.equal(admin.length, 1, 'ran once as administrator');
  assert.deepEqual(admin[0].a.argv, ['sudo', 'apt-get', 'install', '-y', 'jq'], 'the wall\'s reader built the argv');
  assert.equal(admin[0].a.password, PASSWORD, 'the one-shot password reached the admin run');
  assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), 'an administrator command never reaches the plain shell');
  assert.equal(r.data.administrator, true);
});

test('a plain command still goes to the shell (ops.runCommand), never the admin path (no regression)', async () => {
  const ops = spyOps();
  await run_command.run(ops, { command: 'echo hi && ls -la' }, {});
  assert.ok(ops.calls.some((c) => c.op === 'runCommand'), 'a plain command runs through the shell');
  assert.ok(!ops.calls.some((c) => c.op === 'runAdmin'), 'a plain command is never an administrator run');
});

test('a form that could raise her rights, reached at run, is refused and runs nothing (fail closed)', async () => {
  for (const command of ['sudo -i', 'sudo bash', 'su', 'sudo -u bob id']) {
    const ops = spyOps();
    await assert.rejects(() => run_command.run(ops, { command }, {}), /./, command);
    assert.equal(ops.calls.length, 0, `${command} ran nothing`);
  }
});

const localOps = (extra = {}) => createOps({ ctx: { config: () => ({ server: { roots: [root] } }) }, ...extra });

test('ops.runAdmin runs only on this computer, only a sudo argv, only inside the roots', async () => {
  let got = null;
  const ops = localOps({ runAdmin: async (a) => { got = a; return { ran: true, ok: true, code: 0, output: '', wrong: false, notAllowed: false }; } });
  await ops.runAdmin({ computer: 'this', argv: ['sudo', 'apt-get', 'update'], password: PASSWORD });
  assert.deepEqual(got.argv, ['sudo', 'apt-get', 'update']);
  assert.equal(got.password, PASSWORD);
  assert.equal(got.cwd, fs.realpathSync(root), 'the folder is resolved to an allowed root');
  await assert.rejects(() => ops.runAdmin({ computer: 'box2', argv: ['sudo', 'apt-get', 'update'] }), /only on this computer/, 'another computer: the password is the owner\'s own, for this computer');
  await assert.rejects(() => ops.runAdmin({ computer: 'this', argv: ['bash', '-c', 'x'] }), /sudo argv/, 'not a sudo argv');
  await assert.rejects(() => ops.runAdmin({ computer: 'this', argv: ['sudo', 'id'], cwd: '/etc' }), /allowed roots/, 'a folder outside the roots');
});

test('the machine-gated route (runHere) never does an administrator run: a sudo line goes to the shell, not runAdmin', async () => {
  let shelled = null;
  let adminRan = false;
  const ops = localOps({
    runShell: (command) => { shelled = command; return Promise.resolve({ code: 0, output: '', timedOut: false }); },
    runAdmin: async () => { adminRan = true; return { ran: true, ok: true, code: 0, output: '', wrong: false, notAllowed: false }; },
  });
  await ops.runHere({ command: 'sudo apt-get install x', cwd: null, timeoutMs: 1000 });
  assert.equal(shelled, 'sudo apt-get install x', 'runHere treats everything as a plain command');
  assert.equal(adminRan, false, 'a machine token (which reaches only runHere) can never trigger an administrator run with a password');
});

test('the whole chain through the seal: run_command.run runs the exact argv as administrator, the password scrubbed and in no field', { skip: !POSIX && 'the stand-in sudo is a shell script' }, async () => {
  fs.writeFileSync(argsLog, '');
  const ops = localOps();
  const r = await run_command.run(ops, { command: 'sudo apt-get install -y jq' }, { adminPassword: PASSWORD });
  assert.ok(r.output.text.includes('would run: apt-get install -y jq'), r.output.text);
  assert.ok(r.output.text.includes('the password was ••••'), 'a program that prints the password is scrubbed');
  assert.ok(!r.output.text.includes(PASSWORD), 'the password is not in the output');
  assert.ok(!JSON.stringify(r).includes(PASSWORD), 'the password is in no field of the result');
  const argLines = fs.readFileSync(argsLog, 'utf8').trim().split('\n');
  assert.ok(argLines.includes('-S -k -p  -- true'), 'the password was checked first');
  assert.ok(argLines.includes('-S -k -p  -- apt-get install -y jq'), 'then the command ran, the password to sudo\'s input');
  assert.ok(!fs.readFileSync(argsLog, 'utf8').includes(PASSWORD), 'the password is never on a command line');
});

test('a wrong password runs nothing and says so; an account that may not use sudo is said once', { skip: !POSIX && 'the stand-in sudo is a shell script' }, async () => {
  fs.writeFileSync(argsLog, '');
  const ops = localOps();
  await assert.rejects(() => run_command.run(ops, { command: 'sudo apt-get install -y jq' }, { adminPassword: 'not the password' }), /password was wrong/);
  assert.ok(!fs.readFileSync(argsLog, 'utf8').includes('would run: apt-get'), 'the command never ran after a wrong password');
  const na = localOps({ runAdmin: async () => ({ ran: false, ok: false, code: null, output: '', wrong: false, notAllowed: true }) });
  await assert.rejects(() => run_command.run(na, { command: 'sudo apt-get install -y jq' }, { adminPassword: 'x' }), /may not use administrator rights/);
});
