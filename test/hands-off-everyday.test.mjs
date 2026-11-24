// The everyday table: command lines a coding tool runs in ordinary work, each of which must go through the wall. A
// hold where none is needed costs the owner a tap in every session, at night too, so a stricter wall must not reach
// these. The lines live in test/hands-off-everyday.txt; this file asks wallHeld (the function the hook asks) for each.
//
// It spawns nothing: git is a stand-in function that answers the two questions the wall asks of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const data = fs.readFileSync(new URL('./hands-off-everyday.txt', import.meta.url), 'utf8');
const lines = data.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.replace(/\\n/g, '\n'));

// The session's folder and Hoprig's own folders, made up: nothing here exists on disk.
const places = { cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
// git as the wall asks it: the remote's default branch is main, the session stands on feature.
const git = (cwd, args) => {
  const a = args.join(' ');
  if (/^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return 'origin/main';
  if (a === 'symbolic-ref --short HEAD') return 'feature';
  return null;
};

test('the everyday table has at least 60 lines and none twice', () => {
  assert.ok(lines.length >= 60, `only ${lines.length} lines`);
  assert.equal(new Set(lines).size, lines.length, 'no line twice');
});

test('every everyday line goes through the wall', () => {
  const held = [];
  for (const line of lines) {
    const h = wallHeld({ tool: 'Bash', input: { command: line }, cwd: places.cwd, git, places });
    if (h) held.push(`${JSON.stringify(line)}: held as ${h.kind}`);
  }
  assert.deepEqual(held, [], 'everyday lines the wall holds');
});
