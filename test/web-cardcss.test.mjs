// Home card looks that no picture test pins: a long title takes two lines, a finger can press its buttons.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../web/page-home.css', import.meta.url), 'utf8');

test('a card title is cut after two lines, at a word', () => {
  assert.match(css, /article\.card \.card-name \{[^}]*-webkit-line-clamp: 2[^}]*white-space: normal/);
});

test('on a touch screen a card button is 44 px tall', () => {
  assert.match(css, /@media \(pointer: coarse\) \{\s*article\.card :is\(\.btn[^}]*min-height: 44px/);
});

test('a command breaks only at spaces and the queue chip has no indent of its own', () => {
  assert.match(css, /article\.card \.card-cmd \{[^}]*font-family: var\(--mono\)/);
  assert.match(css, /article\.card \.cmd-word \{ white-space: nowrap; \}/);
  assert.match(css, /article\.card \.card-meta \.badge \{ margin-left: 0; \}/);
});

test('a short title never breaks for its pill: the pill wraps under it when both do not fit', () => {
  assert.match(css, /article\.card \.card-name\.short \{ flex: 0 1 auto; max-width: 100%; white-space: nowrap;/);
});
