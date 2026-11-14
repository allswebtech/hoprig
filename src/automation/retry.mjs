// Retry: when a reply ends in an API error that is worth trying again (the server failed, was overloaded, or the
// connection broke), wait 1 minute, then 2, then 4 … and send the continue message, at most `max` times in a row.
// Then stop and tell the owner. A finished reply resets the count.
//
// Never for a usage limit or credit (Auto-switch handles those), a login problem (only the owner can fix it), or
// a request Claude Code itself got wrong (sending it again fails the same way).
//
// Claude Code's StopFailure hook names the error. The kinds (Claude Code 2.1.x): rate_limit, overloaded,
// authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required, billing_error,
// invalid_request, model_not_found, server_error, max_output_tokens, cloud_credential_error, unknown.
// A dropped connection arrives as "unknown".
//
// Stored per session: { attempts, handled (failure.at acted on), sentAt, toldFor (failure.at we gave up on) }
import { atLimit, busy } from './cards.mjs';

export const RETRY_KINDS = new Set(['server_error', 'overloaded', 'unknown']);

/** When the next retry of a session is due, for a tick that wants to wake up in time. */
export const dueAt = (failureAt, attempts, firstMinutes) => failureAt + firstMinutes * 60_000 * 2 ** attempts;

/**
 * state: { cards, data, now, max, firstMinutes }. Returns { actions, data }.
 * Actions: { type: 'retry', session, attempt, error } | { type: 'give-up', session, attempts, error }.
 */
export function decide({ cards, data, now, max, firstMinutes }) {
  const next = {};
  const actions = [];
  for (const c of cards) {
    if (c.kind !== 'claude') continue;
    let st = { attempts: 0, ...((data && data[c.name]) || {}) };
    // A reply finished after our last retry: the trouble is over.
    if (st.sentAt && c.stopAt && c.stopAt > st.sentAt) st = { attempts: 0 };
    next[c.name] = st;
    const f = c.failure;
    if (!f || !RETRY_KINDS.has(f.error) || busy(c) || atLimit(c) || f.at === st.handled) continue;
    if (st.attempts >= max) {
      if (st.toldFor !== f.at) {
        actions.push({ type: 'give-up', session: c.name, attempts: st.attempts, error: f.error });
        st.toldFor = f.at;
      }
      continue;
    }
    if (now < dueAt(f.at, st.attempts, firstMinutes)) continue;
    st.attempts += 1;
    st.handled = f.at;
    st.sentAt = now;
    actions.push({ type: 'retry', session: c.name, attempt: st.attempts, error: f.error });
  }
  for (const k of Object.keys(next)) if (next[k].attempts === 0 && !next[k].toldFor) delete next[k];
  return { actions, data: next };
}

/** ctx: { deck.send(name, text), prompt, max, record(entry), notify(ev) }. */
export async function apply(actions, ctx) {
  for (const a of actions) {
    if (a.type === 'give-up') {
      ctx.record({ automation: 'retry', session: a.session, did: `stopped retrying after ${a.attempts} tries (${a.error})`, outcome: 'gave up' });
      ctx.notify({ title: `${a.session} keeps failing`, message: `The reply ended in an error (${a.error}) ${a.attempts} times in a row. Retrying stopped; please look.`, session: a.session });
      continue;
    }
    try {
      await ctx.deck.send(a.session, ctx.prompt);
      ctx.record({ automation: 'retry', session: a.session, did: `retry ${a.attempt} of ${ctx.max} after "${a.error}"`, outcome: 'ok' });
    } catch (e) {
      ctx.record({ automation: 'retry', session: a.session, did: `retry ${a.attempt} of ${ctx.max}`, outcome: `failed: ${e.message}` });
    }
  }
}
