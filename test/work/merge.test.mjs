// Merging by item (merge.mjs), as a pure function of three versions of the list: one side's change wins over no
// change; adds on both sides are kept (a clash of ids gets a new id); a removal wins over no change; two different
// changes are a conflict the owner decides per item; the file's other keys merge by the same rule; the order is the
// server's with this computer's new items placed by date (one side's list as it stands when only it changed);
// doubled ids are one group.
import assert from 'node:assert/strict';
import test from 'node:test';
import { itemChanges, keyed, mergeItems } from '../../src/work/merge.mjs';

const it = (id, extra = {}) => ({ id, date: null, title: `Task ${id}`, status: 'open', ...extra });
const doc = (items, extra = {}) => ({ ...extra, items });
const ids = (d) => d.items.map((x) => x.id);
const clone = (x) => JSON.parse(JSON.stringify(x));

test('a change on one side takes that side; the same change on both is that change', () => {
  const base = doc([it('a'), it('b'), it('c')]);
  const mine = clone(base);
  mine.items[0].status = 'done';
  const theirs = clone(base);
  theirs.items[1].title = 'Task b, renamed elsewhere';
  theirs.items[2].note = 'same on both';
  mine.items[2].note = 'same on both';
  const r = mergeItems(base, mine, theirs);
  assert.equal(r.undecided, 0);
  assert.deepEqual(r.doc.items, [it('a', { status: 'done' }), it('b', { title: 'Task b, renamed elsewhere' }), it('c', { note: 'same on both' })]);
  assert.deepEqual(r.mine.map((c) => [c.id, c.what]), [['a', 'done'], ['c', 'changed']]);
  assert.deepEqual(r.theirs.map((c) => [c.id, c.what]), [['b', 'changed'], ['c', 'changed']]);
});

test('adds on both sides are kept; two different new items with one id: this computer\'s gets a new id', () => {
  const base = doc([it('a', { date: '2026-12-01' }), it('z', { date: '2026-12-20' })]);
  const mine = clone(base);
  mine.items.splice(1, 0, it('mine-new', { date: '2026-12-10' }), it('same-title', { date: '2026-12-11', note: 'from here' }));
  const theirs = clone(base);
  theirs.items.push(it('theirs-new', { date: '2026-12-05' }), it('same-title', { date: '2026-12-11', note: 'from there' }));
  const r = mergeItems(base, mine, theirs, { today: '2026-11-17' });
  assert.equal(r.undecided, 0);
  assert.deepEqual(r.renamed, [{ from: 'same-title', to: 'same-title-2' }]);
  // The server's order; this computer's new items placed by date (before the first later item).
  assert.deepEqual(ids(r.doc), ['a', 'mine-new', 'same-title-2', 'z', 'theirs-new', 'same-title']);
  assert.equal(r.doc.items.find((x) => x.id === 'same-title').note, 'from there');
  assert.equal(r.doc.items.find((x) => x.id === 'same-title-2').note, 'from here');
  // Added the same on both sides: one.
  const both = mergeItems(base, doc([...base.items, it('n')]), doc([...base.items, it('n')]));
  assert.deepEqual(ids(both.doc), ['a', 'z', 'n']);
});

test('a removal on one side wins over no change; against a change it is a conflict', () => {
  const base = doc([it('a'), it('b'), it('c'), it('d')]);
  const mine = doc([it('a', { status: 'done' }), it('c'), it('d')]); // b removed here, a changed
  const theirs = doc([it('b'), it('c', { status: 'done' })]); // a and d removed there, c changed
  const r = mergeItems(base, mine, theirs);
  assert.deepEqual(r.conflicts.map((c) => [c.name, !!c.mine, !!c.theirs]), [['a', true, false]], 'a: changed here, removed there');
  assert.deepEqual(ids(r.doc), ['c'], 'b removed here, d removed there; a undecided keeps the server\'s (removed)');
  assert.equal(r.doc.items[0].status, 'done');
  const kept = mergeItems(base, mine, theirs, { decisions: { 'a#0': 'mine' } });
  assert.equal(kept.undecided, 0);
  assert.deepEqual(ids(kept.doc), ['c', 'a']);
  // Removed here, changed there: the owner decides too.
  const r2 = mergeItems(base, doc([it('a'), it('c'), it('d')]), doc([it('a'), it('b', { note: 'there' }), it('c'), it('d')]));
  assert.deepEqual(r2.conflicts.map((c) => [c.name, c.mine, !!c.theirs]), [['b', null, true]]);
  assert.deepEqual(ids(mergeItems(base, doc([it('a'), it('c'), it('d')]), doc([it('a'), it('b', { note: 'there' }), it('c'), it('d')]), { decisions: { 'b#0': 'mine' } }).doc), ['a', 'c', 'd']);
});

