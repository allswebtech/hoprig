import assert from 'node:assert/strict';
import test from 'node:test';
import { attention, publicAttention } from '../../src/operator/attention.mjs';
import { SOURCES, boardCache, buildBoard, publicBoard, summary } from '../../src/operator/board.mjs';
import { NOW, bigSources } from './fixtures/bigboard.mjs';
import { ago, session } from './fixtures/cases.mjs';

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

test('every source is watched: read ones with a line, failing or slow ones as "could not be read: <cause>"', async () => {
  const board = await buildBoard({
    sessions: () => [session({ name: 'alpha' })],
    repos: () => { throw new Error('git is not installed at /usr/bin/git'); },
    // Answers, but only after 400 ms: with a limit of 50 ms it must count as not read.
    machine: () => new Promise((r) => setTimeout(() => r({ cpus: 4, load1: 1 }), 400)),
  }, { now: NOW, timeoutMs: 50 });
  assert.equal(board.watched.length, SOURCES.length);
  const by = Object.fromEntries(board.watched.map((w) => [w.source, w]));
  assert.equal(by.sessions.ok, true);
  assert.equal(by.sessions.summary, '1 session, 1 working, 0 asking');
  assert.equal(by.repos.ok, false);
  assert.equal(by.repos.error, 'could not be read: git is not installed at …');
  assert.equal(by.machine.error, 'could not be read: no answer within 0.05 s');
  assert.equal(by.work.error, 'could not be read: not on this computer');
  assert.equal(board.repos, null);
  assert.deepEqual(board.watched.map((w) => w.source), SOURCES.map(([n]) => n));
});

test('a look within 5 seconds reads no source again; after that it does', async () => {
  let reads = 0;
  let t = 1000;
  const cache = boardCache((now) => buildBoard({ sessions: () => { reads++; return []; } }, { now }), { clock: () => t });
  await cache.get();
  t += 4999;
  await cache.get();
  assert.equal(reads, 1);
  t += 2;
  await cache.get();
  assert.equal(reads, 2);
});

test('the attention list: ranked, the same thing one item, "Not now" hides it until its facts change', async () => {
  const sources = { sessions: () => [session({ name: 'beta', asks: ['main'], askType: 'question', askAt: ago(5), state: 'attention' }), session({ name: 'alpha', limit: { at: ago(3) } })] };
  const board = await buildBoard(sources, { now: NOW });
  const a = attention(board, { now: NOW });
  assert.deepEqual(a.items.map((i) => `${i.kind} ${i.subject}`), ['limit session alpha', 'asks session beta']);
  const again = attention(await buildBoard(sources, { now: NOW + 1000 }), { now: NOW + 1000 });
  assert.deepEqual(again.items.map((i) => i.id), a.items.map((i) => i.id));
  const dismissed = new Map([[a.items[1].id, a.items[1].rev]]);
  const put = attention(board, { now: NOW, dismissed });
  assert.equal(put.items.length, 1);
  assert.equal(put.hidden, 1);
  const later = await buildBoard(sources, { now: NOW + 10 * 60_000 });
  assert.equal(attention(later, { now: NOW + 10 * 60_000, dismissed }).items.length, 1, 'only time went by: it stays put off');
  const more = await buildBoard({ sessions: () => [session({ name: 'beta', asks: ['main', 'a9'], askType: 'question', askAt: ago(5), state: 'attention' })] }, { now: NOW });
  const back = attention(more, { now: NOW, dismissed });
  assert.equal(back.items.length, 1, 'an agent waits too: its facts changed, so it is back');
  assert.ok(back.present.has(a.items[1].id));
});

test('a detector that throws does not hide the others', async () => {
  const board = await buildBoard({ sessions: () => [session({ name: 'a', limit: { at: ago(1) } })], machine: () => ({ get cpus() { throw new Error('odd'); } }) }, { now: NOW });
  const a = attention(board, { now: NOW });
  assert.equal(a.items.length, 1);
  assert.deepEqual(a.broken.map((b) => b.kind), ['machine']);
});

