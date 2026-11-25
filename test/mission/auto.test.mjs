// Auto per project (src/mission/auto.mjs, settings.mjs autoOn): what a ready task is, each condition broken alone, and
// the switch: off by default, only while her switch for the project is on, kept when the project's test is saved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENDED_FILE, addEnded, notReady, readEnded, readyTask } from '../../src/mission/auto.mjs';
import { missionsDir } from '../../src/mission/file.mjs';
import { autoOn, cleanPatch, missionSettings } from '../../src/mission/settings.mjs';

const ready = { id: 'add-search', title: 'Add search', project: 'shop', by: 'ai', status: 'open' };
const base = { project: 'shop', ownerId: 'alex', today: '2026-03-10', items: [], missions: [], running: new Set(), ended: new Set(), rolesOff: [] };
const c = (x = {}) => ({ ...base, ...x });

test('a task of the AI, of this project, open, with no date and nothing before it, is ready', () => {
  assert.equal(notReady(ready, c()), null);
  assert.equal(notReady({ ...ready, by: 'writer' }, c()), null, 'a role of hers');
  assert.equal(notReady({ ...ready, date: '2026-03-10' }, c()), null, 'its date is today');
  assert.equal(notReady({ ...ready, date: '2026-03-01' }, c()), null, 'its date is past');
  const done = { id: 'design', project: 'shop', status: 'done' };
  assert.equal(notReady({ ...ready, after: ['design'] }, c({ items: [done] })), null, 'what it waits for is done');
  assert.deepEqual(readyTask([{ ...ready, id: 'a', by: 'me' }, ready], c()), ready, 'the first ready one in his order');
});

test('each condition of "ready", broken alone, makes it not ready', () => {
  const cases = [
    ['another project', { ...ready, project: 'blog' }, c(), /another project/],
    ['no project', { ...ready, project: undefined }, c(), /another project/],
    ['his own (by me)', { ...ready, by: 'me' }, c(), /yours/],
    ['his own (his id)', { ...ready, by: 'alex' }, c(), /yours/],
    ['his own (nobody named)', { ...ready, by: undefined }, c(), /yours/],
    ['the reviewer', { ...ready, by: 'reviewer' }, c(), /review/],
    ['someone else', { ...ready, by: 'bob' }, c(), /not for a role/],
    ['a role he turned off', { ...ready, by: 'writer' }, c({ rolesOff: ['writer'] }), /not for a role/],
    ['the developer turned off (ai)', ready, c({ rolesOff: ['developer'] }), /not for a role/],
    ['done', { ...ready, status: 'done' }, c(), /done/],
    ['dropped', { ...ready, status: 'dropped' }, c(), /dropped/],
    ['in review', { ...ready, status: 'review' }, c(), /review/],
    ['being done', { ...ready, status: 'doing' }, c(), /doing/],
    ['a future date', { ...ready, date: '2026-03-11' }, c(), /not come/],
    ['a date that is not a day', { ...ready, date: '2026-02-30' }, c(), /not a day/],
    ['after a task not done', { ...ready, after: ['design'] }, c({ items: [{ id: 'design', status: 'open' }] }), /waits/],
    ['after a task not in the list', { ...ready, after: ['gone'] }, c(), /waits/],
    ['after one done and one not', { ...ready, after: ['a', 'b'] }, c({ items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'review' }] }), /waits/],
    ['added by a Work token', { ...ready, from: { token: 'wt_1', name: 'ci', at: '2026-03-01' } }, c(), /another program/],
    ['a run of it goes on', ready, c({ running: new Set(['add-search']) }), /run of it/],
    ['a mission holds it', ready, c({ missions: [{ state: 'running', tasks: [{ id: 'add-search', state: 'queued' }] }] }), /mission/],
    ['a mission that ended had it', ready, c({ missions: [{ state: 'failed', tasks: [{ id: 'add-search', state: 'failed' }] }] }), /mission/],
    ['he ended it under Auto', ready, c({ ended: new Set(['add-search']) }), /ended it/],
    ['a deadline, not a task', { ...ready, kind: 'deadline' }, c(), /not a task/],
    ['a run time of his', { ...ready, date: '2026-03-10', work: { at: { time: '07:30', computer: null } } }, c(), /run time of yours/],
  ];
  for (const [name, raw, ctx, why] of cases) {
    assert.match(String(notReady(raw, ctx)), why, name);
    assert.equal(readyTask([raw], ctx), null, name);
  }
});

