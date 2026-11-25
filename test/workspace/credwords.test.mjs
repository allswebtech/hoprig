// The words of the credentials step on the Workspace page are the ones the docs and the changelog say: the button, the
// sentence that there is no undo, the stale plan's sentence and the cost (the command's own). The page part is drawn in
// the Workspace folders panel, and the route sends the sheet its sentences (no second copy of them in the page).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s*\n\s*/g, ' ');

test('the page\'s credentials words are in the docs and the changelog, and the page takes them from the server', async () => {
  const { NO_UNDO, STALE } = await import('../../src/workspace/credweb.mjs');
  const { COST } = await import('../../src/workspace/credrepo.mjs');
  const docs = flat(read('docs/WORKSPACE.md'));
  const page = read('web/workspacecreds.js');
  assert.ok(docs.includes(`"${NO_UNDO}"`), 'the no-undo sentence, word for word');
  assert.ok(docs.includes(`("${STALE}")`), 'the stale plan\'s sentence, word for word');
  assert.ok(docs.includes(flat('Whoever can read that repository reads every key in it, and a private repository is only as safe as the account it is in.')));
  assert.equal(COST, 'Whoever can read that repository reads every key in it, and a private repository is only as safe as the account it is in.');
  assert.match(page, /export const MAKE = 'Make it a private repository'/);
  assert.ok(docs.includes('**Make it a private repository**'));
  assert.ok(read('site/content/changelog.md').includes('- **The credentials folder can be made a private repository from the Workspace page.**'));
  // The sheet shows what the server says (one copy of each sentence): the cost, the undo, the visibility.
  for (const field of ['p.cost', 'p.undo', 'p.visibility', 'p.steps']) assert.ok(page.includes(field), field);
  assert.ok(!page.includes(NO_UNDO) && !page.includes(COST), 'no second copy in the page');
  // Drawn where the credentials folder is shown: the Workspace folders panel.
  assert.match(read('web/brain.js'), /rows\(fine\)\) : null,\n\s+credentialsPart\(\),/);
});
