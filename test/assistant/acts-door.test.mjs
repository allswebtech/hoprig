// Her door is derived from the acts file, and it is the door she had before it was derived: for every route of the server
// (the sample paths of each, four variants of each, 30 bodies, 12 cards or none) it lets through exactly what it let through
// at the base, taken once into test/assistant/fixtures/door-base.json by make-door-base.mjs; the owner's own routes keep
// their class, and the ones the base let by without a name only get stricter. Nothing is opened by the derivation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { BODIES, CARDS, catalogCards, probe, variantsOf } from './fixtures/door-probe.mjs';

const BASE = JSON.parse(fs.readFileSync(new URL('./fixtures/door-base.json', import.meta.url), 'utf8'));
const box = sandbox('actsdoor');
test.after(() => box.cleanup());

const A = await import('../../src/assistant/acts.mjs');
const D = await import('../../src/assistant/door.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const samples = (r) => {
  try {
    return A.samplesOf(r.re);
  } catch {
    return [r.key.replace(/^[A-Z]+ /, '')];
  }
};

test('the door lets through exactly what the door before it let through, route by route and body by body', async (t) => {
  const app = createServer({ watch: false });
  try {
    const routes = [...A.changingRoutes(app), ...A.readRoutes(app)].map((r) => ({ method: r.method, paths: samples(r) }));
    const now = probe({ checkRoute: D.checkRoute, neverClassOf: D.neverClassOf, ALLOW: D.ALLOW }, routes, await catalogCards());
    const asked = routes.reduce((n, r) => n + r.paths.length, 0) * variantsOf('/x').length;
    t.diagnostic(`${routes.length} routes, ${asked} addresses, ${BODIES.length} bodies, ${CARDS.length} cards: ${BASE.passes.length} answers yes at the base`);
    console.log(`DOOR SAME ${routes.length} routes, ${asked} addresses x ${BODIES.length} bodies x ${CARDS.length + 1} cards (none, or one confirmed); ${BASE.passes.length} answers yes at the base`);
    const key = (x) => `${x[0]} ${x[1]} card${x[2]} ${x[3]}`;
    const was = new Set(BASE.passes.map(key));
    const is = new Set(now.passes.map(key));
    assert.deepEqual([...is].filter((x) => !was.has(x)), [], 'the door lets something through that it did not let through at the base');
    assert.deepEqual([...was].filter((x) => !is.has(x)), [], 'the door refuses something that it let through at the base');
    // The class of the owner's own routes: the same, or a class where the base had none (stricter).
    const classOf = new Map(now.classes);
    // "owner" is a path the owner presses and no tool of hers has: the other computer's gate lets it by like a path with no class,
    // so a class now is only stricter. A real class stays the very same.
    const lost = BASE.classes.filter(([p, cls]) => cls !== 'owner' && D.neverClassOf(p) !== cls).map(([p, cls]) => `${p} was ${cls}, now ${D.neverClassOf(p)}`);
    // Only an address that no route of the server answers: a never route with a word more (the base's patterns ended in a tail).
    // The door refuses them all the same (not in its list); a route that has a tail of its own (drop/check) keeps its row.
    const extensions = lost.filter((x) => /\/(x|public-link) was /.test(x));
    assert.deepEqual(lost.filter((x) => !extensions.includes(x)), [], 'an address of the owner\'s own lost its class');
    t.diagnostic(`${extensions.length} extensions of never routes (a word more) have no class now: ${extensions.join('; ')}`);
    assert.ok(extensions.length <= 10, String(extensions.length));
    const stricter = now.classes.filter(([p]) => !BASE.classes.some(([q]) => q === p)).length;
    t.diagnostic(`${BASE.classes.length} paths keep their class, ${stricter} more are named now`);
    assert.ok(classOf.size >= BASE.classes.length);
  } finally {
    await app.close();
  }
});

