// The session log of Work's one history (src/work/sessionlog.mjs): one line at a session's start and one at its end,
// with the project's name only, who started it (Tia's mark read before it goes), the provider and how it ended; never
// a full path. Trimmed at its cap; a write that fails never throws.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('history-sessionlog');
test.after(() => t.cleanup());
const shop = path.join(t.projects, 'shop');
fs.mkdirSync(path.join(shop, 'code', 'web'), { recursive: true });
const outside = path.join(t.home, 'elsewhere');
fs.mkdirSync(outside, { recursive: true });

const { noteStart, noteEnd, readLines, readSessions, logFile, LOG_MAX } = await import('../../src/work/sessionlog.mjs');
const { markHers } = await import('../../src/hermark.mjs');
const runs = await import('../../src/runs.mjs');
const { runsDir } = await import('../../src/paths.mjs');

const recordOf = (runId, extra = {}) => ({ runId, profile: 'max', cwd: path.join(shop, 'code', 'web'), tool: 'claude', startedAt: Date.parse('2026-11-20T10:00:00Z'), ...extra });
const fileOf = (runId) => path.join(runsDir(), `${runId}.json`);

test('a start and an end: the project by name, who, the provider and how it ended; no full path', () => {
  fs.rmSync(logFile(), { force: true });
  const at = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(noteStart(fileOf('aa-1'), recordOf('aa-1'), { now: at }), true);
  markHers(fileOf('bb-2'));
  noteStart(fileOf('bb-2'), recordOf('bb-2', { profile: 'team', cwd: outside }), { now: at + 1000 });
  noteEnd(fileOf('aa-1'), recordOf('aa-1', { limit: { at: 'x' }, title: 'Fix the cart total' }), { now: at + 60_000 });
  noteEnd(fileOf('bb-2'), recordOf('bb-2', { profile: 'team', cwd: outside, failure: { at: 'y' } }), { now: at + 120_000 });
  const text = fs.readFileSync(logFile(), 'utf8');
  assert.ok(!text.includes(t.root), 'no full path in the log');
  assert.ok(!text.includes(t.home));
  const s = readSessions({ now: at + 200_000 });
  assert.deepEqual(s.map((x) => [x.id, x.who, x.project, x.provider, x.end]), [['bb-2', 'tia', null, 'team', 'failed'], ['aa-1', 'owner', 'shop', 'max', 'limit']]);
  assert.equal(s[1].title, 'Fix the cart total');
  assert.equal(s[1].startedAt, '2026-11-20T10:00:00.000Z');
  assert.equal(s[1].endedAt, new Date(at + 60_000).toISOString());
});

test('the run records call the log: a terminal session started and ended through createRun and removeRun', () => {
  fs.rmSync(logFile(), { force: true });
  const cwd = process.cwd();
  process.chdir(shop);
  try {
    const { file } = runs.createRun({ profile: 'max', cwd: shop });
    markHers(file);
    runs.removeRun(file);
  } finally {
    process.chdir(cwd);
  }
  const l = readLines();
  assert.deepEqual(l.map((x) => [x.ev, x.project, x.provider]), [['start', 'shop', 'max'], ['end', 'shop', 'max']]);
  assert.equal(l[1].who, 'tia', 'her mark is read before removeRun takes it away');
  assert.equal(l[0].who, 'owner', 'the mark came after the start');
});

test('a chat\'s processes are one App session', () => {
  fs.rmSync(logFile(), { force: true });
  const at = Date.parse('2026-11-21T08:00:00Z');
  noteEnd(fileOf('c-1'), { runId: 'c-1', kind: 'chat', chat: 'chat42', profile: 'max', cwd: shop, tool: 'claude', startedAt: at }, { now: at + 1000 });
  noteEnd(fileOf('c-2'), { runId: 'c-2', kind: 'chat', chat: 'chat42', profile: 'api', cwd: shop, tool: 'claude', startedAt: at + 5000 }, { now: at + 9000 });
  const s = readSessions({ now: at + 10_000 });
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].kind, s[0].id, s[0].provider, s[0].providers, s[0].startedAt], ['chat', 'chat42', 'api', ['max', 'api'], new Date(at).toISOString()]);
});

test('trimmed at its cap and to 30 days, the newest kept', () => {
  fs.rmSync(logFile(), { force: true });
  const at = Date.parse('2026-11-22T00:00:00Z');
  noteStart(fileOf('old-1'), recordOf('old-1'), { now: at - 31 * 24 * 3_600_000 });
  const max = 4096;
  for (let i = 0; i < 60; i++) noteStart(fileOf(`r-${i}`), recordOf(`r-${i}`), { now: at + i, max });
  assert.ok(fs.statSync(logFile()).size <= max, 'never above the cap');
  const ids = readLines().map((x) => x.id);
  assert.ok(!ids.includes('old-1'), 'older than 30 days: gone');
  assert.equal(ids[ids.length - 1], 'r-59', 'the newest is kept');
  assert.ok(ids.length < 60);
  assert.ok(LOG_MAX >= 64 * 1024);
});

test('a write that fails does not throw', () => {
  const to = path.join(t.root, 'a-file');
  fs.writeFileSync(to, 'x');
  assert.equal(noteStart(fileOf('x-1'), recordOf('x-1'), { to: path.join(to, 'sessions.jsonl') }), false);
  assert.equal(noteEnd(fileOf('x-1'), null), false);
  assert.doesNotThrow(() => noteEnd(fileOf('x-1'), { get runId() { throw new Error('bad'); } }));
});
