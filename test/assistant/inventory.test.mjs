// The inventory of every act (src/assistant/inventory.json) against the code itself: the commands of bin/hoprig.mjs,
// every route that changes something (the server's tables, the machines' table, the routes a feature answers in its
// own handle) and the built-in skills. A new act without a row, or a row whose act, tool or action is gone, fails here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function codeLists() {
  const box = sandbox('inventory');
  const A = await import('../../src/assistant/acts.mjs');
  const { TOOLS } = await import('../../src/assistant/tools.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false });
  try {
    return { A, box, lists: { commands: A.commandsIn(fs.readFileSync(path.join(ROOT, 'bin', 'hoprig.mjs'), 'utf8')), routes: A.changingRoutes(app), skills: A.skillsIn(), tools: TOOLS } };
  } finally {
    await app.close();
  }
}

test('every command, changing route and skill of the code has one row, and every row names something that exists', async () => {
  const { A, box, lists } = await codeLists();
  try {
    // The lists are read from the code, not typed here: a sanity floor that the readers found them at all.
    assert.ok(lists.commands.includes('serve') && lists.commands.length >= 30, String(lists.commands.length));
    assert.ok(lists.routes.some((r) => r.key === 'POST /api/sessions') && lists.routes.length >= 150, String(lists.routes.length));
    assert.ok(lists.routes.some((r) => r.key === 'POST /api/pair/claim'), 'a route a feature answers in its own handle');
    assert.ok(lists.routes.some((r) => r.key === 'POST /api/machines/ssh'), 'a route of the machines\' own table');
    for (const r of lists.routes) assert.ok(r.re.test(A.sampleOf(r.re)), `${r.key}: no sample path fits it`);
    assert.deepEqual(A.inventoryProblems(A.loadInventory().rows, lists), []);
  } finally {
    box.cleanup();
  }
});

test('the inventory check fails on a missing row, a row of nothing, a wrong level, a wrong card, a bad reason', async () => {
  const { A, box, lists } = await codeLists();
  try {
    const rows = A.loadInventory().rows;
    const without = rows.filter((r) => r.act !== 'POST /api/sessions');
    assert.match(A.inventoryProblems(without, lists).join('\n'), /POST \/api\/sessions: no row/);
    assert.match(A.inventoryProblems([...rows, { act: 'hoprig fly', kind: 'command', not: 'not-an-act', why: 'There is no such command at all.' }], lists).join('\n'), /hoprig fly: no such command/);
    const edit = (act, fn) => rows.map((r) => (r.act === act ? fn(structuredClone(r)) : r));
    const p = (rs) => A.inventoryProblems(rs, lists).join('\n');
    assert.match(p(edit('POST /api/sessions', (r) => ((r.hers[0].tool = 'start_rocket'), r))), /no tool start_rocket/);
    assert.match(p(edit('POST /api/pcsetup/project/new', (r) => ((r.hers[0].action = 'launch'), r))), /has no action launch/);
    assert.match(p(edit('POST /api/pcsetup/project/new', (r) => ((r.hers[0].level = 'L1'), r))), /is L2 in the code/);
    assert.match(p(edit('POST /api/pcsetup/project/new', (r) => ((r.hers[0].card = 'no'), r))), /has card "yes" in the code/);
    assert.match(p(edit('POST /api/pc/power', (r) => ((r.hers[0].risk = 'R9'), r))), /risk is one of/);
    assert.match(p(edit('POST /api/settings/password', (r) => ((r.not = 'because'), r))), /not one of the groups/);
    assert.match(p(edit('POST /api/settings/password', (r) => ((r.why = 'no'), r))), /one sentence of why/);
  } finally {
    box.cleanup();
  }
});

test('a risk of money, of what goes out, of deletion or rights never sits on an act with no card', async () => {
  const { A, box, lists } = await codeLists();
  try {
    const rows = A.loadInventory().rows;
    const edited = rows.map((r) => (r.act === 'POST /api/sessions/<id>/rename' ? { ...r, hers: r.hers.map((h) => ({ ...h, risk: 'R2' })) } : r));
    const before = A.inventoryProblems(rows, lists);
    const after = A.inventoryProblems(edited, lists);
    // send_to_session is "maybe" (the server raises it), so R2 there is allowed; an act with card "no" is not.
    assert.deepEqual(after, before);
    const noCard = rows.map((r) => (r.act === 'hoprig profiles' ? { ...r, hers: r.hers.map((h) => ({ ...h, risk: 'R2' })) } : r));
    assert.match(A.inventoryProblems(noCard, lists).join('\n'), /hoprig profiles: risk R2 with no card/);
  } finally {
    box.cleanup();
  }
});

