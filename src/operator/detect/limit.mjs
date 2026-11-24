// A session, or an agent inside one, that stopped at a usage limit: the run record's limit or the screen's limit
// line (both already folded into `session.limit` by the board).
//
// Reads board.sessions[]: { name, provider, limit: { at, text, resetsAt } | null, canSwitch, nextProvider,
// agents: [{ id, limit }] }.

import { act, makeItem } from '../item.mjs';
import { clock, openHref, openLabel, providerName, span, ms, subjectOf } from './util.mjs';

export function detectLimit(board, { now = Date.now() } = {}) {
  const out = [];
  for (const s of board.sessions ?? []) {
    const stopped = s.limit ? [{ who: 'main', limit: s.limit }] : [];
    for (const a of s.agents ?? []) if (a.limit) stopped.push({ who: a.id, label: a.label || '', limit: a.limit });
    if (!stopped.length) continue;
    const first = stopped.map((x) => ms(x.limit.at)).filter((t) => t != null).sort((a, b) => a - b)[0] ?? null;
    const facts = s.outside ? [] : [`provider ${providerName(s.provider, s.providerLabel)}`];
    for (const x of stopped.slice(0, 3)) {
      const who = x.who === 'main' ? 'the session' : x.label ? `agent "${x.label}"` : `agent ${x.who}`;
      const at = ms(x.limit.at);
      facts.push(`${who} stopped at a usage limit${at != null ? ` ${span(now - at)} ago` : ''}`);
      if (x.limit.text) facts.push(`it says: ${x.limit.text}`);
    }
    const reset = stopped.map((x) => x.limit.resetsAt).find(Boolean);
    if (reset) facts.push(`the limit resets at ${clock(reset, now)}`);
    const canMove = s.canSwitch && s.nextProvider && s.nextProvider !== s.provider;
    const next = canMove ? providerName(s.nextProvider, s.nextProviderLabel) : null;
    if (canMove) facts.push(`next provider in the order: ${next}`);
    // A chat is opened by its own address and is not ended from here: its own page stops it. A session Hoprig did not
    // start is not ended from here either.
    const open = act('open', { href: openHref(s), label: openLabel(s) });
    const acts = [...(canMove ? ['switch'] : []), open, ...(s.chatId || s.outside ? [] : ['stop'])];
    // "Wait until" only for a time the tool or the provider named (the board's resetsAt); never guessed.
    const wait = reset ? `, or wait until ${clock(reset, now)}` : '';
    out.push(makeItem({
      kind: 'limit',
      cls: 'stopped',
      subject: subjectOf(s),
      since: first,
      // Each stop with its time: a later stop of the same session at a limit is a new item.
      state: [stopped.map((x) => [x.who, ms(x.limit.at), x.limit.text || null]), reset || null, canMove ? s.nextProvider : null, s.provider || null],
      facts,
      acts,
      recommended: canMove ? 'switch' : 'open',
      why: canMove ? `The work waits for the limit; ${next} can go on with it now${wait}.` : reset ? `No other provider can take it over here; wait until ${clock(reset, now)}.` : 'No other provider can take it over here; look at it.',
      // `hook`: the session's own run record states the limit (not only its screen): what a rule may act on.
      target: { session: s.name, to: canMove ? s.nextProvider : null, hook: s.limit?.source === 'hook', ...(s.mission === true ? { mission: true } : {}) },
    }));
  }
  return out;
}
