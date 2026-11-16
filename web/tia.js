// Tia, the assistant: her page (#/tia: Chat, #/tia/jobs, #/tia/activity) and Settings → Tia. Everything here talks
// to this dashboard ("~/api/assistant/…"): Tia lives on the computer whose page this is, and reaches the others
// herself. Text from Tia, sessions and folders is only ever set as text.
//
// The chat: messages scroll above a message box that stays at the bottom of the window; while Tia works a line says
// what she is doing; a confirm card asks in plain words (the accounts' display names, what it costs, why she asks)
// and, once decided, shows what happened. Styles: page-automations.css (every class starts with "tia-").
import { icon } from './icons.js';
import { add, api, btn, confirmSheet, copyText, fill, h, prefs, toast, url } from './lib.js';
import { navChanged, registerHeadTool, registerPage, registerSessionAction, registerSettingsPage } from './registry.js';
import { fold, saveBar, tabBar, toggle } from './shell.js';
import { MODELS } from './sessiondefaults.js';
import { store } from './store.js';

const NAME = 'Tia';
const A = '~/api/assistant';

// What she did, in plain words (the chips under her answer and the Activity list).
const TOOL_WORDS = {
  list_sessions: 'looked at the sessions', read_session: 'read a session', list_projects: 'looked at the projects', list_conversations: 'looked at earlier conversations',
  get_accounts: 'looked at the providers', get_computer_status: 'looked at the computers', get_settings: 'read the settings', find_skill: 'looked up how to do it',
  start_session: 'start a session', send_to_session: 'type into a session', press_key: 'press a key in a session', rename_session: 'rename a session',
  start_chat: 'start a chat', send_to_chat: 'act in a chat',
  watch_session: 'watch a session', finish_job: 'finish the job', notify_owner: 'notify you', open_screen: 'open a screen',
  stop_session: 'stop a session', switch_account: 'move a session to another provider', set_auto_mode: 'change Auto mode',
  update_claude_code: 'update Claude Code', kill_process: 'end a process', change_setting: 'change a setting', run_command: 'run a command',
  manage_computer: 'change a computer', draft_skill: 'add a skill',
};
// What she is doing right now (the line while she works).
const DOING = {
  list_sessions: 'looking at the sessions', read_session: 'reading a session', list_projects: 'looking at your projects', list_conversations: 'looking at earlier conversations',
  get_accounts: 'checking the providers', get_computer_status: 'checking the computers', get_settings: 'reading the settings', find_skill: 'looking up how to do it',
  start_session: 'starting a session', send_to_session: 'typing into a session', press_key: 'pressing a key in a session', rename_session: 'renaming a session',
  start_chat: 'starting a chat', send_to_chat: 'writing to a chat',
  watch_session: 'watching a session', finish_job: 'finishing the job', notify_owner: 'writing to you', open_screen: 'opening a screen',
  stop_session: 'stopping a session', switch_account: 'moving a session to another provider', set_auto_mode: 'changing Auto mode',
  update_claude_code: 'updating Claude Code', kill_process: 'ending a process', change_setting: 'changing a setting', run_command: 'running a command',
  manage_computer: 'changing a computer', draft_skill: 'writing a skill',
};
// The chip once a call has an answer.
const DID = {
  ...Object.fromEntries(Object.entries(TOOL_WORDS).filter(([, v]) => v.startsWith('looked') || v.startsWith('read'))),
  start_session: 'started a session', send_to_session: 'typed into a session', press_key: 'pressed a key', rename_session: 'renamed a session',
  start_chat: 'started a chat', send_to_chat: 'wrote to a chat',
  watch_session: 'watches a session', finish_job: 'finished the job', notify_owner: 'notified you', open_screen: 'opened a screen',
  stop_session: 'stopped a session', switch_account: 'moved a session', set_auto_mode: 'changed Auto mode', update_claude_code: 'updated Claude Code',
  kill_process: 'ended a process', change_setting: 'changed a setting', run_command: 'ran a command', manage_computer: 'changed a computer', draft_skill: 'added a skill',
};
const JOB_WORDS = { working: 'Working', waiting: 'Waiting for you', done: 'Done', stuck: 'Stuck', stopped: 'Stopped' };
const JOB_PILL = { working: 'st-working', waiting: 'st-waiting', done: 'st-starting', stuck: 'st-limit', stopped: 'st-starting' };
const OUTCOME = { done: 'Done', staged: 'Waiting for your OK', confirmed: 'You confirmed', declined: 'You declined', refused: 'Refused', failed: 'Failed', stale: 'Not run (things changed)', expired: 'Expired' };
// Three things to ask, for the empty chat: each is sent as it is when tapped.
export const EXAMPLES = [
  'What needs me right now?',
  'Set up what is missing on this computer',
  'What did Claude remember about my projects?',
];
/** Her **bold** words as bold, everything else as plain text (never as HTML). */
export const boldText = (text) => String(text).split(/\*\*([^*\n]+)\*\*/).map((part, i) => (i % 2 ? h('strong', part) : part));
const when = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const mmss = (ms) => (ms <= 0 ? 'expired' : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} left`);
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
if (typeof window !== 'undefined' && typeof location !== 'undefined' && !location.pathname.startsWith('/login')) {
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
 * `computerLabel`: its name, or null for this computer. Returns { question, quote, notes: [sentences], why, details }.
 */
export function plainCard(card, { accounts = [], computerLabel = null } = {}) {
  const a = card.input || {};
  const lines = (card.lines || []).map(String);
  const acct = (n) => accounts.find((x) => x.name === n);
  const label = (n) => (n === 'auto' ? 'Auto mode' : (acct(n) && acct(n).label) || n);
  const on = computerLabel ? ` on ${computerLabel}` : '';
  const whyRaw = (lines.find((l) => l.startsWith('Why a card: ')) || '').slice('Why a card: '.length);
  const notes = [];
  let question;
  let quote = null;
  let target = null;
  if (card.tool === 'switch_account') {
    const m = lines.map((l) => /^Move session .* from (\S+) to (\S+)$/.exec(l)).find(Boolean);
    const from = m && m[1] !== 'null' ? m[1] : null;
    target = a.account || (m && m[2]);
    question = `Move the session ${a.session}${on}${from ? ` from ${label(from)}` : ''} to ${label(target)}?`;
    notes.push('The conversation carries on there where it stopped.');
    if (lines.some((l) => /is itself at a usage limit/.test(l))) notes.push(`${label(target)} is at its usage limit right now too.`);
  } else if (card.tool === 'start_session' || card.tool === 'start_chat') {
    target = a.account;
    question = `Start a ${card.tool === 'start_chat' ? 'chat' : 'session'} in ${String(a.folder || '').split(/[\\/]/).filter(Boolean).pop() || a.folder}${on}${target ? ` on ${label(target)}` : ''}?`;
    if (a.message) quote = a.message;
    if (a.goal) notes.push(`Done when: ${a.goal}.`);
  } else if (card.tool === 'send_to_session' && a.key === undefined) {
    question = `Type this into the session ${a.session}${on}?`;
    quote = a.text;
  } else if (card.tool === 'send_to_chat') {
    const words = { allow: 'Allow', allow_always: 'Allow, and not ask again in this chat,', deny: 'Say no to' };
    question = a.stop ? `Stop the reply in the chat ${a.session}${on}?` : a.answer ? `${words[a.answer] || a.answer} what the chat ${a.session}${on} asks?` : `Send this to the chat ${a.session}${on}?`;
    if (a.text !== undefined) quote = a.text;
  } else if (card.tool === 'press_key' || card.tool === 'send_to_session') {
    question = `Press ${a.key} in the session ${a.session}${on}?`;
  } else if (card.tool === 'stop_session') {
    question = `Stop the session ${a.session}${on}?`;
    notes.push('Its conversation is kept; you can continue it later.');
  } else if (card.tool === 'run_command') {
    question = `Run this command${on}${a.folder ? ` in ${a.folder}` : ''}?`;
    quote = a.command;
  } else if (card.tool === 'draft_skill') {
    question = `Add the skill "${a.name}"?`;
  } else {
    question = `${cap(TOOL_WORDS[card.tool] || card.tool)}${on}?`;
  }
  const asks = lines.find((l) => l.startsWith('The session asks: '));
  if (asks) notes.push(`The session asks: ${asks.slice('The session asks: '.length)}`);
  const paid = target && acct(target) && acct(target).kind === 'api';
  if (paid) notes.push(`${label(target)} is paid per use, so the work from here on costs money.`);
  const why = /paid per token/.test(whyRaw) ? `${NAME} asks because it costs money.`
    : /did not start/.test(whyRaw) ? `${NAME} asks because she did not start this session.`
      : /"Ask me"/.test(whyRaw) ? `${NAME} asks because you chose "Ask me" in Settings → ${NAME}.`
        : whyRaw ? `${NAME} asks because ${whyRaw.replace(/\.$/, '')}.`
          : `${NAME} asks before anything risky.`;
  // What the plain words above do not already say (other tools' own lines), for "Details".
  const said = ['switch_account', 'start_session', 'start_chat', 'send_to_session', 'send_to_chat', 'press_key', 'run_command'].includes(card.tool);
  const details = said ? [] : lines.filter((l) => !l.startsWith('Why a card: ') && !l.startsWith('The session asks: '));
  return { question, quote, notes, why, details };
}

/** The accounts and the name of the computer a card is about, from the page's own list of computers. */
function placeOf(card) {
  const c = card.input && card.input.computer;
  const m = (c && c !== 'this' ? store.all.find((x) => x.machine === c) : store.all.find((x) => !x.machine)) || null;
  return { accounts: (m && m.profiles) || [], computerLabel: c && c !== 'this' ? (m && m.machineLabel) || c : null };
}

function cardView(card, decided) {
  const p = plainCard(card, placeOf(card));
  const left = h('span.badge.soft.tia-left');
  const tick = () => (left.textContent = mmss(card.expiresAt - Date.now()));
  tick();
  const timer = setInterval(() => (document.body.contains(left) ? tick() : clearInterval(timer)), 1000);
  const result = h('p.tia-card-result', { role: 'status' });
  const decide = (how) => async (e) => {
    const box = e.target.closest('.tia-card');
    box.querySelectorAll('button').forEach((b) => (b.disabled = true));
    result.textContent = how === 'confirm' ? 'Doing it…' : 'Declining…';
    let outcome;
    try {
      await api(`${A}/cards/${card.id}/${how}`, {});
      outcome = how === 'confirm' ? { ok: true, text: `Done. ${NAME} was told, and carries on.` } : { ok: true, text: `Declined. Nothing was changed; ${NAME} was told.` };
    } catch (err) {
      outcome = { ok: false, text: `It did not run: ${err.message}. Ask ${NAME} again if you still want it.` };
    }
    decided(card, p, how, outcome);
  };
  return h('div.tia-card', { role: 'group', 'aria-label': `${NAME} asks for your OK` },
    h('div.tia-card-head', h('span.tia-card-icon', icon('alert', { size: 18 })), h('h3.tia-card-q', p.question), left),
    p.quote ? h('blockquote.tia-card-quote', p.quote) : null,
    p.notes.length ? h('p.tia-card-text', p.notes.join(' ')) : null,
    h('p.tia-card-why', p.why, ' Nothing happens until you confirm.'),
    p.details.length ? h('details.tia-card-details', h('summary', 'Details'), h('ul', p.details.map((l) => h('li', l)))) : null,
    h('div.tia-card-actions',
      btn('primary', { icon: 'check', label: 'Confirm', onclick: decide('confirm') }),
      btn('secondary', { icon: 'x', label: 'Decline', onclick: decide('reject') }),
      result));
}

/** A card after the owner decided: what happened, in one line, for a little while. */
const decidedView = (d) => h(`div.tia-card.decided${d.outcome.ok ? '' : '.failed'}`, { role: 'status' },
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
 * scrolls (the chat box), or null for the page. `fresh`: start a new conversation. Returns { stop }.
 */
function chatPanel(host, { scrollEl = null, fresh = false } = {}) {
  let es = null;
  let pollTimer = null;
  let on = true;
  const stop = () => {
    on = false;
    if (es) es.close();
    clearTimeout(pollTimer);
  };
  const list = h('div.tia-chat', { 'aria-live': 'polite' });
  const cardsBox = h('div.tia-cards');
  const working = h('p.tia-working', { role: 'status', hidden: true });
  const err = h('div.tia-error', { role: 'alert' });
  const input = h('textarea.field.tia-input', { rows: 1, placeholder: `Ask ${NAME} to get something done…`, 'aria-label': `Message to ${NAME}` });
  const send = btn('primary icon tia-send', { icon: 'send', title: 'Send', type: 'submit' });
  const form = h('form.tia-composer', { onsubmit: (e) => { e.preventDefault(); submit(); } }, input, send);
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
  });
  // Cards sit right above the message box, where the eye is, also after the chat scrolled down.
  fill(host, h('div.tia-chatwrap', list, working, cardsBox, h('div.tia-dock', err, form)));
  // The conversation open last time; on a first visit the newest one ("" means the owner started a new chat).
  const saved = convGet();
  let conv = fresh ? null : saved === null ? ((lastOverview && lastOverview.conversations && lastOverview.conversations[0]) || {}).id || null : saved || null;
  let next = 0;
  let tools = null; // the chip row of the current answer
  const decidedCards = new Map(); // card id → { question, how, outcome, at }
  const known = new Map(); // card id → its question, for the line in the chat once it is decided

  // To the newest message; but a card waiting for an OK is never left with its question out of sight: when the chat
  // ends below its top (a tall card, a short phone screen), the view moves up to the card's top, under the head and
  // the tabs that stay at the top.
  const toBottom = () => requestAnimationFrame(() => {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
    const card = [...cardsBox.querySelectorAll('.tia-card:not(.decided)')].pop();
    if (!card) return;
    const covered = scrollEl ? scrollEl.getBoundingClientRect().top : Math.max(0, ...[...document.querySelectorAll('.pagehead, .tia-tabs')].map((x) => x.getBoundingClientRect().bottom));
    const gap = card.getBoundingClientRect().top - covered - 8;
    if (gap < 0) (scrollEl || document.scrollingElement || document.documentElement).scrollTop += gap;
  });
  const busy = (text) => {
    working.hidden = !text;
    fill(working, text ? [h('span.tia-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', `${NAME} is ${text}…`)] : null);
  };
  const empty = () => fill(list, h('div.tia-empty',
    h('span.tia-off-icon', icon('sparkle', { size: 26 })),
    h('h2.tia-off-title', `Hi, I am ${NAME}.`),
    h('p', 'Tell me what to get done: I start Claude Code sessions in your projects, answer their questions, check the result and tell you when it is done. Try one:'),
    h('div.tia-examples', EXAMPLES.map((x) => h('button.tia-example', { type: 'button', onclick: () => { input.value = x; submit(); } }, icon('send', { size: 15 }), h('span', x))))));

  function render(e) {
    if (e.kind === 'owner') {
      tools = null;
      busy('thinking');
      return add(list, h('div.tia-msg.owner', e.text));
    }
    if (e.kind === 'text') {
      tools = null;
      return add(list, h('div.tia-msg.tia', boldText(e.text)));
    }
    if (e.kind === 'tool_call') {
      if (!tools) {
        tools = h('div.tia-tools');
        add(list, tools);
      }
      busy(DOING[e.tool] || 'working');
      const arg = e.input && (e.input.session || e.input.folder || e.input.query || e.input.job || '');
      return add(tools, h('span.tia-tool', { id: `tc-${e.id}`, 'data-tool': e.tool }, icon('zap', { size: 13 }), h('span', `${cap(DOING[e.tool] || e.tool)}${arg && !/^j_/.test(arg) ? ` · ${short(arg)}` : ''}`)));
    }
    if (e.kind === 'tool_result') {
      const chip = list.querySelector(`#tc-${CSS.escape(e.id)}`);
      if (chip) {
        const t = chip.dataset.tool;
        const words = e.card ? 'waits for your OK' : e.isError ? `could not ${TOOL_WORDS[t] && !/^(looked|read)/.test(TOOL_WORDS[t]) ? TOOL_WORDS[t] : 'do it'}` : DID[t] || 'done';
        chip.classList.add(e.card ? 'card' : e.isError ? 'err' : 'ok');
        chip.lastChild.textContent = cap(words);
        chip.title = e.summary || '';
      }
      if (e.card) {
        busy('waiting for your OK on the card above');
        refreshCards();
      }
      return null;
    }
    if (e.kind === 'wake') return add(list, h('p.tia-note', `${when(e.at)} · a session in her job ${e.reason === 'needs_ok' ? 'asks for permission' : e.reason === 'limit' ? 'reached a usage limit' : e.reason === 'ended' ? 'ended' : e.reason === 'expired' ? 'ran past the time allowed' : 'is waiting'}`));
    if (e.kind === 'card') {
      const q = known.get(e.card) || 'her request';
      const said = {
        done: `You confirmed, and it is done: ${q}`,
        failed: `You confirmed, but it did not run${e.error ? ` (${e.error})` : ''}: ${q}`,
        rejected: `You declined: ${q}`,
        expired: `Nobody answered in time, so nothing was done: ${q}`,
        stale: `Not done, because things changed since ${NAME} asked: ${q}`,
      }[e.status] || `${q} (${e.status})`;
      return add(list, h('p.tia-note', said));
    }
    if (e.kind === 'notice') return add(list, h('p.banner.warn', icon('alert', { size: 18 }), h('span', e.text)));
    if (e.kind === 'done') {
      tools = null;
      busy(null);
      if (!e.ok) {
        return add(list, h('div.banner.error-box.tia-stopped', { role: 'alert' }, icon('alert', { size: 18 }),
          h('span', `${NAME} stopped: ${e.error || 'something went wrong'}. Send your message again; if it keeps happening, check her provider in `, h('a', { href: '#/settings/tia' }, `Settings → ${NAME}`), '.')));
      }
      return Number.isFinite(e.costUsd) && e.costUsd > 0 ? add(list, h('p.tia-note', `This answer cost $${e.costUsd.toFixed(4)}`)) : null;
    }
    return null;
  }
  const renderAll = (events) => {
    for (const e of events) render(e);
    toBottom();
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
        convSet('');
        conv = null;
        return empty();
      }
    }
    pollTimer = setTimeout(follow, 3000);
  }
  async function refreshCards() {
    try {
      const r = await api(`${A}/cards`);
      if (!on) return;
      for (const c of r.cards) known.set(c.id, plainCard(c, placeOf(c)).question);
      const recent = [...decidedCards.values()].filter((d) => Date.now() - d.at < 20_000);
      const before = cardsBox.querySelectorAll('.tia-card').length;
      fill(cardsBox, recent.map(decidedView), r.cards.filter((c) => !decidedCards.has(c.id)).map((c) => cardView(c, decided)));
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
  function decided(card, p, how, outcome) {
    decidedCards.set(card.id, { question: p.question, how, outcome, at: Date.now() });
    refreshCards();
    setTimeout(() => on && refreshCards(), 20_500);
  }
  async function submit() {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    send.disabled = true;
    fill(err);
    busy('reading your message');
    try {
      const r = await api(`${A}/chat`, { text, conversation: conv || undefined, context: pageContext() });
      input.value = '';
      input.style.height = '';
      if (r.conversation !== conv) {
        conv = r.conversation;
        convSet(conv);
        fill(list);
        next = 0;
        if (es) es.close();
        follow();
      }
    } catch (e) {
      busy(null);
      fill(err, h('p.banner.error-box', icon('alert', { size: 18 }), h('span', `${NAME} did not get your message: ${e.message}. Your text is still in the box: press Send to try again.`)));
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  refreshCards();
  if (conv) {
    fill(list, h('div.tia-loading', h('div.spinner', { 'aria-hidden': 'true' })));
    poll().then(() => list.querySelector('.tia-loading')?.remove());
  } else empty();
  if (fresh) toast('New chat started');
  return { stop };
}

// ---------- the chat box: Tia on every page ----------
// The same chat as the Tia page (chatPanel), docked: on a desktop a round button at the bottom right opens it above
// itself; on a phone a small button in the page head opens it full height (the page's own main action keeps the one
// floating place). It stays open while the owner moves between pages (remembered on this device). Not while Tia is
// off, not on her own page, and not over a session's terminal (there it opens from the session's "more" sheet).
const box = { open: prefs.get('tia.box', false), forced: false, chat: null, root: null, body: null, count: null, head: null };
// The page head's button: made with each page head (only the newest is on the page), shown on a phone only.
registerHeadTool(() => {
  const n = h('span.tia-launch-n.hidden');
  box.head = h('button.icon-btn.tia-headbtn.hidden', { type: 'button', title: `Ask ${NAME}`, 'aria-label': `Ask ${NAME}`, onclick: () => setBox(!box.open) },
    icon('sparkle', { size: 16 }), n);
  box.head.count = n;
  setTimeout(paintBox, 0);
  return box.head;
});
function chatBox() {
  if (box.root) return box;
  box.body = h('div.tia-boxbody');
  box.count = h('span.tia-launch-n.hidden');
  const restart = (fresh) => {
    box.chat?.stop();
    box.chat = chatPanel(box.body, { scrollEl: box.body, fresh });
  };
  box.panel = h('section.tia-box.hidden', { role: 'dialog', 'aria-label': NAME },
    h('header.tia-boxhead',
      h('span.tia-boxname', NAME, h('span.badge.soft.tag', 'experimental')),
      btn('icon ghost small', { icon: 'plus', title: 'New chat', onclick: () => { convSet(''); restart(true); } }),
      h('a.btn.icon.ghost.small', { href: '#/tia', title: 'Open the full page', 'aria-label': 'Open the full page', onclick: () => setBox(false) }, icon('external', { size: 16 })),
      btn('icon ghost small', { icon: 'x', title: 'Close', onclick: () => setBox(false) })),
    box.body);
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
  paintBox();
  if (open) setTimeout(() => box.panel.querySelector('textarea')?.focus(), 50);
}
function paintBox() {
  if (typeof document === 'undefined' || !lastOverview) return;
  const on = lastOverview.enabled !== false;
  const here = /^#(\/m\/[^/]+)?\/tia(\/|$)/.test(location.hash || '');
  const terminal = document.body.classList.contains('term-mode');
  const n = (lastOverview.cards || []).length;
  if (box.head) {
    box.head.classList.toggle('hidden', !on || here);
    box.head.count.textContent = String(n);
    box.head.count.classList.toggle('hidden', !n);
    box.head.setAttribute('aria-expanded', String(box.open));
  }
  // While the round button shows, the page keeps the lane under it clear (page-automations.css, body.tia-fab).
  document.body.classList.toggle('tia-fab', on && !here && !terminal);
  if (!on || here || (terminal && !box.forced)) {
    if (box.root) box.root.classList.add('hidden');
    if (box.chat && (!on || here)) {
      box.chat.stop();
      box.chat = null;
    }
    return;
  }
  chatBox();
  box.root.classList.remove('hidden');
  box.root.classList.toggle('over-terminal', terminal);
  box.count.textContent = String(n);
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

function viewTia({ frame, sub }) {
  if (!VIEWS.some(([v]) => v === sub)) {
    location.replace('#/tia');
    return () => {};
  }
  let alive = true;
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
    title: [NAME, h('span.badge.soft.tag', 'experimental')],
    page: 'tia',
    actions: [newChat],
    intro: `${NAME} is your assistant: ask her to start, watch or move sessions; anything risky waits for your OK.`,
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
      fill(top);
      fill(body, h('div.tia-off',
        h('span.tia-off-icon', icon('sparkle', { size: 28 })),
        h('h2.tia-off-title', `${NAME} is off`),
        h('p', `${NAME} is a built-in assistant (experimental) that starts Claude Code sessions for you, watches them and asks you before anything risky.`),
        h('a.btn.primary', { href: '#/settings/tia' }, icon('power', { size: 18 }), h('span', `Turn on ${NAME} in Settings`))));
      return false;
    }
    fill(top, o && o.ready && !o.ready.ok
      ? h('p.banner.warn', icon('alert', { size: 18 }), h('span', `${o.ready.problem} `, h('a', { href: '#/settings/tia' }, `Open Settings → ${NAME}`)))
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
        h('span.row-main', h('span.row-title.tia-wrap', j.goal), h('span.row-sub', `${when(j.createdAt)} · ${j.sessions.map((s) => s.session).join(', ') || 'no session yet'} · ${j.steps} of ${j.maxSteps} answers used`)),
        h(`span.pill.${JOB_PILL[j.state] || 'st-starting'}`, h('span.dot'), JOB_WORDS[j.state] || j.state)),
      j.sessions.length ? h('div.tia-tools', j.sessions.map((s) => h('a.chip', { href: s.computer === 'this' ? `#/s/${encodeURIComponent(s.session)}` : `#/m/${s.computer}/s/${encodeURIComponent(s.session)}` }, icon('terminal', { size: 14 }), s.session))) : null,
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
    if (!alive) return;
    if (!r.entries.length) return fill(body, h('div.empty.compact', icon('text', { size: 28 }), h('div.empty-title', 'Nothing yet'), h('p', `Every change ${NAME} makes or proposes is listed here, and every OK you give.`)));
    fill(body, h('div.rows', r.entries.map((e) => h('div.row.static',
      h('span.row-icon', icon(e.actor === 'owner' ? 'user' : 'sparkle')),
      h('span.row-main',
        h('span.row-title.tia-wrap', `${e.actor === 'owner' ? 'You' : NAME}: ${TOOL_WORDS[e.tool] || e.tool}`),
        h('span.row-sub.tia-wrap', `${new Date(e.at).toLocaleString()} · ${OUTCOME[e.outcome] || e.outcome}${e.error ? ` · ${e.error}` : ''}`),
        Object.keys(e.input || {}).length ? h('span.row-sub.tia-wrap', Object.entries(e.input).map(([k, v]) => `${k}: ${short(v)}`).join(' · ')) : null)))));
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
  id: 'tia', title: NAME, icon: 'sparkle', group: 'more', order: 30, render: viewTia,
  badge: () => (lastOverview && lastOverview.cards ? lastOverview.cards.length : 0),
});

// ---------- Settings → Tia ----------
function tiaSettings({ isAlive }) {
  const box = h('div', h('p.hint', 'Loading…'));
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
    const st = { level: s.level, accounts: s.accounts ? [...s.accounts] : null, runsOn: s.runsOnSet || '', model: s.model || '', maxSteps: s.maxSteps, maxMinutes: s.maxMinutes };
    // On or off is kept at once (the page then shows or hides her settings); the rest with Save.
    const onOff = toggle(`${NAME} is on`, s.enabled, async (on) => {
      try {
        await api(`${A}/settings`, { enabled: on });
        pollOverview();
        setTimeout(paint, 900); // after "Saved" was seen
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
        paint();
        return false;
      }
    }, v.help.enabled);
    const levelWords = { ask: ['Ask me', v.help.levelAsk], work: ['Do the work', v.help.levelWork], handsoff: ['Hands off', v.help.levelHandsoff] };
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
      } }),
      h('span', providerWords(a)))));
    const nameOf = (n) => (n === 'auto' ? 'Auto mode' : ((choices.find((a) => a.name === n) || {}).label || n));
    const runs = h('select.field', { onchange: (e) => (st.runsOn = e.target.value) },
      h('option', { value: '', selected: !st.runsOn }, `Automatic (now: ${s.runsOn ? nameOf(s.runsOn) : 'none'})`),
      // She thinks through Claude Code: only the providers that serve it (`thinks`; absent from an older computer).
      choices.filter((a) => a.thinks !== false).map((a) => h('option', { value: a.name, selected: st.runsOn === a.name }, nameOf(a.name))));
    // The same choices as Settings → New-session defaults; a name set earlier by hand stays one of them.
    const models = [...MODELS];
    if (st.model && !models.some(([m]) => m === st.model)) models.push([st.model, st.model]);
    const model = h('select.field', { onchange: (e) => (st.model = e.target.value) },
      [['', 'The provider\'s default'], ...models].map(([m, t]) => h('option', { value: m, selected: m === st.model }, t)));
    const steps = h('input.field', { type: 'number', min: 1, max: 200, value: st.maxSteps, oninput: (e) => (st.maxSteps = Number(e.target.value)) });
    const mins = h('input.field', { type: 'number', min: 5, max: 10080, value: st.maxMinutes, oninput: (e) => (st.maxMinutes = Number(e.target.value)) });
    const field = (label, input, hint) => h('label.fieldrow', h('span.field-label', label), input, hint ? h('span.hint', hint) : null);
    fill(box,
      onOff,
      s.enabled ? [
        h('div.fieldrow', h('span.field-label', 'How far she may go'), levelSeg, levelHelp),
        h('div.fieldrow', h('span.field-label', 'Providers she may use'), checks, h('span.hint', v.help.accounts + (s.accountsDefault ? ' Now: the default — Auto mode when it is on, and every subscription; no API provider.' : ''))),
        field(`${NAME} runs on`, runs, v.help.runsOn),
        fold('tia-advanced', 'Advanced',
          field('Her model', model, v.help.model),
          field('Answers per job', steps, v.help.maxSteps),
          field('Minutes per job', mins, v.help.maxMinutes)),
        saveBar('Save', async () => {
          await api(`${A}/settings`, { level: st.level, accounts: st.accounts, runsOn: st.runsOn || null, model: st.model || null, maxSteps: st.maxSteps, maxMinutes: st.maxMinutes });
          pollOverview();
        }),
      ] : null);
    const u = v.usage;
    const line = (label, x) => h('div', h('span', label), h('strong', `${x.turns} turns · ${(x.input + x.cacheRead + x.cacheWrite).toLocaleString()} in / ${x.output.toLocaleString()} out · $${x.costUsd.toFixed(2)}`));
    fill(usageBox, h('h3.section-title', 'Usage'), h('div.kv', line('Today', u.today), line('Last 7 days', u.week), u.conversations.slice(-5).reverse().map((c) => line(`Conversation ${c.id.slice(-6)}`, c))), h('p.hint', v.help.usage));
    fill(clientBox,
      h('h3.section-title', 'Let my own Claude Code use these tools'),
      h('p.hint', v.help.client),
      v.client ? h('p.hint', `A token was made ${new Date(v.client.created).toLocaleDateString()}.`) : null,
      h('div.savebar',
        btn('secondary', { icon: 'key', label: v.client ? 'Make a new token' : 'Make a token', onclick: async () => {
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
  return [box, fold('tia-usage', 'Usage, and her tools in your own Claude Code', usageBox, clientBox)];
}

/** A provider by its name, with "(paid per use)" for an API unless its own name already says so. */
export const providerWords = (a) => (a.name === 'auto' ? 'Auto mode'
  : `${a.label || a.name}${a.kind === 'api' && !/\b(pay|paid)\b/i.test(a.label || a.name) ? ' (paid per use)' : ''}`);

registerSettingsPage({
  id: 'tia', title: NAME, icon: 'sparkle', order: 50, onlyHere: true, tag: 'experimental',
  desc: `${NAME} is the assistant: she gets coding work done through Claude Code sessions and tells you when it is done. Choose how far she may go and which providers she may use.`,
  summary: async () => {
    const v = await api(`${A}/settings`);
    return v.settings.enabled ? `On · ${{ ask: 'asks first', work: 'does the work', handsoff: 'hands off' }[v.settings.level] || v.settings.level}` : 'Off';
  },
  render: tiaSettings,
});
