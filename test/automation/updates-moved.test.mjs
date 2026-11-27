// An older page (or another caller) that sends an update setting the automations no longer hold is refused with the
// sentence that names Settings → Version and updates and the code of that place (web/errorways.js), so the page draws its button.
// Through the route POST /api/automation/settings of the automations feature, with the stand-ins of helpers.mjs.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { automationFeature } from '../../src/automation/feature.mjs';
import { fakeCtx, fakeDeck, tmpDir } from './helpers.mjs';

const { WAYS } = await import('../../web/errorways.js');
const req = (body) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });

test('an update setting sent to the automations: a 400 that names Settings → Version and updates, with the code updates-moved', async () => {
  const t = tmpDir('updmoved');
  try {
    const f = fakeCtx({ deck: fakeDeck(), stateDir: t.dir, now: () => 1000 });
    const feature = automationFeature(null, { ctx: f.ctx, tick: false });
    feature.start();
    const route = feature.routes.find(([m, re]) => m === 'POST' && re.test('/api/automation/settings'));
    await assert.rejects(route[2](req({ updates: { mode: 'auto' } }), null, new URLSearchParams()), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.message, 'updates are set in Settings → Version and updates');
      assert.equal(e.details && e.details.code, 'updates-moved');
      return true;
    });
    assert.equal(WAYS['updates-moved'].href, '#/settings/updates');
    await feature.close();
  } finally {
    t.cleanup();
  }
});
