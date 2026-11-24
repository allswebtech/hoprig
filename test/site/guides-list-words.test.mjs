// The words the website's list of the guides shows for the two guides about several computers, and the landing
// page's renderer: both say what the pages say today.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the list of the guides calls the computer the others report to the main computer, never a hub', () => {
  // The key `hub` is the guide's address (/docs/hub/) and keeps its name; the words a person reads follow the pages.
  const rows = read('site/lib/sources.mjs').split('\n').filter((l) => /^\s+(computers|hub):\s*'/.test(l));
  assert.equal(rows.length, 2, 'the descriptions of the two guides are found');
  for (const row of rows) {
    const words = row.slice(row.indexOf("'"));
    assert.doesNotMatch(words, /\bhubs?\b/i, `no "hub" in ${words}`);
    assert.match(words, /main computer/, `"main computer" in ${words}`);
  }
});

test('the landing page has no row of screenshots, and its renderer strips none', () => {
  assert.doesNotMatch(read('site/content/index.md'), /^:::shots?$/m);
  assert.doesNotMatch(read('site/app/(site)/Sections.tsx'), /:::shots/);
});
