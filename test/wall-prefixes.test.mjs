// The forms this round mends, asked row by row of the wall: leading redirection targets and assignments in any order
// (they must not hide the program), a variable standing as the program (held, bare or quoted, in any position), a gh
// or glab api call to the GraphQL endpoint (held whatever method is named), a deploy script behind interpreter
// options (held however many unknown options stand before it), and an interpreter's release-notes script (it writes
// text, so it goes through). The rows live in test/wall-prefixes.txt. This file asks wallHeld (the function the hook
// asks) for each; nothing is run, and git is a stand-in function that answers the two questions the wall asks of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { wallHeld } from '../src/wall.mjs';

const data = fs.readFileSync(new URL('./wall-prefixes.txt', import.meta.url), 'utf8');
const rows = data.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l, n) => {
  const a = l.indexOf(' | ');
  const b = l.indexOf(' | ', a + 3);
  assert.ok(a > 0 && b > a, `row ${n + 1} has the form "verdict | family | text": ${l}`);
  const verdict = l.slice(0, a);
  const m = /^(?:held (\S+)|not held)$/.exec(verdict);
  assert.ok(m, `row ${n + 1}: the verdict is "held <why>" or "not held": ${l}`);
  return { why: m[1] || null, family: l.slice(a + 3, b), text: l.slice(b + 3).replace(/\\n/g, '\n') };
});

// The session's folder and Hoprig's own folders, made up: nothing here exists on disk.
const places = { cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
// git as the wall asks it: the remote's default branch is main, the session stands on feature.
const git = (cwd, args) => {
  const a = args.join(' ');
  if (/^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return 'origin/main';
  if (a === 'symbolic-ref --short HEAD') return 'feature';
  return null;
};
const ask = (line) => wallHeld({ tool: 'Bash', input: { command: line }, cwd: places.cwd, git, places });

test('the rows are read, held and everyday both present, none twice', () => {
  assert.ok(rows.length >= 10, `only ${rows.length} rows`);
  assert.ok(rows.some((r) => r.why) && rows.some((r) => !r.why), 'both held and not-held rows');
  assert.equal(new Set(rows.map((r) => r.text)).size, rows.length, 'no line twice');
});

for (const family of [...new Set(rows.map((r) => r.family))].sort()) {
  test(`family ${family}: every row is answered by the wall as it says`, () => {
    const mine = rows.filter((r) => r.family === family);
    assert.ok(mine.length, `family ${family} has rows`);
    const wrong = [];
    for (const r of mine) {
      const h = ask(r.text);
      const got = h ? h.why : null;
      if (got !== r.why) wrong.push(`${JSON.stringify(r.text)}: ${got ? `held as ${got}` : 'goes through'}, the row says ${r.why ? `held as ${r.why}` : 'goes through'}`);
    }
    assert.deepEqual(wrong, [], `${wrong.length} of ${mine.length} rows in family ${family}`);
  });
}
