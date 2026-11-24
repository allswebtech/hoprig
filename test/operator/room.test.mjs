import assert from 'node:assert/strict';
import test from 'node:test';
import { DISK_PCT, LOAD_PER_CPU, MEM_FREE_PCT } from '../../src/operator/detect/machine.mjs';
import { MAX_AGE_MS, ROOM_ROWS, readingOfHealth, readingOfMachine, roomOf } from '../../src/operator/room.mjs';
import { pickHealth } from '../../src/machines/health.mjs';

const GiB = 1024 ** 3;
const NOW = Date.parse('2026-03-02T10:00:00Z');
// A made-up computer: 8 processors, 32 GB, a quiet disk.
const calm = { cpus: 8, load1: 1.2, memTotal: 32 * GiB, memAvailable: 20 * GiB, disk: { mount: '/', usedPct: 40 } };
const at = NOW - 30_000;

test('the thresholds are one frozen table, each row with its reason, and "full" uses the detector\'s own lines', () => {
  assert.ok(Object.isFrozen(ROOM_ROWS));
  for (const r of ROOM_ROWS) {
    assert.ok(Object.isFrozen(r));
    assert.ok(['full', 'busy'].includes(r.room));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 10, r.measure);
  }
  const full = (m) => ROOM_ROWS.find((r) => r.room === 'full' && r.measure === m).at;
  assert.equal(full('loadPerCpu'), LOAD_PER_CPU);
  assert.equal(full('memFreePct'), MEM_FREE_PCT);
  assert.equal(ROOM_ROWS.find((r) => r.room === 'busy' && r.measure === 'diskPct').at, DISK_PCT);
});

test('calm: free, with the load against its processors and the memory among the facts', () => {
  const r = roomOf({ reading: calm, at, now: NOW, own: { working: 1 } });
  assert.equal(r.room, 'free');
  assert.equal(r.why, 'it has room for new work');
  assert.equal(r.facts[0], 'load 1.2 on 8 CPUs (0.15 per CPU)');
  assert.equal(r.facts[1], '20.0 GB of 32.0 GB memory available (63 %)');
  assert.ok(r.facts.includes('1 session working'));
  assert.ok(r.facts.length <= 5);
});

test('a build running: busy, and the why names the load per processor', () => {
  const r = roomOf({ reading: { ...calm, load1: 7.2 }, at, now: NOW });
  assert.equal(r.room, 'busy');
  assert.equal(r.why, 'It is busy: its load is 0.9 per CPU.');
});

test('the load is relative to the computer: 6 is calm on 16 processors and full on 4', () => {
  assert.equal(roomOf({ reading: { ...calm, cpus: 16, load1: 6 }, at, now: NOW }).room, 'free');
  assert.equal(roomOf({ reading: { ...calm, cpus: 4, load1: 6.4 }, at, now: NOW }).room, 'full');
  // exactly 1.5 per processor is not above the detector's line: busy, as the detector raises nothing
  assert.equal(roomOf({ reading: { ...calm, cpus: 4, load1: 6 }, at, now: NOW }).room, 'busy');
});

test('load far above the processors with no memory left: full', () => {
  const r = roomOf({ reading: { ...calm, cpus: 10, load1: 100, memAvailable: 0.2 * GiB }, at, now: NOW });
  assert.equal(r.room, 'full');
  assert.match(r.why, /^It is full: its load is 10\.0 per CPU\.$/);
  assert.ok(r.facts.some((f) => f.startsWith('0.2 GB of 32.0 GB')));
});

test('memory gone while the load is low: full', () => {
  const r = roomOf({ reading: { ...calm, load1: 0.4, memAvailable: 2 * GiB }, at, now: NOW });
  assert.equal(r.room, 'full');
  assert.equal(r.why, 'It is full: only 6 % of its memory is free.');
  assert.equal(roomOf({ reading: { ...calm, memAvailable: 6 * GiB }, at, now: NOW }).room, 'busy'); // 19 %
});

