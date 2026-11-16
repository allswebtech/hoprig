// The chat view of a Claude Code conversation (#/chat/<id>; #/m/<computer>/chat/<id> for another computer): coding
// without the terminal. Messages with Markdown, each tool call folded into one line (an edit as a small diff, Bash with
// its command) that opens to its input and result, a card with Allow / Deny when a tool use needs the owner's OK,
// the to-do list, Stop, a message box with attachments, the model and effort for the next turn, the provider and
// "Open in terminal". The server side is src/chat/feature.mjs.
//
// Fast with a long conversation: the newest few hundred events are drawn, earlier ones on request; new ones are
// added as they come (a long poll, so no event is drawn twice and nothing is drawn again); and every item is skipped
// by the browser's layout while it is off screen (content-visibility, page-chat.css).
// Text from Claude, tools and files is only ever set as text (h(), mdView).
import { accountLimitActions } from './claudeaccount.js';
import { icon } from './icons.js';
import { KIND, add, api, bytes, chooseSheet, closeWindow, confirmSheet, fill, h, link, machine, profileIcon, profileState, prefs, statusPill, toast, url } from './lib.js';
import { mdView } from './mdtext.js';
import { registerPage, registerSessionAction } from './registry.js';
import { EFFORT, MODELS } from './sessiondefaults.js';
import { pageNotify, store } from './store.js';
import { askTitle, lineDiff, money, toolLine, turnLine } from './chattext.js';
import { forgetHere, named, wayBack, windowWay } from './trail.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const finePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches; // desktop: Enter sends
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- drawing ----------

function diffView(input) {
  const pairs = Array.isArray(input.edits) ? input.edits : [input];
  const rows = pairs.flatMap((e, n) => [...(n ? [['…', '']] : []), ...lineDiff(e.old_string || '', e.new_string || '')]).slice(0, 400);
  return h('pre.chat-diff', rows.map(([m, t]) => h(`span.d${m === '+' ? 'add' : m === '-' ? 'del' : 'ctx'}`, `${m} ${t}\n`)));
}

/** A tool's input as a person reads it. */
function inputView(name, input) {
  const i = input || {};
  if ((name === 'Edit' || name === 'MultiEdit') && (i.old_string !== undefined || Array.isArray(i.edits))) {
    return [h('p.chat-path', i.file_path || ''), diffView(i)];
  }
  if (name === 'Write') return [h('p.chat-path', i.file_path || ''), h('pre.chat-diff', String(i.content || '').split('\n').slice(0, 400).map((t) => h('span.dadd', `+ ${t}\n`)))];
  if (name === 'Bash') return [h('pre.chat-cmd', i.command || ''), i.description ? h('p.chat-hint', i.description) : null];
  if (name === 'Read') return h('p.chat-path', `${i.file_path || ''}${i.offset ? ` · from line ${i.offset}` : ''}`);
  if (name === 'ExitPlanMode') return i.plan ? mdView(i.plan) : h('p.chat-hint', 'Claude wrote no plan text. Its messages above say what it wants to do.');
  return h('pre.chat-json', JSON.stringify(i, null, 2));
}

function toolItem(ev) {
  const line = toolLine(ev.name, ev.input);
  const result = h('div.chat-result');
  const el = h('details.chat-item.chat-tool',
    h('summary',
      h('span.chat-tool-dot', { 'aria-hidden': 'true' }),
      h('span.chat-tool-verb', line.verb),
      line.detail ? h(`span.chat-tool-detail${line.mono ? '.mono' : ''}`, line.detail) : null),
    h('div.chat-tool-body', inputView(ev.name, ev.input), result));
  el.result = result;
  return el;
}

function setResult(el, ev) {
  el.classList.add(ev.isError ? 'err' : 'ok');
  fill(el.result, ev.text ? h(`pre.chat-out${ev.isError ? '.err' : ''}`, ev.text) : h('p.chat-hint', 'No output.'));
}

// ---------- the page ----------

