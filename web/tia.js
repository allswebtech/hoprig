// Tia, the assistant: her page (#/tia: Chat, #/tia/jobs, #/tia/activity) and Settings → Tia. Everything here talks
// to this dashboard ("~/api/assistant/…"): Tia lives on the computer whose page this is, and reaches the others
// herself. Text from Tia, sessions and folders is only ever set as text.
//
// The chat: messages scroll above a message box that stays at the bottom of the window; while Tia works a line says
// what she is doing; a confirm card asks in plain words (the accounts' display names, what it costs, why she asks)
// and, once decided, shows what happened. Styles: page-automations.css (every class starts with "tia-").
import { money } from './chat/words.js';
import { icon } from './icons.js';
import { BARE, add, api, btn, confirmSheet, copyText, fill, h, prefs, toast, url } from './lib.js';
import { navChanged, registerHeadTool, registerPage, registerSessionAction, registerSettingsPage } from './registry.js';
import { fold, saveBar, tabBar, toggle } from './shell.js';
import { modelPicker } from './modelpicker.js';
import { leadSwitch } from './leadswitch.js';
import { store } from './store.js';
import { knownChatTools } from './chat/start.js';
import { keepTabIn } from './tabwrap.js';
import { composerControls, micButton, speech, touchScreen } from './voice.js';
import { byTiaList, tiaAloneFold } from './operator-tia.js';
import { missionLimits } from './mission.js';
import { activityRows, activityWords, continuesOf, sessionWords, stamp, workCardWords } from './tiaactivity.js';
import { DID, TOOL_WORDS, doingLine, jobChip, wordFor } from './tiawords.js';
import { cardElement, closeChoice, formFields } from './tiacards.js';
import { messageView, turnVoice } from './tiamsg.js';

const NAME = 'Tia';
// The line a card carries when her text had characters nobody can see (src/assistant/fence.mjs HIDDEN_REMOVED, the same words).
export const HIDDEN = 'Hidden characters were removed from this text.';
const A = '~/api/assistant';

const JOB_WORDS = { working: 'Working', waiting: 'Waiting for you', done: 'Done', stuck: 'Stuck', stopped: 'Stopped' };
const JOB_PILL = { working: 'st-working', waiting: 'st-waiting', done: 'st-starting', stuck: 'st-limit', stopped: 'st-starting' };
// Three things to ask, for the empty chat: each is sent as it is when tapped.
export const EXAMPLES = [
  'What needs me?',
  'What is running?',
  'Start a new project',
];
// The line under her page's title, for a person who is not a programmer. Paid use asks him first except at Hands off
// within the daily limit he set (levelShort.handsoff, src/assistant/spend.mjs): the line says so, never "always asks".
// The one line under her page's title: short, and it still keeps the promise (the whole sentence is SUBTITLE).
export const HEAD_LINE = 'Say what to do. She asks before anything risky.';
export const SUBTITLE = `Tell ${NAME} what you want done, in your own words. She asks you before anything risky, and before paid use unless you chose Hands off with a daily limit for it (Settings → ${NAME}).`;
/** Her **bold** words as bold, everything else as plain text (never as HTML). */
export const boldText = (text) => String(text).split(/\*\*([^*\n]+)\*\*/).map((part, i) => (i % 2 ? h('strong', part) : part));
const when = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// At zero the same words as the line under the buttons ("This ran out"): one state, one word. A time that is not a
// number (a card with no expiresAt) is ran out too, as expireCard takes it: never "NaN:NaN left" beside "This ran out".
export const mmss = (ms) => (!(ms > 0) ? 'ran out' : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} left`);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

// ---------- the navigation item: a badge with the cards waiting (registry.js) ----------
let lastOverview = null;
let painted = '';
function paintTab() {
  if (!lastOverview) return;
  const now = `${lastOverview.enabled !== false}|${(lastOverview.cards || []).length}`;
  if (now !== painted) {
    painted = now;
    navChanged();
  }
}
async function pollOverview() {
  try {
    lastOverview = await api(`${A}`);
  } catch {
    /* logged out or offline: keep the last */
  }
  paintTab();
  paintBox();
}
// Not inside a window of the desktop (lib.js BARE): Tia's button there is the desktop's, which polls for itself, and
// without an overview the box and the head button stay away.
if (typeof window !== 'undefined' && typeof location !== 'undefined' && !location.pathname.startsWith('/login') && !BARE) {
  pollOverview();
  setInterval(pollOverview, 8000);
  // The frame is drawn again on every route: put the badge back each time.
  const app = document.getElementById('app');
  if (app) new MutationObserver(() => paintTab()).observe(app, { childList: true });
  window.addEventListener('hashchange', () => setTimeout(paintTab, 0));
}

// ---------- confirm cards in plain words ----------

/**
 * The words of a card for the owner, made from its tool and input (the lines the model saw stay as they are, so
 * nothing changes for Tia herself). `accounts`: [{ name, label, kind }] of the computer the card is about;
 * `computerLabel`: its name, or null for this computer; `tools`: how many coding tools are on there; `chat(name)`: a
 * session in words (a chat by its title or folder). Returns { question, quote, quoteBy (what the quote is, or null),
 * notes: [sentences], why, details }.
 */
export function plainCard(card, { accounts = [], computerLabel = null, tools = 1, chat = (n) => sessionWords(n) } = {}) {
  const a = card.input || {};
  const lines = (card.lines || []).map(String);
  const acct = (n) => accounts.find((x) => x.name === n);
  const label = (n) => (n === 'auto' ? 'Auto mode' : (acct(n) && acct(n).label) || n);
  const on = computerLabel ? ` on ${computerLabel}` : '';
  // The words of Activity (tiaactivity.js), so a card and its row there say the same thing.
  const words = activityWords({ tool: card.tool, input: a }, { provider: label, computer: () => computerLabel, chat, tools }).what;
  const whyRaw = (lines.find((l) => l.startsWith('Why a card: ')) || '').slice('Why a card: '.length);
  const notes = [];
  let question;
  let quote = null;
  let quoteBy = null;
  let target = null;
  const work = card.tool === 'manage_work' && card.view ? workCardWords(card.view, a, { provider: label, on }) : null;
  if (work) {
    ({ question, quote, quoteBy } = work);
    notes.push(...work.notes);
    if (a.action === 'start') target = a.account; // a paid provider says so below
  } else if (card.tool === 'switch_account') {
    const m = lines.map((l) => /^Move session .* from (\S+) to (\S+)$/.exec(l)).find(Boolean);
    const from = m && m[1] !== 'null' ? m[1] : null;
    target = a.account || (m && m[2]);
    question = `Move the session ${a.session}${on}${from ? ` from ${label(from)}` : ''} to ${label(target)}?`;
    notes.push('The conversation carries on there where it stopped.');
    if (lines.some((l) => /is itself at a usage limit/.test(l))) notes.push(`${label(target)} is at its usage limit right now too.`);
  } else if (card.tool === 'start_session' || card.tool === 'start_chat') {
    target = a.account;
    // What starts, in the owner's words: a chat or a terminal, and which coding tool (always for a terminal or another
    // coding tool than Claude Code; for a chat of Claude Code when more than one is on).
    question = `${cap(words)}?`;
    if (a.message) quote = a.message;
    if (a.goal) notes.push(`Done when: ${a.goal}.`);
    // On an earlier conversation it is never hers (src/assistant/chats.mjs, tools.mjs): its OKs stay the owner's.
    if (continuesOf(a)) notes.push(`It goes on with that conversation's history, so every OK it asks for comes to you, not to ${NAME}.`);
  } else if (card.tool === 'send_to_session' && (a.continue || a.to_chat)) {
    // The two acts of send_to_session that type nothing of hers (src/assistant/tools.mjs).
    question = a.continue ? `Carry on in the session ${a.session}${on} after its usage limit, on the same provider?` : `Open the session ${a.session}${on} as a chat too?`;
    if (a.to_chat) notes.push('The terminal keeps running; the chat is yours, not hers.');
  } else if (card.tool === 'send_to_session' && a.key === undefined) {
    question = `Type this into the session ${a.session}${on}?`;
    quote = a.text;
  } else if (card.tool === 'send_to_chat' && (a.name !== undefined || a.close || a.terminal)) {
    question = a.name !== undefined ? `Rename ${chat(a.session)}${on}?` : a.close ? `Archive ${chat(a.session)}${on}?` : `Open ${chat(a.session)}${on} in a terminal session?`;
    if (a.name !== undefined) quote = a.name;
    // The App calls this act Archive (web/chat/sidebar.js): the same word and what it does.
    if (a.close) notes.push('It stops if it is working and leaves the list. Its conversation is kept: continue it from Archived in the list of sessions.');
    if (a.terminal) notes.push('The chat closes; the conversation goes on in the terminal.');
  } else if (card.tool === 'send_to_chat') {
    const words = { allow: 'Allow', allow_always: 'Allow, and not ask again in this session,', deny: 'Say no to' };
    question = a.stop ? `Stop the reply in ${chat(a.session)}${on}?` : a.answer ? `${words[a.answer] || a.answer} what ${chat(a.session)}${on} asks?` : `Send this to ${chat(a.session)}${on}?`;
    if (a.text !== undefined) quote = a.text;
  } else if (card.tool === 'press_key' || card.tool === 'send_to_session') {
    question = `Press ${a.key} in the session ${a.session}${on}?`;
  } else if (card.tool === 'stop_session') {
    question = `Stop the session ${a.session}${on}?`;
    notes.push('Its conversation is kept; you can continue it later.');
  } else if (card.tool === 'run_command') {
    // An administrator command carries a form whose "Runs as administrator" row shows the argv, so the question says
    // only that it is an administrator command, and drops the quote so the command is not asked about twice. The
    // computer is named the way every other card names it: nothing for this computer, the machine's label for another
    // (`on`), not the raw id the form was built with on the server. A plain command has no form: its own question and quote.
    if (card.form) {
      question = `Run an administrator command${on}?`;
    } else {
      question = `Run this command${on}${a.folder ? ` in ${a.folder}` : ''}?`;
      quote = a.command;
    }
  } else if (card.tool === 'draft_skill') {
    question = `Add the skill "${a.name}"?`;
  } else {
    question = words !== 'make a change' ? `${cap(words)}?` : `${cap(wordFor(TOOL_WORDS, card.tool, a.action) || 'make a change')}${on}?`;
  }
  // Her text had characters nobody can see: the dashboard took them out at its door (src/assistant/fence.mjs
  // HIDDEN_REMOVED) before the card was made, and the card says so first, so an attempt is seen and not silently mended.
  if (lines.includes(HIDDEN)) notes.unshift(HIDDEN);
  const asks = lines.find((l) => l.startsWith('The session asks: '));
  if (asks) notes.push(`The session asks: ${asks.slice('The session asks: '.length)}`);
  const paid = target && acct(target) && acct(target).kind === 'api';
  if (paid) notes.push(`${label(target)} is paid per use, so the work from here on costs money.`);
  const why = work && !whyRaw ? `${NAME} always asks you first on the Work page.`
    : /paid per token/.test(whyRaw) ? `${NAME} asks because it costs money.`
    : /did not start/.test(whyRaw) ? `${NAME} asks because she did not start this session.`
      : /"Ask me"/.test(whyRaw) ? `${NAME} asks because you chose "Ask me" in Settings → ${NAME}.`
        : whyRaw ? `${NAME} asks because ${whyRaw.replace(/\.$/, '')}.`
          : `${NAME} asks before anything risky.`;
  // What the plain words above do not already say (other tools' own lines), for "Details".
  const said = ['switch_account', 'start_session', 'start_chat', 'send_to_session', 'send_to_chat', 'press_key', 'run_command'].includes(card.tool);
  // The id of the conversation a start goes on with stays in Details: the question says only "an earlier conversation".
  // A Work card's quote (the brief, the session's report, the owner's words of a send-back) is not said twice there (the
  // send-back's words are their own line, the same value as the quote: her input is cleaned once, at the door).
  const details = said ? lines.filter((l) => l.startsWith('Continuing conversation '))
    : lines.filter((l) => l !== HIDDEN && !l.startsWith('Why a card: ') && !l.startsWith('The session asks: ') && !(work && l.startsWith('This task was added by another program, the Work token ')) && !(work && quote && (l.startsWith('Brief: ') || l.startsWith('The session wrote: ') || l === quote)));
  return { question, quote, quoteBy, notes, why, details };
}