test('size budgets on a big machine: board 24 KB, one item 700 bytes, 20 items 8 KB', async () => {
  const board = await buildBoard(bigSources(), { now: NOW, extra: { port: 7400 } });
  const pub = publicBoard(board);
  assert.ok(bytes(pub) <= 24 * 1024, `board is ${bytes(pub)} bytes`);
  assert.equal(pub.sessions.count, 100);
  assert.equal(pub.repos.more > 0, true);
  const list = attention(board, { now: NOW });
  assert.ok(list.items.length > 100, `${list.items.length} items`);
  for (const it of publicAttention(list, { limit: 1000 }).items) assert.ok(bytes(it) <= 700, `${it.kind} item is ${bytes(it)} bytes`);
  const twenty = publicAttention(list, { limit: 20 });
  assert.ok(bytes(twenty) <= 8 * 1024, `20 items are ${bytes(twenty)} bytes`);
  assert.equal(twenty.more, list.items.length - twenty.items.length);
  assert.equal(twenty.shortened, true, 'this big list had to be shortened');
  assert.deepEqual(twenty.items.map((i) => i.rev), list.items.slice(0, twenty.items.length).map((i) => i.rev), 'shortening never changes what a tap refers to');
  const small = publicAttention(attention(await buildBoard({ sessions: () => [session({ name: 'a', limit: { at: ago(1) } })] }, { now: NOW }), { now: NOW }));
  assert.equal(small.shortened, undefined, 'a small list is left whole');
});

test('nothing private on the board: no command input, no address, no transcript', async () => {
  const board = await buildBoard({
    sessions: () => [session({ name: 'a', toolNow: { name: 'Bash', since: ago(30), input: 'curl https://x.example/?token=SECRET' }, transcript: 'SECRET words', lastMessage: 'SECRET' })],
    live: () => ({ local: { status: 200, url: 'http://127.0.0.1:7400/?k=SECRET' }, link: { on: true, status: 530, url: 'https://SECRET.example' } }),
  }, { now: NOW });
  assert.doesNotMatch(JSON.stringify(publicBoard(board)), /SECRET/);
  assert.doesNotMatch(JSON.stringify(publicAttention(attention(board, { now: NOW }))), /SECRET/);
});

test('on a big machine stopped work and what waits for the owner come before repositories with work in progress', async () => {
  const list = attention(await buildBoard(bigSources(), { now: NOW }), { now: NOW });
  const at = (k) => list.items.findIndex((i) => i.kind === k);
  for (const k of ['limit', 'stuck', 'asks']) assert.ok(at(k) < at('repo'), `${k} at ${at(k)}, repo at ${at('repo')}`);
});

test('a long list is shortened from its last items up: the first item and every subject stay whole', async () => {
  const list = attention(await buildBoard(bigSources(), { now: NOW }), { now: NOW });
  const full = publicAttention(list, { limit: 1000 }).items;
  const twenty = publicAttention(list, { limit: 20 });
  assert.equal(twenty.shortened, true);
  assert.deepEqual(twenty.items[0].facts, full[0].facts, 'the first item is whole');
  assert.deepEqual(twenty.items.map((i) => i.subject), full.slice(0, twenty.items.length).map((i) => i.subject), 'no subject is cut');
  assert.equal(twenty.items.length + twenty.more, list.items.length, 'what does not fit is counted in more');
  assert.equal(twenty.kinds.repo, list.items.filter((i) => i.kind === 'repo').length, 'the count of each kind is of the whole list');
});

test('computers whose state is not known say so; the list counts what needs the owner apart from information', async () => {
  assert.equal(summary('computers', [{ name: 'box2', online: null }]), '1 computer, online not known');
  assert.equal(summary('computers', [{ name: 'box2', online: true }, { name: 'box3', online: false }]), '2 computers, 1 online');
  const l = publicAttention(attention(await buildBoard({ sessions: () => [session({ name: 'a', limit: { at: ago(3) } })], repos: () => [{ name: 'shop', path: 'shop', branch: 'main', upstream: 'origin/main', behind: 1, ahead: 0, dirty: 0 }] }, { now: NOW }), { now: NOW }));
  assert.deepEqual([l.count, l.needs], [2, 1]);
});
