// A file a write would alter is never changed by itself: Work refuses the change, says what would be altered, and
// "Tidy the file once" shows the exact difference and writes it only on a yes; after that, changes work. Files that
// come back as they are (the planning tool's own output, one line, tabs, a byte-order mark) open and change at once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE, tempWork, write } from './helpers.mjs';

const t = tempWork('work-tidy');
test.after(() => t.cleanup());
const { workStore, serialize, formatOf } = await import('../../src/work/store.mjs');
const { wouldAlter, readTree, lineDiff } = await import('../../src/work/jsontext.mjs');
const { main } = await import('../../src/work/cli.mjs');

const settings = { timeZone: '', ownerId: 'alex', saveSubject: 'Update work items' };
const dir = path.join(t.root, 'files');
const one = (name, text) => {
  write(dir, { [`${name}.json`]: text });
  const file = path.join(dir, `${name}.json`);
  return { file, store: workStore({ file, settings }, { projects: [] }) };
};
const item = '{\n      "id": "a",\n      "title": "Aaa"\n    }';
const stat = (f) => {
  const s = fs.statSync(f);
  return [s.ino, s.mtimeMs];
};

test('files a write would alter: the change is refused, the bytes stay, and the reason is named', async () => {
  const cases = {
    inline: ['{\n  "items": [\n    { "id": "a", "title": "Aaa", "brands": ["x", "y"] }\n  ]\n}\n', ['layout']],
    numbers: [`{\n  "v": 1.0,\n  "big": 12345678901234567890,\n  "e": 1e3,\n  "items": [\n    ${item}\n  ]\n}\n`, ['number', 'number', 'number']],
    escapes: [`{\n  "u": "\\u00e9\\/",\n  "items": [\n    ${item}\n  ]\n}\n`, ['escape']],
    doubled: ['{\n  "items": [\n    {\n      "id": "a",\n      "title": "Aaa",\n      "note": "first",\n      "note": "second"\n    }\n  ]\n}\n', ['key']],
    lineEnds: [`{\r\n  "items": [\n    ${item}\n  ]\n}\n`, ['line-ends']],
  };
  for (const [name, [text, kinds]] of Object.entries(cases)) {
    const { file, store } = one(name, text);
    const before = stat(file);
    await assert.rejects(store.edit('a', { note: 'n' }), (e) => e.status === 409 && e.code === 'untidy', name);
    await assert.rejects(store.add({ title: 'Something new' }), (e) => e.code === 'untidy', name);
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${name}: not a byte changed`);
    assert.deepEqual(stat(file), before, `${name}: not even written`);
    assert.deepEqual(store.list().untidy.map((a) => a.kind), kinds, name);
  }
  const numbers = wouldAlter(cases.numbers[0], formatOf(cases.numbers[0]));
  assert.deepEqual(numbers.map((a) => [a.path, a.from, a.to]), [['v', '1.0', '1'], ['big', '12345678901234567890', '12345678901234567000'], ['e', '1e3', '1000']]);
  assert.deepEqual(wouldAlter(cases.doubled[0], formatOf(cases.doubled[0])).map((a) => a.path), ['items[0].note']);
});

test('files that come back as they are open and change at once: the planning tool\'s, one line, tabs, a byte-order mark', async () => {
  const texts = {
    planner: fs.readFileSync(FIXTURE, 'utf8'),
    oneLine: '{"items":[{"id":"a","title":"Aaa"}]}\n',
    tabs: `{\n\t"items": [\n\t\t{\n\t\t\t"id": "a",\n\t\t\t"title": "Aaa"\n\t\t}\n\t]\n}`,
    bom: `﻿{\n  "items": [\n    ${item}\n  ]\n}\n`,
  };
  for (const [name, text] of Object.entries(texts)) {
    const { file, store } = one(name, text);
    assert.deepEqual(store.list().untidy, [], name);
    const id = JSON.parse(text.replace(/^﻿/, '')).items[0].id;
    await store.edit(id, { note: 'A note' });
    const after = fs.readFileSync(file, 'utf8');
    const expected = JSON.parse(text.replace(/^﻿/, ''));
    expected.items[0].note = 'A note';
    assert.equal(after, serialize(expected, formatOf(text)), name);
    assert.equal(after.startsWith('﻿'), name === 'bom', `${name}: the mark kept as it was`);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'oneLine.json'), 'utf8'), '{"items":[{"id":"a","title":"Aaa","note":"A note"}]}\n');
});

test('Tidy the file once: the exact difference first, written only with its hash; then changes work', async () => {
  const text = `{\n  "v": 1.0,\n  "items": [\n    { "id": "a", "title": "Aaa" }\n  ]\n}\n`;
  const { file, store } = one('tidyme', text);
  const plan = store.tidyPlan();
  assert.deepEqual(plan.alters.map((a) => a.kind), ['number', 'layout']);
  assert.deepEqual(plan.diff.filter((d) => d.op === '+' || d.op === '-').map((d) => `${d.op}${d.text}`), ['-  "v": 1.0,', '+  "v": 1,', '-    { "id": "a", "title": "Aaa" }', '+    {', '+      "id": "a",', '+      "title": "Aaa"', '+    }']);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'looking writes nothing');
  await assert.rejects(store.tidy('0'.repeat(32)), (e) => e.code === 'moved');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  const r = await store.tidy(plan.hash);
  assert.equal(r.written, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "v": 1,\n  "items": [\n    {\n      "id": "a",\n      "title": "Aaa"\n    }\n  ]\n}\n');
  await store.edit('a', { note: 'Now it changes' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].note, 'Now it changes');
});

test('hoprig tasks tidy: --dry-run shows the difference and writes nothing; without a yes it refuses; --yes writes', async () => {
  const brain = path.join(t.brain, 'work');
  write(brain, { 'tasks.json': '{\n  "items": [ { "id": "a", "title": "Aaa" } ]\n}\n' });
  const file = path.join(brain, 'tasks.json');
  const before = fs.readFileSync(file, 'utf8');
  const run = async (...args) => {
    let out = '';
    let err = '';
    const code = await main(args, { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`), ask: null });
    return { code, out, err };
  };
  let r = await run('tidy', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Tidying ai_brain\/work\/tasks\.json once would change:\n {2}- spaces and line breaks/);
  assert.match(r.out, /^- {4}2 {4}"items": \[ \{ "id": "a", "title": "Aaa" \} \]$/m);
  assert.match(r.out, /\(dry run: nothing written\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  r = await run('tidy');
  assert.equal(r.code, 2);
  assert.match(r.err, /tidy writes only on a yes/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  r = await run('tidy', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "items": [\n    {\n      "id": "a",\n      "title": "Aaa"\n    }\n  ]\n}\n');
  assert.equal((await run('tidy')).code, 0, 'nothing left to tidy');
});

test('the reader: where a broken file breaks, by line and column; the diff of long files', () => {
  assert.throws(() => readTree('{\n  "items": [1,]\n}'), (e) => e.line === 2 && e.column === 15);
  assert.throws(() => readTree('{"a": 01}'), (e) => e.line === 1);
  assert.throws(() => readTree('{"a": "x\ty"}'), (e) => e.column === 9, 'a raw tab in a string is no JSON');
  const a = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 100', 'line one hundred');
  assert.deepEqual(lineDiff(a, b).map((d) => d.op).join(''), '…  -+  …');
});

test('bytes that are not UTF-8 make the file "needs a tidy" with that reason; nothing is written before the yes', async () => {
  const bytes = Buffer.concat([Buffer.from('{\n  "items": [\n    {\n      "id": "cafe",\n      "title": "Caf'), Buffer.from([0xe9]), Buffer.from('"\n    },\n    {\n      "id": "b",\n      "title": "Bbb"\n    }\n  ]\n}\n')]);
  const file = path.join(dir, 'latin1.json');
  fs.writeFileSync(file, bytes);
  const store = workStore({ file, settings }, { projects: [] });
  assert.deepEqual(store.list().untidy, [{ kind: 'bytes', line: 5 }]);
  await assert.rejects(store.status('b', 'done'), (e) => e.code === 'untidy' && /not UTF-8 \(the first at line 5\)/.test(e.message));
  assert.ok(fs.readFileSync(file).equals(bytes), 'not a byte changed');
  // The sheet shows the byte as it is, and what a write puts in its place.
  const plan = store.tidyPlan();
  assert.deepEqual(plan.diff.filter((d) => d.op === '-' || d.op === '+').map((d) => `${d.op}${d.text}`), ['-      "title": "Caf\\xE9"', '+      "title": "Caf�"']);
  assert.ok(fs.readFileSync(file).equals(bytes));
  await store.tidy(plan.hash);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].title, 'Caf�');
  await store.status('b', 'done');
});

