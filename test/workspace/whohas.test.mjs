// Which computer has what (whohas.mjs), on two temporary homes that share one made-up brain (a local bare
// repository): "desk" and "box2". For an entry: the computers that have it; for a computer: what it has and when its
// file was written; an old file says so; a computer of the Computers list with no file is unknown, never "has
// nothing"; "last here" from the brain's history of this computer's own file. The page's route, `workspace status
// --all --json` and `get --list --json` give the same answer, from the one reader.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropWorld, getOn } from './dropfix.mjs';

const w = await dropWorld('whohas', { labels: ['desk', 'box2'] });
test.after(() => w.cleanup());
const [D, B] = w.computers;
const C = await import('../../src/workspace/computer.mjs');
const { whoHas, OLD_DAYS } = await import('../../src/workspace/whohas.mjs');

const commitOwn = (c, label, when = null) => {
  c.use();
  if (when) process.env.GIT_COMMITTER_DATE = process.env.GIT_AUTHOR_DATE = when;
  try {
    w.sh(c.brain, 'add', '--', `computers/${label}.json`);
    w.sh(c.brain, 'commit', '-q', '-m', `computer ${label}`);
    w.sh(c.brain, 'pull', '-q', '--rebase');
    w.sh(c.brain, 'push', '-q');
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
    delete process.env.GIT_AUTHOR_DATE;
  }
};

// box2 has blog, and its file was last committed twelve days ago. desk had blog once (its history says so) and has shop.
assert.equal((await getOn(B, ['blog'])).code, 0);
B.use();
await C.writeOwnFile(B.ctx);
const old = new Date(Date.now() - (OLD_DAYS + 5) * 86_400_000).toISOString();
commitOwn(B, 'box2', old);
assert.equal((await getOn(D, ['blog'])).code, 0);
D.use();
await C.writeOwnFile(D.ctx);
commitOwn(D, 'desk');
fs.rmSync(path.join(D.projects, 'blog'), { recursive: true, force: true });
assert.equal((await getOn(D, ['shop'])).code, 0);
D.use();
await C.writeOwnFile(D.ctx);
commitOwn(D, 'desk');
const leftAt = Number(w.sh(D.brain, 'log', '-1', '--format=%ct', '--', 'computers/desk.json')) * 1000;

test('an entry names the computers that have it; an old file says so; a computer with no file is unknown', async () => {
  D.use();
  const r = await whoHas({ ...D.ctx, machines: ['box2', 'lab'] });
  const e = (n) => r.entries.find((x) => x.name === n);
  assert.deepEqual(e('shop').on, ['desk']);
  assert.equal(e('shop').here, true);
  assert.deepEqual(e('blog').on, ['box2'], 'box2 has blog by its own file');
  assert.equal(e('blog').here, false);
  const box2 = r.computers.find((c) => c.label === 'box2');
  assert.deepEqual(box2.here, ['blog']);
  assert.ok(Math.abs(box2.written - Date.parse(old)) < 2000, 'written: the last brain commit of its file');
  assert.equal(box2.old, true, 'a file older than a week is old');
  const desk = r.computers.find((c) => c.label === 'desk');
  assert.equal(desk.mine, true);
  assert.equal(desk.old, false);
  assert.deepEqual(r.unknown, ['lab'], 'lab is in the Computers list with no file: unknown');
  assert.ok(!r.computers.some((c) => c.label === 'lab'), 'never a computer that "has nothing"');
  assert.ok(r.notes.some((n) => /lab has written no file in the brain: what it has is not known/.test(n)));
});

test('"last here": from the brain\'s history of this computer\'s own file; nothing when it does not say', async () => {
  D.use();
  const r = await whoHas({ ...D.ctx });
  const blog = r.entries.find((x) => x.name === 'blog');
  assert.equal(blog.lastHere, leftAt, 'blog left desk\'s file in that commit');
  assert.equal(r.entries.find((x) => x.name === 'shop').lastHere, undefined, 'here now: no "last here"');
  B.use();
  const b = await whoHas({ ...B.ctx });
  assert.equal(b.entries.find((x) => x.name === 'shop').lastHere, undefined, 'never on box2: nothing is said');
});

test('the page, status --all --json and get --list --json give the same answer from the one reader', async () => {
  D.use();
  fs.mkdirSync(D.env.HOPRIG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(D.env.HOPRIG_CONFIG_DIR, 'machines.json'), JSON.stringify({ machines: [{ name: 'lab', label: 'lab', via: 'ssh', target: 'alex@box9', remoteHost: '127.0.0.1', remotePort: 7433, token: 'hop_x' }] }));
  const { main } = await import('../../src/workspace/cli.mjs');
  const { getMain } = await import('../../src/pcsetup/getproject.mjs');
  const { quietUi } = await import('./gitfix.mjs');
  let st = '';
  assert.equal(await main(['status', '--all', '--json'], { ui: (await quietUi()).ui, write: (s) => (st += s) }), 0);
  let gl = '';
  assert.equal(await getMain(['--list', '--json'], { ui: (await quietUi()).ui, write: (s) => (gl += s), dir: D.projects }), 0);
  const s = JSON.parse(st);
  const g = JSON.parse(gl);
  const want = await whoHas({ ...D.ctx, machines: ['lab'] });
  const short = (list) => list.map(({ label, written, old }) => ({ label, written, old }));
  assert.deepEqual(short(s.computers), short(want.computers));
  assert.deepEqual(short(g.computers), short(want.computers));
  assert.deepEqual(s.unknown, ['lab']);
  assert.deepEqual(g.unknown, ['lab']);
  assert.deepEqual(g.entries, want.entries);
  // One reader: no other module of the product reads the computers' files for "which computer has what".
  const src = path.join(import.meta.dirname, '..', '..', 'src');
  for (const f of ['pcsetup/getlist.mjs', 'workspace/cli.mjs']) assert.match(fs.readFileSync(path.join(src, f), 'utf8'), /whohas\.mjs/, `${f} uses the one reader`);
  assert.doesNotMatch(fs.readFileSync(path.join(src, 'pcsetup/getlist.mjs'), 'utf8'), /whoHasWhat|hereOnThisComputer/, 'get --list has no second reader');
});

