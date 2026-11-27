// A session as Home and Workspace show it: one part, so the words, the state chip and the action are the same on
// both pages. Home draws it as a card (sessionCard); Workspace as a row under its project (sessionRow).
import { heldActCard } from './handsoff.js';
import { hasCard, runsInBackground } from './homefold.js';
import { icon } from './icons.js';
import { TOOL_NAMES, api, askNote, atOf, bgCommandNote, cardTool, h, isCodingCard, limitBox, link, liveBasic, permissionActions, profileIcon, profileText, stateOf, statusPill, switchProfile, toast, toolChip, worktreeOf } from './lib.js';
import { isStarting, markStarting, startingPill } from './newsession.js';
import { registeredCardBadges } from './registry.js';

// A session in the App (chat/page.js) has its own page; every other session is a terminal.
export const sessionHref = (s) => link(s.kind === 'chat' ? `#/chat/${s.chatId}` : `#/s/${encodeURIComponent(s.name)}`, s.machine);
const open = (s) => (location.hash = sessionHref(s));
const nameOf = (s) => s.display || s.name;
const chip = (s, opts) => (isStarting(s) ? startingPill(s) : statusPill(s, opts));

/**
 * The folder line of a card: only when it says more than the name, i.e. not for <…>/projects/<name> (the folder a
 * session of that project runs in). Either separator.
 */
export function folderWorthShowing(s) {
  if (!s.short) return false;
  if (worktreeOf(s.cwd)) return true; // on a branch of its own: the line says so
  const parts = String(s.short || '').split(/[\\/]/).filter(Boolean);
  const [parent, last] = parts.slice(-2);
  return !(parent === 'projects' && (last === s.name || last === s.display));
}
/** The folder line of a card: where the session runs; a chat in its own worktree says its project and its branch. */
export function folderLine(s) {
  const wt = worktreeOf(s.cwd);
  return wt ? `${String(s.short || wt.project).replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '')} · ${wt.branch}` : s.short;
}
/**
 * The extra folders a session may read (a need of its project, --with, "Also open"), by their map names, or null.
 * One line, cut at its end; the whole list is in its title and its words for a screen reader.
 */
export function extrasLine(s, cls = 'span.card-extras') {
  const list = Array.isArray(s.extras) ? s.extras.filter((x) => typeof x === 'string') : [];
  if (!list.length) return null;
  const words = `Also reads (its file tools cannot write there): ${list.join(', ')}`;
  return h(cls, { title: words, 'aria-label': words }, icon('folder', { size: 14 }), h('span.card-extras-text', `Also reads: ${list.join(', ')}`));
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

/** A session that waits for him and whose last message ends in a question ("Should I apply it to /api/cart?"). */
export const endsInQuestion = (s) => /\?\s*$/.test(String((s && s.lastMessage) || ''));
// What he has typed in a card's reply box, per session: the card is drawn anew with each look.
const drafts = new Map();
const draftKey = (s) => `${s.machine ?? ''}|${s.name}`;

/**
 * A reply box on Home's card of a coding session that waits and ends in a question, so he answers there and not in
 * a terminal view. It sends only on his press of Send (no key sends it), only to this session, on its own computer.
 * Not his own keys (no `owner`): the server types it only while the coding tool is in front, never a control key
 * (server.mjs /send). Never on a card that needs an OK or reached a limit: those have their own answers. Never while
 * something of it still runs by itself (a background command, subagents): it may put a question on its screen any
 * moment, and his words would answer that one.
 */
export function replyBox(s, after) {
  if (!s || s.kind === 'chat' || !isCodingCard(s) || stateOf(s).key !== 'waiting' || !endsInQuestion(s)) return null;
  if (runsInBackground(s) || s.background) return null;
  const key = draftKey(s);
  const who = nameOf(s);
  const ta = h('textarea.field.card-reply-text', {
    rows: 1,
    value: drafts.get(key) || '',
    placeholder: 'Your answer…',
    'aria-label': `Your answer to ${who}`,
    'data-keep-focus': `reply|${key}`,
    oninput: () => (ta.value ? drafts.set(key, ta.value) : drafts.delete(key)),
  });
  const send = h('button.btn.small.primary', {
    type: 'button',
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = String(ta.value || '').replace(/\s+$/, '');
      if (!text) return ta.focus?.();
      send.disabled = true;
      try {
        // The card may be seconds old: read the session again and send only while it still waits as the card showed
        // it, so his "2" never answers a permission question that came up since.
        const why = changedSince(s, await readAgain(s));
        if (why) {
          toast(keptWords(`Not sent: ${why}`), { kind: 'error' });
          after?.();
          return;
        }
        // `expect: 'waiting'`: the server reads the session once more right before it types, and refuses (409, with
        // its own sentence) when it no longer waits or a question stands on its screen (server.mjs /send).
        await api(atOf(s, `/api/sessions/${encodeURIComponent(s.name)}/send`), { text, expect: 'waiting' });
        drafts.delete(key);
        ta.value = '';
        toast(`Sent to ${who}.`);
        after?.();
      } catch (err) {
        // A 409 that typed nothing is one refusal, whichever check caught it: the guard of `expect` ("Nothing was
        // sent: …"), a coding tool that ended or is not in front, another message being typed ("Nothing was typed: …",
        // code not_in_front; also what a computer on an older build answers). His words are kept, Home looks again.
        const said = inCardWords(err.message, s);
        if (err.status === 409 && (err.code === 'not_in_front' || /^Nothing was (sent|typed): /.test(err.message))) {
          toast(keptWords(said), { kind: 'error' });
          after?.();
        } else toast(`Not sent: ${said}`, { kind: 'error' });
      } finally {
        send.disabled = false;
      }
    },
  }, icon('send', { size: 16 }), h('span', 'Send'));
  // A press or a key in the box is for the box, never the card's link to the session.
  return h('div.card-reply', { onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation() }, ta, send);
}

