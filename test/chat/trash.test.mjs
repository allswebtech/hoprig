// Hoprig's trash for conversations (src/chat/trash.mjs): a delete moves only the conversation's own files (its
// .jsonl and its folder of the same id), Put back brings them back and refuses to overwrite a conversation that is
// there again, the purge removes what is older than 30 days (a made-up clock), and a dashboard killed at any step
// of a delete, a Put back or a purge leaves the conversation where it was or whole in the trash, never split. Every
// case compares the whole home, file by file, before and after.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('trash');
test.after(() => box.cleanup());
const { trash, trashDir, KEEP_DAYS } = await import('../../src/chat/trash.mjs');
const { projectDir } = await import('../../src/sessions.mjs');
const TRASH = new URL('../../src/chat/trash.mjs', import.meta.url).href;
const DAY = 86_400_000;

/** `p` relative to `root`, with / between its parts on every system (Windows' own is \\). */
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
/** Every file under `root` with its content's hash (links as their target), relative names. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = rel(root, p);
      if (e.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) {
        out[`${r}/`] = 'dir';
        walk(p);
      } else out[r] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
/** The snapshot's names of the trash, of the conversation's own files and of everything else. */
const outside = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith('state/trash')));

let n = 0;
/** A project with two conversations, a subagent folder, a memory folder and the project's own files. */
function home() {
  n++;
  const cwd = path.join(box.root, 'work', `shop${n}`);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'cart.js'), 'export const total = 1;\n');
  fs.writeFileSync(path.join(cwd, `${'0'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}.jsonl`), 'a project file that only looks like a conversation\n');
  const dir = projectDir(cwd);
  const id = crypto.randomUUID();
  const other = crypto.randomUUID();
  fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the cart' } })}\n`);
  fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-a1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, `${other}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(dir, `${other}-notes.txt`), 'a neighbour that starts with its id\n');
  fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# notes\n');
  return { cwd, dir, id, other };
}
const mine = (h) => [rel(box.root, path.join(h.dir, `${h.id}.jsonl`)), rel(box.root, path.join(h.dir, h.id))];
/** Of two snapshots, what is only in one or differs. */
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

test('a delete moves only the conversation\'s .jsonl and its own folder; Put back brings exactly those back', () => {
  const h = home();
  const before = snapshot(box.root);
  const t = trash();
  const e = t.put(h.cwd, h.id, { title: 'Fix the cart' });
  assert.equal(e.files, 2);
  assert.equal(e.until - e.at, KEEP_DAYS * DAY, 'kept for 30 days');
  const after = snapshot(box.root);
  const moved = changed(outside(before), outside(after));
  const [file, folder] = mine(h);
  assert.deepEqual(moved, [file, `${folder}/`, `${folder}/subagents/`, `${folder}/subagents/agent-a1.jsonl`].sort(), 'only its own files left their place, nothing else changed');
  assert.deepEqual(t.list().map((x) => x.conversationId), [h.id]);
  t.restore(e.id);
  assert.deepEqual(outside(snapshot(box.root)), outside(before), 'every file of the home is as it was');
  assert.deepEqual(fs.readdirSync(trashDir()), [], 'the trash is empty again');
  assert.deepEqual(t.list(), []);
});

test('several deletes, then Put back refused while a conversation with the same id is there again', () => {
  const h = home();
  const t = trash();
  const a = t.put(h.cwd, h.id);
  const b = t.put(h.cwd, h.other);
  assert.equal(t.list().length >= 2, true);
  fs.writeFileSync(path.join(h.dir, `${h.id}.jsonl`), 'a new conversation with the same id\n');
  const was = snapshot(box.root);
  assert.throws(() => t.restore(a.id), (e) => e.status === 409 && /same id is in that folder again/.test(e.message));
  assert.deepEqual(snapshot(box.root), was, 'nothing moved: the one there is kept, the deleted one stays in the trash');
  assert.equal(fs.readFileSync(path.join(h.dir, `${h.id}.jsonl`), 'utf8'), 'a new conversation with the same id\n');
  t.restore(b.id);
  assert.ok(fs.existsSync(path.join(h.dir, `${h.other}.jsonl`)));
  assert.throws(() => t.restore(b.id), (e) => e.status === 404, 'only once');
});

test('after 30 days (a made-up clock) the purge removes the entry with its transcript, and nothing else', () => {
  const h = home();
  let now = Date.now(); // the clock the earlier cases' entries were made with
  const t = trash({ now: () => now });
  const e = t.put(h.cwd, h.id);
  const kept = outside(snapshot(box.root));
  now += (KEEP_DAYS - 1) * DAY;
  assert.equal(t.purge(), 0, 'not yet after 29 days');
  assert.ok(t.get(e.id));
  now += DAY;
  assert.ok(t.purge() >= 1, 'on day 30');
  assert.equal(t.get(e.id), null);
  assert.equal(fs.existsSync(path.join(trashDir(), e.id)), false, 'its transcript went with it');
  assert.deepEqual(outside(snapshot(box.root)), kept, 'nothing outside the trash was touched');
});

test('the purge also removes what Hoprig kept of that conversation (its turns\' ends and OKs), and no other conversation\'s', () => {
  const h = home();
  let now = Date.now();
  const t = trash({ now: () => now });
  const turns = path.join(box.state, 'chat-turns');
  fs.mkdirSync(turns, { recursive: true });
  fs.writeFileSync(path.join(turns, `${h.id}.jsonl`), '{"messageId":"m1","end":{}}\n');
  fs.writeFileSync(path.join(turns, `${h.other}.jsonl`), '{"messageId":"m2","end":{}}\n');
  t.put(h.cwd, h.id);
  now += KEEP_DAYS * DAY;
  t.purge();
  assert.equal(fs.existsSync(path.join(turns, `${h.id}.jsonl`)), false, 'its turns went with it');
  assert.equal(fs.existsSync(path.join(turns, `${h.other}.jsonl`)), true, 'another conversation\'s stay');
});

test('a path or id from a browser that leaves Claude Code\'s projects folder is refused, and nothing moves', () => {
  const h = home();
  const before = snapshot(box.root);
  const t = trash();
  for (const id of ['../x', `${h.id}/../../x`, 'memory', '', null]) assert.throws(() => t.put(h.cwd, id), (e) => e.status === 400, String(id));
  assert.throws(() => t.put('relative/folder', h.id), (e) => e.status === 400);
  // The folder's directory is a link to somewhere else: its conversation is not taken from there.
  const elsewhere = path.join(box.root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const cwd = path.join(box.root, 'work', 'linked');
  fs.symlinkSync(elsewhere, projectDir(cwd));
  fs.writeFileSync(path.join(elsewhere, `${h.id}.jsonl`), 'x\n');
  const snapLinked = snapshot(box.root);
  assert.throws(() => t.put(cwd, h.id), (e) => e.status === 400 && /projects folder/.test(e.message));
  assert.deepEqual(snapshot(box.root), snapLinked);
  // A conversation whose file is a link is left alone too.
  const id = crypto.randomUUID();
  fs.symlinkSync(path.join(h.cwd, 'src', 'cart.js'), path.join(h.dir, `${id}.jsonl`));
  assert.throws(() => t.put(h.cwd, id), (e) => e.status === 400 && /plain file/.test(e.message));
  assert.equal(fs.readFileSync(path.join(h.cwd, 'src', 'cart.js'), 'utf8'), 'export const total = 1;\n');
  fs.rmSync(path.join(h.dir, `${id}.jsonl`));
  fs.rmSync(projectDir(cwd));
  fs.rmSync(elsewhere, { recursive: true });
  assert.deepEqual(snapshot(box.root), before);
});

/**
 * Whether the process of `r` (spawnSync) was killed by its own process.kill(pid, 'SIGKILL'): its signal on POSIX; Windows
 * has no signals, so Node ends it outright (TerminateProcess, exit code 1) and spawnSync reports no signal.
 */
const killedSo = (r) => (process.platform === 'win32' ? r.signal === null && r.status === 1 : r.signal === 'SIGKILL');
/** Run `what` of the trash in another process that is killed (SIGKILL) right after journal step `at`. */
function killedAt(what, at, args) {
  const code = `import('${TRASH}').then(async (T) => {
    const t = T.trash({ now: () => ${Date.UTC(2030, 0, 1)} + Number(process.env.SHIFT || 0), step: (s) => s === ${JSON.stringify(at)} && process.kill(process.pid, 'SIGKILL') });
    const a = ${JSON.stringify(args)};
    const r = ${what === 'put' ? 't.put(a[0], a[1])' : what === 'restore' ? 't.restore(a[0])' : 't.purge()'};
    process.stdout.write(JSON.stringify(r));
  })`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SHIFT: String(what === 'purge' ? KEEP_DAYS * DAY + 1 : 0) }, encoding: 'utf8' });
}

test('a dashboard killed at each step of a delete, a Put back and a purge: nothing lost, nothing split', () => {
  for (const at of ['journal', 'moved:0', 'moved:1', 'done']) {
    // ---- a delete ----
    const h = home();
    const before = snapshot(box.root);
    const r = killedAt('put', at, [h.cwd, h.id]);
    assert.ok(killedSo(r), `the delete was killed at ${at}: ${r.signal} ${r.status} ${r.stderr}`);
    trash().recover(); // the next start
    const after = snapshot(box.root);
    const [file] = mine(h);
    const listed = trash().list().filter((x) => x.conversationId === h.id);
    if (after[file]) {
      assert.deepEqual(after, before, `killed at ${at}: it is where it was, the whole home as before`);
      assert.equal(listed.length, 0);
    } else {
      assert.deepEqual(changed(outside(before), outside(after)).filter((k) => !mine(h).some((m) => k === m || k.startsWith(`${m}/`))), [], `killed at ${at}: only its own files moved`);
      assert.equal(listed.length, 1, `killed at ${at}: whole in the trash`);
      const e = trash().get(listed[0].id);
      for (const it of e.items) assert.ok(fs.existsSync(path.join(trashDir(), e.id, 'files', it.name)), `${it.name} is in the trash`);
    }
    // ---- a Put back of it ----
    const t = trash();
    const entry = t.list().find((x) => x.conversationId === h.id) || t.put(h.cwd, h.id);
    const inTrash = snapshot(box.root);
    const r2 = killedAt('restore', at, [entry.id]);
    assert.ok(killedSo(r2), `the Put back was killed at ${at}: ${r2.signal} ${r2.status} ${r2.stderr}`);
    trash().recover();
    const back = snapshot(box.root);
    if (back[file]) {
      assert.deepEqual(outside(back), outside(before), `Put back killed at ${at}: all of it is back`);
      assert.equal(trash().get(entry.id), null);
    } else {
      assert.deepEqual(back, inTrash, `Put back killed at ${at}: still whole in the trash`);
      t.restore(entry.id);
    }
    assert.deepEqual(outside(snapshot(box.root)), outside(before));
  }
  // ---- a purge killed after its journal: finished at the next start, nothing else touched ----
  for (const at of ['journal', 'done']) {
    trash({ now: () => Date.UTC(2040, 0, 1) }).purge(); // what earlier cases left: only this one is in the trash
    const h = home();
    const e = trash({ now: () => Date.UTC(2030, 0, 1) }).put(h.cwd, h.id);
    const kept = outside(snapshot(box.root));
    const r = killedAt('purge', at, []);
    assert.ok(killedSo(r), `the purge was killed at ${at}: ${r.signal} ${r.status} ${r.stderr}`);
    trash().recover();
    assert.equal(trash().get(e.id), null, `purge killed at ${at}: it is gone for good`);
    assert.equal(fs.existsSync(path.join(trashDir(), e.id)), false);
    assert.deepEqual(outside(snapshot(box.root)), kept, 'nothing outside the trash changed');
  }
});
