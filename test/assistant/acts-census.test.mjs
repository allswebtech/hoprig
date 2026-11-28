// The census of the acts file (src/assistant/acts.json) against the code itself: the commands of bin/hoprig.mjs, every
// route that changes something, every route that only reads, the built-in skills. A missing row, a dead row, a never row
// with a weaker answer than the door gave it before, a read that could hold a secret that is answered read, and a row
// with no page or no press each fail here. The counts are printed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = JSON.parse(fs.readFileSync(new URL('./fixtures/door-base.json', import.meta.url), 'utf8'));
const box = sandbox('actscensus');
test.after(() => box.cleanup());

const A = await import('../../src/assistant/acts.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const app = createServer({ watch: false });
test.after(() => app.close());
const lists = { commands: A.commandsIn(fs.readFileSync(path.join(ROOT, 'bin', 'hoprig.mjs'), 'utf8')), skills: A.skillsIn(), routes: A.changingRoutes(app), reads: A.readRoutes(app) };
const SOURCES = A.codeSources(lists);
const CENSUS = { sources: SOURCES, routes: [...lists.routes, ...lists.reads] };
const doc = A.loadActs();

/** The paths whose door class (before the acts file) was a never class, and no row of that class has now. */
const weaker = (rows) => BASE.classes.filter(([, cls]) => cls in A.NEVER_CLASSES).flatMap(([p, cls]) => {
  const here = rows.filter((r) => r.kind === 'route' && A.sourcePattern(r.source).test(p));
  return here.length && !here.some((r) => r.facts.never === cls) ? [`${here.map((r) => r.source).join(', ')}: the door said ${cls} for ${p}, no row says it`] : [];
});

test('every command, route that changes or reads, and skill of the code has one row, and every row names something that exists', () => {
  assert.ok(lists.commands.includes('serve') && lists.commands.length >= 30, String(lists.commands.length));
  assert.ok(lists.routes.length >= 300 && lists.reads.length >= 150, `${lists.routes.length} changing routes, ${lists.reads.length} read routes`);
  assert.deepEqual(A.actsProblems(doc, CENSUS), []);
});

test('the counts: the rows in all, by answer, and the reads by answer', (t) => {
  const by = (rows) => rows.reduce((m, r) => ({ ...m, [A.rowAnswer(r)]: (m[A.rowAnswer(r)] || 0) + 1 }), { read: 0, alone: 0, card: 0, open: 0, none: 0 });
  const all = by(doc.rows);
  const reads = doc.rows.filter((r) => r.source.startsWith('GET ') && r.kind !== 'not-an-act');
  const readCounts = by(reads);
  const secret = reads.filter((r) => A.rowAnswer(r) === 'open');
  const why = secret.reduce((m, r) => ({ ...m, [r.facts.never]: (m[r.facts.never] || 0) + 1 }), {});
  t.diagnostic(`rows in all ${doc.rows.length}; by answer ${JSON.stringify(all)}`);
  t.diagnostic(`read routes ${reads.length}: answered read ${readCounts.read}, answered open ${readCounts.open}, by class ${JSON.stringify(why)}, holding a secret ${secret.filter((r) => r.holds_secret).length}`);
  console.log(`CENSUS rows in all ${doc.rows.length}; by answer ${JSON.stringify(all)}; read routes ${reads.length}: read ${readCounts.read}, open ${readCounts.open} ${JSON.stringify(why)}`);
  assert.equal(Object.values(all).reduce((a, b) => a + b, 0), doc.rows.length);
  assert.ok(all.read > 100 && all.open > 200 && all.card > 100 && all.alone > 30, JSON.stringify(all));
});

test('a missing row, a dead row, a row with a wrong shape each fail', () => {
  const p = (rows, src = CENSUS) => A.actsProblems({ ...doc, rows }, src).join('\n');
  assert.match(p(doc.rows.filter((r) => r.source !== 'POST /api/sessions')), /the code has an act with no row: POST \/api\/sessions/);
  assert.match(p(doc.rows.filter((r) => r.source !== 'GET /api/logs')), /the code has an act with no row: GET \/api\/logs/);
  assert.match(p(doc.rows, { sources: SOURCES.filter((s) => s !== 'POST /api/sessions'), routes: [] }), /a row that outlived its act: the code has no "POST \/api\/sessions"/);
  assert.deepEqual(doc.rows.filter((r) => r.kind === 'route' && !SOURCES.includes(r.source)).map((r) => r.source), ['POST /api/addons/public-link/(install|update|start|stop|remove|setup)', 'POST /api/addons/public-link/do/<id>', 'GET /api/addons/public-link/job'], 'the rows for an address of a route the code has under another name');
  const edit = (source, fn) => doc.rows.map((r) => (r.source === source ? fn(structuredClone(r)) : r));
  assert.match(p(edit('POST /api/sessions', (r) => ((r.id = 'chats.send'), r))), /the id is used twice/);
  assert.match(p(edit('POST /api/sessions', (r) => ((r.screen = 'nowhere'), r))), /is not a screen/);
  assert.match(p(edit('POST /api/sessions', (r) => ((r.press = 'x'.repeat(61)), r))), /the one press/);
  assert.match(p(edit('POST /api/sessions', (r) => ((r.level = 'L1'), r))), /"level" is not a field/);
  assert.match(p(edit('POST /api/sessions', (r) => (delete r.facts.seen, r))), /the fact "seen" is missing/);
  assert.match(p(edit('GET /api/logs', (r) => (delete r.pick, r))), /names what it keeps/);
  assert.match(p(edit('GET /api/logs', (r) => ((r.pick = ['data.token']), r))), /secret field/);
  assert.match(p(edit('POST /api/sessions/<id>/rename', (r) => (delete r.undo, r))), /undo is true, so name the act/);
  assert.match(p(edit('POST /api/sessions/<id>/rename', (r) => ((r.undo = 'nothing.here'), r))), /is not a row/);
  assert.match(p(edit('POST /api/settings/password', (r) => ((r.tool = { name: 'manage_computer' }), r))), /an open row has no tool/);
  assert.match(p(edit('GET /api/tokens', (r) => ((r.facts.never = 'none'), r))), /holds a secret is open, not read/);
});

test('a never row with a weaker answer than the door gave it fails, and today there is none', () => {
  assert.deepEqual(weaker(doc.rows), []);
  assert.ok(BASE.classes.length > 200);
  const rows = doc.rows.map((r) => (r.source === 'POST /api/settings/password' ? { ...r, facts: { ...r.facts, never: 'none' } } : r));
  assert.deepEqual(weaker(rows), ['POST /api/settings/password: the door said sign-in for /api/settings/password, no row says it']);
});

test('a read that could hold a key, a token, a sign-in, a password or a file of the credentials folder is never answered read', () => {
  const secret = /(^|[/])(tokens?|profiles|accounts|hersignin|login|logout|me|gatewayhost|hubprov|credentials|signin|password|keys?|forward|hostkey|access|raw|file|diff|search)(\/|$)/;
  const readRows = doc.rows.filter((r) => r.source.startsWith('GET ') && r.kind === 'route' && A.rowAnswer(r) === 'read');
  // The reads she has today (a row with a tool) stay reads; every other family of the pattern above is open.
  const bad = readRows.filter((r) => !r.tool && secret.test(r.source.replace(/^GET \/api\//, ''))).map((r) => r.source);
  assert.deepEqual(bad, []);
  for (const r of doc.rows.filter((x) => x.holds_secret)) assert.equal(A.rowAnswer(r), 'open', r.source);
  assert.ok(doc.rows.filter((x) => x.holds_secret).length >= 40);
});

test('every row that is not an act says why in one sentence, and every other row names a screen of the product and one press', () => {
  const screens = new Set(doc.screens);
  for (const r of doc.rows) {
    if (r.kind === 'not-an-act') {
      assert.ok(r.why.length >= 20 && r.why.length <= 200, r.source);
      continue;
    }
    assert.ok(screens.has(r.screen) && r.press && r.press.length <= 60, r.source);
  }
});
