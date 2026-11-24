// A session that says it works but has made no progress for a while (20 minutes by default): its run record and
// its conversation file have not changed (`progressAt`, the later of the two, kept by the board). A tool call
// that runs that long is named by its tool; its input is never shown.
//
// A session that started a workflow or background agents counts their transcripts as its progress (the board does
// that); when they are quiet too, the item says that they run, so the owner does not stop work that only waits.
//
// Reads board.sessions[]: { name, state, progressAt, background: n, toolNow: { name, since } | null, limit, asks, provider,
// providerLabel }.

import { act, makeItem } from '../item.mjs';
import { ms, providerName, sessionHref, span } from './util.mjs';

export const STUCK_MS = 20 * 60_000;

export function detectStuck(board, { now = Date.now(), stuckMs = STUCK_MS } = {}) {
  const out = [];
  for (const s of board.sessions ?? []) {
    // A limit or a question is its own item: the session waits for a reason that is already said.
    if (s.state !== 'working' || s.limit || s.asks?.length) continue;
    const at = ms(s.progressAt);
    if (at == null || now - at < stuckMs) continue;
    const bg = Number.isInteger(s.background) && s.background > 0 ? s.background : 0;
    const facts = [`working, with no progress for ${span(now - at)}`, bg ? `${bg} background task${bg > 1 ? 's' : ''} run${bg > 1 ? '' : 's'}, quiet too` : 'its run record and conversation have not changed'];
    const tool = s.toolNow?.name;
    const toolAt = ms(s.toolNow?.since);
    if (tool) facts.push(`one ${tool} call has run for ${toolAt != null ? span(now - toolAt) : 'a long time'}`);
    if (s.provider) facts.push(`provider ${providerName(s.provider, s.providerLabel)}`);
    out.push(makeItem({
      kind: 'stuck',
      cls: 'stopped',
      subject: `session ${s.name}`,
      since: at,
      facts,
      acts: [act('open', { href: sessionHref(s.name), label: 'Open the session' }), 'stop'],
      recommended: 'open',
      why: tool ? `A ${tool} call that runs this long often waits for something that never comes; look at its screen.` : 'Look at its screen before stopping it.',
      target: { session: s.name },
    }));
  }
  return out;
}
