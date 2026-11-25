// "Who did what" on the Work page (web/workdo.js whoDidWhat, web/workplans.js planPartsCard): a task run's card and a
// plan's card draw the chat page's own rows (web/chat/parts.js partRows), with a small stand-in for the browser DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
const { byClass, texts } = await import('../chat/fakedom.mjs');
const { partRows } = await import('../../web/chat/parts.js');
const { runCard, whoDidWhat } = await import('../../web/workdo.js');
const { planPartsCard, taskModelsText } = await import('../../web/workplans.js');
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const use = (i, o, c) => ({ in: i, out: o, cached: c });
const card = {
  lead: { model: 'claude-opus-5-5', tokens: 110, use: use(50, 60, 9000) },
  parts: [
    { kind: 'Running and recording', tier: 'fast', model: 'claude-haiku-5-5', tokens: 120, use: use(100, 20, 0) },
    { kind: 'Writing and reviewing code', tier: 'strong', model: 'claude-sonnet-5-5', tokens: 390, use: use(300, 90, 0) },
  ],
  tiers: [
    { tier: 'fast', models: ['claude-haiku-5-5'], tokens: 120, use: use(100, 20, 0), parts: 1 },
    { tier: 'strong', models: ['claude-sonnet-5-5'], tokens: 390, use: use(300, 90, 0), parts: 1 },
  ],
};
/** The [label, text] pairs a <dl> of the card draws, in order. */
const drawn = (el) => {
  const dl = byClass(el, 'chat-parts-rows')[0];
  assert.ok(dl, 'the chat page\'s rows');
  const out = [];
  for (let i = 0; i < dl.children.length; i += 2) out.push([texts(dl.children[i]).join(''), texts(dl.children[i + 1]).join('')]);
  return out;
};
const run = (x = {}) => ({
  id: '20261117-100000-aaaaaaaa', item: 'renew', title: 'Renew', startedAt: '2026-11-17T10:00:00.000Z', endedAt: '2026-11-17T10:20:00.000Z', project: 'shop', folder: '.',
  tool: 'claude', provider: 'sub', providerLabel: 'Main', model: null, session: null, state: 'done', reason: null, answer: '', commits: [], changed: [], more: 0, ...x,
});

test('a task run\'s card draws the chat page\'s rows: the lead, each part with its kind, model and tokens, each tier', () => {
  const el = whoDidWhat(card);
  const want = partRows(card);
  assert.deepEqual(drawn(el), want);
  assert.deepEqual(want.map(([k]) => k), ['Lead', 'Running and recording', 'Writing and reviewing code', 'Fast, in all', 'Strong, in all']);
  assert.match(want[0][1], /50 new · 60 written · 9,000 cached · claude-opus-5-5/);
  // Under its heading, which opens and closes it: open where there is room, closed where space is short.
  assert.equal(el.tag, 'details');
  assert.equal(texts(el.children[0]).join(''), 'Who did what');
  assert.equal('open' in el.attrs, true);
  assert.equal('open' in whoDidWhat(card, { open: false }).attrs, false);
  // In the run's card itself, and nothing for a run without helpers.
  assert.deepEqual(drawn(byClass(runCard(run({ parts: card })), 'wk-run-parts')[0]), want);
  assert.equal(byClass(runCard(run()), 'wk-run-parts').length, 0);
});

test('a phone: the run\'s card starts closed', () => {
  const had = globalThis.matchMedia;
  globalThis.matchMedia = (q) => ({ matches: q === '(max-width: 599px)' });
  try {
    const el = whoDidWhat(card);
    assert.equal(el.tag, 'details', 'a heading that opens it');
    assert.equal('open' in el.attrs, false);
  } finally {
    if (had) globalThis.matchMedia = had;
    else delete globalThis.matchMedia;
  }
});

test('a run\'s card the owner opened or closed stays so when the page draws it again (it does while a session works)', () => {
  const first = whoDidWhat(card, { key: 'run-a' });
  assert.equal('open' in first.attrs, true, 'open on a wide screen');
  first.open = false;
  first.listeners.toggle();
  assert.equal('open' in whoDidWhat(card, { key: 'run-a' }).attrs, false, 'closed by him: closed when drawn again');
  assert.equal('open' in whoDidWhat(card, { key: 'run-b' }).attrs, true, 'another run keeps its own');
  // The run's card passes its run id.
  const drawnCard = byClass(runCard(run({ id: '20261117-100000-bbbbbbbb', parts: card })), 'wk-run-parts')[0];
  drawnCard.open = false;
  drawnCard.listeners.toggle();
  assert.equal(byClass(runCard(run({ id: '20261117-100000-bbbbbbbb', parts: card })), 'wk-run-parts')[0].attrs.open, undefined);
});

test('a plan\'s card draws the chat page\'s tier rows of its runs, and per task the models that worked on it', () => {
  const parts = { lead: null, parts: [], tiers: card.tiers, tasks: [
    { id: 'shrink-images', title: 'Shrink the images', models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], runs: 2 },
    { id: 'cache-pages', title: 'Cache the pages', models: ['claude-opus-5-5'], runs: 1 },
  ] };
  const el = planPartsCard(parts);
  assert.ok(el);
  assert.equal(texts(el).includes('Who did what'), true);
  assert.deepEqual(drawn(el), partRows(parts));
  assert.deepEqual(partRows(parts).map(([k]) => k), ['Fast, in all', 'Strong, in all']);
  const lines = byClass(el, 'wk-plan-models')[0].children.map((li) => texts(li).join(''));
  assert.deepEqual(lines, ['Shrink the images · claude-sonnet-5-5, claude-haiku-5-5 · 2 runs', 'Cache the pages · claude-opus-5-5 · 1 run']);
  assert.equal(taskModelsText({ models: [], runs: 1 }), '? · 1 run');
  // A plan without any helper run: nothing is drawn.
  assert.equal(planPartsCard(undefined), null);
  assert.equal(planPartsCard({ lead: null, parts: [], tiers: [], tasks: [] }), null);
});

test('the card\'s rule sits beside the run\'s rules, and the page loads the chat page\'s rows rule', () => {
  const css = fs.readFileSync(path.join(WEB, 'page-work.css'), 'utf8');
  assert.match(css, /\.wk-run-title \{[^}]*\}\n\/\*[^\n]*\*\/\n\.wk-run-parts \{/);
  assert.match(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), /href="chat\/rail\.css"/);
});
