// The launch file (src/launchfile.mjs): written for the owner only, taken once by the launcher, and refused when it is
// not one of this dashboard's own: outside the launch folder, a link, open to others, or of the wrong shape.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('launchfile');
test.after(() => box.cleanup());
const L = await import('../../src/launchfile.mjs');
const { binFile } = await import('../../src/paths.mjs');
const { sweepMarks } = await import('../../src/server/marks.mjs');

const POSIX = process.platform !== 'win32';
const USED = /^hoprig: This start line was used already, or it is not a start line of this computer's dashboard\. Start the session again from the dashboard, or type "hoprig" yourself\.\n$/;
const hop = (args, opts = {}) => spawnSync(process.execPath, [binFile(), ...args], { encoding: 'utf8', env: process.env, timeout: 20_000, ...opts });

test('written for the owner only, in a folder of its own, under a random name; the message whole', () => {
  const msg = 'line one\n\ttab \u0015 \'q\' "qq" \\ $(x) `y` ! नमस्ते';
  const file = L.writeLaunch({ cwd: box.root, argv: ['sub', '--', msg] }, 1234);
  assert.equal(path.dirname(file), L.launchDir());
  assert.match(path.basename(file), /^[0-9a-f]{32}\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, cwd: box.root, argv: ['sub', '--', msg], at: 1234 });
  if (POSIX) {
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'never readable by group or others');
    if (process.platform !== 'win32') assert.equal(fs.statSync(L.launchDir()).mode & 0o777, 0o700);
  }
  const other = L.writeLaunch({ cwd: box.root, argv: [] });
  assert.notEqual(other, file, 'one file per start');
  assert.deepEqual(L.takeLaunch(file), { cwd: box.root, argv: ['sub', '--', msg] });
  assert.equal(fs.existsSync(file), false, 'removed as it is taken');
  assert.throws(() => L.takeLaunch(file), L.LaunchError, 'a start line works once');
  L.dropLaunch(other);
});

test('a folder made earlier with more access is made owner-only again', { skip: !POSIX && 'POSIX modes' }, () => {
  fs.chmodSync(L.launchDir(), 0o755);
  L.dropLaunch(L.writeLaunch({ cwd: box.root, argv: [] }));
  if (process.platform !== 'win32') assert.equal(fs.statSync(L.launchDir()).mode & 0o777, 0o700);
});

test('refused: outside the launch folder, a link, open to others, another name, the wrong shape', () => {
  const good = () => L.writeLaunch({ cwd: box.root, argv: ['x'] });
  // Outside the launch folder (its parent, a folder beside it), even when its content is right.
  const f = good();
  const outside = path.join(box.state, path.basename(f));
  fs.copyFileSync(f, outside);
  fs.chmodSync(outside, 0o600);
  assert.throws(() => L.takeLaunch(outside), L.LaunchError);
  assert.throws(() => L.takeLaunch(path.join(L.launchDir(), '..', 'launch', '..', path.basename(f))), L.LaunchError);
  assert.equal(fs.existsSync(outside), true, 'not ours: left alone');
  // A name that is not one of ours.
  const odd = path.join(L.launchDir(), 'start.json');
  fs.copyFileSync(f, odd);
  assert.throws(() => L.takeLaunch(odd), L.LaunchError);
  fs.rmSync(odd);
  if (POSIX) {
    // A link in the launch folder, to a file that would pass.
    const link = path.join(L.launchDir(), `${'a'.repeat(32)}.json`);
    fs.symlinkSync(f, link);
    assert.throws(() => L.takeLaunch(link), L.LaunchError);
    fs.rmSync(link);
    // Open to the group or to others.
    for (const mode of [0o640, 0o604, 0o644]) {
      const g = good();
      fs.chmodSync(g, mode);
      assert.throws(() => L.takeLaunch(g), L.LaunchError, mode.toString(8));
      L.dropLaunch(g);
    }
  }
  L.dropLaunch(f);
  // The wrong shape.
  for (const body of ['not json', '{"v":2,"cwd":"/","argv":[]}', '{"v":1,"cwd":"rel","argv":[]}', '{"v":1,"cwd":"/","argv":[1]}', '{"v":1,"argv":[]}', '{"v":1,"cwd":"/","argv":"x"}', 'null']) {
    const g = good();
    fs.writeFileSync(g, body);
    assert.throws(() => L.takeLaunch(g), L.LaunchError, body);
    assert.equal(fs.existsSync(g), false, 'ours, so taken all the same: it works once');
  }
  assert.throws(() => L.takeLaunch(''), L.LaunchError);
  assert.throws(() => L.takeLaunch(path.join(L.launchDir(), `${'b'.repeat(32)}.json`)), L.LaunchError, 'missing');
});

