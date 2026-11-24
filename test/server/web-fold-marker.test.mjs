// A closed fold on the Computers pages shows a marker that it opens: "For the terminal", the key form's Advanced and
// an offline computer's Details carry cp-fold, and page-computers.css draws its chevron.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

test('the folds carry cp-fold, and its chevron turns when open', () => {
  assert.match(src('joinlink.js'), /h\('details\.adv\.cp-fold', h\('summary', 'For the terminal'\)/);
  assert.match(src('sshkey.js'), /h\('details\.adv\.cp-fold[.\w-]*', h\('summary', 'Advanced'\)/);
  assert.match(src('pc.js'), /h\('details\.adv\.cp-fold[.\w-]*', h\('summary', 'Details'\)/);
  const css = src('page-computers.css');
  assert.match(css, /\.cp-fold > summary::before \{[^}]*border-right: 2px solid currentColor/);
  assert.match(css, /\.cp-fold\[open\] > summary::before \{ transform: rotate\(45deg\); \}/);
});
