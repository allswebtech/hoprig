// The list file and the place: a planning-tool file opened and saved unchanged stays byte for byte the same; one
// item changed keeps every key Work does not know; the file's own JSON style is kept; a broken file is never
// overwritten; one writer at a time; the Work folder never leads out of the brain or the project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE, tempWork, write } from './helpers.mjs';

const t = tempWork('work-store');
test.after(() => t.cleanup());
const { changeDoc, formatOf, lockFile, serialize, workStore } = await import('../../src/work/store.mjs');
const { resolvePlace, cleanSettings, cleanRel, workSettings, projectNames } = await import('../../src/work/place.mjs');

fs.mkdirSync(t.brain, { recursive: true });
fs.mkdirSync(path.join(t.projects, 'shop', 'docs'), { recursive: true });
fs.mkdirSync(path.join(t.projects, 'blog'), { recursive: true });
const projectCfg = (p = 'docs/plans') => ({ work: { place: 'project', project: 'shop', path: p, ownerId: 'alex' } });
const fixtureText = fs.readFileSync(FIXTURE, 'utf8');

test('a planning-tool list opened and saved with nothing changed stays byte for byte the same', async () => {
  write(t.projects, { 'shop/docs/plans/deadlines.json': fixtureText });
  const place = resolvePlace(projectCfg());
  assert.equal(place.fileName, 'deadlines.json', 'the planning tool\'s file is used as it is');
  const stamp = () => {
    const st = fs.statSync(place.file);
    return { ino: st.ino, mtimeMs: st.mtimeMs };
  };
  const before = stamp();
  const r = await changeDoc(place.file, () => {});
  assert.equal(r.written, false);
  assert.equal(fs.readFileSync(place.file, 'utf8'), fixtureText);
  assert.deepEqual(stamp(), before, 'not even written (the same file, the same time)');
  // A change that ends where it started writes nothing either: not the text only, the file itself is untouched (a
  // write through a temporary file and a rename would give it a new inode and a new time).
  const store = workStore(place, { projects: projectNames() });
  const mid = await changeDoc(place.file, (doc) => {
    const it = doc.items.find((x) => x.id === 'call-a003');
    const was = it.status;
    it.status = 'done';
    it.status = was;
  });
  assert.equal(mid.written, false);
  const same = await store.edit('call-a003', { title: JSON.parse(fixtureText).items.find((x) => x.id === 'call-a003').title });
  assert.equal(same.written, false, 'an edit to the same title');
  assert.deepEqual(stamp(), before, 'the same inode and time: nothing was written');
  assert.equal(fs.readFileSync(place.file, 'utf8'), fixtureText);
  // serialize() of the planning tool's own output is that output.
  assert.equal(serialize(JSON.parse(fixtureText), formatOf(fixtureText)), fixtureText);
});

test('one item changed: every key Work does not know is kept, in its place; other items are untouched', async () => {
  write(t.projects, { 'shop/docs/plans/deadlines.json': fixtureText });
  const place = resolvePlace(projectCfg());
  const store = workStore(place, { projects: projectNames(), now: () => new Date('2026-11-17T09:00:00') });
  await store.edit('invoice-a002', { title: 'Send the second invoice now', project: 'shop' });
  const before = JSON.parse(fixtureText);
  const after = JSON.parse(fs.readFileSync(place.file, 'utf8'));
  assert.deepEqual(Object.keys(after), Object.keys(before), 'top-level keys kept ("updated" too)');
  assert.equal(after.updated, '2026-11-15');
  assert.equal(after.items.length, before.items.length);
  for (let i = 0; i < before.items.length; i++) {
    if (before.items[i].id === 'invoice-a002') continue;
    assert.deepEqual(after.items[i], before.items[i], `${before.items[i].id} untouched`);
  }
  const it = after.items.find((x) => x.id === 'invoice-a002');
  assert.deepEqual(Object.keys(it), ['id', 'date', 'approx', 'title', 'brands', 'kind', 'owner', 'status', 'source', 'note', 'client', 'created', 'project', 'x-color', 'flags']);
  assert.deepEqual(it.flags, { pinned: true });
  assert.equal(it['x-color'], 'amber');
  assert.equal(after.items.find((x) => x.id === 'store-gate').gateOf, 'milestone-2');
  // The text is the planning tool's own text with only that item's lines changed.
  const expected = JSON.parse(fixtureText);
  expected.items[expected.items.findIndex((x) => x.id === 'invoice-a002')] = it;
  assert.equal(fs.readFileSync(place.file, 'utf8'), `${JSON.stringify(expected, null, 2)}\n`);
});

