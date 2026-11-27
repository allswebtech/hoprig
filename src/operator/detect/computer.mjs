// A linked computer that has not answered for 5 minutes. Nothing is done on the other computer: the relay tries its
// link again by itself, and the owner gets one row that says so.
//
// Reads board.computers[]: { name, online: true | false | null, offlineSince } (offlineSince: when this computer's
// answers stopped, kept by the source). A computer whose state is not known (online null) says nothing.

import { act, makeItem } from '../item.mjs';
import { ms, span } from './util.mjs';

export const OFFLINE_MS = 5 * 60_000;

export function detectComputer(board, { now = Date.now(), afterMs = OFFLINE_MS } = {}) {
  const out = [];
  for (const c of board.computers ?? []) {
    if (c.online !== false) continue;
    const since = ms(c.offlineSince);
    if (since == null || now - since < afterMs) continue;
    out.push(makeItem({
      kind: 'machine',
      cls: 'machine',
      subject: `computer ${c.name}`,
      since,
      state: ['offline'],
      facts: [`computer ${c.name} has not answered for ${span(now - since)}`, 'the link tries again by itself; nothing is done on that computer'],
      acts: [act('open', { href: '#/computers', label: 'Open Computers' })],
      why: 'Look at that computer: it may be off, asleep or away from the network.',
      target: { computer: c.name },
    }));
  }
  return out;
}