/**
 * A refusal of the send route in the card's words: the server names a session by its terminal's name ("Nothing was
 * sent: shop-cart …", "… in session "shop-cart" …"), the card by its title. Only those two forms are changed, so a
 * name that is also a word ("work") is never changed elsewhere in the sentence.
 */
export function inCardWords(message, s) {
  const who = nameOf(s);
  const m = String(message || '');
  if (who === s.name) return m;
  const lead = `Nothing was sent: ${s.name} `;
  // The title in quotes, as in the other form: "Limit the cart requests" unquoted reads as an order, not as a name.
  return (m.startsWith(lead) ? `Nothing was sent: "${who}" ${m.slice(lead.length)}` : m).split(`session "${s.name}"`).join(`session "${who}"`);
}

/**
 * The end of a refused reply's toast: his words are kept, and where to look next, so he does not press Send again
 * blind. A sentence that already sends him to the session (a question on its screen) is not told twice.
 */
export function keptWords(said) {
  const end = /[.!?]$/.test(said) ? '' : '.';
  return `${said}${end} Your answer is kept.${/Open the session/.test(said) ? '' : ' Open the session to see what it does now.'}`;
}

/**
 * The session `s` as every computer's list says it now (GET ~/api/machines/sessions, the list Home itself reads), or
 * { silent: true } when its computer did not answer, or null when it is gone.
 */
async function readAgain(s) {
  const machine = s.machine ?? null;
  const m = ((await api('~/api/machines/sessions')).machines || []).find((x) => (x.machine ?? null) === machine);
  if (!m || (m.status && m.status !== 'online')) return { silent: true };
  return (m.sessions || []).find((x) => x.name === s.name) || null;
}

/**
 * Why a reply to `was` (the card as drawn) must not go to the session as read `now`; null when it still waits as it
 * did: the same state time and message, no question, notice or held act on it, nothing running by itself.
 */
export function changedSince(was, now) {
  if (now && now.silent) return 'its computer does not answer';
  if (!now) return 'the session has ended';
  const key = stateOf(now).key;
  if (key === 'attention' || hasCard(now)) return 'it is asking you something now';
  if (key === 'limit' || key === 'failed') return 'it needs you in another way now';
  if (key === 'working' || runsInBackground(now) || now.background) return 'it is working again';
  if (key === 'ended') return 'the session has ended';
  if (key !== 'waiting') return 'it is no longer waiting for an answer';
  if (now.statusAt !== was.statusAt || String(now.lastMessage || '') !== String(was.lastMessage || '')) return 'it has changed since you read it';
  return null;
}

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
 * A message as plain text: the marks of formatting (stars, back quotes, title and list marks, a link's address) are
 * taken out, lines run into one. A card shows what was said, not how it was typed.
 */
export function plainText(text) {
  return String(text || '')
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+])\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)\*([^*\s][^*]*?)\*(?=\s|$|[.,;:!?)])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A card's last line: its last message as plain text, never its title again (that told nothing). null: no line. */
export function lastLine(s) {
  const text = plainText(s && s.lastMessage);
  return text && text !== String(nameOf(s)).trim() ? text : null;
}

/** Whose words the last line is: "You", the coding tool's name, or null (the computer does not say). */
export const saidBy = (s) => (s.lastBy === 'you' ? 'You' : s.lastBy === 'claude' ? (cardTool(s) === 'claude' ? 'Claude' : TOOL_NAMES[cardTool(s)] || 'Claude') : null);

/** Where a conversation runs, as a word: "App" for a chat, "Terminal" for a terminal (a computer that says it, says it). */
export const whereWord = (s) => (s.where === 'app' || (!s.where && s.kind === 'chat') ? 'App' : 'Terminal');

