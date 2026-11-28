// The acts file (acts.json: every act, its facts, its page and press) and the list of her tools (inventory.json: which
// tool reaches an act, at which level, with which card) describe the same acts: every row of the inventory is a row of
// the acts file with the same facts, the same answer and the same tool, and every row the inventory does not have is a
// route that only reads.
import assert from 'node:assert/strict';
import test from 'node:test';

const { loadActs, loadInventory, rowAnswer, levelFor } = await import('../../src/assistant/acts.mjs');
const ACTS = loadActs();
const INV = loadInventory().rows;
const byActSource = new Map(ACTS.rows.map((r) => [r.source, r]));
const KIND = { route: 'route', command: 'command', skill: 'skill', act: 'step' };
// An undo of an undo is the act done again: the acts file says "remake" for it, the inventory has always said true (both are an L1 act).
const UNDO_OF_UNDO = 'act undo-act';

test('every row of the inventory is a row of the acts file, with the same facts, the same level and the same tool', () => {
  const problems = [];
  for (const i of INV) {
    const a = byActSource.get(i.act);
    if (!a) {
      problems.push(`${i.act}: no row in the acts file`);
      continue;
    }
    if (a.kind === 'not-an-act') {
      if (i.not !== 'not-an-act') problems.push(`${i.act}: a row that is not an act, the inventory says ${i.not || 'hers'}`);
      continue;
    }
    if (a.kind !== KIND[i.kind]) problems.push(`${i.act}: kind ${a.kind}, the inventory says ${i.kind}`);
    const f = i.act === UNDO_OF_UNDO ? { ...i.facts, undo: 'remake' } : i.facts;
    if (JSON.stringify(a.facts) !== JSON.stringify(f)) problems.push(`${i.act}: the facts differ: ${JSON.stringify(a.facts)} and ${JSON.stringify(i.facts)}`);
    const level = { read: 'L0', alone: 'L1', card: 'L2', open: 'N' }[rowAnswer(a)];
    if (level !== i.level || level !== levelFor(i.facts)) problems.push(`${i.act}: the answer is ${rowAnswer(a)}, the inventory says ${i.level}`);
    // The tool: the first tool of hers, for an act of hers that is not the owner's own; no tool for the rest.
    const want = i.hers && i.facts.never === 'none' ? { name: i.hers[0].tool, ...(i.hers[0].action ? { action: i.hers[0].action } : {}) } : undefined;
    if (JSON.stringify(a.tool) !== JSON.stringify(want)) problems.push(`${i.act}: the tool is ${JSON.stringify(a.tool)}, the inventory says ${JSON.stringify(want)}`);
  }
  assert.deepEqual(problems, []);
});

// Addresses of a route the code has under another name that the door names by themselves: the public link's add-on routes.
const SUB_ADDRESSES = ['POST /api/addons/public-link/(install|update|start|stop|remove|setup)', 'POST /api/addons/public-link/do/<id>', 'GET /api/addons/public-link/job'];

test('the rows the inventory does not have are routes that only read, and the addresses of the public link\'s add-on', () => {
  const have = new Set(INV.map((i) => i.act));
  const extra = ACTS.rows.filter((r) => !have.has(r.source));
  assert.ok(extra.length >= 150, String(extra.length));
  assert.deepEqual(extra.filter((r) => !(r.source.startsWith('GET ') && (r.kind === 'not-an-act' || r.facts.reads === true)) && !SUB_ADDRESSES.includes(r.source)).map((r) => r.source), []);
  for (const r of extra.filter((x) => SUB_ADDRESSES.includes(x.source))) assert.equal(r.facts.never, 'open-out', r.source);
});

test('a row held to the inventory fails when its facts, its tool or its kind differ', () => {
  const clone = (fn) => {
    const rows = structuredClone(ACTS.rows);
    fn(rows.find((r) => r.source === 'POST /api/sessions/<id>/kill'));
    return rows;
  };
  const diff = (rows) => INV.filter((i) => {
    const a = rows.find((r) => r.source === i.act);
    return a && a.kind !== 'not-an-act' && (JSON.stringify(a.facts) !== JSON.stringify(i.act === UNDO_OF_UNDO ? { ...i.facts, undo: 'remake' } : i.facts) || JSON.stringify(a.tool || null) !== JSON.stringify(i.hers && i.facts.never === 'none' ? { name: i.hers[0].tool, ...(i.hers[0].action ? { action: i.hers[0].action } : {}) } : null));
  }).map((i) => i.act);
  assert.deepEqual(diff(ACTS.rows), []);
  assert.deepEqual(diff(clone((r) => (r.facts.seen = true))), ['POST /api/sessions/<id>/kill']);
  assert.deepEqual(diff(clone((r) => (r.tool = { name: 'other_tool' }))), ['POST /api/sessions/<id>/kill']);
});
