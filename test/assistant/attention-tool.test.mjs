// read_attention: the catalog's rules, each wrong parameter, the fixed short result, the cursor of a repeated call,
// an error that says how to recover, and the merge that made room for it (get_accounts is get_computer_status
// providers now, with the same answer).
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { RESULT_BYTES } from '../../src/assistant/attention-tool.mjs';
import { TOOLS, byName } from '../../src/assistant/tools.mjs';
import { attention, publicAttention } from '../../src/operator/attention.mjs';
import { buildBoard, publicBoard } from '../../src/operator/board.mjs';
import { KINDS } from '../../src/operator/item.mjs';
import { NOW, bigSources } from '../operator/fixtures/bigboard.mjs';
import { ago, session } from '../operator/fixtures/cases.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const listOf = async (sources) => publicAttention(attention(await buildBoard(sources, { now: NOW }), { now: NOW }));

function setup(att) {
  const ops = new FakeOps(baseState());
  ops.s.attention = att;
  const core = createAssistantCore({
    ops, cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }),
    skills: new Skills({ dirs: [{ dir: '/nonexistent-owner', source: 'owner' }] }),
  });
  return { ops, call: (tool, args) => core.call(tool, args, { conversation: 'c1' }) };
}
const dataOf = (text) => JSON.parse(/\{[\s\S]*\}/.exec(text.slice(text.indexOf('\n')))[0]);

test('the catalog: read_attention is L0 with a strict, closed schema; still 25 tools at most, get_accounts merged', () => {
  const t = byName.get('read_attention');
  assert.equal(t.level, 'L0');
  assert.equal(t.input.json.additionalProperties, false);
  assert.deepEqual(Object.keys(t.input.json.properties), ['kind', 'limit', 'since', 'show']);
  assert.deepEqual(t.input.json.properties.show.enum, ['items', 'rules', 'done']);
  assert.deepEqual(t.input.json.properties.kind.enum, ['all', ...KINDS]);
  assert.deepEqual([t.input.json.properties.limit.minimum, t.input.json.properties.limit.maximum], [1, 20]);
  assert.equal(t.input.json.required, undefined, 'every parameter has a default');
  assert.ok(TOOLS.length <= 25);
  assert.equal(byName.get('get_accounts'), undefined);
  assert.ok(byName.get('get_computer_status').input.json.properties.providers);
});

test('the merge loses nothing: get_computer_status providers gives what get_accounts gave', async () => {
  const { call } = setup();
  const r = await call('get_computer_status', { providers: true });
  assert.equal(r.isError, false);
  assert.match(r.text, /provider\(s\) on this; at a limit: .*Auto mode/);
  assert.match(r.text, /"would_pick"/);
  assert.match(r.text, /"auto_mode"/);
  assert.match((await call('get_computer_status', { providers: true, setup: true })).text, /give one of providers, coding_tools, setup or settings/);
});