/**
 * What the page knows of computer `c` ("this" or none: this one), for her words: its providers and name, its sessions
 * (a chat by its title or folder), how many coding tools are on there.
 */
function placeAt(c) {
  const other = !!c && c !== 'this';
  const m = (other ? store.all.find((x) => x.machine === c) : store.all.find((x) => !x.machine)) || null;
  const accounts = (m && m.profiles) || [];
  const sessions = (m && m.sessions) || [];
  return {
    accounts,
    computerLabel: other ? (m && m.machineLabel) || c : null,
    tools: knownChatTools(other ? c : null).length,
    provider: (n) => (n === 'auto' ? 'Auto mode' : (accounts.find((x) => x.name === n) || {}).label || n),
    computer: (n) => (!n || n === 'this' ? null : (store.all.find((x) => x.machine === n) || {}).machineLabel || n),
    chat: (n) => sessionWords(n, sessions),
  };
}
/** The accounts, the name, the coding tools and the chats of the computer a card is about. */
const placeOf = (card) => placeAt(card.input && card.input.computer);
/** A job's chat by its title, as the page's list has it now (null: not known, or not a chat). */
const chatTitle = (s) => {
  const m = s.computer && s.computer !== 'this' ? store.all.find((x) => x.machine === s.computer) : store.all.find((x) => !x.machine);
  const c = m && (m.sessions || []).find((x) => x.name === s.session && x.kind === 'chat');
  return (c && typeof c.title === 'string' && c.title.trim()) || null;
};

/** The one kind of link a confirmed card may open: a sheet of the Workspace page, here or on another computer. */
const SHEET_LINK = /^#(\/m\/[a-z0-9][a-z0-9_-]{0,31})?\/workspace\?(drop|group)=[^#\s]{1,600}$/;

function cardView(card, decided) {
  const p = plainCard(card, placeOf(card));
  const left = h('span.badge.soft.tia-left');
  const result = h('p.tia-card-result', { role: 'status' });
  const form = card.form ? formFields(card.form) : null;
  const decide = (how) => async (e) => {
    const box = e.target.closest('.tia-card');
    const hadFocus = box.contains(document.activeElement); // a disabled button drops it; it comes back after (decided)
    box.querySelectorAll('button').forEach((b) => (b.disabled = true));
    result.textContent = how === 'confirm' ? 'Doing it…' : 'Declining…';
    let outcome;
    try {
      const values = how === 'confirm' && form ? form.values() : {};
      const r = await api(`${A}/cards/${card.id}/${how}`, { ...(Object.keys(values).length ? { values } : {}), made: card.createdAt });
      // Her card opened a sheet of the Workspace page (a drop, a group): only such a link is followed; he acts there.
      if (how === 'confirm' && r && typeof r.open === 'string' && SHEET_LINK.test(r.open)) {
        location.hash = r.open;
        outcome = { ok: true, text: `The sheet is open on the Workspace page: you answer and press there. ${NAME} did nothing herself.` };
      } else outcome = how === 'confirm' ? { ok: true, text: `Done. ${NAME} was told, and carries on.` } : { ok: true, text: `Declined. Nothing was changed; ${NAME} was told.` };
    } catch (err) {
      // A wrong password ran nothing and the card stays open: say so beside the password box, clear it and let him
      // type it again, rather than closing the card and sending him back to Tia.
      if (how === 'confirm' && err.code === 'wrong-password') {
        // The server reset the card's time (it stays open for another try), so match the countdown to the new window:
        // otherwise it keeps counting down from the old expiry and can read 'expired' while the retyped password still works.
        if (err.data && Number.isFinite(err.data.expiresAt)) {
          card.expiresAt = err.data.expiresAt;
          tick();
        }
        box.querySelectorAll('button').forEach((b) => (b.disabled = false));
        result.textContent = 'The password was wrong. Nothing ran. Type it again.';
        const pw = box.querySelector('input[type="password"]');
        if (pw) {
          pw.value = '';
          pw.focus();
        }
        return;
      }
      // A card from before a restart: the server's own sentence says why and what to do, whole.
      outcome = { ok: false, text: err.code === 'before-restart' ? err.message : `It did not run: ${err.message}. Ask ${NAME} again if you still want it.` };
    }
    decided(card, p, how, outcome, hadFocus);
  };
  const ok = btn('primary', { icon: 'check', label: 'Confirm', onclick: decide('confirm') });
  const no = btn('secondary', { icon: 'x', label: 'Decline', onclick: decide('reject') });
  // The countdown; at zero the card has run out: both buttons off (the server would refuse them anyway).
  const wait = h('span.tia-card-wait', ' Nothing happens until you confirm.');
  const tick = () => {
    const ms = card.expiresAt - Date.now();
    left.textContent = mmss(ms);
    expireCard({ buttons: [ok, no], result, wait }, ms);
  };
  tick();
  const timer = setInterval(() => (document.body.contains(left) ? tick() : clearInterval(timer)), 1000);
  return h('div.tia-card', { role: 'group', 'aria-label': `${NAME} asks for your OK`, 'data-card': card.id },
    h('div.tia-card-head', h('span.tia-card-icon', icon('alert', { size: 18 })), h('h3.tia-card-q', p.question), left),
    p.quote && p.quoteBy ? h('p.tia-card-text', p.quoteBy) : null,
    p.quote ? h('blockquote.tia-card-quote', p.quote) : null,
    form ? form.el : null,
    p.notes.length ? h('p.tia-card-text', p.notes.join(' ')) : null,
    h('p.tia-card-why', p.why, wait),
    p.details.length ? h('details.tia-card-details', h('summary', 'Details'), h('ul', p.details.map((l) => h('li', l)))) : null,
    h('div.tia-card-actions', ok, no, result));
}

/**
 * A card whose time ran out (`ms` left, 0 or less): nothing can be confirmed or declined any more, and the card says
 * so in place of its buttons' result; its "Nothing happens until you confirm" (`wait`) asks for what he can no longer
 * do, so it says what is true now. → true when it ran out.
 */
export function expireCard({ buttons, result, wait = null }, ms) {
  if (ms > 0) return false;
  for (const b of buttons) b.disabled = true;
  if (wait) wait.textContent = ' Nothing happened.';
  result.textContent = `This ran out. Ask ${NAME} again.`;
  return true;
}

/** A card after the owner decided: what happened, in one line, for a little while. */
const decidedView = (d) => h(`div.tia-card.decided${d.outcome.ok ? '' : '.failed'}`, { role: 'status', 'data-card': d.id, tabindex: '-1' },
  h('div.tia-card-head', h('span.tia-card-icon', icon(d.outcome.ok ? (d.how === 'confirm' ? 'check' : 'x') : 'alert', { size: 18 })), h('h3.tia-card-q', d.question)),
  h('p.tia-card-text', d.outcome.text));

// ---------- the page ----------
// ---------- the chat: one part, on the Tia page and in the chat box of every page ----------

/** Which page the owner is looking at, made by the page itself (never typed): sent with each message. */
function pageContext() {
  const m = /^#(?:\/m\/([a-z0-9][a-z0-9_-]{0,31}))?\/([a-z][a-z0-9-]*)?(?:\/([^?]*))?/.exec(location.hash || '#/') || [];
  const rest = m[3] ? decodeURIComponent(m[3]).split('/') : [];
  // "computer/setup": a page and its part as one id; what follows (a project, an account) as the detail.
  const part = rest.length && /^[a-z0-9-]{1,30}$/.test(rest[0]) ? rest.shift() : null;
  return {
    page: `${m[2] || 'home'}${part ? `/${part}` : ''}`,
    sub: rest.length ? rest.join('/').slice(0, 80) : undefined,
    computer: m[1] || undefined, // another computer by its id; none means this one
  };
}

/**
 * The conversation in `host`: messages, the working line, confirm cards and the message box. `scrollEl`: what
 * scrolls (the chat box), or null for the page. `fresh`: start a new conversation. Returns { stop, quiet (stop listening) }.
 */
