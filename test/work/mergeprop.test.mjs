// The merge by item on 20,000 random triples (a common version and two computers' changes of it, with doubled ids,
// hand-written entries, moves, adds, edits, removals and keys beside the list): nothing either side added or changed
// is lost unless a conflict is shown; merging a version with itself gives it back; when only one side changed
// anything, the result is that side exactly, order included; both orders of the sides give the same items; the result
// is written back as it is read. A fixed seed: the same triples every run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeItems } from '../../src/work/merge.mjs';
import { formatOf, serialize, untidy } from '../../src/work/store.mjs';

test('20,000 random triples: nothing added or changed is lost without a conflict shown', () => {
  let seed = 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pickOne = (a) => a[Math.floor(rnd() * a.length)];
  const S = JSON.stringify;
  let uid = 0;
  const mk = (id) => ({ id, date: rnd() < 0.5 ? null : `2026-11-${String(10 + Math.floor(rnd() * 20))}`, title: `T${uid++}`, status: 'open', ...(rnd() < 0.2 ? { 'x-extra': uid } : {}) });
  const mutate = (list) => {
    const out = list.map((x) => (x && typeof x === 'object' ? { ...x } : x));
    for (let k = Math.floor(rnd() * 4); k > 0; k--) {
      const op = rnd();
      const at = Math.floor(rnd() * out.length);
      if (op < 0.3) out.splice(Math.floor(rnd() * (out.length + 1)), 0, mk(rnd() < 0.3 ? pickOne(['dup', 'new1', 'new2']) : `n${uid}`));
      else if (op < 0.55 && out.length) out[at] = typeof out[at] === 'object' ? { ...out[at], title: `E${uid++}` } : out[at];
      else if (op < 0.75 && out.length) out.splice(at, 1);
      else if (op < 0.85 && out.length > 1) out.splice(Math.floor(rnd() * (out.length - 1)), 0, ...out.splice(at, 1));
      else if (op < 0.9) out.push('a hand-written string');
      else if (out.length && typeof out[at] === 'object') out[at] = { ...out[at], status: 'done' };
    }
    return out;
  };
  const bag = (xs) => S(xs.map((x) => S(x)).sort());
  const noId = (x) => (x && typeof x === 'object' ? S({ ...x, id: undefined }) : S(x));
  const bad = { lost: 0, idem: 0, onlyMine: 0, onlyTheirs: 0, order: 0, notTidy: 0 };
  const first = {};
  const fail = (k, v) => {
    bad[k]++;
    first[k] ??= v;
  };
  const opts = { today: '2026-11-17' };
  let conflicted = 0;
  for (let run = 0; run < 20_000; run++) {
    const baseList = Array.from({ length: Math.floor(rnd() * 5) }, () => mk(rnd() < 0.2 ? 'dup' : `b${uid}`));
    const base = { items: baseList, ...(rnd() < 0.3 ? { updated: 'x' } : {}) };
    const mine = { ...base, items: mutate(baseList) };
    const theirs = { ...base, items: mutate(baseList) };
    if (rnd() < 0.2) theirs.updated = 'y';
    const a = mergeItems(base, mine, theirs, opts);
    const b = mergeItems(base, theirs, mine, opts);
    if (a.conflicts.length) conflicted++;
    const self = mergeItems(base, mine, mine, opts);
    if (S(self.doc) !== S(mine) || self.conflicts.length) fail('idem', { base, mine });
    const onlyMine = mergeItems(base, mine, base, opts);
    if (onlyMine.conflicts.length || S(onlyMine.doc) !== S(mine)) fail('onlyMine', { base, mine });
    const onlyTheirs = mergeItems(base, base, theirs, opts);
    if (onlyTheirs.conflicts.length || S(onlyTheirs.doc) !== S(theirs)) fail('onlyTheirs', { base, theirs });
    if (!a.conflicts.length && !b.conflicts.length && !a.renamed.length && !b.renamed.length && bag(a.doc.items || []) !== bag(b.doc.items || [])) fail('order', { base, mine, theirs });
    if (!a.conflicts.length) {
      const kept = new Set((a.doc.items || []).map(noId));
      const was = new Set(base.items.map((x) => S(x)));
      for (const side of [mine, theirs]) {
        const lost = side.items.find((x) => !was.has(S(x)) && !kept.has(noId(x)));
        if (lost !== undefined) fail('lost', { base: base.items, mine: mine.items, theirs: theirs.items, merged: a.doc.items, lost });
      }
    }
    if (untidy(serialize(a.doc, formatOf(''))).length) fail('notTidy', { doc: a.doc });
  }
  assert.deepEqual(bad, { lost: 0, idem: 0, onlyMine: 0, onlyTheirs: 0, order: 0, notTidy: 0 }, S(first).slice(0, 2000));
  assert.ok(conflicted > 1000, `conflicts are shown, not avoided (${conflicted})`);
});
