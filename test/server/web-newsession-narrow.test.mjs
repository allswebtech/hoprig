// New session on a phone (web/newsession-popup.js with web/style.css): a recent row with Continue beside it keeps the
// whole project name (two lines, never cut), and "Also open" has no empty band of its own around it.
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

test('"Also open" adds no margin of its own around its fold: the sheet body\'s gap parts it', () => {
  assert.match(css, /\.ns-also \{ margin-top: 0; \}/);
  assert.match(css, /\.ns-also > \.fold \{ margin: 0; \}/);
  assert.match(css, /\.sheet-body \{[^}]*gap: 10px/, 'the gap that stays');
});

test('"Also open" has a compact line: its summary is not the 44 px of a fold elsewhere', () => {
  const m = /\.ns-also > \.fold > \.fold-summary \{([^}]*)\}/.exec(css);
  assert.ok(m, 'a rule for the summary inside .ns-also');
  const h = /min-height: (\d+)px/.exec(m[1]);
  assert.ok(h, 'it sets its own height');
  assert.ok(Number(h[1]) >= 24 && Number(h[1]) <= 32, `between 24 and 32 px (a target still easy to press): ${h[1]}`);
  assert.match(css, /\.fold-summary \{[^}]*min-height: 44px/, 'other folds keep their height');
  assert.match(popup, /h\('div\.ns-root', choices, status, alsoSlot/, 'the choices line stands right before "Also open"');
  assert.match(css, /\.ns-root > \.ns-choices \{ margin-bottom: 0; \}/, 'the choices line adds no margin to the sheet\'s gap');
});
