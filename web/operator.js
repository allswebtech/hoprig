// Operator (#/operator): one place that says what needs the owner now, so he does not have to look at every page in
// turn. GET /api/operator/attention (src/operator/feature.mjs): the attention list, ranked (what can harm his data or
// computer, stopped work, what waits for him, the machine, information), each item with its facts, the recommended
// act as the one button and the others behind "More"; what is watched and when it was read (or why not); the
// timeline of what was done by a tap. A tap is POST /api/operator/act { item, act, seen }: the server refuses a tap
// made on an item that changed, and then this page shows the item as it is now.
import { icon } from './icons.js';
import { add, ago, api, confirmSheet, fill, h, link, toast } from './lib.js';
import { navChanged, registerPage } from './registry.js';
import { emptyState, errorBox, skeletonRows } from './shell.js';
import { byTiaList, drawTia, focusKey, hisCap, hisWays, hisWords } from './operator-tia.js';
import { placeLinks } from './operator-ways.js';
import { roomsPart } from './operator-rooms.js';
import { findingPart } from './operator-look.js';

const A = '/api/operator';
const CLASS_WORDS = { harm: 'Can lose work', stopped: 'Stopped', waits: 'Waits for you', machine: 'This computer', info: 'For your information' };
const RISK_WORDS = { stops: 'the work that runs now stops', others: 'others will see it' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- the navigation item: the count of items ----------
let count = 0;
async function pollCount() {
  try {
    const r = await api(`${A}/attention`);
    setCount(r.needs ?? r.count);
  } catch {
    /* logged out, offline or an older computer: keep the last */
  }
}
function setCount(n) {
  if (n !== count) {
    count = n;
    navChanged();
  }
}
if (typeof window !== 'undefined' && typeof location !== 'undefined' && !location.pathname.startsWith('/login')) {
  pollCount();
  setInterval(pollCount, 30_000);
}

const when = (iso) => (iso ? ago(Date.parse(iso)) : '');

/**
 * What an act with a risk asks before it is done (it stops work that runs, or others see it), as the session page and
 * the task manager ask; null for an act that asks nothing.
 */
export function confirmFor(a, c = {}) {
  if (!RISK_WORDS[c.risk]) return null;
  const label = a.label || c.label || a.id;
  return { title: `${label}?`, text: [c.effect, `${cap(RISK_WORDS[c.risk])}.`, c.undo ? `Undo: ${c.undo}` : 'It cannot be undone from here.'].filter(Boolean).join(' '), ok: label, danger: c.risk === 'stops' };
}

function actButton(it, a, catalog, { primary, tap }) {
  const c = catalog[a.id] || {};
  const label = a.label || c.label || a.id;
  const title = [c.effect, RISK_WORDS[c.risk] ? `${cap(RISK_WORDS[c.risk])}.` : null, c.undo ? `Undo: ${c.undo}` : null].filter(Boolean).join(' ');
  // A step that stops work is red only under More steps: as the one visible step it would be the first thing to press.
  const cls = `a.btn.small${primary && c.risk !== 'stops' ? '.primary' : '.secondary'}${c.risk === 'stops' && !primary ? '.danger' : ''}`;
  // Its name says which item it is for: ten "Not now" buttons read the same to a screen reader otherwise.
  const named = { title, 'aria-label': `${label}: ${it.subject}`, 'data-act': a.id };
  if (a.href) return h(cls, { href: link(a.href), ...named, onclick: () => tap(it, a, { quiet: true }) }, h('span', label));
  return h(`button${cls.slice(1)}`, { type: 'button', ...named, onclick: (e) => tap(it, a, { button: e.currentTarget, confirm: confirmFor(a, c) }) }, h('span', label));
}

/** What the toast says after a tap: the timeline's words (subject: result). */
/** The page's first sentence: true with every switch as it may be. */
export const INTRO = 'What stopped or is about to, and its step. Tia acts alone only by a rule, "Tia decides" or a look you turned on.';

/** An act whose result the Computers part shows (its hold line and Undo): that part is read again right after it. */
export const redrawsRooms = (actId) => actId === 'elsewhere';

export const doneWords = (r) => r.said || (r.act === 'dismiss' ? 'Not now: hidden until it changes.' : 'Done.');

/** The word over a card: its class, except a quiet session, which is not known to have stopped. */
export const classWords = (it) => (it.kind === 'stuck' ? 'No progress' : CLASS_WORDS[it.class] || it.class);

/** Facts that start with a number a person did not ask for (a process, a port, a load): they follow the plain ones, quieter. */
export const isTechnical = (f) => /^(process \d|port \d|load \d)|\bport \d+|\(HTTP \d+\)/.test(f);

/** What heads a card: plain words first; the name or number that only a program knows follows in a quieter line. */
export function subjectWords(it) {
  const s = it.subject;
  if (it.kind === 'machine' && s === 'load') return { title: 'This computer is busy', tech: null };
  if (it.kind === 'machine' && s === 'memory') return { title: 'This computer is low on memory', tech: null };
  const dash = /^dashboard on port (\d+)$/.exec(s);
  if (dash) return { title: 'A left-over dashboard', tech: `Port ${dash[1]}` };
  const tmux = /^tmux server (.+)$/.exec(s);
  if (tmux) return { title: 'A left-over terminal server', tech: `tmux server ${tmux[1]}` };
  // A chat: its title, and its id on the muted line below, as the run id is.
  const chat = /^(chat ".*") \(([^()\s]+)\)$/s.exec(s);
  if (chat) return { title: chat[1], tech: chat[2] };
  const run = /^Work run (\S+)$/.exec(s);
  if (run) return { title: 'Work run', tech: run[1] };
  return { title: s, tech: null };
}

/** The visible first step: never the one that stops work (it waits under More steps, in red, with its question). */
export function mainAct(it, catalog) {
  const rec = it.acts.find((a) => a.id === it.recommended) || it.acts[0];
  if (catalog[rec.id]?.risk !== 'stops') return rec;
  return it.acts.find((a) => a !== rec && catalog[a.id]?.risk !== 'stops') || rec;
}

/** The short line under a part's title: what is in it. */
export const PART_HINTS = {
  needs: 'The first ones matter most. Tap the blue button to do the step we recommend.',
  done: 'What you did with a tap on this page.',
  doneTia: 'What Tia did by herself, with Undo where it can be undone.',
  watched: 'What Hoprig reads to make this list, and when it last read it.',
};

/** Settings → Tia opened at the daily limit for paid use (web/showpart.js): the item of a paid move the limit does not allow. */
export const CAP_SWITCH = '#/settings/tia?show=tia-daily-cap';

const riskLine = (list) => (list.length ? h('p.op-risk', list.map(([a, c]) => `${a.label || c.label || a.id}: ${RISK_WORDS[c.risk]}.`).join(' ')) : null);

export function itemCard(it, catalog, tap, { changed = false, his = null, hisWays: ways = null, cap = false, finding = null, done = () => {} } = {}) {
  const main = mainAct(it, catalog);
  const others = [...it.acts.filter((a) => a !== main), { id: 'dismiss' }];
  // The risk of a step is said on the card, where a phone and the keyboard see it (a title is only seen on hover).
  const risky = [main, ...others].map((a) => [a, catalog[a.id] || {}]).filter(([, c]) => RISK_WORDS[c.risk]);
  const subject = subjectWords(it);
  const more = h('details.op-more', h('summary', { 'aria-label': `More steps for ${it.subject}` }, 'More steps'), h('div.op-more-acts', others.map((a) => actButton(it, a, catalog, { primary: false, tap }))));
  return h(`article.op-item.op-${it.class}`, { 'data-item': it.id },
    h('div.op-item-head',
      h('span.op-class', classWords(it)),
      changed ? h('span.op-changed', 'Changed: look again') : null,
      h('h3.op-subject', subject.title),
      it.since ? h('span.op-since', { title: it.since }, when(it.since)) : null,
      subject.tech ? h('span.op-tech.op-sub', subject.tech) : null),
    h('ul.op-facts', [...it.facts.filter((f) => !isTechnical(f)).map((f) => h('li', f)), ...it.facts.filter(isTechnical).map((f) => h('li.op-tech', f))]),
    it.why ? h('p.op-why', it.why) : null,
    his ? h('p.op-his', { role: 'note' }, `Yours: ${his}`) : null,
    // The places his note names, from their codes (errorways.js): a link only opens the place.
    his ? placeLinks(ways, it.subject) : null,
    his && cap ? h('p.op-his-act', h('a.btn.small.secondary', { href: link(CAP_SWITCH) }, 'Set a daily limit for paid use')) : null,
    findingPart(it, finding, done),
    // The line of the visible step stands above its button; the line of a step under More steps, under the button row.
    riskLine(risky.filter(([a]) => a === main)),
    h('div.op-acts', actButton(it, main, catalog, { primary: true, tap }), more),
    riskLine(risky.filter(([a]) => a !== main)));
}

/**
 * What the page says when the list is empty: "nothing needs you" only when every source was read; else what could not
 * be read, with the alert icon (a source that cannot be read is never shown as fine).
 */
export function emptyWords(r) {
  const unread = (r.watched || []).filter((w) => !w.ok && w.at);
  const off = r.hidden ? ` ${r.hidden} put off until ${r.hidden > 1 ? 'they change' : 'it changes'}.` : '';
  if (!unread.length) return { icon: 'check', text: `Nothing needs you now.${off}` };
  const names = unread.map((w) => w.label || w.source).join(', ');
  return { icon: 'alert', text: `Nothing needs you in what could be read. ${unread.length} ${unread.length > 1 ? 'sources' : 'source'} could not be read: ${names}.${off}` };
}

/** What the drawn list shows: the same key means nothing to draw again (a redraw loses focus and an open More). */
export const listKey = (r) => JSON.stringify([r.items.map((i) => [i.id, i.rev, i.since, i.facts]), r.more || 0, r.hidden || 0, emptyWords(r).text]);

/** Draws `nodes` into `list`, keeping which More menus were open and which step had the focus. */
function redraw(list, nodes) {
  const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.closest('[data-item]')?.dataset.item));
  const f = document.activeElement;
  const focused = f && list.contains(f) ? { item: f.closest('[data-item]')?.dataset.item, act: f.dataset?.act || (f.tagName === 'SUMMARY' ? 'more' : null) } : null;
  fill(list, nodes);
  for (const d of list.querySelectorAll('details')) if (open.has(d.closest('[data-item]')?.dataset.item)) d.open = true;
  if (!focused?.item) return;
  const card = [...list.querySelectorAll('[data-item]')].find((c) => c.dataset.item === focused.item);
  (focused.act === 'more' ? card?.querySelector('summary') : card?.querySelector(`[data-act="${focused.act}"]`))?.focus();
}

