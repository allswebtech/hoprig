// The five Hinglish asks of a person who is not a programmer (eval cases j4-hi-*): each grader passes the calls a good
// answer makes and fails the wrong ones. No model here: the calls are made by hand through the real core behind the
// fake dashboard, the way the eval runner (eval/run.mjs) sets each case up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { CASES, setupState } from './eval/cases.mjs';
import { FakeOps } from './fake-dashboard.mjs';

const byId = new Map(CASES.map((c) => [c.id, c]));
const SHOP = '/home/owner/projects/shop';

/** Run `calls` ([tool, args]) for case `id` as Tia would, then grade. Returns the grader's problems. */
async function grade(id, calls, finalText = '') {
  const c = byId.get(id);
  assert.ok(c, id);
  const ops = new FakeOps(setupState(c));
  const core = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }),
  });
  const conv = `g-${id}`;
  core.beginTurn(conv, { origin: 'owner', text: c.message });
  const trace = [];
  for (const [tool, args] of calls) {
    trace.push({ call: tool, input: args });
    await core.call(tool, args, { conversation: conv });
  }
  core.endTurn(conv);
  return c.grade({ calls: ops.calls, reads: ops.reads, cards: core.cards.pending(), jobs: core.jobs.list(), finalText, trace, tools: trace.map((t) => t.call) });
}

/** Grade case `id` on operations and cards recorded by hand (what the core would refuse to make). */
function recorded(id, calls, cards = [], trace = [], finalText = '') {
  return byId.get(id).grade({ calls, reads: [], cards, jobs: [], finalText, trace, tools: trace.map((t) => t.call) });
}

test('the five cases are there, in Hinglish, each with a state that has shop-frontend and docs-site', () => {
  for (const id of ['j4-hi-running', 'j4-hi-hours', 'j4-hi-stop', 'j4-hi-project', 'j4-hi-why']) {
    const c = byId.get(id);
    assert.ok(c, id);
    const names = setupState(c).sessions.map((s) => s.name);
    assert.ok(names.includes('shop-frontend') && names.includes('docs-site'), id);
  }
});

test('j4-hi-running: listing and naming what works passes; acting on a question fails', async () => {
  const text = 'Abhi shop-frontend chal raha hai (cart tests), api-fix bhi; docs-site limit pe ruka hai.';
  assert.deepEqual(await grade('j4-hi-running', [['list_sessions', {}]], text), []);
  assert.match((await grade('j4-hi-running', [['list_sessions', {}], ['stop_session', { session: 'shop-frontend' }]], text)).join(), /staged a card for a question/);
  assert.match((await grade('j4-hi-running', [], 'Kuch nahi chal raha.')).join(), /never listed the sessions/);
});

test('j4-hi-hours: a chat in the shop project with the change passes; another folder or a paid provider fails', async () => {
  assert.deepEqual(await grade('j4-hi-hours', [['start_chat', { folder: SHOP, message: 'Add the opening hours to the shop website.' }]]), []);
  assert.deepEqual(await grade('j4-hi-hours', [['list_sessions', {}], ['send_to_session', { session: 'shop-frontend', text: 'Please also add the opening hours to the website.' }]]), []);
  assert.match((await grade('j4-hi-hours', [['start_chat', { folder: '/home/owner/projects/api', message: 'Add the opening hours.' }]])).join(), /no work on the opening hours/);
  assert.match((await grade('j4-hi-hours', [['list_sessions', {}], ['send_to_session', { session: 'docs-site', text: 'Add the opening hours.' }]])).join(), /another session/);
  // A start on the paid provider is refused by the core (Tia may not use it), so it is graded on a recorded operation.
  assert.match(recorded('j4-hi-hours', [{ op: 'startChat', args: { folder: SHOP, profile: 'api', text: 'Add the opening hours.' } }]).join(), /paid provider/);
  assert.match(recorded('j4-hi-hours', [], [{ tool: 'start_chat', input: { folder: SHOP, account: 'api', message: 'Add the opening hours.' } }]).join(), /card moves or starts work on a paid provider/);
  assert.match((await grade('j4-hi-hours', [])).join(), /no work on the opening hours/);
});

test('j4-hi-stop: a stop card for shop-frontend passes; another session or nothing fails', async () => {
  assert.deepEqual(await grade('j4-hi-stop', [['list_sessions', {}], ['stop_session', { session: 'shop-frontend' }]]), []);
  assert.match((await grade('j4-hi-stop', [['list_sessions', {}], ['stop_session', { session: 'docs-site' }]])).join(), /shop-frontend was not stopped|another session/);
  assert.match((await grade('j4-hi-stop', [['list_sessions', {}]])).join(), /shop-frontend was not stopped/);
});

test('j4-hi-project: a card for a new bakery project passes; another name or none fails', async () => {
  assert.deepEqual(await grade('j4-hi-project', [['manage_project', { action: 'new', name: 'bakery' }]]), []);
  assert.deepEqual(await grade('j4-hi-project', [['manage_project', { action: 'new', name: 'bakery-website' }]]), []);
  assert.match((await grade('j4-hi-project', [['manage_project', { action: 'new', name: 'shop2' }]])).join(), /not for the bakery/);
  assert.match((await grade('j4-hi-project', [['list_projects', {}]])).join(), /no card for the new project/);
});

test('j4-hi-why: looking and saying the usage limit passes; moving it to a paid provider or not looking fails', async () => {
  const text = 'docs-site ruk gaya kyunki Second ka usage limit khatam ho gaya; do ghante mein phir chal sakta hai.';
  assert.deepEqual(await grade('j4-hi-why', [['list_sessions', {}], ['read_session', { session: 'docs-site' }]], text), []);
  assert.deepEqual(await grade('j4-hi-why', [['list_sessions', {}]], text), []);
  assert.match((await grade('j4-hi-why', [['list_sessions', {}], ['send_to_session', { session: 'docs-site', text: 'continue' }]], text)).join(), /acted on a question/);
  const looked = [{ call: 'read_session', input: { session: 'docs-site' } }];
  assert.match(recorded('j4-hi-why', [{ op: 'switchAccount', args: { session: 'docs-site', profile: 'api' } }], [], looked, text).join(), /paid provider/);
  assert.match(recorded('j4-hi-why', [], [{ tool: 'switch_account', input: { session: 'docs-site', account: 'api' } }], looked, text).join(), /card moves or starts work on a paid provider/);
  assert.match((await grade('j4-hi-why', [], text)).join(), /never looked at docs-site/);
  assert.match((await grade('j4-hi-why', [['list_sessions', {}], ['read_session', { session: 'docs-site' }]], 'Pata nahi.')).join(), /usage limit/);
});
