// The dry answer of every row: what the act would be answered, without doing anything. For every row the answer is derived
// from its facts; for an open answer there is a page, an item on it, the one press and the sentence; and for every route the
// door agrees with the answer: an open route is refused at the door, a route no tool of hers names is refused, a route with
// a tool passes the door's route check (with the body her tool sends, or the confirmed card it needs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { BODIES, CARDS } from './fixtures/door-probe.mjs';

const box = sandbox('actsdry');
test.after(() => box.cleanup());

const A = await import('../../src/assistant/acts.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { runConfirmed } = await import('../../src/assistant/confirmed.mjs');
const { SCREENS, openAnswer, focusOf } = await import('../../src/assistant/screens.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const doc = A.loadActs();
const ctx = { config: () => ({ server: { roots: ['/x'] }, sessionDefaults: { permissionMode: 'default' }, assistant: { enabled: true, level: 'work', actAlone: true } }), settingsOf: () => ({ sessionDefaults: { permissionMode: 'default' } }), poke() {} };
// The bodies of the door's fixture, and the one a route asks of a review's id.
const BODIES_MORE = [...BODIES, { id: 'a'.repeat(24) }, { name: 'ab', project: '/x' }];
const lets = (method, p) => [null, ...CARDS].some((card) => BODIES_MORE.some((b) => {
  try {
    const f = () => checkRoute(method, p, b === null ? null : structuredClone(b), ctx);
    card ? runConfirmed(card, f) : f();
    return true;
  } catch {
    return false;
  }
}));

test('every row has its derived answer, and an open one has a page, an item, the one press and a sentence', () => {
  const screens = new Set(SCREENS);
  for (const r of doc.rows) {
    const answer = A.rowAnswer(r);
    assert.ok([...A.ANSWERS, 'none'].includes(answer), r.source);
    if (answer !== 'open') continue;
    const o = openAnswer(r);
    assert.equal(o.outcome, 'open');
    assert.ok(screens.has(o.screen), `${r.source}: ${o.screen} is a screen she can open`);
    assert.ok(o.focus && o.focus === focusOf(r) && /^[a-z0-9-]+$/.test(o.focus), `${r.source}: the item`);
    assert.ok(o.press && o.press.length <= 60 && o.say.includes(o.press) && o.say.includes(o.screen), `${r.source}: the press and the sentence`);
    assert.ok(o.link === `#/${o.screen}` || o.link.startsWith('#/m/'), r.source);
    assert.doesNotMatch(o.say, /cannot|can't|unable/i, r.source);
  }
  assert.equal(openAnswer(doc.rows.find((r) => r.source === 'POST /api/settings/password'), { computer: 'box2' }).link, '#/settings/security');
});

test('the door agrees with the answer of every route: open and no-tool routes are refused, a route with a tool passes', async () => {
  const app = createServer({ watch: false });
  try {
    const keys = new Map([...A.changingRoutes(app), ...A.readRoutes(app)].map((r) => [r.key, r]));
    let asked = 0;
    for (const r of doc.rows.filter((x) => x.kind === 'route')) {
      // A row for an address the door names by itself (the public link's add-on routes) is asked at that address.
      const route = keys.get(r.source) || (A.subRoute(r, { routes: [...keys.values()] }) ? { method: r.source.split(' ')[0], re: A.sourcePattern(r.source) } : null);
      assert.ok(route, `${r.source}: the code has it`);
      const paths = keys.has(r.source) ? (() => {
        try {
          return A.samplesOf(route.re);
        } catch {
          return [r.source.replace(/^[A-Z]+ /, '')];
        }
      })() : [r.source.replace(/^[A-Z]+ /, '').replace(/<id>/g, 'alpha').replace(/\(([a-z-]+)\|[a-z|-]*\)/g, '$1')];
      const passes = paths.some((p) => lets(route.method, p));
      asked += paths.length;
      if (r.tool && A.rowAnswer(r) !== 'open') assert.ok(passes, `${r.source}: a tool of hers names it, the door refuses it`);
      else assert.ok(!passes, `${r.source}: answer ${A.rowAnswer(r)}${r.tool ? '' : ', no tool'}: the door lets it through`);
    }
    assert.ok(asked > 400, String(asked));
  } finally {
    await app.close();
  }
});
