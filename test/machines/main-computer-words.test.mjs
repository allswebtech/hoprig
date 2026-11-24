// "hub" is "main computer" in every sentence a person reads from the joining, linking and set-up files (code names,
// config keys, routes, ids and the --hub flag keep "hub").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const FILES = ['src/machines/link.mjs', 'src/machines/hubcert.mjs', 'src/machines/join.mjs', 'src/addons/feature.mjs', 'src/setup/checks.mjs', 'src/workspace/whomay.mjs',
  'src/machines/tokens.mjs', 'src/machines/tokenaudit.mjs', 'src/machines/hub.mjs', 'src/machines/movehub.mjs', 'src/machines/cli.mjs',
  'src/server/backends/index.mjs', 'src/setup/setup.mjs', 'src/setup/hubsetup.mjs'];

test('words: the joining and set-up sentences say main computer, never hub', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    const strings = src.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
    // A string with a space in it is a sentence; a bare 'hub' is an id or a reason code, and ${j.hub} is a name.
    for (const s of strings.filter((x) => / /.test(x))) {
      const words = s.replace(/\$\{[^}]*\}/g, '').replace(/--hub\b/g, '--');
      assert.doesNotMatch(words, /\bhubs?\b/i, `${f}: ${s}`);
    }
  }
});