function chatPanel(host, { scrollEl = null, fresh = false } = {}) {
  let es = null;
  let pollTimer = null;
  let on = true;
  const stop = () => {
    on = false;
    if (es) es.close();
    clearTimeout(pollTimer);
    mic.dispose(); // the microphone never listens for a panel that is gone
    speech.stop();
  };
  const list = h('div.tia-chat', { 'aria-live': 'polite' });
  const cardsBox = h('div.tia-cards');
  const working = h('p.tia-working', { role: 'status', hidden: true });
  const err = h('div.tia-error', { role: 'alert' });
  const input = h('textarea.field.tia-input', { rows: 1, placeholder: `Ask ${NAME} to get something done…`, 'aria-label': `Message to ${NAME}` });
  const send = btn('primary icon tia-send', { icon: 'send', title: 'Send', type: 'submit' });
  // Speak instead of typing: the words go into the box, and he sends them (voice.js).
  // The line under it takes room from the chat: a card waiting for an OK is kept in sight (toBottom).
  // Here (and only here) a spoken message is sent by itself after a short pause, and her answer to it is read aloud.
  let placed = false; // the controls exist: the microphone's first look comes before them
  const mic = micButton(input, { noted: () => toBottom(), auto: () => submit(), speaks: true, onState: () => place() });
  const form = h('form.tia-composer', { onsubmit: (e) => { e.preventDefault(); submit(); } }, input, mic.el, send);
  placed = true;
  const voice = turnVoice();
  // On a phone one control sits beside the box: the microphone while it is empty, Send once there is text.
  function place() {
    if (!placed) return;
    const c = composerControls({ touch: touchScreen(), empty: !input.value.trim(), state: mic.state() });
    mic.el.style.display = c.mic ? '' : 'none';
    send.style.display = c.send ? '' : 'none';
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && innerWidth > 700) {
      e.preventDefault();
      submit();
    }
  });
  // The box grows with what is typed, up to a few lines.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, 180)}px`;
    place();
  });
  // Cards sit right above the message box, where the eye is, also after the chat scrolled down.
  const newPill = h('button.tia-newpill', { type: 'button', hidden: true, onclick: () => { newPill.hidden = true; toBottom(); } }, icon('down', { size: 15 }), h('span', 'New messages'));
  // Where "New chat started" is said (newChatWhere): on a phone right above the message box, which stays in sight
  // when the view moves to a waiting card (toBottom); never over the box. It goes with his first message.
  const said = newChatWhere(fresh, covers());
  const newChatLine = said === 'chat' ? h('p.tia-note.tia-newchat', { role: 'status' }, 'New chat started.') : null;
  fill(host, h('div.tia-chatwrap', list, working, cardsBox, h('div.tia-dock', newPill, newChatLine, err, mic.note, form)));
  const scroller = () => scrollEl || document.scrollingElement || document.documentElement;
  // Near the bottom (within a line or two): new messages keep it there.
  const atBottom = () => {
    const el = scroller();
    const view = scrollEl ? el.clientHeight : innerHeight;
    return el.scrollHeight - el.scrollTop - view < 80;
  };
  (scrollEl || window).addEventListener('scroll', () => { if (!newPill.hidden && atBottom()) newPill.hidden = true; }, { passive: true });
  // The conversation open last time; on a first visit the newest one ("" means the owner started a new chat).
  const saved = convGet();
  let conv = fresh ? null : saved === null ? ((lastOverview && lastOverview.conversations && lastOverview.conversations[0]) || {}).id || null : saved || null;
  let next = 0;
  let tools = null; // the chip row of the current answer
  let lastAt = null; // the time of the message before, for the day's first message
  let lastOwnerText = ''; // his last message: the notice it brought has a "Use …" button that sends it again
  let lastNotice = null; // a notice that is her newest word: kept in sight (toBottom)
  let lastOwner = null; // his last message, for Try again
  let primed = false; // the conversation's history was drawn once
  const decidedCards = new Map(); // card id → { question, how, outcome, at }
  const known = new Map(); // card id → its question, for the line in the chat once it is decided

  // To the newest message; but a card waiting for an OK is never left with its question out of sight: when the chat
  // ends below its top (a tall card, a short phone screen), the view moves up to the card's top, under the head and
  // the tabs that stay at the top.
  const toBottom = () => requestAnimationFrame(() => {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
    const covered = scrollEl ? scrollEl.getBoundingClientRect().top : Math.max(0, ...[...document.querySelectorAll('.pagehead, .tia-tabs')].map((x) => x.getBoundingClientRect().bottom));
    // Her newest word is a notice (she did not answer, and why): it is her reply to his message, so it is kept in
    // sight before the cards that wait under it (on a phone they can fill the whole window).
    const shown = lastNotice && lastNotice.isConnected ? lastNotice : [...cardsBox.querySelectorAll('.tia-card:not(.decided)')].pop();
    if (!shown) return;
    const gap = shown.getBoundingClientRect().top - covered - 8;
    if (gap < 0) (scrollEl || document.scrollingElement || document.documentElement).scrollTop += gap;
  });
  const busy = (text) => {
    working.hidden = !text;
    fill(working, text ? [h('span.tia-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', `${NAME} is ${text}…`)] : null);
  };
  const empty = () => fill(list, h('div.tia-empty',
    h('span.tia-off-icon', icon('sparkle', { size: 26 })),
    h('h2.tia-off-title', `Hi, I am ${NAME}.`),
    h('p', 'Tell me what to get done: I start sessions in your projects, answer their questions, check the result and tell you when it is done. Try one:'),
    h('div.tia-examples', EXAMPLES.map((x) => h('button.tia-example', { type: 'button', onclick: () => { input.value = x; submit(); } }, icon('send', { size: 15 }), h('span', x))))));

  function render(e) {
    const aloud = voice.see(e);
    if (aloud) speech.speak(aloud);
    if (e.kind !== 'notice') lastNotice = null;
    // A notice answered since (his next message, also the one "Use …" sent, or her words) has no "Use …" any more: the
    // same on a reload, where the history is drawn again, so his message is never sent twice from one notice.
    if (endsNotice(e)) for (const b of list.querySelectorAll('.tia-notice-use')) b.remove();
    if (e.kind === 'owner') {
      tools = null;
      busy('thinking');
      // A question she asked with answers is closed by his next message: answered when it is one of them, else closed.
      for (const q of list.querySelectorAll('.tia-c-choice:not(.answered)')) closeChoice(q, e.text, e.choice);
      lastOwnerText = e.text;
      const row = messageView('owner', e.text, { at: e.at, before: lastAt });
      lastAt = e.at;
      return add(list, row);
    }
    if (e.kind === 'text') {
      tools = null;
      const row = messageView('tia', e.text, { at: e.at, before: lastAt });
      // Her words carry their number: Work's progress lines hide the ones that held a figure of her own.
      const said = row.querySelector('.tia-msg.tia');
      if (said) said.dataset.i = String(e.i);
      lastAt = e.at;
      row.dataset.i = String(e.i); // the progress check finds her answer by it (progressAnswerOf)
      return add(list, row);
    }
    if (e.kind === 'tool_call') {
      if (!tools) {
        tools = h('div.tia-tools');
        add(list, tools);
      }
      // Her work in plain words; a tool this page has no words for is "working on it", never its inside name.
      const doing = doingLine(e.tool, e.input && e.input.action);
      busy(doing);
      const arg = e.input && (e.input.session || e.input.folder || e.input.query || e.input.job || '');
      return add(tools, h('span.tia-tool', { id: `tc-${e.id}`, 'data-tool': e.tool, 'data-action': (e.input && (e.input.action || (Array.isArray(e.input.options) ? 'ask' : ''))) || '' }, icon('zap', { size: 13 }), h('span', `${cap(doing)}${arg && !/^j_/.test(arg) ? ` · ${short(arg)}` : ''}`)));
    }
    if (e.kind === 'tool_result') {
      const chip = list.querySelector(`#tc-${CSS.escape(e.id)}`);
      if (chip) {
        const [t, act] = [chip.dataset.tool, chip.dataset.action];
        const would = wordFor(TOOL_WORDS, t, act);
        const words = e.card ? 'waits for your OK' : e.isError ? `could not ${would && !/^(looked|read)/.test(would) ? would : 'do it'}` : wordFor(DID, t, act) || 'done';
        chip.classList.add(e.card ? 'card' : e.isError ? 'err' : 'ok');
        chip.lastChild.textContent = cap(words);
        chip.title = e.summary || '';
      }
      if (e.card) {
        busy('waiting for your OK on the card above');
        refreshCards();
      }
      // The card the result shows (made by the server from what the tool did; tiacards.js draws it as text).
      return showView(e.view);
    }
    if (e.kind === 'wake') return add(list, h('p.tia-note', `${when(e.at)} · a session in her job ${e.reason === 'needs_ok' ? 'asks for permission' : e.reason === 'notice' ? 'asks you something before it starts' : e.reason === 'limit' ? 'reached a usage limit' : e.reason === 'ended' ? 'ended' : e.reason === 'expired' ? 'ran past the time allowed' : 'is waiting'}`));
    if (e.kind === 'card') {
      // Her question as she asked it ("Start a chat in shop?"), after what came of it: a question stays a question.
      const q = known.get(e.card);
      const asked = q ? ` ${NAME} asked: ${q}` : '';
      const said = {
        done: `You confirmed, and it is done.${asked}`,
        failed: `You confirmed, but it did not run${e.error ? ` (${e.error})` : ''}.${asked}`,
        rejected: `You declined.${asked}`,
        expired: `Nobody answered in time, so nothing was done.${asked}`,
        stale: `Not done, because things changed since ${NAME} asked.${q ? ` She asked: ${q}` : ''}`,
      }[e.status] || `${NAME}'s request: ${e.status}.`;
      add(list, h('p.tia-note', said));
      return showView(e.view);
    }
    if (e.kind === 'progress') {
      // Work's progress as the tool gave it: the answer, made by code. Her words of the turn are hidden when they held
      // a figure the tool did not give.
      for (const i of e.hides || []) {
        const m = list.querySelector(`.tia-msg.tia[data-i="${Number(i)}"]`);
        if (m) (m.closest('.tia-row') || m).hidden = true;
      }
      return add(list, h('div.tia-msg.tia.tia-progress', { role: 'status' },
        h('p.tia-progress-head', e.replaced ? `${NAME}'s answer had a figure Work did not give, so here is what Work says:` : 'What Work says:'),
        h('pre.tia-progress-lines', (e.lines || []).join('\n'))));
    }
    if (e.kind === 'notice') {
      // She did not answer: nothing is thinking any more.
      busy(null);
      // The page's banner says the same sentence: from now on the chat says it, once.
      if (e.code === 'subs-limited' && typeof document.querySelectorAll === 'function') for (const b of document.querySelectorAll('.tia-ready[data-code="subs-limited"]')) b.remove();
      tools = null;
      // "Use …" sends again the message THIS notice came of, and only from the newest notice: an older one's button
      // goes, so one message is never sent twice from two notices. A notice of a job's wake-up has no message of his.
      const text = resendText(e, lastOwnerText);
      for (const b of list.querySelectorAll('.tia-notice-use')) b.remove();
      // The server sends his message again once per notice (`again`: its number), also from two pages at once.
      const row = noticeView(e, { resend: text ? (name) => useAndResend(name, text, {
        save: async (patch) => {
          await api(`${A}/settings`, patch);
          pollOverview();
        },
        send: (words) => submit({ text: words, again: e.i }),
      }) : null, back: text && conv ? `${conv}.${e.i}` : null });
      lastNotice = row;
      return add(list, row);
    }
    if (e.kind === 'done') {
      tools = null;
      busy(null);
      if (!e.ok) {
        // What failed, and one tap to send his last message again.
        const again = lastOwner;
        return add(list, h('div.banner.error-box.tia-stopped', { role: 'alert' }, icon('alert', { size: 18 }),
          h('span', `${NAME} could not finish her answer: ${e.error || 'something went wrong'}. If it keeps happening, check her provider in `, h('a', { href: '#/settings/tia' }, `Settings → ${NAME}`), '.'),
          again ? btn('secondary small tia-again', { icon: 'refresh', label: 'Try again', onclick: (ev) => { ev.currentTarget.disabled = true; input.value = again; submit(); } }) : null));
      }
      return Number.isFinite(e.costUsd) && e.costUsd > 0 ? add(list, h('p.tia-note', `This answer cost ${money(e.costUsd)}`)) : null;
    }
    return null;
  }
  function showView(view) {
    if (!view) return null;
    const el = cardElement(view, { answer: async (text, choice) => {
      if (send.disabled) return false;
      input.value = text;
      await submit({ choice });
      return input.value === '';
    } });
    return el ? add(list, h('div.tia-row.tia.tia-cardrow', el)) : null;
  }
  const renderAll = (events) => {
    // The first draw of a conversation (a reload, another device) is not "new": it opens at the newest message.
    const stick = !primed || atBottom();
    primed = true;
    let added = false;
    for (const e of events) {
      if (e.kind === 'owner') lastOwner = e.text;
      if (render(e)) added = true;
    }
    // The view stays at the newest message unless he scrolled up to read: then a pill says that more came.
    if (stick || !added) toBottom();
    else newPill.hidden = false;
  };

  function follow() {
    if (!on || !conv) return;
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(url(`${A}/stream?conversation=${encodeURIComponent(conv)}&from=${next}`));
      es.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.i < next) return;
        next = e.i + 1;
        renderAll([e]);
      };
      es.onerror = () => {
        // The stream drops on a restart or a sleeping phone: fall back to polling until it comes back.
        es.close();
        es = null;
        poll();
      };
    } else poll();
  }
  async function poll() {
    if (!on || !conv) return;
    try {
      const r = await api(`${A}/chat/${encodeURIComponent(conv)}?from=${next}`);
      if (!on) return;
      renderAll(r.events);
      next = r.next;
      if (!r.busy) busy(null);
    } catch (e) {
      if (e.status === 404) {
        // The dashboard restarted (conversations are kept until then): say so, and leave no card of it on screen.
        convSet('');
        conv = null;
        decidedCards.clear();
        fill(cardsBox, null);
        empty();
        return add(list, h('p.tia-note.tia-gone', { role: 'status' }, `The dashboard restarted, so this conversation is closed. What ${NAME} did is under Activity; ask again to go on.`));
      }
    }
    pollTimer = setTimeout(follow, 3000);
  }
  // The focus inside the cards survives a redraw: on the same card (now what came of it), else the next card, else the
  // message box; a keyboard never starts again at the top of the page. `focus`: the card just decided from the keys.
  async function refreshCards({ focus = null } = {}) {
    try {
      const r = await api(`${A}/cards`);
      if (!on) return;
      for (const c of r.cards) known.set(c.id, plainCard(c, placeOf(c)).question);
      const recent = [...decidedCards.values()].filter((d) => Date.now() - d.at < 20_000);
      const before = cardsBox.querySelectorAll('.tia-card').length;
      const had = focus || (cardsBox.contains(document.activeElement) && document.activeElement.closest('.tia-card')?.dataset.card);
      fill(cardsBox, recent.map(decidedView), r.cards.filter((c) => !decidedCards.has(c.id)).map((c) => cardView(c, decided)));
      if (had && !cardsBox.contains(document.activeElement)) {
        const to = [...cardsBox.querySelectorAll('.tia-card')].find((x) => x.dataset.card === had) || cardsBox.querySelector('.tia-card:not(.decided) button') || input;
        to.focus({ preventScroll: true });
      }
      // A new card is shown whole, its buttons above the message box.
      if (cardsBox.querySelectorAll('.tia-card').length > before) toBottom();
      if (lastOverview) {
        lastOverview.cards = r.cards;
        paintTab();
      }
    } catch {
      /* next time */
    }
  }
  function decided(card, p, how, outcome, hadFocus) {
    decidedCards.set(card.id, { id: card.id, question: p.question, how, outcome, at: Date.now() });
    refreshCards({ focus: hadFocus ? card.id : null });
    setTimeout(() => on && refreshCards(), 20_500);
  }
  // choice: the id of the choice card whose own box this answer was written in (closeChoice).
  // text: a message sent again as it was (a notice's "Use …" button), leaving what is in the box alone.
  // again: the number of the notice whose message this is (the server sends it once per notice).
  async function submit({ choice = null, text: words = null, again: noticeNo = null } = {}) {
    const again = words;
    const text = (again ?? input.value).trim();
    if (!text) {
      input.focus();
      return;
    }
    // A message he spoke (the box still holds what was heard): her answer is read aloud and the server is told.
    const spoken = again === null && mic.heard();
    speech.stop();
    voice.begin(spoken);
    mic.stop();
    if (newChatLine) newChatLine.remove();
    send.disabled = true;
    fill(err);
    busy('reading your message');
    try {
      const r = await api(`${A}/chat`, { text, conversation: conv || undefined, context: pageContext(), ...(spoken ? { spoken: true } : {}), ...(choice ? { choice } : {}), ...(Number.isInteger(noticeNo) ? { again: noticeNo } : {}) });
      if (again === null) {
        input.value = '';
        input.style.height = '';
        mic.forget();
      }
      if (r.conversation !== conv) {
        conv = r.conversation;
        convSet(conv);
        fill(list);
        next = 0;
        primed = false;
        if (es) es.close();
        follow();
      }
    } catch (e) {
      busy(null);
      voice.begin(false);
      fill(err, h('p.banner.error-box', icon('alert', { size: 18 }), h('span', `${NAME} did not get your message: ${e.message}. Your text is still in the box: press Send to try again.`)));
    } finally {
      send.disabled = false;
      place();
      if (!(spoken && touchScreen())) input.focus(); // a phone's keyboard does not open over a spoken message
    }
  }

  refreshCards();
  if (conv) {
    fill(list, h('div.tia-loading', h('div.spinner', { 'aria-hidden': 'true' })));
    poll().then(() => list.querySelector('.tia-loading')?.remove());
  } else empty();
  if (said === 'toast') toast('New chat started');
  // The box is hidden (closed, or not shown on this page): listening stops, the conversation stays.
  place();
  return { stop, quiet: () => { mic.stop(); speech.stop(); } };
}