// Her door (door.mjs) by a closed list: every route the inventory says is not hers (or that she does by another route)
// is refused there, also behind a computer's prefix; every route of hers passes its route check; and every route the
// door lets through that changes something is a row of hers (the door cannot hold more than the inventory says).
test('the door refuses every route that is not hers and lets through only routes the inventory says are hers', async () => {
  const { A, box, lists } = await codeLists();
  try {
    const { ALLOW, NEVER, checkRoute } = await import('../../src/assistant/door.mjs');
    const rows = new Map(A.loadInventory().rows.map((r) => [r.act, r]));
    const passesRoute = (method, p) => !NEVER.some((re) => re.test(p)) && ALLOW.some((e) => e.method === method && e.re.test(p));
    const refusedAtDoor = (method, p) => {
      try {
        checkRoute(method, p, {}, { config: () => ({}) });
        return false;
      } catch (e) {
        return e.status === 403 && e.code === 'tia-route';
      }
    };
    let notHers = 0;
    for (const r of lists.routes) {
      const row = rows.get(r.key);
      const p = A.sampleOf(r.re);
      if (row.hers) {
        assert.ok(passesRoute(r.method, p), `${r.key} is hers in the inventory, but the door has no route for it`);
      } else {
        notHers++;
        assert.ok(refusedAtDoor(r.method, p), `${r.key} is not hers (${row.not || `same as ${row.same}`}), but the door lets ${p} through`);
        assert.ok(refusedAtDoor(r.method, `/m/alpha${p}`), `${r.key}: let through behind a computer's prefix`);
      }
    }
    assert.ok(notHers > 100, String(notHers));
    // Every changing route of the door's list is a route of the code that the inventory gives her.
    for (const e of ALLOW.filter((x) => x.method !== 'GET')) {
      const match = lists.routes.filter((r) => r.method === e.method && A.samplesOf(r.re).some((x) => e.re.test(x)));
      assert.ok(match.length, `door route ${e.method} ${e.path} is no route of the code`);
      for (const r of match) assert.ok(rows.get(r.key).hers, `door route ${e.method} ${e.path} lets through ${r.key}, which the inventory says is not hers`);
    }
  } finally {
    box.cleanup();
  }
});

