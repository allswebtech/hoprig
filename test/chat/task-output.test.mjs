// A background task opens to its output (src/chat/tasks.mjs taskOutput): only the tool's own task file is read, the last
// 2000 lines of it, never more than a bounded tail; an agent has its report text, not a file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OUTPUT_LINES, TaskTable, taskOutput } from '../../src/chat/tasks.mjs';
import { parseLines } from './protocol.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskout-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const tasksDir = path.join(dir, 'proj', 'tasks');
fs.mkdirSync(tasksDir, { recursive: true });

test('the task notification names the output file; the page is never told its path', () => {
  const ev = parseLines([{ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'done', output_file: '/tmp/x/tasks/b1.output' }]);
  assert.equal(ev[0].outputFile, '/tmp/x/tasks/b1.output');
  const t = new TaskTable();
  t.apply({ kind: 'task', taskId: 'b1', type: 'shell', outputFile: '/tmp/x/tasks/b1.output' });
  assert.deepEqual(t.forPage().map((x) => [x.taskId, x.outputFile, x.hasOutput]), [['b1', undefined, true]]);
});

test('a shell task: the last lines of its own file, bounded, with the cut said', async () => {
  const file = path.join(tasksDir, 'b2.output');
  fs.writeFileSync(file, Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const t = { taskId: 'b2', type: 'shell', status: 'running', outputFile: file };
  const r = await taskOutput(t);
  const lines = r.text.split('\n');
  assert.equal(lines.length, OUTPUT_LINES);
  assert.deepEqual([lines[0], lines.at(-1), r.cut, r.running], ['line 501', 'line 2500', true, true]);
  fs.writeFileSync(file, 'one\ntwo');
  const small = await taskOutput({ ...t, status: 'completed' });
  assert.deepEqual([small.text, small.cut, small.running], ['one\ntwo', false, false]);
});

test('a big file is read from its tail only', async () => {
  const file = path.join(tasksDir, 'b3.output');
  fs.writeFileSync(file, `${'a'.repeat(3 << 20)}\nlast\n`);
  const r = await taskOutput({ taskId: 'b3', type: 'shell', status: 'completed', outputFile: file });
  assert.ok(r.text.length <= 512 * 1024 && r.text.endsWith('last'));
  assert.equal(r.cut, true);
});

test('only the tool\'s own task file: another name, another folder, a link, a folder, a missing file, no path', async () => {
  fs.writeFileSync(path.join(tasksDir, 'other.output'), 'secret');
  fs.writeFileSync(path.join(dir, 'passwd'), 'secret');
  fs.mkdirSync(path.join(dir, 'plain'));
  fs.writeFileSync(path.join(dir, 'plain', 'b4.output'), 'secret');
  fs.symlinkSync(path.join(dir, 'passwd'), path.join(tasksDir, 'b5.output'));
  fs.mkdirSync(path.join(tasksDir, 'b6.output'));
  const ask = (taskId, outputFile) => taskOutput({ taskId, type: 'shell', status: 'running', outputFile });
  for (const [id, f] of [['b4', path.join(tasksDir, 'other.output')], ['b4', path.join(dir, 'plain', 'b4.output')], ['b5', path.join(tasksDir, 'b5.output')], ['b6', path.join(tasksDir, 'b6.output')], ['b7', path.join(tasksDir, 'b7.output')], ['b8', undefined], ['b9', 'tasks/b9.output'], ['b9', `${tasksDir}/../tasks/b9.output`]]) {
    const r = await ask(id, f);
    assert.equal(r.text, '', `${id} ${f}`);
    assert.ok(!JSON.stringify(r).includes('secret'));
  }
});

test('an agent has its report or what it does now, no file', async () => {
  assert.equal((await taskOutput({ taskId: 'a', type: 'agent', status: 'completed', summary: 'It found three files.' })).text, 'It found three files.');
  assert.equal((await taskOutput({ taskId: 'a', type: 'agent', status: 'running', now: 'Reading a.js' })).text, 'Reading a.js');
});
