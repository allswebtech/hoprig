// What the README and docs/INSTALL.md say about Windows is the same paragraph, word for word (from "**Windows, macOS and Linux.**"
// to "are not offered on Windows."), so a person never reads "used" in one and "not ready" in the other.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const status = (file) => {
  const m = /\*\*Windows, macOS and Linux\.\*\*[\s\S]*?are not offered on Windows\./.exec(fs.readFileSync(path.join(root, file), 'utf8'));
  return m ? m[0].replace(/\s+/g, ' ') : null;
};

test('README and INSTALL.md say the same about Windows: what runs on GitHub, that it is new, and what was not run on a real PC', () => {
  const a = status('README.md');
  assert.ok(a, 'README.md has the Windows sentence');
  assert.equal(status('docs/INSTALL.md'), a);
  assert.match(a, /Windows is new here/);
  assert.match(a, /walked on Windows four ways/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'docs/INSTALL.md'), 'utf8'), /Not ready yet/);
});
