// A read of a catalog act on ANOTHER computer is a card (the fact "other" turns on, acts.mjs raiseFacts): look and do_act say so,
// and his tap runs it for exactly that computer; on this computer the same read answers at once. The door never lets a read
// inside a look go to another computer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { runAsLook, runConfirmed } from '../../src/assistant/confirmed.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { PlanStore, actsAdapter } from '../../src/assistant/plans.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup() {
  const ops = new FakeOps(baseState());
  const routed = [];
  ops.routeCall = async (computer, method, p) => { routed.push({ computer, method, p }); return { folders: [] }; };
  const core = createAssistantCore({ ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }), plans: new PlanStore(), acts: actsAdapter({ run: async () => ({ ok: true }), undo: async () => ({ ok: true }), fact: async () => ({}) }) });
  core.shown.add('e1', { act: ['folders.extras'], computer: ['box2'] });
  return { core, routed, call: (name, args) => core.call(name, args, { conversation: 'e1' }) };
}

test('the same read: at once here, a card on another computer that runs only on his tap', async () => {
  const { core, routed, call } = setup();
  let r = await call('do_act', { act: 'folders.extras' });
  assert.equal(r.isError, false, r.text);
  assert.equal(routed.length, 1, 'read at once on this computer');
  assert.ok(!r.card);
  routed.length = 0;
  r = await call('do_act', { act: 'folders.extras', computer: 'box2' });
  assert.ok(r.card, `a card is staged: ${r.text}`);
  assert.deepEqual(routed, [], 'nothing was read before his tap');
  const done = await core.confirm(r.card.id);
  assert.equal(done.ok, true);
  assert.deepEqual(routed.map((x) => [x.computer, x.method]), [['box2', 'GET']], 'read on box2 after his tap');
});

test('look says a fact on another computer is not a read for her: it names the card', async () => {
  const { routed, call } = setup();
  const r = await call('look', { facts: [{ id: 'folders.extras', computer: 'box2' }] });
  assert.match(r.text, /not a read: its answer is card/, r.text);
  assert.deepEqual(routed, []);
});

test('the door: a look reaches no other computer; his card for exactly that read does', () => {
  assert.throws(() => runAsLook(() => checkRoute('GET', '/m/box2/api/folders/extras', undefined, {})), /not a route|owner/);
  assert.equal(runAsLook(() => checkRoute('GET', '/api/folders/extras', undefined, {})).tool, 'look');
  const card = { id: 'c_000000000000', tool: 'do_act', input: { act: 'folders.extras', args: {}, computer: 'box2' } };
  const ok = runConfirmed(card, () => checkRoute('GET', '/m/box2/api/folders/extras', undefined, {}));
  // The owner press is this computer's only: there the request keeps her own mark, so that computer's gate judges it.
  assert.equal(ok.tool, 'do_act');
  assert.notEqual(ok.owner, true);
  assert.throws(() => runConfirmed(card, () => checkRoute('GET', '/m/box3/api/folders/extras', undefined, {})), /not a route|owner/);
});
