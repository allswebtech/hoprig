// A provider stopped a session's work, or the work of an agent inside it, in a way that is not a usage limit (that is
// the `limit` item): a model name the endpoint refuses, a sign-in that is gone, an endpoint that does not answer, an
// overload or server error past the tool's retries, the provider's own refusal, an input the model does not take, or
// another provider error. One item per session; each stopped agent is a fact. The name comes from the closed table
// (src/providers/table.mjs), and the one step is an act the product already has.
//
// Reads board.sessions[]: { name, provider, providerLabel, state, stop: { at, reason, text } | null, agents: [{ id, label, stop }] }
// and board.gateways[]: { name, users } (the gateway a session's provider goes through, for "Restart the gateway"),
// and board.providers[]: { name, checkable, check: { at, gaps: [{ name, mend }] } } (the provider check's last result).

import { REASONS } from '../../providers/table.mjs';
import { act, makeItem } from '../item.mjs';
import { cut, ms, openHref, openLabel, providerName, span, subjectOf } from './util.mjs';

// An agent's stop stays on the list for a day: the step it lost is not done again by itself.
export const AGENT_STOP_MS = 24 * 3600_000;
// The versions tried in turn until the item keeps its reason and every fact whole (detectProviderStop): how much of the
// tool's own words it quotes, how long an agent's label may be, how many stops are named one by one (the rest are
// counted) and whether the provider line is kept. What gives way first is what the session itself still shows: the
// tool's words, then how many are named, then the provider line; an agent's label, who stopped, is cut last.
const FITS = [
  [90, 40, 3, true], [64, 40, 2, true], [40, 40, 1, true], [0, 40, 1, true], [0, 40, 1, false],
  [0, 24, 1, false], [0, 16, 1, false],
];
// The model name the tool's line names as refused: the quoted one ("Ambiguous model 'x'"), else the one in parentheses
// ("an issue with the selected model (x)"), else Claude's API's "model: x". Null when none is named.
const REFUSED = [/model\s+['"`]([^'"`\s]{1,120})['"`]/i, /selected model\s*\(([^)\s]{1,120})\)/i, /\bmodel:\s*([A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119})/];
export function refusedName(text) {
  for (const re of REFUSED) {
    const m = re.exec(String(text || ''));
    if (m) return m[1];
  }
  return null;
}

// What the owner reads first: why it stopped and what the step does.
const WHY = {
  auth: 'Sign in again on the Providers page, then continue the session.',
  // At most 80 characters: an item that is too big has its reason cut to that first (item.mjs fit).
  model: 'Add a combo of this name at the gateway, or choose a model the endpoint lists.',
  input: 'Continue without that input, or with another model.',
  refusal: "The provider's own check refused it. Hoprig does not send it again or elsewhere.",
  'no-answer': 'A restart brings back a gateway that hangs.',
  server: 'Continue the session when the provider answers again.',
  'provider-error': 'Read its words in the session.',
};

// The reason of a model-name item from the check's gap: its whole line when it fits (an item's reason is cut at 160
// characters), else the combo and where the MODELS line is, with the switch it needs while that is off.
const WHY_ROOM = 158;
function mendWhy(gap) {
  const whole = `${gap.mend}.`;
  if (whole.length <= WHY_ROOM || !gap.combo) return whole;
  if (!gap.models) return `${gap.combo}.`;
  return gap.off ? `${gap.combo}, or use the MODELS line on its page with its map turned on for sessions.` : `${gap.combo}, or use the MODELS line on its page.`;
}

export function detectProviderStop(board, { now = Date.now() } = {}) {
  const out = [];
  for (const s of board.sessions ?? []) {
    const stops = [];
    if (s.stop && s.stop.reason !== 'limit') stops.push({ who: null, ...s.stop });
    for (const a of s.agents ?? []) {
      const at = ms(a.stop?.at);
      if (a.stop && a.stop.reason !== 'limit' && at != null && now - at <= AGENT_STOP_MS) stops.push({ who: a, ...a.stop });
    }
    if (!stops.length) continue;
    const first = stops[0];
    // A gateway lists its users as the pages call them (a profile's label, else its name, cut to 40 characters).
    const own = [s.provider, s.providerLabel].filter(Boolean).map((n) => String(n).slice(0, 40));
    const gateway = (board.gateways ?? []).find((g) => Array.isArray(g.users) && own.some((n) => g.users.includes(n)));
    // Who stopped and why, and the tool's own words for the first stop. Shorter versions are tried in turn (the words,
    // the labels, how many are named) until the item fits its size (item.mjs ITEM_BYTES) with its reason whole: the
    // fitting there would cut the reason first, and the reason is the step the owner needs.
    const factsOf = (says, label, shown, provider) => {
      const facts = [];
      stops.slice(0, shown).forEach((x, i) => {
        const who = x.who ? (x.who.label ? `agent "${cut(x.who.label, label)}"` : `agent ${x.who.id}`) : x.either ? 'the session, or an agent in it,' : 'the session';
        const at = ms(x.at);
        facts.push(`${who} stopped: ${REASONS[x.reason]?.words || 'a provider error'}${at != null ? `, ${span(now - at)} ago` : ''}`);
        if (i === 0 && x.text && says) facts.push(`it says: ${cut(x.text, says)}`);
      });
      if (stops.length > shown) facts.push(`${stops.length - shown} more agent${stops.length > shown + 1 ? 's' : ''} stopped too`);
      // The case that was found hours later: the session looks fine, but a step of it never ran.
      if (!s.stop && s.state !== 'ended') facts.push('the session goes on, but a step of it was lost');
      // A session Hoprig did not start: which provider it ran on is not known here, and "unknown" would say nothing.
      if (provider && !s.outside) facts.push(`provider ${providerName(s.provider, s.providerLabel)}`);
      return facts;
    };
    const openSession = act('open', { href: openHref(s), label: openLabel(s) });
    // The provider check (providers/check.mjs) on its page, where the press stays the owner's; its last gap names the mend.
    // Only the gap of the very name that stopped this session: another gap's mend would mend another name.
    const refused = refusedName(first.text);
    const gapIn = (p) => (refused ? p?.check?.gaps?.find((g) => !g.picture && g.name === refused) || null : null);
    // A session Hoprig did not start names no provider: the one checked provider whose last check refused that very
    // name is taken, and only when it is the only one; otherwise which provider ran it is not known here.
    const holders = s.outside ? (board.providers ?? []).filter((p) => gapIn(p)) : [];
    const prov = s.outside ? (holders.length === 1 ? holders[0] : null) : (board.providers ?? []).find((p) => p.name === s.provider);
    const gap = gapIn(prov);
    const provName = s.outside ? prov?.name : s.provider;
    // One step, an act the product has; the session can always be opened from its own page.
    const step = REASONS[first.reason]?.step;
    let acts = [openSession];
    if (step === 'signin') acts = [act('open', { href: '#/providers', label: 'Open Providers to sign in' })];
    else if (step === 'name' && s.outside) acts = prov ? [act('open', { href: `#/providers/${encodeURIComponent(provName)}`, label: 'Check this provider' })] : [openSession];
    else if (step === 'name') acts = [openSession, prov?.checkable ? act('open', { href: `#/providers/${encodeURIComponent(provName)}`, label: 'Check this provider' }) : act('open', { href: '#/providers', label: 'See this provider' })];
    else if (step === 'gateway' && gateway) acts = ['restart-gateway', openSession];
    const why = first.reason === 'no-answer' && !gateway ? 'The endpoint did not answer; continue the session when it answers again.'
      : first.reason === 'model' && gap ? mendWhy(gap)
        : first.reason === 'model' && s.outside ? 'Which provider ran it is not known here: check the providers it may use.'
          : first.reason === 'model' && prov?.checkable ? 'Check this provider: it finds each name the endpoint refuses and the line that mends it.' : WHY[first.reason] || WHY['provider-error'];
    const make = (facts) => makeItem({
      kind: 'providerstop',
      cls: 'stopped',
      subject: subjectOf(s),
      since: stops.map((x) => ms(x.at)).filter((t) => t != null).sort((a, b) => a - b)[0] ?? null,
      // Each stop with its time: a later stop of the same session is a new item, also after "Not now".
      state: [stops.map((x) => [x.who?.id || 'main', ms(x.at), x.reason, x.text || null]), s.provider || null, gateway?.name || null],
      facts,
      acts,
      recommended: typeof acts[0] === 'string' ? acts[0] : 'open',
      why,
      target: { session: s.name, addon: gateway?.name || null },
    });
    let item = null;
    for (const [says, label, shown, provider] of FITS) {
      const facts = factsOf(says, label, shown, provider);
      item = make(facts);
      // Kept as written: the reason, and every fact (who stopped, why and when), none cut by the fitting.
      if (item.why === why && item.facts.length === facts.length && item.facts.every((f, i) => f === facts[i])) break;
    }
    out.push(item);
  }
  return out;
}
