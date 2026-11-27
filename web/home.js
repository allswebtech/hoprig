// Home (#/): the sessions of every computer and nothing else that stays. "Get started" above them while set-up is
// unfinished; then the sessions in groups: Needs you (with the providers line only when something is wrong), Working,
// Ready (what has been ready for more than 6 hours folded), Terminals. A group with nothing in it is not drawn. With
// several computers, chips filter by computer. One card per conversation (onecard.js).
import { APP_NAME } from './brand.js';
import { limitStripAction } from './claudeaccount.js';
import { getStartedArea } from './getstarted.js';
import { closable, openCloseSheet } from './closesheet.js';
import { foldLine, foldsAway, splitWaiting } from './homefold.js';
import { fieldLines } from './field.js';
import { icon } from './icons.js';
import { MACHINE_STATE, WINDOW, api, ago, answeredNow, btn, costWords, fill, h, insecure, isPaid, link, nearLimit, needsYouFirst, prefs, stateOf, until, waysOn } from './lib.js';
import { isStarting } from './newsession.js';
import { openNewSession } from './newsession-popup.js';
import { oneCardPerKey } from './onecard.js';
import { needsYouRows } from './operator.js';
import { navChanged, registerHomeCount } from './registry.js';
import { sessionCard } from './sessionitem.js';
import { connectionBanner, emptyState, frame, groupHead } from './shell.js';
import { pageNotify, store } from './store.js';

// Where Home's note about bypass leads: New sessions, opened at the switch itself (showpart.js).
export const BYPASS_SWITCH = '#/settings/new-sessions?show=bypass';

/** The three groups, by the state of a session (lib.js stateOf). "Needs you" is only what cannot go on without you. */
export const GROUPS = [
  ['needs', 'Needs you', ['attention', 'limit', 'failed']],
  ['working', 'Working', ['working', 'starting']],
  ['waiting', 'Ready', ['waiting', 'ended']],
  // A plain terminal is not Claude: it waits for nobody's message and never needs anyone, so it comes last.
  ['terminals', 'Terminals', ['shell']],
];
// The state a group's heading already names: its cards' pills show only the time. "Needs you" holds two states
// (Needs your OK, Limit reached) and Ready also holds Finished and Ended, so those keep their words.
const SAID_BY_HEADING = { working: 'working', waiting: 'waiting', terminals: 'shell' };
export const groupOf = (s) => (isStarting(s) ? 'working' : (GROUPS.find(([, , keys]) => keys.includes(stateOf(s).key)) || GROUPS[2])[0]);

/**
 * The groups Home draws, in order, each { id, title, count, rows, recent, old }: only those with something in them.
 * `needsRows`: what stands at the top of Needs you besides its sessions (the providers line when something is
 * wrong); Ready splits off what has waited for more than 6 hours (homefold.js).
 */
export function homeGroups(sessions, { needsRows = [], lead = null, now = Date.now() } = {}) {
  const ahead = lead && lead.n > 0 ? lead : null;
  return GROUPS.map(([id, title]) => {
    const rows = id === 'needs' ? [...(ahead ? [ahead.el] : []), ...needsRows.filter(Boolean)] : [];
    const mine = sessions.filter((s) => groupOf(s) === id);
    const { recent, old } = id === 'waiting' ? splitWaiting(mine, now) : { recent: mine, old: [] };
    return { id, title, count: (id === 'needs' && ahead ? ahead.n : 0) + needsRowsCount(id, needsRows) + mine.length, rows, recent, old };
  }).filter((g) => g.count > 0);
}
const needsRowsCount = (id, needsRows) => (id === 'needs' ? needsRows.filter(Boolean).length : 0);

