// The proof's rule for a file's time (src/adopt/proof.mjs sameTime): the same whole second, or less than 2 ms apart.
// Made-up times at a second's edge; the listings are made up too, so no file system's precision is in the way.
import assert from 'node:assert/strict';
import test from 'node:test';
import { treeDiff } from '../../src/adopt/proof.mjs';

const EDGE = 1_795_000_001_000; // a full second, in milliseconds
const listing = (ms) => ({ entries: { 'a.txt': `file 3 644 ${ms} made-up-hash` } });
const same = (a, b) => treeDiff(listing(a), listing(b)).length === 0;

test('two times at a second\'s edge less than 2 ms apart are the same; 2 ms or more across it are not', () => {
  assert.equal(same(EDGE - 0.4, EDGE), true, '0.4 ms below the edge, the copy on it');
  assert.equal(same(EDGE, EDGE + 0.4), true, '0.4 ms above it');
  assert.equal(same(EDGE - 0.95, EDGE + 0.95), true, '1.9 ms across it');
  assert.equal(same(EDGE - 1.05, EDGE + 1.05), false, '2.1 ms across it');
  assert.equal(same(EDGE + 100, EDGE + 1100), false, 'a whole second apart');
  assert.equal(same(EDGE + 100, EDGE + 60_100), false, 'a minute apart');
});

test('a file system that keeps whole seconds only: a time and its second are the same', () => {
  assert.equal(same(EDGE + 999.7, EDGE), true);
  assert.equal(same(EDGE + 500, EDGE + 1000), false, 'a time of the next second, 500 ms away, is not');
});

test('only the time may differ that way: size, mode, content and kind still do', () => {
  const at = EDGE - 0.4;
  const diff = (x, y) => treeDiff({ entries: { a: x } }, { entries: { a: y } }).length;
  assert.equal(diff(`file 3 644 ${at} h`, `file 4 644 ${EDGE} h`), 1, 'size');
  assert.equal(diff(`file 3 644 ${at} h`, `file 3 600 ${EDGE} h`), 1, 'mode');
  assert.equal(diff(`file 3 644 ${at} h`, `file 3 644 ${EDGE} other`), 1, 'content');
  assert.equal(diff(`file 3 644 ${at} h`, `link ${at}`), 1, 'kind');
  assert.equal(diff(`file 3 644 ${at} h`, null), 1, 'missing');
});
