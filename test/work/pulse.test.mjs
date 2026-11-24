// Progress (src/work/pulse.mjs): read from the files, never told. A made-up home with a history: twelve finished runs
// of three kinds, four running, one finished that waits for his look, one failed, a session that waits for his
// answer and a workflow with steps. Every number the progress gives is checked against the files by the test itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';
import { makeHistory } from './pulsehome.mjs';

const t = tempWork('work-pulse');
test.after(() => t.cleanup());
const { lineOf, progress, progressLines, shortWords, workUnits } = await import('../../src/work/pulse.mjs');
const { NO_ESTIMATE, basisOf, durationText } = await import('../../src/work/estimate.mjs');
const { transcriptTokens } = await import('../../src/work/pulsefiles.mjs');

const history = await makeHistory(t);
const { place, NOW, H, M, day, code, mech, night, lone, running, looks, failed, items } = history;

const read = async () => {
  const w = await workUnits({ place, cfg: {} });
  return progress({ ...w, items, now: NOW, tz: 'UTC', since: day(10) });
};
const range = (list) => ({ lo: Math.min(...list.map((r) => Date.parse(r.endedAt) - Date.parse(r.startedAt))), hi: Math.max(...list.map((r) => Date.parse(r.endedAt) - Date.parse(r.startedAt))) });
const round5 = (ms) => Math.round(ms / (5 * M)) * 5 * M;

test('the counts are the files\' own: what runs, what waits for him, what finished, what failed', async () => {
  const p = (await read());
  const files = fs.readdirSync(path.join(place.folder, 'runs')).map((f) => JSON.parse(fs.readFileSync(path.join(place.folder, 'runs', f), 'utf8')));
  assert.equal(files.length, 19);
  // Running: the four runs and the working session's workflow, which is that session's work: one piece, not two
  // (the dead record is left out).
  assert.equal(p.counts.running, files.filter((r) => r.state === 'running').length + 1);
  assert.equal(p.running.filter((u) => u.type === 'session').length, 0, 'the session that runs the workflow is not counted again');
  assert.equal(p.running.filter((u) => u.type === 'workflow').length, 1);
  // A session's title names its project already: it is not said twice.
  assert.equal(progressLines(p).some((l) => /A session in (\w+) \(\1\)/.test(l)), false);
  assert.deepEqual(p.running.filter((u) => u.type === 'run').map((u) => u.run).sort(), running.map((r) => r.id).sort());
  // Done: the finished runs, and the two "lane" workflows that finished in other conversations of the shop folder.
  assert.equal(p.counts.done, files.filter((r) => r.state === 'done').length + 2);
  assert.deepEqual(p.done.filter((u) => u.type === 'workflow').map((u) => [u.title, u.project]), [['lane', 'shop'], ['lane', 'shop']]);
  assert.equal(p.counts.failed, 1);
  assert.equal(p.failed[0].run, failed.id);
  // Waits for him: the finished run whose task is in review, and the session that asks him.
  assert.deepEqual(p.waiting.map((u) => u.why).sort(), ['answer', 'review']);
  assert.equal(p.waiting.find((u) => u.why === 'review').run, looks.id);
  assert.equal(p.waiting.find((u) => u.why === 'answer').waitsSince, new Date(NOW - 18 * M).toISOString());
  assert.equal(p.line, lineOf(p.counts));
  assert.equal(p.line, `${p.counts.running} running · 2 wait for you · ${p.counts.done} done · 1 failed`);
});

test('each estimate is the range of its own kind\'s finished runs, with their count; a kind with one has none', async () => {
  const p = (await read());
  const one = (id) => p.running.find((u) => u.run === id);
  for (const [r, list] of [[running[0], [...code, looks]], [running[1], mech], [running[2], night]]) {
    const u = one(r.id);
    const { lo, hi } = range(list);
    assert.equal(u.basis.count, list.length, r.title);
    assert.equal(u.basis.shortestMs, Math.max(5 * M, round5(lo)));
    assert.equal(u.basis.longestMs, Math.max(5 * M, round5(hi)));
    assert.equal(u.basis.text, `about ${durationText(round5(lo))} to ${durationText(round5(hi))}, from ${list.length} like it`);
  }
  assert.equal(one(running[2].id).basis.text, 'about 5 h 30 to 8 h 30, from 4 like it', 'the nightly schedule, in words');
  const nightU = one(running[2].id);
  assert.equal(nightU.eta.doneFrom, new Date(Date.parse(running[2].startedAt) + 5.5 * H).toISOString());
  assert.equal(nightU.eta.text, 'done by about 09:30 to 12:30');
  const b = one(running[3].id);
  assert.equal(b.basis.count, 1, 'beta has one finished run');
  assert.equal(b.basis.text, NO_ESTIMATE);
  assert.ok(lone);
  const wf = p.running.find((u) => u.type === 'workflow');
  assert.equal(wf.basis.text, 'about 50 min to 1 h 10, from 2 like it');
});