// The one number badge of the menu is Home's: the rows of Needs you. The Operator's rows are counted by operator.js
// (registerHomeCount there); the rest of the group (its sessions and the providers row) is counted here.
let ownNeeds = 0;
registerHomeCount(() => ownNeeds);
/** The rows of the Needs you group that are not the Operator's: the group's count less the `lead` rows. */
export const ownNeedsCount = (groups, leadN = 0) => Math.max(0, ((groups.find((g) => g.id === 'needs') || {}).count || 0) - Math.max(0, leadN));
export function setOwnNeeds(n) {
  if (n === ownNeeds) return;
  ownNeeds = n;
  navChanged();
}

/** The Set up card stays only while set-up is unfinished (getstarted.js planGetStarted: mode "open"); the first-run card (firstrun.js) always shows while it is the one thing on Home. */
export const setupShown = (plan, first = false) => first || (!!plan && plan.mode === 'open');

/** A card names its computer only while several are shown at once: with one chosen in the filter it says nothing. */
export const showsComputer = (multi, only) => !!multi && only === 'all';

/**
 * Home's line for a computer that does not answer: what it means and where to look, in plain words. The system's
 * own error ("connect ECONNREFUSED …") is the line's tooltip only; the computer's page says what to check.
 */
export function offlineWords(m) {
  if (m.status === 'offline') return [h('strong', `${m.machineLabel} cannot be reached. `), 'Is it switched on and online? Open it to see what to check.'];
  return [h('strong', `${m.machineLabel}: ${MACHINE_STATE[m.status] || m.status}. `), 'Open it to see what to do.'];
}

/** "A", "A and B", "A, B and C". */
const andList = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/**
 * The one line about the providers of the computers shown: { text, warn, lines }. It warns only about limits: one
 * line per provider at or near one, said once with the computers it is used on after it (only when there are
 * several): "Claude Max is almost used up (96% of its 5-hour limit), on Workstation and Laptop. When it runs out,
 * sessions can go on with Team plan." The last half only when another provider is free; over several computers it names
 * the way only when each computer that has one picks the same, else "another provider". A provider that is not signed
 * in is no warning (one may simply not use it here): it is counted quietly, and Providers has its Sign in button.
 */
export function accountsLine(machines, multi) {
  const troubled = new Map(); // the provider's label -> { label, limited, near, computers }
  let count = 0;
  let unsigned = 0;
  for (const m of machines) {
    for (const p of (m.profiles || []).filter((x) => !x.virtual)) {
      count++;
      const near = nearLimit(p);
      if (p.signedIn === false) {
        unsigned++;
        continue;
      }
      if (!p.limited && !near) continue;
      const t = troubled.get(p.label) || { label: p.label, limited: null, near: null, computers: [] };
      if (p.limited && !t.limited) t.limited = p.limited;
      if (near && (!t.near || near[1].pct > t.near[1].pct)) t.near = near;
      if (m.machineLabel && !t.computers.includes(m.machineLabel)) t.computers.push(m.machineLabel);
      troubled.set(p.label, t);
    }
  }
  if (!count) return { text: 'No providers yet: add one so sessions can start', warn: true, lines: [] };
  if (troubled.size) {
    // The same provider on two computers is one account: the one free elsewhere is not "free" for it.
    // The limit card's own chooser (lib.js waysOn): Auto mode's order, only providers that run Claude Code, one that
    // costs nothing more first; a paid one only when no other is free, and then with the words every paid way carries.
    // Each computer picks in its own Auto order; a way is named only when every computer that has one picks the same.
    const pickOn = (m) => {
      const open = waysOn((m.profiles || []).filter((x) => !x.virtual), (f) => troubled.has(f.label));
      return open.find((f) => !isPaid(f)) || open[0] || null;
    };
    const picks = machines.map(pickOn).filter(Boolean);
    const other = !picks.length ? '' : new Set(picks.map((x) => x.label)).size === 1 ? `${picks[0].label}${costWords(picks[0])}` : 'another provider';
    const lines = [...troubled.values()].map((t) => {
      const what = t.limited
        ? `${t.label} is at its limit${t.limited.until ? `, free ${until(t.limited.until)}` : ''}`
        : `${t.label} is almost used up (${Math.round(t.near[1].pct)}% of its ${t.near[0]} limit)`;
      const where = multi && t.computers.length ? `, on ${andList(t.computers)}` : '';
      const next = !other ? '' : t.limited ? ` Sessions can go on with ${other}.` : ` When it runs out, sessions can go on with ${other}.`;
      return `${what}${where}.${next}`;
    });
    return { text: lines.join(' '), warn: true, lines };
  }
  const where = multi && machines.length > 1 ? ` on ${machines.length} computers` : '';
  const rest = unsigned ? `${unsigned} not signed in` : 'all available';
  return { text: `${count} provider${count === 1 ? '' : 's'}${where} · ${rest}`, warn: false, lines: [] };
}