test('the derived door holds to the rows: no never row passes, every entry has a row with a tool, every row with a tool has an entry', () => {
  assert.deepEqual(D.WIRE_PROBLEMS, []);
  const rows = A.loadActs().rows;
  const byClass = rows.filter((r) => r.kind === 'route' && r.facts.never !== 'none');
  assert.ok(byClass.length > 200, String(byClass.length));
  for (const r of byClass) {
    const sample = r.source.replace(/^[A-Z]+ /, '').replace(/<id>/g, 'x').replace(/\(([a-z-]+)\|.*?\)/g, '$1');
    assert.equal(D.neverClassOf(sample, r.source.split(' ')[0]), r.facts.never, `${r.source}: the class of its address`);
    assert.ok(!D.ALLOW.some((e) => e.method === r.source.split(' ')[0] && e.re.test(sample)), `${r.source}: a never row is in ALLOW`);
  }
  assert.deepEqual(Object.keys(D.NEVER_ROUTES), Object.keys(A.NEVER_CLASSES));
  assert.equal(D.ALLOW.length, 124);
});

test('the other computer\'s gate looks at the address alone: no route she reaches sits on an address that is the owner\'s for another method', async () => {
  const app = createServer({ watch: false });
  try {
    for (const r of [...A.changingRoutes(app), ...A.readRoutes(app)]) {
      for (const p of samples(r)) {
        if (!D.ALLOW.some((e) => e.method === r.method && e.re.test(p))) continue;
        assert.ok(![...Object.values(D.NEVER_ROUTES).flat()].some((re) => re.test(p)), `${r.key}: she reaches it, and its address is the owner's for another method`);
      }
    }
  } finally {
    await app.close();
  }
});

test('deriving the door from changed rows changes the door: a tool taken off closes a route, a class closes it by name, a tool put on needs a wire', () => {
  const rows = A.loadActs().rows;
  const pass = (door, method, p) => door.ALLOW.some((e) => e.method === method && e.re.test(p));
  const plain = D.deriveDoor(rows);
  assert.ok(pass(plain, 'POST', '/api/sessions/s1/kill'));
  const noTool = D.deriveDoor(rows.map((r) => (r.source === 'POST /api/sessions/<id>/kill' ? { ...r, tool: undefined } : r)));
  assert.ok(!pass(noTool, 'POST', '/api/sessions/s1/kill'));
  assert.deepEqual(noTool.problems, ['POST /api/sessions/<id>/kill: a wire for a route that is no row of hers']);
  const open = D.deriveDoor(rows.map((r) => (r.source === 'POST /api/sessions/<id>/kill' ? { ...r, facts: { ...r.facts, never: 'delete-work' } } : r)));
  assert.ok(!pass(open, 'POST', '/api/sessions/s1/kill'));
  assert.ok(open.NEVER_ROUTES['delete-work'].some((re) => re.test('/api/sessions/s1/kill')));
  const added = D.deriveDoor(rows.map((r) => (r.source === 'POST /api/ship/p/<id>/live' ? { ...r, tool: { name: 'manage_computer' } } : r)));
  assert.deepEqual(added.problems, ['POST /api/ship/p/<id>/live: a tool reaches it but no wire says how the door checks it']);
  const weaker = D.deriveDoor(rows.map((r) => (r.source === 'POST /api/settings/password' ? { ...r, tool: { name: 'manage_computer' }, facts: { ...r.facts, never: 'none' } } : r)));
  assert.match(weaker.problems.join('\n'), /POST \/api\/settings\/password: a tool reaches it but no wire says how the door checks it/);
  assert.ok(!pass(weaker, 'POST', '/api/settings/password'), 'with no wire it is not opened');
});

test('her screens are the screens of the rows: every row names one, and the list is the acts file\'s', async () => {
  const { SCREENS } = await import('../../src/assistant/screens.mjs');
  const doc = A.loadActs();
  assert.deepEqual(SCREENS, doc.screens);
  for (const r of doc.rows.filter((x) => x.kind !== 'not-an-act')) assert.ok(SCREENS.includes(r.screen), r.source);
});
