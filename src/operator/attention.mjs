// The attention list: every detector over one board, ranked. An item the owner put off with "Not now" stays
// hidden while what it says is the same (its rev); when its facts change it comes back by itself.

import { KINDS, actCatalog, publicItem, rank } from './item.mjs';
import { detectAsks } from './detect/asks.mjs';
import { detectAutomation } from './detect/automation.mjs';
import { detectEnded } from './detect/ended.mjs';
import { detectLeftover } from './detect/leftover.mjs';
import { detectLimit } from './detect/limit.mjs';
import { detectLive } from './detect/live.mjs';
import { detectMachine } from './detect/machine.mjs';
import { detectProvider } from './detect/provider.mjs';
import { detectProviderStop } from './detect/providerstop.mjs';
import { detectRepo } from './detect/repo.mjs';
import { detectStuck } from './detect/stuck.mjs';
import { detectUnknown } from './detect/unknown.mjs';

/** The sources each kind's detector reads: a put-off item is forgotten only when these were read on that look. */
export const KIND_SOURCES = Object.freeze({
  limit: ['sessions'], stuck: ['sessions'], asks: ['sessions'], ended: ['sessions', 'work'], provider: ['providers', 'gateways'],
  machine: ['machine'], leftover: ['leftovers'], repo: ['repos'], live: ['live'], automation: ['changes'], providerstop: ['sessions', 'gateways', 'providers'],
  unknown: ['work'],
});

export const DETECTORS = Object.freeze({
  limit: detectLimit, stuck: detectStuck, asks: detectAsks, ended: detectEnded, provider: detectProvider,
  machine: detectMachine, leftover: detectLeftover, repo: detectRepo, live: detectLive, automation: detectAutomation,
  providerstop: detectProviderStop, unknown: detectUnknown,
});

/**
 * All items of a board, ranked (with their server-side targets). `dismissed` maps an item's id to the rev it had
 * when it was put off. A detector that throws on odd input does not hide the others: it becomes its own note.
 */
export function attention(board, { now = Date.now(), dismissed = new Map(), decorate = null } = {}) {
  const all = [];
  const broken = [];
  for (const kind of KINDS) {
    try { all.push(...DETECTORS[kind](board, { now })); } catch (e) { broken.push({ kind, error: String(e?.message || e).slice(0, 120) }); }
  }
  // One card per run: a failed run that the kind unknown reports (with its look's finding) is not also an ended card.
  const told = new Set(all.filter((i) => i.kind === 'unknown').flatMap((i) => [i.target?.run, ...(i.target?.runs || [])]).filter(Boolean));
  const one = all.filter((i) => !(i.kind === 'ended' && i.target?.run && told.has(i.target.run)));
  // `decorate`: the prepared steps of a decision (decide-table.mjs), added before "Not now" compares a rev.
  const items = decorate ? decorate(one) : one;
  const shown = [];
  let hidden = 0;
  for (const it of rank(items)) {
    if (dismissed.get(it.id) === it.rev) hidden++;
    else shown.push(it);
  }
  // `present`: every item there is now, shown or put off; a put-off item that is gone is forgotten (feature.mjs), so
  // the same thing coming back later is shown again.
  return { at: board.at, items: shown, hidden, broken, present: new Set(items.map((i) => i.id)) };
}

/** The most a list may weigh: 8 KB for every 20 items it shows. */
export const LIST_BYTES_PER_20 = 8 * 1024;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Keeps a list within its budget: when it is too heavy, the reasons and facts get shorter step by step, from the
 * lowest-ranked item upward, so the first items, which matter most, stay whole longest. A subject is never cut: it is
 * what tells two items apart. When even the shortest form is too heavy, the last items go to `more`. The list says
 * `shortened` so the reader knows there is more to see. Ids, revs and acts are never touched: a tap made from a
 * shortened list is the same tap.
 */
function fitList(out, budget) {
  const weight = () => Buffer.byteLength(JSON.stringify(out));
  if (weight() <= budget) return;
  out.shortened = true;
  const shorten = (from, to) => {
    for (let i = from; i >= to; i--) {
      const it = out.items[i];
      for (const n of [80, 60, 40, 30, 24]) {
        it.why = clip(it.why, n);
        it.facts = it.facts.slice(0, n <= 24 ? 2 : n <= 40 ? 3 : 8).map((f) => clip(f, n));
        if (weight() <= budget) return true;
      }
    }
    return false;
  };
  if (shorten(out.items.length - 1, FIRST_WHOLE)) return;
  while (out.items.length > FIRST_WHOLE && weight() > budget) {
    out.items.pop();
    out.more = (out.more || 0) + 1;
  }
  if (weight() > budget) shorten(Math.min(FIRST_WHOLE, out.items.length) - 1, 0);
}

// The first items of a list are what the owner (or a small model) acts on: they are cut last.
const FIRST_WHOLE = 3;

/** The list as the page gets it: at most `limit` items, without the server-side targets, within its budget. */
export function publicAttention(list, { limit = 50 } = {}) {
  const items = list.items.slice(0, limit);
  // How many of each kind the whole list holds: a reader of the first items knows which kind to ask for.
  const kinds = {};
  for (const it of list.items) kinds[it.kind] = (kinds[it.kind] || 0) + 1;
  // `needs`: the items that are more than information (the navigation badge counts these).
  const needs = list.items.filter((i) => i.class !== 'info').length;
  const out = { at: list.at, count: list.items.length, needs, kinds, items: items.map(publicItem), acts: actCatalog(items), hidden: list.hidden };
  if (list.items.length > limit) out.more = list.items.length - limit;
  if (list.broken.length) out.broken = list.broken;
  fitList(out, Math.max(1, Math.ceil(items.length / 20)) * LIST_BYTES_PER_20);
  return out;
}
