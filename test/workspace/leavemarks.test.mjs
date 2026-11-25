// The owner's marks of the whole-computer check (leavemarks.mjs), kept in this computer's own file in the brain
// (computer.mjs, key "leave"): keep and ignore take a dot-folder off the asks and are remembered on the next look, so it
// is asked once; outside is named once and never counted or walked; a folder outside the home, "..", a name holding
// the host name and a computer without a label are each refused in one sentence; the file round-trips through its own
// strict checker, and a file of the old form without the key still reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-leavemarks');
test.after(() => w.cleanup());
process.env.HOPRIG_HOSTNAME = 'boxhost.example.test';
const C = await import('../../src/workspace/computer.mjs');
const L = await import('../../src/workspace/leavemarks.mjs');
const { homeLook } = await import('../../src/workspace/leavehome.mjs');

const MB = 1024 * 1024;
const A = w.computer('alpha');
A.use();
w.clone(w.bare('brain', { empty: true }), path.join(A.ws, 'ai_brain'));
const sparse = (rel, size) => {
  const p = path.join(A.home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  fs.truncateSync(p, size);
};
sparse('.toolx/data.db', 2 * MB);
sparse('.tooly/data.db', 3 * MB);
sparse('.toolz/data.db', 4 * MB);
sparse('Desktop/old/archive.bin', 2 * MB);
fs.mkdirSync(path.join(A.home, '.toolz', 'inside-name-w4'), { recursive: true });
const look = () => homeLook({ home: A.home, dir: A.ws, facts: { databases: [] } });
const fileOf = () => C.fileOf('alpha', A.ws);
const asked = (r) => r.asks.map((a) => a.where).sort();

test('without a label nothing is marked, and the refusal names the command that gives one', async () => {
  const r = await L.setMark({ dir: A.ws, home: A.home, kind: 'keep', what: '~/.toolx' });
  assert.equal(r.ok, false);
  assert.match(r.why, /no label in the workspace yet, and the marks are kept in its own file: give it one with {2}hoprig workspace label <name>/);
  assert.deepEqual(L.readMarks({ dir: A.ws, home: A.home }), { keep: [], ignore: [], outside: [], testData: [], label: null });
  assert.equal((await L.unmark({ dir: A.ws, home: A.home, what: '~/.toolx' })).ok, false);
});

test('a labelled computer: its file starts in the old form, without the key, and reads with no marks', async () => {
  await C.setLabel('alpha', { dir: A.ws, projects: A.projects });
  const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
  assert.equal(raw.leave, undefined);
  assert.equal(C.checkComputerFile(raw, 'alpha', 'boxhost').ok, true);
  assert.deepEqual(L.readMarks({ dir: A.ws, home: A.home }), { keep: [], ignore: [], outside: [], testData: [], label: 'alpha' });
});

test('keep and ignore take a dot-folder off the asks, and the next look remembers: it is asked once', async () => {
  assert.deepEqual(asked(await look()), ['~/.toolx', '~/.tooly', '~/.toolz']);
  const k = await L.setMark({ dir: A.ws, home: A.home, kind: 'keep', what: '~/.toolx' });
  assert.equal(k.ok, true, k.why);
  assert.deepEqual(k.marks.keep, ['~/.toolx']);
  // An absolute path of the home is kept by its home-relative name.
  const i = await L.setMark({ dir: A.ws, home: A.home, kind: 'ignore', what: path.join(A.home, '.tooly') });
  assert.equal(i.ok, true, i.why);
  assert.deepEqual(i.marks.ignore, ['~/.tooly']);
  // A second look, with the marks read again from the file (as a new run of the command would).
  const again = await look();
  assert.deepEqual(asked(again), ['~/.toolz']);
  assert.ok(![...again.items, ...again.asks].some((x) => /toolx|tooly/.test(x.where)), 'a marked folder is no item either');
  const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
  assert.deepEqual(raw.leave, { ignore: ['~/.tooly'], keep: ['~/.toolx'] });
  assert.ok(!fs.readFileSync(fileOf(), 'utf8').includes(A.home), 'the file holds no path of this computer');
});

test('one folder has one mark: a new one takes the place of the old; unmark takes it off', async () => {
  const r = await L.setMark({ dir: A.ws, home: A.home, kind: 'ignore', what: '~/.toolx' });
  assert.deepEqual([r.marks.keep, r.marks.ignore], [[], ['~/.toolx', '~/.tooly']]);
  const u = await L.unmark({ dir: A.ws, home: A.home, what: '~/.toolx' });
  assert.equal(u.ok, true);
  assert.deepEqual(u.marks.ignore, ['~/.tooly']);
  assert.deepEqual(asked(await look()), ['~/.toolx', '~/.toolz']);
  const none = await L.unmark({ dir: A.ws, home: A.home, what: '~/.toolx' });
  assert.equal(none.ok, false);
  assert.match(none.why, /has no mark/);
  assert.equal((await L.setMark({ dir: A.ws, home: A.home, kind: 'keep', what: '~/.toolx' })).ok, true);
});

test('outside is named once, "not checked, by your word", never counted and never walked', async () => {
  for (const what of ['~/.toolz', '~/Desktop/old']) assert.equal((await L.setMark({ dir: A.ws, home: A.home, kind: 'outside', what })).ok, true);
  const r = await look();
  assert.deepEqual(r.outside, [{ where: '~/.toolz', why: 'not checked, by your word' }, { where: '~/Desktop/old', why: 'not checked, by your word' }]);
  assert.deepEqual(asked(r), []);
  const text = JSON.stringify({ items: r.items, asks: r.asks, notChecked: r.notChecked });
  assert.ok(!/toolz|Desktop/.test(text), text);
  assert.ok(!JSON.stringify(r).includes('inside-name-w4'));
});

test('an outside folder inside a dot-folder is not walked: its size does not count for the dot-folder', async () => {
  sparse('.toolw/small.txt', 10);
  sparse('.toolw/archive/big.bin', 3 * MB);
  assert.ok(asked(await look()).includes('~/.toolw'), 'with the archive it is above the size');
  assert.equal((await L.setMark({ dir: A.ws, home: A.home, kind: 'outside', what: '~/.toolw/archive' })).ok, true);
  const r = await look();
  assert.ok(!asked(r).includes('~/.toolw'), 'without it, 10 bytes are not asked about');
  assert.ok(r.outside.some((o) => o.where === '~/.toolw/archive'));
  assert.equal((await L.unmark({ dir: A.ws, home: A.home, what: '~/.toolw/archive' })).ok, true);
  fs.rmSync(path.join(A.home, '.toolw'), { recursive: true });
});

test('keep and ignore are for dot-folders; testData names a known engine and takes it off the databases', async () => {
  const d = await L.setMark({ dir: A.ws, home: A.home, kind: 'keep', what: '~/Desktop/old' });
  assert.equal(d.ok, false);
  assert.match(d.why, /not a dot-folder of the home/);
  const bad = await L.setMark({ dir: A.ws, home: A.home, kind: 'testData', what: 'oracle' });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /not a database engine Hoprig knows/);
  const facts = { databases: [{ engine: 'postgresql', running: true, newestChange: new Date().toISOString() }] };
  assert.equal((await homeLook({ home: A.home, dir: A.ws, facts })).items.filter((i) => i.kind === 'database').length, 1);
  const t = await L.setMark({ dir: A.ws, home: A.home, kind: 'testData', what: 'PostgreSQL' });
  assert.equal(t.ok, true, t.why);
  assert.deepEqual(t.marks.testData, ['postgresql']);
  assert.equal((await homeLook({ home: A.home, dir: A.ws, facts })).items.filter((i) => i.kind === 'database').length, 0);
});

