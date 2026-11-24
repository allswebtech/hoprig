// The public link's helper is named in her summary as a person who is not a programmer can follow it: what it is for,
// with its program's name beside it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { codingToolsView } from '../../src/assistant/codingtools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

test('an update of cloudflared is named "the helper for the public link (cloudflared)"', async () => {
  const s = baseState();
  const row = s.updates.items.find((x) => x.id === 'cloudflared');
  Object.assign(row, { latest: '2025.2.0', updateAvailable: true, action: 'update' });
  const r = await codingToolsView(new FakeOps(s), 'this');
  assert.match(r.summary, /available \([^)]*the helper for the public link \(cloudflared\)/, r.summary);
  assert.doesNotMatch(r.summary, /tunnel helper/);
});
