// Money in the Operator: a move of a session onto a provider billed by use, a decision's own call and a look's session
// there, done without the owner's tap. Each is money like Tia's own paid acts, so each follows her rule: only at her level
// "Hands off" AND inside the daily limit for paid use he set (Settings → Tia), counted by the same ledger and the same amount
// (src/assistant/spend.mjs, the file in this state folder). The hold is taken with take() in one synchronous step right
// before the act, so two acts at once cannot both pass the last free amount. With no daily limit for paid use, or that
// limit used up, the act is his, said in one plain line, with a button that opens the limit. His own tap writes nothing here.
import { HOLD_USD, SpendLedger, isPaid, paidName, spendFile } from '../assistant/spend.mjs';
import { ANSWERS } from './decide-table.mjs';

/** The id of the field of the daily limit for paid use in Settings → Tia, and the address that opens the page at it (web/showpart.js). */
export const CAP_PART = 'tia-daily-cap';
export const CAP_SWITCH = `#/settings/tia?show=${CAP_PART}`;

/**
 * The ledger of this state folder: one object for as long as the folder stays the same (a test's own state folder
 * gets its own), so the Operator's writes all go through one ledger. A lock left behind by a process that ended
 * inside it is waited for once, until it is stale, and taken over (spend.mjs #append).
 */
let kept = null;
export const ledger = () => {
  const file = spendFile();
  if (!kept || kept.file !== file) kept = new SpendLedger({ file });
  return kept;
};

/**
 * True when `name` spends money by use, by the accounts as the dashboard lists them: an API key, a profile marked paid
 * per use, one that is not on this computer (not known: the safe side), or Auto mode whose order holds such a provider.
 */
export function paidTo(name, acc = {}) {
  if (typeof name !== 'string' || !name) return true;
  if (name === 'auto') return paidName('auto', acc);
  const p = (acc.profiles || []).find((x) => x.name === name);
  return !p || isPaid(p);
}

const dollars = (v) => `$${(Math.round(v * 100) / 100).toFixed(2)}`;
const capOf = (cap) => (typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : null);

/** The one line on the item: `what` ("Moving this session to paid-x") costs money by use, and why it is his. */
export function capLine(what, cap) {
  const c = capOf(cap);
  return c ? `${what} costs money by use, and today's daily limit for paid use of ${dollars(c)} is used up.` : `${what} costs money by use, and Tia has no daily limit for paid use.`;
}

/** Whether one more paid act fits today's daily limit for paid use, read without writing: null when it does, else the item's line. */
export function room(what, cap, l = ledger()) {
  const c = capOf(cap);
  if (!c) return capLine(what, null);
  const t = l.today();
  return t.spent + t.held + HOLD_USD > c + 1e-9 ? capLine(what, c) : null;
}

/**
 * The hold, right before the act: written at once when the daily limit for paid use has room (→ null), else the item's
 * line and nothing written. Called with no await between it and the act's start.
 */
export function hold(what, cap, id, l = ledger()) {
  const c = capOf(cap);
  if (!c) return capLine(what, null);
  return l.take(c, { id }) ? capLine(what, c) : null;
}

/**
 * The provider a call of hers (a decision, a look) may run on, money-wise: `paid` (billed by use), the level and the daily
 * limit for paid use as resolveTia gives them. → null when it may, else why not, in one clause.
 */
export function mayCall(paid, tia, l = ledger()) {
  if (!paid) return null;
  if (tia.level !== 'handsoff') return 'she spends that only at "Hands off"';
  const c = capOf(tia.dailyCapUsd);
  if (!c) return 'Tia has no daily limit for paid use (Settings → Tia)';
  const t = l.today();
  return t.spent + t.held + HOLD_USD > c + 1e-9 ? `today's daily limit for paid use of ${dollars(c)} is used up (Settings → Tia)` : null;
}

/**
 * A step of `item` that moves work onto a provider billed by use (a limit's switch, a mission's next-provider): → its
 * { step, to, what } or null. `steps`: the ones offered (the item's own by default; its target is read from the item).
 */
export function paidStep(item, acc, steps = item?.steps || []) {
  if (steps.includes('switch') && item.kind === 'limit') {
    const to = item.target?.to;
    return paidTo(to, acc) ? { step: 'switch', to, what: `Moving this session to ${to}` } : null;
  }
  if (steps.includes('next-provider') && item.kind === 'mission-limit') return paidTo(item.to, acc) ? { step: 'next-provider', to: item.to, what: `Moving this task to ${item.to}` } : null;
  return null;
}

/** The steps of a decision that type into a session: the fixed nudge line, an answer to its question (decide-table.mjs). */
export const TYPING = Object.freeze(['nudge', 'note', ...ANSWERS]);

/**
 * Typing into the session of `item` (a stuck session, a question) when its own provider is billed by use: the session
 * then runs a turn paid per token, as after her own send_to_session there. Judged as that act is (core.mjs facts: the
 * session's profile, Auto mode by its order), so a session whose provider is not on this computer, or not known (one
 * the coding tool ran without Hoprig), is not counted as paid here. → { to, what } or null.
 */
export function paidTyping(item, board, acc) {
  if (!['stuck', 'asks'].includes(item?.kind)) return null;
  const s = (board?.sessions || []).find((x) => x.name === item.target?.session);
  if (!s || typeof s.provider !== 'string' || !s.provider || !paidName(s.provider, acc)) return null;
  return { to: s.provider, what: `Typing into this session on ${s.provider}` };
}

/** A paid call or look reported what it cost: the hold `id` is settled with it (spend.mjs spent). */
export function settle(usd, what, id, l = ledger()) {
  if (Number.isFinite(usd) && usd >= 0) l.spent(usd, what, id);
}
