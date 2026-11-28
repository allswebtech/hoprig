// Watches (design 2.4): the owner's own state; evaluated from facts the attention loop already has; tell once; no model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WatchStore, factsOf, MAX_WATCHES, WAKES_PER_DAY } from '../../src/assistant/watches.mjs';

const board = (sessions) => ({ sessions });
const mk = (now = () => 1_000_000, notify = null) => new WatchStore({ file: null, now, notify });

test('a watch fires once when its session needs him, by push, and not again', () => {
  const pushed = [];
  const w = mk(undefined, (t) => pushed.push(t));
  w.add({ on: 'session', target: 'alpha', when: 'needs-me' });
  assert.deepEqual(w.evaluate(factsOf(board([{ name: 'alpha', state: 'working', asks: [] }]))), [], 'not yet');
  const f = w.evaluate(factsOf(board([{ name: 'alpha', state: 'working', asks: ['ok?'] }])));
  assert.equal(f.length, 1);
  assert.match(f[0].text, /alpha needs you/);
  assert.deepEqual(pushed, [f[0].text]);
  assert.deepEqual(w.evaluate(factsOf(board([{ name: 'alpha', asks: ['ok?'] }]))), [], 'tells once');
});

test('what cannot be seen is not told; a row watch shows in the list and sends no push', () => {
  const pushed = [];
  const w = mk(undefined, (t) => pushed.push(t));
  w.add({ on: 'session', target: 'gone', when: 'ends', tell: 'row' });
  assert.deepEqual(w.evaluate(factsOf(board([]))), []);
  const f = w.evaluate(factsOf(board([{ name: 'gone', state: 'ended' }])));
  assert.equal(f.length, 1);
  assert.deepEqual(pushed, []);
  assert.equal(w.rows().length, 1);
});

test('a watch runs out after its hours; at most 50; the same watch twice is one', () => {
  let t = 0;
  const w = mk(() => t);
  const r = w.add({ on: 'session', target: 'a', when: 'ends', hours: 1 });
  assert.equal(w.add({ on: 'session', target: 'a', when: 'ends', hours: 1 }).already, true);
  t = 3600_001;
  assert.equal(w.list().length, 0);
  assert.ok(r.watch);
  const w2 = mk();
  for (let i = 0; i < MAX_WATCHES; i++) assert.ok(w2.add({ on: 'session', target: `s${i}`, when: 'ends' }).watch);
  assert.match(w2.add({ on: 'session', target: 'more', when: 'ends' }).error, /50/);
});

test('a bad watch is refused with what works; the hours stay in 1 to 72', () => {
  const w = mk();
  assert.match(w.add({ on: 'gateway', target: 'g', when: 'needs-me' }).error, /fails, back/);
  assert.match(w.add({ on: 'session', target: 'a', when: 'ends', hours: 73 }).error, /1 to 72/);
  assert.match(w.add({ on: 'session', when: 'ends' }).error, /which session/);
});

test('a wake wakes her only ten times a day; past that it is told as a push only', () => {
  const w = mk();
  const fired = [];
  for (let i = 0; i < WAKES_PER_DAY + 2; i++) {
    w.add({ on: 'session', target: `s${i}`, when: 'ends', tell: 'wake' });
    fired.push(...w.evaluate(factsOf(board([{ name: `s${i}`, state: 'ended' }]))));
  }
  assert.equal(fired.filter((e) => e.wake).length, WAKES_PER_DAY);
  assert.equal(fired.length, WAKES_PER_DAY + 2);
});

test('a provider limit and a computer coming back are read from the board', () => {
  const w = mk();
  w.add({ on: 'provider', target: 'p1', when: 'limit' });
  w.add({ on: 'computer', target: 'c1', when: 'back' });
  const none = w.evaluate({ ...factsOf({ providers: [{ name: 'p1', limited: false }], computers: [{ name: 'c1', status: 'offline' }] }) });
  assert.equal(none.length, 0);
  const both = w.evaluate(factsOf({ providers: [{ name: 'p1', limited: true }], computers: [{ name: 'c1', status: 'online' }] }));
  assert.equal(both.length, 2);
});

test('it is kept in a file of its own and read back', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watches-'));
  const file = path.join(dir, 'a', 'watches.json');
  const a = new WatchStore({ file });
  a.add({ on: 'session', target: 'x', when: 'ends' });
  assert.equal(new WatchStore({ file }).list().length, 1);
  fs.rmSync(dir, { recursive: true });
});
