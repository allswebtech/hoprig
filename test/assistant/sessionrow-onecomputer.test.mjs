// Her list of sessions asks for the computers' labels only where the list spans more than one computer: the list of
// computers also looks up this computer's coding tool, and a plain list of sessions on one computer needs no label.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byName } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

async function asked(sessions) {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true };
  s.sessions = sessions;
  const ops = new FakeOps(s);
  let n = 0;
  const real = ops.computers.bind(ops);
  ops.computers = async (...a) => (n++, real(...a));
  const now = Date.now;
  await byName.get('list_sessions').run(ops, {}, { now, jobs: { forSession: () => null, list: () => [] }, tia: async () => s.assistant });
  return n;
}

test('sessions on one computer: the list of computers is not asked', async () => {
  assert.equal(await asked([{ computer: 'this', name: 'shop', kind: 'claude', status: 'working', cwd: '/home/owner/projects/shop', title: '' }]), 0);
});

test('sessions on two computers: it is asked once, for their labels', async () => {
  assert.equal(await asked([
    { computer: 'this', name: 'shop', kind: 'claude', status: 'working', cwd: '/home/owner/projects/shop', title: '' },
    { computer: 'box2', name: 'blog', kind: 'claude', status: 'waiting', cwd: '/home/owner/projects/blog', title: 'Fix the menu' },
  ]), 1);
});
