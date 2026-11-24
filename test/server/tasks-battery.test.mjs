// Every scheduled task Hoprig makes on Windows runs on battery too: a task made without these settings stays "Queued"
// on a laptop that is not plugged in. The source is searched for every place that makes a task, so a new one cannot
// come without being held here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as winsvc from '../../src/server/service/windows.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
// What a task's definition is checked through: file → the task XML it makes.
const KNOWN = { [path.join('server', 'service', 'windows.mjs')]: () => winsvc.taskXml({ user: 'S-1-5-21-1-2-3-1001', script: 'C:\\x\\s.ps1', home: 'C:\\Users\\alex' }) };

test('every task Hoprig makes allows the battery, and is known to this test', () => {
  const makers = [];
  for (const e of fs.readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    const text = fs.readFileSync(file, 'utf8');
    // A task is made by schtasks /Create, by Register-ScheduledTask, or from a <Task> definition.
    if (/'\/Create'|Register-ScheduledTask|<Task version=/.test(text)) makers.push(path.relative(SRC, file));
  }
  assert.deepEqual(makers.sort(), Object.keys(KNOWN).sort(), 'a new place that makes a task: add it to KNOWN with its definition');
  for (const [file, xml] of Object.entries(KNOWN)) {
    const x = xml();
    assert.match(x, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/, file);
    assert.match(x, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/, file);
  }
});
