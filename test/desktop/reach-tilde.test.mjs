// Files reach writes the allowed folders under ~ (the home folder), so a screen never shows a full home path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the allowed folders are written through tildePath', async () => {
  // The list of folders is the textarea of Security and sign-in (a full path per line, as typed); the reach choice no
  // longer repeats it, so no full home path is written there.
  const s = fs.readFileSync(new URL('../../web/desktop/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /tops\.map/);
  globalThis.window ??= {};
  const { tildePath } = await import('../../web/lib.js');
  assert.equal(tildePath('/home/alex/Projects', '/home/alex'), '~/Projects');
  assert.equal(tildePath('/home/alexa/x', '/home/alex'), '/home/alexa/x');
});
