// Operator: what needs the owner now. It has no page of its own any more: the cards that ask him to act are rows in
// the Needs you group of Home (needsYouRows), the Tia side is a fold of Settings -> Tia (operator-tia.js tiaAloneFold),
// the computers box is a part of a computer's Overview (operator-rooms.js), and #/operator opens Home.
// GET /api/operator/attention (src/operator/feature.mjs): the attention list, ranked (what can harm his data or
// computer, stopped work, what waits for him, the machine, information), each item with its facts, the recommended
// act as the one button and the others behind "More"; what is watched and when it was read (or why not); the
// timeline of what was done by a tap. A tap is POST /api/operator/act { item, act, seen }: the server refuses a tap
// made on an item that changed, and then this page shows the item as it is now.
import { ago, api, confirmSheet, fill, h, link, stateOf, toast } from './lib.js';
import { store } from './store.js';
import * as registry from './registry.js';
import { navChanged, registerPage } from './registry.js';
import { findingPart } from './operator-look.js';
import { placeLinks } from './operator-ways.js';

const A = '/api/operator';
const CLASS_WORDS = { harm: 'Can lose work', stopped: 'Stopped', waits: 'Waits for you', machine: 'This computer', info: 'For your information' };
const RISK_WORDS = { stops: 'the work that runs now stops', others: 'others will see it' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- the navigation item: the count of items ----------
let count = 0;
async function pollCount() {
  try {
    const r = await api(`${A}/attention`);
    setCount(rowsOf(r));
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
/** The rows of Home's Needs you that are the Operator's: the cards that ask, without those a session card already shows. */
const rowsOf = (r) => (r.items || []).filter((i) => asksYou(i) && !sameAsCard(i)).length;
/** The number on Home's badge: the cards that ask the owner to act (the rows of Needs you). */
export const homeCount = () => count;
// The menu lane gives the badge of Home a hook; without it (this lane alone) the count only lives here.
if (typeof registry.registerHomeCount === 'function') registry.registerHomeCount(homeCount);
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
  const cls = `a.btn.small${primary ? '.primary' : '.secondary'}${c.risk === 'stops' ? '.danger' : ''}`;
  // Its name says which item it is for: ten "Not now" buttons read the same to a screen reader otherwise.
  const named = { title, 'aria-label': `${label}: ${it.subject}`, 'data-act': a.id };
  if (a.href) return h(cls, { href: link(a.href), ...named, onclick: () => tap(it, a, { quiet: true }) }, h('span', label));
  return h(`button${cls.slice(1)}`, { type: 'button', ...named, onclick: (e) => tap(it, a, { button: e.currentTarget, confirm: confirmFor(a, c) }) }, h('span', label));
}

export const doneWords = (r) => r.said || (r.act === 'dismiss' ? 'Not now: hidden until it changes.' : 'Done.');

/** The word over a card: its class, except a quiet session, which is not known to have stopped. */
export const classWords = (it) => (it.kind === 'stuck' ? 'No progress' : CLASS_WORDS[it.class] || it.class);

/** Settings → Tia opened at the daily limit for paid use (web/showpart.js): the item of a paid move the limit does not allow. */
export const CAP_SWITCH = '#/settings/tia?show=tia-daily-cap';

export function itemCard(it, catalog, tap, { changed = false, his = null, hisWays: ways = null, cap = false, finding = null, done = () => {} } = {}) {
  const main = it.acts.find((a) => a.id === it.recommended) || it.acts[0];
  const others = [...it.acts.filter((a) => a !== main), { id: 'dismiss' }];
  // The risk of a step is said on the card, where a phone and the keyboard see it (a title is only seen on hover).
  const risky = [main, ...others].map((a) => [a, catalog[a.id] || {}]).filter(([, c]) => RISK_WORDS[c.risk]);
  const more = h('details.op-more', h('summary', { 'aria-label': `More steps for ${it.subject}` }, 'More steps'), h('div.op-more-acts', others.map((a) => actButton(it, a, catalog, { primary: false, tap }))));
  return h(`article.op-item.op-${it.class}`, { 'data-item': it.id },
    h('div.op-item-head',
      h('span.op-class', classWords(it)),
      changed ? h('span.op-changed', 'Changed: look again') : null,
      h('h3.op-subject', it.subject),
      it.since ? h('span.op-since', { title: it.since }, when(it.since)) : null),
    h('ul.op-facts', it.facts.map((f) => h('li', f))),
    it.why ? h('p.op-why', it.why) : null,
    his ? h('p.op-his', { role: 'note' }, `Yours: ${his}`) : null,
    // The places his note names, from their codes (errorways.js): a link only opens the place.
    his ? placeLinks(ways, it.subject) : null,
    his && cap ? h('p.op-his-act', h('a.btn.small.secondary', { href: link(CAP_SWITCH) }, 'Set a daily limit for paid use')) : null,
    findingPart(it, finding, done),
    risky.length ? h('p.op-risk', risky.map(([a, c]) => `${a.label || c.label || a.id}: ${RISK_WORDS[c.risk]}.`).join(' ')) : null,
    h('div.op-acts', actButton(it, main, catalog, { primary: true, tap }), more));
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

/** A card asks the owner to act, unless it only informs (a branch that is only here, a session that ended). */
export const asksYou = (it) => it.class !== 'info';

/**
 * A session that asks or is at a limit is already a card of Needs you on Home, with its own buttons: a row for it
 * would say the same twice, so it is left out while that card is there.
 */
export function sameAsCard(it, machines = store.all || []) {
  if (it.kind !== 'asks' && it.kind !== 'limit') return false;
  return machines.some((m) => (m.sessions || []).some((x) => (x.chatId ? it.subject.endsWith(`(${x.chatId.slice(0, 8)})`) : it.subject === `session ${x.name}`) && ['attention', 'limit', 'failed'].includes(stateOf(x).key)));
}

/**
 * One row of Home's Needs you: what it is, the one fact that matters, the recommended step as the one button, and the
 * other steps behind "More steps" (closed). The risk of a step is asked by the sheet when it is pressed.
 */
export function itemRow(it, catalog, tap, { changed = false, finding = null, done = () => {}, opened = new Set() } = {}) {
  const main = it.acts.find((a) => a.id === it.recommended) || it.acts[0];
  const others = [...it.acts.filter((a) => a !== main), { id: 'dismiss' }];
  const more = h('details.op-more', h('summary', { 'aria-label': `More steps for ${it.subject}` }, 'More'), h('div.op-more-acts', others.map((a) => actButton(it, a, catalog, { primary: false, tap }))));
  more.open = opened.has(it.id);
  more.addEventListener('toggle', () => opened[more.open ? 'add' : 'delete'](it.id)); // kept while the rows are drawn again
  return h(`article.op-row.op-${it.class}`, { 'data-item': it.id },
    h('div.op-row-text',
      h('h3.op-subject', it.subject),
      h('p.op-row-fact', changed ? 'Changed: look again' : it.facts[0] || classWords(it))),
    findingPart(it, finding, done),
    h('div.op-acts', actButton(it, main, catalog, { primary: true, tap }), more));
}

/**
 * Home's Needs you rows: draws the cards that ask the owner to act into `box` and keeps them up to date. Nothing is
 * drawn (the box stays empty) while none asks. Returns the function that stops it.
 */
export function needsYouRows(box, onCount = () => {}) {
  let alive = true;
  let drawn = null;
  let changedId = null; // the item a tap was refused on because it changed
  const opened = new Set(); // the rows whose More is open
  async function tap(it, a, { quiet = false, button = null, confirm = null } = {}) {
    if (confirm && !(await confirmSheet(confirm))) return;
    changedId = null;
    if (button) button.disabled = true;
    try {
      const r = await api(`${A}/act`, { item: it.id, act: a.id, seen: it.rev });
      if (!quiet) toast(doneWords(r), { kind: 'ok' });
    } catch (e) {
      if (e.status === 409 && e.data?.current?.id) changedId = e.data.current.id;
      if (!quiet) toast(e.message, { kind: 'error', ms: 6000 });
    } finally {
      if (button) button.disabled = false;
    }
    if (alive) load();
  }
  async function load() {
    let r;
    try {
      r = await api(`${A}/attention`);
    } catch {
      return; // older computer, offline or logged out: what is drawn stays
    }
    if (!alive) return;
    const items = r.items.filter((i) => asksYou(i) && !sameAsCard(i));
    setCount(items.length);
    const key = `${JSON.stringify(items.map((i) => [i.id, i.rev, i.since, i.facts]))}|${changedId || ''}|${JSON.stringify(r.findings || {})}`;
    if (key === drawn) return;
    drawn = key;
    // Only the cards: the heading and the count are Home's group, which holds this box above its sessions.
    fill(box, items.length ? h('div.cards.op-rows', items.map((it) => itemRow(it, r.acts, tap, { changed: it.id === changedId, finding: r.findings?.[it.id] || null, done: () => alive && load(), opened }))) : null);
    onCount(items.length);
  }
  load();
  const every = setInterval(() => alive && !document.hidden && load(), 15_000);
  return () => {
    alive = false;
    clearInterval(every);
  };
}

/** The old page: its address opens Home, scrolled to Needs you (the timer outlives this page: the router leaves it at once). */
function viewOperator() {
  location.replace('#/');
  let tries = 0;
  const look = setInterval(() => {
    const at = document.querySelector('.g-needs');
    if (at || ++tries > 20) {
      clearInterval(look);
      at?.scrollIntoView({ block: 'start' });
    }
  }, 150);
}

registerPage({ id: 'operator', title: 'Operator', icon: 'eye', render: viewOperator });
