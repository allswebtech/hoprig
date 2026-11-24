// On a phone, Home's New session and Work's main action stand in the page head, as on a desktop: a floating button
// sat on the first card's text ("Claude wants to run: …"), the line he has to say yes to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

test('Home and Work keep their main action in the page head', () => {
  for (const f of ['home.js', 'work.js']) assert.match(src(f), /primaryInHead: true/, f);
});

// Providers too: a floating Add provider covered the last provider's lines ("· 2 sessions", its usage) at 390 px.
test('Providers keeps Add provider in the page head', () => {
  assert.match(src('accounts.js'), /primary: here \? \{ label: 'Add provider'[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*primaryInHead: true,/);
});

test('a page that keeps it in the head gets no floating button', () => {
  const shell = src('shell.js');
  assert.match(shell, /const fab = primary && !primaryInHead \? go\('fab'\) : null;/);
  assert.match(shell, /go\(primaryInHead \? 'pagehead-primary\.head-always' : 'pagehead-primary'\)/);
});

test('on a phone the head shows it in the title row', () => {
  const css = src('style.css');
  const phone = css.slice(css.indexOf('@media (max-width: 899px) {\n  .pagehead { display: grid;'));
  assert.match(phone.slice(0, phone.indexOf('\n}\n')), /\.pagehead-primary\.head-always \{ display: inline-flex; grid-column: 3; grid-row: 1;/);
});

test('without the floating button a card\'s long buttons still wrap on a phone', () => {
  const css = src('style.css');
  const phone = css.slice(css.indexOf('@media (max-width: 899px) {\n  .pagehead { display: grid;'));
  assert.match(phone.slice(0, phone.indexOf('\n}\n')), /\n {2}:is\(\.card, \.si-row\) :is\(\.limit-actions, \.card-actions\) \.btn, \.accountsline-actions \.btn \{ max-width: 100%; white-space: normal;/);
});