function watchedList(watched) {
  return h('ul.op-watched', watched.map((w) => h(`li${w.ok ? '' : '.op-unread'}`,
    icon(w.ok ? 'check' : 'alert', { size: 16 }),
    h('span.op-w-label', w.label),
    h('span.op-w-text', w.ok ? w.summary : w.error),
    w.ok && w.at ? h('span.op-w-at', when(w.at)) : null)));
}

function timelineList(lines) {
  if (!lines.length) return h('p.hint', 'You have done nothing from here yet.');
  return h('ul.op-timeline', lines.map((l) => h(`li${l.ok ? '' : '.op-failed'}`,
    h('span.op-t-at', { title: l.at }, when(l.at)),
    h('span.op-t-what', `${l.subject}: ${l.result}`))));
}

function viewOperator({ frame }) {
  const list = h('div.op-list', skeletonRows(3));
  const watched = h('div.op-side-body', skeletonRows(4));
  const timeline = h('div.op-side-body');
  const tia = h('div.op-tia-box');
  const byTia = h('div.op-side-body');
  const roomsBox = h('section.op-rooms-box', { 'aria-label': 'Computers' });
  const rooms = roomsPart(roomsBox, { onread: () => alive && load() });
  frame({
    title: 'Operator',
    page: 'operator',
    intro: INTRO,
    wide: true,
    body: [h('div.op-grid',
      h('section.op-main', { 'aria-label': 'Needs you' }, h('h2.op-h', 'Needs you'), h('p.hint.op-part-hint', PART_HINTS.needs), list),
      h('aside.op-side',
        roomsBox,
        h('section', { 'aria-label': 'Done by Tia' }, h('h2.op-h', 'Done by Tia'), h('p.hint.op-part-hint', PART_HINTS.doneTia), byTia),
        h('section', { 'aria-label': 'Done by you' }, h('h2.op-h', 'Done by you'), h('p.hint.op-part-hint', PART_HINTS.done), timeline),
        h('section', { 'aria-label': 'Watched' }, h('h2.op-h', 'Watched'), h('p.hint.op-part-hint', PART_HINTS.watched), watched)),
      // What Tia does by herself is settings: it comes last on a phone and under both columns on a wide screen.
      h('div.op-tia-row', tia))],
  });
  let alive = true;
  let look = true;
  let drawn = null; // the key of the list as drawn
  let after = null; // after a tap: the item to put the focus on once the list is drawn again
  let changedId = null; // the item a tap was refused on because it changed: marked until the next tap
  let tiaKey = null; // what the Tia panel shows as drawn
  let tiaAfter = null; // after the owner's own change in the panel or in Done by Tia: the control to put the focus on
  const changed = (focus) => {
    tiaAfter = { focus: focus || null };
    if (alive) load();
  };

  // After a tap the focus goes to the same item when it is still there, else to the next one, else to the timeline.
  function focusAfter({ id, next }) {
    const cards = [...list.querySelectorAll('[data-item]')];
    const card = cards.find((c) => c.dataset.item === id) || cards.find((c) => c.dataset.item === next) || null;
    const target = card?.querySelector('.op-acts > .btn') || timeline.querySelector('li, p');
    if (!target) return;
    if (!target.matches('button, a, summary')) target.tabIndex = -1;
    target.focus();
  }

  async function tap(it, a, { quiet = false, button = null, confirm = null } = {}) {
    if (confirm && !(await confirmSheet(confirm))) return;
    const cards = [...list.querySelectorAll('[data-item]')].map((c) => c.dataset.item);
    changedId = null;
    if (!quiet) after = { id: it.id, next: cards[cards.indexOf(it.id) + 1] || null };
    if (button) button.disabled = true;
    try {
      const r = await api(`${A}/act`, { item: it.id, act: a.id, seen: it.rev });
      if (!quiet) toast(doneWords(r), { kind: 'ok' });
    } catch (e) {
      // A tap on an item that changed: the card is marked, and shown, once the list is drawn again.
      if (e.status === 409 && e.data?.current?.id) changedId = e.data.current.id;
      if (!quiet) toast(e.message, { kind: 'error', ms: 6000 });
    } finally {
      // The list is drawn again only when it changed: a button left disabled would stay so, and hold no focus.
      if (button) button.disabled = false;
    }
    if (alive) load();
    // "Start new work on <name>": the hold line and its Undo under Computers at once, not at the next 15 s redraw.
    if (alive && redrawsRooms(a.id)) rooms.load();
  }

  async function load() {
    let r;
    try {
      r = await api(`${A}/attention${look ? '?look=1' : ''}`);
      look = false;
    } catch (e) {
      if (!alive) return;
      return fill(list, e.status === 404 ? h('p.hint', 'This computer runs an older version without the Operator page.') : errorBox(e.message, load));
    }
    if (!alive) return;
    setCount(r.needs ?? r.count);
    const key = `${listKey(r)}|${changedId || ''}|${JSON.stringify(r.reflexes?.his || {})}|${JSON.stringify(r.findings || {})}`;
    if (key !== drawn) {
      drawn = key;
      redraw(list, [r.items.length
        ? [...r.items.map((it) => itemCard(it, r.acts, tap, { changed: it.id === changedId, his: hisWords(it, r.reflexes), hisWays: hisWays(it, r.reflexes), cap: hisCap(it, r.reflexes), finding: r.findings?.[it.id] || null, done: () => alive && load() })), r.more ? h('p.hint', `${r.more} more below these; the first ones matter most.`) : null]
        : (({ icon: ic, text }) => emptyState(ic, text))(emptyWords(r)),
      r.hidden && r.items.length ? h('p.hint', `${r.hidden} put off until ${r.hidden > 1 ? 'they change' : 'it changes'}.`) : null]);
    }
    if (after) focusAfter(after);
    after = null;
    if (changedId) [...list.querySelectorAll('[data-item]')].find((c) => c.dataset.item === changedId)?.scrollIntoView({ block: 'nearest' });
    fill(watched, watchedList(r.watched));
    fill(timeline, timelineList(r.timeline));
    // The Tia panel: drawn again when what it says changed, and always after his own change there (drawTia).
    if (r.reflexes) {
      const own = tiaAfter;
      tiaAfter = null;
      tiaKey = drawTia(tia, r.reflexes, changed, { drawn: tiaKey, force: !!own, focus: own?.focus?.startsWith('undo-') ? null : own?.focus });
      const keep = own?.focus?.startsWith('undo-') ? own.focus : byTia.contains(document.activeElement) ? document.activeElement.dataset?.focus : null;
      fill(byTia, byTiaList(r.byTia || [], r.reflexes, changed));
      // After an Undo the focus stays on its line, or goes to the heading when the line is gone.
      if (keep && !focusKey(byTia, keep) && own) {
        const head = byTia.parentElement?.querySelector('h2');
        if (head) {
          head.tabIndex = -1;
          head.focus();
        }
      }
    }
  }
  load();
  // Opened: every computer is read now, then the list again (its overload item may offer one with room). The 15 s
  // redraw shows what is kept.
  rooms.load(true).then(() => alive && load());
  const every = setInterval(() => alive && !document.hidden && (load(), rooms.load()), 15_000);
  return () => {
    alive = false;
    clearInterval(every);
  };
}

registerPage({ id: 'operator', title: 'Operator', icon: 'eye', group: 'more', order: 5, perComputer: true, render: viewOperator, badge: () => count });
