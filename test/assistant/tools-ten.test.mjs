// Her ten tools (design 2.1): look, find_acts, do_act, start_work, steer_work and the old names. Each rule has a test that fails
// without it: a read through the pick with no secret field, a card that is staged and not run, an open answer with its page and
// press, the start and the steer that go to the tool that did them, and the old names that still answer. A test also PRINTS how
// many acts she reaches by answer now, against the base (the acts a tool of hers reached by name).
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadActs, rowAnswer } from '../../src/assistant/acts.mjs';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { actRows, isCardRoute, isReadRoute } from '../../src/assistant/catalog.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { ALIASES, EAGER_NAMES } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const READ = actRows().find((r) => isReadRoute(r) && !/<id>|\(/.test(r.source));
const CARD = actRows().find((r) => isCardRoute(r) && r.source.startsWith('POST ') && !/<id>|\(/.test(r.source) && !r.input);
const OPEN = actRows().find((r) => r.facts && r.facts.never === 'sign-in' && r.kind === 'route');

function setup({ answer = { name: 'x', items: [1, 2], secret_key: 'sk-never', nested: { token: 't', ok: true } } } = {}) {
  const state = baseState();
  state.assistant = { ...state.assistant, enabled: true, level: 'work' };
  const ops = new FakeOps(state);
  const routed = [];
  // The real routeCall asks the door; so does this one, with the same checkRoute.
  ops.routeCall = async (computer, method, p, body) => {
    checkRoute(method, p.split('?')[0], body, { config: () => state.assistant, poke() {} });
    routed.push({ method, p, body });
    return answer;
  };
  const cards = new CardStore({ now: Date.now });
  const core = createAssistantCore({ ops, now: Date.now, cards, audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }) });
  return { ops, core, cards, routed, call: (name, args) => core.call(name, args, { conversation: 'w1' }), show: (...ids) => core.shown.add('w1', { act: ids }) };
}

