// The catch-up after the move's switch (src/setup/movecatch.mjs): a line root's side wrote after the copy is brought
// over when the copy is a clean beginning of root's file; a file whose copy is not is listed and never overwritten; a
// file written only after the copy is added. Root's idle terminal is ended by its own socket and session, and only
// after the catch-up (the stand-in tmux writes down when it was asked).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const X = await import('../../src/setup/movecatch.mjs');
const { projectSlug: slugOf } = await import('../../src/sessions.mjs');
// Claude Code names a project folder after its real path (process.cwd()); a temporary folder may be reached through a
// link (macOS: /var is a link to /private/var), and a path here may not be made yet.
const projectSlug = (p) => slugOf(path.join(fs.realpathSync(s.tmp), path.relative(s.tmp, p)));

const oldHome = path.join(s.tmp, 'root');
const newHome = path.join(s.tmp, 'users', 'hoprig');
const shop = (home) => path.join(home, 'Workspace/projects/shop');
const write = (f, t) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
const rootProj = path.join(oldHome, '.claude/projects', projectSlug(shop(oldHome)));
const places = [projectSlug(shop(oldHome)), projectSlug(shop(newHome))].map((n) => path.join(newHome, '.claude/projects', n));
// As the copy left it: three conversations and an agent's file four folders down, in both places of the user's.
const at = { a: 'a1.jsonl', b: 'b2.jsonl', c: 'c3.jsonl', agent: 'a1/subagents/x/y/agent-1.jsonl' };
for (const dir of [rootProj, ...places]) {
  write(path.join(dir, at.a), '{"n":1}\n');
  write(path.join(dir, at.b), '{"n":1}\n');
  write(path.join(dir, at.c), '{"n":1}\n');
  write(path.join(dir, at.agent), '{"agent":1}\n');
}

test("a line root's side wrote after the copy is brought over; a copy that is not a clean beginning is listed, not overwritten; then root's terminal ends", async () => {
  // Root's side goes on: two lines at the stop, one at the end of its terminal; another file is new; and in the user's
  // copy of c3 the user's own session has already written something of its own.
  fs.appendFileSync(path.join(rootProj, at.a), '{"n":2}\n{"n":3}\n');
  fs.appendFileSync(path.join(rootProj, at.agent), '{"agent":2}\n');
  write(path.join(rootProj, 'd4.jsonl'), '{"late":1}\n');
  fs.appendFileSync(path.join(rootProj, at.c), '{"root":2}\n');
  for (const p of places) fs.appendFileSync(path.join(p, at.c), '{"user":2}\n');
  const userC = fs.readFileSync(path.join(places[1], at.c), 'utf8');

  const order = [];
  const pairs = X.projectPairs(path.join(oldHome, '.claude'), path.join(newHome, '.claude'), oldHome, newHome);
  assert.equal(pairs.length, 2, 'the old name and the new path\'s name');
  const owned = [];
  const c = X.catchUp(pairs, { own: (p) => (owned.push(p), order.push('own')) });
  order.push('caught-up');
  const ended = await X.endTerminals([{ socket: '/tmp/tmux-0/default', session: 'shop' }, { socket: 'relative', session: 'x' }, { socket: '/tmp/tmux-0/default', session: '' }], {
    run: async (argv) => (order.push(argv.join(' ')), { ok: true }),
  });
  const again = X.compareAll(pairs);

  for (const p of places) {
    assert.equal(fs.readFileSync(path.join(p, at.a), 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n');
    assert.equal(fs.readFileSync(path.join(p, at.agent), 'utf8'), '{"agent":1}\n{"agent":2}\n');
    assert.equal(fs.readFileSync(path.join(p, 'd4.jsonl'), 'utf8'), '{"late":1}\n');
  }
  assert.equal(fs.readFileSync(path.join(places[1], at.c), 'utf8'), userC, 'never overwritten');
  assert.equal(c.kept.length, 2);
  assert.ok(c.kept.every((k) => k.endsWith('/c3.jsonl')));
  assert.equal(c.added.length, 2);
  assert.equal(owned.length, 2, 'a new file is given to the user');
  // Only the one terminal with an absolute socket and a name, by its own socket and the exact session name, after the catch-up.
  assert.deepEqual(ended, [{ socket: '/tmp/tmux-0/default', session: 'shop', ok: true }]);
  assert.deepEqual(order.slice(-2), ['caught-up', 'tmux -S /tmp/tmux-0/default kill-session -t =shop']);
  assert.deepEqual(again, { same: 8, total: 10, differ: again.differ });
  assert.ok(again.differ.every((d) => d.endsWith('/c3.jsonl')));
  const lines = X.catchLines(c, ended, again).join('\n');
  assert.match(lines, /brought over in 6 file\(s\)/);
  assert.match(lines, /Not brought over, because the copy is not a clean beginning of root's file/);
  assert.match(lines, /Root's terminal shop ended \(tmux -S \/tmp\/tmux-0\/default kill-session -t =shop\)\./);
  assert.match(lines, /compared by content: 8 of 10 the same\./);
});

test("the catch-up never writes through a link the user's side put in its way, and gives the folders it makes to the user", () => {
  const base = path.join(s.tmp, 'links');
  const rootP = path.join(base, 'root/.claude/projects/p');
  const userHome = path.join(base, 'user');
  const userP = path.join(userHome, '.claude/projects/p');
  const outside = path.join(base, 'outside');
  write(path.join(rootP, 'a.jsonl'), '{"n":1}\n{"n":2}\n');
  write(path.join(rootP, 'new.jsonl'), '{"new":1}\n');
  write(path.join(rootP, 'deep/sub/agent.jsonl'), '{"agent":1}\n');
  write(path.join(outside, 'victim'), '{"n":1}\n');
  fs.mkdirSync(userP, { recursive: true });
  // A file of the copy made a link to a file outside the home, and a folder made a link to a folder outside it.
  fs.symlinkSync(path.join(outside, 'victim'), path.join(userP, 'a.jsonl'));
  fs.symlinkSync(outside, path.join(userP, 'deep'));
  const owned = [];
  const c = X.catchUp([{ from: rootP, to: userP, name: 'p' }], { own: (q) => owned.push(q), home: userHome });
  assert.equal(fs.readFileSync(path.join(outside, 'victim'), 'utf8'), '{"n":1}\n', 'nothing written through the link');
  assert.ok(!fs.existsSync(path.join(outside, 'sub')), 'no folder made through the linked folder');
  assert.deepEqual(c.kept.sort(), ['p/a.jsonl', 'p/deep/sub/agent.jsonl']);
  assert.deepEqual(c.added, ['p/new.jsonl']);
  // A folder the catch-up makes is the user's too, not only the file in it.
  fs.rmSync(path.join(userP, 'deep'));
  const owned2 = [];
  X.catchUp([{ from: rootP, to: userP, name: 'p' }], { own: (q) => owned2.push(q), home: userHome });
  assert.ok(owned2.includes(path.join(userP, 'deep')) && owned2.includes(path.join(userP, 'deep/sub')), owned2.join('\n'));
});