test('a workflow\'s steps, its last progress and its tokens are its record\'s', async () => {
  const wf = (await read()).running.find((u) => u.type === 'workflow');
  assert.equal(wf.title, 'lane');
  assert.deepEqual(wf.steps, { phases: 2, phase: 2, phaseTitle: 'review', agents: 4, done: 2, working: 2, failed: 0 });
  assert.equal(wf.lastAt, new Date(NOW - 7 * M).toISOString());
  assert.equal(wf.tokens, 123456);
  assert.equal(wf.startedAt, new Date(NOW - 40 * M).toISOString());
});

test('tokens: what the files report, "not reported" where they say nothing, never summed over a run that did not report', async () => {
  const p = (await read());
  const of = (r) => p.done.find((u) => u.run === r.id);
  assert.equal(of(night[0]).tokens, 3000);
  assert.equal(of(night[3]).tokens, null);
  assert.equal(of(night[3]).tokensText, 'not reported');
  assert.equal(of(code[0]).tokensText, 'not reported');
  assert.equal(of(night[2]).tokensText, '9,000 tokens');
  // The working session's transcript (its row is its workflow's now, so read the way its row reads it).
  assert.equal(await transcriptTokens(history.cwd, history.conv), 10 + 25 + 300 + 5 + 5 + 40, 'a message written twice counts once, with its last usage');
});

test('the failed one says why in the tool\'s own words, cut at 80 on a word', async () => {
  const f = (await read()).failed[0];
  assert.ok(f.reason.length <= 80, f.reason);
  // The product's lead-in is taken off before the cut: the 80 characters are the tool's own words.
  assert.ok(f.reason.startsWith('The tests in checkout failed because the payment stand-in did not answer'), f.reason);
  assert.ok(f.reason.endsWith('…'));
  assert.equal(shortWords('short'), 'short');
});

test('the lines say the same numbers', async () => {
  const p = (await read());
  const text = progressLines(p).join('\n');
  assert.ok(text.startsWith(p.line));
  for (const u of p.running) assert.ok(text.includes(u.basis.count < 2 ? NO_ESTIMATE : u.basis.text), u.title);
  assert.match(text, /Nightly \(alpha\): since 04:00; about 5 h 30 to 8 h 30, from 4 like it: done by about 09:30 to 12:30/);
  assert.match(text, /lane \(shop\): since 05:20, step 2 of 2, 2 of 4 agents done; about 50 min to 1 h 10, from 2 like it/);
});

test('done and failed count from `since`; a run of another project or schedule never counts for a kind', async () => {
  const w = await workUnits({ place, cfg: {} });
  const p = progress({ ...w, items, now: NOW, tz: 'UTC' });
  assert.equal(p.counts.done, 1, 'the last 24 hours: only the one that waits for his look');
  assert.equal(basisOf('schedule:other', w.finished).count, 0);
  assert.equal(basisOf('project:beta:code', w.finished).count, 1);
});

test('a workflow that finished or failed in the night is in done or failed, with its own end and tokens', async () => {
  const { projectDir } = await import('../../src/sessions.mjs');
  const { conv, cwd } = history;
  const dir = path.join(projectDir(cwd), conv, 'workflows');
  const wf = (id, status) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ taskId: id, workflowName: `night-${id}`, status, startTime: NOW - 6 * H, durationMs: 5 * H, totalTokens: 900000 }));
  wf('wf9', 'completed');
  wf('wf8', 'failed');
  wf('wf7', 'killed');
  try {
    const p = progress({ ...(await workUnits({ place, cfg: {} })), items, now: NOW, tz: 'UTC' });
    const done = p.done.find((u) => u.title === 'night-wf9');
    assert.ok(done, JSON.stringify(p.done.map((u) => u.title)));
    assert.equal(done.type, 'workflow');
    assert.equal(done.endedAt, new Date(NOW - H).toISOString());
    assert.equal(done.tokens, 900000);
    assert.deepEqual(p.failed.filter((u) => u.type === 'workflow').map((u) => [u.title, u.state]).sort(), [['night-wf7', 'stopped'], ['night-wf8', 'failed']]);
    assert.equal(p.running.filter((u) => u.type === 'workflow').length, 1, 'only the one that runs is running');
  } finally {
    for (const id of ['wf9', 'wf8', 'wf7']) fs.rmSync(path.join(dir, `${id}.json`));
  }
});

