// Every Operator and mission text that names a place carries that place as a code of the page's table of places
// (web/errorways.js), in the one field `ways`, beside words that stay as they were. Every code they send is in the
// table, so the page draws its link (an unknown code would draw nothing).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { ACTS, actCatalog, makeItem } = await import('../../src/operator/item.mjs');
const { PREPARED_ACTS } = await import('../../src/operator/decide-table.mjs');
const { RULES } = await import('../../src/operator/rules.mjs');
const { WAYS } = await import('../../web/errorways.js');

const known = (code) => Object.hasOwn(WAYS, code);

test('the places the texts name are in the table, each with the place its words name', () => {
  const want = {
    'operator-page': ['Operator', '#/operator'], 'decide-limits': ['Operator', '#/operator'],
    'auto-mode': ['Providers', '#/providers'], 'tia-settings': ['Settings → Tia', '#/settings/tia'],
    'work-plans': ['Plans', '#/work/plans'], 'work-team': ['Team', '#/work/team'],
  };
  for (const [code, [label, href]] of Object.entries(want)) {
    assert.ok(known(code), `${code} is in the table`);
    assert.deepEqual([WAYS[code].label, WAYS[code].href], [label, href], code);
  }
  // Every code a source of the Operator or the missions sends, found by its words in the source, is in the table.
  const files = ['item.mjs', 'decide-table.mjs', 'rules.mjs', 'reflex.mjs', 'decider.mjs'].map((f) => `../../src/operator/${f}`).concat(['../../src/mission/engine.mjs', '../../src/mission/report.mjs']);
  const sent = new Set();
  for (const f of files) {
    const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of s.matchAll(/\[((?:'[a-z][a-z-]*'(?:,\s*)?)+)\]/g)) for (const c of m[1].matchAll(/'([a-z][a-z-]*)'/g)) if (/-/.test(c[1])) sent.add(c[1]);
    // The mission report works the codes out from a why's words: ['Work → Plans', 'work-plans'] (src/mission/report.mjs PLACES).
    for (const m of s.matchAll(/\['[^'\n]+', '([a-z][a-z]*-[a-z-]*)'\]/g)) sent.add(m[1]);
  }
  for (const c of Object.keys(want)) assert.ok(sent.has(c), `${c} is sent by a source`);
});

test('End the session: its undo names the one place an ended session is continued, as the session menu and the End sheet do', async () => {
  globalThis.document ??= { createElement: () => ({}), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
  const { END_TEXT } = await import('../../web/closesheet.js');
  assert.equal(ACTS.stop.undo, 'Continue it from the project\'s page.');
  assert.match(END_TEXT, /continue it from the project's page\./);
  assert.match(fs.readFileSync(new URL('../../web/session.js', import.meta.url), 'utf8'), /can be continued later from the project\\'s page/);
  assert.doesNotMatch(ACTS.stop.undo, /Sessions page/, 'the sidebar has no Sessions page');
  // No code for a place the page has no address for: a project's page is one per project.
  assert.equal('ways' in ACTS.stop, false);
  assert.equal(known('sessions-page'), false);
  const cat = actCatalog([makeItem({ kind: 'stuck', subject: 'session alpha', cls: 'stopped', acts: ['stop'], facts: ['no progress'] })]);
  assert.equal(cat.stop.undo, 'Continue it from the project\'s page.', 'the catalog sends it once with the list');
  assert.equal('ways' in cat.dismiss, false, 'an act that names no place sends none');
});

test('Hold new starts: its undo names the Operator page by its code', () => {
  assert.equal(PREPARED_ACTS.hold.undo, 'Lift the hold in Settings → Tia.');
  assert.deepEqual(PREPARED_ACTS.hold.ways, ['operator-page']);
});

test('the limit and elsewhere rules name their places by code; their details keep every word', () => {
  const limit = RULES.find((r) => r.id === 'limit');
  assert.match(limit.detail, /Providers → Auto mode\. Only to a provider Tia may use \(Settings → Tia\)/);
  assert.deepEqual(limit.ways, ['auto-mode', 'tia-settings']);
  assert.deepEqual(RULES.find((r) => r.id === 'elsewhere').ways, ['tia-settings']);
  for (const r of RULES) for (const c of r.ways || []) assert.ok(known(c), `${r.id}: ${c}`);
});

test('every code these texts carry is in the table or on the wanted list', () => {
  for (const [id, a] of Object.entries(ACTS)) for (const c of a.ways || []) assert.ok(known(c), `${id}: ${c}`);
});

test('Settings → Tia is named by its whole name, never only "Tia" (her chat in the sidebar)', () => {
  assert.equal(WAYS['tia-settings'].label, 'Settings → Tia');
  assert.equal(WAYS['tia-cap'].label, 'Settings → Tia');
});

test('a link to the page shown now is not drawn: "Open Operator" on the Operator page would only load it again', async () => {
  globalThis.document ??= { createElement: () => ({}), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
  const { placesOf } = await import('../../web/operator-ways.js');
  assert.deepEqual(placesOf(['decide-limits', 'operator-page'], '#/operator'), []);
  assert.deepEqual(placesOf(['decide-limits'], '#/operator?x=1'), []);
  assert.deepEqual(placesOf(['decide-limits'], '#/work'), [{ label: 'Operator', href: '#/operator' }], 'elsewhere it is drawn');
  assert.deepEqual(placesOf(['tia-settings'], '#/operator'), [{ label: 'Settings → Tia', href: '#/settings/tia', button: "Open Tia's settings" }]);
  assert.deepEqual(placesOf(['decide-limits'], ''), [{ label: 'Operator', href: '#/operator' }]);
});
