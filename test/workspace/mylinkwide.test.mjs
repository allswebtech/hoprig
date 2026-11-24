// "This link is mine" never names a link that leads to the whole home folder, the workspace itself or a folder above
// them: Hoprig would then sync, install in and link memory into everything there. Refused by the same function the
// command and the page's sheet use, before anything is saved. A temporary home only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-mylinkwide');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const code = path.join(A.projects, 'shop', 'code');
fs.mkdirSync(code, { recursive: true });
fs.mkdirSync(path.join(A.home, 'disk2', 'shop-web'), { recursive: true });
const { addMyLink, myLinkEntries } = await import('../../src/workspace/inside.mjs');

test('a link to the home, a folder above it, the workspace or the projects folder is refused; a folder of his is not', () => {
  const cases = { all: A.home, up: path.dirname(A.home), ws: A.ws, projects: A.projects, top: path.parse(A.home).root };
  for (const [name, to] of Object.entries(cases)) {
    const l = path.join(code, name);
    fs.symlinkSync(to, l);
    for (const dryRun of [true, false]) {
      assert.throws(() => addMyLink(l, {}, { dryRun }), (e) => e.status === 400 && /holds your home folder or the workspace itself/.test(e.message), `${name} ${dryRun}`);
    }
  }
  assert.deepEqual(myLinkEntries(), [], 'nothing saved');
  const mine = path.join(code, 'shop-web');
  fs.symlinkSync(path.join(A.home, 'disk2', 'shop-web'), mine);
  assert.equal(addMyLink(mine).added, true);
});
