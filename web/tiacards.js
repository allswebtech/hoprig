// Tia's cards on her page (src/assistant/cardkinds.mjs has the kinds): each drawn from the card's data with h() and
// text nodes only; a link only when it is a page address of this dashboard. Nothing in a card is read as HTML.
//
// A status, progress or needs card follows its subject while it is in view: a session or a computer through the page's
// own poller (store.js, every 3 s, 15 s while the tab is hidden), the others by ONE request per tick of that same poller
// for every such card on screen (POST /api/assistant/views). No card has a timer of its own. A card keeps its height
// while what it says changes, so nothing below it jumps.
import { icon } from './icons.js';
import { add, api, confirmSheet, fill, h, span as unit, toast } from './lib.js';
import { redact } from './redact.js';
import { store } from './store.js';

const HREF = /^#\/[A-Za-z0-9_\-./%:]{0,190}$/;
export const STATE_WORDS = {
  starting: 'Starting', working: 'Working', waiting: 'Finished', asks: 'Needs your OK', limit: 'Stopped at a usage limit',
  ended: 'Ended', shell: 'Terminal', online: 'Online', offline: 'Not reachable now', unknown: 'Not known now', gone: 'Gone',
};
export const RUN_WORDS = { working: 'Working', waiting: 'Waiting for you', done: 'Done', stuck: 'Stuck', stopped: 'Stopped', failed: 'Failed', limit: 'Stopped at a usage limit', unknown: 'Not known now', gone: 'Gone' };
const PILL = { asks: 'attention', limit: 'limit', failed: 'limit', stuck: 'limit', offline: 'limit', waiting: 'waiting', working: 'working', starting: 'working', online: 'working' };
const ENDED = new Set(['ended', 'done', 'stuck', 'stopped', 'failed', 'gone', 'shell']);
const RISK_WORDS = { stops: 'It stops work that runs.', others: 'Others will see it.' };
const UNIT = { '%': '%', sessions: ' sessions', load: '', tasks: ' tasks' };

/** A page address of this dashboard as a link, or plain text when it is anything else. */
export function pageLink(href, label, cls = 'a.btn.small.secondary.tia-c-step', attrs = {}) {
  return typeof href === 'string' && HREF.test(href) ? h(cls, { href, ...attrs }, h('span', label)) : h('span.tia-c-sub', label);
}
const pill = (state, words) => h(`span.pill.st-${PILL[state] || 'starting'}.tia-c-pill`, h('span.dot'), words[state] || state);
/**
 * A length of time in the page's one unit rule (lib.js span: "4 min", "7 h", "2 days"), so a card says what Home and
 * the sheet say; only less than a minute, which that rule rounds up, reads "under a minute".
 */
const span = (ms) => (ms < 60_000 ? 'under a minute' : unit(ms));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const frame = (kind, label, ...body) => h(`section.tia-c.tia-c-${kind}`, { role: 'group', 'aria-label': label }, ...body);

// ---------- the static kinds ----------

function openCard(c) {
  return frame('open', c.label, pageLink(c.href, c.label, 'a.btn.primary.tia-c-openbtn', { 'aria-label': c.label }));
}

// A list without states (tasks, the setup) is drawn once. A list of sessions or computers follows the page's own poller
// as a status card does (fromStore): it shows the states of now and says as of when. Until the poller has them, a list
// drawn again from the history (a reload, another device, the page opened later) leaves its states out instead of
// claiming ones that may be over; one just made shows its own.
function listCard(c) {
  return frame('list', c.title, ...listBody(c, source.now(), false));
}
function listBody(c, now, checking) {
  const states = !checking && c.items.some((it) => it.state);
  const more = c.total > c.items.length ? `Showing ${c.items.length} of ${c.total}.` : null;
  const when = checking ? `Read at ${clock(c.at)}; open the page for what is so now.` : states ? `As of ${clock(c.seen ?? c.at)}.` : null;
  const foot = [more, when].filter(Boolean).join(' ');
  const state = (it) => (it.state && states ? it.state : null);
  return [
    h('h3.tia-c-title', c.title),
    c.items.length ? h('ul.tia-c-items', c.items.map((it) => h('li', it.href && HREF.test(it.href)
      ? h('a.tia-c-item', { href: it.href }, state(it) ? h(`span.tia-c-dot.st-${PILL[it.state] || 'starting'}`, { title: STATE_WORDS[it.state] || it.state }) : null,
        h('span.tia-c-itemtext', h('span.tia-c-label', it.label), it.sub ? h('span.tia-c-sub', it.sub) : null),
        state(it) ? h('span.tia-c-state', STATE_WORDS[it.state] || it.state) : null)
      : h('span.tia-c-item', h('span.tia-c-itemtext', h('span.tia-c-label', it.label), it.sub ? h('span.tia-c-sub', it.sub) : null)))))
      : h('p.tia-c-sub', 'Nothing here.'),
    h('div.tia-c-foot', foot ? h('span.tia-c-sub', foot) : null, pageLink(c.all.href, c.all.label)),
  ];
}

