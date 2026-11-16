// The card a chat shows when its provider cannot answer now (a usage limit, out of credit). What it offers is a
// list: one line per action, so another part of the dashboard adds its own (a sign-in with another account, say)
// as one more entry. Each entry: (ctx) → { label, icon, primary?, run } or null (not offered now).
import { icon } from '../icons.js';
import { h, until } from '../lib.js';

/** ctx: { v (the chat's state), moveProvider() } */
export const LIMIT_ACTIONS = [
  (ctx) => ({ label: 'Move to another provider', icon: 'swap', primary: true, run: ctx.moveProvider }),
];

/** When the plan's window that ran out starts again, in words ("in 2 h"), or ''. */
function resets(limits) {
  const hit = Object.values(limits || {}).filter((x) => x && x.status === 'rejected' && Number.isFinite(x.resetsAt)).sort((a, b) => b.resetsAt - a.resetsAt)[0];
  return hit ? until(hit.resetsAt) : '';
}

/** The card, or null while the provider can answer (or a terminal runs the conversation). */
export function limitCard(v, ctx) {
  if (!v.limit || v.terminal) return null;
  const again = resets(v.limits);
  const actions = LIMIT_ACTIONS.map((make) => make({ ...ctx, v })).filter(Boolean);
  return h('div.banner.error-box.chat-banner.chat-limit', { role: 'alert' },
    icon('alert', { size: 18 }),
    h('span', `${v.profile ? v.profile.label : 'This provider'} cannot answer now: ${v.limit.text}${again ? ` It is free again ${again}.` : ''}`),
    h('span.chat-banner-actions', actions.map((a) => h(`button.btn.small.${a.primary ? 'primary' : 'secondary'}`, { type: 'button', onclick: () => a.run() }, icon(a.icon || 'swap', { size: 16 }), h('span', a.label)))));
}
