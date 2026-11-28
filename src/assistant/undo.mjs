// Undo on her Activity: the PERSON presses it, once, for an act she did alone (switch on). What puts each one back is in takeback.mjs
// (a record in the audit entry: { kind, ... }) or hoprigact.mjs (the entry's `undo` names the act that does it). An act with no
// way back never ran alone, so it has no button. The press is an entry of the audit log of its own (result.undid = the entry's
// time), which is also how "taken back already" is known: a second press does nothing.
import { BACKS } from './takeback.mjs';
import { ACTS, putBack } from './hoprigact.mjs';

const WEEK = 7 * 24 * 3600_000;

/** The times of the entries that were taken back. */
export const takenBack = (entries) => new Set(entries.filter((e) => e.outcome === 'done' && e.result && Number.isFinite(e.result.undid)).map((e) => e.result.undid));

/** Does this entry have a way back that Activity offers (not whether it was used)? */
export function hasWayBack(e) {
  if (!e || e.actor !== 'assistant' || e.level !== 'L1' || e.outcome !== 'done' || !e.result || !e.result.undo) return false;
  const u = e.result.undo;
  return e.tool === 'hoprig_act' ? !!(u.act && ACTS[u.act]) : !!(u.kind && BACKS[u.kind] && BACKS[u.kind].restore);
}

/** The entries as Activity shows them: each with `undo: 'press'` (one press takes it back) or `'done'` (taken back), or neither. */
export function withUndo(entries, all = entries) {
  const gone = takenBack(all);
  return entries.map((e) => (hasWayBack(e) ? { ...e, undo: gone.has(e.at) ? 'done' : 'press' } : e));
}

/**
 * The owner pressed Undo on the entry made at `at`. → { ok: true, summary } | { ok: false, error, code }. `ctx`: what a restore may use
 * (the watches). Claimed before the first await, so two presses at once restore once.
 */
export function createUndo({ audit, ops, ctxFor, now = Date.now, tell = () => {} }) {
  const claimed = new Set();
  return async function undoAct(at) {
    const all = audit.since(now() - WEEK);
    const e = all.find((x) => x.at === at && hasWayBack(x));
    if (!e) return { ok: false, code: 'none', error: 'there is nothing to take back there (it is older than a week, or it cannot be taken back)' };
    if (takenBack(all).has(at) || claimed.has(at)) return { ok: false, code: 'used', error: 'it was taken back already' };
    claimed.add(at);
    const ctx = ctxFor(e.conversation);
    try {
      const u = e.result.undo;
      let said;
      if (e.tool === 'hoprig_act') {
        await putBack(ops, e, ctx);
        said = 'It is taken back.';
      } else {
        said = (await BACKS[u.kind].restore(ops, u, ctx)).summary;
      }
      audit.append({ actor: 'owner', conversation: e.conversation, tool: 'undo', level: 'L1', input: { act: e.tool }, outcome: 'done', result: { undid: at } });
      tell(e.conversation, `The owner pressed Undo in Activity: ${said}`);
      return { ok: true, summary: said };
    } catch (err) {
      claimed.delete(at);
      const error = String((err && err.message) || err).replace(/^Error: /, '').slice(0, 200);
      audit.append({ actor: 'owner', conversation: e.conversation, tool: 'undo', level: 'L1', input: { act: e.tool }, outcome: 'failed', error });
      return { ok: false, code: 'failed', error };
    }
  };
}
