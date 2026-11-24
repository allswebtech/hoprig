// What the README and docs/INSTALL.md say about Windows is the same paragraph, word for word (from "On Windows
// (natively" to "itself was not tried."), so a person never reads "used" in one and "not ready" in the other.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const status = (file) => {
  const m = /On Windows \(natively, without WSL\)[\s\S]*?itself was not tried\./.exec(fs.readFileSync(path.join(root, file), 'utf8'));
  return m ? m[0].replace(/\s+/g, ' ') : null;
};

test('README and INSTALL.md say the same about Windows: what was used, the ways round, and what was not tried', () => {
  const a = status('README.md');
  assert.ok(a, 'README.md has the Windows sentence');
  assert.equal(status('docs/INSTALL.md'), a);
  assert.match(a, /needed ways round/);
  assert.match(a, /`install\.ps1` itself was not tried/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'docs/INSTALL.md'), 'utf8'), /Not ready yet/);
});
