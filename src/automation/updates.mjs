// Updates: look for a new Claude Code, then tell the owner ("notify") or update it by itself ("auto").
// At most one look every 6 hours, never while a session is working, and only one message per new version.
// Claude Code is updated only while no session is working: a running session keeps its own copy until it
// restarts, so updating under an idle session is safe.
//
// Stored: { lastCheckAt, claudeTold } (the version already announced).
import { busy } from './cards.mjs';

export const CHECK_EVERY_MS = 6 * 3600_000;

/** state: { cards, data, now, settings: { claude } }. Returns { actions, data }. Action: { type: 'check' }. */
export function decide({ cards, data, now, settings }) {
  const d = { lastCheckAt: 0, ...(data || {}) };
  if (settings.claude === 'off') return { actions: [], data: d };
  if (now - d.lastCheckAt < CHECK_EVERY_MS) return { actions: [], data: d };
  if (cards.some(busy)) return { actions: [], data: d };
  return { actions: [{ type: 'check' }], data: { ...d, lastCheckAt: now } };
}

/**
 * What to do with what the look found. Pure. claude: claudeInfo() result or null. Returns { actions, data } with
 * actions { type: 'tell', current, latest } | { type: 'update-claude', current, latest }.
 */
export function afterCheck({ claude, settings, data }) {
  const d = { ...data };
  const actions = [];
  if (settings.claude !== 'off' && claude && claude.updateAvailable && claude.latest) {
    if (settings.claude === 'auto') actions.push({ type: 'update-claude', current: claude.installed, latest: claude.latest });
    else if (d.claudeTold !== claude.latest) {
      actions.push({ type: 'tell', current: claude.installed, latest: claude.latest });
      d.claudeTold = claude.latest;
    }
  }
  return { actions, data: d };
}

/** ctx: { updates: { claudeInfo(), claudeUpdate() }, deck.list(), settings, data, save(data), record(entry), notify(ev) }. */
export async function apply(actions, ctx) {
  if (!actions.some((a) => a.type === 'check')) return;
  const claude = await ctx.updates.claudeInfo().catch((e) => ({ error: e.message }));
  if (claude && claude.error) {
    ctx.record({ automation: 'updates', did: 'could not look for a new Claude Code', outcome: `failed: ${claude.error}` });
    return;
  }
  const found = afterCheck({ claude, settings: ctx.settings, data: ctx.data });
  ctx.save(found.data);
  if (!found.actions.length) {
    ctx.record({ automation: 'updates', did: 'looked for a new Claude Code', outcome: 'nothing new' });
    return;
  }
  for (const a of found.actions) {
    if (a.type === 'tell') {
      ctx.record({ automation: 'updates', did: `Claude Code ${a.latest} is available (you have ${a.current || 'an unknown version'})`, outcome: 'told the owner' });
      ctx.notify({ title: `Claude Code ${a.latest} is available`, message: `You have ${a.current || 'an unknown version'}.`, session: '' });
      continue;
    }
    // update-claude: look again right before, a session may have started working meanwhile.
    const cards = await ctx.deck.list();
    if (cards.some(busy)) {
      ctx.record({ automation: 'updates', did: `Claude Code ${a.latest} waits`, outcome: 'postponed: a session is working' });
      ctx.save({ ...found.data, lastCheckAt: 0 }); // look again at the next quiet moment, not in 6 hours
      continue;
    }
    const r = await ctx.updates.claudeUpdate().catch((e) => ({ ok: false, output: e.message }));
    const outcome = r.ok ? `ok: now ${r.version || a.latest}` : `failed: ${String(r.output || '').split('\n').filter(Boolean).pop() || 'see the log'}`;
    ctx.record({ automation: 'updates', did: `updated Claude Code from ${a.current} to ${a.latest}`, outcome });
    ctx.notify({ title: r.ok ? `Claude Code updated to ${r.version || a.latest}` : 'Claude Code update failed', message: outcome, session: '' });
  }
}