test('the files nobody used go after ten minutes, when the start marks are swept', () => {
  const old = L.writeLaunch({ cwd: box.root, argv: ['--', 'secret task'] });
  const fresh = L.writeLaunch({ cwd: box.root, argv: [] });
  const t = (Date.now() - 11 * 60_000) / 1000;
  fs.utimesSync(old, t, t);
  sweepMarks();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  L.dropLaunch(fresh);
});

test('the launcher: started with --launch it runs in the file\'s folder as if started with its arguments; once', () => {
  const work = fs.mkdtempSync(path.join(box.root, 'w-'));
  const plain = hop(['profiles', '--json'], { cwd: work });
  assert.equal(plain.status, 0, plain.stderr);
  const file = L.writeLaunch({ cwd: work, argv: ['profiles', '--json'] });
  const r = hop(['--launch', file], { cwd: box.root });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, plain.stdout, ''], 'the same as typed by hand');
  assert.equal(fs.existsSync(file), false);
  const again = hop(['--launch', file]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, USED);
  assert.equal(again.stdout, '', 'nothing started');
  // Its folder is gone: one sentence, exit 2.
  const gone = L.writeLaunch({ cwd: path.join(box.root, 'gone\u0015x'), argv: ['profiles'] });
  const g = hop(['--launch', gone]);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /^hoprig: the folder this session was to start in is not there any more: ".*gone\\u0015x"\. Start it again from the dashboard in a folder that exists\.\n$/);
  // A planted file, a missing path, a second word: refused, nothing runs.
  for (const args of [['--launch', path.join(box.root, 'x.json')], ['--launch'], ['--launch', file, 'extra']]) {
    const x = hop(args);
    assert.deepEqual([x.status, x.stdout], [2, ''], args.join(' '));
    assert.match(x.stderr, USED);
  }
  // Plain arguments work as before, and the flag is not in the help.
  assert.equal(hop(['--version']).status, 0);
  assert.doesNotMatch(hop(['--help']).stdout, /--launch/);
});

test('the launcher in the folder: process.cwd() and $PWD are the file\'s folder, whatever the shell started in', () => {
  // Windows refuses a control character in a file name: there, the characters PowerShell and cmd.exe would read.
  const work = fs.mkdtempSync(path.join(box.root, POSIX ? 'tab\tand \u0015 ' : "sp ace ' % $ & ^ ! (x) "));
  const file = L.writeLaunch({ cwd: work, argv: ['a', '--', 'm\n2'] });
  const script = `import { applyLaunch } from ${JSON.stringify(new URL('../../src/launchfile.mjs', import.meta.url).href)}; applyLaunch(); process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pwd: process.env.PWD }));`;
  const runner = path.join(box.root, 'runner.mjs');
  fs.writeFileSync(runner, script);
  const ok = spawnSync(process.execPath, [runner, '--launch', file], { encoding: 'utf8', cwd: box.root });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { argv: ['a', '--', 'm\n2'], cwd: fs.realpathSync(work), pwd: work });
});
