// "Use other providers" (with "Lead model" on): the lead may hand a part to another provider the owner ticked for this
// session, through one function of the dashboard (partdoor.mjs), never by itself. The ticks are the server's record
// (the chat's, the plan's, Tia's settings, the new-session default), never what the model says. Which providers can be
// ticked, and the one gate every part passes, are here.
import { limitedProfiles } from '../autoswitch.mjs';
import { billedLogin } from '../routerstate.mjs';
import { NAME_RE, listProfiles, publicProfile, readProfile, servesTools } from '../profiles.mjs';

export const OTHERS_MAX = 10;
const serves = (p) => !!p && servesTools(p).includes('claude');

/**
 * The providers that can be ticked for a session on provider `own`: every other one that serves Claude Code, with its
 * coding tools, whether it is billed by use and its limit as last known. → [{ name, label, tools, paid, limited, ticked }]
 */
export function otherProviders(own, ticks = [], { now = Date.now() } = {}) {
  const limited = limitedProfiles(now);
  return listProfiles().filter((p) => p.name !== own && serves(p)).map((p) => {
    const v = publicProfile(p);
    const l = limited[p.name];
    return { name: v.name, label: v.label || v.name, kind: v.kind, tools: v.tools, paid: v.paid === true || billedLogin(p), limited: l ? { until: l.until || null } : null, ticked: ticks.includes(p.name) };
  });
}

/** A clean list of ticks for a session on `own` (an error in plain words for a bad one); [] for none. */
export function cleanOthers(v, own = null) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > OTHERS_MAX || v.some((n) => typeof n !== 'string' || !NAME_RE.test(n))) throw new Error(`the other providers are a list of up to ${OTHERS_MAX} provider names`);
  for (const n of v) {
    if (n === own) throw new Error('the session\'s own provider is not another provider');
    if (!serves(readProfile(n))) throw new Error(`there is no provider "${n}" that serves Claude Code`);
  }
  return [...new Set(v)];
}

/** Ticks as an old record or a hand-edited file may hold them: only names, never an error. */
export const ticksOf = (v) => (Array.isArray(v) ? [...new Set(v.filter((n) => typeof n === 'string' && NAME_RE.test(n)))].slice(0, OTHERS_MAX) : []);

/**
 * Whether a part may start on `provider` for lead session `s` ({ lead, others, profile, byTia }), from facts the
 * dashboard looked up itself: { tia: { allowed, level } (her settings, for a session of hers), running (parts that run
 * now: every session that runs by itself here), atOnce (the computer's limit), paidOk (the owner allows a provider billed
 * by use for work that goes on by itself), ownerYes (he said yes to this very part on its card), now }.
 * → { ok: true } | { ok: true, hold: cap } | { refuse: plain words } | { card: plain words } (a provider billed by use
 * waits for the owner's OK). `hold`: a part of Tia's at "Hands off" on a provider billed by use may start by itself
 * only inside her daily limit for paid use (`cap`, dollars): the caller takes the hold (spend.mjs take) and makes it a
 * card when there is no room.
 */
export function partGate(s, provider, { tia = null, running = 0, atOnce = 1, paidOk = false, ownerYes = false, now = Date.now() } = {}) {
  if (!s || s.lead !== true) return { refuse: 'Lead model is off for this session' };
  if (!ticksOf(s.others).length) return { refuse: '"Use other providers" is off for this session' };
  if (typeof provider !== 'string' || !ticksOf(s.others).includes(provider)) return { refuse: `"${String(provider).slice(0, 40)}" is not one of the providers ticked for this session (${ticksOf(s.others).join(', ')})` };
  const p = readProfile(provider);
  if (!serves(p)) return { refuse: `the provider "${provider}" does not serve Claude Code` };
  if (s.byTia && !(tia && Array.isArray(tia.allowed) && tia.allowed.includes(provider))) return { refuse: `Tia may not use the provider "${provider}" (Settings → Tia)` };
  const l = limitedProfiles(now)[provider];
  if (l) return { refuse: `the provider "${provider}" is at its limit${l.until ? ` until ${new Date(l.until).toISOString()}` : ''}: skipped` };
  if (running >= atOnce) return { refuse: `${running} session${running === 1 ? '' : 's'} run${running === 1 ? 's' : ''} by ${running === 1 ? 'itself' : 'themselves'} now (at most ${atOnce} at once on this computer): wait for one to end` };
  // Her chats follow her own rule (src/assistant/policy.mjs): every API provider is paid per token, as her own start
  // of a session there is; the owner's chats, a key straight to the vendor (profiles.mjs isPayPerUse).
  // A stored sign-in on a key billed by use (routerstate.mjs billedLogin) is billed by use too.
  const paid = p.paid === true || billedLogin(p) || (s.byTia === true && p.kind === 'api');
  if (paid && !ownerYes && !(s.byTia ? tia && tia.level === 'handsoff' : paidOk)) return { card: `the provider "${provider}" is billed by use: the owner's OK comes first` };
  // Hands off lets her spend only inside the daily limit he set, as her own paid acts (src/assistant/spend.mjs).
  if (paid && !ownerYes && s.byTia) {
    const cap = Number.isFinite(tia.dailyCapUsd) && tia.dailyCapUsd > 0 ? tia.dailyCapUsd : null;
    return cap ? { ok: true, hold: cap } : { card: `the provider "${provider}" is billed by use and no daily limit for paid use is set: the owner's OK comes first` };
  }
  return { ok: true };
}
