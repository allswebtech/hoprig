// Files reach writes the allowed folders under ~ (the home folder), so a screen never shows a full home path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the allowed folders are written through tildePath', async () => {
  const s = fs.readFileSync(new URL('../../web/desktop/index.js', import.meta.url), 'utf8');
  assert.match(s, /`Allowed folders: \$\{tops\.map\(\(t\) => tildePath\(t\)\)\.join\(', '\) \|\| 'your home folder'\}/);
  globalThis.window ??= {};
  const { tildePath } = await import('../../web/lib.js');
  assert.equal(tildePath('/home/alex/Projects', '/home/alex'), '~/Projects');
  assert.equal(tildePath('/home/alexa/x', '/home/alex'), '/home/alexa/x');
});
