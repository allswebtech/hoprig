// A session as Home and Workspace show it: one part, so the words, the state chip and the action are the same on
// both pages. Home draws it as a card (sessionCard); Workspace as a row under its project (sessionRow).
import { icon } from './icons.js';
import { h, limitBox, link, liveBasic, machinePill, permissionActions, profileIcon, profileText, stateOf, statusPill, switchProfile, toolChip } from './lib.js';
import { isStarting, markStarting, startingPill } from './newsession.js';
import { registeredCardBadges } from './registry.js';

// A chat (chat/page.js) has its own page; every other session is a terminal.
export const sessionHref = (s) => link(s.kind === 'chat' ? `#/chat/${s.chatId}` : `#/s/${encodeURIComponent(s.name)}`, s.machine);
const open = (s) => (location.hash = sessionHref(s));
const nameOf = (s) => s.display || s.name;
const chatTag = (s) => (s.kind === 'chat' ? h('span.badge.soft', icon('text', { size: 13 }), 'Chat') : null);
const chip = (s, opts) => (isStarting(s) ? startingPill(s) : statusPill(s, opts));

/**
 * The folder line of a card: only when it says more than the name, i.e. not for <…>/projects/<name> (the folder a
 * session of that project runs in). Either separator.
 */
export function folderWorthShowing(s) {
  const parts = String(s.short || '').split(/[\\/]/).filter(Boolean);
  const [parent, last] = parts.slice(-2);
  return !(parent === 'projects' && (last === s.name || last === s.display));
}
// A plain terminal has no provider; its chip already says "Terminal".
const provider = (s) => (s.profile
  ? h(`span.ppill${s.profile.name === 'auto' ? '.auto' : ''}`, icon(profileIcon(s.profile), { size: 14 }), profileText(s))
  : null);
// Moved to another provider from here: it restarts, and reads "Starting" until Claude reports again.
const moved = (s, refresh) => () => {
  markStarting(s.machine, s.name);
  refresh();
};
const linkProps = (s, label) => ({
  tabindex: 0,
  role: 'link',
  'aria-label': label,
  onclick: () => open(s),
  onkeydown: (e) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) open(s);
  },
});

/** The button that moves a session back to the provider it prefers, once that one is free again. */
function backButton(s, profiles, after) {
  const pref = s.preferred && !s.limit && profiles.find((p) => p.name === s.preferred);
  return pref
    ? h('button.btn.small.secondary', {
      type: 'button',
      onclick: async (e) => {
        e.stopPropagation();
        if (await switchProfile(s, pref)) after();
      },
    }, icon('swap', { size: 16 }), h('span', `Move back to ${pref.label}`))
    : null;
}

/**
 * Home: a session as a card, with the computer's name when there are several. `heading`: the state key its group's
 * heading already names ("Working", "Waiting for your next message"): its pill then shows only the time.
 */
export function sessionCard(s, profiles, refresh, multi, { heading = null } = {}) {
  const st = stateOf(s);
  const after = moved(s, refresh);
  const back = backButton(s, profiles, after);
  return h(`article.card.st-${st.key}`, linkProps(s, `${nameOf(s)}${multi ? ` on ${s.machineLabel}` : ''}: ${st.text}`),
    h('div.card-top', h('h3.card-name', nameOf(s)), chip(s, { text: st.key !== heading || Boolean(s.background) })),
    h('div.card-meta',
      chatTag(s),
      toolChip(s),
      multi ? machinePill(s.machineLabel) : null,
      provider(s),
      folderWorthShowing(s) ? h('span.card-path', icon('folder', { size: 14 }), s.short) : null,
      liveBasic(s),
      registeredCardBadges().map((b) => b(s))),
    s.lastMessage ? h('p.card-msg', s.lastMessage) : s.title && s.kind !== 'chat' ? h('p.card-msg.title', s.title) : null,
    st.key === 'attention' && s.note ? h('p.card-note', s.note) : null,
    // Answered right here, the same answers as the session page's banner.
    permissionActions(s, refresh),
    limitBox(s, profiles, after),
    back ? h('div.card-actions', back) : null);
}

/** Workspace: a session as a row under its project. `where`: which repository of the project it runs in, or null. */
export function sessionRow(s, profiles, refresh, { where = null } = {}) {
  const st = stateOf(s);
  const after = moved(s, refresh);
  return h(`div.row.static.si-row.st-${st.key}`, linkProps(s, `${nameOf(s)}: ${st.text}`),
    h('span.row-icon', icon(s.kind === 'chat' ? 'text' : 'terminal')),
    h('span.row-main',
      h('span.si-top', h('span.row-title', nameOf(s)), chip(s)),
      h('span.si-meta', toolChip(s), provider(s), where ? h('span.si-where', icon('folder', { size: 13 }), where) : null, liveBasic(s)),
      s.lastMessage ? h('span.row-sub.si-msg', s.lastMessage) : null,
      st.key === 'attention' && s.note ? h('span.si-note', s.note) : null,
      permissionActions(s, refresh),
      limitBox(s, profiles, after),
      backButton(s, profiles, after)),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}