const skeleton = (n = 3) => Array.from({ length: n }, () => h('div.card.skeleton', h('div.sk.w40'), h('div.sk.w70'), h('div.sk.w90')));

export function viewHome() {
  store.viewing = null;
  pageNotify.setTitleBase(APP_NAME);
  const top = h('div');
  const bypassNote = h('div');
  const filters = h('div');
  const list = h('div.home-groups', skeleton());
  const opRows = h('div.home-op'); // the cards that ask you to act, the first rows inside Needs you (operator.js)
  let opN = 0;
  let again = () => {};
  // "Get started" (getstarted.js): above everything while a step is missing.
  let noSessions = false;
  let paintEmpty = () => {};
  // The Sessions app of a desktop (lib.js WINDOW): the sessions of that one computer, under the app's name. Get started
  // is the dashboard's (this computer's setup, its steps lead to pages that are not apps): not in a window.
  const fixed = WINDOW && WINDOW.only;
  const gs = fixed
    ? { el: null, plan: () => ({ mode: 'hidden', claudeReady: true }), repaint() {}, stop() {} }
    : getStartedArea({ firstRun: () => noSessions, onChange: () => {
      // Done (or closed): no card at all, not a line that says it is done.
      if (gs && gs.el) gs.el.hidden = !setupShown(gs.plan(), !!(gs.first && gs.first()));
      paintEmpty();
    } });
  frame({
    title: fixed && WINDOW.label ? WINDOW.label : 'Home',
    page: 'home',
    // In the Sessions app of another computer a new session starts on that computer.
    primary: { label: 'New session', icon: 'plus', onclick: () => openNewSession(fixed && fixed !== '~' ? { m: fixed } : fixed === '~' ? { m: null } : {}) },
    // On a phone in the page head, not floating: a floating button sat on the first card's "Claude wants to run: …".
    primaryInHead: true,
    body: [
      insecure() ? h('div.banner.muted', icon('lock', { size: 18 }), h('span', 'Not encrypted. Use only on a network you trust, or put it behind HTTPS.')) : null,
      top, bypassNote, fixed ? null : fieldLines(), gs.el, filters, list,
    ],
  });
  // Said once: the update kept "Allow bypass permissions mode" on, because this dashboard used bypass (src/bypassgate.mjs).
  if (!fixed) {
    api('/api/settings/bypass').then((b) => {
      if (!b || !b.kept) return;
      const seen = () => api('/api/settings/bypass/seen', {}).catch(() => {}).then(() => {
        const had = bypassNote.contains(document.activeElement);
        fill(bypassNote);
        if (had) {
          list.tabIndex = -1; // the focus goes on to the sessions, not to the page's start
          list.focus();
        }
      });
      fill(bypassNote, h('div.banner.muted.bypass-note', { role: 'status' }, icon('info', { size: 18 }),
        h('span', 'Bypass permissions mode stays allowed: this dashboard used it before the switch "Allow bypass permissions mode" existed. You can turn it off in Settings → New sessions.'),
        h('span.banner-actions', h('a.btn.small.secondary', { href: BYPASS_SWITCH, onclick: () => seen() }, 'Open the switch'), h('button.btn.small.primary', { type: 'button', onclick: () => seen() }, 'OK'))));
    }, () => {}); // an older computer: no such switch
  }
  let last = '';
  // The fold of sessions that have waited for more than 6 hours (homefold.js): open or not, kept while the list is
  // drawn again. Closed when Home opens: the sessions of the last hours come first.
  let foldOpen = false;
  const waitedFold = (old, card) => {
    const cards = h('div.cards.home-fold-cards', { id: 'home-fold-cards', hidden: !foldOpen }, old.map(card));
    const show = h('button.btn.small.secondary', {
      type: 'button', 'aria-expanded': String(foldOpen), 'aria-controls': 'home-fold-cards',
      onclick: () => {
        foldOpen = !foldOpen;
        cards.hidden = !foldOpen;
        show.setAttribute('aria-expanded', String(foldOpen));
        show.textContent = foldOpen ? 'Hide' : 'Show';
      },
    }, foldOpen ? 'Hide' : 'Show');
    // End them…: his own press, in a sheet that names each one (closesheet.js). Nothing ends by itself.
    const closeThem = old.some(closable)
      ? h('button.btn.small.secondary', { type: 'button', onclick: () => openCloseSheet(old, { after: () => store.refresh() }) }, 'End them…')
      : null;
    return [h('div.home-fold', h('p.home-fold-line', icon('clock', { size: 18 }), h('span', foldLine(old.length))),
      h('div.home-fold-actions', show, closeThem)), cards];
  };
  // The filter: 'all', or one computer ('~' is this one). Per device.
  let only = fixed || prefs.get('home.machine', 'all');
  const keyOf = (m) => (m === null ? '~' : m);
  const paint = (d, err) => {
    again = () => {
      last = '';
      paint(d, err);
    };
    fill(top, connectionBanner(err));
    const all = store.all;
    if (!all.length) {
      if (err) fill(list, h('div.empty', icon('alert', { size: 32 }), h('p', err.message), btn('secondary', { label: 'Try again', icon: 'refresh', onclick: () => store.refresh() })));
      return;
    }
    const multi = store.multi;
    if (!fixed && (!multi || !all.some((m) => keyOf(m.machine) === only))) only = 'all';
    // An answer sent a moment ago is part of what a card shows (lib.js answeredNow): its buttons come back when it ends.
    // A session that has just waited 6 hours moves into the fold, with nothing else of it changed (homefold.js).
    const key = JSON.stringify([only, all.map((m) => [m.machine, m.machineLabel, m.status, m.error, m.sessions, m.profiles, m.sessions.map((s) => foldsAway(s)), m.sessions.map((s) => answeredNow(s))])]);
    if (key === last) {
      for (const el of list.querySelectorAll('[data-at]')) el.textContent = `${el.dataset.bare ? '' : ' · '}${ago(Number(el.dataset.at))}`;
      return;
    }
    last = key;
    const shown = all.filter((m) => only === 'all' || keyOf(m.machine) === only);
    const setOnly = (k) => {
      only = k;
      prefs.set('home.machine', k);
      last = '';
      store.refresh();
    };
    const count = (m) => m.sessions.length;
    fill(filters, multi && !fixed
      ? [
        h('div.mchips', { role: 'tablist', 'aria-label': 'Computers' },
          h(`button.chip${only === 'all' ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(only === 'all'), onclick: () => setOnly('all') },
            h('span', 'All'), h('span.chip-n', String(all.reduce((n, m) => n + count(m), 0)))),
          all.map((m) => h(`button.chip${only === keyOf(m.machine) ? '.on' : ''}${m.status !== 'online' ? '.off' : ''}`, {
            type: 'button', role: 'tab', 'aria-selected': String(only === keyOf(m.machine)), onclick: () => setOnly(keyOf(m.machine)),
          }, icon('cpu', { size: 15 }), h('span', m.machineLabel), m.status === 'online' ? h('span.chip-n', String(count(m))) : h('span.dot.offdot')))),
        // A computer that cannot be reached is said once, here, not by missing sessions.
        all.filter((m) => m.status !== 'online' && (only === 'all' || keyOf(m.machine) === only)).map((m) =>
          h('a.banner.warn.mbanner', { href: link('#/computer', m.machine), title: m.error || null }, icon('alert', { size: 18 }),
            h('span', ...offlineWords(m)), icon('chevronRight', { size: 18 }))),
      ]
      : null);
    // The providers line only when something is wrong, and then as a row of Needs you; "all available" is not shown.
    const line = accountsLine(shown.filter((m) => m.status === 'online'), multi);
    const providerRows = line.warn
      ? [h('div.home-needs-row', h('a.accountsline.warn', { href: '#/providers' },
        icon('alert', { size: 18 }),
        // One line per provider when several are near a limit (a phone then reads them one by one).
        h('span.accountsline-text', line.lines.length > 1 ? line.lines.map((l) => h('span.accountsline-one', l)) : line.text),
        icon('chevronRight', { size: 18 })),
      // The stored Claude sign-in of this computer is at its limit: go on with another account (claudeaccount.js).
      limitStripAction(shown))]
      : [];
    const profilesOf = new Map(all.map((m) => [m.machine, m.profiles]));
    const sessions = oneCardPerKey(shown.flatMap((m) => m.sessions)).sort(needsYouFirst);
    noSessions = !sessions.length;
    if (!sessions.length) {
      paintEmpty = () => {
        // With Get started open, it leads; here only the main action once Claude Code is ready.
        const p = gs.plan();
        const noAccount = !shown.some((m) => (m.profiles || []).some((x) => !x.virtual));
        fill(list, p.mode !== 'hidden' && !p.claudeReady
          ? emptyState('sessions', 'No sessions yet. Finish the first step above, then start one here.')
          : noAccount
            ? emptyState('sessions', 'No sessions yet. Add a provider for your coding tool, then start a session.',
              h('a.btn.primary', { href: '#/providers' }, icon('plus', { size: 18 }), h('span', 'Add provider')))
            : emptyState('sessions', 'No sessions yet. Start one in a project; it keeps running when you close this page.',
              h('button.btn.primary', { type: 'button', onclick: () => openNewSession() }, icon('plus', { size: 18 }), h('span', 'New session'))));
      };
      gs.repaint();
      paintEmpty();
      // Something wrong with a provider is said even with no session: as Needs you, above the empty words.
      setOwnNeeds(providerRows.length);
      if (providerRows.length || opN) list.prepend(h('section.home-group.g-needs', { 'aria-label': 'Needs you' }, groupHead('Needs you', providerRows.length + opN), opN ? opRows : null, providerRows));
      return;
    }
    paintEmpty = () => {};
    const after = () => store.refresh();
    // The rows at the top of Needs you, before its sessions: the Operator's cards first (`lead`, drawn by
    // needsYouRows into opRows), then the providers row. A group with no rows is not drawn.
    const needsRows = [...providerRows];
    // A card names its computer only while every computer is shown (one chosen in the filter: it is that one).
    const named = showsComputer(multi, only);
    const groups = homeGroups(sessions, { needsRows, lead: { el: opRows, n: opN } });
    setOwnNeeds(ownNeedsCount(groups, opN));
    fill(list, groups.map(({ id, title, count, rows, recent, old }) => {
      const card = (s) => sessionCard(s, profilesOf.get(s.machine) || [], after, named, { heading: SAID_BY_HEADING[id] });
      // Ready: what has waited for more than 6 hours stands folded under one line.
      return h(`section.home-group.g-${id}`, { 'aria-label': title }, groupHead(title, count),
        rows.length ? rows : null,
        recent.length ? h('div.cards', recent.map(card)) : null,
        old.length ? waitedFold(old, card) : null);
    }));
  };
  const unsubscribe = store.subscribe(paint);
  const stopOp = needsYouRows(opRows, (n) => {
    if (n === opN) return;
    opN = n;
    again();
  });
  return () => {
    unsubscribe();
    gs.stop();
    stopOp();
  };
}