test('a workflow that finished or failed in the night is in done or failed after its session\'s process has ended too, once', async () => {
  const { projectDir } = await import('../../src/sessions.mjs');
  const { conv, cwd } = history;
  const dir = path.join(projectDir(cwd), conv, 'workflows');
  const wf = (id, status) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ taskId: id, workflowName: `gone-${id}`, status, startTime: NOW - 6 * H, durationMs: 5 * H, totalTokens: 900000 }));
  wf('wg9', 'completed');
  wf('wg8', 'failed');
  try {
    for (const [alive, how] of [[() => false, 'its process gone'], [undefined, 'its session still there']]) {
      const p = progress({ ...(await workUnits({ place, cfg: {}, ...(alive ? { alive } : {}) })), items, now: NOW, tz: 'UTC' });
      assert.equal(p.done.filter((u) => u.title === 'gone-wg9').length, 1, `${how}: ${JSON.stringify(p.done.map((u) => u.title))}`);
      assert.equal(p.done.find((u) => u.title === 'gone-wg9').project, 'shop');
      assert.deepEqual(p.failed.filter((u) => u.type === 'workflow').map((u) => u.title), ['gone-wg8'], how);
    }
  } finally {
    for (const id of ['wg9', 'wg8']) fs.rmSync(path.join(dir, `${id}.json`));
  }
});

test('a running Do it run and its chat\'s record are one piece of work, not two', async () => {
  const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
  const recs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  const chat = '99999999-8888-7777-6666-555555555555';
  const conv = '77777777-8888-7777-6666-555555555555';
  const before = progress({ ...(await workUnits({ place, cfg: {} })), items, now: NOW, tz: 'UTC' }).counts.running;
  const r = { v: 1, id: newRunId(new Date(NOW - 10 * M)), item: 'do-it-now', title: 'Do it now', writer: writerId(), by: 'owner', startedAt: new Date(NOW - 10 * M).toISOString(), endedAt: null,
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: chat, conversation: conv, message: null, brief: 'Do it',
    state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null };
  writeRun(place, r);
  // The record the chat writes for it (src/runs.mjs createChatRun).
  fs.writeFileSync(path.join(recs, 'x.json'), JSON.stringify({ runId: 'x', kind: 'chat', chat, pid: process.pid, cwd: history.cwd, sessionId: null, conversation: conv, status: 'working', startedAt: NOW - 10 * M, statusAt: NOW }));
  try {
    const p = progress({ ...(await workUnits({ place, cfg: {} })), items, now: NOW, tz: 'UTC' });
    assert.equal(p.counts.running, before + 1);
    assert.equal(p.running.filter((u) => u.type === 'session' && u.startedAt === new Date(NOW - 10 * M).toISOString()).length, 0);
    assert.ok(p.running.find((u) => u.run === r.id));
    assert.equal('chat' in JSON.parse(JSON.stringify(p.running.find((u) => u.run === r.id))), false, 'the chat id is not given out');
  } finally {
    fs.rmSync(path.join(recs, 'x.json'));
    fs.rmSync(path.join(place.folder, 'runs', `${r.id}.json`));
  }
});

