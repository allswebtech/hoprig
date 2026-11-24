// The forms of a push and of a program that the wall reads (src/wall.mjs): systemd-run's own options, a variable in
// double quotes standing as the program, a variable in a push, and a push that deletes a branch on the remote by name.
// Each is a row of test/wall-pushforms.txt with the answer the wall must give, both the lines that are held and the
// everyday lines beside them that must still go through. Every row is asked of wallHeld, the function the hook asks.
//
// It spawns nothing: git is a stand-in function that answers the questions the wall asks of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { WALL_REASON, readCommands, wallHeld, wallKind } from '../src/wall.mjs';

const data = fs.readFileSync(new URL('./wall-pushforms.txt', import.meta.url), 'utf8');
const BRANCHES = new Set(['feature', 'main']);
const rows = data.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l, n) => {
  const a = l.indexOf(' | ');
  const b = l.indexOf(' | ', a + 3);
  assert.ok(a > 0 && b > a, `row ${n + 1} has the form "verdict | branch | text": ${l}`);
  const row = { verdict: l.slice(0, a), branch: l.slice(a + 3, b), text: l.slice(b + 3) };
  assert.ok(row.verdict === 'not held' || /^held [a-z]+(?:[- ][a-z]+)*$/.test(row.verdict), `row ${n + 1}: the verdict is "not held" or "held <reason id>": ${l}`);
  assert.ok(row.verdict === 'not held' || WALL_REASON[row.verdict.slice(5)], `row ${n + 1}: ${row.verdict.slice(5)} is a reason id of the wall`);
  assert.ok(BRANCHES.has(row.branch), `row ${n + 1}: the branch is feature or main: ${l}`);
  return row;
});

// The session's folder and Hoprig's own folders, made up: nothing here exists on disk.
const places = { cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
// git as the wall asks it: the remote's default branch is main, the session stands on `branch`, and no tag is known.
const gitOn = (branch) => (cwd, args) => {
  const a = args.join(' ');
  if (/^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return 'origin/main';
  if (a === 'symbolic-ref --short HEAD') return branch;
  return null;
};
const ask = (r) => wallHeld({ tool: 'Bash', input: { command: r.text }, cwd: places.cwd, git: gitOn(r.branch), places });

test('the file has held and everyday rows, and no line twice', () => {
  assert.ok(rows.filter((r) => r.verdict === 'not held').length >= 10, 'at least 10 everyday rows');
  assert.ok(rows.filter((r) => r.verdict !== 'not held').length >= 10, 'at least 10 held rows');
  const keys = rows.map((r) => `${r.branch} ${r.text}`);
  assert.equal(new Set(keys).size, keys.length, 'no row twice');
});

test('every row is answered by the wall as the file says, with its reason', () => {
  const wrong = [];
  for (const r of rows) {
    const h = ask(r);
    const got = h ? `held ${h.why}` : 'not held';
    if (got !== r.verdict) wrong.push(`${JSON.stringify(r.text)} on ${r.branch}: ${got}, the file says ${r.verdict}`);
  }
  assert.deepEqual(wrong, []);
});

// The two substitutions that name the branch the session stands on, bare or in double quotes, read as a push of HEAD:
// held while the session stands on the main branch, through on a work branch, as `git push origin HEAD` is.
test('the two forms that name the current branch by a command substitution read as a push of HEAD', () => {
  for (const sub of ['$(git branch --show-current)', '$(git rev-parse --abbrev-ref HEAD)']) {
    for (const text of [`git push origin ${sub}`, `git push origin "${sub}"`, `git push -u origin "${sub}"`]) {
      for (const branch of ['main', 'feature']) {
        assert.equal(ask({ text, branch })?.why ?? null, ask({ text: 'git push origin HEAD', branch })?.why ?? null, `${text} on ${branch}`);
      }
      assert.equal(ask({ text, branch: 'main' })?.why, 'push', `${text} on main`);
      assert.equal(ask({ text, branch: 'feature' }), null, `${text} on feature`);
    }
  }
  // The raw line reaches the reader with its quotes: `"$(…)"` becomes `"HEAD"`, read as the plain word HEAD.
  for (const text of ['git push origin "$(git branch --show-current)"', 'git push origin $(git rev-parse --abbrev-ref HEAD)']) {
    assert.deepEqual(readCommands(text)?.map((c) => c.map((w) => w.word)), [['git', 'push', 'origin', 'HEAD']], text);
    assert.ok(!readCommands(text)[0][3].vars, `${text}: no variable stands in the word`);
  }
  // After a line break the substitution starts a new command: it is the program there, so it stays held.
  assert.equal(ask({ text: 'git push origin\n$(git branch --show-current) --version', branch: 'feature' })?.why, 'unreadable');
});

// wallKind is the reader that needs no git (Tia's own command asks it for `admin` and `unreadable`): a systemd-run
// that leaves the user's own manager is an administrator command, a quoted variable as the program cannot be read.
test('the reader without git context gives the same kind for the program forms', () => {
  for (const r of rows.filter((x) => x.verdict === 'held admin' || x.verdict === 'held unreadable')) assert.equal(wallKind(r.text), r.verdict.slice(5), r.text);
  for (const text of ['systemd-run --user make test', '"$VENV/bin/python" -m pytest -q', 'echo "$EDITOR"']) assert.equal(wallKind(text), null, text);
});

test('the card sentences are true for a push with a variable and for a push that deletes a branch by name', () => {
  assert.match(WALL_REASON['push-elsewhere'], /a variable names where it goes/);
  assert.match(WALL_REASON['push-prune'], /delete remote branches, by name or with a pruning push/);
});