// ---------- the chat box: Tia on every page ----------
// The same chat as the Tia page (chatPanel), docked: on a desktop a round button at the bottom right opens it above
// itself; on a phone a small button in the page head opens it full height (the page's own main action keeps the one
// floating place). It stays open while the owner moves between pages (remembered on this device). Not while Tia is
// off, not on her own page, and not over a session's terminal (there it opens from the session's "more" sheet).
const box = { open: prefs.get('tia.box', false), forced: false, chat: null, root: null, body: null, count: null, head: null };
// The page head's button: made with each page head (only the newest is on the page), shown on a phone only.
registerHeadTool(() => {
  const n = h('span.tia-launch-dot.hidden');
  box.head = h('button.icon-btn.tia-headbtn.hidden', { type: 'button', title: `Ask ${NAME}`, 'aria-label': `Ask ${NAME}`, onclick: () => setBox(!box.open) },
    icon('sparkle', { size: 16 }), n);
  box.head.count = n;
  setTimeout(paintBox, 0);
  return box.head;
});
function chatBox() {
  if (box.root) return box;
  box.body = h('div.tia-boxbody');
  box.count = h('span.tia-launch-dot.hidden');
  const restart = (fresh) => {
    box.chat?.stop();
    box.chat = chatPanel(box.body, { scrollEl: box.body, fresh });
  };
  box.panel = h('section.tia-box.hidden', { role: 'dialog', 'aria-label': NAME },
    h('header.tia-boxhead',
      h('span.tia-boxname', NAME),
      btn('icon ghost small', { icon: 'plus', title: 'New chat', onclick: () => { convSet(''); restart(true); } }),
      h('a.btn.icon.ghost.small', { href: '#/tia', title: 'Open the full page', 'aria-label': 'Open the full page', onclick: () => setBox(false) }, icon('external', { size: 16 })),
      btn('icon ghost small', { icon: 'x', title: 'Close', onclick: closeBox })),
    box.body);
  // A desktop: the box floats beside the page, which stays usable, so Tab may go on to the page (as from any other part
  // of it). A phone: the box covers the whole page like a sheet, so Tab stays inside, as in a sheet (tabwrap.js).
  // Escape closes it on both, and the focus goes back to her button.
  keepTabIn(box.panel, { when: covers });
  // What it is follows the width while it is open (a window made narrower, a phone turned): aria-modal says the same.
  if (typeof matchMedia === 'function') matchMedia(COVERS).addEventListener('change', () => box.panel.setAttribute('aria-modal', String(covers())));
  box.panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    closeBox();
  });
  box.launch = h('button.tia-launch', { type: 'button', 'aria-label': `Ask ${NAME}`, title: `Ask ${NAME}`, onclick: () => setBox(!box.open) }, icon('sparkle', { size: 22 }), box.count);
  box.restart = restart;
  box.root = h('div.tia-boxroot.hidden', box.panel, box.launch);
  add(document.body, box.root);
  return box;
}
function setBox(open, { forced = false } = {}) {
  box.open = open;
  box.forced = open && forced;
  if (!forced) prefs.set('tia.box', open);
  if (!open) box.chat?.quiet();
  paintBox();
  if (open) {
    box.panel.setAttribute('aria-modal', String(covers()));
    setTimeout(() => box.panel.querySelector('textarea')?.focus(), 50);
  }
}
/** Whether the open box covers the page (a phone: full height over it, page-automations.css) or floats beside it. */
const COVERS = '(max-width: 899px)';
const covers = () => typeof matchMedia === 'function' && matchMedia(COVERS).matches;
/** Close the box and give the focus back to the button that opened it (the round one, or the page head's on a phone). */
function closeBox() {
  setBox(false);
  const back = [box.launch, box.head].find((b) => b && b.isConnected && b.getClientRects().length);
  if (back) back.focus();
}
function paintBox() {
  if (typeof document === 'undefined' || !lastOverview) return;
  const on = lastOverview.enabled !== false;
  const here = /^#(\/m\/[^/]+)?\/tia(\/|$)/.test(location.hash || '');
  const terminal = document.body.classList.contains('term-mode');
  const n = (lastOverview.cards || []).length;
  if (box.head) {
    box.head.classList.toggle('hidden', !on || here);
    box.head.count.textContent = '';
    box.head.count.classList.toggle('hidden', !n);
    box.head.setAttribute('aria-expanded', String(box.open));
  }
  // While the round button shows, the page keeps the lane under it clear (page-automations.css, body.tia-fab).
  document.body.classList.toggle('tia-fab', on && !here && !terminal);
  if (!on || here || (terminal && !box.forced)) {
    if (box.root) box.root.classList.add('hidden');
    box.chat?.quiet();
    if (box.chat && (!on || here)) {
      box.chat.stop();
      box.chat = null;
    }
    return;
  }
  chatBox();
  box.root.classList.remove('hidden');
  box.root.classList.toggle('over-terminal', terminal);
  box.count.textContent = '';
  box.count.classList.toggle('hidden', !n);
  box.panel.classList.toggle('hidden', !box.open);
  box.launch.setAttribute('aria-expanded', String(box.open));
  if (box.open && !box.chat) box.restart(false);
  if (!box.open && box.chat) {
    box.chat.stop();
    box.chat = null;
  }
}
if (typeof window !== 'undefined' && typeof location !== 'undefined' && !location.pathname.startsWith('/login')) {
  window.addEventListener('hashchange', () => setTimeout(() => {
    if (box.forced && !document.body.classList.contains('term-mode')) box.forced = false;
    paintBox();
  }, 0));
}
// In a session the chat box opens from the "more" sheet (the terminal keeps the corner).
registerSessionAction({
  id: 'tia',
  label: `Ask ${NAME}`,
  sub: 'The assistant: she can start, watch or move sessions for you',
  icon: 'sparkle',
  describe: () => (lastOverview && lastOverview.enabled !== false ? {} : null),
  run: () => setBox(true, { forced: true }),
});

const VIEWS = [['', 'Chat', 'sparkle'], ['jobs', 'Jobs', 'clock'], ['activity', 'Activity', 'text']];

// While Full administrator rights are on, Tia's own page says so in its head, always — on every tab
// (Chat, Jobs, Activity), not only in Settings. Null at Off and at Ask, where his tap still comes before a command.
export function fullHeadBanner(level) {
  if (level !== 'full') return null;
  return h('p.banner.warn.tia-full-head', { role: 'status' }, icon('alert', { size: 18 }),
    h('span', h('strong', 'Full administrator rights are on. '),
      `${NAME} runs administrator commands on this computer with no card. `,
      h('a', { href: '#/settings/tia' }, 'Change this in Settings.')));
}