/** The last part of the folder a session runs in ("~/Workspace/projects/shop" is "shop"); a branch of its own keeps its branch. */
export function folderLast(s) {
  const wt = worktreeOf(s.cwd);
  if (wt) return `${wt.project} · ${wt.branch}`;
  return String(s.short || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/**
 * The card of the conversation `was` (a terminal that has gone: { name, key, sessionId }) as the list shows it now,
 * under another name: the chat it was handed to. null while it still stands or nothing carries it on.
 */
export function whereNow(list, was) {
  if (!was || (!was.key && !was.sessionId)) return null;
  return (list || []).find((x) => x.name !== was.name && ((was.key && x.key === was.key) || (was.sessionId && x.sessionId === was.sessionId))) || null;
}

/**
 * Home: a session as a card, one look on every width. Row 1: its title, and its state in words with the time. Row 2,
 * one line that never wraps: where it runs (App or Terminal), the computer only while several are shown (`multi`),
 * its provider, the folder's last part. Row 3: its last words as plain text, said by whom when the computer says it.
 */
export function sessionCard(s, profiles, refresh, multi) {
  const st = stateOf(s);
  const after = moved(s, refresh);
  const back = backButton(s, profiles, after);
  const said = lastLine(s);
  const by = saidBy(s);
  const extra = [extrasLine(s), liveBasic(s), ...registeredCardBadges().map((b) => b(s))].filter(Boolean);
  const hasFolder = folderWorthShowing(s) && folderLast(s);
  return h(`article.card.st-${st.key}`, linkProps(s, `${nameOf(s)}${multi ? ` on ${s.machineLabel}` : ''}: ${st.text}`),
    h('div.card-top', h('h3.card-name', nameOf(s)), chip(s)),
    h('div.card-where',
      toolChip(s),
      h('span.cw', icon(s.kind === 'chat' ? 'text' : 'terminal', { size: 14 }), whereWord(s)),
      multi && s.machineLabel ? h('span.cw', s.machineLabel) : null,
      s.profile ? h('span.cw.cw-provider', profileText(s)) : null,
      hasFolder ? h('span.cw.card-path', { title: s.short || null }, icon('folder', { size: 14 }), h('span.card-path-text', folderLast(s))) : null),
    extra.length ? h('div.card-meta', extra) : null,
    said ? h('p.card-msg', by ? [h('strong.card-by', `${by}: `), said] : said) : null,
    // A held act: show what the wall held (web/handsoff.js) in place of the short note, so the owner sees the whole
    // act before Allow, here on Home too and not only on the session page.
    st.key === 'attention' && s.held ? heldActCard(s.held) : st.key === 'attention' && s.note ? h('p.card-note', askNote(s.note)) : st.key === 'failed' && s.note ? h('p.card-note', s.note) : null,
    // Refused as root: what to do next, in plain words.
    st.key === 'failed' && rootRefusedNext(s.note) ? h('p.card-note.card-next', rootRefusedNext(s.note)) : null,
    // A command still running in the background while it waits for the owner (web/lib.js): the state stays
    // Finished, this adds the one line that says a command may carry on by itself.
    bgCommandNote(s) ? h('p.card-note.card-bg-note', bgCommandNote(s)) : null,
    // Answered right here, the same answers as the session page's banner.
    permissionActions(s, refresh),
    replyBox(s, refresh),
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
      h('span.si-meta', toolChip(s), provider(s), where ? h('span.si-where', icon('folder', { size: 13 }), where) : null, extrasLine(s), liveBasic(s)),
      lastLine(s) ? h('span.row-sub.si-msg', lastLine(s)) : null,
      st.key === 'attention' && s.held ? heldActCard(s.held) : st.key === 'attention' && s.note ? h('span.si-note', askNote(s.note)) : st.key === 'failed' && s.note ? h('span.si-note', s.note) : null,
      bgCommandNote(s) ? h('span.row-sub.si-bg-note', bgCommandNote(s)) : null,
      permissionActions(s, refresh),
      limitBox(s, profiles, after),
      backButton(s, profiles, after)),
    h('span.row-end', icon('chevronRight', { size: 18 })));
}

/** Claude Code's words when it refuses bypass permissions mode as root (CLAUDE_ROOT_REFUSAL in src/setup/rootfacts.mjs). */
export const ROOT_REFUSAL_WORDS = 'cannot be used with root/sudo privileges';

/** The next step after a start that Claude Code refused as root, or null for any other reason. */
export const rootRefusedNext = (note) => (String(note || '').includes(ROOT_REFUSAL_WORDS)
  ? 'Start it again in a mode that asks (Manual or Accept edits), or move Hoprig to an ordinary user in Settings → Runs as root.'
  : null);
