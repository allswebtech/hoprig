// A question or an OK that waits for the owner, with how long it has waited. The answer stays his own typing:
// the only act is to open the session where the question is.
//
// Reads board.sessions[]: { name, provider, providerLabel, asks: ['main' | agent id | '?'], askType, askAt }.

import { act, makeItem } from '../item.mjs';
import { ms, openHref, providerName, span, subjectOf } from './util.mjs';

// What the owner gives: the session asked, he answers.
const WHAT = { permission: 'your OK', question: 'your answer to its question', plan: 'your OK on its plan' };

export function detectAsks(board, { now = Date.now() } = {}) {
  const out = [];
  for (const s of board.sessions ?? []) {
    if (!s.asks?.length) continue;
    const at = ms(s.askAt);
    const what = WHAT[s.askType] ?? 'your answer';
    const who = s.asks.map((a) => (a === 'main' ? 'the session' : a === '?' ? 'someone in it' : `agent ${a}`));
    const facts = [`${who.slice(0, 3).join(', ')} ${s.asks.length > 1 ? 'wait' : 'waits'} for ${what}`];
    if (at != null) facts.push(`waiting for ${span(now - at)}`);
    // Only an agent by its id holds up the work that started it; '?' (who asks is not known) is not said to be one.
    if (s.asks.some((a) => a !== 'main' && a !== '?')) facts.push('an agent that waits holds up the work that started it');
    if (s.provider) facts.push(`provider ${providerName(s.provider, s.providerLabel)}`);
    out.push(makeItem({
      kind: 'asks',
      cls: 'waits',
      subject: subjectOf(s),
      since: at,
      // When it asked is part of what it says: the next question of the same session is a new item, though its
      // facts read the same (how long it waits does not count).
      state: [s.asks, s.askType || null, at, s.provider || null],
      facts,
      acts: [act('open', { href: openHref(s), label: s.chatId ? 'Open the chat' : 'Open the session' })],
      recommended: 'open',
      why: `It goes on only after your answer; the answer is yours to type.`,
      target: { session: s.name },
    }));
  }
  return out;
}
