// The sheet Work's band opens (saveSheet) speaks the band's words: no commit, push, upstream, git or origin/main in
// anything a person reads there, and its title and button say "Keep a copy" as the band does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('words: the sheet behind Work\'s band never says commit, push, upstream or a branch name', () => {
  const src = fs.readFileSync(new URL('../../web/work.js', import.meta.url), 'utf8');
  const a = src.indexOf('function saveSheet()');
  assert.ok(a >= 0, 'found: saveSheet');
  const part = src.slice(a, src.indexOf('registerPage(', a))
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    .replace(/icon\('[a-z-]+'/g, 'icon(')
    .replace(/api\('[^']*'/g, 'api(');
  const strings = (part.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || []).filter((s) => !/^'(primary|secondary|Close|Cancel|Done|merge|ff|blocked|moved|change|info|warn|check|alert|span|div|p|h3|li|ul|strong)'$/.test(s));
  assert.ok(strings.length > 10, 'the strings were found');
  // What a person reads of a template: its text, and the quoted text inside each ${…}; never the code names there.
  const shown = (t) => {
    let prev;
    do {
      prev = t;
      t = t.replace(/\$\{([^{}]*)\}/g, (m, inner) => ` ${(inner.match(/'(?:[^'\\]|\\.)*'|`[^`]*`/g) || []).join(' ')} `);
    } while (t !== prev);
    return t;
  };
  for (const s of strings.map(shown)) assert.doesNotMatch(s, /\bcommits?\b|\bcommitted\b|\bpush|upstream|\bgit\b(?! server)|origin\/|\bMerge\b|\bSend\b/i, s);
  assert.match(part, /title: 'Keep a copy of your list'/);
  assert.match(part, /'Keep a copy and upload'/);
});
