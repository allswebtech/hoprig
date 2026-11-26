// Neighbours of gaps 5 and 6 of the wall: a wildcard (`*`, `?`), a `[...]` class or a brace list that could name one
// of Hoprig's own folders is held, and a `cd`/`pushd` the wall can follow before such a path is held too; beside the
// everyday wildcards and folder changes that must still go through. The lines live in test/wall-globcd.txt, one per
// row (`held` or `through`); this file asks wallHeld (the function the hook asks) for each. It spawns nothing: git is
// a stand-in function that answers the two questions the wall asks of it, and nothing here exists on disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const data = fs.readFileSync(new URL('./wall-globcd.txt', import.meta.url), 'utf8');
const rows = data.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
  const i = l.indexOf(' | ');
  assert.ok(i > 0, `a row has the form "verdict | line": ${l}`);
  const verdict = l.slice(0, i);
  assert.ok(verdict === 'held' || verdict === 'through', `verdict is held or through: ${l}`);
  return { verdict, line: l.slice(i + 3) };
});

// The session's folder and Hoprig's own folders, made up: nothing here exists on disk.
// They are POSIX places, read as on Linux everywhere: on Windows `/w` is the drive-relative `W:`, which no home is
// (test/wall-windows.test.mjs asks the same lines with Windows places).
const places = { platform: 'linux', cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
// git as the wall asks it: the remote's default branch is main, the session stands on feature.
const git = (cwd, args) => {
  const a = args.join(' ');
  if (/^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return 'origin/main';
  if (a === 'symbolic-ref --short HEAD') return 'feature';
  return null;
};
const held = (line) => wallHeld({ tool: 'Bash', input: { command: line }, cwd: places.cwd, git, places });

test('the neighbour table has rows of both kinds', () => {
  assert.ok(rows.some((r) => r.verdict === 'held'), 'some held rows');
  assert.ok(rows.some((r) => r.verdict === 'through'), 'some go-through rows');
});

test('each held neighbour is held, each everyday line goes through', () => {
  const wrong = [];
  for (const r of rows) {
    const h = held(r.line);
    const got = h ? 'held' : 'through';
    if (got !== r.verdict) wrong.push(`${JSON.stringify(r.line)}: want ${r.verdict}, got ${got}${h ? ` (${h.kind})` : ''}`);
  }
  assert.deepEqual(wrong, []);
});

test('a wildcard or brace that could name a Hoprig folder is held as its own files', () => {
  for (const line of ['cat ~/.config/hop*/config.json', 'cat ~/.config/{hoprig,other}/config.json']) {
    assert.equal(held(line).kind, 'settings', line);
  }
});
