// A progress read on a large store (src/work/pulse.mjs workUnits, src/work/pulsefiles.mjs): the workflow records are
// taken newest first, one written before the earliest time asked for is not read, at most 300 a folder are parsed,
// what was parsed is kept for the next look, and the server's one thread comes back between small pieces. Counted,
// not timed (a busy machine cannot make it pass or fail): how many records were parsed and how many file calls ran
// between two turns of the thread. 8 projects of 300 records of 200 agents each (a reviewer's numbers).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-pulsepieces');
test.after(() => t.cleanup());
const { workUnits, progress } = await import('../../src/work/pulse.mjs');
const { projectDir } = await import('../../src/sessions.mjs');

const H = 3_600_000;
const NOW = Date.now();
const agents = Array.from({ length: 200 }, (_, i) => ({ type: 'workflow_agent', index: i, phaseIndex: 0, state: 'done' }));
let n = 0;
/** A finished workflow record in project `p`, written `ageH` hours ago (its file's time too). */
function record(p, ageH, name = 'wf') {
  n += 1;
  const conv = `c${String(n).padStart(7, '0')}-1111-2222-3333-444444444444`;
  const d = path.join(projectDir(path.join(t.projects, p)), conv, 'workflows');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `w${n}.json`);
  fs.writeFileSync(f, JSON.stringify({ taskId: `w${n}`, workflowName: name, status: 'completed', startTime: NOW - ageH * H - H, durationMs: H, totalTokens: 1, workflowProgress: agents }));
  const at = new Date(NOW - ageH * H);
  fs.utimesSync(f, at, at);
}
const PROJECTS = Array.from({ length: 8 }, (_, i) => `proj${i}`);
for (const p of PROJECTS) {
  fs.mkdirSync(path.join(t.projects, p), { recursive: true });
  for (let r = 0; r < 300; r++) record(p, 3);
}

/** One look, watched: the turns of the thread, and the most records parsed and file calls made between two turns. */
async function look(o = {}) {
  const calls = { now: 0, most: 0 };
  const names = ['readdirSync', 'lstatSync', 'readFileSync', 'readSync', 'statSync', 'openSync'];
  const had = Object.fromEntries(names.map((k) => [k, fs[k]]));
  let parsedAll = 0;
  const WF = `${path.sep}workflows${path.sep}`;
  for (const k of names) fs[k] = function (...a) { calls.now += 1; if (k === 'readFileSync' && String(a[0]).includes(WF)) parsedAll += 1; return had[k].apply(this, a); };
  let mark = 0;
  let mostParsed = 0;
  let turns = 0;
  let going = true;
  const tick = () => {
    if (!going) return;
    mostParsed = Math.max(mostParsed, parsedAll - mark);
    mark = parsedAll;
    calls.most = Math.max(calls.most, calls.now);
    calls.now = 0;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    const w = await workUnits({ cfg: {}, alive: () => false, since: NOW - 7 * 24 * H, ...o });
    going = false;
    mostParsed = Math.max(mostParsed, parsedAll - mark);
    calls.most = Math.max(calls.most, calls.now);
    return { w, turns, parsed: parsedAll, mostParsed, mostCalls: calls.most };
  } finally {
    Object.assign(fs, had);
  }
}

test('a first look over 8 projects of 300 records parses each once, in pieces: the thread comes back between them', async () => {
  const r = await look();
  assert.equal(r.w.units.filter((u) => u.type === 'workflow').length, 2400, 'each folder\'s 300 newest ended workflows are listed');
  assert.ok(r.parsed >= 2400 && r.parsed <= 2400 + 50, `${r.parsed} parsed`);
  assert.ok(r.turns >= r.parsed / 10, `the thread came back ${r.turns} times for ${r.parsed} records (at once: 0 or 1)`);
  assert.ok(r.mostParsed <= 8, `at most 8 records parsed between two turns, not ${r.mostParsed}`);
  assert.ok(r.mostCalls <= 260, `at most 260 file calls between two turns, not ${r.mostCalls}`);
});

test('the next look parses nothing again: what was parsed is kept, also past 2000 records', async () => {
  const r = await look();
  assert.equal(r.parsed, 0, `${r.parsed} parsed again`);
  assert.ok(r.mostCalls <= 260, `at most 260 file calls between two turns, not ${r.mostCalls}`);
});

test('a record written before the earliest time asked for is not read at all', async () => {
  for (let r = 0; r < 50; r++) record('proj0', 10 * 24, 'old');
  const r = await look();
  assert.equal(r.parsed, 0, `none of the 50 old records was read (${r.parsed})`);
  assert.equal(r.w.units.some((u) => u.title === 'old'), false);
});

test('newest first: past 300 records in a folder, the ones that ended last night are there, with no live session', async () => {
  for (let r = 0; r < 5; r++) record('proj1', 1, `night-${r}`);
  const r = await look();
  const p = progress({ ...r.w, items: [], now: NOW, tz: 'UTC', since: NOW - 6 * H });
  for (let i = 0; i < 5; i++) assert.ok(p.done.some((u) => u.title === `night-${i}`), `night-${i} is in done`);
});

test('progress over 2400 units makes no number formatter per unit (one stretch of the thread stays short)', async () => {
  const w = await workUnits({ cfg: {}, alive: () => false, since: NOW - 7 * 24 * H });
  assert.ok(w.units.length >= 2400, String(w.units.length));
  const had = Number.prototype.toLocaleString;
  let calls = 0;
  Number.prototype.toLocaleString = function (...a) { calls += 1; return had.apply(this, a); };
  try {
    const p = progress({ ...w, items: [], now: NOW, tz: 'UTC', since: NOW - 24 * H });
    assert.ok(p.done.length >= 2400);
    assert.equal(p.done[0].tokensText, '1 tokens');
  } finally {
    Number.prototype.toLocaleString = had;
  }
  assert.equal(calls, 0, `${calls} formatters made for one read`);
});
