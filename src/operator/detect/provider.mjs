// A provider that is near its limit (80 % or more of a window), at it (100 %), whose sign-in is gone, or a gateway
// add-on that does not answer its port: one that runs and hangs, or one that providers go through and that stopped.
//
// Reads board.providers[]: { name, label, usage: { fiveHour: { pct, resetsAt }, week: { pct, resetsAt } } | null,
// signedIn: true | false | null } and board.gateways[]: { name, port, running, installed, usedBy, users: [provider],
// live: sessions open now that go through it | null, answers, since }.
//
// A provider's PRERUN starts its gateway before each session, so a gateway that is not running while no session of
// those providers is open (after a reboot, or stopped by the owner) is not started yet: information, not stopped work.

import { act, makeItem } from '../item.mjs';
import { clock, ms, num, providerName } from './util.mjs';

export const NEAR_PCT = 80;
const WINDOWS = [['fiveHour', 'the five-hour window'], ['week', 'the week']];

export function detectProvider(board, { now = Date.now() } = {}) {
  const out = [];
  for (const p of board.providers ?? []) {
    const facts = [];
    let worst = 0;
    let since = null;
    for (const [key, words] of WINDOWS) {
      const w = p.usage?.[key];
      const pct = num(w?.pct);
      if (pct == null || pct < NEAR_PCT) continue;
      worst = Math.max(worst, pct);
      facts.push(`${words}: ${Math.round(pct)} % used${w.resetsAt ? `, resets at ${clock(w.resetsAt, now)}` : ''}`);
    }
    if (p.usage?.at) since = ms(p.usage.at);
    const gone = p.signedIn === false;
    if (gone) facts.unshift('its sign-in is gone: new sessions on it cannot start');
    if (!facts.length) continue;
    const reached = worst >= 100;
    out.push(makeItem({
      kind: 'provider',
      cls: gone || reached ? 'stopped' : 'info',
      subject: `provider ${providerName(p.name, p.label)}`,
      // The id stays what it was before the subject named the label, so a "Not now" given then still holds.
      key: `provider ${p.name}`,
      since,
      state: [gone ? 'signed out' : 'signed in', reached ? 'reached' : worst ? 'near' : 'fine'],
      facts,
      acts: [act('open', { href: '#/providers', label: gone ? 'Open Providers to sign in' : 'Open Providers' })],
      why: gone ? 'Sign in again on the Providers page.' : reached ? 'Sessions on it stop until the reset; another provider can take them.' : 'It is near its limit: plan the next work on another provider.',
      target: { provider: p.name },
    }));
  }
  for (const g of board.gateways ?? []) {
    const used = Number.isInteger(g.usedBy) && g.usedBy > 0 ? g.usedBy : 0;
    if (g.answers !== false || !(g.running || (g.installed && used))) continue;
    const users = Array.isArray(g.users) && g.users.length ? g.users.map(String) : null;
    if (!g.running && g.live === 0) {
      out.push(makeItem({
        kind: 'provider',
        cls: 'info',
        subject: `gateway ${g.name}`,
        since: g.since ?? null,
        state: ['not started'],
        facts: [`the gateway is not started: nothing answers on port ${g.port}`,
          `no session that goes through it is open; the next session of ${users ? users.join(' or ') : 'a provider that goes through it'} starts it`],
        acts: ['restart-gateway', act('open', { href: '#/settings/addons' })],
        why: 'Nothing waits for it now; start it here only to check that it starts.',
        target: { addon: g.name },
      }));
      continue;
    }
    out.push(makeItem({
      kind: 'provider',
      cls: 'stopped',
      subject: `gateway ${g.name}`,
      since: g.since ?? null,
      facts: [g.running ? `the gateway runs but does not answer on port ${g.port}` : `the gateway is not running: nothing answers on port ${g.port}${g.ownerStopped ? ' (you stopped it)' : ''}`,
        g.live ? `${g.live} open session${g.live > 1 ? 's go' : ' goes'} through it and cannot work` : used ? `${used} provider${used > 1 ? 's go' : ' goes'} through it and cannot be used` : 'providers that go through it cannot be used'],
      acts: ['restart-gateway', act('open', { href: '#/settings/addons' })],
      why: 'A restart brings a gateway back when its process hangs.',
      // `ownerStopped`: he stopped it himself; no rule of Tia's starts it again.
      target: { addon: g.name, ownerStopped: g.ownerStopped === true },
    }));
  }
  return out;
}
