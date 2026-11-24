// The hand-over of a move, end to end through the real launcher entry (bin/hoprig.mjs): a launch file the dashboard
// writes with a hand-over → applyLaunch → launch → createRun. A stand-in Claude Code copies the run record it was
// handed ($HOPRIG_RUN_FILE) and its own environment, then ends. The new record takes the dashboard's run id and the
// stops; nothing of the hand-over is in the coding tool's environment.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('movecarry-launcher');
test.after(() => box.cleanup());
const L = await import('../../src/launchfile.mjs');
const { binFile } = await import('../../src/paths.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { saveConfig } = await import('../../src/config.mjs');

const POSIX = process.platform !== 'win32';
const work = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'shop-')));
const out = path.join(box.root, 'fake-out.json');
const fake = path.join(box.root, 'fake-claude.mjs');
fs.writeFileSync(fake, `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ run: JSON.parse(fs.readFileSync(process.env.HOPRIG_RUN_FILE, 'utf8')), file: process.env.HOPRIG_RUN_FILE, env: process.env, args: process.argv.slice(2) }));
`, { mode: 0o755 });
saveConfig({ claudeBin: fake, usage: false });
writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });

const CONV = crypto.randomUUID();
const DONE = [{ at: Date.now() - 60_000, kind: 'question', question: 'Which runner?', text: 'node:test (Recommended)', because: 'recommended' }];
const hop = (args) => spawnSync(process.execPath, [binFile(), ...args], { encoding: 'utf8', cwd: box.root, env: { ...process.env, FAKE_OUT: out }, timeout: 30_000 });

test('a launch file with a hand-over starts a run under the dashboard\'s id with the stops', { skip: !POSIX && 'the stand-in is started by its #! line' }, () => {
  const hand = { from: 'mabc123-111', runId: 'mabc124-222', conversation: CONV, carry: { stop: 'loop', row: 3, done: DONE } };
  const file = L.writeLaunch({ cwd: work, argv: ['backup', '--session-id', CONV], hand });
  const r = hop([L.LAUNCH_FLAG, file]);
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(got.run.runId, 'mabc124-222');
  assert.equal(path.basename(got.file), 'mabc124-222.json');
  assert.equal(got.run.conversation, CONV);
  assert.equal(got.run.handsOffStop, 'loop');
  assert.equal(got.run.handsOffRow, 3);
  assert.deepEqual(got.run.handsOffDone, DONE);
  assert.equal(JSON.stringify(got.env).includes('mabc123-111'), false, 'the old id is in no variable of the coding tool');
  assert.equal(Object.values(got.env).some((v) => String(v).includes('mabc124-222') && !String(v).endsWith('mabc124-222.json')), false, 'the hand-over is in no variable');
  assert.equal(fs.existsSync(file), false, 'the launch file was taken');
});

test('the same start without a hand-over writes a run of its own id, with nothing carried', { skip: !POSIX && 'the stand-in is started by its #! line' }, () => {
  const file = L.writeLaunch({ cwd: work, argv: ['backup', '--session-id', CONV] });
  const r = hop([L.LAUNCH_FLAG, file]);
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.notEqual(got.run.runId, 'mabc124-222');
  for (const k of ['handsOffStop', 'handsOffRow', 'handsOffDone']) assert.equal(k in got.run, false, k);
});

test('a hand-over of a bad shape refuses the start with the one sentence; nothing starts', () => {
  const file = path.join(L.launchDir(), `${crypto.randomBytes(16).toString('hex')}.json`);
  fs.mkdirSync(L.launchDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ v: 1, cwd: work, argv: ['backup'], at: 1, hand: { from: 'mabc123-111', runId: 'mabc124-222', conversation: CONV, carry: { on: true } } }), { mode: 0o600 });
  fs.rmSync(out, { force: true });
  const r = hop([L.LAUNCH_FLAG, file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /This start line was used already/);
  assert.equal(fs.existsSync(out), false, 'the coding tool never started');
});

test('a launch file with a reset hand starts the resumed run with its answers stopped', { skip: !POSIX && 'the stand-in is started by its #! line' }, () => {
  // A restore after a reboot, or a chat opened in a terminal: the dashboard could not carry Hands-off, so the new
  // run starts with its answers stopped ('reset'). The wall still holds by the switch (hook.mjs preToolHold).
  const file = L.writeLaunch({ cwd: work, argv: ['backup', '--resume', CONV], hand: { reset: true } });
  const r = hop([L.LAUNCH_FLAG, file]);
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(got.run.handsOffStop, 'reset', 'the resumed run starts with its answers stopped');
  assert.equal(got.run.conversation, CONV);
  assert.equal(fs.existsSync(file), false, 'the launch file was taken');
});
