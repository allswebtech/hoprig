// Home (#/): the sessions of every computer and nothing else that stays. "Get started" above them until it is done
// or closed; one line about the accounts (a warning only when one is at its limit); then the sessions in three
// groups: Needs you, Working, Idle. With several computers, chips filter by computer.
import { APP_NAME } from './brand.js';
import { getStartedArea } from './getstarted.js';
import { icon } from './icons.js';
import { MACHINE_STATE, ago, btn, fill, h, insecure, needsYouFirst, prefs, stateOf, until } from './lib.js';
import { isStarting } from './newsession.js';
import { sessionCard } from './sessionitem.js';
import { connectionBanner, emptyState, frame, groupHead } from './shell.js';
import { pageNotify, store } from './store.js';

/** The three groups, by the state of a session (lib.js stateOf). "Needs you" is only what cannot go on without you. */
export const GROUPS = [
  ['needs', 'Needs you', ['attention', 'limit']],
  ['working', 'Working', ['working', 'starting']],
  ['waiting', 'Waiting for your next message', ['waiting', 'ended']],
  // A plain terminal is not Claude: it waits for nobody's message and never needs anyone, so it comes last.
  ['terminals', 'Terminals', ['shell']],
];
export const groupOf = (s) => (isStarting(s) ? 'working' : (GROUPS.find(([, , keys]) => keys.includes(stateOf(s).key)) || GROUPS[2])[0]);

const NEAR = 90; // from this share of a limit, the line warns

/**
 * The one line about the providers of the computers shown: { text, warn }. All fine: "3 providers · all available".
 * Otherwise only the providers not signed in, or at or near a limit, by name ("Claude Max is at 96% of its 5-hour limit"); the
 * computer's name once, only when there are several.
 */
export function accountsLine(machines, multi) {
  const troubles = [];
  let count = 0;
  for (const m of machines) {
    const said = [];
    for (const p of (m.profiles || []).filter((x) => !x.virtual)) {
      count++;
      const u = p.usage || {};
      const near = [['5-hour', u.fiveHour], ['weekly', u.week]].filter(([, x]) => x && Number.isFinite(x.pct) && x.pct >= NEAR).sort((x, y) => y[1].pct - x[1].pct)[0];
      if (p.signedIn === false) said.push(`${p.label} is not signed in`);
      else if (p.limited) said.push(`${p.label} is at its limit${p.limited.until ? `, free ${until(p.limited.until)}` : ''}`);
      else if (near) said.push(`${p.label} is at ${Math.round(near[1].pct)}% of its ${near[0]} limit`);
    }
    if (said.length) troubles.push(multi ? `${m.machineLabel}: ${said.join('; ')}` : said.join('; '));
  }
  if (!count) return { text: 'No providers yet: add one so sessions can start', warn: true };
  if (troubles.length) return { text: troubles.join(' · '), warn: true };
  const where = multi && machines.length > 1 ? ` on ${machines.length} computers` : '';
  return { text: `${count} provider${count === 1 ? '' : 's'}${where} · all available`, warn: false };
}

const skeleton = (n = 3) => Array.from({ length: n }, () => h('div.card.skeleton', h('div.sk.w40'), h('div.sk.w70'), h('div.sk.w90')));

