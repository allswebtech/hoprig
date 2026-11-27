// The census of her door, in small: every route of the server that changes something (the server's tables, the
// machines' table, the routes a feature answers itself) is asked of her door with an empty body and with only a
// confirmation, and the routes it lets through are compared with ONE list below. A route that opens by a later change
// fails here, and the person who opens it must weigh it and add it to the list on purpose. A gateway's start, stop and
// restart are never in it: they are the owner's tap, run in the server, not a route of her door. A route that passes only
// as the act of a card he confirmed (a Fix, an add-on install, the restart of Hoprig) is asked here without one: refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('doorcensus');
test.after(() => box.cleanup());

const A = await import('../../src/assistant/acts.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const LET = [
  'POST /api/assistant/run',
  'POST /api/automation/queue/<id>',
  'POST /api/automation/schedules',
  'POST /api/automation/settings',
  'POST /api/chats/<id>/answer',
  'POST /api/chats/<id>/close',
  'POST /api/chats/<id>/fork',
  'POST /api/chats/<id>/stop',
  'POST /api/chats/<id>/terminal',
  'POST /api/claude/update',
  'POST /api/field/twice/<id>/(dismiss|draft)',
  'POST /api/machine/label',
  'POST /api/machines/<id>/rename',
  'POST /api/pc/kill',
  'POST /api/pc/power',
  'POST /api/pcsetup/install',
  'POST /api/pcsetup/project/add',
  'POST /api/pcsetup/project/clone',
  'POST /api/pcsetup/project/new',
  'POST /api/pcsetup/project/sync',
  'POST /api/pcsetup/projects-dir',
  'POST /api/pcsetup/rules',
  'POST /api/pcsetup/setup',
  'POST /api/sessions',
  'POST /api/sessions/<id>/continue',
  'POST /api/sessions/<id>/key',
  'POST /api/sessions/<id>/kill',
  'POST /api/sessions/<id>/rename',
  'POST /api/sessions/<id>/send',
  'POST /api/sessions/<id>/switch',
  'POST /api/settings',
  'POST /api/skillhub/approve',
  'POST /api/skillhub/check',
  'POST /api/skillhub/remove',
  'POST /api/skillhub/review',
  'POST /api/skillhub/settings',
  'POST /api/skillhub/update-review',
  'POST /api/skills/learned/<id>/(install|discard|undo)',
  'POST /api/updates/check',
  'POST /api/work/fix-ids',
  'POST /api/work/items',
  'POST /api/work/missions',
  'POST /api/work/missions/<id>/stop',
  'POST /api/work/missions/<id>/tasks/<id>/run-tests',
  'POST /api/work/plans',
  'POST /api/work/plans/<id>',
  'POST /api/workspace/drop/check',
  'POST /api/workspace/forget',
  'POST /api/workspace/map',
  'POST /api/workspace/restore',
  'POST /api/workspace/settings',
  'POST /api/workspace/setup',
  'POST /api/workspace/sync',
];

const ctxWith = (actAlone) => ({ config: () => ({ server: { roots: ['/x'] }, sessionDefaults: { permissionMode: 'default' }, assistant: { enabled: true, level: 'work', actAlone } }), poke() {} });
const lets = (method, p, actAlone) => [{}, { confirm: 'box2' }].some((body) => {
  try {
    checkRoute(method, p, body, ctxWith(actAlone));
    return true;
  } catch {
    return false;
  }
});

test('the routes her door lets through are exactly the listed ones, with her switch off or on', async () => {
  const app = createServer({ watch: false });
  try {
    const routes = A.changingRoutes(app);
    assert.ok(routes.length > 150, String(routes.length));
    const through = { off: [], on: [] };
    for (const r of routes) {
      for (const [k, alone] of [['off', false], ['on', true]]) if (A.samplesOf(r.re).some((p) => lets(r.method, p, alone))) through[k].push(r.key);
    }
    assert.deepEqual(through.off.sort(), [...LET].sort(), 'a route of her door was opened or closed: weigh it, then change the list');
    assert.deepEqual(through.on.sort(), through.off.sort(), 'her switch changes nothing at the door: it acts later, in decide()');
    assert.ok(!LET.some((k) => /gatewayhost/.test(k)), 'a gateway is never restarted, started or stopped through her door');
  } finally {
    await app.close();
  }
});
