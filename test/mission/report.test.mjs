// The report, the Team numbers and the morning brief are the sums of the runs in the missions' files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { missionReport, morningBrief, teamView, testsWhere } from '../../src/mission/report.mjs';

const run = (kind, cost, tokens, minutes, day = '2026-11-18') => ({ id: '20261118-100000-00000000', kind, provider: 'key', state: 'done', cost, tokens, minutes, day });
const task = (id, role, state, firstPass, runs, why = null) => ({ id, title: `Task ${id}`, role, state, why, branch: `work/${id}`, firstPass, runs });
const m = {
  id: 'm-20261118-abcdef', goal: 'Make the shop clearer', project: 'shop', state: 'waits', why: null, createdAt: '2026-11-18T08:00:00Z', endedAt: null,
  tasks: [
    task('a', 'writer', 'done', true, [run('work', 0.02, 1000, 2), run('review', 0.01, 500, 1)]),
    task('b', 'developer', 'review', false, [run('work', 0.1, 4000, 5), run('review', 0.01, 500, 1), run('fix', 0.05, 2000, 3), run('review', 0.01, 500, 1)]),
    task('c', 'developer', 'failed', false, [run('work', null, 3000, 4, '2026-11-17')], 'its gate failed twice'),
  ],
};

test('a mission\'s report: each task\'s three numbers and the sums of its runs', () => {
  const r = missionReport(m);
  assert.deepEqual(r.tasks.map((t) => [t.tokens, t.minutes, t.firstPass]), [[1500, 3, true], [7000, 10, false], [3000, 4, false]]);
  assert.equal(r.total.tokens, 11500);
  assert.equal(r.total.minutes, 17);
  assert.equal(r.total.cost, 0.2);
  assert.equal(r.total.costUnknown, 1);
  assert.equal(r.total.passedFirst, 1);
  assert.deepEqual(r.counts, { done: 1, waits: 1, failed: 1, open: 0, dropped: 0, stopped: 0 });
  assert.match(r.lines.join(' '), /Waits for you: "Task b"\..*Failed: "Task c" \(its gate failed twice\)/);
});

test('the Team tab per role: tasks, passed first time, and the reviewer\'s own runs counted for the reviewer', () => {
  const team = Object.fromEntries(teamView([m], ['ops']).map((x) => [x.role, x]));
  assert.equal(team.ops.on, false);
  assert.deepEqual([team.developer.tasks, team.developer.passedFirst, team.developer.tokens, team.developer.runs], [2, 0, 9000, 3]);
  assert.deepEqual([team.writer.tasks, team.writer.passedFirst, team.writer.cost], [1, 1, 0.02]);
  assert.deepEqual([team.reviewer.tasks, team.reviewer.runs, team.reviewer.tokens, team.reviewer.cost], [2, 3, 1500, 0.03]);
  assert.equal(team.developer.costUnknown, 1);
});

test('the morning brief: finished and waits since yesterday, and that cost; a task that failed before "from" is not re-listed', () => {
  const b = morningBrief([m], { from: '2026-11-18' });
  // Task c failed, but its last run was on the 17th (before "from"): it is not listed again, as finished is not.
  assert.deepEqual([b.finished.length, b.waits.length, b.failed.length], [1, 1, 0]);
  assert.equal(b.cost, 0.2);
  assert.equal(b.tokens, 8500, 'the run of the 17th is not counted');
  assert.equal(b.costUnknown, 0);
  assert.equal(b.lines[0], 'Finished: 1 task.');
});

test('a task that failed since yesterday is in the brief with its why; one that failed weeks ago is not, and does not keep the brief shown', () => {
  const recent = { ...m, id: 'm-20261118-cccccc', tasks: [task('r', 'developer', 'failed', false, [run('work', null, 100, 1, '2026-11-18')], 'its gate failed twice')] };
  const bRecent = morningBrief([recent], { from: '2026-11-18' });
  assert.deepEqual(bRecent.failed.map((x) => [x.title, x.why]), [['Task r', 'its gate failed twice']]);
  assert.match(bRecent.lines.join(' '), /Failed: 1: "Task r" \(its gate failed twice\)/);
  assert.equal(bRecent.shown, true);
  const old = { ...m, id: 'm-20261001-ffffff', state: 'failed', createdAt: '2026-10-01T08:00:00Z', endedAt: '2026-10-01T09:00:00Z', tasks: [task('of', 'developer', 'failed', false, [run('work', null, 100, 1, '2026-10-01')], 'its gate failed twice')] };
  const bOld = morningBrief([old], { from: '2026-11-18' });
  assert.equal(bOld.failed.length, 0, 'a task that failed six weeks ago is not news again');
  assert.equal(bOld.shown, false, 'an old failure alone does not keep the morning brief shown');
});

test('the morning brief counts a task once, also when two missions\' files hold it', () => {
  const again = { ...m, id: 'm-20261118-abcdee', tasks: [m.tasks[1]] };
  const b = morningBrief([m, again], { from: '2026-11-18' });
  assert.equal(b.waits.length, 1);
  assert.match(b.lines.join(' '), /Waits for you: 1\./);
});

