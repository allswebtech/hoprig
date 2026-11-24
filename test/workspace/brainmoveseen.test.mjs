// Move out moves only what the sheet showed: the press sends the fingerprint of the refusal list the sheet drew, and a
// list that changed since (a key file that came after, named by a request built by hand) moves nothing. A temporary
// home and a bare repository of this test's own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-brainmoveseen');
test.after(() => w.cleanup());
const url = w.bare('ai_brain');
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const brain = w.clone(url, path.join(A.ws, 'ai_brain'));
w.commit(brain, 'notes.md', 'plain\n', 'add notes');
w.sh(brain, 'push', '-q');

const { moveOut } = await import('../../src/workspace/brainmove.mjs');
const { brainChanges } = await import('../../src/workspace/brainsave.mjs');
const out = path.join(A.ws, 'ai_brain-moved-out');

test('a file the sheet never showed is not moved, also when the request names it', async () => {
  fs.writeFileSync(path.join(brain, 'a.pem'), 'a\n');
  const sheet = await brainChanges({ dir: A.ws });
  assert.deepEqual(sheet.secret, ['a.pem']);
  assert.match(sheet.moveSeen, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(brain, 'b.pem'), 'b\n'); // came after the sheet was drawn
  for (const files of [['a.pem', 'b.pem'], ['a.pem']]) {
    await assert.rejects(moveOut({ dir: A.ws, files, seen: sheet.moveSeen }), (e) => e.status === 409 && /changed since the sheet was opened: nothing was moved/.test(e.message), JSON.stringify(files));
  }
  assert.ok(fs.existsSync(path.join(brain, 'a.pem')) && fs.existsSync(path.join(brain, 'b.pem')));
  assert.equal(fs.existsSync(out), false, 'nothing reached the folder beside');
  await assert.rejects(moveOut({ dir: A.ws, files: ['a.pem'] }), (e) => e.status === 400 && /seen/.test(e.message), 'no list sent: refused');
  // The sheet opened again shows both; that press moves both.
  const again = await brainChanges({ dir: A.ws });
  const r = await moveOut({ dir: A.ws, files: again.secret, seen: again.moveSeen });
  assert.deepEqual(r.moved.map((m) => m.from).sort(), ['a.pem', 'b.pem']);
});

test('the route refuses a press that sends no list the sheet showed, before anything moves', async () => {
  const { Readable } = await import('node:stream');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  let moves = 0;
  const f = workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: () => 'owner' }, { moveOut: async () => (moves++, { folder: '', moved: [], untracked: [] }) });
  const [, , fn] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/workspace/git/brain/moveout'));
  for (const body of [{ files: ['a.pem'] }, { files: ['a.pem'], seen: 'x' }]) {
    await assert.rejects(fn(Object.assign(Readable.from([]), { body, headers: {} })), (e) => e.status === 400 && /seen/.test(e.message), JSON.stringify(body));
  }
  assert.equal(moves, 0);
});
