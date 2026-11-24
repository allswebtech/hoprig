// "Who did what" on a chat's page (Lead model): per part its kind, model and tokens, and one totals line per tier,
// from GET /api/chats/<id>/parts (Claude Code's own records). Shown only for a chat with Lead on, once a part ran.
import { api, fill, h, openSheet } from '../lib.js';

const TIER_WORD = { fast: 'Fast', strong: 'Strong', strongest: 'Strongest', other: 'Other' };
const num = (n) => Number(n || 0).toLocaleString();
const KIND_WORD = { runner: 'running and recording', coder: 'writing and reviewing code', thinker: 'hard thinking' };
const any = (r) => !!(r && ((r.parts && r.parts.length) || (r.others && r.others.length)));
/**
 * What a part used, the tokens first: new input, output, and cache reads apart (a cache read costs about a tenth of new
 * input, so one sum would make every tier look the same). An older computer sends one number only.
 */
const useWords = (x) => (x.use ? `${num(x.use.in)} new · ${num(x.use.out)} written · ${num(x.use.cached)} cached` : `${num(x.tokens)} tokens`);

/** The card's rows from the route's answer: pure, for the tests. → [[label, text]] */
export function partRows(r) {
  const rows = [];
  if (r.lead) rows.push(['Lead', `${useWords(r.lead)} · ${r.lead.model || '?'}`]);
  for (const p of r.parts) rows.push([p.kind || 'Other part', `${useWords(p)} · ${p.model || '?'}`]);
  for (const p of r.others || []) rows.push([`On ${p.provider}${p.kind ? ` (${KIND_WORD[p.kind] || p.kind})` : ''}`, `${p.use ? useWords(p) : `${num(p.tokens)} tokens`} · ${p.model || 'not started yet'}`]);
  for (const t of r.tiers) rows.push([`${TIER_WORD[t.tier] || t.tier}, in all`, `${t.parts} part${t.parts === 1 ? '' : 's'} · ${useWords(t)} · ${t.models.join(', ') || '?'}`]);
  return rows;
}

/**
 * The rows drawn: the kind, then its tokens and model on a line that wraps (a dated model id is long), with the whole
 * text as its title. The rail is narrow: nothing of it is cut off.
 */
const drawRows = (rows) => rows.flatMap(([k, x]) => [h('dt', k), h('dd', { title: `${k}: ${x}` }, x)]);

/** "Who did what" in a sheet: the same rows, at any width (below the rail's width the rail is not drawn). */
export async function partsSheet(A) {
  let rows = [];
  let failed = false;
  try {
    const r = await api(`${A}/parts`);
    rows = any(r) ? partRows(r) : [];
  } catch {
    failed = true;
  }
  openSheet({ title: 'Who did what', subtitle: 'Which model did each part of this session, with its tokens: new, written and read from the cache.' }, (close) => [
    rows.length ? h('dl.chat-rail-rows.chat-parts-rows', drawRows(rows)) : h('p.sheet-text', failed ? 'This computer cannot say it yet.' : 'No part was handed to a helper yet.'),
    h('div.sheet-actions', h('button.btn.primary', { type: 'button', onclick: () => close() }, 'Close')),
  ]);
}

/** o: { A (the chat's address) } → { el, load(state) } */
export function partsCard(o) {
  const body = h('dl.chat-rail-rows.chat-parts-rows');
  const el = h('section.chat-rcard.hidden', h('h2.chat-rcard-head', h('span', 'Who did what')), body);
  let asking = false;
  return {
    el,
    async load(v) {
      if (!v || !v.lead || asking) return void (v && !v.lead && el.classList.add('hidden'));
      asking = true;
      try {
        const r = await api(`${o.A}/parts`);
        const rows = any(r) ? partRows(r) : [];
        el.classList.toggle('hidden', !rows.length);
        fill(body, drawRows(rows));
      } catch {
        el.classList.add('hidden'); // an older computer without the route
      } finally {
        asking = false;
      }
    },
  };
}