function numbersCard(c) {
  return frame('numbers', c.title,
    h('h3.tia-c-title', c.title),
    h('dl.tia-c-rows', c.rows.map((r) => h('div.tia-c-row',
      h('dt', r.label),
      h('dd', h('span.tia-c-fig', `${Number.isInteger(r.value) ? r.value : r.value.toFixed(1)}${UNIT[r.unit] ?? ''}`),
        r.of ? h('span.tia-c-meter', { 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(0, Math.min(100, (r.value / r.of) * 100))}%` } })) : null,
        r.note ? h('span.tia-c-sub', r.note) : null)))),
    h('p.tia-c-sub', `As of ${clock(c.asOf)}`));
}

/**
 * A choice: each answer is one tap that sends its words as the owner's message (`answer`), nothing else. An answer
 * written in its own box goes with the card's id, so the history knows it was answered from here (closeChoice).
 */
function choiceCard(c, { answer }) {
  const buttons = c.options.map((o) => h('button.btn.secondary.tia-c-option', { type: 'button', onclick: () => pick(o) }, h('span', o)));
  const free = c.free ? h('input.field.tia-c-free', { type: 'text', maxlength: 500, placeholder: 'Or write your own answer', 'aria-label': 'Your own answer' }) : null;
  const send = c.free ? h('button.btn.primary.tia-c-sendown', { type: 'button', onclick: () => free.value.trim() && pick(free.value.trim(), c.id) }, h('span', 'Send')) : null;
  const said = h('p.tia-c-said', { role: 'status' });
  const el = frame('choice', `Tia asks: ${c.question}`,
    h('div.tia-c-head', h('span.tia-c-icon', icon('comment', { size: 18 })), h('h3.tia-c-title', c.question)),
    h('div.tia-c-options', buttons),
    c.free ? h('div.tia-c-ownrow', free, send) : null,
    said);
  el.dataset.view = c.id;
  if (free) free.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send.click(); } });
  async function pick(text, choice = null) {
    if (el.classList.contains('answered')) return;
    el.dataset.sent = text; // his message that comes back is this card's answer (closeChoice)
    if ((await answer(text, choice)) === false) {
      delete el.dataset.sent;
      return;
    }
    markAnswered(el, text);
  }
  return el;
}
/**
 * His next message closes an open choice: it is his answer only when it is one of its answers or was sent from the card
 * itself (`choice`: the card id his message carries, kept by the server, so a reload and another device know it too);
 * any other message closes it without claiming he answered.
 */
export function closeChoice(el, text, choice = null) {
  const options = [...el.querySelectorAll('.tia-c-option')].map((b) => b.textContent);
  if (options.includes(text) || el.dataset.sent === text || (choice && choice === el.dataset.view)) return markAnswered(el, text);
  markAnswered(el);
  const said = el.querySelector('.tia-c-said');
  if (said) said.textContent = 'Closed: you wrote a message instead.';
}
/** A choice that was answered (now, or by a later message of his): its buttons are done. */
export function markAnswered(el, text = null) {
  el.classList.add('answered');
  for (const b of el.querySelectorAll('button, input')) b.disabled = true;
  if (text) for (const b of el.querySelectorAll('.tia-c-option')) b.setAttribute('aria-pressed', String(b.textContent === text));
  const said = el.querySelector('.tia-c-said');
  if (said) said.textContent = text ? `You answered: ${text}` : 'Answered.';
}

function resultCard(c, opts) {
  const el = frame('result', c.title);
  const draw = (card, note = null) => fill(el,
    h('div.tia-c-head', h(`span.tia-c-icon${card.ok ? '.ok' : '.bad'}`, icon(card.ok ? 'check' : 'alert', { size: 18 })), h('h3.tia-c-title', card.title)),
    card.changed.length ? h('ul.tia-c-changed', card.changed.map((x) => h('li', x))) : null,
    note ? h('p.tia-c-note', { role: 'status' }, note) : null,
    h('div.tia-c-foot', pageLink(card.see.href, card.see.label), card.undo ? h('button.btn.small.secondary.tia-c-undo', { type: 'button', onclick: (e) => undo(card, e.currentTarget) }, icon('undo', { size: 16 }), h('span', 'Undo')) : null));
  async function undo(card, b) {
    b.disabled = true;
    try {
      const r = await (opts.undo || ((id) => api(`~/api/assistant/views/${id}/undo`, {})))(card.id);
      draw(r.card, 'Taken back. Tia was told.');
    } catch (e) {
      draw(e.data && e.data.card ? e.data.card : { ...card, undo: false }, `Not taken back: ${e.message}.`);
    }
    el.querySelector('.tia-c-foot a, .tia-c-foot button')?.focus({ preventScroll: true });
  }
  draw(c);
  return el;
}

// ---------- the dynamic kinds ----------

function statusBody(c, now, checking) {
  const ended = ENDED.has(c.state);
  return [
    h('div.tia-c-head', h('span.tia-c-icon', icon(c.subject.type === 'computer' ? 'monitor' : 'terminal', { size: 18 })), h('h3.tia-c-title', c.title),
      checking ? h('span.tia-c-sub', 'Checking…') : pill(c.state, STATE_WORDS)),
    h('p.tia-c-sub.tia-c-since', checking ? 'Reading what is so now.' : c.state === 'gone' ? (c.subject.type === 'session' ? 'This session has ended.' : 'It is no longer there.')
      : c.state === 'offline' ? 'It cannot be reached now, so what runs there is not known.'
        : c.since ? `${ended ? 'Since' : 'For'} ${ended ? clock(c.since) : span(now - c.since)}` : ' '),
    c.note && !checking ? h('p.tia-c-note', c.note) : null,
    c.state === 'gone' ? null : h('div.tia-c-foot', pageLink(c.step.href, c.step.label, c.state === 'asks' ? 'a.btn.small.primary.tia-c-step' : undefined)),
  ];
}

function progressBody(c, now, checking) {
  const end = c.ended || (ENDED.has(c.state) ? c.at : null);
  return [
    h('div.tia-c-head', h('span.tia-c-icon', icon('tasks', { size: 18 })), h('h3.tia-c-title', c.title), checking ? h('span.tia-c-sub', 'Checking…') : pill(c.state, RUN_WORDS)),
    h('ol.tia-c-steps', { 'aria-label': `${Math.min(c.done, c.steps.length)} of ${c.steps.length} steps done` }, c.steps.map((s, i) => h(`li${i < c.done ? '.done' : i === c.done && !ENDED.has(c.state) ? '.now' : ''}`,
      h('span.tia-c-tick', { 'aria-hidden': 'true' }, i < c.done ? icon('check', { size: 13 }) : null), h('span', s)))),
    h('p.tia-c-sub.tia-c-since', checking ? 'Reading what is so now.' : c.state === 'gone' ? 'It is no longer there.'
      : c.started ? (end ? `Took ${span(end - c.started)}, ended ${clock(end)}` : `${span(now - c.started)} so far`) : ' '),
    c.state === 'gone' ? null : h('div.tia-c-foot', pageLink(c.step.href, c.step.label)),
  ];
}

function needsBody(c, now, checking, x) {
  return [
    h('div.tia-c-head', h('span.tia-c-icon', icon('bell', { size: 18 })), h('h3.tia-c-title', 'What needs you'), checking ? h('span.tia-c-sub', 'Checking…') : null),
    h('ul.tia-c-needlist', c.items.map((it) => h(`li.tia-c-need${it.gone ? '.gone' : ''}`, { 'data-item': it.id },
      h('div.tia-c-needhead', h('strong', it.subject), it.since && !it.gone ? h('span.tia-c-sub', `${span(now - Date.parse(it.since))} ago`) : null),
      it.gone ? [x.notes.get(it.id) ? h('p.tia-c-note', { role: 'status' }, x.notes.get(it.id)) : null, h('p.tia-c-sub', 'It is no longer on the list.')] : [
        it.facts.length ? h('ul.tia-c-facts', it.facts.map((f) => h('li', f))) : null,
        it.why ? h('p.tia-c-sub', it.why) : null,
        RISK_WORDS[it.act.risk] ? h('p.tia-c-risk', RISK_WORDS[it.act.risk]) : null,
        x.notes.get(it.id) ? h('p.tia-c-note', { role: 'status' }, x.notes.get(it.id)) : null,
        it.act.href && HREF.test(it.act.href)
          ? h('a.btn.small.primary.tia-c-act', { href: it.act.href, 'aria-label': `${it.act.label}: ${it.subject}` }, h('span', it.act.label))
          : h('button.btn.small.primary.tia-c-act', { type: 'button', 'aria-label': `${it.act.label}: ${it.subject}`, onclick: (e) => x.tap(it, e.currentTarget) }, h('span', it.act.label)),
      ]))),
    h('div.tia-c-foot', c.total > c.items.length ? h('span.tia-c-sub', `${c.total} in all.`) : null, pageLink(c.all.href, c.all.label)),
  ];
}

const BODY = { status: statusBody, progress: progressBody, needs: needsBody, list: listBody };
const LABEL = { status: (c) => `Now: ${c.title}`, progress: (c) => `Progress: ${c.title}`, needs: () => 'What needs you', list: (c) => c.title };
// The kinds that follow the page's own poller (fromStore); the others are read again through the views route.
const POLLED = new Set(['status', 'list']);

// The cards on screen that follow something, by id, and where they get it from (tests and the gallery set their own).
const live = new Map();
let source = {
  computers: () => store.all,
  subscribe: (fn) => store.subscribe(fn),
  readAt: () => store.readAt,
  error: () => store.error,
  views: (ids) => api('~/api/assistant/views', { ids }),
  tap: (it) => api('~/api/operator/act', { item: it.id, act: it.act.id, seen: it.rev }),
  now: () => Date.now(),
};
/** Where the following cards read from (the gallery and the tests give fixtures). */
export function setSource(s) {
  source = { ...source, ...s };
}
let unsubscribe = null;
let asking = false;

// What a session asks, in one line, from its exact card (src/askcard.mjs askLine, the same function; a test keeps them
// equal): the status card says this where the session has such a card, else its note.
export const askLine = (c) => {
  if (!c || typeof c !== 'object') return '';
  if (c.kind === 'question' && Array.isArray(c.questions) && c.questions.length && typeof c.questions[0].question === 'string') {
    const more = c.questions.length - 1;
    return `${c.questions[0].question}${more > 0 ? ` (and ${more} more question${more > 1 ? 's' : ''})` : ''}`;
  }
  if (c.kind === 'plan') return 'It shows its plan and asks whether to go ahead.';
  if (c.kind === 'permission' && c.permission && typeof c.permission.tool === 'string' && c.permission.tool) return `Allow ${c.permission.tool}${c.permission.what ? `: ${c.permission.what}` : ''}`;
  if (c.kind === 'notice' && c.notice && typeof c.notice.text === 'string') return c.notice.text;
  return '';
};

// A key is masked and a path of the computer cut to its last part, as the server's card text is (cardkinds.mjs
// shortText). A browser that cannot mask (redact gives null) shows no note rather than one that may hold a key.
const PATH = /(?:\/(?:home|Users|root|private|var\/folders)\/|[A-Za-z]:\\)[^\s"']*/g;
export const noteText = (v) => {
  const masked = redact(v);
  return masked === null ? undefined : masked.replace(PATH, (m) => `…/${m.split(/[\\/]/).filter(Boolean).pop() || ''}`).replace(/\s+/g, ' ').trim().slice(0, 200);
};

/**
 * A session's or a computer's card as the page's poller has it now; null while it has nothing yet. `after`: when the card
 * came to this page (ms); only a list the poller asked for after that can say its session is gone (a session just
 * started is not in a list asked for before it), so until then a missing session is null too.
 */
export function fromStore(c, all, after = null, readAt = null) {
  if (!all || !all.length) return null;
  if (c.kind === 'list') return listFromStore(c, all, after, readAt);
  const m = all.find((x) => (c.subject.computer === 'this' ? !x.machine : x.machine === c.subject.computer));
  if (c.subject.type === 'computer') return { ...c, state: !m ? 'gone' : m.status && m.status !== 'online' ? 'offline' : 'online' };
  if (!m || (m.status && m.status !== 'online')) return { ...c, state: 'unknown', note: 'That computer cannot be reached now, so its state is not known.' };
  // A terminal by its own id, which a rename keeps (never by when it was made: two can be made in one second). A card
  // without that id (made before it existed, or a chat, whose name never changes) follows its name only, with the
  // second it was made in as a check: a new session that took the old name is another one, and a renamed one is not
  // looked for, so the card says that its session has ended rather than follow another.
  const made = c.subject.created;
  const list = m.sessions || [];
  const s = c.subject.term
    ? list.find((x) => x.termId === c.subject.term && x.kind !== 'chat')
    : list.find((x) => x.name === c.subject.id && (!made || x.created == null || x.created === made));
  if (!s) return after !== null && !(readAt >= after) ? null : { ...c, state: 'gone', note: undefined };
  // Renamed: the card names it as it is called now, and its step opens it under that name.
  if (s.name !== c.subject.id && !/^chat:/.test(s.name)) {
    const href = `${c.subject.computer === 'this' ? '#' : `#/m/${encodeURIComponent(c.subject.computer)}`}/s/${encodeURIComponent(s.name)}`;
    c = { ...c, subject: { ...c.subject, id: s.name }, step: { ...c.step, href } };
  }
  const key = sessionKey(s);
  const asked = key === 'asks' ? askLine(s.askCard) || s.note : '';
  const note = key === 'asks' && asked ? noteText(asked) : key === 'limit' ? 'Stopped at a usage limit.' : s.lastMessage ? noteText(s.lastMessage) : undefined;
  // The step says what to do in the state it is in now (as cardmake.mjs sessionStatus does), not the one it was made in.
  const step = { ...c.step, label: key === 'asks' ? 'Answer it' : 'Open the session' };
  return { ...c, state: key, since: s.statusAt || c.since, note, step };
}

const sessionKey = (s) => (s.limit || s.runLimit ? 'limit' : s.kind === 'shell' ? 'shell' : { attention: 'asks', waiting: 'waiting', starting: 'starting', working: 'working', ended: 'ended' }[s.status] || 'unknown');

// A list item's page address names its subject (cardmake.mjs sessionHref and at): a session, a chat or a computer.
const ITEM = /^#(?:\/m\/([a-z0-9][a-z0-9_-]{0,31}))?\/(?:s\/([^/?]+)|chat\/([^/?]+)|computer)$/;
/**
 * A list's items with their states as the poller has them now (`seen`: the minute of that poll); an item whose subject
 * its address does not name keeps no state. A subject missing from a poll asked for before the card came keeps its own.
 */
function listFromStore(c, all, after, readAt) {
  const early = after !== null && !(readAt >= after);
  const items = c.items.map((it) => {
    const p = typeof it.href === 'string' && it.state ? ITEM.exec(it.href) : null;
    if (!p) return { ...it, state: undefined };
    const m = all.find((x) => (p[1] ? x.machine === p[1] : !x.machine));
    if (!p[2] && !p[3]) return { ...it, state: !m ? (early ? it.state : 'gone') : m.status && m.status !== 'online' ? 'offline' : 'online' };
    if (!m || (m.status && m.status !== 'online')) return { ...it, state: 'unknown' };
    let name;
    try {
      name = p[2] ? decodeURIComponent(p[2]) : `chat:${p[3]}`;
    } catch {
      return { ...it, state: undefined };
    }
    const s = (m.sessions || []).find((x) => x.name === name);
    return { ...it, state: s ? sessionKey(s) : early ? it.state : 'gone' };
  });
  return { ...c, items, seen: Math.floor((readAt || source.now()) / 60_000) * 60_000 };
}

async function tick() {
  for (const [id, x] of live) if (!x.el.isConnected) live.delete(id);
  if (!live.size) {
    unsubscribe?.();
    unsubscribe = null;
    return;
  }
  const all = source.computers();
  // The page's own poller could not read the sessions (the dashboard does not answer, a restart): a status card keeps
  // what it shows and says as of when, never as if it were so now.
  const down = !!(source.error && source.error());
  for (const x of live.values()) {
    if (!POLLED.has(x.card.kind)) x.update(x.card, x.checking, x.unreadAt || null);
    else if (down) x.update(x.card, x.checking, x.seenAt || x.card.at);
    else {
      // Nothing known yet: a card from the history keeps "Checking…", a card just made keeps its own state.
      const cur = fromStore(x.card, all, x.born, source.readAt());
      x.update(cur || x.card, !cur && x.checking);
    }
  }
  // Read again: the cards on screen whose subject can still change (a job or run that ended stays as it ended).
  const ids = [...live.values()].filter((x) => !POLLED.has(x.card.kind) && x.visible && !(x.card.kind === 'progress' && ENDED.has(x.card.state) && !x.checking)).map((x) => x.card.id);
  if (!ids.length || asking) return;
  asking = true;
  try {
    const r = await source.views(ids);
    for (const id of ids) {
      const x = live.get(id);
      if (!x) continue;
      const cur = r.cards[id];
      if (!cur) x.lost();
      else if (cur.unread) {
        // Not readable now: a card never read since the reload keeps "Checking…"; another keeps what it shows and says
        // as of when.
        const { unread, ...card } = cur;
        if (x.checking) x.update(x.card, true);
        else x.update(card, false, card.at);
      } else x.update(cur, false);
    }
  } catch {
    // Not read this time: the cards keep what they show, say as of when, and the next tick tries again.
    for (const id of ids) {
      const x = live.get(id);
      if (x && !x.checking) x.update(x.card, false, x.seenAt || x.card.at);
    }
  } finally {
    asking = false;
  }
}

function followCard(c) {
  const el = frame(c.kind, LABEL[c.kind](c));
  // A card drawn again from the history (a reload, another device) says what is so NOW, never the moment it was made:
  // until it is read again it says so instead of showing an old state.
  const old = source.now() - c.at > 15_000;
  const x = { el, card: c, checking: old, notes: new Map(), drawn: '', visible: true, born: source.now() };
  // Only a card on screen is read again: one far up in a long conversation waits until he scrolls to it.
  if (typeof IntersectionObserver === 'function') {
    x.visible = false;
    new IntersectionObserver((seen) => {
      const was = x.visible;
      x.visible = seen.some((e) => e.isIntersecting);
      if (x.visible && !was && x.checking) tick();
    }).observe(el);
  }
  // unreadAt: the subject could not be read now; what the card shows was read then (ms).
  x.update = (card, checking = false, unreadAt = null) => {
    x.card = { ...card, id: c.id };
    x.checking = checking;
    const now = source.now();
    // When what it shows was last read for real; a card that cannot be read now says "as of" that time until it can.
    x.unreadAt = unreadAt;
    if (!checking && !unreadAt) x.seenAt = now;
    const body = BODY[c.kind](x.card, now, checking, x);
    if (unreadAt && !checking) body.push(h('p.tia-c-note.tia-c-unread', { role: 'status' }, `Could not be read now; this is as of ${clock(unreadAt)}.`));
    const key = JSON.stringify([x.card, checking, unreadAt, [...x.notes], Math.floor(now / 60_000)]);
    // Nothing changed since the last tick: the height kept for the change is let go, so a card that got shorter (an item
    // that left the list) leaves no empty frame. It moves once, a tick after its content changed, never while it does.
    if (key === x.drawn) {
      if (el.style.minHeight) el.style.minHeight = '';
      return;
    }
    x.drawn = key;
    // The card keeps its height while its content changes (it may grow), so nothing below it jumps.
    if (el.isConnected && el.offsetHeight) el.style.minHeight = `${el.offsetHeight}px`;
    const active = document.activeElement;
    const had = active && el.contains(active) ? active.closest('[data-item]')?.dataset.item || 'card' : null;
    fill(el, body);
    el.classList.toggle('ended', ENDED.has(x.card.state));
    if (had) (el.querySelector(`[data-item="${had}"] .tia-c-act`) || el.querySelector('a, button'))?.focus({ preventScroll: true });
  };
  x.lost = () => {
    live.delete(c.id);
    x.update({ ...x.card }, false);
    el.classList.add('ended');
    add(el, h('p.tia-c-note', 'This card is too old to follow it now: open the page to see what is so now.'));
  };
  x.tap = async (it, b) => {
    if (RISK_WORDS[it.act.risk] && !(await confirmSheet({ title: `${it.act.label}?`, text: `${RISK_WORDS[it.act.risk]} ${it.subject}.`, ok: it.act.label, danger: it.act.risk === 'stops' }))) return;
    b.disabled = true;
    try {
      const r = await source.tap(it);
      x.notes.set(it.id, `Done: ${r.said || it.act.label}.`);
      toast(r.said || 'Done', { kind: 'ok' });
    } catch (e) {
      // The item changed since this card was drawn: nothing was done, and the card shows the item as it is now.
      const cur = e.data && 'current' in e.data ? e.data.current : undefined;
      x.notes.set(it.id, e.status === 409 ? 'It changed since you saw it, so nothing was done: look again.' : `Not done: ${e.message}.`);
      if (cur === null) x.card = { ...x.card, items: x.card.items.map((i) => (i.id === it.id ? { ...i, gone: true } : i)) };
    }
    x.update(x.card, false);
    tick();
  };
  const first = POLLED.has(c.kind) ? fromStore(c, source.computers(), x.born, source.readAt()) : null;
  x.update(first || c, POLLED.has(c.kind) ? !first && old : old);
  live.set(c.id, x);
  queueMicrotask(() => {
    if (!unsubscribe) unsubscribe = source.subscribe(() => tick());
    else if (old) tick();
  });
  return el;
}

/**
 * The element of a card (src/assistant/cardkinds.mjs), or null for a kind this page does not know. opts: { answer(text)
 * → false when it was not sent (choice), undo(id) (tests) }.
 */
export function cardElement(c, opts = {}) {
  if (!c || typeof c !== 'object') return null;
  switch (c.kind) {
    case 'open': return openCard(c);
    case 'list': return c.items.some((it) => it.state) ? followCard(c) : listCard(c);
    case 'numbers': return numbersCard(c);
    case 'choice': return choiceCard(c, { answer: opts.answer || (async () => false) });
    case 'result': return resultCard(c, opts);
    case 'status': case 'progress': case 'needs': return followCard(c);
    default: return null;
  }
}

/** The fields of a form card (a confirm card with `form`): read-only lines, and the values he may change. */
export function formFields(form) {
  const inputs = [];
  const el = h('div.tia-c-form', form.fields.map((f) => {
    if (f.type === 'readonly') return h('div.tia-c-row', h('span.tia-c-sub', f.label), h('strong', f.value === null ? '—' : String(f.value)));
    const id = `tf-${Math.random().toString(36).slice(2, 9)}`;
    const input = f.type === 'choice'
      ? h('select.field', { id }, f.options.map((o) => h('option', { value: o, selected: o === f.value }, o)))
      : h('input.field', { id, type: f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text', value: f.value === null ? '' : String(f.value), ...(f.type === 'password' ? { autocomplete: 'off' } : {}), ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) });
    inputs.push([f, input]);
    return h('label.tia-c-field', { for: id }, h('span.tia-c-sub', f.label), input);
  }));
  /** What he changed: { name: value } (a number as a number); empty when nothing changed. */
  const values = () => Object.fromEntries(inputs.filter(([f, i]) => i.value !== String(f.value ?? '')).map(([f, i]) => [f.name, f.type === 'number' && i.value.trim() !== '' && Number.isFinite(Number(i.value)) ? Number(i.value) : i.value]));
  return { el, values };
}
