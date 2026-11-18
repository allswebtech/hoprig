// Idle care's "stop an unused gateway" with the real add-on list (src/automation/index.mjs realAddons): the list holds
// add-ons that are not gateways (the public link, with no profile), and a tick must still run every rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeCtx, fakeDeck, tmpDir } from './helpers.mjs';

const box = sandbox('idle-addons');
const dir = tmpDir('idle-addons');
test.after(() => {
  box.cleanup();
  dir.cleanup();
});
const { createAutomation } = await import('../../src/automation/index.mjs');
const { allAddons } = await import('../../src/addons/index.mjs');

test('with idle care for gateways on, a tick over the real add-ons runs and counts each gateway', async () => {
  const f = fakeCtx({ deck: fakeDeck([]), automation: { idle: { gateway: true } }, stateDir: dir.dir, now: () => 1000, addons: undefined });
  const a = createAutomation(f.ctx);
  try {
    const r = await a.tick();
    assert.equal(r.error, undefined, `the tick failed: ${r.error}`);
    assert.deepEqual(f.lines.filter((l) => /profile/.test(l)), [], 'no add-on without a profile broke it');
    assert.ok('idle' in r.plan, 'idle care decided');
    const kept = JSON.parse(fs.readFileSync(path.join(dir.dir, 'automation', 'idle.json'), 'utf8'));
    assert.deepEqual(Object.keys(kept.gateways), allAddons().filter((x) => x.gateway).map((x) => x.id), 'each gateway, and nothing else, is counted');
  } finally {
    await a.close?.();
  }
});
