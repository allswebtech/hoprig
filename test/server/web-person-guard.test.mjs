// The guard that protects a person on every page: no sideways scroll, nothing cut, a press target a finger can hit.
// It counts nothing and limits nothing (no number of things on a screen, of menu items or of tabs). What needs a real
// layout is measured by tools/person-guard.mjs in a browser on the built-in demo; this file pins that tool's judging
// with made-up measurements, and checks that its known list (what the pages already had when it was written) is well
// formed. A break that is not in the list fails the tool; a known one that is gone is only reported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { KNOWN_FILE, RULES, fresh, judge, keyOf, line } from '../../tools/person-guard.mjs';

const clean = { w: 393, sideways: 0, cut: [], small: [] };

test('a clean page passes at both sizes', () => {
  assert.deepEqual(judge(clean, { phone: true }), []);
  assert.deepEqual(judge(clean, { phone: false }), []);
  assert.deepEqual(judge({ none: true }, { phone: true }), []);
});

test('a page that scrolls sideways is named, by a pixel or more', () => {
  assert.equal(judge({ ...clean, sideways: 0.5 }, { phone: true }).length, 0);
  const f = judge({ ...clean, sideways: 38 }, { phone: true });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'sideways');
  assert.match(f[0].text, /38px/);
});

test('a part that is cut is named, at either size', () => {
  const m = { ...clean, cut: ['span.row-sub Now: a long model passes the window'] };
  for (const phone of [true, false]) {
    const f = judge(m, { phone });
    assert.equal(f.length, 1);
    assert.equal(f[0].rule, 'cut');
    assert.match(f[0].text, /passes the window/);
  }
});

test('a small press target is named on a phone only', () => {
  const m = { ...clean, small: ['Save button.btn', 'a check box input'] };
  const f = judge(m, { phone: true });
  assert.deepEqual(f.map((x) => x.rule), ['touch', 'touch']);
  assert.match(f[0].text, /under 44x44/);
  assert.deepEqual(judge(m, { phone: false }), []);
});

test('nothing is counted: a page full of things, with a long menu and many tabs, still passes', () => {
  const m = { ...clean, controls: 400, screens: 12, menu: { bar: 9, side: 14, more: 1, groupTitles: 2 }, tabs: [{ n: 7, slides: 0 }], openFolds: ['A', 'B'], longLists: ['LI.row x60'], repeated: ['save x2'] };
  assert.deepEqual(judge(m, { phone: true }), []);
});

test('a known break does not fail, a new one does', () => {
  const x = { rule: 'touch', item: 'Save button.btn', text: '' };
  const k = keyOf('393x852', '#/work', x);
  assert.equal(k, '393x852 | #/work | touch | Save button.btn');
  assert.deepEqual(fresh([k], [k]), []);
  assert.deepEqual(fresh([k, keyOf('393x852', '#/work', { ...x, item: 'Add button.btn' })], [k]), ['393x852 | #/work | touch | Add button.btn']);
});

test('a line says ok or BREAK with the faults', () => {
  assert.match(line('393x852', '#/', []), /^ok /);
  assert.match(line('393x852', '#/', [{ rule: 'sideways', text: 'scrolls sideways by 9px' }]), /^BREAK .*sideways: scrolls sideways by 9px/);
});

test('the known list is well formed: sorted, no duplicate, each key has a size, a page, a rule and its part', () => {
  const known = JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'));
  assert.ok(Array.isArray(known));
  assert.deepEqual(known, [...new Set(known)].sort());
  for (const k of known) {
    const [size, addr, rule, ...item] = k.split(' | ');
    assert.match(size, /^\d+x\d+$/, k);
    assert.match(addr, /^#\//, k);
    assert.ok(RULES.includes(rule), k);
    if (rule !== 'sideways') assert.ok(item.join(' | ').length > 0, k);
    if (rule === 'touch') assert.equal(size, '393x852', k);
  }
});

test('the guard has no counting rule left', () => {
  const src = fs.readFileSync(new URL('../../tools/person-guard.mjs', import.meta.url), 'utf8');
  assert.deepEqual(RULES, ['sideways', 'cut', 'touch']);
  assert.doesNotMatch(src, /LIMITS|OPENS_ITS_PART|LONG_BY_NATURE|barMenu|wideMenu|introLines|longLists/);
});

test('the key of a break does not hold a number that moves between demo runs', () => {
  const a = keyOf('393x852', '#/operator', { rule: 'touch', item: 'Open the run: Work run 20261127-184722-7 a.btn' });
  const b = keyOf('393x852', '#/operator', { rule: 'touch', item: 'Open the run: Work run 20261128-090101-7 a.btn' });
  assert.equal(a, b);
  assert.equal(keyOf('393x852', '#/workspace', { rule: 'touch', item: 'Earlier conversations (2)' }), keyOf('393x852', '#/workspace', { rule: 'touch', item: 'Earlier conversations (7)' }));
});
