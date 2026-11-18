// The lock of a Work file between two real processes: a holder that still runs keeps it however old its file is (the
// old rule took any lock older than 30 s); a release never removes a lock another process holds now; a lock of a
// process that has ended is taken at once; one whose process cannot be told is taken only after it went unrefreshed
// for UNPROVEN_STALE_MS. A save holds the lock only while it commits, never across the fetch or the send.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-lock');
test.after(() => t.cleanup());
const { changeDoc, workStore } = await import('../../src/work/store.mjs');
const { lockFile, UNPROVEN_STALE_MS } = await import('../../src/work/lock.mjs');
const LOCK = new URL('../../src/work/lock.mjs', import.meta.url).href;

const file = path.join(t.root, 'list', 'tasks.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
const settings = { timeZone: '', ownerId: 'me', saveSubject: 'Update work items' };
const add = (title, opts) => changeDoc(file, (doc) => doc.items.push({ id: title.toLowerCase().replace(/\W+/g, '-'), title }), opts);
const ids = () => JSON.parse(fs.readFileSync(file, 'utf8')).items.map((x) => x.id);
const backdate = (seconds) => {
  const then = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(lockFile(file), then, then);
};

/** Another process that takes the lock, says "held", and lets it go when it reads a line ("released" after). */
function holder() {
  const code = `import { withLock } from ${JSON.stringify(LOCK)};
    await withLock(${JSON.stringify(file)}, async () => {
      process.stdout.write('held\\n');
      await new Promise((r) => process.stdin.once('data', r));
      process.stdin.destroy();
    });
    process.stdout.write('released\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    out += d;
    for (const w of [...waiters]) if (out.includes(w.word)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  });
  const said = (word) => (out.includes(word) ? Promise.resolve() : new Promise((resolve) => waiters.push({ word, resolve })));
  const ended = new Promise((r) => child.on('exit', r));
  return { child, said, ended, let: () => child.stdin.write('go\n') };
}

test('a holder that still runs keeps the lock, also when its file is older than the old 30 s', async () => {
  fs.writeFileSync(file, '{\n  "items": []\n}\n');
  const h = holder();
  await h.said('held');
  const theirs = fs.readFileSync(lockFile(file), 'utf8');
  assert.equal(JSON.parse(theirs).pid, h.child.pid, 'the lock names its process');
  assert.match(JSON.parse(theirs).proc || '', /^[LT]:/, 'and that process\'s identity, as the run records do');
  backdate(40); // as if it had been held for 40 s (a save across a slow fetch did that before)
  await assert.rejects(add('Written while held', { wait: 1200 }), (e) => e.status === 409 && e.code === 'busy');
  assert.deepEqual(ids(), [], 'nothing written while the other process holds the lock');
  assert.equal(fs.readFileSync(lockFile(file), 'utf8'), theirs, 'its lock is untouched');
  h.let();
  await h.said('released');
  await h.ended;
  assert.equal(fs.existsSync(lockFile(file)), false, 'its release removed its own lock');
  await add('Written after');
  assert.deepEqual(ids(), ['written-after']);
});

test('a release never removes a lock that another process holds now', async () => {
  const h = holder();
  await h.said('held');
  // Another process took it meanwhile (as a takeover would): the holder's release must leave that one alone.
  const other = JSON.stringify({ pid: process.pid, proc: null, token: 'someone-else', at: new Date().toISOString() });
  fs.writeFileSync(lockFile(file), other);
  h.let();
  await h.ended;
  assert.equal(fs.readFileSync(lockFile(file), 'utf8'), other);
  fs.rmSync(lockFile(file));
});

test('the lock of a process that has ended is taken at once; one that cannot be told only after a while', async () => {
  const gone = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const ended = JSON.stringify({ pid: gone, proc: 'L:x:1', token: 'dead', at: new Date().toISOString() });
  fs.writeFileSync(lockFile(file), ended);
  await add('After a dead holder', { wait: 1000 });
  assert.ok(ids().includes('after-a-dead-holder'));
  // A running process (the test runner) named without an identity that can be compared: not taken while fresh.
  const unknown = JSON.stringify({ pid: process.ppid, proc: null, token: 'unknown', at: new Date().toISOString() });
  fs.writeFileSync(lockFile(file), unknown);
  await assert.rejects(add('Not yet', { wait: 600 }), (e) => e.code === 'busy');
  backdate(UNPROVEN_STALE_MS / 1000 + 5);
  await add('After the while', { wait: 1000 });
  assert.ok(ids().includes('after-the-while'));
  assert.equal(fs.existsSync(lockFile(file)), false);
  // A lock of an older Hoprig (a bare pid) of a process that has ended: taken at once too.
  fs.writeFileSync(lockFile(file), String(gone));
  await add('After an old lock', { wait: 1000 });
  assert.ok(ids().includes('after-an-old-lock'));
});

test('three processes writing at once: every change lands, none is lost', async () => {
  fs.writeFileSync(file, '{\n  "items": []\n}\n');
  const STORE = new URL('../../src/work/store.mjs', import.meta.url).href;
  const writer = (n) => new Promise((resolve, reject) => {
    const code = `import { changeDoc } from ${JSON.stringify(STORE)};
      await Promise.all(Array.from({ length: 5 }, (_, i) => changeDoc(${JSON.stringify(file)}, (doc) => doc.items.push({ id: 'p${n}-' + i, title: 'From process ${n}' }))));`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(`writer ${n} ended with ${status}`))));
  });
  await Promise.all([writer(1), writer(2), writer(3)]);
  assert.equal(ids().length, 15);
  assert.deepEqual(ids().sort(), [1, 2, 3].flatMap((n) => [0, 1, 2, 3, 4].map((i) => `p${n}-${i}`)).sort());
  assert.equal(fs.existsSync(lockFile(file)), false);
});

test('a save holds the lock only while it commits: a change of the page goes through during its fetch', async () => {
  const { saveWork } = await import('../../src/work/save.mjs');
  const shop = path.join(t.projects, 'shop');
  t.repo(shop, { 'README.md': '# shop\n', 'tasks/tasks.json': '{\n  "items": []\n}\n' });
  const place = { file: path.join(shop, 'tasks', 'tasks.json'), folder: path.join(shop, 'tasks'), base: shop, label: 'shop/tasks', fileName: 'tasks.json', kind: 'project', settings };
  await workStore(place).add({ title: 'Before the save' });
  let during = null;
  // A git that takes its time to fetch; while it does, the page adds an item.
  const { capture } = await import('../../src/setup/system.mjs');
  const slowFetch = async (argv, opts) => {
    if (argv.includes('fetch')) during = await workStore(place).add({ title: 'Added during the fetch' }, { wait: 500 }).then(() => 'written', (e) => e.code);
    return capture(argv, opts);
  };
  const r = await saveWork(place, { subject: 'Update work items', run: slowFetch });
  assert.equal(during, 'written', 'the page was not kept waiting by the fetch');
  // The file changed between the plan and the commit: nothing committed, the new plan comes back.
  assert.equal(r.code, 'moved', r.message);
  assert.equal(r.saved, false);
  assert.deepEqual(r.plan.changes.map((c) => c.title).sort(), ['Added during the fetch', 'Before the save']);
  const again = await saveWork(place, { subject: 'Update work items', expect: { hash: r.plan.hash } });
  assert.equal(again.sent, true, again.message);
});