function viewTia({ frame, sub }) {
  if (!VIEWS.some(([v]) => v === sub)) {
    location.replace('#/tia');
    return () => {};
  }
  let alive = true;
  let rightsLevel = null; // her administrator level on this computer (for the head banner while Full is on)
  const cleanups = [];
  const top = h('div.tia-top');
  const body = h('div.tia-body');
  const tabs = tabBar(`Parts of ${NAME}`, VIEWS.map(([v, label, ic]) => ({ id: v, label, icon: ic, href: v ? `#/tia/${v}` : '#/tia' })), sub);
  tabs.classList.add('tia-tabs');
  const newChat = btn('secondary small', { icon: 'plus', label: 'New chat', onclick: () => {
    convSet('');
    if (sub) location.hash = '#/tia';
    else chatView({ fresh: true });
  } });
  frame({
    title: NAME,
    page: 'tia',
    actions: [newChat],
    intro: HEAD_LINE,
    body: [top, tabs, body],
    fillWindow: !sub, // the chat: messages above, the message box kept at the bottom
  });
  // The tabs stay right under the sticky page head while the messages scroll (page-automations.css .tia-tabs); the
  // head's height changes with the width, so it is measured.
  const head = document.querySelector('.pagehead');
  if (head && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => tabs.style.setProperty('--tia-head', `${head.offsetHeight}px`));
    ro.observe(head);
    cleanups.push(() => ro.disconnect());
  }

  /** On or off, ready or not: off shows one sentence and the way to the setting instead of the page. */
  function paintState(o) {
    const off = o && o.enabled === false;
    tabs.classList.toggle('hidden', off);
    newChat.classList.toggle('hidden', off || !!sub);
    if (off) {
      fill(top, fullHeadBanner(rightsLevel));
      fill(body, h('div.tia-off',
        h('span.tia-off-icon', icon('sparkle', { size: 28 })),
        h('h2.tia-off-title', `${NAME} is off`),
        h('p', `${NAME} starts and watches coding sessions for you.`),
        h('a.btn.primary', { href: '#/settings/tia' }, icon('power', { size: 18 }), h('span', `Turn on ${NAME} in Settings`))));
      return false;
    }
    fill(top,
      fullHeadBanner(rightsLevel),
      // Every subscription at its limit is said once: here until her notice in the chat says it (render removes this).
      o && o.ready && !o.ready.ok && !(o.ready.code === 'subs-limited' && saidInChat(body, o.ready.code))
        ? h('p.banner.warn.tia-ready', { dataset: { code: o.ready.code || '' } }, icon('alert', { size: 18 }), h('span', `${pageTime(o.ready.problem, o.ready)} `, bannerLink(o.ready)))
        : null);
    return true;
  }
  async function overview() {
    try {
      const o = await api(`${A}`);
      lastOverview = o;
      paintTab();
      return o;
    } catch (e) {
      fill(top, h('p.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', `Could not reach ${NAME}: ${e.message}. Check the connection, then reload the page.`)));
      return null;
    }
  }

  // ---- chat (chatPanel, shared with the chat box) ----
  let stopChat = () => {};
  function chatView({ fresh = false } = {}) {
    stopChat();
    stopChat = chatPanel(body, { fresh }).stop;
  }
  cleanups.push(() => stopChat());

  // ---- jobs ----
  async function jobsView() {
    fill(body, h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading the jobs…')));
    let r;
    try {
      r = await api(`${A}/jobs`);
    } catch (e) {
      return fill(body, h('p.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', `Could not load the jobs: ${e.message}. Reload the page to try again.`)));
    }
    if (!alive) return;
    if (!r.jobs.length) return fill(body, h('div.empty.compact', icon('clock', { size: 28 }), h('div.empty-title', 'No jobs yet'), h('p', `When you ask ${NAME} to get something done, the job shows here: its goal, the sessions, and what she did.`)));
    fill(body, h('div.rows', r.jobs.map((j) => h('div.row.static.col.tia-job',
      h('div.mrow-top',
        // The sessions are the chips below, by name: the line under the goal keeps to the time and the count.
        h('span.row-main', h('span.row-title.tia-wrap', j.goal), h('span.row-sub', `${stamp(j.createdAt)} · ${j.sessions.length ? '' : 'no session yet · '}${j.steps} of ${j.maxSteps} answers used`)),
        h(`span.pill.${JOB_PILL[j.state] || 'st-starting'}`, h('span.dot'), JOB_WORDS[j.state] || j.state)),
      j.sessions.length ? h('div.tia-tools', j.sessions.map((s) => jobChip(s, chatTitle(s)))) : null,
      h('details', h('summary.hint', 'What she did'), h('ul.tia-log', j.log.slice(-12).map((l) => h('li', `${when(l.at)} ${l.text}`)))),
      j.state === 'working' || j.state === 'waiting'
        ? h('div', btn('secondary small', { icon: 'stop', label: 'Stop this job', onclick: async () => {
          if (!(await confirmSheet({ title: 'Stop this job?', text: `${NAME} stops working on it. Its sessions keep running; stop them from Home if you want.`, ok: 'Stop the job', danger: true }))) return;
          try {
            await api(`${A}/jobs/${j.id}/stop`, {});
            toast('Job stopped');
            jobsView();
          } catch (e) {
            toast(`${e.message}. Try again.`, { kind: 'error' });
          }
        } }))
        : null))));
  }

  // ---- activity (the audit log) ----
  async function activityView() {
    fill(body, h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…')));
    let r;
    try {
      r = await api(`${A}/audit?n=150`);
    } catch (e) {
      return fill(body, h('p.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', `Could not load the activity: ${e.message}. Reload the page to try again.`)));
    }
    // What she did by herself under her rules (Done by Tia, with Undo): kept by the operator's store, shown only when she did something.
    const att = await api('/api/operator/attention').catch(() => null);
    if (!alive) return;
    const byTia = att && att.reflexes && Array.isArray(att.byTia) ? att.byTia : [];
    const doneBy = byTia.length ? h('section', { 'aria-label': 'Done by Tia' }, h('h2.group-head', h('span', 'Done by Tia')), byTiaList(byTia, att.reflexes, () => activityView())) : null;
    if (!r.entries.length) return doneBy ? fill(body, doneBy) : fill(body, h('div.empty.compact', icon('text', { size: 28 }), h('div.empty-title', 'Nothing yet'), h('p', `Every change ${NAME} makes or proposes is listed here, and every OK you give.`)));
    // Each entry as one sentence (tiaactivity.js): providers, coding tools, chats and folders by their names; a card's
    // entries (her proposal, your answer, what came of it) as one row.
    fill(body, doneBy, h('div.rows', activityRows(r.entries).map(({ e, at, steps, error }) => {
      const w = activityWords(e, placeAt(e.input && e.input.computer));
      return h('div.row.static',
        h('span.row-icon', icon(e.actor === 'owner' ? 'user' : 'sparkle')),
        h('span.row-main',
          h('span.row-title.tia-wrap', `${e.actor === 'owner' ? 'You' : NAME}: ${w.what}`),
          h('span.row-sub.tia-wrap', `${stamp(at)} · ${steps.join(' · ')}${error ? ` · ${error}` : ''}`),
          w.detail ? h('span.row-sub.tia-wrap', cap(w.detail)) : null,
          w.quote ? h('span.row-sub.tia-wrap', `“${w.quote.length > 160 ? `${w.quote.slice(0, 159)}…` : w.quote}”`) : null));
    })));
  }

  const draw = () => (sub === 'jobs' ? jobsView() : sub === 'activity' ? activityView() : chatView());
  // Known already (the navigation asks every few seconds): draw at once; else wait for the answer.
  if (lastOverview) {
    if (paintState(lastOverview)) draw();
  } else fill(body, h('div.empty.compact', h('div.spinner', { 'aria-hidden': 'true' }), h('p', 'Loading…')));
  const hadOverview = !!lastOverview;
  overview().then((o) => {
    if (!alive || !o) return;
    const wasOff = hadOverview && lastOverview && o.enabled === false;
    if (paintState(o) && (!hadOverview || wasOff)) draw();
  });
  // Her administrator level, for the head banner. Read once at mount; a change is made on Settings → Tia,
  // which reloads. A failure leaves the banner off — it never blocks the page.
  api('/api/herrights').then((r) => {
    if (!alive) return;
    const next = (r && r.level) || null;
    if (next === rightsLevel) return;
    rightsLevel = next;
    if (lastOverview) paintState(lastOverview);
  }).catch(() => {});
  // On a phone the message box rides above the on-screen keyboard.
  const vv = typeof window !== 'undefined' && window.visualViewport;
  if (vv) {
    const kb = () => document.documentElement.style.setProperty('--tia-kb', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
    vv.addEventListener('resize', kb);
    kb();
    cleanups.push(() => {
      vv.removeEventListener('resize', kb);
      document.documentElement.style.removeProperty('--tia-kb');
    });
  }
  return () => {
    alive = false;
    cleanups.forEach((f) => f());
  };
}

// The open conversation, remembered per viewer.
const convGet = () => prefs.get('tia.conversation', null);
const convSet = (v) => prefs.set('tia.conversation', v);

registerPage({
  id: 'tia', title: NAME, icon: 'sparkle', navAs: 'home', render: viewTia,
  badge: () => (lastOverview && lastOverview.cards ? lastOverview.cards.length : 0),
});

// ---------- Settings → Tia: her rights on this computer (administrator level + git sign-in) ----------
// The owner's own per-computer choices (src/server/herrights.mjs: the level, off/ask/full; src/server/hersignin.mjs:
// which credentials file signs her sessions in to the git server). Set here and nowhere else — never through Tia's
// door, a token, another computer or a session. Off by default, so his tap comes before every administrator command.
// Every state has its own plain words for someone who is not a programmer.
// What Full does not lift (src/wall.mjs, src/hook.mjs: Full lifts the administrator act and nothing else): her own
// command is refused or carded, a session of hers waits for his yes. Said wherever Full is described.
export const FULL_KEEPS = 'Even at Full, a delete as administrator outside the session\'s own folder, a push to the main branch, a release and a change to Hoprig\'s own folders never run without you.';
const RIGHTS_WORDS = {
  off: ['Off', 'An administrator command is refused with no card, and Tia tells you the command to run yourself. This is the default, and what an install leaves; an update keeps Off and Ask each time, and turns Full into Ask each time.'],
  ask: ['Ask each time', 'Every administrator command shows you one card with the exact command. It runs only when you tap it — with your password where this computer asks for one, typed here and given straight to sudo, never kept.'],
  full: ['Full', `Her administrator commands run with no card, each kept in the audit log and her activity. ${FULL_KEEPS} Offered only where sudo needs no password; Hoprig never keeps a password to make it work.`],
};

// One short plain line per level, shown for all three, so a person who never opened a terminal can choose; the
// whole text of the chosen level (RIGHTS_WORDS) and the details of her sessions are in folds below them.
export const RIGHTS_SHORT = {
  off: 'Tia never runs an administrator command. She tells you the command, and you run it yourself.',
  ask: 'Tia shows you each administrator command first. It runs only when you tap it.',
  full: 'Tia runs administrator commands without asking. Pushes to the main branch, releases and a few more still wait for you.',
};
export const STAYS_SHORT = 'In a session Tia started, the risky steps still wait for your yes, also when you type there yourself.';