test('refused, each in one sentence, and nothing written: outside the home, "..", the host name, the home itself', async () => {
  const before = fs.readFileSync(fileOf(), 'utf8');
  const cases = [
    [path.join(w.root, 'elsewhere'), /outside your home folder/],
    ['/etc', /outside your home folder/],
    ['~/../beta', /without "\.\."/],
    ['~/.toolx/../.tooly', /without "\.\."/],
    ['~/.boxhost-data', /this computer's host name/],
    ['~/Desktop/BoxHost', /this computer's host name/],
    ['~', /the home folder itself/],
    ['~/.a\u0007b', /control character/],
    ['', /name a folder/],
  ];
  for (const [what, why] of cases) {
    const r = await L.setMark({ dir: A.ws, home: A.home, kind: 'outside', what });
    assert.equal(r.ok, false, JSON.stringify(what));
    assert.match(r.why, why, JSON.stringify(what));
    assert.ok(!r.why.includes('\n') && r.why.length < 300);
  }
  assert.equal((await L.setMark({ dir: A.ws, home: A.home, kind: 'other', what: '~/.toolx' })).ok, false);
  assert.equal(fs.readFileSync(fileOf(), 'utf8'), before);
});

test("the computer's file round-trips through its own checker; the strict check refuses bad marks", () => {
  const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
  const c = C.checkComputerFile(raw, 'alpha', 'boxhost');
  assert.equal(c.ok, true, c.why);
  const mine = C.computersHere(A.ws).files.find((f) => f.label === 'alpha');
  assert.deepEqual(mine.leave, { keep: ['~/.toolx'], ignore: ['~/.tooly'], outside: ['~/.toolz', '~/Desktop/old'], testData: ['postgresql'] });
  const text = C.fileContent({ label: raw.label, id: raw.id, here: raw.here, folders: raw.folders, leave: mine.leave });
  assert.equal(text, fs.readFileSync(fileOf(), 'utf8'), 'written again from what was read: the same bytes');
  const bad = (leave, host = 'boxhost') => C.checkComputerFile({ ...raw, leave }, 'alpha', host);
  for (const leave of [
    [],
    { keep: '~/.x' },
    { keep: ['/abs/path'] },
    { keep: ['.x'] },
    { outside: ['~/a/../b'] },
    { outside: ['~/a\nb'] },
    { ignore: ['~/'] },
    { keep: Array.from({ length: 501 }, (_, i) => `~/.t${i}`) },
    { testData: ['oracle'] },
    { other: [] },
    { keep: ['~/.boxhost'] },
  ]) assert.equal(bad(leave).ok, false, JSON.stringify(leave).slice(0, 80));
  assert.equal(bad({ keep: Array.from({ length: 500 }, (_, i) => `~/.t${i}`) }).ok, true, '500 is the most');
  // Another computer's file that names this host name is its own word: it still reads here.
  assert.equal(bad({ keep: ['~/.boxhost'] }, null).ok, true);
});

test('a file of the old form, without the key, still reads; the marks are kept when the file is written again', async () => {
  const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
  const old = { ...raw };
  delete old.leave;
  assert.equal(C.checkComputerFile(old, 'alpha', 'boxhost').ok, true);
  assert.ok(!C.fileContent({ ...old, leave: null }).includes('"leave"'));
  // The upkeep's own write (no marks handed in) keeps them.
  await C.writeOwnFile({ dir: A.ws, projects: A.projects });
  assert.deepEqual(JSON.parse(fs.readFileSync(fileOf(), 'utf8')).leave, raw.leave);
});
