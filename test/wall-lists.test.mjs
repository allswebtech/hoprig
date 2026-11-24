// The wall's lists, asked row by row: programs that run their words (a package runner, an environment loader, a
// version manager's runner, `python -m <module>`), the ways to publish or release, and a deploy script run by an
// interpreter. The rows live in test/wall-lists.txt: each held row with the reason id its card shows, and the
// everyday rows beside them that must still go through. This file asks wallHeld (the function the hook asks) for
// each; nothing is run, and git is a stand-in function that answers the two questions the wall asks of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { wallHeld, runsItsWords } = await import('../src/wall.mjs');

const data = fs.readFileSync(new URL('./wall-lists.txt', import.meta.url), 'utf8');
const rows = data.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l, n) => {
  const a = l.indexOf(' | ');
  const b = l.indexOf(' | ', a + 3);
  assert.ok(a > 0 && b > a, `row ${n + 1} has the form "verdict | gap | text": ${l}`);
  const verdict = l.slice(0, a);
  const m = /^(?:held (\S+)|not held)$/.exec(verdict);
  assert.ok(m, `row ${n + 1}: the verdict is "held <why>" or "not held": ${l}`);
  return { why: m[1] || null, gap: l.slice(a + 3, b), text: l.slice(b + 3).replace(/\\n/g, '\n') };
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

test('the rows are read, none twice', () => {
  assert.ok(rows.length >= 60, `only ${rows.length} rows`);
  assert.equal(new Set(rows.map((r) => r.text)).size, rows.length, 'no line twice');
});

for (const gap of ['C7', 'C8', 'C9']) {
  test(`${gap}: every row is answered by the wall as it says`, () => {
    const mine = rows.filter((r) => r.gap === gap);
    if (!mine.length) return;
    const wrong = [];
    for (const r of mine) {
      const h = ask(r.text);
      const got = h ? h.why : null;
      if (got !== r.why) wrong.push(`${JSON.stringify(r.text)}: ${got ? `held as ${got}` : 'goes through'}, the row says ${r.why ? `held as ${r.why}` : 'goes through'}`);
    }
    assert.deepEqual(wrong, [], `${wrong.length} of ${mine.length} rows`);
  });
}

test('a runner of two words is read with its subcommand: the program alone is never one that runs its words', () => {
  for (const p of ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'pipx', 'poetry', 'bundle', 'mise', 'direnv', 'corepack', 'python', 'python3']) assert.equal(runsItsWords(p), false, p);
  for (const p of ['npx', 'bunx', 'pnpx', 'uvx', 'cross-env', 'dotenv', 'env-cmd']) assert.equal(runsItsWords(p), true, p);
});

test('an administrator command a package runner stands beside is marked: what the runner fetches cannot be told', () => {
  for (const line of ['npx sudo apt-get install -y nginx', 'sudo npx some-tool', 'uv run sudo apt-get install -y nginx']) {
    const h = ask(line);
    assert.ok(h, line);
    assert.equal(h.why, 'admin', line);
    assert.equal(h.unsure, true, line);
  }
  // python -m with a module the wall knows is that module's command, as it is without python.
  assert.notEqual(ask('sudo python3 -m pip install -r requirements.txt').unsure, true);
});