// The docs' section "What Tia can do, and what she cannot" is made from the inventory (tools/tia-acts-doc.mjs).
test('the docs\' section of what Tia can do matches the inventory', async () => {
  const D = await import('../../tools/tia-acts-doc.mjs');
  const page = fs.readFileSync(D.DOC, 'utf8');
  assert.equal(D.withSection(page), page, 'docs/OPERATOR.md differs from src/assistant/inventory.json: run node tools/tia-acts-doc.mjs');
  const A = await import('../../src/assistant/acts.mjs');
  const rows = A.loadInventory().rows;
  // A changed row changes the section.
  const edited = rows.map((r) => (r.act === 'POST /api/settings/password' ? { ...r, why: 'Another reason, written for this test only.' } : r));
  assert.notEqual(D.section(edited), D.section(rows));
  assert.match(page, /## What Tia can do, and what she cannot/);
  // The money group in the one name for it: a provider billed by use, never "paid provider".
  assert.equal(A.GROUPS.money, 'money and prices: what a provider costs, which provider billed by use or model is used');
  assert.match(page, /\*\*Money and prices: what a provider costs, which provider billed by use or model is used\*\* \(\d+\):/);
});

// The contract: R3 only on a tool that declares its risk by its argument (run_command); any other R3 row fails.
test('R3 sits only on a tool that declares its risk by its argument', async () => {
  const { A, box, lists } = await codeLists();
  try {
    const rows = A.loadInventory().rows;
    const r3 = rows.flatMap((r) => (r.hers || []).filter((h) => h.risk === 'R3').map((h) => h.tool));
    assert.deepEqual([...new Set(r3)], ['run_command']);
    const edited = rows.map((r) => (r.act === 'POST /api/skillhub/remove' ? { ...r, hers: r.hers.map((h) => ({ ...h, risk: 'R3' })) } : r));
    assert.match(A.inventoryProblems(edited, lists).join('\n'), /manage_skills is R3 but does not declare its risk by its argument/);
  } finally {
    box.cleanup();
  }
});

// The rule: every row carries six facts and its level is levelFor's, never a free word.
test('a row without one of its six facts, or with a level other than levelFor gives, or a tool action with no row, fails', async () => {
  const { A, box, lists } = await codeLists();
  try {
    const rows = A.loadInventory().rows;
    const p = (rs) => A.inventoryProblems(rs, lists).join('\n');
    const edit = (act, fn) => rows.map((r) => (r.act === act ? fn(structuredClone(r)) : r));
    for (const k of ['reads', 'own', 'undo', 'spends', 'seen', 'other', 'never']) {
      assert.match(p(edit('POST /api/sessions', (r) => (delete r.facts[k], r))), new RegExp(`POST /api/sessions: the fact "${k}" is missing`), k);
    }
    assert.match(p(edit('POST /api/sessions', (r) => (delete r.facts, r))), /no facts/);
    assert.match(p(edit('POST /api/sessions', (r) => ((r.level = 'L2'), r))), /the row says L2, levelFor gives L1/);
    assert.match(p(edit('POST /api/sessions', (r) => ((r.facts.spends = true), r))), /the row says L1, levelFor gives L2/);
    assert.match(p(edit('POST /api/settings/password', (r) => ((r.facts.never = 'none'), r))), /levelFor gives L2/);
    // A tool that runs less strictly than the rule gives: the stricter level wins.
    assert.match(p(edit('POST /api/sessions', (r) => ((r.facts.spends = true), (r.level = 'L2'), r))), /the stricter level wins/);
    // A tool action no row names.
    assert.match(p(rows.filter((r) => !(r.hers || []).some((h) => h.action === 'clean-own-temp'))), /hoprig_act clean-own-temp: a tool action that changes something has no row/);
    assert.match(p(rows.filter((r) => r.act !== 'act watch-session')), /watch_session: a tool action that changes something has no row/);
  } finally {
    box.cleanup();
  }
});

test('the written levels are what the rule gives, and the NEVER classes are the six', async () => {
  const A = await import('../../src/assistant/acts.mjs');
  const rows = A.loadInventory().rows;
  for (const r of rows) {
    assert.deepEqual(A.factProblems(r.facts), [], r.act);
    assert.equal(r.level, A.levelFor(r.facts), r.act);
  }
  const classes = new Set(rows.map((r) => r.facts.never).filter((n) => n !== 'none'));
  for (const c of classes) assert.ok(A.NEVER_CLASSES[c], `${c} is a NEVER class`);
  // Her acts: a row that carries the facts of an act with no route names the tool that does it.
  for (const act of ['restart-gateway', 'stop-gateway', 'restart-hoprig', 'reopen-session', 'continue-session', 'hold-starts', 'clean-own-temp', 'change-plan', 'undo-act', 'auto-order', 'auto-mode', 'change-setting', 'probe-provider']) {
    const row = rows.find((r) => r.act === `act ${act}`);
    assert.ok(row && row.hers.some((h) => h.tool === 'hoprig_act' && h.action === act), act);
  }
  assert.equal(rows.find((r) => r.act === 'act restart-gateway').level, 'L2');
  assert.equal(rows.find((r) => r.act === 'act stop-gateway').level, 'L2');
  assert.equal(rows.find((r) => r.act === 'act probe-provider').level, 'L0');
  assert.equal(rows.find((r) => r.act === 'act auto-order').level, 'L2');
  assert.equal(rows.find((r) => r.act === 'act clean-own-temp').facts.undo, false, 'deleted files are not put back by one press');
  assert.equal(rows.find((r) => r.act === 'act clean-own-temp').level, 'L2');
  // The keeper's command is in the inventory, not an act of anyone's: the service manager runs it.
  const keep = rows.find((r) => r.act === 'hoprig keep');
  assert.equal(keep.not, 'not-an-act');
});

test('levelDifferences lists the rows whose tool runs stricter than the rule gives', async () => {
  const A = await import('../../src/assistant/acts.mjs');
  const rows = A.loadInventory().rows;
  const edited = rows.map((r) => (r.act === 'POST /api/chats/<id>/close' ? { ...r, hers: r.hers.map((h) => ({ ...h, level: 'L2', card: 'yes' })) } : r));
  assert.deepEqual(A.levelDifferences(edited).map((d) => d.act), ['POST /api/chats/<id>/close']);
});
