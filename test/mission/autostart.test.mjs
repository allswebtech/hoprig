// Auto per project in the engine (engine.mjs autoStart) with the stand-in coding tool on a temporary computer: off reads
// and writes nothing new; on, a ready task becomes a mission of that one task, one start per look, said in Activity and
// on its line; the limits stop a start; End stops it and Auto never takes that task again; two looks at once start it once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { FAKE, missionHome, standInBox } from './helpers.mjs';

const t = missionHome('mission-auto');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore, changeDoc } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { missionEngine } = await import('../../src/mission/engine.mjs');
const { listMissions, readMission } = await import('../../src/mission/file.mjs');
const { readEnded, STARTED_WORDS } = await import('../../src/mission/auto.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.repo(path.join(t.projects, 'blog'), { 'README.md': '# blog\n' });
t.arm();
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' }, missions: {} };
saveConfig(cfg);
const ON = { on: true, projects: { shop: { on: true, auto: true } }, capUsd: 5, providers: ['key'], atOnce: 1 };
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const toolLog = path.join(t.root, 'tool.log');
process.env.FAKE_TOOL_LOG = toolLog;
process.env.FAKE_VERDICTS = path.join(t.root, 'verdicts');
const calls = () => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, 'utf8').trim().split('\n').filter(Boolean) : []);
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600, killGraceMs: 200 });
const engines = [];
const said = [];
const engineOf = (x = {}) => {
  const e = missionEngine({ config: () => cfg, runner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 2, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'), tickMs: 3_600_000, activity: (a) => said.push(a), ...x });
  engines.push(e);
  return e;
};
test.after(async () => {
  for (const e of engines) await e.close();
  await runner.close();
});
const autos = () => listMissions(place()).missions.filter((m) => m.auto);
/** Every file under the temporary computer with its bytes' hash. */
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
async function quiet() {
  for (let i = 0; i < 300 && runner.running().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(runner.running(), [], 'nothing runs any more');
}
/** End every mission still going, so the next test begins with none of hers running. */
async function endAll(e) {
  for (const m of listMissions(place()).missions) if (['planning', 'running', 'waits'].includes(m.state)) await e.stop(m.id).catch(() => {});
  await quiet();
  // Its run settled in the mission file too (a task still "running" there counts as a session of hers at once).
  const going = () => listMissions(place()).missions.some((m) => m.tasks.some((x) => x.state === 'running'));
  for (let i = 0; i < 200 && going(); i++) {
    await e.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(going(), false, 'no task of hers runs any more');
}
/** "HH:MM" of this computer's clock `min` minutes from now (a window of working hours that is not now). */
const hhmm = (min) => new Date(Date.now() + min * 60_000).toTimeString().slice(0, 5);
const add = async (x) => (await store().add({ project: 'shop', by: 'writer', note: 'Files: note.md', ...x })).item.id;

test('Auto off (her switch on): a ready task is not started, and a look reads nothing new and writes nothing', async () => {
  cfg.missions = { ...structuredClone(ON), projects: { shop: { on: true } } };
  await add({ title: 'A ready note' });
  const e = engineOf();
  const before = snapshot();
  const seen = [];
  const { readFileSync, readdirSync } = fs;
  fs.readFileSync = (f, ...a) => (seen.push(String(f)), readFileSync(f, ...a));
  fs.readdirSync = (f, ...a) => (seen.push(String(f)), readdirSync(f, ...a));
  try {
    for (let i = 0; i < 3; i++) await e.tick();
  } finally {
    fs.readFileSync = readFileSync;
    fs.readdirSync = readdirSync;
  }
  assert.deepEqual(seen.filter((f) => /tasks\.json$|auto-ended\.json$|[\\/]runs$/.test(f)), [], 'not the list, not the ended tasks, not the runs');
  assert.deepEqual(snapshot(), before, 'nothing was written anywhere');
  assert.deepEqual(calls(), []);
  assert.deepEqual(said, []);
  assert.equal(t.trapped(), '');
});

test('Auto on: one ready task becomes a mission of that one task, one start per look, said in Activity and on its line', async () => {
  cfg.missions = { ...structuredClone(ON), atOnce: 2 };
  const first = (await store().list()).items.find((x) => x.title === 'A ready note').id;
  const second = await add({ title: 'Another ready note', note: 'DO:slow\nFiles: two.md' });
  await add({ title: 'His own note', by: 'me' });
  await add({ title: 'A later note', date: '2999-01-01' });
  await add({ title: 'A blog note', project: 'blog' });
  const e = engineOf();
  await e.tick();
  let ms = autos();
  assert.equal(ms.length, 1, 'one start per look');
  const m = ms[0];
  assert.deepEqual(m.tasks.map((x) => x.id), [first], 'the first ready task in his order');
  assert.equal(m.plan, null);
  assert.equal(m.goal, 'A ready note');
  assert.ok(m.line[0].words.startsWith(STARTED_WORDS), m.line[0].words);
  assert.equal(STARTED_WORDS, 'Started by Tia (Auto)');
  assert.deepEqual(said, [{ automation: 'Tia (Auto)', did: 'Tia (Auto) started "A ready note" in shop', outcome: 'ok' }]);
  assert.equal(readMission(place(), m.id).tasks[0].state, 'running', 'its session started in the same look');
  await e.tick();
  ms = autos();
  assert.equal(ms.length, 2, 'the next look takes the next ready task');
  assert.deepEqual(ms.map((x) => x.tasks[0].id).sort(), [first, second].sort());
  for (let i = 0; i < 4; i++) await e.tick();
  assert.equal(autos().length, 2, 'his own task, one of a later date and one of another project are never taken');
  await endAll(e);
  said.splice(0);
});

test('the limits stop an Auto start: no spend cap, sessions at once, outside his hours, Tia OFF', async () => {
  await add({ title: 'A limited note' });
  const e = engineOf();
  const n = autos().length;
  for (const missions of [
    { ...structuredClone(ON), capUsd: 0 },
    { ...structuredClone(ON), hours: { from: hhmm(120), to: hhmm(180) } },
    { ...structuredClone(ON), on: false },
    { ...structuredClone(ON), providers: ['key'], projects: { shop: { on: false, auto: true } } },
  ]) {
    cfg.missions = missions;
    await e.tick();
    assert.equal(autos().length, n, JSON.stringify(missions));
  }
  // At "sessions at once": a session of hers runs, so nothing more starts.
  cfg.missions = structuredClone(ON);
  const hang = await add({ title: 'A hanging note', note: 'DO:hang' });
  await changeDoc(place().file, (doc) => {
    const items = doc.items.filter((x) => x.id === hang);
    doc.items = [...items, ...doc.items.filter((x) => x.id !== hang)]; // first in his order
  });
  await e.tick();
  assert.equal(autos().length, n + 1);
  await e.tick();
  await e.tick();
  assert.equal(autos().length, n + 1, 'one session of hers at once: the limited note waits');
  await endAll(e);
  said.splice(0);
});

test('End stops an Auto mission at once, and Auto never takes that task again', async () => {
  cfg.missions = structuredClone(ON);
  const id = await add({ title: 'A long note', note: 'DO:hang' });
  await changeDoc(place().file, (doc) => {
    doc.items = [...doc.items.filter((x) => x.id === id), ...doc.items.filter((x) => x.id !== id)];
  });
  const e = engineOf();
  await e.tick();
  const m = autos().find((x) => x.tasks[0].id === id);
  assert.ok(m, 'started');
  assert.equal(readMission(place(), m.id).tasks[0].state, 'running');
  await e.stop(m.id);
  await quiet();
  for (let i = 0; i < 100 && !readMission(place(), m.id).tasks[0].runs.length; i++) await new Promise((r) => setTimeout(r, 50));
  const after = readMission(place(), m.id);
  assert.equal(after.state, 'stopped');
  assert.equal(after.why, 'You ended it');
  assert.ok(after.line.some((l) => /You ended it: what ran is stopped, and Auto never takes this task again/.test(l.words)));
  assert.equal(after.tasks[0].runs[0].state, 'stopped', 'its session was stopped, though "Tia OFF stops what runs" is off');
  assert.ok(readEnded(place()).has(id));
  // Its mission gone from the list (a folder kept short): the ended list alone keeps it out.
  fs.renameSync(path.join(place().folder, 'missions', `${m.id}.json`), path.join(t.root, `${m.id}.json`));
  assert.equal((await store().list()).items.find((x) => x.id === id).status, 'open', 'still open in Work: ready but for the End');
  const n = autos().length;
  for (let i = 0; i < 3; i++) await e.tick();
  assert.equal(autos().filter((x) => x.tasks[0].id === id).length, 0, 'never taken again');
  assert.ok(autos().length <= n + 1);
  await endAll(e);
  said.splice(0);
  assert.equal(t.trapped(), '');
});

test('End pressed while an Auto session is starting stops that session (Tia OFF stops what runs is off)', async () => {
  cfg.missions = structuredClone(ON);
  const id = await add({ title: 'A starting note', note: 'DO:hang' });
  await changeDoc(place().file, (doc) => {
    doc.items = [...doc.items.filter((x) => x.id === id), ...doc.items.filter((x) => x.id !== id)];
  });
  let calledBack;
  const called = new Promise((r) => (calledBack = r));
  let release;
  const gate = new Promise((r) => (release = r));
  const stops = [];
  const slow = {
    ...runner,
    startAlone: async (a) => {
      calledBack();
      await gate;
      return runner.startAlone(a);
    },
    stop: (rid, why) => (stops.push([rid, why]), runner.stop(rid, why)),
  };
  const e = engineOf({ runner: slow });
  const look = e.tick();
  await called;
  const m = autos().find((x) => x.tasks[0].id === id);
  assert.ok(m, 'its mission was made');
  await e.stop(m.id);
  release();
  await look;
  await quiet();
  const after = readMission(place(), m.id);
  assert.equal(stops.length, 1, 'its session was stopped');
  assert.equal(stops[0][1], 'You ended it');
  assert.equal(after.state, 'stopped');
  assert.equal(after.why, 'You ended it');
  assert.ok(readEnded(place()).has(id));
  await endAll(e);
  said.splice(0);
  assert.equal(t.trapped(), '');
});

test('Tia at "Ask me": Auto starts nothing (each start of hers is his card first); at "Do the work" it starts', async () => {
  cfg.missions = structuredClone(ON);
  const id = await add({ title: 'An asked note', note: 'DO:slow\nFiles: asked.md' });
  await changeDoc(place().file, (doc) => {
    doc.items = [...doc.items.filter((x) => x.id === id), ...doc.items.filter((x) => x.id !== id)];
  });
  const logs = [];
  const e = engineOf({ log: (l) => logs.push(l) });
  const n = autos().length;
  cfg.assistant = { enabled: true, level: 'ask' };
  try {
    for (let i = 0; i < 3; i++) await e.tick();
    assert.equal(autos().length, n, 'nothing started at Ask me');
    assert.deepEqual(logs.filter((l) => /Ask me/.test(l)), ['Auto starts nothing: Tia is set to "Ask me"'], 'said once');
    cfg.assistant = { enabled: true, level: 'work' };
    await e.tick();
    assert.equal(autos().filter((x) => x.tasks[0].id === id).length, 1, 'started at Do the work');
  } finally {
    delete cfg.assistant;
  }
  await endAll(e);
  said.splice(0);
});

test('two looks at once (two dashboards of this computer) start a ready task once', async () => {
  cfg.missions = structuredClone(ON);
  const id = await add({ title: 'A twice-looked note', note: 'DO:slow\nFiles: twice.md' });
  await changeDoc(place().file, (doc) => {
    doc.items = [...doc.items.filter((x) => x.id === id), ...doc.items.filter((x) => x.id !== id)];
  });
  const a = engineOf();
  const b = engineOf();
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(autos().filter((x) => x.tasks[0].id === id).length, 1);
  await endAll(a);
  said.splice(0);
});

test('the feature writes an Auto start into Work → Activity (the automation log of the state folder)', async () => {
  const { activityLine } = await import('../../src/mission/feature.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  activityLine({ automation: 'Tia (Auto)', did: 'Tia (Auto) started "A note" in shop', outcome: 'ok' });
  const lines = fs.readFileSync(path.join(stateDir(), 'automation.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const e = lines[lines.length - 1];
  assert.deepEqual([e.automation, e.did, e.outcome], ['Tia (Auto)', 'Tia (Auto) started "A note" in shop', 'ok']);
  assert.ok(stateDir().startsWith(t.root), 'the temporary computer\'s state folder');
});
