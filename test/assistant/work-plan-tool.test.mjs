// manage_work and plans (src/assistant/worktool.mjs): Tia reads the plans and one plan in its own order, and changes a
// plan's tasks (add into it, reword, move, mark done, hand to a role). A change runs at once only when the owner's own
// message of this turn named that plan or task and her level is not "Ask me"; else it is his card. On the fake
// dashboard (fake-work.mjs withPlan), whose plan view is the real one (src/work/planview.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';
import { PLAN_ID, withPlan } from './fake-work.mjs';

function setup({ level = 'work', state = withPlan(baseState()) } = {}) {
  state.assistant = { ...state.assistant, enabled: true, level };
  const ops = new FakeOps(state);
  const core = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }),
  });
  const call = (args, conversation = 'p1') => core.call('manage_work', args, { conversation });
  return { ops, core, call };
}
const writes = (ops) => ops.calls.map((c) => c.op);
const dataOf = (r) => JSON.parse(/<untrusted_\w+[^>]*>\n?([\s\S]*?)\n?<\/untrusted_/.exec(r.text)[1]);

test('plans: the list of plans, with the ids she may read next; nothing changes', async () => {
  const { call, ops } = setup();
  assert.match((await call({ action: 'plan', plan: PLAN_ID })).text, /plan "launch-the-shop" was not shown.*manage_work action plans/s);
  const r = await call({ action: 'plans' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^1 plan\(s\) on this\. Next: action plan/);
  const d = dataOf(r);
  assert.equal(d.plans[0].plan, PLAN_ID);
  assert.deepEqual(d.plans[0].progress, { done: 0, all: 4 });
  assert.deepEqual(writes(ops), []);
});

test('plan: its milestones and tasks in the plan\'s own order, each with its state, date, who does it and what it waits for', async () => {
  const { call, ops } = setup();
  await call({ action: 'plans' });
  const r = await call({ action: 'plan', plan: PLAN_ID });
  assert.equal(r.isError, false, r.text);
  const d = dataOf(r);
  assert.deepEqual(d.milestones.map((m) => [m.milestone, m.tasks.map((t) => t.task)]), [['build', ['write-the-cart-tests', 'fix-the-cart-total']], ['ship', ['deploy-the-shop']]], 'by milestone, then by date (the tests are dated, the fix is not)');
  assert.deepEqual(d.no_milestone.map((t) => t.task), ['pick-a-domain']);
  const fix = d.milestones[0].tasks[1];
  assert.deepEqual([fix.status, fix.by, fix.after, fix.waits_on], ['open', 'ai', ['write-the-cart-tests'], ['write-the-cart-tests']]);
  const deploy = d.milestones[1].tasks[0];
  assert.deepEqual([deploy.date, deploy.by, deploy.waits_on], ['2026-11-30', 'me', ['fix-the-cart-total']]);
  // The tasks it showed are hers to name next.
  assert.equal((await call({ action: 'task', task: 'deploy-the-shop' })).isError, false);
  assert.deepEqual(writes(ops), []);
});

test('plan: a plan that is gone is said with the step that recovers', async () => {
  const { call, ops } = setup();
  await call({ action: 'plans' });
  ops.s.work.plans = [];
  const r = await call({ action: 'plan', plan: PLAN_ID });
  assert.equal(r.isError, true);
  assert.match(r.text, /there is no plan "launch-the-shop" on this any more\. Next: call manage_work action plans/);
});

// ---- changes of a plan ----

const cardOf = (r) => /card (c_[0-9a-f]{12})/.exec(r.text)[1];
const staged = (r) => /Waiting for the owner's OK \(card c_/.test(r.text);
const item = (ops, id) => ops.s.work.items.find((x) => x.id === id);
/** A conversation that read the plan in a turn of the owner's that says `text`. */
async function readIn(text, opts) {
  const t = setup(opts);
  t.core.beginTurn('p1', { origin: 'owner', text });
  await t.call({ action: 'plans' });
  await t.call({ action: 'plan', plan: PLAN_ID });
  return t;
}

test('a move he asked for by name runs at once, and undo puts it back', async () => {
  const { call, ops } = await readIn('Move "Fix the cart total" to the Ship it milestone, and it no longer waits for anything.');
  const r = await call({ action: 'edit', task: 'fix-the-cart-total', milestone: 'ship', after: [] });
  assert.equal(r.isError, false, r.text);
  assert.ok(!staged(r), r.text);
  assert.match(r.text, /Changed the task fix-the-cart-total on this \(milestone, after\)\. Next: say so in your reply; undo takes it back/);
  assert.deepEqual(ops.calls.map((c) => c.op), ['workTaskPlan']);
  assert.deepEqual(ops.calls[0].args, { computer: 'this', id: 'fix-the-cart-total', at: 1, plan: PLAN_ID, milestone: 'ship', after: [] });
  assert.deepEqual([item(ops, 'fix-the-cart-total').milestone, item(ops, 'fix-the-cart-total').after], ['ship', undefined]);
  const u = await call({ action: 'undo' });
  assert.equal(u.isError, false, u.text);
  assert.deepEqual([item(ops, 'fix-the-cart-total').plan, item(ops, 'fix-the-cart-total').milestone, item(ops, 'fix-the-cart-total').after], [PLAN_ID, 'build', ['write-the-cart-tests']]);
});

test('reword, hand to a role, mark done: each at once when he named the task, each taken back by undo', async () => {
  const { call, ops } = await readIn('In the launch the shop plan: call the deploy task "Deploy the shop to the server", give the cart tests to the tester role, and the domain one is done.');
  let r = await call({ action: 'edit', task: 'deploy-the-shop', title: 'Deploy the shop to the server' });
  assert.equal(r.isError, false, r.text);
  assert.ok(!staged(r), r.text);
  assert.equal(item(ops, 'deploy-the-shop').title, 'Deploy the shop to the server');
  r = await call({ action: 'edit', task: 'write-the-cart-tests', by: 'tester' });
  assert.ok(!staged(r), r.text);
  assert.equal(item(ops, 'write-the-cart-tests').by, 'tester');
  r = await call({ action: 'done', task: 'pick-a-domain' });
  assert.ok(!staged(r), r.text);
  assert.equal(item(ops, 'pick-a-domain').status, 'done');
  for (let i = 0; i < 3; i++) assert.equal((await call({ action: 'undo' })).isError, false);
  assert.deepEqual([item(ops, 'deploy-the-shop').title, item(ops, 'write-the-cart-tests').by, item(ops, 'pick-a-domain').status], ['Deploy the shop', 'ai', 'open']);
});

test('a task added into the plan at his word lands in its milestone with what it waits for; undo takes it out', async () => {
  const { call, ops } = await readIn('Add a task "Write the launch post" to the launch the shop plan, in Ship it, after the deploy.');
  const add = { action: 'add', title: 'Write the launch post', plan: PLAN_ID, milestone: 'ship', after: ['deploy-the-shop'], project: 'shop' };
  const r = await call(add);
  assert.equal(r.isError, false, r.text);
  assert.ok(!staged(r), r.text);
  assert.match(r.text, /Added the task write-the-launch-post to the plan launch-the-shop on this/);
  const x = item(ops, 'write-the-launch-post');
  assert.deepEqual([x.plan, x.milestone, x.after], [PLAN_ID, 'ship', ['deploy-the-shop']]);
  // The same add again changes nothing twice.
  const again = await call(add);
  assert.match(again.text, /has the task write-the-launch-post of that title already: nothing was added/);
  assert.equal(ops.s.work.items.filter((y) => y.title === 'Write the launch post').length, 1);
  assert.equal(ops.calls.filter((c) => c.op === 'workAdd').length, 1);
  assert.equal((await call({ action: 'undo' })).isError, false);
  assert.equal(item(ops, 'write-the-launch-post'), undefined);
});

test('the same edit twice writes once', async () => {
  const { call, ops } = await readIn('Give "Write the cart tests" to the reviewer role.');
  assert.ok(!staged(await call({ action: 'edit', task: 'write-the-cart-tests', by: 'reviewer' })));
  const r = await call({ action: 'edit', task: 'write-the-cart-tests', by: 'reviewer' });
  assert.match(r.text, /is like that already: nothing was changed/);
  assert.equal(ops.calls.filter((c) => c.op === 'workEdit').length, 1);
});

test('a change of his plan that his message did not name is a card that shows the change, and nothing is done before his tap', async () => {
  const { call, core, ops } = await readIn('What is left in my plans?');
  const r = await call({ action: 'edit', task: 'fix-the-cart-total', milestone: 'ship' });
  assert.ok(staged(r), r.text);
  assert.match(r.text, /Why a card: the owner's message did not name this plan or this task/);
  assert.match(r.text, /Milestone: \\"Build the cart\\" → \\"Ship it\\"/);
  assert.deepEqual(ops.calls, [], 'nothing changed before his tap');
  const done = await core.confirm(cardOf(r));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(item(ops, 'fix-the-cart-total').milestone, 'ship');
  // A task he named, moved into a plan he did not name, is a card too.
  ops.s.work.plans.push({ ...ops.s.work.plans[0], id: 'other-plan', title: 'Other plan', milestones: [] });
  const t2 = await readIn('Move Renew the domain somewhere sensible.');
  t2.ops.s.work.plans.push({ ...t2.ops.s.work.plans[0], id: 'other-plan', title: 'Other plan', milestones: [] });
  await t2.call({ action: 'plans' });
  await t2.call({ action: 'list' });
  assert.ok(staged(await t2.call({ action: 'edit', task: 'renew-the-domain', plan: 'other-plan' })));
  assert.deepEqual(t2.ops.calls, []);
});

test('at "Ask me" every change of a plan is a card, also one he named; a task in no plan is as before', async () => {
  const { call, ops } = await readIn('Mark "Pick a domain name" in the launch the shop plan done.', { level: 'ask' });
  for (const a of [{ action: 'done', task: 'pick-a-domain' }, { action: 'edit', task: 'pick-a-domain', title: 'Pick the domain' }, { action: 'add', title: 'Pick a host', plan: PLAN_ID }]) {
    const r = await call(a);
    assert.ok(staged(r), `${a.action}: ${r.text}`);
    assert.match(r.text, /the owner set \\"Ask me\\": every change of a plan needs his OK/);
  }
  assert.deepEqual(ops.calls, []);
  await call({ action: 'list' });
  assert.ok(!staged(await call({ action: 'done', task: 'renew-the-domain' })), 'a task of no plan: her level for Work as it was');
});

test('in a job\'s turn every change of a plan is a card, whatever the earlier message said', async () => {
  const { call, core, ops } = await readIn('Mark "Pick a domain name" in the launch the shop plan done.');
  const j = core.jobs.create({ conversation: 'p1', goal: 'Look at the plan' });
  core.beginTurn('p1', { origin: 'job', job: j.id, mode: 'notify' });
  const r = await call({ action: 'done', task: 'pick-a-domain' });
  assert.ok(staged(r), r.text);
  assert.match(r.text, /this turn is not one/);
  assert.deepEqual(ops.calls, []);
});

test('a role that is not one, a milestone or plan that is not there, and a stale plan are refused with the step that recovers', async () => {
  const { call, core, ops } = await readIn('Hand "Write the cart tests" to the boss, and move it to the launch milestone.');
  assert.match((await call({ action: 'edit', task: 'write-the-cart-tests', by: 'boss' })).text, /by: must be one of: me, ai, developer, reviewer, tester, researcher, writer, ops/);
  let r = await call({ action: 'edit', task: 'write-the-cart-tests', milestone: 'launch' });
  assert.equal(r.isError, true);
  assert.match(r.text, /"launch" is not a milestone of the plan launch-the-shop\. Next: use one of: build, ship/);
  assert.match((await call({ action: 'add', title: 'Pick a host', plan: 'no-such-plan' })).text, /plan "no-such-plan" was not shown.*manage_work action plans/s);
  assert.match((await call({ action: 'edit', task: 'renew-the-domain', title: 'x y z' })).text, /task "renew-the-domain" was not shown/);
  // A card made on the plan as it was: the plan changed before his tap, so nothing runs.
  core.beginTurn('p1', { origin: 'owner', text: 'Anything to tidy?' });
  const c = await call({ action: 'edit', task: 'write-the-cart-tests', milestone: 'ship' });
  assert.ok(staged(c), c.text);
  ops.s.work.plans[0].milestones[1].title = 'Ship it now';
  const done = await core.confirm(cardOf(c));
  assert.equal(done.ok, false);
  assert.equal(done.code, 'stale');
  assert.equal(item(ops, 'write-the-cart-tests').milestone, 'build');
  assert.equal(ops.calls.filter((x) => x.op === 'workTaskPlan').length, 0);
});

test('the door: the plan route takes only the keys her tool sends; a plan\'s own route stays his', async () => {
  const { checkRoute } = await import('../../src/assistant/door.mjs');
  const ctx = { config: () => ({}) };
  assert.equal(checkRoute('POST', '/api/work/items/fix-it/plan', { at: 1, plan: PLAN_ID, milestone: 'ship', after: [] }, ctx).tool, 'manage_work add, edit, undo');
  assert.equal(checkRoute('GET', `/api/work/plans/${PLAN_ID}`, undefined, ctx).tool.startsWith('manage_work plan'), true);
  const refused = (m, p, b) => assert.throws(() => checkRoute(m, p, b, ctx), (e) => e.status === 403, `${m} ${p} ${JSON.stringify(b)}`);
  refused('POST', '/api/work/items/fix-it/plan', { at: 1, plan: PLAN_ID, status: 'done' });
  refused('POST', '/api/work/items/fix-it/plan', { plan: PLAN_ID });
  // Her act change-plan (hoprig_act) makes and changes a plan: its title, goal, projects and milestones, never its status.
  assert.equal(checkRoute('POST', `/api/work/plans/${PLAN_ID}`, { seen: '0123456789abcdef', title: 'x' }, ctx).tool, 'hoprig_act change-plan');
  assert.equal(checkRoute('POST', '/api/work/plans', { title: 'x', goal: 'y' }, ctx).tool, 'hoprig_act change-plan');
  refused('POST', `/api/work/plans/${PLAN_ID}`, { seen: '0123456789abcdef', status: 'dropped' });
  refused('POST', '/api/work/plans', { title: 'x', status: 'done' });
});
