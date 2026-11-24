// What nobody can explain yet: a Work run that failed with a reason no detector knows, a task whose runs ended in an
// error twice, and a mission's check that failed the same way after a fix. Each is an item of the kind `unknown`: the
// owner's to read, and the one kind Tia may start a look into (src/operator/look.mjs), when he switched that on.
//
// Reads board.work.runs[]: { id, item, title, state, endedAt, reason, project, by } and board.work.checks[]: { mission,
// task, title, project, words, at, run } (sources.mjs). A look's own run is never one of them.

import { act, makeItem } from '../item.mjs';
import { ms, span } from './util.mjs';

export const UNKNOWN_WINDOW_MS = 24 * 3600_000;

// The reasons the product says itself, or another detector already explains: a usage limit, a provider that refused,
// a sign-in, a run that did not start, the time limit, the restricted mode, a refused step, a dashboard that stopped.
export const KNOWN = Object.freeze([
  /usage limit|rate.?limit|\b429\b|overloaded|\b529\b/i,
  /did not start|never said which tools|restricted/i,
  /time limit|was stopped|dashboard stopped|stopped while/i,
  /needed an OK and was refused/i,
  /sign(?:ed)? ?in|log ?in|authenticat|\b401\b|\b403\b|credit|billing|budget/i,
]);
// Only the reason's first 80 characters are read, as when the source kept no more: a stack trace further on names
// files (src/billing.mjs) and words (credit, restricted) that say nothing about why the run ended.
const EXPLAINED_SPAN = 80;
export const explained = (reason) => KNOWN.some((re) => re.test(String(reason || '').slice(0, EXPLAINED_SPAN)));

export function detectUnknown(board, { now = Date.now(), windowMs = UNKNOWN_WINDOW_MS } = {}) {
  const out = [];
  const recent = (board.work?.runs ?? []).filter((r) => r && r.by !== 'look' && r.state === 'failed' && ms(r.endedAt) != null && now - ms(r.endedAt) <= windowMs);
  const open = { href: '#/work/activity', label: 'Open the runs' };
  // Two failed runs of one task: the newest first.
  const byItem = new Map();
  for (const r of [...recent].sort((a, b) => ms(b.endedAt) - ms(a.endedAt))) {
    if (typeof r.item !== 'string' || !r.item) continue;
    if (!byItem.has(r.item)) byItem.set(r.item, []);
    byItem.get(r.item).push(r);
  }
  const twice = new Set();
  for (const [item, list] of byItem) {
    if (list.length < 2) continue;
    const [last, prev] = list;
    twice.add(last.id).add(prev.id);
    out.push(makeItem({
      kind: 'unknown', cls: 'stopped', subject: `task ${item}`, since: ms(last.endedAt),
      facts: [`"${last.title}" ended in an error twice, the last ${span(now - ms(last.endedAt))} ago`, last.project ? `project ${last.project}` : null, last.reason ? `last reason: ${last.reason}` : null, prev.reason && prev.reason !== last.reason ? `before: ${prev.reason}` : null],
      acts: [act('open', open)],
      why: 'It failed twice, and nothing here says why.',
      target: { case: 'twice', run: last.id, runs: [last.id, prev.id], item, project: last.project || null },
    }));
  }
  for (const r of recent) {
    if (twice.has(r.id) || explained(r.reason)) continue;
    out.push(makeItem({
      kind: 'unknown', cls: 'stopped', subject: `Work run ${r.id}`, since: ms(r.endedAt),
      facts: [`"${r.title}" failed ${span(now - ms(r.endedAt))} ago`, r.project ? `project ${r.project}` : null, r.reason ? `reason: ${r.reason}` : 'no reason was given'],
      acts: [act('open', open)],
      why: 'It failed for a reason no check of Hoprig knows.',
      target: { case: 'reason', run: r.id, item: r.item || null, project: r.project || null },
    }));
  }
  for (const c of board.work?.checks ?? []) {
    const at = ms(c.at);
    if (!c || at == null || now - at > windowMs || !Array.isArray(c.words) || !c.words.length) continue;
    out.push(makeItem({
      kind: 'unknown', cls: 'stopped', subject: `check of task ${c.task} in mission ${c.mission}`, since: at,
      facts: [`"${c.title}": its check failed the same way after a fix`, c.project ? `project ${c.project}` : null, `it said: ${c.words[0]}`],
      acts: [act('open', { href: '#/work', label: 'Open the mission' })],
      why: 'The fix did not change what the check says.',
      target: { case: 'check', run: c.run || null, item: c.task, mission: c.mission, project: c.project || null, words: c.words.slice(0, 5) },
    }));
  }
  return out;
}
