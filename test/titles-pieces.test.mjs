// Names on a large home (src/titles.mjs readTitles): a list reads only the conversations it shows, and reads them in
// pieces that give the server's one thread back between them, so another request is never held for a whole file.
// Counted, not timed (a busy machine cannot make it pass or fail): how many times the thread came back while a 6 MB
// conversation was read, which files were opened, and that the name read after it reads nothing more at once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './server/helpers.mjs';

const box = sandbox('titlepieces');
test.after(() => box.cleanup());
const T = await import('../src/titles.mjs');
const { folderHistory } = await import('../src/chat/history.mjs');
const { projectDir } = await import('../src/sessions.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;
const id = (n) => `3b0c2f4e-2222-4a2b-8c3d-${String(n).padStart(12, '0')}`;
const cwd = path.join(box.root, 'work', 'shop');
fs.mkdirSync(cwd, { recursive: true });
const dir = projectDir(cwd);
fs.mkdirSync(dir, { recursive: true });
/** A conversation of about `mb` MB: its first words, filler, then a title near its end. */
function convo(n, mb, ageMin) {
  const f = path.join(dir, `${id(n)}.jsonl`);
  const fill = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(64 * 1024) }] } });
  fs.writeFileSync(f, line({ type: 'user', message: { role: 'user', content: `work ${n}` } }) + fill.repeat(Math.max(0, Math.round((mb * 1024) / 64))) + line({ type: 'ai-title', aiTitle: `Title ${n}` }));
  const t = new Date(Date.now() - ageMin * 60_000);
  fs.utimesSync(f, t, t);
  return f;
}
// 60 conversations: the newest is 6 MB, the rest small. Earlier conversations shows the newest 50.
const big = convo(0, 6, 0);
for (let i = 1; i < 60; i++) convo(i, 0.01, i);

/** Every file opened (sync or not) and every byte read at once with readSync, while `fn` runs. */
async function watch(fn) {
  const opened = [];
  let syncBytes = 0;
  const had = { openSync: fs.openSync, readSync: fs.readSync, open: fs.promises.open };
  fs.openSync = function (p, ...r) { opened.push(String(p)); return had.openSync.call(this, p, ...r); };
  fs.readSync = function (...r) { const n = had.readSync.apply(this, r); syncBytes += n; return n; };
  fs.promises.open = function (p, ...r) { opened.push(String(p)); return had.open.call(this, p, ...r); };
  try {
    return { r: await fn(), opened, syncBytes };
  } finally {
    Object.assign(fs, { openSync: had.openSync, readSync: had.readSync });
    fs.promises.open = had.open;
  }
}

test('a list reads only the conversations it shows: Earlier conversations of 60 opens the newest 50, not the other 10', async () => {
  T.forgetTitles();
  const { r, opened } = await watch(() => folderHistory(cwd));
  assert.equal(r.length, 50);
  assert.equal(r[0].title, 'Title 0', 'the 6 MB one is named by its title near the end');
  const convs = new Set(opened.filter((p) => p.startsWith(dir)).map((p) => path.basename(p, '.jsonl')));
  assert.equal(convs.size, 50, 'only the 50 it shows were opened');
  for (let i = 50; i < 60; i++) assert.ok(!convs.has(id(i)), `the 51st and later are not read (${i})`);
});

test('a 6 MB conversation is read in pieces: the thread comes back between them, and the name after it reads nothing at once', async () => {
  T.forgetTitles();
  let back = 0;
  let going = true;
  const tick = () => { if (!going) return; back++; setImmediate(tick); };
  setImmediate(tick);
  const { syncBytes } = await watch(() => T.readTitles([big]));
  going = false;
  // 6 MB in pieces of 256 KB: about 24 pieces, each followed by a turn of the loop.
  assert.ok(back >= 20, `the thread came back ${back} times while it was read (at once: 0 or 1)`);
  assert.equal(syncBytes, 0, 'nothing of it was read at once');
  const after = await watch(() => T.conversationTitle(big).title);
  assert.equal(after.r, 'Title 0');
  assert.equal(after.syncBytes, 0, 'conversationTitle() after readTitles() reads nothing more');
});

test('a piecewise read and a read at once of the same file at the same time: the name is right either way', async () => {
  T.forgetTitles();
  const p = T.readTitles([big]);
  assert.equal(T.conversationTitle(big).title, 'Title 0', 'read at once meanwhile');
  await p;
  fs.appendFileSync(big, line({ type: 'ai-title', aiTitle: 'Title 0, later' }));
  await T.readTitles([big]);
  assert.equal(T.conversationTitle(big).title, 'Title 0, later', 'what was added since is read');
});