test('the file\'s own style is kept (four spaces, CRLF, no final newline); a broken file is never overwritten', async () => {
  const dir = path.join(t.root, 'style');
  const file = path.join(dir, 'tasks.json');
  write(dir, { 'tasks.json': '{\r\n    "items": []\r\n}' });
  await changeDoc(file, (doc) => doc.items.push({ id: 'a-1', title: 'First one' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{\r\n    "items": [\r\n        {\r\n            "id": "a-1",\r\n            "title": "First one"\r\n        }\r\n    ]\r\n}');
  write(dir, { 'tasks.json': '{ "items": [ broken' });
  await assert.rejects(changeDoc(file, (doc) => doc.items.push({ id: 'x' })), (e) => e.status === 409 && /not valid JSON/.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "items": [ broken');
  write(dir, { 'tasks.json': '{"items":5}' });
  const place = { file, settings: workSettings({}) };
  await assert.rejects(workStore(place).add({ title: 'Something to do' }), (e) => e.status === 400 && /not a list/.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"items":5}');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
});

test('in one process, changes at once all land (lock.test.mjs: across processes); the lock is in the state folder', async () => {
  const dir = path.join(t.root, 'many');
  const file = path.join(dir, 'tasks.json');
  const place = { file, settings: workSettings({}) };
  const store = workStore(place);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.add({ title: `Thing number ${i}` })));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 12);
  assert.ok(lockFile(file).startsWith(process.env.HOPRIG_STATE_DIR));
  assert.deepEqual(fs.readdirSync(dir), ['tasks.json']);
  // A lock another process holds makes the next change wait; a stale one (a process that died) is taken over.
  fs.writeFileSync(lockFile(file), '999999');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile(file), old, old);
  await store.add({ title: 'After a stale lock' });
  assert.equal(fs.existsSync(lockFile(file)), false);
});

test('the place: the brain by default; a project folder only inside the project; never through a link out', () => {
  const brain = resolvePlace({});
  assert.equal(brain.kind, 'brain');
  assert.equal(brain.label, 'ai_brain/work');
  assert.equal(brain.file, path.join(t.brain, 'work', 'tasks.json'));
  for (const bad of ['../x', 'docs/../../etc', '/etc', '.git', 'docs/.hidden', 'no-ai', 'docs/test-data', 'credentials', 'a\\..\\b', '', ' ']) {
    assert.throws(() => cleanSettings({ place: 'project', project: 'shop', path: bad }), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal(cleanRel('./docs/plans/'), 'docs/plans');
  assert.throws(() => cleanSettings({ place: 'project', project: '../shop', path: 'docs' }), /folder name/);
  assert.throws(() => cleanSettings({ place: 'elsewhere' }), /AI brain or in a project/);
  assert.throws(() => cleanSettings({ where: 'x' }), /not a Work setting/);
  assert.throws(() => cleanSettings({ timeZone: 'Mars/Base' }), /time zone/);
  assert.throws(() => cleanSettings({ saveSubject: 'two\nlines' }), /one line/);
  assert.throws(() => cleanSettings({ ownerId: 'Alex Smith' }), /your id/);
  assert.throws(() => resolvePlace({ work: { place: 'project', project: 'gone', path: 'docs' } }), (e) => e.status === 409 && /not in the workspace/.test(e.message));
  // A broken setting in the file falls back to the default place, never to a path it was not checked for.
  assert.equal(resolvePlace({ work: { place: 'project', project: 'shop', path: '../../..' } }).kind, 'brain');

  const outside = path.join(t.root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'tasks.json'), '{"items":[{"id":"secret","title":"Not yours"}]}');
  fs.symlinkSync(outside, path.join(t.projects, 'shop', 'linked'));
  assert.throws(() => resolvePlace(projectCfg('linked')), (e) => e.status === 409 && /leads out/.test(e.message));
  fs.symlinkSync(outside, path.join(t.projects, 'shop', 'docs', 'deep'));
  assert.throws(() => resolvePlace(projectCfg('docs/deep/more')), (e) => e.status === 409 && /leads out/.test(e.message));
  fs.mkdirSync(path.join(t.projects, 'shop', 'docs', 'filelink'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'tasks.json'), path.join(t.projects, 'shop', 'docs', 'filelink', 'tasks.json'));
  assert.throws(() => resolvePlace(projectCfg('docs/filelink')), (e) => e.status === 409 && /not a plain file/.test(e.message));
  fs.symlinkSync(path.join(t.root, 'nowhere'), path.join(t.projects, 'shop', 'dangling'));
  assert.throws(() => resolvePlace(projectCfg('dangling')), (e) => e.status === 409 && /leads nowhere/.test(e.message));
  fs.symlinkSync(outside, path.join(t.projects, 'away'));
  assert.ok(projectNames().includes('away'), 'listed as a project (a link)');
  assert.throws(() => resolvePlace({ work: { place: 'project', project: 'away', path: 'docs' } }), (e) => e.status === 409 && /leads out of the workspace/.test(e.message));
  fs.symlinkSync(outside, path.join(t.brain, 'work'));
  assert.throws(() => resolvePlace({}), (e) => e.status === 409 && /leads out of its AI brain/.test(e.message));
  fs.rmSync(path.join(t.brain, 'work'));
});
