// hoprig_act and the rule behind every act: levelFor on the six facts of a row, run again on the facts of each call.
// A gateway restart is L1 (she does it alone only when the owner allowed it, else a card), a stop is a card, a paid
// provider in the Auto order says so on its card, a spoken L1 act that cannot be put back with one press is a card, a
// place that holds credentials is refused, an act of another conversation can be undone, and the tool array does not
// change when an act is added.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NEVER_CLASSES, factProblems, levelFor, raiseFacts } from '../../src/assistant/acts.mjs';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { ACTS, callFacts, decide } from '../../src/assistant/hoprigact.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { ALLOW, NEVER_ROUTES, checkRoute, gatedDispatch, neverClassOf } from '../../src/assistant/door.mjs';
import { MCP_TOOLS, MCP_TOOLS_JSON, OLD_NAMES, TOOLS } from '../../src/assistant/tools.mjs';
import { noteStopped } from '../../src/addons/stopmark.mjs';
import { sandbox } from '../server/helpers.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const BUILTIN = fileURLToPath(new URL('../../skills', import.meta.url));
// One home for the whole file: the places that hold credentials are worked out once, from the first one.
const box = sandbox('hoprigact');
process.on('exit', () => box.cleanup());
const F = (o = {}) => ({ reads: false, own: false, undo: false, spends: false, seen: false, other: false, never: 'none', ...o });

function setup({ alone = false, level = 'work', change } = {}) {
  const s = baseState();
  s.assistant = { enabled: true, level, actAlone: alone };
  change?.(s);
  const ops = new FakeOps(s);
  const audit = new AuditLog({ file: null });
  const core = createAssistantCore({ ops, cards: new CardStore(), audit, jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [{ dir: BUILTIN, source: 'built-in' }] }) });
  const call = (args, { conversation = 'c1' } = {}) => core.call('hoprig_act', args, { conversation });
  const writes = (op) => ops.calls.filter((c) => c.op === op);
  return { core, ops, audit, call, writes };
}

test('levelFor: reads are free, one press back is L1, money, others and what is hard to undo are L2, a NEVER class is N', () => {
  assert.equal(levelFor(F({ reads: true })), 'L0');
  assert.equal(levelFor(F({ own: true, undo: true })), 'L1');
  assert.equal(levelFor(F({ own: true, undo: 'remake' })), 'L1');
  assert.equal(levelFor(F({ own: true })), 'L2', 'no undo');
  assert.equal(levelFor(F({ own: true, undo: true, spends: true })), 'L2');
  assert.equal(levelFor(F({ own: true, undo: true, seen: true })), 'L2');
  assert.equal(levelFor(F({ own: true, undo: true, other: true })), 'L2');
  assert.equal(levelFor(F({ reads: true, spends: true })), 'L2', 'a read that costs money is not free');
  assert.equal(levelFor(F({ own: false })), 'L2', 'not Hoprig\'s own state');
  for (const never of Object.keys(NEVER_CLASSES)) assert.equal(levelFor(F({ reads: true, own: true, undo: true, never })), 'N', never);
  assert.deepEqual(Object.keys(NEVER_CLASSES), ['sign-in', 'credentials', 'open-out', 'pair', 'delete-work', 'her-rights']);
});

test('spoken raises an L1 act that no press takes back, and never lowers one', () => {
  assert.equal(levelFor(F({ own: true, undo: true }), { spoken: true }), 'L1');
  assert.equal(levelFor(F({ own: true, undo: 'remake' }), { spoken: true }), 'L2');
  assert.equal(levelFor(F({ own: true, undo: 'remake' }), { spoken: false }), 'L1');
  assert.equal(levelFor(F({ reads: true }), { spoken: true }), 'L0');
  assert.equal(levelFor(F({ own: true }), { spoken: true }), 'L2');
});