test('a running Do it run whose chat asks for an OK: one running, and its question waits for him', async () => {
  const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
  const recs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  const chat = '99999999-8888-7777-6666-444444444444';
  const conv = '77777777-8888-7777-6666-444444444444';
  const before = progress({ ...(await workUnits({ place, cfg: {} })), items, now: NOW, tz: 'UTC' }).counts;
  const r = { v: 1, id: newRunId(new Date(NOW - 10 * M)), item: 'needs-an-ok', title: 'Needs an OK', writer: writerId(), by: 'owner', startedAt: new Date(NOW - 10 * M).toISOString(), endedAt: null,
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: chat, conversation: conv, message: null, brief: 'Do it',
    state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null };
  writeRun(place, r);
  // The chat's record as the hook leaves it when the coding tool asks for an OK (src/hook.mjs: 'attention', askAt).
  fs.writeFileSync(path.join(recs, 'y.json'), JSON.stringify({ runId: 'y', kind: 'chat', chat, pid: process.pid, cwd: history.cwd, sessionId: conv, conversation: conv, status: 'attention', startedAt: NOW - 10 * M, statusAt: NOW - 3 * M, askAt: NOW - 3 * M }));
  try {
    const p = progress({ ...(await workUnits({ place, cfg: {} })), items, now: NOW, tz: 'UTC' });
    assert.equal(p.counts.running, before.running + 1, 'the run, once');
    assert.equal(p.counts.waiting, before.waiting + 1, 'its question waits for him');
    const w = p.waiting.find((u) => u.run === r.id);
    assert.ok(w, JSON.stringify(p.waiting.map((u) => u.title)));
    assert.equal(w.why, 'answer');
    assert.equal(w.item, 'needs-an-ok');
    assert.equal(w.waitsSince, new Date(NOW - 3 * M).toISOString());
    // The task's own progress (its runs sheet, `tasks progress <task>`) has it too.
    const { readProgress } = await import('../../src/work/pulse.mjs');
    const one = await readProgress({ cfg: {}, place, items, now: NOW, item: 'needs-an-ok' });
    assert.deepEqual([one.counts.running, one.counts.waiting], [1, 1]);
  } finally {
    fs.rmSync(path.join(recs, 'y.json'));
    fs.rmSync(path.join(place.folder, 'runs', `${r.id}.json`));
  }
});

test('the workflows of a running Do it run\'s conversation: a finished one is in done, the running one is the run\'s steps', async () => {
  const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  const recs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  const chat = '99999999-8888-7777-6666-333333333333';
  const conv = '77777777-8888-7777-6666-333333333333';
  const before = progress({ ...(await workUnits({ place, cfg: {} })), items, now: NOW, tz: 'UTC' }).counts;
  const r = { v: 1, id: newRunId(new Date(NOW - H)), item: 'with-workflows', title: 'With workflows', writer: writerId(), by: 'owner', startedAt: new Date(NOW - H).toISOString(), endedAt: null,
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: chat, conversation: conv, message: null, brief: 'Do it',
    state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null };
  writeRun(place, r);
  fs.writeFileSync(path.join(recs, 'z.json'), JSON.stringify({ runId: 'z', kind: 'chat', chat, pid: process.pid, cwd: history.cwd, sessionId: conv, conversation: conv, status: 'working', startedAt: NOW - H, statusAt: NOW - M }));
  const dir = path.join(projectDir(history.cwd), conv, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'e1.json'), JSON.stringify({ taskId: 'e1', workflowName: 'early-part', status: 'completed', startTime: NOW - 50 * M, durationMs: 20 * M, totalTokens: 500 }));
  fs.writeFileSync(path.join(dir, 'e2.json'), JSON.stringify({ taskId: 'e2', workflowName: 'late-part', status: 'running', startTime: NOW - 20 * M,
    workflowProgress: [{ type: 'workflow_phase', index: 0, title: 'build' }, { type: 'workflow_agent', index: 0, phaseIndex: 0, state: 'done' }, { type: 'workflow_agent', index: 1, phaseIndex: 0, state: 'progress' }] }));
  try {
    const p = progress({ ...(await workUnits({ place, cfg: {} })), items, now: NOW, tz: 'UTC' });
    assert.equal(p.counts.running, before.running + 1, 'the run, once: its running workflow is not a second piece');
    assert.ok(p.done.find((u) => u.type === 'workflow' && u.title === 'early-part'), JSON.stringify(p.done.map((u) => u.title)));
    const run = p.running.find((u) => u.run === r.id);
    assert.deepEqual([run.steps.agents, run.steps.done], [2, 1], 'the run shows its workflow\'s steps');
    assert.match(progressLines(p).join('\n'), /With workflows \(shop\): since 05:00, step 1 of 1, 1 of 2 agents done/);
  } finally {
    fs.rmSync(path.join(recs, 'z.json'));
    fs.rmSync(path.join(projectDir(history.cwd), conv), { recursive: true });
    fs.rmSync(path.join(place.folder, 'runs', `${r.id}.json`));
  }
});

