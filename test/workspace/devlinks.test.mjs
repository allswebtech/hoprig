// A tool adopted into the workspace is a LINK under development/ (pcsetup/devplaces.mjs): development/flutter/flutter
// pointing at a made-up Flutter in the home, which is itself a git checkout (Flutter's SDK is one). Everything that
// walks or deletes the workspace treats it as a link: the map scan never maps it, this computer's description counts
// it as one entry and records the tool by name and version only, restore and drop never walk into it or delete
// through it, and the tool stays byte for byte as it was. A download's temporary folder (.hoprig-tmp-…) is skipped.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropOn, dropWorld, getOn, owner } from './dropfix.mjs';
import { quietUi } from './gitfix.mjs';

const w = await dropWorld('devlinks', { labels: ['alpha'] });
test.after(() => w.cleanup());
const [A] = w.computers;
const { scanWorkspace } = await import('../../src/workspace/mapscan.mjs');
const C = await import('../../src/workspace/computer.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');

/** Every entry under `dir`, links not followed: kind, mode, content hash, a link's text. */
function snap(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[r] = `dir ${st.mode & 0o777}`;
        walk(p, r);
      } else out[r] = `file ${st.mode & 0o777} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir, '');
  return out;
}

A.use();
const tool = path.join(A.home, 'flutter');
fs.mkdirSync(path.join(tool, 'bin'), { recursive: true });
fs.writeFileSync(path.join(tool, 'bin', 'flutter'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(tool, 'version'), '3.41.2\n');
w.sh(A.home, 'init', '-q', tool);
w.sh(tool, 'add', '-A');
w.sh(tool, 'commit', '-q', '-m', 'flutter');
const dev = path.join(A.ws, 'development');
fs.mkdirSync(path.join(dev, 'flutter'), { recursive: true });
fs.symlinkSync(tool, path.join(dev, 'flutter', 'flutter'));
// A download that is still running: Hoprig's own temporary folder, with a git checkout in it.
fs.mkdirSync(path.join(dev, '.hoprig-tmp-abc123', 'into', 'flutter'), { recursive: true });
w.sh(A.home, 'init', '-q', path.join(dev, '.hoprig-tmp-abc123', 'into', 'flutter'));
const toolBefore = snap(tool);

test('the map scan does not map the linked tool or the temporary folder (both git checkouts)', async () => {
  A.use();
  const r = await scanWorkspace({ dir: A.ws, projects: A.projects });
  const all = JSON.stringify(r.map || r);
  assert.doesNotMatch(all, /development/, all);
  assert.deepEqual(snap(tool), toolBefore);
});

test('this computer\'s description: the link is one entry, never followed; the temporary folder is not named; the tool is recorded by name and version', async () => {
  A.use();
  const d = C.describeFolder(A.ws, 'development');
  assert.deepEqual(d.items, [{ name: 'flutter', kind: 'folder', entries: 1 }]);
  assert.deepEqual(C.describeFolder(A.ws, 'development/flutter').items, [{ name: 'flutter', kind: 'link' }]);
  const r = await C.writeOwnFile({ dir: A.ws, projects: A.projects });
  assert.ok(r.written !== false, JSON.stringify(r));
  const file = w.fileHere(A, 'alpha');
  assert.deepEqual(file.folders.development.tools, [{ name: 'Flutter', version: '3.41.2', adopted: true }]);
  assert.doesNotMatch(JSON.stringify(file.folders.development), /\/|hoprig-tmp/, 'no path and no temporary folder in the file');
  assert.deepEqual(snap(tool), toolBefore);
});

test('restore on a computer whose development/ holds the link: the link stays a link, the tool is untouched', async () => {
  A.use();
  const q = await quietUi();
  await restoreWorkspace(w.u.brain, { ui: q.ui, dir: A.ws, projects: A.projects });
  assert.equal(fs.readlinkSync(path.join(dev, 'flutter', 'flutter')), tool);
  assert.deepEqual(snap(tool), toolBefore);
});

test('drop of a project that holds a link to the tool: never through it; the link alone goes, the tool stays', async () => {
  A.use();
  if (!fs.existsSync(A.shop)) assert.equal((await getOn(A, ['shop'])).code, 0);
  // A link that is work git does not hold: drop refuses to lose it, and keeps the project; nothing is followed.
  fs.symlinkSync(tool, path.join(A.shop, 'sdk'));
  const kept = await dropOn(A, ['shop'], { answers: owner('shop') });
  assert.equal(kept.code, 1, kept.text);
  assert.match(kept.text, /sdk leaves its folder through a link/);
  assert.ok(fs.existsSync(A.shop));
  assert.deepEqual(snap(tool), toolBefore);
  fs.unlinkSync(path.join(A.shop, 'sdk'));
  // A link in a folder git ignores (node_modules): removed with the project, the link only.
  const mods = path.join(A.shop, 'code', 'shop-api', 'node_modules');
  fs.mkdirSync(mods, { recursive: true });
  fs.symlinkSync(tool, path.join(mods, 'sdk'));
  const r = await dropOn(A, ['shop'], { answers: owner('shop') });
  assert.equal(r.code, 0, r.text);
  assert.equal(fs.existsSync(A.shop), false);
  assert.deepEqual(snap(tool), toolBefore, 'not one byte of the tool changed');
  assert.equal(fs.readlinkSync(path.join(dev, 'flutter', 'flutter')), tool, 'the adoption link in development/ stays');
});