// A session she started keeps her hold until it ends (docs/OPERATOR.md "What a session she starts does"). The hold is
// the coding tool's own "wait for yes" in the session, not a card on this page, so the words say "waits for your yes".
export const STAYS_HERS = 'A session Tia started stays hers until it ends, also when you type into it yourself. There each of these waits for your yes in that session, the same as one she runs: a push or a merge into the main branch, a release, a pull request, a deploy, a delete outside the session\'s folder, a change to project.json or to Hoprig\'s own files, a line Hoprig cannot read, a direct call to GitHub or GitLab that can change something there, and, below Full, an administrator command.';

// The limits the owner weighs (docs/OPERATOR.md "What a session she starts does"): the hook reads the command a session
// runs, not what a program it starts does; and Hoprig has no hook for OpenCode or Codex, so she may start one only at
// Full (src/codetools/start.mjs assertHerToolBound), where nothing holds it.
export const TOOLS_UNHELD = 'This holds for her Claude Code sessions: their hook reads each command the session runs. What a script or another program started there then does is not read, so this protects against a mistake, not against a session that hides what it does. Hoprig has no hook for Codex or OpenCode, so below Full she cannot start a session on them. At Full she can, and nothing holds such a session: a delete as administrator outside the session\'s own folder, a push to the main branch or a change to Hoprig\'s own settings runs there with no card.';

// The rights block's Save buttons stand on the left, as the daily limit's does below it.
const startBar = (bar) => (bar.classList.add('start'), bar);

function tiaRights({ isAlive }) {
  const box = h('div.tia-rights', h('p.hint', 'Loading…'));
  async function paint() {
    let r;
    let sg;
    try {
      [r, sg] = await Promise.all([api('/api/herrights'), api('/api/hersignin')]);
    } catch (e) {
      return fill(box, h('p.form-error', e.message));
    }
    if (!isAlive()) return;

    // ---- administrator rights ----
    // Which levels this computer may offer: no sudo → none (only Off applies); sudo that asks a password → Off and
    // Ask (Full is never offered where a password would have to be kept); sudo with no password → all three.
    const levels = !r.sudoPresent ? [] : r.fullOffered ? ['off', 'ask', 'full'] : ['off', 'ask'];
    const sel = { level: r.level === 'full' && !levels.includes('full') ? 'ask' : r.level, confirm: '' };
    // While Full is on, the head of this section says so, always (as a banner, set apart from the text below). What Full
    // does not lift is said once, under the level, where Full is then the one chosen.
    const fullBanner = r.level === 'full'
      ? h('p.banner.warn.tia-rights-full', { role: 'status' }, icon('alert', { size: 18 }),
        h('span', h('strong', 'Full administrator rights are on. '), 'Her administrator commands run on this computer with no card. Choose Off or Ask below to change that.'))
      : null;
    // Full chosen under a previous Hoprig version reads as Ask each time after an update: say why, so the
    // owner knows his deliberate Full was turned off and must confirm it again under this version.
    const heldBanner = r.heldFromFull
      ? h('p.banner.warn.tia-rights-held', { role: 'status' }, icon('alert', { size: 18 }),
        h('span', h('strong', 'Full administrator rights were turned off by a Hoprig update. '),
          'The setting reads Ask each time now, so every administrator command shows you a card. To use Full again, choose Full below and confirm it for this computer.'))
      : null;
    const levelHelp = h('p.hint.tia-rights-help');
    const confirmSlot = h('div');
    const saveSlot = h('div');
    const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Administrator rights for Tia on this computer' });
    const paintLevel = () => {
      fill(seg, levels.map((l) => h('button.seg', {
        type: 'button', role: 'radio', 'aria-checked': String(sel.level === l),
        onclick: () => { sel.level = l; sel.confirm = ''; paintLevel(); },
      }, h('span', RIGHTS_WORDS[l][0]))));
      levelHelp.textContent = RIGHTS_WORDS[sel.level][1];
      // Turning Full on needs the exact sentence typed on this page: shown only when Full is picked and
      // not already on.
      if (sel.level === 'full' && r.level !== 'full') {
        fill(confirmSlot, h('label.fieldrow', h('span.field-label', 'Type to confirm'),
          h('input.field', { type: 'text', 'aria-label': `Type: ${r.sentence}`, placeholder: r.sentence, value: sel.confirm, oninput: (e) => (sel.confirm = e.target.value) }),
          h('span.hint', ['To turn Full on, type exactly: ', h('strong', r.sentence)])));
      } else {
        fill(confirmSlot);
      }
      fill(saveSlot, sel.level === r.level
        ? h('p.hint', `Now: ${RIGHTS_WORDS[r.level][0]}.`)
        : startBar(saveBar('Save', async () => {
          await api('/api/herrights', { level: sel.level, ...(sel.level === 'full' ? { confirm: sel.confirm.trim() } : {}) });
          setTimeout(paint, 300);
        })));
    };
    paintLevel();
    const rightsBlock = !r.sudoPresent
      ? h('p.hint.tia-rights-nosudo', 'This computer has no sudo, so Tia cannot run administrator commands here. The setting is off.')
      : [
        r.fullOffered ? null : h('p.hint', 'Full is offered only where sudo needs no password. On this computer sudo asks for one, so choose Ask each time: its card asks you for the password when a command runs.'),
        seg,
        h('ul.tia-rights-levels', levels.map((l) => h('li.hint', h('strong', `${RIGHTS_WORDS[l][0]}: `), RIGHTS_SHORT[l]))),
        fold('tia-rights-level-more', 'More about the chosen level', levelHelp),
        confirmSlot, saveSlot,
      ];

    // ---- the git sign-in her sessions use ----
    const file = { value: sg.file || '' };
    const checkSlot = h('div.tia-signin-check');
    const signinBlock = [
      h('h3.section-title', 'Git sign-in for her sessions'),
      sg.file
        // The limit belongs with the chosen token, where "this token" has something to point at: it guards against a
        // mistake, not against a session that hunts for his own sign-in.
        ? h('p.hint', ['Her sessions sign in to the git server with the token in ', h('code', sg.file), ', in place of your own. A session runs as your user, so this token protects against a mistake, not against a session that looks for your own sign-in.'])
        : h('p.hint', 'With no file chosen, her sessions use your own git sign-in.'),
      h('label.fieldrow', h('span.field-label', 'Token file'),
        h('input.field', { type: 'text', 'aria-label': 'Credentials file name', placeholder: 'folder/name.token', value: file.value, oninput: (e) => (file.value = e.target.value) }),
        h('span.hint', 'The name of one file in your credentials folder. Its content is never shown, logged, or put on a command line. Leave it empty to use your own sign-in.')),
      startBar(saveBar('Save', async () => {
        const res = await api('/api/hersignin', { file: file.value.trim() });
        toast(res.file ? 'Her sessions will sign in with that token.' : 'Her sessions will use your own sign-in.');
        setTimeout(paint, 300);
      })),
      sg.file ? h('div.savebar', btn('secondary', { label: 'Check what this token may do', onclick: async () => {
        fill(checkSlot, h('p.hint', 'Asking the git server…'));
        try {
          const c = await api('/api/hersignin/check', {});
          fill(checkSlot, h('ul.tia-check-lines', (c.lines || []).map((l) => h('li.hint', l))));
        } catch (e) {
          fill(checkSlot, h('p.form-error', e.message)); // the file is missing or cannot be read, or the check could not reach the git server
        }
      } })) : null,
      checkSlot,
      h('p.hint', 'Make the token at your git server yourself, with only the rights you want her sessions to have — one that cannot delete a repository or force-push the default branch unless you mean it to. The check asks the git server, on your press only, what this token can do.'),
    ];

    fill(box,
      h('h3.section-title', 'Administrator rights on this computer'),
      fullBanner,
      heldBanner,
      h('p.hint', 'Whether Tia may run administrator (sudo) commands on this computer, and how. This is your own choice, per computer; it can be changed only here, on your signed-in page.'),
      rightsBlock,
      // The owner may type into a session she started and take it for his own; it is not, and what he runs there
      // waits for his yes as her own commands do. Said here so that wait is no surprise.
      // And the limit for the coding tools Hoprig cannot hold (OpenCode, Codex), next to the level so the owner weighs
      // it before turning one on: such a session she starts is not bound by this level. One plain line, the details folded.
      h('p.hint', STAYS_SHORT),
      fold('tia-rights-stays-more', 'Details: her sessions, and what Hoprig cannot check',
        h('p.hint.tia-rights-stays', STAYS_HERS),
        h('p.hint.tia-rights-stays', TOOLS_UNHELD)),
      fold('tia-signin-advanced', 'Advanced', signinBlock));
  }
  paint();
  return box;
}

// ---------- Settings → Tia ----------
/** The label and the one line of her switch, true for the state it shows (never "Tia is on" over a switch that is off). */
export const onOffWords = (on) => (on
  ? { label: `${NAME} is on`, line: 'Turn her off to hide her button and stop everything she watches.' }
  : { label: `${NAME} is off`, line: 'Turn her on to let her do jobs for you. She is experimental.' });
