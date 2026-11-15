// Administrator rights without a terminal (src/pcsetup/admin.mjs), with a fake sudo on PATH: it reads the password
// from its input, checks it against a test password and only prints what it would run (nothing is installed, the
// real sudo is never called). The password must never reach a command line, a job's lines, a route's answer, a log
// or a file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const POSIX = process.platform !== 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcsetup-admin-'));
const bin = path.join(tmp, 'bin');
const argsLog = path.join(tmp, 'sudo-args.log');
const PASSWORD = 'Test pw 9#x';
fs.mkdirSync(bin, { recursive: true });
// The fake: -n is refused (a password is needed); -S reads one line and compares it; then it prints what it would
// run, and (like a careless program) the password it was given, so the scrubbing is tested too.
fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
printf '%s\\n' "$*" >> "${argsLog}"
if [ "$1" = "-n" ]; then echo "sudo: a password is required" >&2; exit 1; fi
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
Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
const A = await import('../../src/pcsetup/admin.mjs');
const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the sudo argv: the password through the input (-S -k, no prompt), never on the command line; without one sudo may not ask', () => {
  assert.deepEqual(A.asAdmin(['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update'], true), ['sudo', '-S', '-k', '-p', '', '--', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update']);
  assert.deepEqual(A.asAdmin(['sudo', 'usermod', '-aG', 'docker', 'dev'], false), ['sudo', '-n', '--', 'usermod', '-aG', 'docker', 'dev']);
  assert.deepEqual(A.asAdmin(['brew', 'install', 'jq'], true), ['brew', 'install', 'jq'], 'not an admin step: as it is');
  assert.equal(A.scrubber('s3cret')('a s3cret b s3cret'), 'a •••• b ••••');
  assert.equal(A.scrubber(null)('as it is'), 'as it is');
});

test('does sudo need a password: root and no sudo need nothing; otherwise `sudo -n true` decides', async () => {
  const calls = [];
  const run = async (argv) => (calls.push(argv), { ok: false });
  assert.equal(await A.sudoNeedsPassword({ root: true, has: () => true }, run), false);
  assert.equal(await A.sudoNeedsPassword({ root: false, has: () => false }, run), false);
  assert.equal(calls.length, 0);
  assert.equal(await A.sudoNeedsPassword({ root: false, has: () => true }, run), true);
  assert.deepEqual(calls[0], ['sudo', '-n', 'true']);
  assert.equal(await A.sudoNeedsPassword({ root: false, has: () => true }, async () => ({ ok: true })), false, 'no password needed (NOPASSWD)');
});

test('the password is checked first; a wrong one is said and installs nothing', { skip: !POSIX && 'the fake sudo is a shell script' }, async () => {
  assert.deepEqual(await A.checkPassword(PASSWORD), { ok: true, notAllowed: false });
  assert.deepEqual(await A.checkPassword('wrong'), { ok: false, notAllowed: false });
  const r = A.adminRunner(PASSWORD);
  const lines = [];
  const out = await r(['sudo', 'apt-get', 'install', '-y', 'jq'], { onLine: (l) => lines.push(l) });
  assert.equal(out.ok, true);
  assert.deepEqual(lines, ['would run: apt-get install -y jq', 'the password was ••••']);
  assert.ok(!out.output.includes(PASSWORD));
  assert.ok(!fs.readFileSync(argsLog, 'utf8').includes(PASSWORD), 'never on a command line');
});

function harness(over = {}) {
  const sys = { platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: os.tmpdir(), home: process.env.HOME, env: process.env, has: (b) => b === 'sudo', exists: () => false, clt: true, run: async () => ({ ok: false, stdout: '', stderr: '' }) };
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [], create: async () => assert.fail('no terminal') }, deck: { launcher: () => ['node', 'hoprig.mjs'] } };
  const f = pcsetupFeature(sctx, { sys, projectsDir: () => path.join(tmp, 'projects'), ...over });
  const call = async (method, p, body) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Object.assign(Readable.from([]), { body }), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  return call;
}

test('Set up this computer from the page: the password asked for, a wrong one asked again, then the job; the password nowhere', { skip: !POSIX && 'the fake sudo is a shell script' }, async () => {
  const said = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(keep)) console[k] = (...a) => said.push(a.join(' '));
  try {
    fs.writeFileSync(argsLog, '');
    const call = harness();
    // Terminal extras on apt: every step is an admin step (the package lists, then one install).
    assert.deepEqual(await call('POST', '/api/pcsetup/setup', { kits: ['extras'] }), { needsPassword: true });
    assert.deepEqual(await call('POST', '/api/pcsetup/setup', { kits: ['extras'], password: 'wrong' }), { needsPassword: true, wrong: true, notAllowed: false });
    await assert.rejects(call('POST', '/api/pcsetup/setup', { kits: ['extras'], password: 'two\nlines' }), /cannot be used/);
    assert.equal((await call('GET', '/api/pcsetup/job')).kind, null, 'nothing started');
    const answer = await call('POST', '/api/pcsetup/setup', { kits: ['extras'], password: PASSWORD });
    assert.deepEqual(answer, { started: true });
    let j;
    for (let i = 0; i < 200; i++) {
      j = await call('GET', '/api/pcsetup/job?from=0');
      if (!j.running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(j.running, false);
    assert.deepEqual(j.steps.map((s) => s.state), ['ok', 'ok']);
    assert.deepEqual(j.result.data.missing, ['tmux', 'ripgrep', 'jq'], 'the fake installs nothing: still missing, by name');
    assert.equal(j.steps[0].label, 'refresh the package lists');
    assert.match(j.steps[1].command, /^sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux ripgrep jq$/);
    assert.ok(j.lines.includes('    would run: env DEBIAN_FRONTEND=noninteractive apt-get update'), j.lines.join('\n'));
    assert.ok(j.lines.includes('    the password was ••••'), 'a program that prints it is scrubbed');
    const args = fs.readFileSync(argsLog, 'utf8').trim().split('\n');
    assert.ok(args.includes('-S -k -p  -- env DEBIAN_FRONTEND=noninteractive apt-get update'), args.join('\n'));
    // Nowhere: the job's answer, its result, the command lines, what was printed, any file the run left behind.
    assert.ok(!JSON.stringify(j).includes(PASSWORD), 'not in the route\'s answer');
    assert.ok(!args.join('\n').includes(PASSWORD), 'not on a command line');
    assert.ok(!said.join('\n').includes(PASSWORD), 'not in a log');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const file of walk(tmp).filter((x) => !x.endsWith(`${path.sep}sudo`))) assert.ok(!fs.readFileSync(file, 'utf8').includes(PASSWORD), `not in ${path.relative(tmp, file)}`);
  } finally {
    Object.assign(console, keep);
  }
});

test('an account that may not use sudo: said once, not asked again and again', async () => {
  const call = harness({ stream: async (argv, o) => (o.onLine('dev is not in the sudoers file.'), { ok: false, code: 1, output: '' }), sudoNeedsPassword: async () => true });
  assert.deepEqual(await call('POST', '/api/pcsetup/setup', { kits: ['extras'], password: 'x' }), { needsPassword: true, wrong: false, notAllowed: true });
});
