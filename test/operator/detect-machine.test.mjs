import assert from 'node:assert/strict';
import test from 'node:test';
import { detectMachine } from '../../src/operator/detect/machine.mjs';

const GiB = 1024 ** 3;
const calm = { cpus: 4, load1: 2.0, memTotal: 16 * GiB, memAvailable: 6 * GiB, disks: [{ mount: '/', usedPct: 61 }], tmp: { usedPct: 12 } };

test('a calm machine gives nothing', () => {
  assert.deepEqual(detectMachine({ machine: calm }), []);
});

test('the temporary folder 80 % full is still below the 85 % line; 88 % is an item', () => {
  assert.deepEqual(detectMachine({ machine: { ...calm, tmp: { usedPct: 80 } } }), []);
  const [it] = detectMachine({ machine: { ...calm, tmp: { usedPct: 88 } } });
  assert.equal(it.subject, 'the temporary folder');
  assert.deepEqual(it.facts, ['the temporary folder is 88 % full', 'tests and builds fail when it fills up']);
  assert.equal(it.class, 'machine');
});

test('load above 1.5 per CPU, memory under 10 %, a disk at 85 %', () => {
  const items = detectMachine({ machine: { ...calm, load1: 6.4, memAvailable: 1.2 * GiB, disks: [{ mount: '/', usedPct: 85 }, { mount: '/data', usedPct: 50 }] } });
  assert.deepEqual(items.map((i) => i.subject), ['load', 'memory', 'disk /']);
  assert.equal(items[0].facts[0], 'load 6.4 on 4 CPUs (1.6 per CPU)');
  assert.equal(items[1].facts[0], '1.2 GB of 16.0 GB available (8 %)');
  assert.equal(items[0].acts[0].href, '#/desktop/tasks');
});

test('exactly 1.5 per CPU is not above it; no source gives nothing', () => {
  assert.deepEqual(detectMachine({ machine: { ...calm, load1: 6 } }), []);
  assert.deepEqual(detectMachine({ machine: null }), []);
  assert.deepEqual(detectMachine({}), []);
});

test('a moving load is the same item to the owner: put off once, it stays put off while it is high', () => {
  const a = detectMachine({ machine: { ...calm, load1: 6.4 } })[0];
  const b = detectMachine({ machine: { ...calm, load1: 8.8 } })[0];
  assert.equal(a.rev, b.rev);
});
