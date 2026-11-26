// "Who did what" (src/models/parts.mjs): per helper its kind, model and tokens from Claude Code's own transcripts,
// one message counted once (it is written on several lines), never from what a model writes of itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('parts');
test.after(() => box.cleanup());
const { partsOf } = await import('../../src/models/parts.mjs');

const CONV = '11111111-2222-4333-8444-555555555555';
const line = (agent, id, model, usage, text = 'done') => JSON.stringify({ type: 'assistant', attributionAgent: agent, isSidechain: !!agent, message: { id, model, usage, content: [{ type: 'text', text }] } });
const u = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

test('each helper with its kind, model and tokens; a message on several lines counted once; totals per tier', () => {
  const dir = path.join(box.root, 'projects', 'shop');
  const sub = path.join(dir, CONV, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(dir, `${CONV}.jsonl`), [line(undefined, 'm1', 'claude-sonnet-5-5', u(100, 50)), line(undefined, 'm1', 'claude-sonnet-5-5', u(100, 50))].join('\n'));
  // The helper says it is another model: its words never count, only the record's model.
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), [line('hoprig-runner', 'r1', 'claude-haiku-5-5', u(10, 5), 'I am claude-opus-5-5'), line('hoprig-runner', 'r1', 'claude-haiku-5-5', u(10, 5)), line('hoprig-runner', 'r2', 'claude-haiku-5-5', u(20, 5))].join('\n'));
  fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), [line('hoprig-coder', 'c1', 'claude-sonnet-5-5', u(300, 100)), 'not json', ''].join('\n'));
  fs.writeFileSync(path.join(sub, 'agent-a3.jsonl'), line('general-purpose', 'g1', 'claude-sonnet-5-5', u(1, 1)));
  fs.writeFileSync(path.join(sub, '../../note.txt'), 'x');
  const r = partsOf('/unused', CONV, { dir });
  assert.deepEqual(r.lead, { model: 'claude-sonnet-5-5', tokens: 150, use: { in: 100, out: 50, cached: 0 } });
  const byAgent = Object.fromEntries(r.parts.map((p) => [p.agent, [p.tier, p.model, p.tokens]]));
  assert.deepEqual(byAgent['hoprig-runner'], ['fast', 'claude-haiku-5-5', 40]);
  assert.deepEqual(byAgent['hoprig-coder'], ['strong', 'claude-sonnet-5-5', 400]);
  assert.deepEqual(byAgent['general-purpose'], [null, 'claude-sonnet-5-5', 2], 'a helper of another name is listed, with no tier');
  assert.deepEqual(r.tiers.map((t) => [t.tier, t.tokens, t.parts]).sort(), [['fast', 40, 1], ['other', 2, 1], ['strong', 400, 1]]);
  assert.equal(r.parts.find((p) => p.agent === 'hoprig-runner').kind, 'Running and recording');
});

test('cache reads are kept apart and left out of the headline: a part that wrote 200 tokens never reads as 125,000', () => {
  const dir = path.join(box.root, 'projects', 'cached');
  const sub = path.join(dir, CONV, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const big = { input_tokens: 800, output_tokens: 200, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 4000 };
  fs.writeFileSync(path.join(sub, 'agent-b1.jsonl'), line('hoprig-runner', 'r1', 'claude-haiku-5-5', big));
  const r = partsOf('/unused', CONV, { dir });
  assert.deepEqual([r.parts[0].tokens, r.parts[0].use], [5000, { in: 4800, out: 200, cached: 120_000 }]);
  assert.equal(r.parts[0].cacheWrite, 4000, 'of the new input, what was written to the cache: its own price');
  assert.deepEqual(r.tiers[0].use, { in: 4800, out: 200, cached: 120_000 });
});

test('no helpers, no file, a bad id: nothing, and nothing outside the folder is read', () => {
  assert.deepEqual(partsOf('/unused', CONV, { dir: path.join(box.root, 'none') }), { lead: null, parts: [], tiers: [] });
  assert.deepEqual(partsOf('/unused', '../../etc', { dir: box.root }), { lead: null, parts: [], tiers: [] });
});

test('the chat page\'s card: one row per part with its kind, model and tokens, and one totals line per tier', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  await import('../chat/fakedom.mjs');
  const { partRows } = await import('../../web/chat/parts.js');
  const rows = partRows({
    lead: { model: 'claude-sonnet-5-5', tokens: 1500 },
    parts: [{ agent: 'hoprig-runner', kind: 'Running and recording', tier: 'fast', model: 'claude-haiku-5-5', tokens: 1000, use: { in: 800, out: 200, cached: 124000 } }, { agent: 'x', kind: null, tier: null, model: 'm', tokens: 2 }],
    tiers: [{ tier: 'fast', models: ['claude-haiku-5-5'], tokens: 1000, use: { in: 800, out: 200, cached: 124000 }, parts: 1 }],
  });
  assert.deepEqual(rows.map(([k]) => k), ['Lead', 'Running and recording', 'Other part', 'Fast, in all']);
  assert.equal(rows[1][1], `${(800).toLocaleString()} new · 200 written · ${(124000).toLocaleString()} cached · claude-haiku-5-5`, 'the tokens first, cache reads apart');
  assert.equal(rows[2][1], '2 tokens · m', 'an older computer: one number');
  assert.equal(rows[3][1], `1 part · ${(800).toLocaleString()} new · 200 written · ${(124000).toLocaleString()} cached · claude-haiku-5-5`);
});

test('the card is readable in the rail and below it: rows wrap, carry their full text, and open in a sheet from the menu', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { byClass } = await import('../chat/fakedom.mjs');
  const WEB = path.join(import.meta.dirname, '..', '..', 'web');
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ lead: null, parts: [{ agent: 'hoprig-coder', kind: 'Writing and reviewing code', tier: 'strong', model: 'claude-sonnet-4-5-20250929', tokens: 7500, use: { in: 5000, out: 2500, cached: 120000 } }], tiers: [] }) });
  const { partsCard } = await import('../../web/chat/parts.js');
  const card = partsCard({ A: '/api/chats/x' });
  await card.load({ lead: true });
  const dd = byClass(card.el, 'chat-parts-rows')[0].children.filter((c) => c.tag === 'dd');
  assert.ok(dd.length >= 1);
  assert.match(dd[0].getAttribute('title') || dd[0].title, /claude-sonnet-4-5-20250929/, 'the full text as its title');
  const css = fs.readFileSync(path.join(WEB, 'chat', 'rail.css'), 'utf8');
  assert.match(css, /\.chat-parts-rows dd \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/, 'the model wraps, never cut');
  const { moreItems } = await import('../../web/chat/header.js');
  const v = { engine: { id: 'claude' }, caps: {}, tasks: [] };
  assert.ok(moreItems({ ...v, lead: true }).some((i) => i.value === 'parts' && i.label === 'Who did what'), 'in the ⋮ menu, at every width');
  assert.ok(!moreItems(v).some((i) => i.value === 'parts'), 'not for a chat with Lead off');
  assert.match(fs.readFileSync(path.join(WEB, 'chat', 'page.js'), 'utf8'), /parts: \(\) => partsSheet\(A\)/);
  // The chat says Lead is on or off, with its line, and turns it from the chip.
  const composer = fs.readFileSync(path.join(WEB, 'chat', 'composer.js'), 'utf8');
  assert.match(composer, /api\(`\$\{o\.A\}\/settings`, \{ lead: !v\.lead \}\)/);
  assert.match(composer, /fill\(leadWord, v\.lead \? 'on' : 'off'\)/);
});
