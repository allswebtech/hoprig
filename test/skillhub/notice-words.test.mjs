// The weekly skill check's notice names the place the person opens: the Skills page (there is no "Settings → Skills").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'skillhub', 'feature.mjs'), 'utf8');

test('the skill updates notice says "Review them on the Skills page"', () => {
  assert.match(SRC, /Review them on the Skills page\./);
  assert.doesNotMatch(SRC, /Settings → Skills\./);
});
