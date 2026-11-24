// Her words that held a figure Work did not give are hidden under Work's own lines (answercheck.mjs, tia.js). Seen in a
// real browser: the row was marked hidden and still drawn, because a row has a display of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const css = fs.readFileSync(path.join(web, 'page-tiacards.css'), 'utf8');
const js = fs.readFileSync(path.join(web, 'tia.js'), 'utf8');

test('a hidden row of her words takes no room: the row has a display of its own, so it has its hidden rule', () => {
  assert.match(css, /^\.tia-row\s*\{[^}]*\bdisplay\s*:/m, 'the row no longer has a display of its own: this test may go');
  assert.match(css, /^\.tia-row\[hidden\]\s*\{\s*display:\s*none;?\s*\}/m);
});

test('her words carry their number, and the progress lines hide the whole row of the ones they replace', () => {
  assert.match(js, /said\.dataset\.i = String\(e\.i\)/);
  assert.match(js, /\(m\.closest\('\.tia-row'\) \|\| m\)\.hidden = true/);
});
