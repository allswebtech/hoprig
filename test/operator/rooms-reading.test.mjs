// The rooms feature can be handed this computer's reading (the demo hands in its made-up computer's), so a page of the
// demo never shows the real computer's load, processors or memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { roomsFeature } from '../../src/operator/rooms.mjs';

const GiB = 1024 ** 3;

test("this computer's room is read from the snapshot handed in, never the real computer's", async () => {
  let read = 0;
  // Figures no real computer of the suite shows together: 13 processors, a load of 0.37, 3 of 13 GiB free.
  const snapshot = async () => { read++; return { load: [0.37, 0.3, 0.2], cpus: 13, mem: { total: 13 * GiB, available: 3 * GiB }, disks: [{ mount: '/', size: 100 * GiB, used: 40 * GiB, avail: 60 * GiB }] }; };
  const ctx = { HttpError: Error, config: () => ({}), state: async () => ({ sessions: [] }), caller: (req) => req.who, readJson: async () => ({}), saveConfig: () => {} };
  const f = roomsFeature(ctx, { snapshot, ask: () => ({ reached: false }), workspace: () => '/' });
  const [, , route] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/operator/rooms'));
  const v = await route({ url: '/api/operator/rooms?look=1', who: 'page' });
  const here = v.computers.find((c) => c.here);
  assert.ok(here, JSON.stringify(v));
  assert.equal(read, 1, 'the snapshot handed in was read');
  assert.equal(here.reached, true);
  assert.equal(here.cpus, 13);
  assert.equal(here.load1, 0.37);
  assert.equal(here.memFreePct, Math.round((3 / 13) * 100));
  f.close?.();
});
