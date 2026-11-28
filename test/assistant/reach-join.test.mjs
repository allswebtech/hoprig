// What she reaches now, printed by a test of the tree: for every act of acts.json how she answers it (read, alone, card, open,
// none) and by which tool; the counts against the integration head (where only the acts a tool of hers named were reached);
// and every route her door passes now that it refused before, each with its condition (which card of his, or a look).
// The door is asked as it is: a route with no card and no look must still be refused (that is the integration head's door).
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadActs, rowAnswer } from '../../src/assistant/acts.mjs';
import { callOf, catalogRoutes, isReadRoute, placesOf, toolOf } from '../../src/assistant/catalog.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { runAsLook, runConfirmed } from '../../src/assistant/confirmed.mjs';
import { EAGER_NAMES } from '../../src/assistant/tools.mjs';

const ctx = { config: () => ({ server: { roots: ['/x'] }, sessionDefaults: { permissionMode: 'default' }, assistant: { enabled: true, level: 'work', actAlone: false } }), poke() {} };
const rows = loadActs().rows;
const acts = rows.filter((r) => r.kind !== 'not-an-act');

/** The tool that answers a row now. */
function toolFor(row) {
  const a = rowAnswer(row);
  if (a === 'read') return toolOf(row) ? toolOf(row).name : 'look';
  if (toolOf(row)) return `${toolOf(row).name} (via do_act)`;
  return 'do_act';
}

test('every act of the acts file: how she answers it now and by which tool (printed)', (t) => {
  const by = {};
  const byTool = {};
  const lines = [];
  for (const r of rows) {
    const a = r.kind === 'not-an-act' ? 'none' : rowAnswer(r);
    const tl = r.kind === 'not-an-act' ? '-' : toolFor(r);
    by[a] = (by[a] || 0) + 1;
    byTool[tl] = (byTool[tl] || 0) + 1;
    lines.push(`ACT ${r.id} ${a} ${tl}`);
  }
  console.log(lines.join('\n'));
  const base = {};
  for (const r of acts.filter((x) => x.tool)) base[rowAnswer(r)] = (base[rowAnswer(r)] || 0) + 1;
  const b = (o) => `read ${o.read || 0}, alone ${o.alone || 0}, card ${o.card || 0}, open ${o.open || 0}, none ${o.none || 0}`;
  console.log(`REACH rows ${rows.length}: ${b(by)}`);
  console.log(`REACH BASE (integration head: acts a tool of hers named, ${acts.filter((x) => x.tool).length} of ${acts.length}): ${b(base)}`);
  console.log(`REACH NOW (${acts.length} of ${acts.length} have an answer): ${b({ ...by, none: 0 })}`);
  console.log(`REACH BY TOOL ${JSON.stringify(Object.fromEntries(Object.entries(byTool).sort()))}`);
  t.diagnostic('printed');
  assert.equal(EAGER_NAMES.length, 10);
  assert.ok(Object.values(byTool).every((n) => n > 0));
});

const sample = (row) => {
  const { ids, variants } = placesOf(row);
  const args = {};
  ['target', 'target2', 'target3'].slice(0, ids).forEach((k, i) => { args[k] = `x${i + 1}`; });
  if (variants[0]) args.variant = variants[0][0];
  return args;
};

test('the routes her door passes now that it refused at the integration head, each with its condition (printed)', () => {
  const read = [];
  const card = [];
  for (const e of catalogRoutes()) {
    let call;
    try { call = callOf(e.row, sample(e.row)); } catch { continue; }
    const body = call.body ?? undefined;
    const bare = () => checkRoute(e.method, call.path, body, ctx);
    assert.throws(bare, undefined, `${e.row.source} must be refused without a look or a card`);
    if (isReadRoute(e.row)) {
      let ok = true;
      try { runAsLook(() => checkRoute(e.method, call.path, body, ctx)); } catch { ok = false; }
      if (ok) read.push(`${e.row.source} [${e.row.id}] when: inside a look, a read, no secret field kept`);
      continue;
    }
    const cards = [
      { id: 'j1', tool: 'do_act', input: { act: e.row.id, args: sample(e.row) } },
      { id: 'j2', tool: 'plan_acts', input: { steps: [{ act: e.row.id, args: sample(e.row) }, { act: e.row.id, args: sample(e.row) }] } },
    ];
    const ok = cards.map((c) => { try { runConfirmed(c, () => checkRoute(e.method, call.path, body, ctx)); return true; } catch { return false; } });
    if (ok[0]) card.push(`${e.row.source} [${e.row.id}] when: the owner taps the card of do_act for this act and these arguments${ok[1] ? ' (or the plan card that holds it as a step)' : ''}; answer ${rowAnswer(e.row)}`);
    // a card for ANOTHER act never opens this route
    const other = { id: 'j3', tool: 'do_act', input: { act: 'no.other-act', args: {} } };
    assert.throws(() => runConfirmed(other, () => checkRoute(e.method, call.path, body, ctx)), undefined, `${e.row.source} opened by another act's card`);
  }
  console.log(`NEWLY PASSING reads inside a look: ${read.length}`);
  for (const l of read) console.log(`  READ ${l}`);
  console.log(`NEWLY PASSING changes only on a confirmed card: ${card.length}`);
  for (const l of card) console.log(`  CARD ${l}`);
  assert.ok(card.length > 0);
  assert.ok(isReadRoute(catalogRoutes().find((e) => isReadRoute(e.row)).row));
});