function viewChat({ sub }) {
  const id = String(sub || '');
  if (!ID_RE.test(id)) {
    location.replace(link('#/'));
    return () => {};
  }
  const A = `/api/chats/${id}`;
  const app = document.getElementById('app');
  document.body.classList.remove('has-nav');
  document.body.classList.add('chat-mode');
  store.viewing = `chat:${id}`;
  // The way back is the page you came from (trail.js), as in a terminal session; else Home.
  named('Chat');
  const inWindow = windowWay(); // a window of the desktop: the way back stays in its app, none where it starts
  const way = inWindow || wayBack() || { hash: link('#/'), label: 'Home' };
  let alive = true;
  let v = null; // the last view from the server
  let epoch = 0;
  let next = 0;
  let first = 0;
  const tools = new Map(); // tool use id → its item
  const asks = new Map(); // request id → its card
  const draftKey = `chat.draft.${id}`;

  // ---------- layout ----------
  const titleEl = h('span.chat-title-text', 'Chat');
  const subEl = h('div.chat-sub');
  const provBtn = h('button.profilebtn', { type: 'button', title: 'Move to another provider', onclick: () => moveProvider() },
    icon('user', { size: 16 }), h('span.profilebtn-label', '…'), icon('chevronDown', { size: 14 }));
  const bar = h('header.chat-bar',
    inWindow === null ? null : h('a.btn.ghost.chatback', { href: way.hash, 'aria-label': `Back to ${way.label}`, title: `Back to ${way.label}` }, icon('back'), h('span.chatback-label', way.label)),
    h('div.chat-head', h('h1.chat-title', titleEl), subEl),
    h('div.chat-bar-end', provBtn, h('button.btn.icon.ghost', { type: 'button', title: 'More for this chat', 'aria-label': 'More for this chat', onclick: () => menu() }, icon('more'))));
  const notes = h('div.chat-notes'); // a terminal runs it, a limit, the connection
  const moreSlot = h('div.chat-moreslot'); // "Show earlier messages"
  const olderBox = h('div.chat-older'); // earlier messages, once asked for
  const list = h('div.chat-list', { 'aria-live': 'polite' });
  const working = h('div.chat-working.hidden', { role: 'status' }, h('span.chat-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', 'Claude is working…'));
  const scroll = h('div.chat-scroll', h('div.chat-col', moreSlot, olderBox, list, working));
  const downBtn = h('button.btn.small.primary.chat-down.hidden', { type: 'button', onclick: () => toBottom(true) }, icon('down', { size: 16 }), h('span', 'New messages'));
  const todos = h('div.chat-todos');
  const nextRow = h('div.chat-next');
  const textarea = h('textarea.msg.chat-input', { rows: 1, 'aria-label': 'Message to Claude', placeholder: finePointer ? 'Message Claude — Enter sends, Shift+Enter new line' : 'Message Claude', enterkeyhint: finePointer ? 'send' : 'enter' });
  const fileInput = h('input.hidden', { type: 'file', multiple: true });
  const sendBtn = h('button.btn.primary.icon.send', { type: 'button', 'aria-label': 'Send', title: 'Send', onclick: () => sendMessage() }, icon('send', { size: 20 }));
  const stopBtn = h('button.btn.danger.icon.send.hidden', { type: 'button', 'aria-label': 'Stop', title: 'Stop Claude', onclick: () => stop() }, icon('stop', { size: 20 }));
  const attachBtn = h('button.btn.icon.ghost', { type: 'button', 'aria-label': 'Attach a file', title: 'Attach a file (it goes into the project folder)', onclick: () => fileInput.click() }, icon('paperclip'));
  const upStatus = h('div.upload-status.hidden', { role: 'status' });
  const dock = h('div.chat-dock', h('div.chat-col', todos, nextRow, upStatus, h('div.chat-composer', attachBtn, textarea, sendBtn, stopBtn, fileInput)));
  const wrap = h('div.chat-wrap', bar, notes, h('div.chat-mid', scroll, downBtn), dock);
  fill(app, wrap);

  // The height follows the visual viewport: the message box stays above an open phone keyboard.
  const vv = window.visualViewport;
  const onViewport = () => {
    if (!vv) return;
    wrap.style.setProperty('--vvh', `${vv.height}px`);
    wrap.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);
  onViewport();

  // ---------- scrolling ----------
  const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  function toBottom(force = false) {
    if (force || nearBottom()) {
      requestAnimationFrame(() => (scroll.scrollTop = scroll.scrollHeight));
      downBtn.classList.add('hidden');
    } else downBtn.classList.remove('hidden');
  }
  scroll.addEventListener('scroll', () => nearBottom() && downBtn.classList.add('hidden'));

  // ---------- the events ----------
  function item(ev) {
    switch (ev.kind) {
      case 'user':
        return h('div.chat-item.chat-user', ev.text);
      case 'text':
        return h('div.chat-item.chat-text', mdView(ev.text));
      case 'tool': {
        const el = toolItem(ev);
        tools.set(ev.id, el);
        return el;
      }
      case 'result': {
        const el = tools.get(ev.id);
        if (el) setResult(el, ev);
        return null;
      }
      case 'ask': {
        const el = askCard(ev);
        asks.set(ev.request, el);
        return el;
      }
      case 'answer': {
        const el = asks.get(ev.request);
        if (el) decided(el, ev.cancelled ? 'No longer waiting' : ev.allow ? (ev.always ? 'Allowed for this chat' : 'Allowed') : 'Denied', ev.allow);
        return null;
      }
      case 'done': {
        if (ev.ok) {
          const t = turnLine(ev);
          return t ? h('p.chat-item.chat-turn', icon('check', { size: 13 }), h('span', t)) : null;
        }
        if (ev.subtype === 'error_during_execution' || ev.subtype === 'stopped' || ev.error === 'stopped') return h('p.chat-item.chat-note', 'Stopped.');
        return h('div.chat-item.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', ev.error || 'The reply ended with an error.'));
      }
      case 'notice':
        return h('p.chat-item.chat-note', ev.text);
      default:
        return null;
    }
  }
  const draw = (events) => events.map(item).filter(Boolean);

  // ---------- the OK card ----------
  function askCard(ev) {
    const status = h('p.chat-ask-status', { role: 'status' });
    const buttons = h('div.chat-ask-actions');
    const body = h('div.chat-ask-body');
    const el = h('section.chat-item.chat-ask', { 'aria-label': askTitle(ev.tool, ev.input) },
      h('div.chat-ask-head', icon(ev.tool === 'AskUserQuestion' ? 'info' : 'alert', { size: 18 }), h('strong', askTitle(ev.tool, ev.input))),
      // For a file the description is its name, which the path below already shows.
      ev.description && !['Bash', 'Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit'].includes(ev.tool) ? h('p.chat-hint', ev.description) : null,
      body,
      // Why Claude Code asks, where the request does not say it: your own rule or hook, plan mode, a risky delete.
      ev.why ? h('p.chat-hint.chat-ask-why', icon('info', { size: 14 }), h('span', ev.why)) : null,
      buttons,
      // "Allow in this chat" may cover more than this one call (npm view *): say what, before it is pressed.
      ev.canAlways && ev.alwaysText ? h('p.chat-hint.chat-ask-scope', `“Allow in this chat” stops the asking for: ${ev.alwaysText}`) : null,
      status);
    el.status = status;
    el.buttons = buttons;
    const answer = async (allow, extra = {}) => {
      for (const b of buttons.querySelectorAll('button')) b.disabled = true;
      try {
        await api(`${A}/answer`, { request: ev.request, allow, ...extra });
        store.refresh(); // Home and the tab title follow at once, not at the next look
      } catch (e) {
        // Answered meanwhile (another tab, or the turn ended): the card closes with the next news, not with an error.
        if (e.status === 409) return;
        for (const b of buttons.querySelectorAll('button')) b.disabled = false;
        toast(e.message, { kind: 'error' });
      }
    };
    if (ev.tool === 'AskUserQuestion' && Array.isArray(ev.input.questions)) {
      // Each question with its options; the chosen labels go back as Claude Code expects them (agent-sdk/user-input).
      const chosen = new Map();
      fill(body, ev.input.questions.slice(0, 10).map((q) => {
        const opts = Array.isArray(q.options) ? q.options.slice(0, 12) : [];
        const row = h('div.chat-q-opts', { role: q.multiSelect ? 'group' : 'radiogroup' }, opts.map((o) =>
          h('button.chip', { type: 'button', 'aria-pressed': 'false', title: o.description || '', onclick: (e) => {
            const set = chosen.get(q.question) || new Set();
            if (!q.multiSelect) set.clear();
            if (set.has(o.label)) set.delete(o.label);
            else set.add(o.label);
            chosen.set(q.question, set);
            for (const b of row.querySelectorAll('button')) b.setAttribute('aria-pressed', String(set.has(b.textContent)));
            e.currentTarget.blur();
          } }, o.label)));
        return h('div.chat-q', h('p.chat-q-text', q.question), row);
      }));
      fill(buttons,
        h('button.btn.primary', { type: 'button', onclick: () => {
          const answers = {};
          for (const [k, set] of chosen) if (set.size) answers[k] = [...set].join(', ');
          if (!Object.keys(answers).length) return toast('Choose an answer first', { kind: 'error' });
          answer(true, { answers });
        } }, 'Send answer'),
        h('button.btn.secondary', { type: 'button', onclick: () => answer(false, { message: 'the user preferred to answer in a message' }) }, 'Answer in a message'));
    } else {
      fill(body, inputView(ev.tool, ev.input));
      fill(buttons,
        h('button.btn.primary', { type: 'button', onclick: () => answer(true) }, icon('check', { size: 16 }), h('span', ev.tool === 'ExitPlanMode' ? 'Start with this plan' : 'Allow')),
        ev.canAlways ? h('button.btn.secondary', { type: 'button',
          title: ev.always === 'edits' ? 'Claude changes files without asking for the rest of this chat' : `Claude does not ask again in this chat for: ${ev.alwaysText || 'this'}`,
          onclick: () => answer(true, { always: true }) }, ev.always === 'edits' ? 'Allow all edits in this chat' : 'Allow in this chat') : null,
        h('button.btn.secondary.danger-text', { type: 'button', onclick: () => answer(false) }, icon('x', { size: 16 }), h('span', ev.tool === 'ExitPlanMode' ? 'Keep planning' : 'Deny')));
    }
    return el;
  }
  function decided(el, text, ok) {
    if (el.done) return;
    el.done = true;
    el.classList.add('decided');
    fill(el.buttons);
    fill(el.status, icon(ok ? 'check' : 'x', { size: 14 }), h('span', text));
  }

  // ---------- state ----------
  function paint() {
    const s = v;
    fill(titleEl, s.title || 'New chat');
    pageNotify.setTitleBase(s.title || 'Chat');
    named(s.title || 'Chat');
    const pill = statusPill({ status: s.status, statusAt: null }, { time: false });
    // A narrow screen cuts the words of the state, not the pill: they go in a span that can end in "…".
    fill(pill, [...pill.childNodes].map((n) => (n.nodeType === 3 ? h('span.chat-pill-text', n.textContent) : n)));
    fill(subEl, pill, h('span.chat-where', ` · ${s.short}`), s.liveModel || s.model ? h('span.chat-where', ` · ${s.liveModel || s.model}`) : null,
      Number.isFinite(s.costTotal) && s.costTotal > 0 ? h('span.chat-where', ` · ${money(s.costTotal)} so far`) : null);
    fill(provBtn.querySelector('.profilebtn-label'), s.profile.label);
    const ro = !!s.terminal;
    fill(notes,
      ro ? h('div.banner.warn.chat-banner', icon('terminal', { size: 18 }),
        h('span', s.terminal.name ? `This conversation runs in the terminal session "${s.terminal.name}". You can read along here; to write, continue it here.` : 'This conversation runs in a terminal outside the dashboard. You can read along here; to write, continue it here.'),
        h('span.chat-banner-actions',
          h('button.btn.small.primary', { type: 'button', onclick: () => takeOver() }, 'Continue here'),
          s.terminal.name ? h('a.btn.small.secondary', { href: link(`#/s/${encodeURIComponent(s.terminal.name)}`) }, 'Open the terminal') : null))
        : null,
      s.limit && !ro ? limitBanner(s) : null);
    const busy = s.status !== 'waiting';
    working.classList.toggle('hidden', s.status !== 'working');
    sendBtn.classList.toggle('hidden', busy);
    stopBtn.classList.toggle('hidden', !busy);
    textarea.disabled = ro;
    attachBtn.disabled = ro;
    if (ro) textarea.placeholder = 'Read only while the terminal runs this conversation';
    else textarea.placeholder = finePointer ? 'Message Claude — Enter sends, Shift+Enter new line' : 'Message Claude';
    // Cards that no longer wait (answered elsewhere, or the turn ended) close.
    for (const [r, el] of asks) if (!s.pending.includes(r)) decided(el, 'No longer waiting', false);
    paintTodos(s.todos);
    paintNext();
  }

  // The provider cannot answer: move the chat to another one, or (on Claude Code's stored sign-in) go on with another
  // Claude account (claudeaccount.js). Once another account signed in, going on here leads.
  function limitBanner(s) {
    const account = (accountLimitActions({ kind: 'chat', chatId: s.id, name: `chat:${s.id}`, display: s.title || 'This chat', profile: s.profile, limit: s.limit, limitAt: s.limit.at || null, machine: machine.current },
      (store.data && store.data.profiles) || []) || []).filter(Boolean);
    const leads = account.filter((b) => /(^|\s)primary(\s|$)/.test(b.className));
    const move = h(`button.btn.small.${leads.length ? 'secondary' : 'primary'}`, { type: 'button', onclick: () => moveProvider() }, icon('swap', { size: 16 }), h('span', 'Move to another provider'));
    return h('div.banner.error-box.chat-banner', { role: 'alert' }, icon('alert', { size: 18 }), h('span', `${s.profile.label} cannot answer now: ${s.limit.text}`),
      h('span.chat-banner-actions', leads, move, account.filter((b) => !leads.includes(b))));
  }

  let todosOpen = prefs.get('chat.todos', true);
  function paintTodos(items) {
    if (!items || !items.length) return fill(todos);
    const done = items.filter((t) => t.status === 'completed').length;
    const now = items.find((t) => t.status === 'in_progress');
    const head = h('button.chat-todos-head', { type: 'button', 'aria-expanded': String(todosOpen), onclick: () => {
      todosOpen = !todosOpen;
      prefs.set('chat.todos', todosOpen);
      paintTodos(items);
    } }, icon(todosOpen ? 'chevronDown' : 'chevronRight', { size: 14 }), h('strong', `To-do ${done}/${items.length}`), now ? h('span.chat-todo-now', now.activeForm || now.content) : null);
    fill(todos, head, todosOpen ? h('ul.chat-todo-list', items.map((t) => h(`li.t-${t.status}`, h('span.chat-todo-mark', { 'aria-hidden': 'true' }, t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'), h('span', t.content)))) : null);
  }

  function paintNext() {
    const modelName = (m) => (m ? (MODELS.find(([x]) => x === m) || [m, m])[1].split(':')[0] : 'Default model');
    fill(nextRow,
      h('span.chat-next-label', 'Next message:'),
      h('button.chip', { type: 'button', onclick: () => chooseNext('model') }, icon('sparkle', { size: 13 }), h('span', modelName(v.model)), icon('chevronDown', { size: 12 })),
      h('button.chip', { type: 'button', onclick: () => chooseNext('effort') }, icon('zap', { size: 13 }), h('span', v.effort ? `Effort ${v.effort}` : 'Default effort'), icon('chevronDown', { size: 12 })));
  }
  async function chooseNext(what) {
    const cur = v[what];
    const items = what === 'model'
      ? [{ value: '', label: 'Default model', sub: 'As Claude Code chooses' }, ...v.choices.models.map((m) => ({ value: m, label: (MODELS.find(([x]) => x === m) || [m, m])[1] }))]
      : [{ value: '', label: 'Default effort', sub: 'As Claude Code chooses' }, ...v.choices.efforts.map((e) => ({ value: e, label: EFFORT[e] || e }))];
    const pick = await chooseSheet({ title: what === 'model' ? 'Model for the next message' : 'How hard Claude thinks', subtitle: 'From the next message on, in this chat.', items: items.map((x) => ({ ...x, current: (x.value || null) === (cur || null) })) });
    if (pick === null || (pick || null) === (cur || null)) return;
    try {
      await api(`${A}/next`, { [what]: pick || null });
      v[what] = pick || null;
      paintNext();
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  // ---------- following the server ----------
  function apply(r) {
    const stick = nearBottom();
    if (r.reset) {
      tools.clear();
      asks.clear();
      fill(olderBox);
      fill(list, draw(r.events));
      epoch = r.epoch;
      first = r.first;
    } else if (r.events.length) {
      list.querySelector('.chat-empty')?.remove();
      add(list, draw(r.events));
    }
    next = r.next;
    // The state changed (an OK is needed, was given here or in another tab, the reply ended): Home's copy is old.
    if (v && v.status !== r.status) store.refresh();
    v = r;
    if (r.reset) paintMore(r.older);
    if (!r.events.length && r.reset && !r.older) fill(list, h('div.chat-empty', icon('text', { size: 26 }), h('p', 'Write what Claude should do in this project. It works here as in the terminal: it reads, edits and runs commands, and asks you before anything that needs your OK.')));
    paint();
    if (r.reset) toBottom(true);
    else if (r.events.length) toBottom(stick);
  }

  const paintMore = (more) => fill(moreSlot, more ? h('button.btn.small.secondary.chat-more', { type: 'button', onclick: (e) => older(e.currentTarget) }, 'Show earlier messages') : null);
  async function older(btnEl) {
    btnEl.disabled = true;
    try {
      const r = await api(`${A}/older?before=${first}`);
      const h0 = scroll.scrollHeight;
      if (r.events.length) {
        // Earlier events go above what is shown: a chunk of their own, first in the box.
        const shown = [...olderBox.children];
        fill(olderBox, h('div.chat-chunk', draw(r.events)), shown);
        first = r.events[0].i;
      }
      paintMore(r.events.length > 0 && first > r.base);
      // Keep what was on screen where it was.
      scroll.scrollTop += scroll.scrollHeight - h0;
    } catch (e) {
      btnEl.disabled = false;
      toast(e.message, { kind: 'error' });
    }
  }

  function gone() {
    forgetHere(); // a chat that is not open any more is never a way back
    fill(wrap, bar, h('div.chat-mid', h('div.empty', icon('text', { size: 32 }),
      h('p', 'This chat is not open any more: it was closed, or opened in a terminal.'),
      // A window that started on this chat has no page to go back to: it offers to close instead.
      inWindow === null
        ? h('button.btn.primary', { type: 'button', onclick: () => closeWindow() }, icon('x', { size: 18 }), h('span', 'Close window'))
        : h('a.btn.primary', { href: way.hash }, icon(way.label === 'Home' ? 'home' : 'back', { size: 18 }), h('span', way.label === 'Home' ? 'Home' : `Back to ${way.label}`)))));
  }

  async function follow() {
    let wait = 0;
    let failures = 0;
    while (alive) {
      try {
        const r = await api(`${A}?from=${next}&epoch=${epoch}&wait=${wait}`);
        if (!alive) return;
        if (failures) fill(notes);
        failures = 0;
        apply(r);
        wait = 20;
      } catch (e) {
        if (!alive) return;
        if (e.status === 404) return gone();
        failures++;
        if (failures === 2) add(notes, h('div.banner.warn', { role: 'status' }, icon('refresh', { size: 18 }), h('span', 'Connection lost — reconnecting…')));
        await sleep(Math.min(10_000, 1000 * 2 ** Math.min(failures, 4)));
        wait = 0;
      }
    }
  }

  // ---------- actions ----------
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, Math.round(innerHeight * 0.3))}px`;
  };
  textarea.value = prefs.get(draftKey, '');
  textarea.addEventListener('input', () => {
    prefs.set(draftKey, textarea.value);
    grow();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && finePointer && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function sendMessage() {
    const text = textarea.value.replace(/\s+$/, '');
    if (!text) return textarea.focus();
    if (v && v.status !== 'waiting') return toast('Claude is still working. Wait, or press Stop.', { kind: 'error' });
    sendBtn.disabled = true;
    try {
      await api(`${A}/send`, { text });
      textarea.value = '';
      prefs.set(draftKey, '');
      grow();
      toBottom(true);
    } catch (e) {
      toast(`Not sent: ${e.message}`, { kind: 'error' });
    } finally {
      sendBtn.disabled = false;
      textarea.focus();
    }
  }

  async function stop() {
    stopBtn.disabled = true;
    try {
      await api(`${A}/stop`, {});
    } catch (e) {
      toast(e.message, { kind: 'error' });
    } finally {
      stopBtn.disabled = false;
    }
  }

  async function takeOver() {
    const ok = await confirmSheet({
      title: 'Continue here?',
      text: 'Claude stops in the terminal (the terminal stays, as a plain shell) and the conversation goes on in this chat. A reply the terminal is writing right now is cut off.',
      ok: 'Continue here',
    });
    if (!ok) return;
    try {
      await api(`${A}/take`, {});
      toast('The conversation continues here');
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  async function moveProvider() {
    const profiles = ((store.data && store.data.profiles) || []).filter((p) => p.name);
    if (!profiles.length) return toast('No other provider on this computer', { kind: 'error' });
    const pick = await chooseSheet({
      title: 'Continue on…',
      subtitle: 'The next message goes to this provider; the conversation stays the same.',
      items: profiles.map((p) => ({
        value: p.name, label: p.label, icon: profileIcon(p),
        sub: p.virtual ? profileState(p).text : `${KIND[p.kind] || p.kind} · ${profileState(p).text}`,
        current: v && v.profile.name === p.name, disabled: v && v.profile.name === p.name,
      })),
    });
    if (!pick) return;
    try {
      await api(`${A}/provider`, { profile: pick });
      toast(`The next message goes to ${(profiles.find((p) => p.name === pick) || {}).label || pick}`);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  async function openInTerminal() {
    const ok = await confirmSheet({
      title: 'Open in a terminal?',
      text: 'The same conversation continues in a terminal session, with Claude Code as you know it. This chat closes; you can open the session as a chat again from its menu.',
      ok: 'Open in terminal',
    });
    if (!ok) return;
    try {
      const { name } = await api(`${A}/terminal`, {});
      store.refresh();
      forgetHere(); // the chat closes: the terminal goes back to where the chat would have
      location.hash = link(`#/s/${encodeURIComponent(name)}`);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  async function menu() {
    const busy = v && v.status !== 'waiting';
    const what = await chooseSheet({
      title: (v && v.title) || 'Chat',
      subtitle: v ? v.short : null,
      items: [
        busy ? { value: 'stop', label: 'Stop Claude', sub: 'Ends the reply it is writing', icon: 'stop' } : null,
        { value: 'terminal', label: 'Open in terminal', sub: 'The same conversation, in a terminal session', icon: 'terminal' },
        { value: 'provider', label: 'Move to another provider', sub: v ? `Now: ${v.profile.label}` : '', icon: 'swap' },
        { value: 'attach', label: 'Attach a file', sub: 'Upload into the project; its path goes into your message', icon: 'paperclip' },
        { value: 'close', label: 'Close this chat', sub: 'The conversation stays; it leaves Home', icon: 'trash', danger: true },
      ].filter(Boolean),
    });
    if (what === 'stop') stop();
    else if (what === 'terminal') openInTerminal();
    else if (what === 'provider') moveProvider();
    else if (what === 'attach') fileInput.click();
    else if (what === 'close') {
      if (!(await confirmSheet({ title: 'Close this chat?', text: 'Claude stops if it is working. The conversation is kept: you can continue it later from New session → Options → Conversation.', ok: 'Close', danger: true }))) return;
      try {
        await api(`${A}/close`, {});
        store.refresh();
        forgetHere();
        if (inWindow !== null) location.hash = way.hash;
        else if (!closeWindow()) gone();
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    }
  }

  // ---------- attachments (the same uploads folder as a session's) ----------
  const insertText = (t) => {
    const s = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, s);
    textarea.value = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${t} ${textarea.value.slice(textarea.selectionEnd ?? s)}`;
    prefs.set(draftKey, textarea.value);
    grow();
  };
  const upload = (file) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); // XHR, not fetch: it reports upload progress
    xhr.open('POST', url(`${A}/upload`));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'upload'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) upStatus.textContent = `Uploading ${file.name}: ${Math.round((e.loaded / e.total) * 100)}% of ${bytes(e.total)}`;
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: connection lost'));
    xhr.send(file);
  });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    upStatus.classList.remove('hidden');
    for (const f of files) {
      try {
        insertText((await upload(f)).path);
        toast(`${f.name} is in the project folder; its path is in your message`);
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    }
    upStatus.classList.add('hidden');
    textarea.focus();
  });

  fill(list, h('div.chat-loading', h('div.spinner', { 'aria-hidden': 'true' })));
  grow();
  follow();
  return () => {
    alive = false;
    store.viewing = null;
    document.body.classList.remove('chat-mode');
    vv?.removeEventListener('resize', onViewport);
    vv?.removeEventListener('scroll', onViewport);
  };
}

registerPage({ id: 'chat', title: 'Chat', icon: 'text', navAs: 'home', perComputer: true, render: viewChat });

// The terminal session's "more" sheet: the same conversation as a chat (it runs in the terminal until "Continue here").
registerSessionAction({
  id: 'open-chat',
  label: 'Open as chat',
  sub: 'The same conversation, without the terminal',
  icon: 'text',
  describe: (me) => {
    const s = ((store.data && store.data.sessions) || []).find((x) => x.name === me.name);
    return s && s.kind === 'claude' && s.sessionId ? {} : null;
  },
  run: async (me) => {
    try {
      const { id } = await api('/api/chats/from-session', { session: me.name });
      location.hash = link(`#/chat/${id}`, me.machine);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  },
});
