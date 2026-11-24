// The dashboard's Tia mark (src/hermark.mjs): written where src/hook.mjs sessionByTia reads it, in the state folder
// the wall protects (not where a session can write), and removed when the run ends. Her safety in a session
// rests on this mark: below Full a session she started holds an administrator command as the owner's card, and whose
// session it is is read from this mark, never from the run record a command of the session can write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-hermark-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { herMarkFile, markHers, unmarkHers } = await import('../../src/hermark.mjs');
const { hookSettingsDir, runsDir, stateDir } = await import('../../src/paths.mjs');
const { removeRun, removeSettingsLeftovers } = await import('../../src/runs.mjs');

const runFile = (id) => path.join(runsDir(), `${id}.json`);
// Exactly how src/hook.mjs sessionByTia computes the mark path, replicated here to hold the writer and the reader
// equal: a `.tia` sibling of the handed hook settings, two folders up from the run record then into hook-settings.
const readerMark = (file) => path.join(path.dirname(path.dirname(file)), 'hook-settings', `${path.basename(file)}.tia`);

test('markHers writes {byTia:true} exactly where hook.mjs sessionByTia reads it', () => {
  const file = runFile('run-a');
  const wrote = markHers(file);
  assert.equal(wrote, herMarkFile(file));
  assert.equal(wrote, readerMark(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(wrote, 'utf8')), { byTia: true });
});

test('the mark lies in the state folder, beside the hook settings, not where a session can write', () => {
  const file = runFile('run-b');
  const mark = herMarkFile(file);
  assert.ok(mark.startsWith(hookSettingsDir() + path.sep), 'mark is under the hook-settings dir');
  assert.ok(hookSettingsDir().startsWith(stateDir() + path.sep), 'hook-settings is under the state folder the wall protects');
});

test('unmarkHers removes the mark and is safe when it is already gone', () => {
  const file = runFile('run-c');
  markHers(file);
  assert.ok(fs.existsSync(herMarkFile(file)));
  unmarkHers(file);
  assert.ok(!fs.existsSync(herMarkFile(file)));
  unmarkHers(file); // no throw the second time
});

test('removeRun removes the mark with the run record and its handed hook settings', () => {
  const file = runFile('run-d');
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ runId: 'run-d' }));
  const handed = path.join(hookSettingsDir(), 'run-d.json');
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  fs.writeFileSync(handed, '{}');
  markHers(file);
  assert.ok(fs.existsSync(herMarkFile(file)));
  removeRun(file);
  assert.ok(!fs.existsSync(file), 'run record gone');
  assert.ok(!fs.existsSync(handed), 'handed hook settings gone');
  assert.ok(!fs.existsSync(herMarkFile(file)), 'mark gone');
});

test('removeSettingsLeftovers sweeps an orphaned mark but keeps one whose run record lives', () => {
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  markHers(runFile('gone')); // no run record for "gone"
  fs.writeFileSync(runFile('live'), JSON.stringify({ runId: 'live' }));
  markHers(runFile('live'));
  removeSettingsLeftovers();
  assert.ok(!fs.existsSync(herMarkFile(runFile('gone'))), 'orphaned mark swept');
  assert.ok(fs.existsSync(herMarkFile(runFile('live'))), 'mark of a live run kept');
});
