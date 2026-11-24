// Work's band over the list: no git words in anything a person reads (the same idea as the git sheets' test).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('words: Work\'s band never says commit, push or upstream', () => {
  const src = fs.readFileSync(new URL('../../web/work.js', import.meta.url), 'utf8');
  const part = (from, to, needed = true) => {
    const a = src.indexOf(from);
    if (a < 0 && !needed) return '';
    assert.ok(a >= 0, `found: ${from}`);
    return src.slice(a, src.indexOf(to, a));
  };
  // The band is drawn in paintTop and worded in saveBand; comments are not read by a person.
  const band = (part('async function paintTop', 'function paintFoot') + part('export function saveBand', 'export function unsavedText', false))
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    .replace(/icon\('[a-z-]+'/g, 'icon(');
  const strings = band.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
  assert.ok(strings.length > 10, 'the strings were found');
  for (const s of strings) assert.doesNotMatch(s, /\bcommits?\b|\bpush|upstream|\bgit\b/i, s);
});