export function viewHome() {
  store.viewing = null;
  pageNotify.setTitleBase(APP_NAME);
  const top = h('div');
  const filters = h('div');
  const accountsRow = h('div');
  const list = h('div.home-groups', skeleton());
  // "Get started" (getstarted.js): above everything while a step is missing.
  let noSessions = false;
  let paintEmpty = () => {};
  const gs = getStartedArea({ firstRun: () => noSessions, onChange: () => paintEmpty() });
  frame({
    title: 'Home',
    page: 'home',
    intro: 'Your Claude Code sessions on every computer, the ones that need you first.',
    primary: { label: 'New session', icon: 'plus', href: '#/new' },
    body: [
      insecure() ? h('div.banner.muted', icon('lock', { size: 18 }), h('span', 'Not encrypted. Use only on a network you trust, or put it behind HTTPS.')) : null,
      top, gs.el, filters, accountsRow, list,
    ],
  });
  let last = '';
  // The filter: 'all', or one computer ('~' is this one). Per device.
  let only = prefs.get('home.machine', 'all');
  const keyOf = (m) => (m === null ? '~' : m);
  const unsubscribe = store.subscribe((d, err) => {
    fill(top, connectionBanner(err));
    const all = store.all;
    if (!all.length) {
      if (err) fill(list, h('div.empty', icon('alert', { size: 32 }), h('p', err.message), btn('secondary', { label: 'Try again', icon: 'refresh', onclick: () => store.refresh() })));
      return;
    }
    const multi = store.multi;
    if (!multi || !all.some((m) => keyOf(m.machine) === only)) only = 'all';
    const key = JSON.stringify([only, all.map((m) => [m.machine, m.machineLabel, m.status, m.error, m.sessions, m.profiles])]);
    if (key === last) {
      for (const el of list.querySelectorAll('[data-at]')) el.textContent = ` · ${ago(Number(el.dataset.at))}`;
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
    fill(filters, multi
      ? [
        h('div.mchips', { role: 'tablist', 'aria-label': 'Computers' },
          h(`button.chip${only === 'all' ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(only === 'all'), onclick: () => setOnly('all') },
            h('span', 'All'), h('span.chip-n', String(all.reduce((n, m) => n + count(m), 0)))),
          all.map((m) => h(`button.chip${only === keyOf(m.machine) ? '.on' : ''}${m.status !== 'online' ? '.off' : ''}`, {
            type: 'button', role: 'tab', 'aria-selected': String(only === keyOf(m.machine)), onclick: () => setOnly(keyOf(m.machine)),
          }, icon('cpu', { size: 15 }), h('span', m.machineLabel), m.status === 'online' ? h('span.chip-n', String(count(m))) : h('span.dot.offdot')))),
        // A computer that cannot be reached is said once, here, not by missing sessions.
        all.filter((m) => m.status !== 'online' && (only === 'all' || keyOf(m.machine) === only)).map((m) =>
          h('a.banner.warn.mbanner', { href: '#/computers' }, icon('alert', { size: 18 }),
            h('span', h('strong', `${m.machineLabel}: ${MACHINE_STATE[m.status] || m.status}. `), m.error || ''), icon('chevronRight', { size: 18 }))),
      ]
      : null);
    const line = accountsLine(shown.filter((m) => m.status === 'online'), multi);
    fill(accountsRow, h(`a.accountsline${line.warn ? '.warn' : ''}`, { href: '#/providers' },
      icon(line.warn ? 'alert' : 'user', { size: 18 }), h('span.accountsline-text', line.text), icon('chevronRight', { size: 18 })));
    const profilesOf = new Map(all.map((m) => [m.machine, m.profiles]));
    const sessions = shown.flatMap((m) => m.sessions).sort(needsYouFirst);
    noSessions = !sessions.length;
    if (!sessions.length) {
      paintEmpty = () => {
        // With Get started open, it leads; here only the main action once Claude Code is ready.
        const p = gs.plan();
        const noAccount = !shown.some((m) => (m.profiles || []).some((x) => !x.virtual));
        fill(list, p.mode !== 'hidden' && !p.claudeReady
          ? emptyState('sessions', 'No sessions yet. Finish the first step above, then start one here.')
          : noAccount
            ? emptyState('sessions', 'No sessions yet. Add the provider Claude should use, then start a session.',
              h('a.btn.primary', { href: '#/providers' }, icon('plus', { size: 18 }), h('span', 'Add provider')))
            : emptyState('sessions', 'No sessions yet. Start one in a project; it keeps running when you close this page.',
              h('a.btn.primary', { href: '#/new' }, icon('plus', { size: 18 }), h('span', 'New session'))));
      };
      gs.repaint();
      paintEmpty();
      return;
    }
    paintEmpty = () => {};
    const after = () => store.refresh();
    fill(list, GROUPS.map(([id, title]) => {
      const mine = sessions.filter((s) => groupOf(s) === id);
      return mine.length
        ? h(`section.home-group.g-${id}`, { 'aria-label': title }, groupHead(title, mine.length), h('div.cards', mine.map((s) => sessionCard(s, profilesOf.get(s.machine) || [], after, multi))))
        : null;
    }));
  });
  return () => {
    unsubscribe();
    gs.stop();
  };
}