test('the old name get_accounts still answers, as get_computer_status with the providers, and says the name is old; it is not in the list', async () => {
  const { call } = setup();
  const r = await call('get_accounts', {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /provider\(s\) on this; at a limit: .*Auto mode/);
  assert.match(r.text, /"would_pick"/);
  assert.match(r.text, /get_accounts is an old name: call get_computer_status \{"providers":true\}/);
  assert.ok(!TOOLS.some((t) => t.name === 'get_accounts'), 'not in the list the model sees');
  // Its input goes through the same door: a wrong field is refused under the new name's schema.
  assert.match((await call('get_accounts', { setup: true })).text, /give one of providers, coding_tools, setup or settings/);
});

test('her text reaches read_attention through the same door as her other tools: the cleaned value', async () => {
  const { call } = setup(await listOf({ sessions: () => [session({ name: 'a', limit: { at: ago(3) } })] }));
  const r = await call('read_attention', { kind: 'lim\u200bit' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^1 limit item\(s\) need the owner/);
  assert.match(r.text, /Characters nobody can see were taken out of your input/);
});

test('each wrong parameter is refused, naming the field and the next step; nothing is read', async () => {
  const { call, ops } = setup(await listOf({ sessions: () => [session({ name: 'a', limit: { at: ago(3) } })] }));
  for (const [args, re, next] of [
    [{ kind: 'weather' }, /kind: must be one of: all, limit/, 'call read_attention {"kind":"all"} (kind is one of all, limit,'],
    [{ kind: 'limits' }, /kind: must be one of/, 'call read_attention {"kind":"limit"} (kind is one of'],
    [{ limit: 0 }, /limit: must be from 1 to 20/, 'call read_attention {"limit":20} (limit is a whole number from 1 to 20)'],
    [{ limit: 50 }, /limit: must be from 1 to 20/, 'call read_attention {"limit":20}'],
    [{ limit: '5' }, /limit: must be a whole number/, 'call read_attention {"limit":20}'],
    [{ since: '2026-11-18T10:00:00Z' }, /since: has the wrong form/, 'call read_attention {} for the whole list; since takes only the since value from next of an earlier read_attention result, never a time or an item id'],
    [{ since: 'limit-f3248094a637' }, /since: has the wrong form/, 'call read_attention {} for the whole list;'],
    [{ bogus: 1 }, /unknown field "bogus"/, 'call read_attention {} (its fields are kind, limit, since and show, all optional)'],
    [{ show: 'switches' }, /show: must be one of: items, rules, done/, 'call read_attention {"show":"rules"} (show is one of items, rules, done)'],
  ]) {
    const r = await call('read_attention', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
    assert.ok(r.text.includes(`Next: ${next}`), `${JSON.stringify(args)}: ${r.text}`);
  }
  assert.equal(ops.reads.filter((x) => x.op === 'attention').length, 0);
});

test('the result has a fixed short shape: summary, items, more, next; 4 KB on a big machine', async () => {
  const { call, ops } = setup(await listOf(bigSources()));
  ops.s.attentionAll = publicAttention(attention(await buildBoard(bigSources(), { now: NOW }), { now: NOW }), { limit: 1000 }).items;
  const r = await call('read_attention', { limit: 20 });
  assert.equal(r.isError, false);
  const d = dataOf(r.text);
  assert.deepEqual(Object.keys(d).sort(), ['items', 'more', 'next']);
  assert.ok(d.items.length >= 5 && d.items.length <= 20, `${d.items.length} items`);
  assert.ok(d.more > 0);
  for (const it of d.items) assert.deepEqual(Object.keys(it), ['id', 'kind', 'class', 'subject', 'since', 'facts', 'recommended', 'why']);
  assert.ok(Buffer.byteLength(r.text) <= RESULT_BYTES + 400, `${Buffer.byteLength(r.text)} bytes with the fence`);
  assert.deepEqual(d.next.map((n) => n.act.split(' ')[0]), ['open_screen', 'read_attention']);
  const lim = dataOf((await call('read_attention', { kind: 'limit', limit: 3 })).text);
  assert.ok(lim.items.every((i) => i.kind === 'limit'));
  assert.equal(lim.items.length, 3);
  assert.deepEqual(ops.reads.filter((x) => x.op === 'attention').map((x) => x.args.kind), [null, 'limit'], 'the kind is chosen by the route, before its cut');
});

test('a repeated call with the cursor returns only what changed, and says what went', async () => {
  const sources = (names) => ({ sessions: () => names.map((n) => session({ name: n, state: 'attention', asks: ['main'], askType: 'question', askAt: ago(4) })) });
  const s = setup(await listOf(sources(['a', 'b'])));
  const first = dataOf((await s.call('read_attention', {})).text);
  assert.equal(first.items.length, 2);
  const cursor = JSON.parse(first.next[1].act.slice('read_attention '.length)).since;
  assert.equal(cursor.length, 4 + 12, cursor);
  const same = await s.call('read_attention', { since: cursor });
  assert.match(same.text, /0 new or changed item\(s\), 0 gone, 2 in all/);
  assert.equal(dataOf(same.text).items.length, 0);
  s.ops.s.attention = await listOf(sources(['b', 'c']));
  const later = await s.call('read_attention', { since: cursor });
  assert.match(later.text, /1 new or changed item\(s\), 1 gone, 2 in all/);
  assert.deepEqual(dataOf(later.text).items.map((i) => i.subject), ['session c']);
});

test('an error says the cause and the one call that recovers', async () => {
  const { call, ops } = setup();
  ops.attention = async () => { throw Object.assign(new Error('no such route'), { status: 404 }); };
  const old = await call('read_attention', {});
  assert.equal(old.isError, true);
  assert.match(old.text, /no attention list .*Next: call list_sessions and get_computer_status instead/);
  ops.attention = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
  assert.match((await call('read_attention', {})).text, /could not be read.*Next: call read_attention again in a minute/);
});

// The list as the route sends it: its first 50 items, the whole count, and what is watched.
const routeOf = async (sources) => {
  const board = await buildBoard(sources, { now: NOW });
  return { ...publicAttention(attention(board, { now: NOW })), watched: publicBoard(board).watched };
};

test('a source that could not be read, or a detector that failed, is said: the list is never just empty', async () => {
  const s = setup(await routeOf({ sessions: () => { throw new Error('the dashboard state could not be read'); } }));
  const r = await s.call('read_attention', {});
  assert.equal(r.isError, false);
  assert.match(r.text, /0 item\(s\) need the owner in what could be read as of 2026-03-10 14:00 UTC; could not read: sessions \(the dashboard state could not be read\), so this list may miss items\./);
  s.ops.s.attention = { ...(await routeOf({})), broken: [{ kind: 'repo', error: 'bad input' }] };
  assert.match((await s.call('read_attention', {})).text, /could not read: the repo check \(bad input\)/);
});

test('on a big machine the total is the whole list, not the 50 items the route sends', async () => {
  const route = await routeOf(bigSources());
  assert.equal(route.items.length, 50);
  const d = await setup(route).call('read_attention', {});
  assert.match(d.text, new RegExp(`^${route.count} item\\(s\\) need the owner: \\d+ repo, \\d+ [a-z]+.* as of 2026-03-10 14:00 UTC`));
  assert.ok(route.count > 300, `${route.count}`);
  assert.equal(dataOf(d.text).more, route.count - dataOf(d.text).items.length);
});

test('the cursor marks only the items the result showed: the others come in the next read', async () => {
  const s = setup(await routeOf({ leftovers: () => [1, 2, 3, 4].map((i) => ({ what: 'tmux', pid: 9000 + i, socket: `s${i}`, startedAt: ago(200), clients: 0, parentAlive: false, panes: [{ command: 'bash', children: 0 }] })) }));
  const one = dataOf((await s.call('read_attention', { limit: 1 })).text);
  assert.deepEqual([one.items.length, one.more], [1, 3]);
  const later = await s.call('read_attention', JSON.parse(one.next[1].act.slice('read_attention '.length)));
  assert.match(later.text, /^3 new or changed item\(s\), 0 gone, 4 in all/);
  assert.equal(dataOf(later.text).items.length, 3);
  assert.ok(!dataOf(later.text).items.some((i) => i.id === one.items[0].id), 'the one shown before is not shown again');
});

test('a cursor of one kind is not read as another: other kinds\' items are not "gone"', async () => {
  const s = setup(await routeOf({ sessions: () => [session({ name: 'a', limit: { at: ago(3) } }), session({ name: 'b', state: 'attention', asks: ['main'], askType: 'question', askAt: ago(2) })] }));
  const all = dataOf((await s.call('read_attention', {})).text);
  const since = JSON.parse(all.next[1].act.slice('read_attention '.length)).since;
  const wrong = await s.call('read_attention', { kind: 'limit', since });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /that since value is from a read of kind all, not limit\. Next: call read_attention \{"since":"all\.[0-9a-f]+"\} for what changed there, or read_attention \{"kind":"limit"\} for the whole limit list/);
  const lim = dataOf((await s.call('read_attention', { kind: 'limit' })).text);
  const again = await s.call('read_attention', JSON.parse(lim.next[1].act.slice('read_attention '.length)));
  assert.match(again.text, /^0 new or changed limit item\(s\), 0 gone, 1 in all/);
});

test('no kind shares its name with "what changed", every kind says what it means, and since says it is not a time', () => {
  const p = byName.get('read_attention').input.json.properties;
  assert.ok(!KINDS.includes('changed'));
  for (const k of KINDS) assert.match(p.kind.description, new RegExp(`\\b${k} \\(`), k);
  assert.match(p.since.description, /^Not a time: the since value from next of an earlier read_attention result/);
});

test('for every kind, the next act a result gives is accepted as it is, and leaves out exactly what it showed', async () => {
  const route = await routeOf(bigSources());
  const whole = publicAttention(attention(await buildBoard(bigSources(), { now: NOW }), { now: NOW }), { limit: 1000 }).items;
  const s = setup(route);
  s.ops.s.attentionAll = whole;
  for (const kind of ['all', ...KINDS]) {
    const first = await s.call('read_attention', kind === 'all' ? {} : { kind });
    assert.equal(first.isError, false, `${kind}: ${first.text}`);
    const d = dataOf(first.text);
    assert.ok(d.items.length > 0, `${kind}: the board has items of this kind`);
    const again = await s.call('read_attention', JSON.parse(d.next[1].act.slice('read_attention '.length)));
    assert.equal(again.isError, false, `${kind}: ${again.text}`);
    // The route sends 50 items at most; what it did not send is in more, not in what changed.
    const total = kind === 'all' ? route.count : whole.filter((i) => i.kind === kind).length;
    const unsent = total - Math.min(total, 50);
    assert.match(again.text, new RegExp(`^${d.more - unsent} new or changed .*, 0 gone, ${total} in all`), kind);
  }
});

test('show "rules" and "done" read the owner\'s standing rules and what they did, in a short fixed shape; she only reads', async () => {
  const att = await listOf({ sessions: () => [session({ name: 'a', limit: { at: ago(3) } })] });
  att.reflexes = {
    acts: true, tia: true, active: true, said: 'Tia does by herself only what the rules that are on say, within their limits.', projectsOut: ['shop'], his: {}, undoable: [],
    rules: [
      { id: 'limit', sentence: 'When a session stops at a usage limit, continue it on the next provider of my order.', on: true, undo: 'Move it back', noUndo: null, budget: { perHour: 3, perDay: 10, waitMinutes: 10 }, left: { hour: 2, day: 9 } },
      { id: 'leftover', sentence: 'End a test\'s left-over processes.', on: false, undo: null, noUndo: 'An ended process cannot be undone.', budget: { perHour: 3, perDay: 10, waitMinutes: 10 }, left: { hour: 3, day: 10 } },
    ],
  };
  att.byTia = [{ at: '2026-03-10T13:58:00Z', by: 'limit', subject: 'session a', act: 'switch', ok: true, result: 'moved to plan-b' }];
  const { call, ops } = setup(att);
  const r = await call('read_attention', { show: 'rules' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /1 of 2 rules on; never in: shop/);
  const d = dataOf(r.text);
  assert.deepEqual(d.rules.map((x) => [x.id, x.on, x.left, x.undo]), [['limit', true, '2 more this hour, 9 more today', 'yes'], ['leftover', false, '3 more this hour, 10 more today', 'no']]);
  const done = await call('read_attention', { show: 'done' });
  assert.equal(done.isError, false, done.text);
  assert.deepEqual(dataOf(done.text).done.map((x) => [x.rule, x.subject, x.result, x.done]), [['limit', 'session a', 'moved to plan-b', true]]);
  assert.ok(Buffer.byteLength(done.text) < 4096 + 400);
  assert.deepEqual(ops.calls.filter((c) => !/^(attention)$/.test(c.op)), [], 'reading the rules changes nothing');
});
