// "hub" is "main computer" in every sentence a person reads on these files (code names and ids keep "hub").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const FILES = ['web/getstarted.js', 'web/store.js', 'web/joinlink.js', 'src/server/backends/none.mjs', 'src/workspace/whomay.mjs'];
// The one place left: the sentence names the button "Mark as my hub" of web/computers.js, whose words change with it.
const BUTTON = /mark it as your hub/g;

test('words: no sentence says hub; it is the main computer', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    const strings = src.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
    // A string with a space in it is a sentence; a bare 'hub' is an id or a reason code, and ${j.hub} is a name.
    for (const s of strings.filter((x) => / /.test(x))) assert.doesNotMatch(s.replace(/\$\{[^}]*\}/g, '').replace(BUTTON, ''), /\bhubs?\b/i, `${f}: ${s}`);
  }
  assert.match(fs.readFileSync(new URL('../../web/getstarted.js', import.meta.url), 'utf8'), /'This main computer is reachable'/);
});
