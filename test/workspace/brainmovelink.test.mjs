// A brain folder that is a link to another place (not one the owner named as his): Hoprig moves nothing in it, so the
// save sheet offers no Move out button that can only fail, and says why in plain words. A temporary home only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-brainmovelink');
test.after(() => w.cleanup());
const url = w.bare('ai_brain');
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const real = w.clone(url, path.join(A.home, 'disk2', 'brain'));
w.commit(real, 'notes.md', 'plain\n', 'add notes');
w.sh(real, 'push', '-q');
fs.mkdirSync(A.ws, { recursive: true });
fs.symlinkSync(real, path.join(A.ws, 'ai_brain'));

const { brainChanges } = await import('../../src/workspace/brainsave.mjs');
const { moveOut } = await import('../../src/workspace/brainmove.mjs');

test('a brain that is a link: the key is still refused, no Move out is offered, and the sheet says why', async () => {
  fs.writeFileSync(path.join(real, 'e.pem'), 'e\n');
  const c = await brainChanges({ dir: A.ws });
  assert.deepEqual(c.secret, ['e.pem'], 'the save still refuses it');
  assert.equal(c.movedOut, undefined, 'no folder named, so no button');
  assert.equal(c.moveSeen, undefined);
  assert.equal(c.brainIsLink, true);
  // The move itself refuses too, before anything moves (as before).
  await assert.rejects(moveOut({ dir: A.ws, files: ['e.pem'], seen: 'a'.repeat(64) }), (e) => e.status === 409);
  assert.ok(fs.existsSync(path.join(real, 'e.pem')));
});

test('the sheet\'s words for it: no button, and why', async () => {
  globalThis.Node ??= class {};
  globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const { saveWords } = await import('../../web/gitsetup.js');
  const c = await brainChanges({ dir: A.ws });
  const said = saveWords(c);
  assert.equal(said.moveOut, undefined);
  assert.match(said.lines.join(' '), /AI brain folder here is a link to another place/);
});