test('the disk nearly full: busy at the warning line, full at 95 %', () => {
  assert.equal(roomOf({ reading: { ...calm, disk: { mount: '/', usedPct: 88 } }, at, now: NOW }).room, 'busy');
  const r = roomOf({ reading: { ...calm, disk: { mount: '/home', usedPct: 97 } }, at, now: NOW });
  assert.equal(r.room, 'full');
  assert.equal(r.why, 'It is full: its disk is 97 % full.');
  assert.ok(r.facts.includes('disk /home 97 % full'));
});

test('a hold in place: full while it stands, its line among the five facts; an ended hold counts for nothing', () => {
  const own = { working: 0, runs: { running: 0, atOnce: 4 }, hold: { until: NOW + 20 * 60_000 } };
  const r = roomOf({ reading: calm, at, now: NOW, own });
  assert.equal(r.room, 'full');
  assert.equal(r.why, 'It is full: a "Start nothing new" hold is in place.');
  assert.match(r.facts[0], /^"Start nothing new" until 10:20 UTC$/);
  assert.ok(r.facts.length <= 5);
  assert.equal(roomOf({ reading: calm, at, now: NOW, own: { ...own, hold: { until: NOW - 1 } } }).room, 'free');
});

test('Work at its limit there: busy', () => {
  const r = roomOf({ reading: calm, at, now: NOW, own: { runs: { running: 4, atOnce: 4 } } });
  assert.equal(r.room, 'busy');
  assert.equal(r.why, 'It is busy: Work runs as many runs as it may there.');
  assert.ok(r.facts.includes('Work: 4 of 4 runs by themselves'));
});

test('an old answer is unknown, never the old word', () => {
  const r = roomOf({ reading: calm, at: NOW - MAX_AGE_MS - 60_000, now: NOW });
  assert.equal(r.room, 'unknown');
  assert.equal(r.why, 'its last answer is 7 minutes old');
  assert.deepEqual(r.facts, []);
  assert.equal(roomOf({ reading: calm, at: NOW - MAX_AGE_MS, now: NOW }).room, 'free');
  // a receipt time far in the future is a fault of the record, never fresh
  assert.equal(roomOf({ reading: calm, at: NOW + 3600_000, now: NOW }).room, 'unknown');
  assert.equal(roomOf({ reading: calm, at: null, now: NOW }).room, 'unknown');
  assert.equal(roomOf({ reading: null, at, now: NOW }).why, 'it was not reached');
});

test('numbers that cannot be true: unknown, "its answer could not be read", never free', () => {
  const bad = [
    { cpus: 0 }, { cpus: 2000 }, { cpus: 2.5 }, { cpus: '8' }, { cpus: null },
    { load1: -1 }, { load1: 5000 }, { load1: NaN }, { load1: Infinity }, { load1: '1.2' }, { load1: null },
    { memTotal: 0 }, { memTotal: -1 }, { memAvailable: -1 }, { memAvailable: 64 * GiB }, { memAvailable: 'lots' },
    { disk: { mount: '/', usedPct: 140 } }, { disk: { mount: '/', usedPct: -3 } }, { disk: { mount: '/', usedPct: 'x' } },
  ];
  for (const b of bad) {
    const r = roomOf({ reading: { ...calm, ...b }, at, now: NOW });
    assert.equal(r.room, 'unknown', JSON.stringify(b));
    assert.equal(r.why, 'its answer could not be read');
  }
  // no disk named at all is still readable
  assert.equal(roomOf({ reading: { ...calm, disk: null }, at, now: NOW }).room, 'free');
});

test('the reading of a Health answer takes the disk the workspace is on, else the fullest real disk', () => {
  const h = { load: [3, 2, 1], cpus: 4, memory: { total: 8 * GiB, available: 4 * GiB }, disks: [
    { mount: '/', size: 100 * GiB, used: 50 * GiB }, { mount: '/srv', size: 200 * GiB, used: 180 * GiB }, { mount: '/boot', size: 0.5 * GiB, used: 0.49 * GiB },
  ] };
  assert.deepEqual(readingOfHealth(h, '/home/alex/Workspace').disk, { mount: '/', usedPct: 50 });
  assert.deepEqual(readingOfHealth(h, '/srv/ws').disk, { mount: '/srv', usedPct: 90 });
  assert.deepEqual(readingOfHealth(h).disk, { mount: '/srv', usedPct: 90 });
  assert.equal(readingOfHealth(h).load1, 3);
  assert.equal(readingOfHealth(null), null);
  // pickHealth's nulls for missing numbers stay null, and the room is then unknown
  assert.equal(roomOf({ reading: readingOfHealth({ load: null, cpus: null, memory: null, disks: [] }), at, now: NOW }).room, 'unknown');
});

