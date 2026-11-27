// The judgement of the browser drive's layout guard (tools/app-chat-guard.mjs), fed made-up boxes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, line } from '../../tools/app-chat-guard.mjs';

const WIN = { w: 1000, h: 800, scrollW: 1000 };
const box = (part, x, y, w, h, extra = {}) => ({ part, x, y, w, h, up: [], ...extra });
const kinds = (faults) => faults.map((f) => `${f.part}: ${f.kind} ${f.px}`);

test('a part inside its column and the window is clean', () => {
  const col = box('column', 100, 0, 600, 800);
  const msg = box('message', 100, 10, 600, 40, { up: [0] });
  const nested = box('text', 110, 12, 500, 20, { up: [1, 0] });
  assert.deepEqual(judge([col, msg, nested], WIN), []);
});

test('one pixel outside its column is a fault, the sub-pixel rounding is not', () => {
  const col = box('column', 100, 0, 600, 800);
  assert.deepEqual(kinds(judge([col, box('bubble', 100, 10, 601, 40, { up: [0] })], WIN)), ['bubble: outside its column (right) 1']);
  assert.deepEqual(kinds(judge([col, box('bubble', 99, 10, 600, 40, { up: [0] })], WIN)), ['bubble: outside its column (left) 1']);
  assert.deepEqual(judge([col, box('bubble', 100, 10, 600.5, 40, { up: [0] })], WIN), []);
});

test('a part outside the window and a page that scrolls sideways', () => {
  assert.deepEqual(kinds(judge([box('panel', 900, 0, 101, 800)], WIN)), ['panel: outside the window (right) 1']);
  assert.deepEqual(kinds(judge([box('panel', -3, 0, 100, 800)], WIN)), ['panel: outside the window (left) 3']);
  assert.deepEqual(kinds(judge([], { ...WIN, scrollW: 1040 })), ['the page: scrolls sideways 40']);
});

test('two parts that are not parent and child must not overlap', () => {
  const a = box('queue', 100, 100, 500, 100);
  const b = box('panel', 590, 100, 200, 100);
  assert.deepEqual(kinds(judge([a, b], WIN)), ['queue: overlaps 10']);
  assert.deepEqual(judge([a, box('panel', 600, 100, 200, 100)], WIN), []); // touching is not overlapping
  assert.deepEqual(judge([a, box('panel', 590, 100, 200, 100, { overlay: true })], WIN), []); // a menu floats on purpose
});

test('parent and child nested may share space, a sideways scroller may hold wide content', () => {
  const p = box('message', 100, 0, 300, 100);
  const c = box('code', 100, 10, 300, 40, { up: [0] });
  assert.deepEqual(judge([p, c], WIN), []);
  const code = box('code block', 100, 0, 300, 40, { scroller: true });
  assert.deepEqual(judge([code, box('line', 100, 0, 900, 20, { up: [0] })], WIN), []);
});

test('a wide part inside a container that only clips is cut off, and what is clipped away cannot overlap', () => {
  const wrap = box('table wrap', 100, 0, 400, 100);
  const table = box('table', 100, 10, 1200, 80, { up: [0], cx: 100, cw: 400 });
  const panel = box('panel', 700, 0, 200, 100);
  assert.deepEqual(kinds(judge([wrap, table, panel], WIN)), ['table: cut off by its container 800']);
});

test('a column that scrolls sideways by itself is a fault unless it is meant to', () => {
  assert.deepEqual(kinds(judge([box('message list', 0, 0, 500, 500, { sideways: 120 })], WIN)), ['message list: scrolls sideways inside 120']);
  assert.deepEqual(judge([box('code block', 0, 0, 500, 50, { sideways: 120, scroller: true })], WIN), []);
});

test('cut text needs an ellipsis or a way to read it whole', () => {
  assert.equal(judge([box('title', 0, 0, 100, 20, { cutX: 30 })], WIN).length, 1);
  assert.deepEqual(judge([box('title', 0, 0, 100, 20, { cutX: 30, ellipsis: true })], WIN), []);
  assert.deepEqual(judge([box('title', 0, 0, 100, 20, { cutY: 30, way: true })], WIN), []);
});

test('a picture lies inside its button with a margin', () => {
  const btn = (icon) => box('button', 100, 100, 32, 32, { icon });
  assert.deepEqual(judge([btn({ x: 108, y: 108, w: 16, h: 16 })], WIN), []);
  assert.deepEqual(kinds(judge([btn({ x: 101, y: 108, w: 16, h: 16 })], WIN)), ['button: its picture has no margin in the button 1']);
  assert.equal(judge([btn({ x: 100, y: 100, w: 40, h: 16 })], WIN).length, 1); // leaves the button
  assert.deepEqual(kinds(judge([btn({ x: 108, y: 108, w: 0, h: 0, empty: true })], WIN)), ['button: its picture is empty 1']);
});

test('a part with no size is not judged, a fault is one line', () => {
  assert.deepEqual(judge([box('gone', 5000, 0, 0, 0)], WIN), []);
  assert.equal(line('queue', 1440, { part: 'a queued bubble', kind: 'outside its column (right)', px: 12 }), 'FAULT queue | 1440 | a queued bubble | outside its column (right) | by 12px');
});

test('a phone: a field under 16 px lets the phone zoom in, and a page wider than its width is a fault', () => {
  const PH = { w: 393, h: 852, scrollW: 393, touch: true };
  assert.deepEqual(judge([], { ...PH, fields: [{ part: 'the text field', fs: 16 }, { part: 'the rename box', fs: 17 }] }), []);
  assert.deepEqual(kinds(judge([], { ...PH, fields: [{ part: 'the text field', fs: 14 }] })), ['the text field: text size under 16 px on a touch screen 2']);
  // not a touch screen: the size is not judged
  assert.deepEqual(judge([], { ...WIN, fields: [{ part: 'the text field', fs: 14 }] }), []);
  assert.deepEqual(kinds(judge([], { ...PH, bodyScrollW: 420 })), ['the page body: scrolls sideways 27']);
});