test('a file nested deeper, or with a longer number, than Work reads is refused plainly; nothing is written', async () => {
  for (const [name, text, why] of [
    ['deep', `{\n  "items": [],\n  "d": ${'['.repeat(5000)}${']'.repeat(5000)}\n}\n`, /tasks-deep\.json is nested more than 100 levels deep \(at line 3\): Work reads lists of tasks and changes nothing in this file/],
    ['long', `{\n  "items": [],\n  "n": 1${'0'.repeat(450)}\n}\n`, /tasks-long\.json has a number longer than 400 characters \(at line 3\), which JSON cannot hold exactly/],
    ['broken-deep', `{"items": ${'['.repeat(200000)}`, /tasks-broken-deep\.json is nested more than 100 levels deep/],
  ]) {
    const { file, store } = one(`tasks-${name}`, text);
    assert.throws(() => store.list(), (e) => e.status === 409 && e.details.code === 'limits' && why.test(e.message), name);
    await assert.rejects(store.add({ title: 'Something new' }), (e) => e.status === 409 && why.test(e.message), name);
    assert.throws(() => store.tidyPlan(), (e) => e.status === 409, name);
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${name}: not a byte changed`);
  }
});

test('the tidy sheet says how much of the difference it shows; the command shows all of it', async () => {
  const long = 'x'.repeat(500);
  const items = Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, title: `Plan item ${i}`, ...(i === 0 ? { note: long } : {}) }));
  const text = `{\n  "items": ${JSON.stringify(items)}\n}\n`; // the list on one line: a write spreads it over lines
  const { store } = one('wide', text);
  const plan = store.tidyPlan();
  assert.equal(plan.cut, true);
  assert.ok(plan.changed > 2000, String(plan.changed));
  assert.ok(plan.shownChanged < plan.changed && plan.shownChanged >= 390, String(plan.shownChanged));
  const full = store.tidyPlan({ full: true });
  assert.equal(full.cut, false);
  assert.equal(full.shownChanged, plan.changed);
  assert.ok(full.diff.some((d) => d.text.includes(long)), 'no line cut');
  // The command: --dry-run prints every changed line, whole.
  const brain = path.join(t.brain, 'work');
  write(brain, { 'tasks.json': text });
  let out = '';
  assert.equal(await main(['tidy', '--dry-run'], { out: (s) => (out += `${s}\n`), err: () => {}, ask: null }), 0);
  assert.equal(out.split('\n').filter((l) => /^[+-] /.test(l)).length, plan.changed);
  assert.ok(out.includes(long));
});
