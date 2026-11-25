// The rules that keep a mission inside what the owner allowed: off by default twice (a whole-home snapshot over a start
// and three ticks: nothing written, started or called), "Tia OFF" half way, a restart in the middle, a task claimed by
// another dashboard, a task that came from another program's token, and a switch turned off while a start is checked.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome, standInBox } from './helpers.mjs';

const t = missionHome('mission-rules');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore, readDoc, changeDoc } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId } = await import('../../src/work/runs.mjs');
const { system: procIdent } = await import('../../src/procid.mjs');
const { missionEngine } = await import('../../src/mission/engine.mjs');
const { readMission, writeMission } = await import('../../src/mission/file.mjs');
const { withLock } = await import('../../src/work/lock.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.repo(path.join(t.projects, 'blog'), { 'README.md': '# blog\n' });
t.arm();
const OK = [process.execPath, '-e', 'process.exit(0)'];
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' }, missions: {} };
saveConfig(cfg);
const ON = { on: true, projects: { shop: { on: true, test: OK } }, capUsd: 5, providers: ['key'], atOnce: 1 };
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const toolLog = path.join(t.root, 'tool.log');
process.env.FAKE_TOOL_LOG = toolLog;
process.env.FAKE_VERDICTS = path.join(t.root, 'verdicts');
const calls = () => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600, killGraceMs: 200 });
let planned = 0;
const planner = {
  async start(c) {
    planned += 1;
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
};
const engines = [];
let days = 0;
/** An engine on a day of its own (the clock moved on by whole days): one test's spend is never another's. */
const engineOf = (day = ++days) => {
  const now = () => new Date(Date.now() + day * 86_400_000);
  const e = missionEngine({ config: () => cfg, runner, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 2, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'), tickMs: 3_600_000, now });
  e.day = day;
  e.today = () => now().toISOString().slice(0, 10);
  engines.push(e);
  return e;
};
test.after(async () => {
  for (const e of engines) await e.close();
  await runner.close();
});

/** Every file under the temporary computer with its bytes' hash: what a look wrote anywhere shows. */
function snapshot() {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(t.root, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(t.root);
  return out;
}
async function mission(e, goal, tasks) {
  const g = await e.give({ goal, project: 'shop' });
  assert.equal(g.plain, false, g.why);
  const ids = [];
  for (const x of tasks) ids.push((await store().add({ title: x.title, project: 'shop', by: x.by || 'writer', note: x.note })).item.id);
  await e.accepts.after(g.proposal.id, { plan: 'a-plan', tasks: ids });
  return { id: g.mission.id, ids };
}
/** Until no run of the shared runner works any more (a test that stopped a mission lets what runs end first). */
async function quiet() {
  for (let i = 0; i < 300 && runner.running().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(runner.running(), [], 'nothing runs any more');
}
async function until(e, id, test0, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    await e.tick();
    const m = readMission(place(), id);
    if (test0(m) || Date.now() > end) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('off by default, twice: a goal is a plain proposal; a start and three ticks write, start and call nothing', async () => {
  const e = engineOf();
  const g = await e.give({ goal: 'Make the shop faster', project: 'shop' });
  assert.equal(g.plain, true, 'Tia OFF by default: the goal is his plan to accept');
  assert.equal(planned, 1);
  cfg.missions = { on: true, projects: {} };
  const g2 = await e.give({ goal: 'Make the shop faster', project: 'shop' });
  assert.equal(g2.plain, true, 'the project\'s switch is off by default');
  cfg.missions = {};
  const before = snapshot();
  e.begin();
  for (let i = 0; i < 3; i++) await e.tick();
  assert.deepEqual(snapshot(), before, 'nothing was written anywhere');
  assert.deepEqual(calls(), [], 'no coding tool was started');
  assert.deepEqual(e.running(), []);
  assert.equal(t.trapped(), '');
});

test('Tia OFF half way: what runs goes to its end and no further, nothing new starts, one line says where it stands', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  const { id, ids } = await mission(e, 'Three notes', [
    { title: 'Note one', note: 'DO:slow\nFiles: one.md' }, { title: 'Note two', note: 'Files: two.md' }, { title: 'Note three', note: 'Files: three.md' },
  ]);
  await e.tick();
  const first = readMission(place(), id).tasks.find((x) => x.state === 'running');
  assert.ok(first, 'the first task started');
  for (let i = 0; i < 100 && !calls().length; i++) await new Promise((r) => setTimeout(r, 50)); // its tool has begun
  cfg.missions.on = false; // the press
  await e.off();
  const n = calls().length;
  const m = await until(e, id, (x) => !x.tasks.some((y) => y.state === 'running'));
  for (let i = 0; i < 3; i++) await e.tick();
  const after = readMission(place(), id);
  assert.equal(calls().length, n, 'not even the review of the one that ended started');
  assert.equal(after.tasks.find((x) => x.id === first.id).runs.length, 1, 'it ran to its end');
  assert.ok(after.tasks.filter((x) => x.id !== first.id).every((x) => x.state === 'queued' && !x.runs.length), 'nothing new started');
  assert.match(after.why, /^Tia OFF: nothing new starts/);
  assert.ok(after.line.some((l) => /Tia OFF: nothing new starts; 1 session runs to the end and goes no further/.test(l.words)));
  assert.equal(m.state, 'running');
  assert.equal(ids.length, 3);
  await e.stop(id);
});

test('Tia OFF with "stop what runs": the running session is stopped and said so', async () => {
  cfg.missions = { ...structuredClone(ON), offStops: true };
  const e = engineOf();
  const { id } = await mission(e, 'One hanging note', [{ title: 'Hanging note', note: 'DO:hang' }]);
  await e.tick();
  assert.equal(readMission(place(), id).tasks[0].state, 'running');
  cfg.missions.on = false;
  await e.off();
  const m = await until(e, id, (x) => x.tasks[0].state !== 'running');
  assert.equal(m.tasks[0].state, 'stopped');
  assert.equal(m.tasks[0].runs[0].state, 'stopped');
  assert.ok(m.tasks[0].runs[0].budget > 0, 'a stopped run keeps the budget it held: it counts against the cap at that');
  assert.equal(m.tasks[0].restarts, 0, 'a session stopped by OFF is not started again');
  assert.equal(m.state, 'stopped', 'stopped by Tia OFF is "stopped", never "failed"');
  assert.equal(m.why, '1 task stopped');
});

test('Tia OFF pressed while a session is starting: with "stop what runs" it is stopped too', async () => {
  cfg.missions = { ...structuredClone(ON), offStops: true };
  let e = null;
  // The press lands inside the start: after the last look at the switch, before the run is known to the engine.
  const late = { ...runner, startAlone: async (job) => {
    cfg.missions.on = false;
    await e.off();
    return runner.startAlone(job);
  } };
  const day = ++days;
  e = missionEngine({ config: () => cfg, runner: late, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 2, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'), tickMs: 3_600_000, now: () => new Date(Date.now() + day * 86_400_000) });
  engines.push(e);
  const { id } = await mission(e, 'A note started at the press', [{ title: 'Late note', note: 'DO:hang' }]);
  await e.tick();
  const m = await until(e, id, (x) => x.tasks[0].state !== 'running', 8_000);
  assert.equal(m.tasks[0].state, 'stopped', `${m.tasks[0].state}: ${m.tasks[0].why}`);
  assert.equal(m.tasks[0].runs[0].state, 'stopped');
  await quiet();
});

test('a restart in the middle: the mission goes on from its file and the run that ended meanwhile is settled once', async () => {
  cfg.missions = structuredClone(ON);
  fs.writeFileSync(process.env.FAKE_VERDICTS, '');
  const e1 = engineOf();
  const { id } = await mission(e1, 'A note across a restart', [{ title: 'Restart note', note: 'Files: restart.md' }]);
  await e1.tick();
  const running = readMission(place(), id).tasks[0];
  assert.equal(running.state, 'running');
  await e1.close(); // the dashboard stops; its run still ends (the door settles it in its record)
  for (let i = 0; i < 100 && runner.running().length; i++) await new Promise((r) => setTimeout(r, 100));
  const e2 = engineOf(e1.day); // the same dashboard after its restart: the same day
  const m = await until(e2, id, (x) => x.state !== 'running');
  const x = m.tasks[0];
  assert.equal(x.state, 'review', `${x.state}: ${x.why} / ${m.state}: ${m.why} / ${m.line.slice(-4).map((l) => l.words).join(' | ')}`);
  assert.deepEqual(x.runs.map((r) => r.kind), ['work', 'review'], 'the work run counted once, then its review');
  assert.equal(x.runs[0].id, running.run.id);
  assert.equal(x.runs[0].provider, null, 'its usage was not read after the restart: its cost is unknown, not "none"');
});

test('a restart while a review runs: its pass still counts, checked against the snapshot kept in the file', async () => {
  cfg.missions = structuredClone(ON);
  fs.writeFileSync(process.env.FAKE_VERDICTS, 'PASS\n');
  const e1 = engineOf();
  const { id } = await mission(e1, 'A note reviewed across a restart', [{ title: 'Reviewed note', note: 'DO:slowreview\nFiles: reviewed.md' }]);
  const m1 = await until(e1, id, (x) => x.tasks[0].run && x.tasks[0].run.kind === 'review');
  assert.ok(m1.tasks[0].run.before && m1.tasks[0].run.before.ref, 'the snapshot is in the file');
  await e1.close(); // the dashboard stops while the review runs; the run ends and its record keeps the answer
  for (let i = 0; i < 100 && runner.running().length; i++) await new Promise((r) => setTimeout(r, 100));
  const e2 = engineOf(e1.day);
  const m = await until(e2, id, (x) => x.state !== 'running');
  const x = m.tasks[0];
  assert.deepEqual(x.verdicts.map((v) => v.verdict), ['pass'], m.line.slice(-3).map((l) => l.words).join(' | '));
  assert.equal(x.state, 'review');
  assert.equal(x.firstPass, true);
  assert.ok(!m.line.some((l) => /changed the branch/.test(l.words)));
});

test('two dashboards: a task claimed by another live process is never started here', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  const g = await e.give({ goal: 'A claimed note', project: 'shop' });
  const tid = (await store().add({ title: 'Claimed note', project: 'shop', by: 'writer', note: 'Files: claimed.md' })).item.id;
  cfg.missions.projects.shop.on = false; // nothing of the Accept's own look starts it before the claim is written
  await e.accepts.after(g.proposal.id, { plan: 'c-plan', tasks: [tid] });
  await e.tick();
  const id = g.mission.id;
  assert.equal(readMission(place(), id).tasks[0].runs.length, 0);
  cfg.missions.projects.shop.on = true;
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const ident = procIdent.of([other.pid]).get(other.pid) || null;
    await withLock(place().file, async () => {
      const m = readMission(place(), id);
      Object.assign(m.tasks[0], { state: 'running', claim: { writer: m.writer, pid: other.pid, ident } });
      writeMission(place(), m);
    });
    const n = calls().length;
    for (let i = 0; i < 3; i++) await e.tick();
    assert.equal(calls().length, n, 'nothing started for a task another process holds');
    const held = readMission(place(), id).tasks[0];
    assert.equal(held.state, 'running');
    assert.equal(held.claim.pid, other.pid, 'the other process keeps its claim');
    assert.equal(held.run, null, 'no run of this dashboard was started for it');
  } finally {
    other.kill('SIGKILL');
  }
  await new Promise((r) => setTimeout(r, 200));
  // Its process is gone: the claim is taken over, and the task starts here once (its first run is this dashboard's).
  const m = await until(e, id, (x) => x.tasks[0].runs.length > 0);
  assert.equal(m.tasks[0].runs.length >= 1, true, 'a claim of a process that is gone is not held');
  assert.ok(m.line.some((l) => /start was interrupted: it starts again/.test(l.words)));
  await e.stop(id);
  await until(e, id, (x) => !x.tasks.some((y) => y.state === 'running'));
  await quiet();
});

test('a task that came from another program\'s token is never part of a mission without his press', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  const g = await e.give({ goal: 'A goal with a foreign task', project: 'shop' });
  const own = (await store().add({ title: 'Own note', project: 'shop', by: 'writer', note: 'Files: own.md' })).item.id;
  const foreign = (await store().add({ title: 'Foreign note', project: 'shop', by: 'writer' })).item.id;
  await changeDoc(place().file, (doc) => {
    doc.items.find((x) => x.id === foreign).from = { token: 'tok1', name: 'a script', at: '2026-11-18T10:00:00Z' };
  });
  await e.accepts.after(g.proposal.id, { plan: 'b-plan', tasks: [own, foreign] });
  const m = readMission(place(), g.mission.id);
  assert.deepEqual(m.tasks.map((x) => x.id), [own]);
  assert.ok(m.line.some((l) => l.task === foreign && /came from another program/.test(l.words)));
  assert.ok(m.line.some((l) => l.task === foreign && /it is yours to start from Work/.test(l.words)), 'no press is promised that the page has not');
  await assert.rejects(() => e.add(m.id, foreign, { hers: true }), (x) => x.status === 403 && /came from another program: it joins a mission only by your own press on Work/.test(x.message), 'never by her card');
  assert.deepEqual(readMission(place(), m.id).tasks.map((x) => x.id), [own]);
  await e.add(m.id, foreign); // his press
  assert.deepEqual(readMission(place(), m.id).tasks.map((x) => x.id), [own, foreign]);
  await e.stop(m.id);
});

test('a task the plan gives to the owner ("me", or his id in a planner\'s file) starts no session: it is his, said once', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  fs.writeFileSync(toolLog, '');
  const g = await e.give({ goal: 'Put the shop online', project: 'shop' });
  const pay = (await store().add({ title: 'Pay for the domain', project: 'shop', by: 'me', note: 'Only I can pay.' })).item.id;
  const yes = (await store().add({ title: 'Say yes to the images', project: 'shop', by: 'writer' })).item.id;
  const page = (await store().add({ title: 'Write the launch page', project: 'shop', by: 'writer', note: 'Files: launch.md' })).item.id;
  // A planner's file: who does it is `owner`, with his id for "me" (model.mjs setWho), and no `by`.
  await changeDoc(place().file, (doc) => {
    const x = doc.items.find((y) => y.id === yes);
    delete x.by;
    x.owner = 'alex';
    const w = doc.items.find((y) => y.id === page);
    delete w.by;
    w.owner = 'writer';
  });
  await e.accepts.after(g.proposal.id, { plan: 'online-plan', tasks: [pay, yes, page] });
  const m0 = readMission(place(), g.mission.id);
  assert.deepEqual(m0.tasks.map((x) => [x.id, x.role, x.state]), [[pay, null, 'his'], [yes, null, 'his'], [page, 'writer', 'queued']]);
  assert.ok(m0.line.some((l) => l.task === pay && /Yours: the plan gives it to you/.test(l.words)));
  const m = await until(e, g.mission.id, (x) => ['waits', 'done', 'failed'].includes(x.state));
  assert.equal(m.state, 'waits', m.why);
  const ran = calls().filter((c) => !c.review).length;
  assert.equal(ran, 1, 'only the writer\'s task got a session');
  assert.deepEqual(m.tasks.find((x) => x.id === pay).runs, []);
  await assert.rejects(e.add(m.id, pay), /not for her sessions/);
  assert.equal(t.trapped(), '');
});

test('a task one mission holds is never taken by another: not by an Accept, not by his press', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  const one = await e.give({ goal: 'The first goal', project: 'shop' });
  const two = await e.give({ goal: 'The second goal', project: 'shop' });
  const tid = (await store().add({ title: 'Shared note', project: 'shop', by: 'writer', note: 'Files: shared.md' })).item.id;
  cfg.missions.projects.shop.on = false; // nothing starts: the task stays held by the first, queued
  try {
    await e.accepts.after(one.proposal.id, { plan: 'one-plan', tasks: [tid] });
    await e.accepts.after(two.proposal.id, { plan: 'two-plan', tasks: [tid] });
    assert.deepEqual(readMission(place(), one.mission.id).tasks.map((x) => x.id), [tid]);
    const m2 = readMission(place(), two.mission.id);
    assert.deepEqual(m2.tasks, [], 'the second mission did not take it');
    assert.ok(m2.line.some((l) => l.task === tid && /"The first goal" holds it already/.test(l.words)));
    await assert.rejects(e.add(two.mission.id, tid), /in the mission "The first goal" already/);
  } finally {
    cfg.missions.projects.shop.on = true;
  }
  await e.stop(one.mission.id);
  await e.stop(two.mission.id).catch(() => {});
});

test('a plan\'s "review it" task never runs as a work session; a mission file that says otherwise is refused at the start', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  fs.writeFileSync(toolLog, '');
  fs.writeFileSync(process.env.FAKE_VERDICTS, '');
  const { id, ids } = await mission(e, 'A cart and its review', [{ title: 'Add the cart', by: 'writer', note: 'Files: cart.md' }, { title: 'Review the cart', by: 'reviewer' }]);
  const m = await until(e, id, (x) => ['waits', 'done', 'failed'].includes(x.state));
  const rev = m.tasks.find((x) => x.id === ids[1]);
  assert.equal(rev.state, 'his', rev.why);
  assert.deepEqual(rev.runs, []);
  assert.equal(calls().filter((c) => !c.review).length, 1, 'one work session: the cart');
  // An older file that holds a reviewer task as queued work: it is never started as one.
  await withLock(place().file, async () => {
    const x = readMission(place(), id);
    Object.assign(x.tasks.find((y) => y.id === ids[1]), { role: 'reviewer', state: 'queued', why: null });
    x.state = 'running';
    writeMission(place(), x);
  });
  const n = calls().length;
  const m2 = await until(e, id, (x) => x.tasks.find((y) => y.id === ids[1]).state !== 'queued');
  assert.equal(m2.tasks.find((y) => y.id === ids[1]).state, 'his');
  assert.equal(calls().length, n, 'no session started for it');
});

test('a mission whose last task waits for one in review waits for him, says for what, and goes on after his Accept', async () => {
  cfg.missions = structuredClone(ON);
  fs.writeFileSync(process.env.FAKE_VERDICTS, '');
  const e = engineOf();
  const g = await e.give({ goal: 'Notes and their index', project: 'shop' });
  const first = (await store().add({ title: 'Write the notes', project: 'shop', by: 'writer', note: 'Files: notes.md' })).item.id;
  const second = (await store().add({ title: 'Write the index', project: 'shop', by: 'writer', note: 'Files: index.md' })).item.id;
  await changeDoc(place().file, (doc) => {
    doc.items.find((x) => x.id === second).after = [first];
  });
  await e.accepts.after(g.proposal.id, { plan: 'idx-plan', tasks: [first, second] });
  const m = await until(e, g.mission.id, (x) => x.state === 'waits');
  assert.equal(m.state, 'waits', `${m.state}: ${m.why}`);
  assert.equal(m.why, '"Write the index" waits for "Write the notes", which waits for your Accept in Work');
  for (let i = 0; i < 3; i++) await e.tick();
  assert.equal(readMission(place(), g.mission.id).line.filter((l) => /The mission waits for you: "Write the index"/.test(l.words)).length, 1, 'said once');
  await store().status(first, 'done'); // his Accept
  const m2 = await until(e, g.mission.id, (x) => x.tasks[1].runs.length > 0);
  assert.ok(m2.tasks[1].runs.length > 0, `the second task started after his Accept: ${m2.why}`);
  await until(e, g.mission.id, (x) => !x.tasks.some((y) => y.state === 'running'));
});

test('a usage limit with no other provider: the task waits until a time it names, then tries again', async () => {
  cfg.missions = structuredClone(ON);
  let shift = 0;
  const base = Date.now() + ++days * 86_400_000;
  const e = missionEngine({ config: () => cfg, runner, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 2, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'), tickMs: 3_600_000, now: () => new Date(base + shift) });
  engines.push(e);
  const { id } = await mission(e, 'A goal at a limit', [{ title: 'Limited note', note: 'DO:limit' }]);
  const m = await until(e, id, (x) => x.tasks[0].runs.length === 1 && x.tasks[0].state === 'queued' && /waits until/.test(x.why || ''));
  assert.match(m.why, /every provider of your order reached its usage limit: it waits until \d\d:\d\d, then tries again/);
  assert.ok(m.line.some((l) => /key reached its usage limit and no other provider of your order is free: it waits until/.test(l.words)));
  assert.ok(!m.line.some((l) => /goes on with the next provider/.test(l.words)), 'it names no next provider that does not exist');
  for (let i = 0; i < 2; i++) await e.tick();
  assert.equal(readMission(place(), id).tasks[0].runs.length, 1, 'not tried again within the hour');
  shift = 61 * 60_000;
  const m2 = await until(e, id, (x) => x.tasks[0].runs.length >= 2);
  assert.ok(m2.tasks[0].runs.length >= 2, 'tried again once the hour passed');
  await e.stop(id).catch(() => {});
  await quiet();
});

test('a goal whose planning failed ends as failed, and stays so over later looks', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  const g = await e.give({ goal: 'A goal nobody can plan', project: 'shop' });
  writeProposal({ ...g.proposal, state: 'failed', reason: 'the planning session ended without a plan' });
  for (let i = 0; i < 2; i++) await e.tick();
  const m = readMission(place(), g.mission.id);
  assert.equal(m.state, 'failed');
  assert.ok(m.endedAt, 'it ended');
  assert.match(m.why, /^Planning failed: the planning session ended without a plan/);
});

test('a mission another dashboard runs: Stop says so, and never that there is no such mission', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  const g = await e.give({ goal: 'A goal of another dashboard', project: 'shop' });
  await withLock(place().file, async () => {
    const m = readMission(place(), g.mission.id);
    m.writer = '0123456789abcdef';
    writeMission(place(), m);
  });
  await assert.rejects(e.stop(g.mission.id), (err) => err.status === 409 && /another dashboard started this mission: stop or change it there/.test(err.message));
  await assert.rejects(e.stop('m-20200101-000000'), /no such mission/);
});

test('a removed task is not started; a project switched off before the start starts nothing', async () => {
  cfg.missions = { ...structuredClone(ON), atOnce: 1 };
  const e = engineOf();
  const { id, ids } = await mission(e, 'Two notes, one removed', [{ title: 'Kept note', note: 'Files: kept.md' }, { title: 'Removed note', note: 'Files: removed.md' }]);
  await store().remove(ids[1]);
  cfg.missions.projects.shop.on = false;
  const n = calls().length;
  for (let i = 0; i < 3; i++) await e.tick();
  assert.equal(calls().length, n, 'its project\'s switch is off: nothing starts');
  const m = readMission(place(), id);
  assert.equal(m.tasks[1].state, 'dropped');
  assert.match(m.why, /does not work on shop by herself/);
  assert.equal(readDoc(place().file).doc.items.some((x) => x.id === ids[1]), false);
  await e.stop(id);
  assert.equal(t.trapped(), '');
});

test('sessions at once: each one\'s budget is kept in the mission file, and together they never pass the cap', async () => {
  // Two projects: the run door never runs two sessions of one project at once.
  cfg.missions = { ...structuredClone(ON), capUsd: 0.4, atOnce: 2, offStops: true };
  cfg.missions.projects.blog = { on: true, test: OK };
  await quiet();
  const e = engineOf();
  fs.writeFileSync(toolLog, '');
  const ids = [];
  for (const project of ['shop', 'blog']) {
    const g = await e.give({ goal: `A hanging note in ${project}`, project });
    const tid = (await store().add({ title: `Budget ${project}`, project, by: 'writer', note: 'DO:hang' })).item.id;
    await e.accepts.after(g.proposal.id, { plan: `${project}-budget`, tasks: [tid] });
    ids.push(g.mission.id);
  }
  await e.tick();
  const running = ids.flatMap((x) => readMission(place(), x).tasks).filter((x) => x.state === 'running');
  assert.equal(running.length, 2, ids.map((x) => readMission(place(), x).why).join('; '));
  for (let i = 0; i < 100 && calls().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  const budgets = calls().map((c) => Number(c.args[c.args.indexOf('--max-budget-usd') + 1]));
  assert.deepEqual(budgets.sort(), running.map((x) => x.run.budget).sort(), 'what each session was given is what the file holds');
  const { spentOn } = await import('../../src/mission/limits.mjs');
  const { listMissions } = await import('../../src/mission/file.mjs');
  const spent = spentOn(listMissions(place()).missions, e.today()).usd;
  assert.ok(spent + budgets[0] + budgets[1] <= 0.4 + 1e-9, `spent $${spent} and held $${budgets.join(' + $')}: within the cap of $0.40`);
  cfg.missions.on = false;
  await e.off();
  for (const x of ids) await until(e, x, (y) => !y.tasks.some((z) => z.state === 'running'));
  await quiet();
});

test('a mission stopped while its session ran, then a restart: its task is settled from the run, and a new mission starts', async () => {
  cfg.missions = { ...structuredClone(ON), atOnce: 1 };
  await quiet();
  const r1 = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600, killGraceMs: 200 });
  const e1 = engineOf();
  const day = e1.day;
  const mk = (r) => {
    const e = missionEngine({ config: () => cfg, runner: r, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 2, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'), tickMs: 3_600_000, now: () => new Date(Date.now() + day * 86_400_000) });
    engines.push(e);
    return e;
  };
  const a = mk(r1);
  const { id } = await mission(a, 'A goal stopped mid run', [{ title: 'Stopped hang', note: 'DO:hang' }]);
  await until(a, id, (x) => x.tasks[0].run);
  await a.stop(id); // offStops off: the session would run to its end
  await a.close();
  await r1.close(); // the dashboard stops: its session ends with it
  const r2 = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600, killGraceMs: 200 });
  await r2.begin();
  const b = mk(r2);
  try {
    const old = await until(b, id, (x) => x.tasks[0].state !== 'running', 8_000);
    assert.equal(old.state, 'stopped');
    assert.equal(old.tasks[0].state, 'stopped', `${old.tasks[0].state}: ${old.tasks[0].why}`);
    assert.equal(old.tasks[0].run, null);
    fs.writeFileSync(process.env.FAKE_VERDICTS, '');
    const n = await mission(b, 'A later goal', [{ title: 'Later note', note: 'Files: later.md' }]);
    const m = await until(b, n.id, (x) => x.tasks[0].runs.length > 0, 8_000);
    assert.ok(m.tasks[0].runs.length > 0, `the later mission started: ${m.why}`);
    await until(b, n.id, (x) => !x.tasks.some((y) => y.state === 'running'));
  } finally {
    await b.close();
    await r2.close();
  }
});