test('a project added after the last one moves a comma, never "last here"; this computer\'s row is its disk', async () => {
  // box2 has blog (its file committed), then gets shop: the diff shows `-  "blog"` / `+  "blog",`.
  assert.equal((await getOn(B, ['shop'])).code, 0);
  B.use();
  await C.writeOwnFile(B.ctx);
  commitOwn(B, 'box2');
  const listed = JSON.parse(w.sh(B.brain, 'show', 'HEAD:computers/box2.json')).here;
  assert.ok(listed.includes('blog') && listed.includes('shop') && listed.indexOf('blog') < listed.indexOf('shop'), JSON.stringify(listed));
  // blog goes from box2's disk by hand; its file is not written again.
  fs.rmSync(path.join(B.projects, 'blog'), { recursive: true, force: true });
  const r = await whoHas({ ...B.ctx });
  const blog = r.entries.find((x) => x.name === 'blog');
  assert.equal(blog.here, false);
  assert.equal(blog.lastHere, undefined, 'its newest committed file still lists blog: the history says no date');
  const mine = r.computers.find((c) => c.mine);
  assert.equal(mine.label, 'box2');
  assert.equal(mine.fromDisk, true);
  assert.ok(!mine.here.includes('blog'), 'this computer\'s row: what its disk has now, not its old file');
  assert.ok(mine.here.includes('shop'));
});

test('a refused file is named as refused, never as a computer that wrote none', async () => {
  D.use();
  const bad = path.join(D.brain, 'computers', 'box4.json');
  fs.writeFileSync(bad, '{ not json');
  try {
    const r = await whoHas({ ...D.ctx, machines: ['box4', 'lab'] });
    assert.deepEqual(r.unknown, ['lab']);
    assert.ok(r.refused.some((x) => x.name === 'box4.json' && /not valid JSON/.test(x.why)), JSON.stringify(r.refused));
    assert.ok(!r.notes.some((n) => /box4 has written no file/.test(n)), JSON.stringify(r.notes));
  } finally {
    fs.rmSync(bad);
  }
});

test('a file under this label with another computer\'s id: a conflict, one row for this computer from its disk, no label twice', async () => {
  D.use();
  const file = path.join(D.brain, 'computers', 'desk.json');
  const keep = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, keep.replace(/"id": "[0-9a-f]{32}"/, `"id": "${'a'.repeat(32)}"`));
  try {
    const r = await whoHas({ ...D.ctx });
    const desks = r.computers.filter((c) => c.label === 'desk');
    assert.equal(desks.length, 1, JSON.stringify(r.computers));
    assert.equal(desks[0].mine, true);
    assert.deepEqual(r.entries.find((x) => x.name === 'shop').on, ['desk']);
    assert.ok(r.conflicts && r.conflicts.some((c) => c.label === 'desk' && /another computer's id/.test(c.why)));
  } finally {
    fs.writeFileSync(file, keep);
  }
});

test('a computer listed under another name than its label: joined by the label it reported; else both names, never "has nothing"', async () => {
  D.use();
  // Listed as "office", and its Hoprig said its workspace label is box2 (machines.json info.workspace).
  const joined = await whoHas({ ...D.ctx, machines: [{ name: 'office', workspace: 'box2' }] });
  const box2 = joined.computers.find((c) => c.label === 'box2');
  assert.deepEqual(box2.listedAs, ['office'], 'its file\'s row names the Computers entry');
  assert.deepEqual(box2.here, ['blog']);
  assert.deepEqual(joined.unknown, [], 'not unknown beside its own file');
  assert.equal(joined.unjoined, undefined);
  // An older Hoprig said no label: it cannot be joined; the row says both names and that they could not be joined.
  const loose = await whoHas({ ...D.ctx, machines: [{ name: 'office' }] });
  assert.deepEqual(loose.unknown, ['office']);
  assert.deepEqual(loose.unjoined, [{ name: 'office', maybe: ['box2'] }]);
  assert.ok(loose.notes.some((n) => /office could not be joined with a computer's file: .*update Hoprig there.*It may be box2/.test(n)), loose.notes.join(' | '));
  assert.ok(!loose.computers.find((c) => c.label === 'box2').listedAs, 'nothing is joined by a guess');
  // A name that matches a file needs no label (as before), and a reported label that is no label is not kept.
  const byName = await whoHas({ ...D.ctx, machines: ['box2'] });
  assert.deepEqual([byName.unknown, byName.computers.find((c) => c.label === 'box2').listedAs], [[], undefined]);
  const { workspaceOf } = await import('../../src/machines/hub.mjs');
  assert.deepEqual([workspaceOf({ workspace: 'box2' }), workspaceOf({ workspace: '../x' }), workspaceOf({ workspace: 'Box 2' }), workspaceOf({})], [{ workspace: 'box2' }, {}, {}, {}]);
  // This computer says its own label to a hub (GET /api/machine, pair --json).
  const { machineInfo } = await import('../../src/machines/pairing.mjs');
  assert.equal(machineInfo().workspace, 'desk');
});
