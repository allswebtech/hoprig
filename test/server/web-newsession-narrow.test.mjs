// New session on a phone (web/newsession-popup.js with web/style.css): a recent row with Continue beside it keeps the
// whole project name (two lines, never cut), and the first screen's rules (rows, chips, More options) hold the sizes the design names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../../web/newsession-popup.js', import.meta.url), 'utf8');

test('on a phone a recent row with Continue beside it wraps the project name instead of cutting it', () => {
  assert.match(popup, /h\('div\.ns-runrow', start1, open\)/, 'the row the rule is for');
  const m = /@media \(max-width: (\d+)px\) \{\s*\.ns-runrow \.row-title \{([^}]*)\}/.exec(css);
  assert.ok(m, 'a phone rule for the run row title');
  assert.ok(Number(m[1]) >= 390, 'it holds at 390 px');
  assert.match(m[2], /white-space: normal/);
  assert.match(m[2], /overflow-wrap: anywhere/);
});

test('the first screen: rows are at least 56 px, the computers a row of chips, More options a quiet button of 44 px', () => {
  assert.match(css, /\.ns-projects \.row, \.ns-projects button\.row \{ min-height: 56px; \}/);
  assert.match(css, /\.ns-chips \{[^}]*overflow-x: auto/, 'the only sideways scroll');
  assert.match(css, /\.ns-chip \{[^}]*min-height: 44px/);
  assert.match(css, /\.ns-more \{[^}]*min-height: 44px/);
  assert.match(css, /\.ns-seg-btn \{[^}]*min-height: 44px/);
  assert.match(popup, /h\('div\.ns-root', intro, moreSlot, opts, pcSlot, status, projSlot, actions\)/, 'the quiet line, More options, the computers, the projects');
  assert.doesNotMatch(css, /\.ns-tile|\.ns-choices|\.ns-startword/, 'the old tiles, line and Start word are gone');
});

test('a look fix: the options sit evenly, the foot button is 48 px, and a short screen drops the quiet line', () => {
  assert.match(css, /\.ns-opt \.toggle-line \{[^}]*margin-top: 0/, 'no extra gap above the first switch');
  assert.match(css, /\.sheet-actions \.btn \{ min-height: 48px; \}/);
  assert.match(css, /@media \(max-height: 520px\) \{ \.ns-intro \{ display: none; \} \}/);
  assert.equal((css.match(/^\.newopts \{/gm) || []).length, 1, 'one rule for the options box, not two that fight');
});