test('factProblems: every fact must be there, with its kind', () => {
  assert.deepEqual(factProblems(F()), []);
  for (const k of ['reads', 'own', 'undo', 'spends', 'seen', 'other', 'never']) {
    const f = F();
    delete f[k];
    assert.match(factProblems(f).join(), new RegExp(`"${k}" is missing`));
  }
  assert.match(factProblems(F({ never: 'money' })).join(), /not one of/);
  assert.match(factProblems(F({ own: 'yes' })).join(), /true or false/);
});

test('arguments raise a level and never lower it', () => {
  const base = F({ own: true, undo: true });
  assert.deepEqual(raiseFacts(base, { spends: true }), { ...base, spends: true });
  assert.equal(raiseFacts(F({ spends: true }), { spends: false }).spends, true);
  assert.equal(raiseFacts(F({ never: 'pair' }), { never: 'none' }).never, 'pair');
  assert.equal(raiseFacts(base, { never: 'credentials' }).never, 'credentials');
  // The server's own facts of a call: another computer, a paid provider, a session that is not hers, a credentials folder.
  assert.equal(callFacts({ act: 'restart-gateway', computer: 'box2' }, {}).other, true);
  assert.equal(callFacts({ act: 'continue-session', session: 's' }, { session: { paid: true }, mine: true }).spends, true);
  assert.equal(callFacts({ act: 'continue-session', session: 's' }, { session: { paid: false }, mine: false }).seen, true);
  assert.equal(callFacts({ act: 'continue-session', session: 's' }, { session: { paid: false }, mine: true }).seen, false);
  assert.equal(callFacts({ act: 'reopen-session', session: 's' }, { session: { cwd: box.profiles }, mine: true }).never, 'credentials');
});

test('decide: L1 runs alone only with the owner\'s switch and not at Ask me; L2 and N never run alone', () => {
  const a = { act: 'restart-gateway', item: 'gw1' };
  assert.deepEqual(decide(a, {}, { actAlone: true, level: 'work' }), { level: 'L1' });
  assert.equal(decide(a, {}, { actAlone: false, level: 'work' }).level, 'L2');
  assert.equal(decide(a, {}, { actAlone: true, level: 'ask' }).level, 'L2');
  assert.equal(decide({ act: 'stop-gateway', item: 'gw1' }, {}, { actAlone: true, level: 'handsoff' }).level, 'L2');
  assert.equal(decide({ act: 'probe-provider', item: 'gw1' }, {}, {}).level, 'L0');
  assert.ok(decide({ act: 'nothing' }, {}, {}).refuse);
  assert.equal(decide({ act: 'reopen-session', session: 's' }, { session: { cwd: '/x' }, mine: true }, { actAlone: true }).level, 'L1');
  assert.equal(decide({ act: 'reopen-session', session: 's', computer: 'box2' }, { session: { cwd: '/x' }, mine: true }, { actAlone: true }).level, 'L2', 'another computer');
  assert.equal(decide({ act: 'clean-own-temp' }, { spoken: true }, { actAlone: true }).level, 'L2');
  assert.equal(decide({ act: 'clean-own-temp' }, { spoken: false }, { actAlone: true }).level, 'L1');
});

test('a gateway restart runs at L1 with "She may act alone" on, and is a card with it off', async () => {
  const on = setup({ alone: true });
  const r = await on.call({ act: 'restart-gateway', item: 'gw1' });
  assert.equal(r.isError, false, r.text);
  assert.equal(on.writes('mends.restartGateway').length, 1);
  assert.deepEqual(on.writes('mends.restartGateway')[0].args, { id: 'gw1' });
  const line = on.audit.recent().find((e) => e.tool === 'hoprig_act');
  assert.equal(line.level, 'L1');
  assert.equal(line.outcome, 'done');
  assert.deepEqual(line.result.undo, { act: 'stop-gateway', item: 'gw1' }, 'Activity can undo it');

  const off = setup({ alone: false });
  const c = await off.call({ act: 'restart-gateway', item: 'gw1' });
  assert.ok(c.card, 'a card');
  assert.equal(off.writes('mends.restartGateway').length, 0, 'nothing ran');
  assert.match(c.card.lines.join('\n'), /Restart the gateway gw1\?/);
  assert.match(c.card.lines.join('\n'), /sessions? on it wait/);
});