test('an End while the ended list cannot be read leaves that list as it is (the tasks ended before stay out)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ended-'));
  try {
    const place = { folder: dir, label: 'plans' };
    addEnded(place, 'first-ended');
    addEnded(place, 'second-ended');
    assert.deepEqual([...readEnded(place)], ['first-ended', 'second-ended']);
    const file = path.join(missionsDir(place), ENDED_FILE);
    fs.writeFileSync(file, '{ broken');
    assert.equal(readEnded(place), null, 'unreadable: Auto starts nothing');
    const kept = addEnded(place, 'third-ended');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'the list is not replaced by one id');
    assert.equal(readEnded(place), null, 'still unreadable: Auto still starts nothing');
    assert.equal(kept, false, 'the End is told it was not written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Auto switch: off by default, only while her switch for the project is on', () => {
  assert.equal(missionSettings({ missions: { on: true, projects: { shop: { on: true } } } }).projects.shop.auto, false);
  assert.equal(autoOn(missionSettings({ missions: { on: true, projects: { shop: { on: true } } } }), 'shop'), false);
  assert.equal(autoOn(missionSettings({ missions: { on: true, projects: { shop: { on: true, auto: true } } } }), 'shop'), true);
  assert.equal(autoOn(missionSettings({ missions: { on: false, projects: { shop: { on: true, auto: true } } } }), 'shop'), false, 'Tia OFF');
  assert.equal(missionSettings({ missions: { on: true, projects: { shop: { on: false, auto: true } } } }).projects.shop.auto, false, 'her switch off: no Auto');
  assert.equal(autoOn(missionSettings({ missions: { on: true, projects: { shop: { on: true, auto: 'yes' } } } }), 'shop'), false, 'only true');
  const cur = missionSettings({ missions: { on: true, projects: { shop: { on: true } } } });
  const opts = { projects: ['shop'], providers: [] };
  assert.throws(() => cleanPatch({ projects: { shop: { on: true, auto: 'yes' } } }, cur, opts), /auto is true or false/);
  const on = cleanPatch({ projects: { shop: { on: true, auto: true } } }, cur, opts);
  assert.equal(on.projects.shop.auto, true);
  assert.equal(cleanPatch({ projects: { shop: { on: true, test: ['npm', 'test'] } } }, on, opts).projects.shop.auto, true, 'saving the test command keeps Auto');
  const off = cleanPatch({ projects: { shop: { on: false, test: null } } }, on, opts);
  assert.equal(off.projects.shop.auto, false, 'her switch off takes Auto off');
  assert.equal(cleanPatch({ projects: { shop: { on: true, test: null } } }, off, opts).projects.shop.auto, false, 'on again: Auto stays off until he chooses it again');
});

test('the docs, the changelog and the README say what the code does, in the page\'s words', async () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const flat = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
  const web = flat('web/mission.js');
  assert.match(web, /export const AUTO_LABEL = 'Tia starts this project\\'s ready tasks by herself'/);
  assert.match(web, /export const AUTO_BY = 'Started by Tia \(Auto\)'/);
  // "every 15 seconds" in the docs is the engine's own look.
  assert.match(flat('src/mission/engine.mjs'), /const TICK_MS = 15_000;/);
  const work = flat('docs/WORK.md');
  assert.match(work, /"Tia starts this project's ready tasks by herself", shown on Work → Team only under her switch for that project and off until you turn it on/);
  assert.match(work, /each look \(every 15 seconds\) takes at most one task/);
  assert.match(work, /"Started by Tia \(Auto\)"/);
  assert.match(work, /\*\*End\*\* where another has Stop: its session is stopped at once, and Tia never takes that task by herself again/);
  assert.match(work, /With Auto off nothing of it reads the list or writes anything\./);
  const log = flat('site/content/changelog.md');
  assert.match(log, /\*\*Tia starts this project's ready tasks by herself\*\*, off after the update and after a new install/);
  assert.match(flat('README.md'), /\*\*Auto\*\*, a switch per project on Work → Team \(off at first\)/);
});
