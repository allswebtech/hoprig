// The map written by two computers in turn. A tool folder under development/ (a checkout of a version manager) is on a
// branch on one computer and at a tag (no branch: a detached HEAD) on another. The map scan wrote the branch of an
// "other" entry only where the folder is on one, so the computer at the tag took the line out and the next one put it
// back: every go-live made a commit of that one line. A folder that is on no branch says nothing about the branch, so the
// line the map already has stays, and a restore still checks the folder out on it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const G = gitWorld('mapflip');
test.after(() => G.cleanup());
const { scanWorkspace } = await import('../../src/workspace/mapscan.mjs');
const { emptyMap } = await import('../../src/workspace/mapscan.mjs');

const url = G.bare('version-manager');
/** A computer's workspace with the tool folder cloned, on its branch or at a tag. */
const computer = (n, { atTag }) => {
  const c = G.computer(n);
  const dest = path.join(c.ws, 'development', 'tools', 'version-manager');
  G.clone(url, dest);
  if (atTag) {
    G.sh(dest, 'tag', 'v1.0');
    G.sh(dest, 'checkout', '-q', 'v1.0'); // a detached HEAD
  }
  fs.mkdirSync(c.projects, { recursive: true });
  return c;
};
const write = async (c, previous) => {
  c.use();
  const r = await scanWorkspace({ dir: c.ws, projects: c.projects, previous });
  return r.map;
};

test('a computer at a tag never takes out the branch another one wrote, and the first never writes it again: the map stays byte for byte', async () => {
  const onBranch = computer('on-a-branch', { atTag: false });
  const atTag = computer('at-a-tag', { atTag: true });
  const first = await write(onBranch, emptyMap());
  const entry = first.others.find((o) => o.dir === 'development/tools/version-manager');
  assert.ok(entry, JSON.stringify(first));
  assert.equal(entry.branch, 'main', 'a computer on a branch writes it');
  assert.equal(entry.sync, false, 'a tool is not synced');
  const text = JSON.stringify(first);
  const second = await write(atTag, first);
  assert.equal(JSON.stringify(second), text, 'the computer at the tag leaves the map as it was');
  const third = await write(onBranch, second);
  assert.equal(JSON.stringify(third), text, 'and the first again: the same bytes');
  assert.equal(JSON.stringify(await write(atTag, third)), text);
});

test('a folder at a tag on a map that has no branch for it writes none', async () => {
  const atTag = computer('only-a-tag', { atTag: true });
  const m = await write(atTag, emptyMap());
  const entry = m.others.find((o) => o.dir === 'development/tools/version-manager');
  assert.ok(entry && !('branch' in entry), JSON.stringify(entry));
});

test('a computer that is on another branch still says so: only a folder on no branch keeps the map line', async () => {
  const c = computer('other-branch', { atTag: false });
  const dest = path.join(c.ws, 'development', 'tools', 'version-manager');
  G.sh(dest, 'checkout', '-q', '-b', 'stable');
  const m = await write(c, { ...emptyMap(), others: [{ dir: 'development/tools/version-manager', url: G.url('version-manager'), branch: 'main', sync: false }] });
  assert.equal(m.others.find((o) => o.dir === 'development/tools/version-manager').branch, 'stable');
});
