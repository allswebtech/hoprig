import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The terminal draws a coding tool's frames (╭─╮ │ ╰─╯) and its marks (⎿ under a tool call, ⇧ in "⇧⇥"). A browser
// takes each character from the first family of the list that holds it, and only after the whole list from the
// system's own fallback. Liberation Mono holds │ and ─ but not the rounded corners, ⎿ or ⇧, and on a Linux computer
// with Chinese and Japanese fonts the system's fallback for them is WenQuanYi Zen Hei or IPAGothic: 14 px wide in a
// cell of 8.4 px, so the corners did not meet their side bars. So the list itself names, before the generic
// `monospace`, fonts that hold them.
//
// What each font holds was read from its file with fc-list ":charset=<hex>": Noto Sans Mono 2.x (Debian's
// fonts-noto-core) and GNU FreeMono 2012 (fonts-freefont-ttf). Both are 0.6 em wide, as Liberation Mono is.
const FRAME = ['╭', '╮', '╰', '╯', '│', '─'];
const MARKS = ['⎿', '⇧'];
const HOLDS = {
  'Noto Sans Mono': [...FRAME],
  FreeMono: [...FRAME, ...MARKS],
};

function families() {
  const src = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  const m = src.match(/new Terminal\(\{[\s\S]*?fontFamily: '([^']+)'/);
  assert.ok(m, 'the terminal\'s fontFamily is in web/session.js');
  return m[1].split(',').map((f) => f.trim().replace(/^"(.*)"$/, '$1'));
}

test('the terminal\'s font list names fonts that hold its frame and its marks before the generic monospace', () => {
  const list = families();
  assert.equal(list.at(-1), 'monospace', 'the list ends with the generic family');
  const named = list.slice(0, -1);
  for (const ch of [...FRAME, ...MARKS]) {
    const holder = named.find((f) => HOLDS[f]?.includes(ch));
    assert.ok(holder, `a font of the list that holds ${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase()}) comes before monospace: ${list.join(', ')}`);
  }
});

test('the key bar\'s ⇧Tab names a font that holds ⇧ in the weight the keys are drawn in', () => {
  // The keys are drawn at weight 600 (web/page-session.css .key): FreeMono's and Noto Sans Mono's bold faces lack ⇧,
  // so on that Linux computer ⇧ came from IPAGothic, a filled arrow unlike the key's other letters. Noto Sans Symbols2
  // has one face only, which Chrome takes for every weight (fc-list ":charset=21e7").
  const css = readFileSync(new URL('../web/page-session.css', import.meta.url), 'utf8');
  const m = css.match(/\n\.key \{[^}]*?font: ([^;]+);/);
  assert.ok(m, 'the .key rule names its font in web/page-session.css');
  assert.match(m[1], /"Noto Sans Symbols2"/, `a font holding ⇧ at every weight is named for the keys: ${m[1]}`);
});

test('the letters stay those of the fonts before them: the added fonts come after Liberation Mono', () => {
  const list = families();
  const lib = list.indexOf('Liberation Mono');
  assert.ok(lib >= 0, 'Liberation Mono is still named');
  for (const f of Object.keys(HOLDS)) if (list.includes(f)) assert.ok(list.indexOf(f) > lib, `${f} comes after Liberation Mono`);
});
