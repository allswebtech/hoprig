// The card a chat shows when its provider cannot answer now (a usage limit, out of credit). What it offers is a
// list: one entry per action, so another part of the dashboard adds its own as one more entry. Each entry:
// (ctx) → { label, icon, primary?, run }, an array of ready buttons, or null (not offered now).
// The buttons of Claude Code's stored sign-in ("Continue with the new account", "Sign in with another Claude
// account") come from claudeaccount.js, the same as on a session's limit card.
import { accountLimitActions } from '../claudeaccount.js';
import { icon } from '../icons.js';
import { h, machine, until } from '../lib.js';
import { store } from '../store.js';
import { hasPlan } from './words.js';

/** ctx: { id (the chat's), v (its state), moveProvider(), profiles? (this computer's; the store's by default) } */
export const LIMIT_ACTIONS = [
  (ctx) => accountLimitActions({
    kind: 'chat', chatId: ctx.id, name: `chat:${ctx.id}`, display: ctx.v.title || 'This session', profile: ctx.v.profile,
    limit: ctx.v.limit, limitAt: (ctx.v.limit && ctx.v.limit.at) || null, machine: machine.current,
  }, ctx.profiles || (store.data && store.data.profiles) || []),
  (ctx) => ({ label: 'Move to another provider', icon: 'swap', primary: true, run: ctx.moveProvider }),
];

/** When the plan's window that ran out starts again, in words ("in 2 h"), or ''. */
function resets(limits) {
  const hit = Object.values(limits || {}).filter((x) => x && x.status === 'rejected' && Number.isFinite(x.resetsAt)).sort((a, b) => b.resetsAt - a.resetsAt)[0];
  return hit ? until(hit.resetsAt) : '';
}

const isPrimary = (b) => /(^|\s)primary(\s|$)/.test(b.className || '');

/** The card, or null while the provider can answer (or a terminal runs the conversation). */
export function limitCard(v, ctx) {
  if (!v.limit || v.terminal) return null;
  const again = hasPlan(v) ? resets(v.limits) : '';
  const buttons = LIMIT_ACTIONS.flatMap((make) => {
    const a = make({ ...ctx, v });
    if (!a) return [];
    if (Array.isArray(a)) return a.filter(Boolean);
    return [h(`button.btn.small.${a.primary ? 'primary' : 'secondary'}`, { type: 'button', onclick: () => a.run() }, icon(a.icon || 'swap', { size: 16 }), h('span', a.label))];
  });
  // One main button: the first that asks to be it; any later one steps back to a secondary.
  const lead = buttons.find(isPrimary);
  for (const b of buttons) {
    if (b !== lead && isPrimary(b)) b.className = b.className.replace(/(^|\s)primary(\s|$)/, '$1secondary$2');
  }
  return h('div.banner.error-box.chat-banner.chat-limit', { role: 'alert' },
    icon('alert', { size: 18 }),
    h('span', `${v.profile ? v.profile.label : 'This provider'} cannot answer now: ${v.limit.text}${again ? ` It is free again ${again}.` : ''}`),
    h('span.chat-banner-actions', lead ? [lead, ...buttons.filter((b) => b !== lead)] : buttons));
}