test('a stop is a card at every level of hers, also with the switch on', async () => {
  for (const level of ['ask', 'work', 'handsoff']) {
    const t = setup({ alone: true, level });
    const r = await t.call({ act: 'stop-gateway', item: 'gw1' });
    assert.ok(r.card, level);
    assert.equal(t.writes('mends.stopGateway').length, 0);
    assert.match(r.card.lines.join('\n'), /Stop the gateway gw1\?/);
  }
});

test('a gateway the owner stopped himself is not started again by her', async () => {
  noteStopped('gw9');
  const t = setup({ alone: true });
  const r = await t.call({ act: 'restart-gateway', item: 'gw9' });
  assert.equal(r.isError, true);
  assert.match(r.text, /stopped by the owner himself/);
  assert.equal(t.writes('mends.restartGateway').length, 0);
});

test('a provider paid per use in the Auto order is a card that says so, with the switch on too', async () => {
  const t = setup({ alone: true });
  const r = await t.call({ act: 'auto-order', item: 'api', value: 2 });
  assert.ok(r.card, 'a card');
  assert.match(r.card.lines.join('\n'), /Put api second in the order\?/);
  assert.match(r.card.lines.join('\n'), /api is paid per use and counts against your daily cap/);
  assert.equal(t.writes('setAutoSwitch').length, 0);
  // A provider on a subscription is a card too (Auto moves sessions there), without the paid line.
  const s = await t.call({ act: 'auto-order', item: 'sub2', value: 1 });
  assert.ok(s.card);
  assert.doesNotMatch(s.card.lines.join('\n'), /paid per use/);
});

test('Auto mode and a setting are acts of hoprig_act now, and the old names still work', async () => {
  const t = setup({ alone: true });
  const r = await t.call({ act: 'auto-mode', value: { enabled: true } });
  assert.ok(r.card, 'a card');
  const old = await t.core.call('set_auto_mode', { enabled: true }, { conversation: 'c2' });
  assert.ok(old.card);
  assert.match(old.text, /old name/);
  const set = await t.core.call('change_setting', { key: 'upload_max_mb', value: 50 }, { conversation: 'c3' });
  assert.ok(set.card);
  assert.match(set.text, /old name/);
  assert.ok(OLD_NAMES.has('set_auto_mode') && OLD_NAMES.has('change_setting'));
  assert.ok(!TOOLS.some((x) => x.name === 'set_auto_mode' || x.name === 'change_setting'));
  const bad = await t.call({ act: 'change-setting', item: 'password', value: 'x' });
  assert.equal(bad.isError, true);
});