test('two sessions in one folder: its finished workflows are the basis once', async () => {
  const recs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.writeFileSync(path.join(recs, 'd.json'), JSON.stringify({ runId: 'd', pid: process.pid, cwd: history.cwd, sessionId: 'aaaaaaaa-2222-3333-4444-555555555555', status: 'working', startedAt: NOW - 50 * M, statusAt: NOW - M }));
  try {
    const w = await workUnits({ place, cfg: {} });
    assert.equal(w.finished.filter((f) => f.kind === 'workflow:lane').length, 2, 'the two finished "lane" workflows, once each');
    const wf = progress({ ...w, items, now: NOW, tz: 'UTC' }).running.find((u) => u.type === 'workflow');
    assert.equal(wf.basis.text, 'about 50 min to 1 h 10, from 2 like it');
  } finally {
    fs.rmSync(path.join(recs, 'd.json'));
  }
});

test('what waits for his look does not depend on `since`: a task still in review waits a day later too', async () => {
  const w = await workUnits({ place, cfg: {} });
  for (const [now, since] of [[NOW, NOW - 2 * H], [NOW + 25 * H, undefined]]) {
    const p = progress({ ...w, items, now, tz: 'UTC', ...(since ? { since } : {}) });
    assert.deepEqual(p.waiting.map((u) => u.why).sort(), ['answer', 'review'], new Date(now).toISOString());
    assert.equal(p.waiting.find((u) => u.why === 'review').run, looks.id);
    assert.equal(p.done.some((u) => u.run === looks.id), false, 'the done list keeps to since');
  }
});

test('who did what on a Work run: its helpers\' records read through workUnits, handed on by the runs route', async () => {
  const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  const { partsByRun } = await import('../../src/work/pulse.mjs');
  const { doRoutes } = await import('../../src/work/dofeature.mjs');
  const conv = '66666666-8888-7777-6666-555555555555';
  const r = { v: 1, id: newRunId(new Date(NOW - 30 * M)), item: 'with-helpers', title: 'With helpers', writer: writerId(), by: 'owner', startedAt: new Date(NOW - 30 * M).toISOString(), endedAt: new Date(NOW - 5 * M).toISOString(),
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'claude-sonnet-5-5', effort: 'medium', session: null, conversation: conv, message: null, brief: 'Do it',
    state: 'done', reason: null, answer: 'Done.', commits: [], changed: [], more: 0, was: 'open', statusError: null };
  writeRun(place, r);
  const sub = path.join(projectDir(fs.realpathSync(history.cwd)), conv, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const line = (agent, id, model, i, o) => JSON.stringify({ type: 'assistant', attributionAgent: agent, isSidechain: true, message: { id, model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'done' }] } });
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), `${line('hoprig-runner', 'h1', 'claude-haiku-5-5', 100, 20)}\n`);
  fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), `${line('hoprig-coder', 'h2', 'claude-sonnet-5-5', 300, 90)}\n`);
  try {
    const w = await workUnits({ place, cfg: {} });
    const u = w.units.find((x) => x.run === r.id);
    assert.ok(u && u.parts, 'the run has its parts');
    assert.deepEqual(u.parts.tiers.map((t) => [t.tier, t.parts, t.tokens, t.models]), [['fast', 1, 120, ['claude-haiku-5-5']], ['strong', 1, 390, ['claude-sonnet-5-5']]]);
    assert.equal(w.units.find((x) => x.run === running.id)?.parts, undefined, 'a run without helpers has none');
    // The runs route (Activity, a task's runs) takes them from the same reader.
    const route = doRoutes({ runs: { list: () => [{ id: r.id }, { id: 'other' }] }, readJson: async () => ({}), refOf: () => null, ownerOnly: () => {}, resume: async () => {}, partsByRun: () => partsByRun({ place, cfg: {} }) })
      .find(([m, re]) => m === 'GET' && re.test('/api/work/runs'));
    const got = await route[2]({}, [], new URLSearchParams());
    assert.equal(got.runs[0].parts.tiers.length, 2);
    assert.equal(got.runs[1].parts, undefined);
  } finally {
    fs.rmSync(path.join(projectDir(fs.realpathSync(history.cwd)), conv), { recursive: true, force: true });
    fs.rmSync(path.join(place.folder, 'runs', `${r.id}.json`));
  }
});