test('two different changes of one item: a conflict, decided per item; until then the server\'s stays', () => {
  const base = doc([it('a'), it('b')]);
  const mine = doc([it('a', { title: 'Mine' }), it('b', { status: 'done' })]);
  const theirs = doc([it('a', { title: 'Theirs' }), it('b', { status: 'dropped' })]);
  const r = mergeItems(base, mine, theirs);
  assert.equal(r.undecided, 2);
  assert.deepEqual(r.conflicts.map((c) => [c.key, c.mine.title, c.theirs.title]), [['a#0', 'Mine', 'Theirs'], ['b#0', 'Task b', 'Task b']]);
  assert.deepEqual(r.doc.items, theirs.items);
  const d = mergeItems(base, mine, theirs, { decisions: { 'a#0': 'mine', 'b#0': 'theirs' } });
  assert.equal(d.undecided, 0);
  assert.deepEqual(d.doc.items, [it('a', { title: 'Mine' }), it('b', { status: 'dropped' })]);
});

test('the keys Work does not know merge by the same rule, in the server\'s order', () => {
  const base = { updated: '2026-11-01', owner: 'x', items: [it('a')] };
  const mine = { updated: '2026-11-02', owner: 'x', items: [it('a')], extra: 1 };
  const theirs = { owner: 'y', updated: '2026-11-01', items: [it('a')] };
  const r = mergeItems(base, mine, theirs);
  assert.deepEqual(Object.keys(r.doc), ['owner', 'updated', 'items', 'extra']);
  assert.deepEqual(r.doc, { owner: 'y', updated: '2026-11-02', items: [it('a')], extra: 1 });
  const c = mergeItems(base, { ...mine, owner: 'z' }, theirs);
  assert.deepEqual(c.conflicts.map((x) => x.key), ['key:owner']);
  assert.equal(mergeItems(base, { ...mine, owner: 'z' }, theirs, { decisions: { 'key:owner': 'mine' } }).doc.owner, 'z');
});

test('an id that two items share is never merged item by item: the group is one value, decided by the owner', () => {
  const A = it('x', { title: 'A' });
  const B = it('x', { title: 'B' });
  const base = doc([A, B, it('y'), 'a note written by hand']);
  assert.deepEqual(keyed(base).map((e) => e.key), ['x#0', 'x#1', 'y#0', '~"a note written by hand"#0']);
  // Both sides changed the two "x" differently (here A was removed, there A was changed): one conflict for the group,
  // with every item of it on both sides; pairing by place would have offered B against "A edited".
  const r = mergeItems(base, doc([B, it('y'), 'a note written by hand']), doc([it('x', { title: 'A edited' }), B, it('y'), 'a note written by hand']));
  assert.deepEqual(r.conflicts.map((c) => [c.key, c.name, c.mine.map((x) => x.title), c.theirs.map((x) => x.title)]), [['x#*', 'x', ['B'], ['A edited', 'B']]]);
  const mine = mergeItems(base, doc([B, it('y'), 'a note written by hand']), doc([it('x', { title: 'A edited' }), B, it('y'), 'a note written by hand']), { decisions: { x: 'mine' } });
  assert.deepEqual(mine.doc.items.map((x) => x.title || x), ['B', 'Task y', 'a note written by hand']);
  // Here A removed, there B removed: never "nothing left" by itself, the owner chooses.
  const two = mergeItems(base, doc([B, it('y')]), doc([A, it('y')]));
  assert.deepEqual(two.conflicts.map((c) => c.key), ['x#*']);
  // Here A removed, there only y changed: the group as this computer left it, the rest merged as usual.
  const one = mergeItems(base, doc([B, it('y'), 'a note written by hand']), doc([A, B, it('y', { status: 'done' }), 'a note written by hand']));
  assert.equal(one.undecided, 0);
  assert.deepEqual(one.doc.items.map((x) => x.title ? `${x.title}:${x.status}` : x), ['B:open', 'Task y:done', 'a note written by hand']);
  // A doubled id in this computer's version only (added twice here), the server changed something else: both kept.
  const added = mergeItems(doc([it('y')]), doc([it('y'), it('n', { title: 'N1' }), it('n', { title: 'N2' })]), doc([it('y', { status: 'done' })]));
  assert.deepEqual(added.doc.items.map((x) => x.title), ['Task y', 'N1', 'N2']);
});

test('only this computer changed the list: the result is its list as it stands, its order included', () => {
  const base = doc([it('a', { date: '2026-12-01' }), it('b', { date: '2026-12-02' })]);
  const mine = doc([it('new', { date: '2026-12-09' }), it('b', { date: '2026-12-02' }), it('a', { date: '2026-12-01', status: 'done' })]);
  const r = mergeItems(base, mine, clone(base));
  assert.equal(r.undecided, 0);
  assert.deepEqual(r.doc, mine);
  assert.deepEqual(mergeItems(base, clone(base), mine).doc, mine, 'and the other way round');
});

test('the changes of a version list every changed item, doubled ids too; a new id is said as such', () => {
  const before = doc([it('d'), it('d'), it('e')]);
  const after = doc([it('d', { status: 'done' }), it('d', { status: 'done' }), it('e')]);
  assert.deepEqual(itemChanges(before, after).map((c) => [c.key, c.what]), [['d#0', 'done'], ['d#1', 'done']]);
  const fixed = doc([it('d'), { ...it('d'), id: 'd-2' }, it('e')]);
  assert.deepEqual(itemChanges(before, fixed).map((c) => [c.id, c.what, c.from]), [['d-2', 'new id', 'd']]);
});

test('a version without a list of items is not merged', () => {
  assert.throws(() => mergeItems(doc([]), { items: 5 }, doc([])), (e) => e.code === 'unmergeable');
});
