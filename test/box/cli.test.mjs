// The box's commands: `hoprig box check` (0 for a yes, 3 for a no; --json) and `hoprig box run [--write DIR]...
// [--read DIR]... -- <command...>` (the command's own exit code; 124 at the timeout; 3 with one line why when nothing
// ran). The real commands run as their own process in a temporary home; the no-box and timeout cases go through
// main()'s own arguments, never a variable.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { boxCheck } from '../../src/box/box.mjs';
import { main, parseRun } from '../../src/box/cli.mjs';
import { sealed } from '../seal.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hoprig.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-cli-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, 'home');
const work = path.join(tmp, 'work');
const lib = path.join(tmp, 'lib');
for (const d of [home, work, lib]) fs.mkdirSync(d);
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

/** `hoprig ...args` as its own process in the temporary home, from `cwd`. → { code, out, err } */
function hoprig(args, cwd = work) {
  const env = sealed({ HOME: home, PATH: process.env.PATH, HOPRIG_CONFIG_DIR: path.join(tmp, 'config'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), HOPRIG_WORKSPACE_DIR: path.join(tmp, 'ws') });
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
/** A writable stand-in for stdout or stderr. */
const sink = () => ({ text: '', write(s) { this.text += s; } });

test('the words of box run: --write and --read up to "--", then the command; anything else is refused', () => {
  assert.deepEqual(parseRun(['--write', 'a', '--read=b', '--', 'npm', 'test']), { write: ['a'], read: ['b'], argv: ['npm', 'test'] });
  assert.deepEqual(parseRun(['--', '-x', '--write']), { write: [], read: [], argv: ['-x', '--write'] }, 'after "--" every word is the command\'s');
  for (const bad of [['npm', 'test'], ['--write', 'a'], ['--write', 'a', '--'], ['--write'], ['--unboxed', '--', 'x'], ['--net', '--', 'x']]) assert.ok(parseRun(bad).why, JSON.stringify(bad));
});

test('no box: check says no with the why and the step and exits 3; run runs nothing and exits 3 with one line', async () => {
  const no = async () => ({ ok: false, kind: null, why: 'bubblewrap is not installed', step: 'install bubblewrap (for example: sudo apt install bubblewrap)' });
  const out = sink();
  assert.equal(await main(['check'], { out, err: sink(), check: no }), 3);
  assert.equal(out.text, 'This computer has no box: bubblewrap is not installed.\nWhat would give it one: install bubblewrap (for example: sudo apt install bubblewrap).\n');
  const json = sink();
  assert.equal(await main(['check', '--json'], { out: json, err: sink(), check: no }), 3);
  assert.deepEqual(JSON.parse(json.text), { ok: false, kind: null, why: 'bubblewrap is not installed', step: 'install bubblewrap (for example: sudo apt install bubblewrap)' });
  const err = sink();
  const ran = [];
  const code = await main(['run', '--write', work, '--', 'true'], { out: sink(), err, cwd: work, run: async (...a) => (ran.push(a), { ok: false, code: null, timedOut: false, out: '', why: 'no box on this computer: bubblewrap is not installed' }) });
  assert.equal(code, 3);
  assert.equal(err.text, 'hoprig box run: no box on this computer: bubblewrap is not installed\n');
});

test('box run: a wrong option exits 3 and runs nothing; the run gets 30 minutes and 1 MB', async () => {
  const seen = [];
  const run = async (argv, opts) => (seen.push([argv, opts]), { ok: true, code: 0, out: '', timedOut: false, dropped: 0 });
  const err = sink();
  assert.equal(await main(['run', '--', 'true', 'x'], { out: sink(), err: sink(), cwd: work, run }), 0);
  assert.equal(seen[0][1].timeoutMs, 30 * 60_000);
  assert.equal(seen[0][1].maxOut, 1 << 20);
  assert.deepEqual(seen[0][1].write, []);
  assert.equal(await main(['run', '--bogus', '--', 'true'], { out: sink(), err, cwd: work, run }), 3);
  assert.equal(seen.length, 1, 'nothing ran for a wrong option');
  assert.match(err.text, /^hoprig box run: unknown option: --bogus\n$/);
});

test('in the real box: check says yes and exits 0, also as JSON', { skip, timeout: 60_000 }, () => {
  const r = hoprig(['box', 'check']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^This computer has a box \(bwrap\)/);
  const j = hoprig(['box', 'check', '--json']);
  assert.equal(j.code, 0);
  assert.deepEqual(JSON.parse(j.out), { ok: true, kind: 'bwrap', why: '', step: '' });
});

test('in the real box: run gives the command\'s own exit code and output; a read folder is read-only', { skip, timeout: 60_000 }, () => {
  fs.writeFileSync(path.join(lib, 'v.txt'), 'from-lib');
  const ok = hoprig(['box', 'run', '--write', '.', '--read', lib, '--', process.execPath, '-e', `const fs = require('fs'); fs.writeFileSync('out.txt', 'y'); console.log(fs.readFileSync(${JSON.stringify(path.join(lib, 'v.txt'))}, 'utf8')); try { fs.writeFileSync(${JSON.stringify(path.join(lib, 'w'))}, 'x') } catch (e) { console.log(e.code) } process.exit(7)`]);
  assert.equal(ok.code, 7, ok.err);
  assert.equal(ok.out, 'from-lib\nEROFS\n');
  assert.equal(fs.readFileSync(path.join(work, 'out.txt'), 'utf8'), 'y');
});

test('in the real box: no --write or --read that holds the current folder exits 3, and nothing runs', { skip, timeout: 60_000 }, () => {
  const r = hoprig(['box', 'run', '--read', lib, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(lib, 'ran'))}, 'x')`]);
  assert.equal(r.code, 3);
  assert.equal(r.err, 'hoprig box run: nothing ran: cwd must be inside a write or read folder\n');
  assert.equal(fs.existsSync(path.join(lib, 'ran')), false);
});

test('in the real box: a timeout exits 124 with one line', { skip, timeout: 60_000 }, async () => {
  const err = sink();
  const out = sink();
  const code = await main(['run', '--write', work, '--', '/bin/sh', '-c', 'echo started; sleep 30'], { out, err, cwd: work, runMs: 1500 });
  assert.equal(code, 124);
  assert.equal(out.text, 'started\n', 'the output so far is printed');
  assert.equal(err.text, 'hoprig box run: stopped after 1.5 seconds, with every process it started\n');
});

test('box run: --write or --read with no folder (a "--" or another option next) is refused, not taken as the folder', () => {
  assert.match(parseRun(['--write', '--', 'true']).why, /^--write needs a folder$/);
  assert.match(parseRun(['--write', '--read', 'x', '--', 'true']).why, /^--write needs a folder$/);
  assert.match(parseRun(['--read', '--', 'ls']).why, /^--read needs a folder$/);
  assert.deepEqual(parseRun(['--write', '.', '--', 'npm', 'test']), { write: ['.'], read: [], argv: ['npm', 'test'] }, 'a real folder still works');
});

test('box check with an unknown word names the word and exits 3 (the brief sets only 0 and 3 for check)', async () => {
  const err = sink();
  const code = await main(['check', '--bogus'], { out: sink(), err, check: async () => ({ ok: true, kind: 'bwrap' }) });
  assert.equal(code, 3);
  assert.match(err.text, /^hoprig box check: unknown option: --bogus\n$/);
});

test('box run with no box shows the step that would give one', async () => {
  const err = sink();
  const no = async () => ({ ok: false, code: null, timedOut: false, out: '', why: 'no box on this computer: bubblewrap is not installed', step: 'install bubblewrap (for example: sudo apt install bubblewrap)' });
  const code = await main(['run', '--write', work, '--', 'true'], { out: sink(), err, cwd: work, run: no });
  assert.equal(code, 3);
  assert.match(err.text, /no box on this computer: bubblewrap is not installed/);
  assert.match(err.text, /what would give it one: install bubblewrap/);
});