test('the morning brief: only what was finished since yesterday; a failed planning of today is under Failed with its why', () => {
  const old = { ...m, id: 'm-20261001-aaaaaa', tasks: [task('o', 'writer', 'done', true, [run('work', 0.02, 1000, 2, '2026-10-01')])] };
  const planning = { id: 'm-20261118-bbbbbb', goal: 'Add a newsletter', project: 'shop', state: 'failed', why: 'Planning failed: the session ended without a plan', createdAt: '2026-11-18T08:00:00Z', endedAt: '2026-11-18T08:05:00Z', tasks: [] };
  const b = morningBrief([old, planning], { from: '2026-11-18' });
  assert.equal(b.finished.length, 0, 'a task finished six weeks ago is not news');
  assert.equal(b.lines[0], 'Nothing was finished.');
  assert.deepEqual(b.failed.map((x) => x.title), ['Add a newsletter']);
  assert.match(b.lines.join(' '), /Failed: 1: "Add a newsletter" \(Planning failed: the session ended without a plan\)/);
  assert.equal(b.shown, true);
  assert.equal(morningBrief([old], { from: '2026-11-18' }).shown, false, 'only old news: no brief');
});

test('a mission\'s cost is said once, as numbers; the brief writes dollars as the page does', () => {
  const r = missionReport(m);
  assert.ok(!r.lines.some((l) => /^Cost /.test(l)), r.lines.join(' | '));
  const small = { ...m, tasks: [task('s', 'writer', 'done', true, [run('work', 0.0053, 100, 1)])] };
  assert.match(morningBrief([small], { from: '2026-11-18' }).lines.join(' '), /It cost \$0\.0053, 100 tokens\./);
});

test('the sums are rounded once, at the end: they are the sums of the runs', () => {
  const runs = [0.0097256, 0.014831, 0.0123304].map((c, i) => ({ ...run('work', c, 1000, 1), id: `20261119-06000${i}-0000000${i}` }));
  const r = missionReport({ ...m, tasks: runs.map((x, i) => task(`t${i}`, 'developer', 'review', null, [x])) });
  assert.equal(r.total.cost, 0.0369, 'not 0.0368, the sum of each task rounded first');
});

test('the report says per task whether its tests ran in the box, by his own run outside it, or not at all', () => {
  const g = (gate) => ({ ...task('x', 'developer', 'review', true, []), gate });
  assert.equal(testsWhere(g({ ok: true, words: [], boxed: true })), 'box');
  assert.equal(testsWhere(g({ ok: true, words: [], testsNotRun: true })), 'not-run');
  assert.equal(testsWhere(g({ ok: true, words: [], testsNotRun: true, here: { ok: true, boxed: true } })), 'box');
  assert.equal(testsWhere(g({ ok: true, words: [], testsNotRun: true, here: { ok: true } })), 'here');
  assert.equal(testsWhere(g({ ok: true, words: ['the named files are written'] })), null, 'a check that runs no tests');
  assert.equal(testsWhere(g(null)), null);
  const r = missionReport({ ...m, tasks: [
    { ...task('p', 'developer', 'review', true, []), gate: { ok: true, words: [], boxed: true } },
    { ...task('q', 'tester', 'review', true, []), gate: { ok: true, words: [], testsNotRun: true } },
    { ...task('w', 'writer', 'done', true, []), gate: { ok: true, words: [] } },
  ] });
  assert.deepEqual(r.tasks.map((t) => t.tests), ['box', 'not-run', null]);
  assert.ok(r.lines.includes('Tests passed in the box: "Task p".'), r.lines.join(' | '));
  assert.ok(r.lines.includes('Tests not run: "Task q".'), r.lines.join(' | '));
});

test('the report says whether each task\'s tests passed, failed or were stopped, grouped by that', () => {
  const g = (id, gate) => ({ ...task(id, 'tester', 'review', true, []), gate });
  const r = missionReport({ ...m, tasks: [
    g('a', { ok: true, words: [], boxed: true, tests: { result: 'passed' } }),
    g('b', { ok: false, words: [], boxed: true, tests: { result: 'failed' } }),
    g('c', { ok: false, words: [], boxed: true, tests: { result: 'timeout', limit: '10 minutes' } }),
    g('d', { ok: true, words: [], boxed: true, tests: { result: 'passed' } }),
    g('e', { ok: true, words: [], testsNotRun: true, here: { ok: false, code: 1, boxed: false } }),
    g('f', { ok: true, words: [], testsNotRun: true, here: { ok: false, code: null, boxed: true, timedOut: true } }),
    g('o', { ok: false, words: [], boxed: true }), // a gate kept before it said its result
  ] });
  assert.deepEqual(r.tasks.map((t) => t.testsResult), ['box-passed', 'box-failed', 'box-timeout', 'box-passed', 'here-failed', 'box-timeout', 'box-failed']);
  const tests = r.lines.filter((l) => l.startsWith('Tests'));
  assert.deepEqual(tests, [
    'Tests passed in the box: "Task a", "Task d".',
    'Tests failed in the box: "Task b", "Task o".',
    'Tests stopped in the box, too slow: "Task c", "Task f".',
    'Tests you ran outside the box failed: "Task e".',
  ]);
});