test('an act of hers the owner spoke: an L1 act with nothing to take back is a card, one with undo stays L1', async () => {
  const t = setup({ alone: true });
  t.core.beginTurn('v1', { origin: 'owner', text: 'clean up the old files', spoken: true });
  const spoken = await t.call({ act: 'clean-own-temp' }, { conversation: 'v1' });
  assert.ok(spoken.card, 'a card when spoken');
  assert.equal(t.writes('mends.cleanOwnTemp').filter((c) => !c.args.dryRun).length, 0);
  assert.match(spoken.card.lines.join('\n'), /Free 1\.2 GB of Hoprig's own old logs and copies\?/);
  t.core.beginTurn('v2', { origin: 'owner', text: 'clean up the old files' });
  const typed = await t.call({ act: 'clean-own-temp' }, { conversation: 'v2' });
  assert.equal(typed.isError, false, typed.text);
  assert.equal(t.writes('mends.cleanOwnTemp').filter((c) => !c.args.dryRun).length, 1, 'typed: it ran');
  t.core.beginTurn('v3', { origin: 'owner', text: 'hold the schedules', spoken: true });
  const held = await t.call({ act: 'hold-starts', value: true }, { conversation: 'v3' });
  assert.equal(held.isError, false, held.text);
  assert.equal(t.writes('mends.hold').length, 1, 'with an undo it stays L1 when spoken');
});

test('an act on a session in the credentials folder is refused, whatever the switch says', async () => {
  const t = setup({ alone: true, change: (s) => { s.sessions[0].cwd = box.profiles; } });
  await t.core.call('list_sessions', {}, { conversation: 'c1' });
  const r = await t.call({ act: 'reopen-session', session: 'api-fix' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /credentials/);
  assert.equal(t.writes('mends.reopenSession').length, 0);
});

test('Undo: an act of another conversation, from the last 7 days, can be undone from any conversation', async () => {
  const t = setup({ alone: true });
  const first = await t.call({ act: 'hold-starts', value: true }, { conversation: 'monday' });
  assert.equal(first.isError, false, first.text);
  const entry = t.audit.recent().find((e) => e.tool === 'hoprig_act' && e.outcome === 'done');
  const list = await t.call({ act: 'list', word: 'undo' }, { conversation: 'tuesday' });
  assert.match(list.text, new RegExp(String(entry.at)));
  const undone = await t.call({ act: 'undo-act', item: String(entry.at) }, { conversation: 'tuesday' });
  assert.equal(undone.isError, false, undone.text);
  assert.equal(t.writes('mends.release').length, 1, 'the hold was released');
  // Once undone it is not offered again, and an act 8 days old is not offered at all.
  const again = await t.call({ act: 'undo-act', item: String(entry.at) }, { conversation: 'wednesday' });
  assert.equal(again.isError, true);
  const old = setup({ alone: true });
  old.audit.append({ actor: 'assistant', conversation: 'x', tool: 'hoprig_act', level: 'L1', input: { act: 'hold-starts', value: true }, outcome: 'done', result: { undo: { act: 'hold-starts', value: false } } });
  old.audit.memory[0].at = Date.now() - 8 * 24 * 3600_000;
  const none = await old.call({ act: 'undo-act', item: String(old.audit.memory[0].at) });
  assert.equal(none.isError, true);
});

test('undoing a restart is a stop, so it needs his tap', async () => {
  const t = setup({ alone: true });
  await t.call({ act: 'restart-gateway', item: 'gw1' }, { conversation: 'a' });
  const entry = t.audit.recent().find((e) => e.tool === 'hoprig_act' && e.outcome === 'done');
  const u = await t.call({ act: 'undo-act', item: String(entry.at) }, { conversation: 'b' });
  assert.ok(u.card, 'a card');
  assert.equal(t.writes('mends.stopGateway').length, 0);
});

test('the tool array is byte-identical when an act is added: the description never lists the acts', () => {
  const tool = TOOLS.find((x) => x.name === 'hoprig_act');
  assert.ok(tool);
  for (const name of Object.keys(ACTS)) assert.ok(!tool.description.includes(name) || name === 'list', `the description names ${name}`);
  assert.doesNotMatch(JSON.stringify(tool.input.json), /restart-gateway|stop-gateway|auto-order/);
  const before = JSON.stringify(MCP_TOOLS);
  ACTS['test-only-act'] = { what: 'an act added by a test', needs: [], level: 'L1', check() {}, async run() { return { summary: 'ok' }; } };
  try {
    assert.equal(JSON.stringify(MCP_TOOLS), before);
    assert.equal(JSON.stringify(MCP_TOOLS), MCP_TOOLS_JSON);
  } finally {
    delete ACTS['test-only-act'];
  }
  assert.equal(TOOLS.length, 24);
});

test('act list with a word returns the acts, their levels and what they need', async () => {
  const t = setup({ alone: true });
  const r = await t.call({ act: 'list', word: 'gateway' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /restart-gateway/);
  assert.match(r.text, /stop-gateway/);
  assert.doesNotMatch(r.text, /auto-order/);
  assert.match(r.text, /"level":"L1"/);
  assert.match(r.text, /"level":"L2"/);
});

test('a card is never confirmed by voice: the confirm route refuses a confirm the page marked spoken', async () => {
  // The route itself (feature.mjs) is exercised with a real session in feature.test.mjs; here its rule is pinned.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/assistant/feature.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(m\[2\] === 'confirm' && b\.spoken === true\) throw Object\.assign\(new HttpError\(403, 'a card is confirmed by a tap on the screen, never by voice'\)/);
  // And her own turn: a message he spoke marks only the turn, never a card.
  assert.match(src, /turn\(c, `\$\{contextLine\(b\.context\)\}\$\{text\}`, \{ spoken: b\.spoken === true \}\)/);
});

// Every class of NEVER, with routes of the code that fall in it: refused at her door, on this computer and behind a
// linked computer's prefix, and before anything is dispatched, whatever a row of ALLOW would say.
const SAMPLES = {
  'sign-in': [['POST', '/api/login'], ['POST', '/api/profiles/add'], ['POST', '/api/accounts/claude-login/start'], ['POST', '/api/tokens/abcdef123456/revoke'], ['POST', '/api/gatewayhost/trouteai/add/key'], ['POST', '/api/gatewayhost/trouteai/service'], ['POST', '/api/gatewayhost/linger'], ['POST', '/api/workspace/git/signin']],
  credentials: [['POST', '/api/workspace/credentials']],
  'open-out': [['POST', '/api/public-link/custom/start'], ['POST', '/api/machines/box2/forward'], ['POST', '/api/gateways/trouteai/share'], ['POST', '/api/addons/public-link/start']],
  pair: [['POST', '/api/pair/code'], ['POST', '/api/joins'], ['POST', '/api/links/code'], ['POST', '/api/machines/box2/remove'], ['POST', '/api/machines/box2/hostkey'], ['POST', '/api/machines/url']],
  'delete-work': [['POST', '/api/workspace/drop'], ['POST', '/api/files/delete'], ['POST', '/api/chats/delete'], ['POST', '/api/adopt/retire']],
  'her-rights': [['POST', '/api/herrights'], ['POST', '/api/assistant/settings'], ['POST', '/api/assistant/cards/c_000000000000/confirm'], ['POST', '/api/updates/settings'], ['POST', '/api/operator/settings'], ['POST', '/api/settings/bypass'], ['POST', '/api/handsoff/session']],
};

test('every NEVER class is refused at her door, here and behind a linked computer, even where a row of ALLOW would match', async () => {
  assert.deepEqual(Object.keys(NEVER_ROUTES), Object.keys(NEVER_CLASSES));
  assert.deepEqual(Object.keys(SAMPLES), Object.keys(NEVER_CLASSES));
  const seen = [];
  const ctx = { config: () => ({}), dispatch: async (m, u) => (seen.push(`${m} ${u}`), { status: 200, json: {} }) };
  for (const [cls, list] of Object.entries(SAMPLES)) {
    for (const [method, p] of list) {
      assert.equal(neverClassOf(p), cls, `${p} is of class ${cls}`);
      for (const url of [p, `/m/box2${p}`]) {
        assert.throws(() => checkRoute(method, url, {}, ctx), (e) => e.status === 403 && e.code === 'tia-route', url);
        assert.throws(() => gatedDispatch(ctx, method, url, {}), (e) => e.status === 403, url);
      }
      // A mistaken row of ALLOW for it does not let it through: NEVER is looked at first.
      ALLOW.push({ method, re: new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), path: p, tool: 'a mistake', body: null, card: null });
      try {
        assert.throws(() => checkRoute(method, p, {}, ctx), (e) => e.status === 403, `${p} with a row that allows it`);
      } finally {
        ALLOW.pop();
      }
    }
  }
  assert.deepEqual(seen, [], 'nothing was dispatched');
  // The three routes of a gateway she may restart, start and stop are not of any class.
  for (const verb of ['restart', 'start', 'stop']) assert.equal(neverClassOf(`/api/gatewayhost/trouteai/${verb}`), null, verb);
  assert.equal(checkRoute('POST', '/api/gatewayhost/trouteai/restart', { confirm: 'desk' }, ctx).tool, 'hoprig_act restart-gateway, stop-gateway');
  assert.throws(() => checkRoute('POST', '/api/gatewayhost/trouteai/restart', { confirm: 'desk', password: 'x' }, ctx), (e) => e.status === 403, 'only the confirmation travels with it');
});