function tiaSettings({ isAlive }) {
  const box = h('div', h('p.hint', 'Loading…')); // her switch and the level
  const limitsBox = h('div.tia-limits-box'); // her providers, the daily limit and what she runs on
  const usageBox = h('div');
  const clientBox = h('div');
  async function paint() {
    let v;
    try {
      v = await api(`${A}/settings`);
    } catch (e) {
      return fill(box, h('p.form-error', e.message));
    }
    if (!isAlive()) return;
    const s = v.settings;
    const st = { level: s.level, accounts: s.accounts ? [...s.accounts] : null, runsOn: s.runsOnSet || '', model: s.model || '', lead: s.lead === true, others: s.others || [], maxSteps: s.maxSteps, maxMinutes: s.maxMinutes, computers: Array.isArray(s.computers) ? s.computers.filter((n) => n !== 'this') : [], dailyCapUsd: s.dailyCapUsd ?? null };
    // On or off is kept at once (the page then shows or hides her settings); the rest with Save.
    const onOff = toggle(onOffWords(s.enabled).label, s.enabled, async (on) => {
      try {
        await api(`${A}/settings`, { enabled: on });
        pollOverview();
        setTimeout(paint, 900); // after "Saved" was seen
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
        paint();
        return false;
      }
    }, onOffWords(s.enabled).line); // one true line for the state the switch shows; nothing folded under it
    // "She answers the OKs of her Work runs" (assistant.answersHers, off at first): kept at once, as on or off is, so one
    // press stops it. Its sentence says what she then answers by herself and what stays his card.
    const answersHers = v.help.answersHers ? toggle('She answers the OKs of her Work runs', s.answersHers === true, async (on) => {
      try {
        await api(`${A}/settings`, { answersHers: on });
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
        paint();
        return false;
      }
    }, { line: 'When a Work task she started asks for an OK, she answers it, only to look inside the project or run its checks.', more: v.help.answersHers }, { key: 'tia-answers-hers' }) : null;
    const levelWords = { ask: ['Ask me', v.help.levelAsk], work: ['Do the work', v.help.levelWork], handsoff: ['Hands off', v.help.levelHandsoff] };
    // What each level means in one short line; the full text of the chosen one under a closed "More".
    const short = v.help.levelShort || {};
    const levelLines = h('ul.tia-level-lines', v.levels.map((l) => h('li', h('strong', levelWords[l][0]), ` — ${short[l] || ''}`)));
    const levelHelp = h('p.hint.tia-level-help');
    const levelSeg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'How far she may go' });
    const paintLevel = () => {
      fill(levelSeg, v.levels.map((l) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(st.level === l), onclick: () => { st.level = l; paintLevel(); } }, h('span', levelWords[l][0]))));
      levelHelp.textContent = levelWords[st.level][1];
    };
    paintLevel();
    const real = v.accounts.filter((a) => !a.virtual);
    const choices = [...(v.autoOn ? [{ name: 'auto', label: 'Auto mode', kind: 'auto' }] : []), ...real];
    const allowedNow = st.accounts || s.allowed;
    const checks = h('div.checks', choices.map((a) => h('label.check',
      h('input', { type: 'checkbox', checked: allowedNow.includes(a.name), onchange: (e) => {
        const cur = st.accounts || [...s.allowed];
        st.accounts = e.target.checked ? [...new Set([...cur, a.name])] : cur.filter((n) => n !== a.name);
        drawLead(); // her ticks under Lead model are only of the providers she may use
      } }),
      h('span', providerWords(a)))));
    // The computers she may start new work on (assistant.computers): only where several are linked.
    const pcs = Array.isArray(v.computers) ? v.computers : [];
    const pcChecks = pcs.length ? h('div.checks', h('label.check', h('input', { type: 'checkbox', checked: true, disabled: true }), h('span', 'This computer')), pcs.map((c) => h('label.check',
      h('input', { type: 'checkbox', checked: st.computers.includes(c.name), onchange: (e) => {
        st.computers = e.target.checked ? [...new Set([...st.computers, c.name])] : st.computers.filter((n) => n !== c.name);
      } }),
      h('span', c.label)))) : null;
    const nameOf = (n) => (n === 'auto' ? 'Auto mode' : ((choices.find((a) => a.name === n) || {}).label || n));
    const runs = h('select.field', { id: 'tia-runs-on', onchange: (e) => {
      st.runsOn = e.target.value;
      drawModel();
    } },
      h('option', { value: '', selected: !st.runsOn }, automaticWords(v.automatic || s, nameOf)),
      // She thinks through Claude Code: only the providers that serve it (`thinks`; absent from an older computer).
      choices.filter((a) => a.thinks !== false).map((a) => h('option', { value: a.name, selected: st.runsOn === a.name }, nameOf(a.name))));
    // The models of the provider she runs on (src/models/catalog.mjs), asked when this is drawn; a name saved earlier
    // that the list leaves out stays, marked.
    const modelSlot = h('div');
    const drawModel = () => fill(modelSlot, modelPicker({
      provider: st.runsOn || s.runsOn || null, tool: 'claude', value: st.model, key: 'tia-model', label: 'Her model', hint: v.help.model,
      emptyLabel: 'The provider\'s default', at: (p) => `~${p}`, onchange: (m) => (st.model = m || ''),
    }));
    drawModel();
    // Her ticks: only providers she may use (the server refuses any other), billed by use by her own rule (policy.mjs:
    // every API provider below Hands off), said as the list above says it.
    const leadSlot = h('div');
    const drawLead = () => {
      const allowed = st.accounts || s.allowed;
      fill(leadSlot, leadSwitch({ value: st.lead === true, provider: null, noProvider: 'Which models it uses depends on the provider she starts each chat on.', at: (p) => `~${p}`, key: 'tia-lead',
        onchange: (on) => (st.lead = on), others: (st.others || []).filter((n) => allowed.includes(n)), onothers: (l) => (st.others = l), only: allowed.filter((n) => n !== 'auto'), billed: (p) => p.kind === 'api' || p.paid === true }));
    };
    drawLead();
    const steps = h('input.field', { type: 'number', min: 1, max: 200, value: st.maxSteps, oninput: (e) => (st.maxSteps = Number(e.target.value)) });
    const mins = h('input.field', { type: 'number', min: 5, max: 10080, value: st.maxMinutes, oninput: (e) => (st.maxMinutes = Number(e.target.value)) });
    // The daily limit for paid use on providers billed by use (src/assistant/spend.mjs), beside the level that runs
    // without asking; empty is no limit: each paid act asks him. Under it what was spent against it today.
    const cap = h('input.field', { id: 'tia-daily-cap', type: 'number', min: 0.5, max: 10000, step: 0.5, placeholder: 'No limit', 'aria-label': 'Daily limit for paid use in US dollars', value: st.dailyCapUsd ?? '', oninput: (e) => (st.dailyCapUsd = e.target.value === '' ? null : Number(e.target.value)) });
    const sp = v.spend || { cap: null, today: { spent: 0, held: 0 } };
    const spentLine = h('span.hint.tia-spent', spentWords(sp));
    const field = (label, input, hint) => h('label.fieldrow', h('span.field-label', label), input, hint ? h('span.hint', hint) : null);
    // Both Saves: the line under the field is drawn again from what the server answers (it counts today's spend), so
    // a limit just set is never shown as "No daily limit".
    const saveAll = async () => {
      const r = await api(`${A}/settings`, { level: st.level, accounts: st.accounts, runsOn: st.runsOn || null, model: st.model || null, lead: st.lead === true, others: st.lead === true ? st.others || [] : [], maxSteps: st.maxSteps, maxMinutes: st.maxMinutes, dailyCapUsd: st.dailyCapUsd, ...(pcs.length ? { computers: st.computers.length ? st.computers : null } : {}) });
      spentLine.textContent = spentWords(savedSpend(r, sp, st.dailyCapUsd));
      pollOverview();
    };
    // Sent here to set the limit ("Set a daily limit for paid use"): its Save right under it, as the panel's Save.
    // He came from a notice of hers: after this Save, one button sends his message again (once) and opens her chat.
    const back = backOf(typeof location !== 'undefined' ? location.hash : '');
    const backSlot = h('div.tia-cap-back');
    const capSave = capSaveWanted(typeof location !== 'undefined' ? location.hash : '') ? saveBar('Save', async () => {
      await saveAll();
      if (back) fill(backSlot, backButton(back));
    }) : null;
    if (capSave) capSave.classList.add('start', 'tia-cap-save');
    fill(box,
      onOff,
      s.enabled ? h('div.fieldrow', h('span.field-label', 'How far she may go'), levelSeg, fold('tia-level-more', 'What each level means', levelLines, levelHelp)) : null);
    fill(limitsBox,
      s.enabled ? [
        answersHers,
        // The field, its Save when he was sent here, what is used today; the long text of what counts under "More".
        h('div.fieldrow', h('label.field-label', { for: 'tia-daily-cap' }, 'Daily limit for paid use (US $)'), cap, capSave, backSlot, spentLine, fold('tia-cap-more', 'What counts against the limit', h('p.hint', v.help.dailyCapUsd))),
        h('div.fieldrow', h('span.field-label', 'Providers she may use'), checks, h('span.hint', v.help.accounts + (s.accountsDefault ? ' Now: the default — Auto mode when it is on, and every subscription; no API provider.' : ''))),
        pcChecks ? h('div.fieldrow', h('span.field-label', 'Computers she may start work on'), pcChecks, h('span.hint', v.help.computers)) : null,
        field(`${NAME} runs on`, runs, v.help.runsOn),
        // For the chats she starts: their models are those of the provider she starts each one on, not of the one she
        // thinks on, so no one provider's tiers are named here.
        fold('tia-advanced', 'Advanced',
          modelSlot,
          leadSlot,
          field('Answers per job', steps, v.help.maxSteps),
          field('Minutes per job', mins, v.help.maxMinutes)),
        saveBar('Save', saveAll),
      ] : null);
    const u = v.usage;
    const line = (label, x) => h('div', h('span', label), h('strong', `${x.turns} turns · ${(x.input + x.cacheRead + x.cacheWrite).toLocaleString()} in / ${x.output.toLocaleString()} out · ${money(x.costUsd)}`));
    fill(usageBox, h('h3.section-title', 'Usage'), h('div.kv', line('Today', u.today), line('Last 7 days', u.week), u.conversations.slice(-5).reverse().map((c) => line(`Conversation ${c.id.slice(-6)}`, c))), h('p.hint', v.help.usage));
    // Her tools answer the owner's own client only while she is on: no token is offered while she is off.
    fill(clientBox,
      h('h3.section-title', 'Let my own Claude Code use these tools'),
      h('p.hint', v.help.client),
      s.enabled ? null : h('p.hint.tia-client-off', `Only while ${NAME} is on: turn her on above first.`),
      v.client ? h('p.hint', `A token was made ${new Date(v.client.created).toLocaleDateString()}.`) : null,
      h('div.savebar',
        s.enabled && btn('secondary', { icon: 'key', label: v.client ? 'Make a new token' : 'Make a token', onclick: async () => {
          try {
            const r = await api(`${A}/client-token`, {});
            fill(clientBox.querySelector('.tia-cmd') || add(clientBox, h('div.tia-cmd')).lastChild,
              h('p.hint', 'Run this once in a terminal on this computer. The token is shown only now.'),
              h('div.cmdline', h('code', r.command), btn('icon ghost', { icon: 'copy', title: 'Copy', onclick: async () => toast((await copyText(r.command)) ? 'Copied' : 'Select and copy it by hand') })));
          } catch (e) {
            toast(e.message, { kind: 'error' });
          }
        } }),
        v.client ? btn('secondary', { icon: 'trash', label: 'Revoke', onclick: async () => { await api(`${A}/client-token/revoke`, {}); toast('Revoked'); paint(); } }) : null));
  }
  paint();
  // What she has used and her tools for your own Claude Code: looked at rarely, so closed until opened.
  // After her switch and the level, five folds, closed at first: what she may do alone, the limits and roles, her rights
  // on this computer, her self-improvement rounds, and what she has used with the token for your own Claude Code.
  return [
    box,
    tiaAloneFold(),
    fold('tia-limits', 'Limits and roles', limitsBox, missionLimits()),
    fold('tia-rights', 'Rights', tiaRights({ isAlive })),
    fold('tia-improve', 'Self-improvement', ((slot) => (import('./tiaimprove.js').then((m) => m.improveTia(slot, { isAlive })), slot))(h('div.tia-improve'))),
    fold('tia-usage', 'Usage and token', usageBox, clientBox),
  ];
}

/**
 * The sentence of the card of the daily limit for paid use: what was spent today, what is counted for acts on a
 * provider billed by use whose cost Hoprig could not measure: $0.50 each until the day ends; and what he can do
 * (raise the daily limit for paid use or wait for tomorrow). Never "work under way": such an act stays counted after
 * its session ended. "Reached" only when it is.
 */
