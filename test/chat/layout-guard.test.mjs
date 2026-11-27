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

// ---- the phone checks (round 27b) ----
const PH = { w: 393, h: 852, scrollW: 393, bodyScrollW: 393, touch: true };

test('a touch screen: every press target in the bar, the foot and the tail is at least 44 by 44', () => {
  const b = (w, h) => box('a button', 10, 10, w, h, { tap: true });
  assert.deepEqual(judge([b(44, 44)], PH), []);
  assert.deepEqual(kinds(judge([b(38, 44)], PH)), ['a button: press target under 44 px 6']);
  assert.deepEqual(kinds(judge([b(44, 40)], PH)), ['a button: press target under 44 px 4']);
  assert.deepEqual(judge([b(43.8, 44)], PH), [], 'the rounding of the browser');
  assert.deepEqual(judge([b(30, 30)], { ...WIN }), [], 'a mouse screen: not judged');
});

test('a round button is a circle: width equal to height', () => {
  assert.deepEqual(judge([box('send', 10, 10, 44, 44, { round: true })], PH), []);
  assert.deepEqual(kinds(judge([box('send', 10, 10, 38, 44, { round: true })], PH)), ['send: a round button that is an oval 6']);
  assert.deepEqual(judge([box('chip', 10, 10, 90, 44)], PH), [], 'a pill that is not drawn as a circle may be wide');
});

test('text meant for one line is on one line', () => {
  assert.deepEqual(judge([box('the title text', 10, 10, 200, 22, { oneLine: true, lines: 1 })], PH), []);
  assert.deepEqual(kinds(judge([box('the title text', 10, 10, 200, 44, { oneLine: true, lines: 2 })], PH)), ['the title text: text on more than one line 1']);
});

test('the foot is at most 100 px at rest and 150 with a background tasks line; the conversation keeps its room with the keyboard open', () => {
  assert.deepEqual(judge([], { ...PH, foot: { h: 100, bg: false } }), []);
  assert.deepEqual(kinds(judge([], { ...PH, foot: { h: 146, bg: false } })), ['the foot: taller than 100 px 46']);
  assert.deepEqual(judge([], { ...PH, foot: { h: 150, bg: true } }), []);
  assert.deepEqual(kinds(judge([], { ...PH, foot: { h: 196, bg: true } })), ['the foot: taller than 150 px 46']);
  assert.deepEqual(judge([], { ...WIN, foot: { h: 300, bg: false } }), [], 'not a phone');
  const KB = { ...PH, h: 450 };
  assert.deepEqual(judge([], { ...KB, conv: { h: 294, bg: false } }), []);
  assert.deepEqual(kinds(judge([], { ...KB, conv: { h: 248, bg: false } })), ['the conversation: under 294 px high with the keyboard open 46']);
  assert.deepEqual(judge([], { ...KB, conv: { h: 244, bg: true } }), []);
  assert.deepEqual(judge([], { ...PH, conv: { h: 248, bg: false } }), [], 'only with the keyboard open');
});

test('the status is the living line in the conversation; no line under the box; no key named on a touch screen; nothing beside a sent message', () => {
  assert.deepEqual(judge([], { ...PH, live: { present: true, last: true }, oldStatus: false, esc: [], beside: [] }), []);
  assert.deepEqual(kinds(judge([], { ...PH, live: { present: true, last: false } })), ['the living line: is not the last thing before the queued messages 1']);
  assert.deepEqual(kinds(judge([], { ...PH, oldStatus: true })), ['the line under the box: still drawn 1']);
  assert.deepEqual(kinds(judge([], { ...PH, esc: ['the placeholder'] })), ['the placeholder: names the Esc key on a touch screen 1']);
  assert.deepEqual(judge([], { ...WIN, esc: ['the placeholder'] }), [], 'a mouse screen keeps its hints');
  assert.deepEqual(kinds(judge([], { ...PH, beside: ['Rewind to here'] })), ['Rewind to here: shares a row with a sent message 1']);
});

test('the overlay key of the page script is not inside a comment, so menus and the list over the chat are overlays', async () => {
  const { COLLECT } = await import('../../tools/app-chat-guard.mjs');
  for (const l of COLLECT.split('\n')) if (/\/\/ .*overlay:/.test(l)) assert.fail(`a comment swallows the overlay key: ${l.slice(0, 120)}`);
  assert.match(COLLECT, /overlay: !!el\.closest\(OVERLAYS\)/);
  const { PARTS } = await import('../../tools/app-chat-guard.mjs');
  assert.ok(PARTS.some(([, sel]) => /chat-side-over/.test(sel)) || /chat-side-over \.chat-side/.test(COLLECT), 'the list over the chat counts as floating');
});