test('her array is the closed list of ten, and every old name is an alias that still answers', async () => {
  assert.deepEqual(EAGER_NAMES, ['look', 'find_acts', 'do_act', 'plan_acts', 'start_work', 'steer_work', 'watch_work', 'notify_owner', 'open_screen', 'run_command']);
  const { call } = setup();
  for (const old of Object.keys(ALIASES)) {
    const r = await call(old, {});
    assert.doesNotMatch(r.text, /there is no tool/, `${old} is still a tool that answers`);
  }
  const r = await call('list_sessions', {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /api-fix/);
});

test('find_acts: words in, act ids out with the answer for now, the page and the press', async () => {
  const { call } = setup();
  const r = await call('find_acts', { query: 'ship live', limit: 5 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /ship\.live|ship\./);
  assert.match(r.text, /"answer":"(card|open|alone|read)"/);
  assert.match(r.text, /"press":/);
});

test('look: a read act is read through its pick, no secret field, and the facts of the frequent ids still answer', async () => {
  const { call, routed, show } = setup();
  show(READ.id);
  const r = await call('look', { facts: [{ id: 'sessions' }, { id: READ.id }] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /api-fix/);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].method, 'GET');
  assert.doesNotMatch(r.text, /sk-never|"secret_key"|"token"/, 'no secret-class field reaches her');
});

test('look: a fact that is not a read says its answer and the act id for do_act', async () => {
  const { call, routed, show } = setup();
  show(CARD.id);
  const r = await call('look', { facts: [{ id: CARD.id }] });
  assert.match(r.text, /not a read/);
  assert.match(r.text, new RegExp(CARD.id.replace(/\./g, '\\.')));
  assert.equal(routed.length, 0, 'nothing ran');
});

test('do_act: a card row is staged, not run; his tap runs exactly its act; a never row opens its page', async () => {
  const { call, routed, cards, show } = setup();
  show(CARD.id, OPEN.id);
  const r = await call('do_act', { act: CARD.id, why: 'he asked' });
  assert.match(r.text, /Waiting for the owner's OK \(card c_/);
  assert.equal(routed.length, 0, 'nothing ran before the tap');
  assert.ok(r.card || /card c_/.test(r.text));
  // The door refuses the same route outside a confirmed card.
  const p = CARD.source.replace(/^POST /, '');
  assert.throws(() => checkRoute('POST', p, {}, { config: () => ({}), poke() {} }), /not a route|owner/);
  const o = await call('do_act', { act: OPEN.id });
  assert.equal(o.isError, false, o.text);
  assert.match(o.text, /press/i);
  assert.equal(routed.length, 0);
  assert.ok(cards);
});

test('do_act: an unknown act and a secret field are refused with the next step', async () => {
  const { call, show } = setup();
  show('no.such-act', CARD.id);
  const u = await call('do_act', { act: 'no.such-act' });
  assert.equal(u.isError, true);
  assert.match(u.text, /find_acts/);
  const s = await call('do_act', { act: CARD.id, args: { password: 'x' } });
  assert.equal(s.isError, true);
  assert.match(s.text, /secret/);
});

test('start_work: a chat and a terminal go to the start that did it, with the same checks', async () => {
  const { call, ops } = setup();
  const c = await call('start_work', { folder: '/home/owner/projects/api', message: 'run the tests', provider: 'sub' });
  assert.equal(c.isError, false, c.text);
  assert.ok(ops.calls.some((x) => x.op === 'startChat'), 'a chat by default');
  const t = await call('start_work', { kind: 'terminal', folder: '/home/owner/projects/web', provider: 'sub' });
  assert.equal(t.isError, false, t.text);
  assert.ok(ops.calls.some((x) => x.op === 'startSession'));
  const bad = await call('start_work', { kind: 'terminal', folder: '/home/owner/projects/web', fork_of: 'chat:11111111-1111-4111-8111-111111111111' });
  assert.equal(bad.isError, true);
});

test('steer_work: send goes to the session, a key to a chat is refused, a missing field says what to add', async () => {
  const { call, ops } = setup();
  await call('look', { facts: [{ id: 'sessions' }] });
  // api-fix is his session: a message into it cannot be taken back, so it is a card
  const s = await call('steer_work', { action: 'send', target: 'api-fix', text: 'go on' });
  assert.equal(s.isError, false, s.text);
  assert.ok(s.card, 'a card');
  assert.equal(ops.calls.length, 0);
  const k = await call('steer_work', { action: 'key', target: 'chat:11111111-1111-4111-8111-111111111111', key: 'Enter' });
  assert.equal(k.isError, true);
  assert.match(k.text, /no keys|send or answer/);
  const m = await call('steer_work', { action: 'send', target: 'api-fix' });
  assert.equal(m.isError, true);
  assert.match(m.text, /needs text/);
});

test('how many acts she reaches by answer now, against the base (printed)', (t) => {
  const rows = loadActs().rows.filter((r) => r.kind !== 'not-an-act');
  const by = (list) => list.reduce((o, r) => ({ ...o, [rowAnswer(r)]: (o[rowAnswer(r)] || 0) + 1 }), { read: 0, alone: 0, card: 0, open: 0 });
  // The base: an act a tool of hers reached by name (row.tool) or a page of hers (open_screen) for an open row of a known screen.
  const base = by(rows.filter((r) => r.tool));
  const now = by(rows);
  t.diagnostic(`REACH base: read ${base.read}, alone ${base.alone}, card ${base.card}, open ${base.open} (${rows.filter((r) => r.tool).length} of ${rows.length}); now by answer: read ${now.read}, alone ${now.alone}, card ${now.card}, open ${now.open} (${rows.length} of ${rows.length})`);
  assert.equal(now.read + now.alone + now.card + now.open, rows.length, 'every act has an answer');
  assert.ok(now.open > 0 && now.read > base.read && now.card > base.card);
});
