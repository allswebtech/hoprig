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

// The routes that pass ONLY as the act of a card the owner confirmed, through do_act (the catalog of the acts file): each is asked
// with the card for exactly its act and the arguments made from its address, and refused without it. Listed on purpose, by group.
const CARD_LET = [
  'POST /api/adopt/apply',
  'POST /api/adopt/home',
  'POST /api/adopt/plan',
  'POST /api/adopt/scan',
  'POST /api/chats/<id>/pr/merge',
  'POST /api/code/create',
  'POST /api/code/file',
  'POST /api/code/git/commit',
  'POST /api/code/git/stage',
  'POST /api/code/git/unstage',
  'POST /api/code/rename',
  'POST /api/field/report/<id>/(send|dont-send)',
  'POST /api/field/settings',
  'POST /api/folders/extras/accept',
  'POST /api/health/line',
  'POST /api/health/restart',
  'POST /api/machines/<id>/move',
  'POST /api/move',
  'POST /api/notify/test',
  'POST /api/onboarding/first-chat',
  'POST /api/onboarding/install-claude',
  'POST /api/parts/<id>/answer',
  'POST /api/pcsetup/clone',
  'POST /api/pcsetup/project/command/start',
  'POST /api/pcsetup/project/needs',
  'POST /api/pcsetup/project/start',
  'POST /api/pcsetup/recipe',
  'POST /api/pcsetup/tool',
  'POST /api/providers/<id>/check',
  'POST /api/providers/<id>/map',
  'POST /api/providers/<id>/mend',
  'POST /api/services/action',
  'POST /api/ship/limiter',
  'POST /api/ship/p/<id>/allow',
  'POST /api/ship/p/<id>/auto',
  'POST /api/ship/p/<id>/back',
  'POST /api/ship/p/<id>/check',
  'POST /api/ship/p/<id>/drop',
  'POST /api/ship/p/<id>/goon',
  'POST /api/ship/p/<id>/handoff',
  'POST /api/ship/p/<id>/live',
  'POST /api/ship/p/<id>/together',
  'POST /api/skillhub/tools/<id>/update',
  'POST /api/skills/learned/look',
  'POST /api/system/processes/end',
  'POST /api/work/proposals/<id>/accept',
  'POST /api/work/proposals/<id>/clean',
  'POST /api/work/proposals/<id>/dismiss',
  'POST /api/work/propose',
  'POST /api/work/save',
  'POST /api/work/save/drop',
  'POST /api/work/settings',
  'POST /api/workspace/find/add',
  'POST /api/workspace/find/get',
  'POST /api/workspace/find/undo',
  'POST /api/workspace/instep/look',
  'POST /api/workspace/label',
  'POST /api/workspace/leave/mark',
  'POST /api/workspace/link',
  'POST /api/workspace/map/case',
  'POST /api/workspace/map/commit',
  'POST /api/workspace/map/upgrade',
  'POST /api/workspace/mylink',
  'POST /api/workspace/onlyhere/push',
  'POST /api/workspace/tools/allow',
  'POST /api/workspace/tools/remove',
];

test('the routes that pass only on a confirmed do_act card are exactly the listed ones, and none passes without the card', async () => {
  const { catalogCards } = await import('./fixtures/door-probe.mjs');
  const { runConfirmed } = await import('../../src/assistant/confirmed.mjs');
  const { rowById } = await import('../../src/assistant/catalog.mjs');
  const cardsFor = await catalogCards();
  const app = createServer({ watch: false });
  try {
    const through = [];
    const groups = {};
    for (const r of A.changingRoutes(app)) {
      for (const p of A.samplesOf(r.re)) {
        const cards = cardsFor(r.method, p);
        const ok = cards.find((c) => {
          try {
            runConfirmed(c, () => checkRoute(r.method, p, {}, ctxWith(false)));
            return true;
          } catch {
            return false;
          }
        });
        if (!ok) continue;
        assert.equal(lets(r.method, p, false) && !LET.includes(r.key), false, `${r.key} passes without a card`);
        if (!through.includes(r.key)) {
          through.push(r.key);
          const area = rowById(ok.input.act).area;
          (groups[area] ||= []).push(r.key);
        }
      }
    }
    console.log(`CARD ROUTES ${through.length} route(s) pass only as the act of a confirmed do_act card; by group: ${Object.entries(groups).map(([g, l]) => `${g} ${l.length}`).join(', ')}`);
    console.log(`CARD LIST ${JSON.stringify(through.sort())}`);
    assert.deepEqual(through.sort(), [...CARD_LET].sort(), 'a route that opens only on a card was added or lost: weigh it, then change the list');
    assert.ok(!through.some((k) => /gatewayhost|\/keys|password|login|pair|onboarding\/run/.test(k)), 'a never route passed');
  } finally {
    await app.close();
  }
});
