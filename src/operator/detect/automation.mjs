// A change the product's own automation made to the owner's data since his last look at the Operator page: for
// example the upkeep's commit in the brain or a workspace map rewritten by a sync. He sees what it did and can
// open the commit.
//
// Reads board.changes[]: { where, commit, at, by, files: n, subject } and board.lastLook (when the owner last
// opened the panel). A commit's subject is its first line, cut short; its content is never on the board.

import { act, makeItem } from '../item.mjs';
import { clock, ms } from './util.mjs';

export function detectAutomation(board, { now = Date.now() } = {}) {
  const look = ms(board.lastLook) ?? 0;
  const out = [];
  for (const c of board.changes ?? []) {
    const at = ms(c.at);
    if (at == null || at <= look || !/^[0-9a-f]{7,40}$/.test(c.commit ?? '')) continue;
    out.push(makeItem({
      kind: 'automation',
      cls: 'info',
      subject: `${c.where} commit ${c.commit.slice(0, 7)}`,
      since: at,
      // The commit is the thing: its clock time turns into a date after a while, which is no change.
      state: [c.where, c.commit, c.subject || null, Number.isInteger(c.files) ? c.files : null],
      facts: [`${c.by || 'an automation'} changed ${c.where} at ${clock(at, now)}`, c.subject ? `its message: ${c.subject}` : null, Number.isInteger(c.files) ? `${c.files} file${c.files === 1 ? '' : 's'} changed` : null],
      acts: [act('open-commit', { href: `#/code?repo=${encodeURIComponent(c.where)}&commit=${c.commit}` })],
      why: 'It changed your data without you; see that it did the right thing.',
      target: { where: c.where, commit: c.commit },
    }));
  }
  return out;
}
