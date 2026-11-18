// Idle care: tidy up what nobody uses.
//   shells   close a plain shell session (nothing running in it, nobody looking at it) after N quiet hours
//   gateway  stop an add-on gateway (it starts again by itself when a session needs it) after no session has
//            used its account for N minutes. A session in Auto mode counts as using every account of the order.
//
// Stored: { gateways: { [addon id]: { lastUsedAt, stoppedFor } } }   stoppedFor = the lastUsedAt we stopped at,
// so one quiet spell gives one stop.
import { isCodingCard, plainShell } from './cards.mjs';

/**
 * state: { cards, data, now, settings: { shells, shellHours, gateway, gatewayMinutes }, addons: [{ id, profile }],
 * autoOrder: [profile names] }. Returns { actions, data }.
 * Actions: { type: 'close-shell', session, idleMs } | { type: 'stop-gateway', addon, idleMs }.
 */
export function decide({ cards, data, now, settings, addons = [], autoOrder = [] }) {
  const actions = [];
  if (settings.shells) {
    for (const c of cards) {
      if (!plainShell(c) || c.attached || !Number.isFinite(c.activity)) continue;
      const idleMs = now - c.activity;
      if (idleMs > settings.shellHours * 3600_000) actions.push({ type: 'close-shell', session: c.name, idleMs });
    }
  }
  const gateways = {};
  if (settings.gateway) {
    for (const a of addons) {
      const g = { lastUsedAt: now, stoppedFor: null, ...((data && data.gateways && data.gateways[a.id]) || {}) };
      // A chat whose process runs counts too: that process does not run the provider's PRERUN again, so a gateway
      // stopped under it would fail its next message. Once its process stops (after a quiet while), it does not.
      const using = (c) => isCodingCard(c) || (c.kind === 'chat' && c.running === true);
      const used = cards.some((c) => using(c) && c.profile && (c.profile.name === a.profile || (c.profile.name === 'auto' && autoOrder.includes(a.profile))));
      if (used) g.lastUsedAt = now;
      else if (g.stoppedFor !== g.lastUsedAt && now - g.lastUsedAt > settings.gatewayMinutes * 60_000) {
        actions.push({ type: 'stop-gateway', addon: a.id, idleMs: now - g.lastUsedAt });
        g.stoppedFor = g.lastUsedAt;
      }
      gateways[a.id] = g;
    }
  }
  return { actions, data: { gateways } };
}

/** ctx: { deck.kill(name), addons: [{ id, title, status(), stop() }], record(entry) }. */
export async function apply(actions, ctx) {
  for (const a of actions) {
    if (a.type === 'close-shell') {
      try {
        await ctx.deck.kill(a.session);
        ctx.record({ automation: 'idle', session: a.session, did: `closed the shell after ${Math.round(a.idleMs / 3600_000)} quiet hours`, outcome: 'ok' });
      } catch (e) {
        ctx.record({ automation: 'idle', session: a.session, did: 'could not close the idle shell', outcome: `failed: ${e.message}` });
      }
      continue;
    }
    const addon = ctx.addons.find((x) => x.id === a.addon);
    if (!addon) continue;
    try {
      const st = await addon.status();
      if (!st.running) continue; // already stopped: nothing to do, nothing to log
      const r = await addon.stop();
      ctx.record({ automation: 'idle', did: `stopped ${addon.title || addon.id}: unused for ${Math.round(a.idleMs / 60_000)} minutes`, outcome: r && r.ok ? 'ok' : `failed: ${(r && r.error) || 'it did not stop'}` });
    } catch (e) {
      ctx.record({ automation: 'idle', did: `could not stop ${addon.title || addon.id}`, outcome: `failed: ${e.message}` });
    }
  }
}
