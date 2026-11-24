// What docs/WORK.md's Missions part says Save does with the missions' files, held to the code (src/work/save.mjs,
// src/work/saveplan.mjs): it reads the code and calls the check that decides which files go in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMissionFile } from '../src/work/saveplan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const doc = read('docs/WORK.md');
const missions = doc.slice(doc.indexOf('\n## Missions'), doc.indexOf('\n## ', doc.indexOf('\n## Missions') + 1)).replace(/\s+/g, ' ');

test("the Missions part says Save commits the missions' files, and the code does", () => {
  assert.doesNotMatch(missions, /Save does not commit/);
  assert.match(missions, /\*\*Save commits the missions' files\*\* with the list, by name/);
  assert.match(missions, /not a plain mission record \(a link, or something a session wrote\) is named in the Save plan and left alone/);
  // The plan puts the mission files among the files it commits, and the save takes them as Work's own.
  const plan = read('src/work/saveplan.mjs');
  assert.match(plan, /const files = \[[^\n]*, \.\.\.missionFiles\];/);
  assert.match(plan, /const notMissions = missionNamed\.filter\(\(e\) => !isMission\(e\)\)/);
  assert.match(read('src/work/save.mjs'), /const isExtra = \(file\) => [^\n]*isMissionFile\(file\)/);
});

test('a plain mission record is taken, a link or another file of its name is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missions-claims-'));
  try {
    const rec = path.join(dir, 'm-20270101-a1b2c3.json');
    fs.writeFileSync(rec, JSON.stringify({ v: 1, id: 'm-20270101-a1b2c3', writer: 'box2', goal: 'example' }));
    assert.equal(isMissionFile(rec), true);
    const link = path.join(dir, 'm-20270101-d4e5f6.json');
    fs.symlinkSync(rec, link);
    assert.equal(isMissionFile(link), false, 'a link');
    const other = path.join(dir, 'm-20270101-0a0b0c.json');
    fs.writeFileSync(other, JSON.stringify({ note: 'something a session wrote' }));
    assert.equal(isMissionFile(other), false, 'not a mission record');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
