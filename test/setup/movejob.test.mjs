// The job file of a move started from the page (src/setup/movejob.mjs, movecli.mjs --job): every line and the result
// are in the file; after the switch each write also goes to the user's state folder, given to the user.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const J = await import('../../src/setup/movejob.mjs');
const M = await import('../../src/setup/movecli.mjs');

test('lines and the result go to the job file, and to the user\'s state folder once switched', () => {
  const file = path.join(s.tmp, 'root-state', J.JOB_FILE);
  const owned = [];
  const w = J.jobWriter(file, { chown: (p, uid) => owned.push([p, uid]) });
  w.line('first');
  assert.deepEqual(J.readJob(file).lines, ['first']);
  assert.equal(J.readJob(file).running, true);
  const userState = path.join(s.tmp, 'user-state');
  w.mirror(userState, { uid: 1001 });
  w.line('second');
  w.end({ ok: true, code: 0 });
  for (const f of [file, path.join(userState, J.JOB_FILE)]) {
    const j = J.readJob(f);
    assert.deepEqual(j.lines, ['first', 'second']);
    assert.deepEqual(j.result, { ok: true, code: 0 });
    assert.equal(j.running, false);
  }
  // Only the job file is given to the user: written as a temporary file of a random name beside it (given first, so it
  // is never root's), then renamed into its name. No temporary file is left.
  const tmpName = new RegExp(`^\\.${J.JOB_FILE.replace('.', '\\.')}\\.[0-9a-f]{16}\\.tmp$`);
  assert.ok(owned.length > 0);
  assert.ok(owned.every(([p, uid]) => path.dirname(p) === userState && (path.basename(p) === J.JOB_FILE || tmpName.test(path.basename(p))) && uid === 1001), owned.map(([p]) => p).join('\n'));
  assert.deepEqual(fs.readdirSync(userState), [J.JOB_FILE]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('--job: a look that stops writes its lines and a failed result', async () => {
  const file = path.join(s.tmp, 'job2.json');
  const io = { home: path.join(s.tmp, 'r'), uid: 1000, env: {}, dirs: { config: '/x', state: '/x', claude: '/x', workspace: '/x' } };
  assert.equal(await M.main(['--yes', '--job', file], { io, cfg: {}, out: () => {}, err: () => {} }), 1);
  const j = J.readJob(file);
  assert.equal(j.running, false);
  assert.deepEqual(j.result, { ok: false, code: 1 });
  assert.match(j.lines.join('\n'), /does not run as root here/);
});

test('a job whose process is gone is read as ended without a result, never "running" for good', () => {
  const file = path.join(s.tmp, 'lost', J.JOB_FILE);
  const w = J.jobWriter(file);
  w.line('Copying 47 entries…');
  // Its process is alive: running.
  assert.equal(J.readJob(file, { alive: () => true }).running, true);
  // Killed (out of memory, a reboot): ended, with one line that says so.
  const j = J.readJob(file, { alive: () => false });
  assert.equal(j.running, false);
  assert.deepEqual(j.result, { ok: false, lost: true });
  assert.deepEqual(j.lines, ['Copying 47 entries…', J.LOST_LINE]);
  // A job only started (no process wrote it yet): running for a while, then ended too.
  const started = path.join(s.tmp, 'started', J.JOB_FILE);
  J.startJob(started, { now: () => 1000 });
  assert.deepEqual(J.readJob(started, { now: () => 2000 }), { running: true, pid: null, startedAt: 1000, lines: [], result: null });
  assert.equal(J.readJob(started, { now: () => 1000 + J.START_MS + 1 }).running, false);
});

test("the job's mirror in the user's state folder never writes through a link the user put there", () => {
  const home = path.join(s.tmp, 'mirror-home');
  const userState = path.join(home, '.local/state/hoprig');
  const outside = path.join(s.tmp, 'mirror-outside');
  fs.mkdirSync(userState, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'target'), 'root\'s file\n');
  // The job file itself made a link, and the predictable temporary name of the old code too.
  fs.symlinkSync(path.join(outside, 'target'), path.join(userState, J.JOB_FILE));
  fs.symlinkSync(path.join(outside, 'target'), path.join(userState, `${J.JOB_FILE}.${process.pid}.tmp`));
  const w = J.jobWriter(path.join(s.tmp, 'mirror-root', J.JOB_FILE), { chown: () => {} });
  w.mirror(userState, { uid: 1001, home });
  w.line('after the switch');
  assert.equal(fs.readFileSync(path.join(outside, 'target'), 'utf8'), 'root\'s file\n', 'nothing written through a link');
  assert.equal(fs.lstatSync(path.join(userState, J.JOB_FILE)).isFile(), true, 'the link itself was replaced');
  assert.deepEqual(J.readJob(path.join(userState, J.JOB_FILE), { alive: () => true }).lines, ['after the switch']);
});
