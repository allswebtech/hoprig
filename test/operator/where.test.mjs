// Where Tia starts new work (src/operator/where.mjs), from named cases with made-up computers box2 and box3.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as whereMod from '../../src/operator/where.mjs';

const { chooseWhere, PLACED_MS } = whereMod;
// The 1-minute load average shows a start about a minute after it (where.mjs SHOWN_MS).
const SHOWN_MS = 60_000;

const NOW = Date.parse('2026-03-02T10:00:00Z');
const here = (room, o = {}) => ({ name: 'this', here: true, allowed: true, room, cpus: 8, load1: room === 'full' ? 14 : 2, at: NOW - 30_000, lacks: null, ...o });
const box = (name, room, o = {}) => ({ name, label: name === 'box2' ? 'Box 2' : 'Box 3', allowed: true, room, cpus: 8, load1: room === 'free' ? 1 : room === 'busy' ? 7 : 14, at: NOW - 30_000, lacks: null, ...o });

test('he names a computer she may use: it wins, even when it is busy and this computer has room', () => {
  assert.deepEqual(chooseWhere({ candidates: [here('free'), box('box2', 'busy')], named: 'box2', now: NOW }), { computer: 'box2', why: 'you named Box 2' });
  assert.deepEqual(chooseWhere({ candidates: [here('full'), box('box2', 'free')], named: 'this', now: NOW }), { computer: 'this', why: 'you named this computer' });
});

test('he names one she may not use, one that lacks the project, or one that is not his: nowhere, with the clause', () => {
  assert.deepEqual(chooseWhere({ candidates: [here('free'), box('box2', 'free', { allowed: false })], named: 'box2', now: NOW }), { computer: null, why: 'you have not allowed her to start work on Box 2 (Settings → Tia)' });
  assert.deepEqual(chooseWhere({ candidates: [here('free'), box('box2', 'free', { lacks: 'the project is not there' })], named: 'box2', now: NOW }), { computer: null, why: 'Box 2 cannot take it: the project is not there' });
  assert.equal(chooseWhere({ candidates: [here('free')], named: 'box9', now: NOW }).computer, null);
});

test('this computer unless it is full: free, busy and not known all stay here', () => {
  assert.deepEqual(chooseWhere({ candidates: [here('free'), box('box2', 'free')], now: NOW }), { computer: 'this', why: 'this computer has room' });
  assert.equal(chooseWhere({ candidates: [here('busy'), box('box2', 'free')], now: NOW }).computer, 'this');
  assert.equal(chooseWhere({ candidates: [here('unknown'), box('box2', 'free')], now: NOW }).computer, 'this');
});

test('this computer is full and another has room: there, with why', () => {
  assert.deepEqual(chooseWhere({ candidates: [here('full'), box('box2', 'free')], now: NOW }), { computer: 'box2', why: 'this computer is full and Box 2 has room' });
});

test('the allowed candidate with the most room: free before busy, then the lower load', () => {
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'busy'), box('box3', 'free')], now: NOW }).computer, 'box3');
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'free', { load1: 3 }), box('box3', 'free', { load1: 1 })], now: NOW }).computer, 'box3');
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'free', { allowed: false }), box('box3', 'busy')], now: NOW }).computer, 'box3', 'never one she may not use');
});

test('the other has room but not the project: it is no candidate; she starts here and says why', () => {
  const r = chooseWhere({ candidates: [here('full'), box('box2', 'free', { lacks: 'the project is not there' })], now: NOW });
  assert.deepEqual(r, { computer: 'this', why: 'this computer is full, but Box 2 cannot take it: the project is not there' });
});

test('nothing better: this computer, as today, and the clause says why', () => {
  assert.deepEqual(chooseWhere({ candidates: [here('full')], now: NOW }), { computer: 'this', why: 'this computer is full, but you have allowed her no other computer' });
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'unknown')], now: NOW }).why, 'this computer is full, but the room of Box 2 is not known');
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'full')], now: NOW }).why, 'this computer is full, but Box 2 is full too');
});

test('a tie goes to this computer; only the setting decides which others are candidates', () => {
  // the setting absent: no other is allowed, so even full here she starts here, as today
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'free', { allowed: false })], now: NOW }).computer, 'this');
});