export function spentWords(sp) {
  const t = (sp && sp.today) || { spent: 0, held: 0, unmeasured: 0 };
  const n = t.unmeasured || 0;
  // What the parts that run now hold (their budgets, less what they cost so far) is said apart from the $0.50 each.
  const partsHeld = t.partsHeld || 0;
  // What a part that stopped before it reported its last turn's cost had left of its budget: counted, never spent.
  const cutHeld = t.cutHeld || 0;
  // …and what a part whose end Hoprig did not see (the dashboard stopped while it ran) had left: counted the same.
  const unseenHeld = t.unseenHeld || 0;
  const other = Math.round(((t.held || 0) - partsHeld - cutHeld - unseenHeld) * 100) / 100;
  // One act has one figure: "counts $0.50"; only several have "each" and a sum.
  // "Act" is not a word he knows here: what is counted is a session started, moved or written to.
  const counted = n === 1 ? ` One start, move or message of a session on a provider billed by use whose cost Hoprig could not measure counts ${money(other || 0.5)}; it stays counted until the day ends.`
    : n ? ` ${n} starts, moves or messages of sessions on a provider billed by use whose cost Hoprig could not measure count ${money(0.5)} each, ${money(other || n * 0.5)} in all; they stay counted until the day ends.` : '';
  const parts = partsHeld > 0 ? ` ${money(partsHeld)} is held for ${t.parts === 1 ? 'a part that runs now' : `${t.parts} parts that run now`} (a part is a piece of a task that a session handed to another provider); when a part ends, what it cost counts in its place.` : '';
  const cut = cutHeld > 0 ? ` ${money(cutHeld)} is counted for ${t.cuts > 1 ? `${t.cuts} parts that stopped before they reported what their last turn cost: Hoprig could not measure it, so the rest of their budgets stays` : 'a part that stopped before it reported what its last turn cost: Hoprig could not measure it, so the rest of its budget stays'} counted until the day ends.` : '';
  const unseen = unseenHeld > 0 ? ` ${money(unseenHeld)} is counted for ${t.unseen > 1 ? `${t.unseen} parts whose end Hoprig did not see (the dashboard stopped while they ran): Hoprig could not measure what they cost, so the rest of their budgets stays` : 'a part whose end Hoprig did not see (the dashboard stopped while it ran): Hoprig could not measure what it cost, so the rest of its budget stays'} counted until the day ends.` : '';
  // No limit: both things that follow from it, the card for a paid act and her chat that stays quiet on a paid provider.
  if (!(sp && sp.cap)) return `Today: ${money(t.spent)} spent.${counted}${parts}${cut}${unseen} No daily limit for paid use: everything paid asks you first, and ${NAME} does not answer in her chat while she runs on a provider that costs money.`;
  const used = (t.spent || 0) + (t.held || 0);
  const full = used + 1e-9 >= sp.cap ? ' The daily limit is reached: raise it, or wait for tomorrow.'
    : used + 0.5 > sp.cap + 1e-9 ? ` The daily limit has no room for another ${money(0.5)}: raise it, or wait for tomorrow.`
      : n ? ' When the daily limit is reached, raise it, or wait for tomorrow.' : '';
  // In the order he thinks of it: what was spent, what is counted besides, and then what of his limit that uses; never
  // "used" and "spent" side by side with two figures.
  return `Today: ${money(t.spent)} spent.${counted}${parts}${cut}${unseen} ${money(used)} of your ${money(sp.cap)} daily limit is used.${full}`;
}

/**
 * What the line under the limit field says after a Save: the server's answer (POST /api/assistant/settings answers
 * with the settings view, its `spend` read after the save); an answer without it keeps today's figures with the
 * limit just saved.
 */
export const savedSpend = (answer, before, cap) => (answer && answer.spend ? answer.spend : { ...(before || {}), cap: cap ?? null });

/**
 * A line of the server with a time in it ("can be used again at 21:05"): that time written the way this page writes
 * its other times (the browser's own clock form, as when()), with the day when it is not today. `atText` is the
 * server's words for `until`; a line without them is shown as it came.
 */
export function pageTime(text, { atText, until } = {}, now = Date.now()) {
  if (typeof text !== 'string' || typeof atText !== 'string' || !atText || !Number.isFinite(until) || !text.includes(atText)) return text;
  const d = new Date(until);
  const day = new Date(now).toDateString() === d.toDateString() ? '' : ` on ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`;
  return text.replace(atText, `${when(until)}${day}`);
}

/**
 * Where a new chat says that it started: a toast on a wide window; on a phone (`phone`) the toast would sit over the
 * message box and the cards' buttons, so the empty chat says it. Nothing for a chat that was not new.
 */
export const newChatWhere = (fresh, phone) => (!fresh ? null : phone ? 'chat' : 'toast');

/** An event after which a notice's "Use …" is gone: his next message, her words, or the end of her turn. */
export const endsNotice = (e) => !!e && (e.kind === 'owner' || e.kind === 'text' || e.kind === 'done');

/** What "Use …" on notice `e` sends again: his message that brought it; nothing for a job's wake-up. */
export const resendText = (e, last) => (e && e.origin === 'owner' && typeof last === 'string' ? last : '');

/** The own Save of the field of the daily limit for paid use is drawn when the page was opened at it (#/settings/tia?show=tia-daily-cap). */
export const capSaveWanted = (hash) => /[?&]show=tia-daily-cap(?:&|$)/.test(String(hash || ''));

/**
 * The banner's way on, when Tia cannot answer: Settings → Tia, except when every subscription is at its limit
 * (Automatic), where there is nothing to set: waiting is the answer. His own chosen subscription at its limit
 * ("chosen-limited") keeps the link: another subscription, or Automatic, may answer now.
 */
export const bannerLink = (ready) => (ready && ready.code === 'subs-limited'
  ? (ready.other ? h('a', { href: RUNS_LINK }, `Choose another provider for ${NAME}`) : null)
  : h('a', { href: '#/settings/tia' }, `Open Settings → ${NAME}`));

/** True when the chat in `root` shows a notice of `code` already (the banner then says nothing more). */
export const saidInChat = (root, code) => !!(root && typeof root.querySelector === 'function' && root.querySelector(`.tia-notice[data-code="${code}"]`));

/**
 * The link to the daily limit for paid use of a notice his message brought: it names the conversation and the notice (`back`: "<id>.<number>"),
 * so the Save under the field can offer the way back. Without it the plain link.
 */
export const capLinkFor = (back) => (typeof back === 'string' && BACK_RE.test(back) ? `${CAP_LINK}&back=${back}` : CAP_LINK);
const BACK_RE = /^[A-Za-z0-9_-]{1,64}\.\d{1,6}$/;

/** The conversation and the notice a page address names (`back=<id>.<number>`), or null: only that plain shape. */
export function backOf(hash) {
  const m = /[?&]back=([A-Za-z0-9_-]{1,64})\.(\d{1,6})(?:&|$)/.exec(String(hash || ''));
  return m ? { conversation: m[1], again: Number(m[2]) } : null;
}

/**
 * His press after the Save: his message of that notice is sent again through the chat route (the server sends it once
 * per notice, also when another page pressed at the same moment), and her chat opens on that conversation. Sent
 * already: her chat opens all the same, with the server's sentence.
 */
export async function sendBack(back, { post = (body) => api(`${A}/chat`, body), open = (to) => (location.hash = to), remember = convSet } = {}) {
  let said = null;
  try {
    await post({ conversation: back.conversation, again: back.again });
  } catch (e) {
    if (e.code !== 'sent-already') throw e;
    said = e.message;
  }
  remember(back.conversation);
  open('#/tia');
  return said;
}

const backButton = (back) => btn('primary', { icon: 'send', label: `Back to ${NAME}'s chat: send your message`, onclick: async (ev) => {
  const b = ev.currentTarget;
  b.disabled = true;
  try {
    const said = await sendBack(back);
    if (said) toast(said);
  } catch (e) {
    b.disabled = false;
    toast(e.message, { kind: 'error', ms: 6000 });
  }
} });

/** Where "Choose another provider for Tia" leads: Settings → Tia at "Tia runs on". It only opens the place. */
export const RUNS_LINK = '#/settings/tia?show=tia-runs-on';

/** Where "Set a daily limit for paid use" leads: Settings → Tia, the field of that limit in the middle of the window. */
export const CAP_LINK = '#/settings/tia?show=tia-daily-cap';

/**
 * His press on "Use <label>": "Tia runs on" is set to that subscription through the existing settings route, and only
 * when that was saved is his last message sent again, once. A save that fails sends nothing.
 */
export async function useAndResend(name, text, { save, send }) {
  await save({ runsOn: name });
  if (text) await send(text);
}

/**
 * A notice in her chat. One with a `code` (paid-no-cap, cap-reached, chosen-limited) carries no way in words: the
 * buttons are drawn here. "Use <label> (included in your plan)" when a subscription can answer (`e.use`), which calls
 * `resend(name)` once; and "Set a daily limit for paid use", which opens the field of that limit (for chosen-limited, where
 * nothing is paid: "Open Settings → Tia").
 */
export function noticeView(e, { resend = null, back = null } = {}) {
  // His chosen subscription at its limit: nothing is paid, so the second way is Settings → Tia, not the daily limit.
  const chosen = e.code === 'chosen-limited';
  const subsAll = e.code === 'subs-limited';
  const coded = chosen || subsAll || e.code === 'paid-no-cap' || e.code === 'cap-reached';
  if (!coded) return h('p.banner.warn', icon('alert', { size: 18 }), h('span', pageTime(e.text, e)));
  const use = e.use && typeof e.use.name === 'string' ? e.use : null;
  const useBtn = use && resend ? btn('primary tia-notice-use', { label: `Use ${use.label || use.name} (included in your plan)`, onclick: async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      await resend(use.name);
    } catch (err) {
      b.disabled = false;
      toast(err.message, { kind: 'error', ms: 6000 });
    }
  } }) : null;
  return h('div.banner.warn.tia-notice', { role: 'status', dataset: { code: e.code } },
    icon('alert', { size: 18 }),
    h('div.tia-notice-body', h('span', pageTime(e.text, e)),
      h('div.tia-notice-acts', useBtn,
        chosen ? h('a.btn.secondary', { href: '#/settings/tia' }, h('span', `Open Settings → ${NAME}`))
          // Every subscription at its limit: nothing to pay here (she never moves to a paid provider by herself); when he
          // allowed another provider, the way to choose it himself.
          : subsAll ? (e.other ? h('a.btn.secondary', { href: RUNS_LINK }, h('span', `Choose another provider for ${NAME}`)) : null)
          : h('a.btn.secondary', { href: capLinkFor(back) }, h('span', e.code === 'cap-reached' ? 'Raise the daily limit for paid use' : 'Set a daily limit for paid use')))));
}

/**
 * What "Automatic" picks now (the settings view's `automatic`), as the choice of "Tia runs on" names it: the first
 * subscription that can answer, Auto mode or another provider when he has no subscription, or none while every
 * subscription is at its limit.
 */
export const automaticWords = (a, nameOf = (n) => n) => `Automatic (now: ${a && a.runsOn ? nameOf(a.runsOn)
  : a && a.subsLimited ? 'none, every subscription is at its limit' : 'none'})`;

/** A provider by its name, with "billed by use" for an API provider (her rule, policy.mjs) unless its name says so. */
export const providerWords = (a) => (a.name === 'auto' ? 'Auto mode'
  : `${a.label || a.name}${a.kind === 'api' && !/\b(pay|paid|billed)\b/i.test(a.label || a.name) ? ' · billed by use' : ''}`);

registerSettingsPage({
  id: 'tia', title: NAME, icon: 'sparkle', order: 50, onlyHere: true, tag: 'experimental',
  desc: `${NAME} gets coding work done and tells you when it is done.`,
  summary: async () => {
    const v = await api(`${A}/settings`);
    return v.settings.enabled ? `On · ${{ ask: 'asks first', work: 'does the work', handsoff: 'hands off' }[v.settings.level] || v.settings.level}` : 'Off';
  },
  render: tiaSettings,
});
