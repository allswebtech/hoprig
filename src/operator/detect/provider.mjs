// A provider that is near its limit (80 % or more of a window), at it (100 %), whose sign-in is gone, or a gateway
// add-on that does not answer its port: one that runs and hangs, or one that providers go through and that stopped.
//
// Reads board.providers[]: { name, label, usage: { fiveHour: { pct, resetsAt }, week: { pct, resetsAt } } | null,
// signedIn: true | false | null } and board.gateways[]: { name, port, running, installed, usedBy, users: [provider],
// live: sessions open now that go through it | null, answers, since }.
//
// A provider that does not answer at its address (a plain gateway, an endpoint the owner added): board.providers[].reach
// is { answers: false, address, sessions } after the slow check's own look (a knock, then one request with no key); it is
// never Hoprig's to restart, so its row only opens the Providers page.
// A gateway add-on can also answer with server errors (g.status 500 or more: its own health address), or leave its port
// to another program (g.foreign, g.heldBy: { pid, name }): that program is never ended and has no restart act.
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
    // Its address does not answer: every open session on it fails, whatever its usage says.
    if (p.reach && p.reach.answers === false) {
      const n = Number.isInteger(p.reach.sessions) && p.reach.sessions > 0 ? p.reach.sessions : 0;
      out.push(makeItem({
        kind: 'provider',
        cls: n ? 'stopped' : 'info',
        subject: `provider ${providerName(p.name, p.label)} address`,
        key: `reach ${p.name}`,
        since: ms(p.reach.since),
        state: ['unreachable'],
        facts: [`provider ${providerName(p.name, p.label)} does not answer at its address${p.reach.address ? ` (${String(p.reach.address).slice(0, 50)})` : ''}`, n ? `${n} open session${n > 1 ? 's' : ''} on it cannot work` : 'no session on it is open now'],
        acts: [act('open', { href: '#/providers', label: 'Open Providers' })],
        why: 'It is not Hoprig\'s to restart: check the provider\'s own address or its server.',
        target: { provider: p.name },
      }));
    }
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
    // Another program holds its port: said, never ended, never started over (no restart act, so no rule can act).
    if (g.foreign === true && !g.running && (g.installed || used)) {
      const by = g.heldBy && Number.isInteger(g.heldBy.pid) ? `${String(g.heldBy.name || 'another program').slice(0, 40)}, pid ${g.heldBy.pid}` : 'another program';
      out.push(makeItem({
        kind: 'provider',
        cls: used ? 'stopped' : 'info',
        subject: `gateway ${g.name}`,
        since: g.since ?? null,
        state: ['port taken', by],
        facts: [`port ${g.port} is held by ${by}`, used ? `${used} provider${used > 1 ? 's go' : ' goes'} through the gateway and cannot be used` : 'no provider goes through it now', 'Hoprig does not end a program it did not start'],
        acts: [act('open', { href: '#/settings/addons' })],
        why: 'End that program yourself, or give the gateway another port.',
        target: { addon: g.name, foreign: true },
      }));
      continue;
    }
    // It answers its port, but with server errors: the restart rule's case as much as one that does not answer.
    const erring = g.running && g.answers !== false && Number.isInteger(g.status) && g.status >= 500;
    if (!erring && (g.answers !== false || !(g.running || (g.installed && used)))) continue;
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
      facts: [erring ? `the gateway answers with server errors (HTTP ${g.status}) on port ${g.port}` : g.running ? `the gateway runs but does not answer on port ${g.port}` : `the gateway is not running: nothing answers on port ${g.port}${g.ownerStopped ? ' (you stopped it)' : ''}`,
        g.live ? `${g.live} open session${g.live > 1 ? 's go' : ' goes'} through it and cannot work` : used ? `${used} provider${used > 1 ? 's go' : ' goes'} through it and cannot be used` : 'providers that go through it cannot be used'],
      acts: ['restart-gateway', act('open', { href: '#/settings/addons' })],
      why: 'A restart brings a gateway back when its process hangs.',
      // `ownerStopped`: he stopped it himself; no rule of Tia's starts it again.
      target: { addon: g.name, ownerStopped: g.ownerStopped === true },
    }));
  }
  return out;
}