test('ten starts in the same second spread: each one placed counts as one more load until the next answer', () => {
  const candidates = [here('full'), box('box2', 'free', { load1: 4 }), box('box3', 'free', { load1: 4 })];
  const placed = [];
  const where = [];
  for (let i = 0; i < 10; i++) {
    const r = chooseWhere({ candidates, placed, now: NOW });
    where.push(r.computer);
    if (r.computer) placed.push({ name: r.computer, at: NOW });
  }
  const n = (x) => where.filter((w) => w === x).length;
  // three each at most (PLACED_MAX), the rest here, as without another computer
  assert.equal(n('box2'), 3, where.join(','));
  assert.equal(n('box3'), 3, where.join(','));
  assert.equal(n('this'), 4, where.join(','));
  // past the detector's line (1.5 per processor with 8 processors is 12), a computer takes no more
  const many = Array.from({ length: 30 }, () => ({ name: 'box2', at: NOW }));
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'free', { load1: 4 })], placed: many, now: NOW }).computer, 'this');
  // an answer received a minute or more after them counts the old starts in already; an old placement goes after 5 minutes
  // (two starts at load 11 on 8: counted on top they take box2 past 1.5 per processor; shown by its answer they do not)
  const two = [{ name: 'box2', at: NOW - SHOWN_MS }, { name: 'box2', at: NOW - SHOWN_MS }];
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'free', { load1: 11, at: NOW - SHOWN_MS + 1 })], placed: two, now: NOW }).computer, 'this', 'an answer under a minute after them does not show them');
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'free', { load1: 11, at: NOW })], placed: two, now: NOW }).computer, 'box2');
  assert.equal(chooseWhere({ candidates: [here('full'), box('box2', 'free', { load1: 4 })], placed: many.map((p) => ({ ...p, at: NOW - PLACED_MS - 1 })), now: NOW }).computer, 'box2');
  // this computer's own burst counts too: a free computer filled by ten starts here is full
  const burst = Array.from({ length: 12 }, () => ({ name: 'this', at: NOW }));
  assert.equal(chooseWhere({ candidates: [here('free', { load1: 2 }), box('box2', 'free')], placed: burst, now: NOW }).computer, 'box2');
});

test('this computer lacks the project and no other can take it: nowhere, never brought there', () => {
  const r = chooseWhere({ candidates: [here('free', { lacks: 'the project is not there' }), box('box2', 'free', { lacks: 'the project is not there' })], now: NOW });
  assert.equal(r.computer, null);
  assert.match(r.why, /^this computer cannot take it \(the project is not there\), and Box 2 cannot take it: the project is not there$/);
});

test('the time where takes, measured: 10 000 choices among three computers', () => {
  const candidates = [here('full'), box('box2', 'free'), box('box3', 'busy')];
  const placed = [{ name: 'box2', at: NOW }];
  const t0 = performance.now();
  for (let i = 0; i < 10_000; i++) chooseWhere({ candidates, placed, now: NOW });
  const per = (performance.now() - t0) / 10_000;
  console.log(`# where among three computers: ${per.toFixed(4)} ms`);
  assert.ok(per < 1);
});

test('a computer read again a second after each start still counts those starts: its 1-minute load has not risen yet', () => {
  const placed = [];
  const where = [];
  for (let i = 0; i < 10; i++) {
    const t = NOW + i * 1000;
    // this computer is read at every start (rooms.mjs forStart): its answer is always this moment's
    const candidates = [here('busy', { load1: 11.5, at: t }), box('box2', 'free', { load1: 0, at: t })];
    const r = chooseWhere({ candidates, placed, now: t });
    where.push(r.computer);
    placed.push({ name: r.computer, at: t });
  }
  // this computer at 1.44 per processor takes one more, then box2 (three at most), then here again as without it
  assert.deepEqual(where.slice(0, 4), ['this', 'box2', 'box2', 'box2'], where.join(','));
  // an answer a minute after a start shows it: the start no longer counts on top
  const later = chooseWhere({ candidates: [here('busy', { load1: 11.5, at: NOW + SHOWN_MS }), box('box2', 'free')], placed: [{ name: 'this', at: NOW }], now: NOW + SHOWN_MS });
  assert.equal(later.computer, 'this');
  assert.equal(whereMod.SHOWN_MS, SHOWN_MS);
});

test('a computer that claims 1024 processors at load 0 takes three starts in five minutes, never all of them', () => {
  const candidates = [here('full'), box('box2', 'free', { cpus: 1024, load1: 0 }), box('box3', 'free', { cpus: 8, load1: 1 })];
  const placed = [];
  const where = [];
  for (let i = 0; i < 30; i++) {
    const r = chooseWhere({ candidates, placed, now: NOW + i * 1000 });
    where.push(r.computer);
    placed.push({ name: r.computer, at: NOW + i * 1000 });
  }
  const n = (x) => where.filter((w) => w === x).length;
  assert.equal(n('box2'), 3, where.join(','));
  assert.equal(n('box3'), 3, where.join(','));
  assert.equal(n('this'), 24, 'the rest stays here, as without another computer');
  const last = chooseWhere({ candidates: candidates.slice(0, 2), placed, now: NOW + 30_000 });
  assert.deepEqual(last, { computer: 'this', why: 'this computer is full, but Box 2 got 3 new starts in the last 5 minutes' });
  // five minutes later it may take more again
  assert.equal(chooseWhere({ candidates, placed, now: NOW + 30_000 + 5 * 60_000 }).computer, 'box2');
});

test('the hold: the held computer first, this computer keeps its real room in the why', () => {
  assert.deepEqual(chooseWhere({ candidates: [here('free', { held: true }), box('box2', 'free')], now: NOW }), { computer: 'box2', why: 'new work is held off this computer until it is calm and Box 2 has room' });
  assert.deepEqual(chooseWhere({ candidates: [here('free', { held: true }), box('box2', 'full')], now: NOW }), { computer: 'this', why: 'new work is held off this computer until it is calm, but Box 2 is full, so it starts here' });
});