test('the reading of this computer\'s own board source', () => {
  const m = { cpus: 4, load1: 1, memTotal: 8 * GiB, memAvailable: 4 * GiB, disks: [{ mount: '/', usedPct: 30 }, { mount: '/data', usedPct: 70 }], tmp: { usedPct: 5 } };
  assert.deepEqual(readingOfMachine(m).disk, { mount: '/data', usedPct: 70 });
  assert.deepEqual(readingOfMachine(m, '/').disk, { mount: '/', usedPct: 30 });
  assert.equal(roomOf({ reading: readingOfMachine(m), at, now: NOW }).room, 'free');
});

test('an answer with nulls, empty strings, booleans, lists or text for its numbers could not be read: never free, never full', () => {
  const good = { hoprig: 'health', load: [1, 1, 1], cpus: 8, memory: { total: 16 * GiB, available: 8 * GiB }, disks: [{ mount: '/', size: 100 * GiB, used: 40 * GiB, avail: 60 * GiB }] };
  assert.equal(roomOf({ reading: readingOfHealth(pickHealth(good)), at, now: NOW }).room, 'free', 'the honest answer has room');
  const hostile = {
    'load of nulls': { load: [null, null, null] },
    'load of empty strings': { load: ['', '', ''] },
    'load of false': { load: [false] },
    'load of an empty list': { load: [[]] },
    'load of a blank': { load: [' '] },
    'load as text': { load: ['1.2', '1', '1'] },
    'processors as text': { cpus: '64' },
    'processors as a list': { cpus: [8] },
    'processors as true': { cpus: true },
    'memory as text': { memory: { total: String(16 * GiB), available: String(8 * GiB) } },
    'memory available null': { memory: { total: 16 * GiB, available: null } },
    'memory total false': { memory: { total: false, available: 0 } },
    'a disk used empty': { disks: [{ mount: '/', size: 100 * GiB, used: '', avail: 0 }] },
    'a disk used missing': { disks: [{ mount: '/', size: 100 * GiB }] },
    'a disk size as text': { disks: [{ mount: '/', size: '100', used: 0 }, { mount: '/srv', size: 50 * GiB, used: '' }] },
  };
  for (const [name, bad] of Object.entries(hostile)) {
    const r = roomOf({ reading: readingOfHealth(pickHealth({ ...good, ...bad })), at, now: NOW });
    assert.equal(r.room, 'unknown', name);
    assert.equal(r.why, 'its answer could not be read', name);
  }
});

test('another computer\'s room is read from the disk its workspace is on (own.mount), not from its fullest disk', () => {
  const h = { load: [1, 1, 1], cpus: 8, memory: { total: 16 * GiB, available: 8 * GiB }, disks: [
    { mount: '/', size: 100 * GiB, used: 10 * GiB }, { mount: '/mnt/backup', size: 2000 * GiB, used: 1950 * GiB },
  ] };
  assert.equal(roomOf({ reading: readingOfHealth(pickHealth({ ...h, own: { mount: '/' } })), at, now: NOW }).room, 'free');
  assert.deepEqual(readingOfHealth(pickHealth({ ...h, own: { mount: '/' } })).disk, { mount: '/', usedPct: 10 });
  // its workspace on the full disk: full, as it should be
  assert.equal(roomOf({ reading: readingOfHealth(pickHealth({ ...h, own: { mount: '/mnt/backup' } })), at, now: NOW }).room, 'full');
  // an older computer that names no mount: the fullest disk, so a full disk is never missed
  assert.equal(roomOf({ reading: readingOfHealth(pickHealth(h)), at, now: NOW }).room, 'full');
});
