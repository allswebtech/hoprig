// Work's place refused: a project that is not in the projects folder sends work-place-gone (Work → Tasks → Work settings (at the foot)), and no
// AI brain yet sends no-workspace (the AI brain page sets it up), so the page adds one button there (web/errorways.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-codes-'));
Object.assign(process.env, { HOPRIG_STATE_DIR: path.join(tmp, 'state'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg') });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { resolvePlace } = await import('../../src/work/place.mjs');

const ws = path.join(tmp, 'ws');
const projects = path.join(ws, 'projects');
fs.mkdirSync(projects, { recursive: true });
const codeOf = (e) => e && e.details && e.details.code;

test('a Work place in a project that is not there: work-place-gone', () => {
  assert.throws(() => resolvePlace({ work: { place: 'project', project: 'shop', path: 'docs/plans' } }, { workspace: ws, projects }),
    (e) => e.status === 409 && codeOf(e) === 'work-place-gone' && /Work → Tasks → Work settings \(at the foot\)/.test(e.message));
});

test('Work in the AI brain while there is none: no-workspace', () => {
  assert.throws(() => resolvePlace({}, { workspace: ws, projects }), (e) => e.status === 409 && codeOf(e) === 'no-workspace' && /Set one up on the AI brain page, or choose "A project" under Work → Tasks → Work settings \(at the foot\)\.$/.test(e.message) && !/Workspace → Set up|keep Work in a project/.test(e.message));
});
