// The frame every page is drawn in, and the shared parts of a page (style.css names the same components):
//   sidebar      desktop (>= 900 px): logo and name, the main pages, a divider, the second group
//   bottombar    phone: Home · Projects · Accounts · Computers · More (More lists the second group)
//   pagehead     the page's title, one sentence saying what it is for, at most one primary action
//   switcher     which computer, on a page that belongs to one computer, only when there are several
//   panel        a card with an icon, a title and one sentence
//   fold         "Advanced": closed until opened, remembered per viewer
//   radiocards   a question answered by picking one of a few cards
//   groupHead    a heading with a count over a group of rows
//   tabBar       the parts of a page, each with its own address; scrolls sideways on a phone
//   errorBox, okBox, steps, stepHeader, skeletonRows   a result, numbered steps, a step header, rows while loading
import { APP_NAME } from './brand.js';
import { icon } from './icons.js';
import { BARE, MACHINE_STATE, applyPageTheme, fill, h, link, machine, prefs } from './lib.js';
import { navPages, pageById, registeredHeadTools } from './registry.js';
import { store } from './store.js';
import { cameFrom, named, startOver, wayBack } from './trail.js';

const app = typeof document !== 'undefined' ? document.getElementById('app') : null;

/** Home is the router's own page; every other navigation item is a registered page (registry.js). */
const HOME = { id: 'home', title: 'Home', icon: 'home', perComputer: false, count: 0 };

/** The navigation item a page lights up: itself, or the item it belongs to (navAs). */
const currentItem = (pageId) => (pageById(pageId) || {}).navAs || pageId;

const hrefOf = (p) => (p.id === 'home' ? '#/' : p.perComputer ? link(`#/${p.id}`) : `#/${p.id}`);

function navItem(p, current, cls) {
  return h(`a.${cls}`, { href: hrefOf(p), 'aria-current': current === p.id ? 'page' : null, onclick: startOver },
    icon(p.icon, { size: cls === 'side-item' ? 18 : 22 }),
    h('span', p.title),
    p.count ? h('span.nav-badge', { 'aria-label': `${p.count} waiting for you` }, String(p.count)) : null);
}

function paintNav(side, bottom, pageId) {
  const current = currentItem(pageId);
  const main = [HOME, ...navPages('main')];
  const more = navPages('more');
  fill(side,
    h('a.side-brand', { href: '#/', onclick: startOver }, h('img.side-mark', { src: 'icon.svg', alt: '', width: 36, height: 36 }), h('span.side-name', APP_NAME)),
    h('div.side-group', main.map((p) => navItem(p, current, 'side-item'))),
    h('div.side-group', h('div.side-group-title', 'More'), more.map((p) => navItem(p, current, 'side-item'))));
  const inMore = current === 'more' || more.some((p) => p.id === current);
  const waiting = more.reduce((n, p) => n + p.count, 0);
  fill(bottom,
    main.map((p) => navItem(p, current, 'tab')),
    h('a.tab', { href: '#/more', 'aria-current': inMore ? 'page' : null, onclick: startOver }, icon('grid', { size: 22 }), h('span', 'More'),
      waiting ? h('span.nav-badge', { 'aria-label': `${waiting} waiting for you` }, String(waiting)) : null));
}

/** The label of the open computer for titles ("Providers · pc2"), or null on this computer. */
export const openLabel = () => {
  const d = store.data;
  return machine.current ? (d && d.machineLabel) || machine.current : null;
};

/**
 * Which computer a page shows: a pill in the page head naming it, and under it the list of computers. `target` is
 * the page ("#/providers"). Nothing while there is one computer.
 */
export function computerSwitcher(target) {
  if (!store.multi) return null;
  const cur = store.all.find((m) => m.machine === machine.current) || store.all[0];
  const pop = h('div.switch-pop.hidden', { role: 'menu', 'aria-label': 'Computers' },
    store.all.map((m) => h('a.switch-item', {
      href: link(target, m.machine), role: 'menuitem', 'aria-current': m.machine === machine.current ? 'true' : null,
    }, icon('cpu', { size: 16 }),
    h('span.switch-text', h('span.switch-name', m.machineLabel), h('span.switch-sub', m.status === 'online' ? `${m.sessions.length} session${m.sessions.length === 1 ? '' : 's'}` : MACHINE_STATE[m.status] || m.status)),
    m.machine === machine.current ? icon('check', { size: 16 }) : null)));
  const btn = h('button.switch-pill', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: `Computer: ${cur.machineLabel}`, onclick: (e) => {
    e.stopPropagation();
    const open = pop.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => document.addEventListener('click', () => {
      pop.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }, { once: true }), 0);
  } }, icon('cpu', { size: 15 }), h('span.switch-label', cur.machineLabel), icon('chevronDown', { size: 14 }));
  return h('div.switch-menu', btn, pop);
}

/** The light/dark button of the page head (the same choice as Settings → Appearance, kept on this device). */
function themeButton() {
  const dark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const b = h('button.icon-btn', { type: 'button' });
  const paint = () => {
    const d = dark();
    b.title = d ? 'Light colours' : 'Dark colours';
    b.setAttribute('aria-label', b.title);
    fill(b, icon(d ? 'sun' : 'moon', { size: 16 }));
  };
  b.addEventListener('click', () => {
    prefs.set('page.theme', dark() ? 'light' : 'dark');
    applyPageTheme();
    paint();
  });
  paint();
  return b;
}

/** "Connection lost — reconnecting…" while the last poll failed. */
export function connectionBanner(err) {
  return err && err.status !== 401 ? h('div.banner.warn', { role: 'status' }, icon('refresh', { size: 18 }), h('span', 'Connection lost — reconnecting…')) : null;
}

let stopFrame = () => {};
// The navigation is made once and kept: moving between pages changes the page, not the sidebar or the bottom bar.
const side = typeof document !== 'undefined' ? h('nav.sidebar', { 'aria-label': 'Pages' }) : null;
const bottom = typeof document !== 'undefined' ? h('nav.bottombar', { 'aria-label': 'Pages' }) : null;
/** The router calls this before drawing the next page: the frame's own listeners end with the page. */
export function endFrame() {
  stopFrame();
  stopFrame = () => {};
}

/**
 * Draw a page. `page`: the registered page id ('home' for Home) whose navigation item lights up. `back`: a hash for the
 * way back (sub-pages; `backOnPhoneOnly` when a desktop shows the way back on the page itself). `primary`: { label,
 * icon, href | onclick } — the page's one main action: a button in the page head on a desktop, the floating button
 * on a phone. `wide`: room for two columns (Settings). `fillWindow`: the page fills the window and its last part
 * stays at the bottom (Tia's chat). The page head holds, on the right, the page's tools, its main action, the
 * computer pill (a page of one computer, with several) and the light/dark button.
 */
export function frame({ title, place = null, intro = null, page = null, back: parent = null, backLabel: parentLabel = 'Back', backOnPhoneOnly: parentOnPhoneOnly = false, introOnPhone = true, actions = [], primary = null, body, extra = [], wide = false, fillWindow = false }) {
  endFrame();
  // The way back is the page that sent you here (trail.js); without one, the page's own parent. `place` is what a
  // link back to this page says, when the title alone would not ("Setup" for a computer's Setup part).
  named(place || (typeof title === 'string' ? title : Array.isArray(title) && typeof title[0] === 'string' ? title[0] : ''));
  const way = page === 'home' && !parent ? null : wayBack(parent); // Home is where every trail starts
  const back = way ? way.hash : parent;
  const backLabel = way ? way.label : parentLabel;
  const backOnPhoneOnly = way ? false : parentOnPhoneOnly;
  // A page whose parent is a list beside it on a desktop (Settings): there the way back stays the page you came from.
  const from = !way && parentOnPhoneOnly ? cameFrom() : null;
  const backLink = (href, label, cls) => h(`a.pagehead-back${cls}`, { href, 'aria-label': `Back to ${label}` }, icon('back', { size: 16 }), h('span.pagehead-back-label', label));
  const reg = page ? pageById(page) : null;
  const switcher = h('div.switcher-slot');
  // Drawn again only when the computers or their names change, so an open list is not closed by the next poll.
  let switcherKey = null;
  const paintSwitcher = () => {
    const key = reg && reg.perComputer && store.multi ? JSON.stringify([machine.current, store.all.map((m) => [m.machine, m.machineLabel, m.status, m.sessions.length])]) : '';
    if (key === switcherKey) return;
    switcherKey = key;
    fill(switcher, key ? computerSwitcher(`#/${page}`) : null);
  };
  const paint = () => paintNav(side, bottom, page);
  paint();
  paintSwitcher();
  // The list of computers may arrive after the first paint.
  const unsubscribe = store.subscribe(paintSwitcher);
  window.addEventListener('nav-changed', paint);
  stopFrame = () => {
    unsubscribe();
    window.removeEventListener('nav-changed', paint);
  };
  const go = primary
    ? (cls) => (primary.href
      ? h(`a.btn.primary.${cls}`, { href: primary.href }, icon(primary.icon || 'plus', { size: 16 }), h('span', primary.label))
      : h(`button.btn.primary.${cls}`, { type: 'button', onclick: primary.onclick }, icon(primary.icon || 'plus', { size: 16 }), h('span', primary.label)))
    : () => null;
  // In a window of the desktop (lib.js BARE): no navigation, no floating button and no head icons (the desktop has
  // the theme, Tia and the computer); the window belongs to one computer, so no switcher either.
  if (BARE) {
    const bareHead = h('header.pagehead',
      h('div.pagehead-text',
        back ? backLink(back, backLabel, '') : null,
        h('div.pagehead-title-row', h('h1.page-title', title)),
        intro ? h(`p.page-intro${introOnPhone ? '' : '.desktop-only'}`, intro) : null),
      h('div.head-tools', actions.length ? h('div.pagehead-actions', actions) : null, go('pagehead-primary')));
    fill(app, h('div.shell-main', h(`main.page${wide ? '.wide' : ''}${fillWindow ? '.fill' : ''}`, bareHead, body)), extra);
    document.body.classList.add('bare');
    document.body.classList.remove('has-nav', 'has-fab');
    return;
  }
  const head = h('header.pagehead',
    h('div.pagehead-text',
      back ? backLink(back, backLabel, backOnPhoneOnly ? '.phone-only' : '') : null,
      from ? backLink(from.hash, from.label, '.desktop-only') : null,
      h('div.pagehead-title-row',
        back ? null : h('img.pagehead-mark', { src: 'icon.svg', alt: '', width: 26, height: 26 }),
        h('h1.page-title', title)),
      intro ? h(`p.page-intro${introOnPhone ? '' : '.desktop-only'}`, intro) : null),
    h('div.head-tools', actions.length ? h('div.pagehead-actions', actions) : null, go('pagehead-primary'), switcher,
      h('div.head-icons', registeredHeadTools().map((make) => {
        try {
          return make();
        } catch {
          return null;
        }
      }), themeButton())));
  const fab = primary ? go('fab') : null;
  fill(app, side, h('div.shell-main', h(`main.page${wide ? '.wide' : ''}${fillWindow ? '.fill' : ''}`, head, body)), extra, fab, bottom);
  document.body.classList.add('has-nav');
  // A phone: the floating button covers the right of the screen while the page scrolls under it. Its width goes to
  // the page (style.css, --fab-w), so the buttons on a card end before it and none of them can be under it.
  document.body.classList.toggle('has-fab', !!fab);
  if (fab) requestAnimationFrame(() => fab.offsetWidth && document.body.style.setProperty('--fab-w', `${fab.offsetWidth}px`));
}

/** A card with an icon, a title and one sentence; `tag` is a small word next to the title. */
export function panel({ id = null, icon: ic = null, title, desc = null, tag = null }, ...body) {
  return h('section.card.panel', { id },
    title ? h('div.panel-head', ic ? h('span.panel-icon', icon(ic)) : null,
      h('div', h('h2.panel-title', title, tag ? h('span.badge.soft.tag', tag) : null), desc ? h('p.panel-desc', desc) : null)) : null,
    ...body);
}

/** "Advanced" (or `label`): closed until opened; open or closed is remembered per viewer under `key`. */
export function fold(key, label, ...children) {
  const d = h('details.fold', { open: prefs.get(`fold.${key}`, false) },
    h('summary.fold-summary', h('span', label), icon('chevronDown', { size: 18 })),
    h('div.fold-body', children));
  d.addEventListener('toggle', () => prefs.set(`fold.${key}`, d.open));
  return d;
}

/** A question answered by one of a few cards: options [{ value, title, sub }]. */
export function radioCards(name, options, value, onchange) {
  return h('div.radiocards', { role: 'radiogroup' }, options.map((o) =>
    h(`label.radiocard${o.value === value ? '.on' : ''}`,
      h('input', { type: 'radio', name, value: o.value, checked: o.value === value, onchange: () => onchange(o.value) }),
      h('span.radiocard-text', h('span.radiocard-title', o.title), o.sub ? h('span.radiocard-sub', o.sub) : null))));
}

/** A heading over a group of rows, with its count. */
export const groupHead = (text, count) => h('h2.group-head', h('span', text), count === undefined ? null : h('span.group-count', String(count)));

/** One row of a list that leads somewhere: { href | onclick, icon, title, sub, end }. */
export function listRow({ href = null, onclick = null, icon: ic = null, title, sub = null, end = null }) {
  const inner = [
    ic ? h('span.row-icon', icon(ic)) : null,
    h('span.row-main', h('span.row-title', title), sub ? h('span.row-sub', sub) : null),
    end,
    h('span.row-end', icon('chevronRight', { size: 18 })),
  ];
  return href ? h('a.row', { href }, inner) : h('button.row', { type: 'button', onclick }, inner);
}

/** An empty state that teaches: one sentence and one button. */
export const emptyState = (ic, text, action = null) => h('div.empty.compact', icon(ic, { size: 28 }), h('p', text), action);

// ---------- form pieces shared by the settings of every page ----------

/**
 * "Saved" for a moment next to a control whose change is kept at once (a switch, a choice, an order). `where` is the
 * element it shows in; the mark stays the same size while hidden, so nothing moves.
 */
export function savedMark() {
  const el = h('span.saved-mark', { role: 'status', 'aria-live': 'polite' });
  let t = null;
  el.show = (text = 'Saved') => {
    clearTimeout(t);
    el.textContent = text;
    el.classList.add('on');
    t = setTimeout(() => el.classList.remove('on'), 2200);
    window.dispatchEvent(new Event('saved')); // e.g. the Settings list redraws its one-line summaries
  };
  return el;
}

/**
 * A switch with its label and one sentence. `onchange(value)` may return a Promise: "Saved" shows next to the switch
 * once it settles without an error. A switch kept only in this browser shows it at once.
 */
export function toggle(label, checked, onchange, hint) {
  const mark = savedMark();
  return h('label.switchrow',
    h('span.switchrow-text', h('span.switchrow-label', label, mark), hint ? h('span.hint', hint) : null),
    h('input.switch', { type: 'checkbox', role: 'switch', checked, onchange: async (e) => {
      try {
        const r = await onchange(e.target.checked);
        if (r !== false) mark.show();
      } catch {
        /* the caller said why */
      }
    } }));
}

/** A labelled input with one sentence under it. */
export const field = (label, input, hint) => h('label.fieldrow', h('span.field-label', label), input, hint ? h('span.hint', hint) : null);

/** A label and its value on one line. */
export const info = (label, value, hint) => h('div.inforow', h('div.inforow-top', h('span', label), h('strong', value)), hint ? h('p.hint', hint) : null);

/** A save button that shows progress and the server's answer. */
export function saveBar(label, fn, done = 'Saved') {
  const b = h('button.btn.primary', { type: 'button' }, label);
  const msg = h('p.form-error', { role: 'alert' });
  const mark = savedMark();
  b.addEventListener('click', async () => {
    b.disabled = true;
    msg.textContent = '';
    try {
      await fn();
      mark.show(done);
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      b.disabled = false;
    }
  });
  return h('div.savebar', msg, mark, b);
}

// ---------- results, steps, loading ----------

/** What went wrong, in one sentence; with `retry`, a Try again button under it. */
export const errorBox = (text, retry = null) => h('div.result',
  h('div.banner.error-box', { role: 'alert' }, icon('alert', { size: 18 }), h('span', text)),
  retry ? h('button.btn.secondary', { type: 'button', onclick: retry }, icon('refresh', { size: 18 }), h('span', 'Try again')) : null);

/** It worked: one sentence (text and nodes). */
export const okBox = (...text) => h('div.banner.ok-box', { role: 'status' }, icon('check', { size: 18 }), h('span', ...text));

/** Numbered steps a person follows in order: each item is the step's content. */
export const steps = (...items) => h('ol.numbered', items.map((it, i) => h('li', h('span.num-dot', String(i + 1)), h('div.num-body', it))));

/** Where a person is in a few steps ("1 Name · 2 Check · 3 Create"): `at` is the current one, from 0. */
export const stepHeader = (names, at) =>
  h('ol.stepper', names.map((t, n) => h(`li${n <= at ? '.on' : ''}`, { 'aria-current': n === at ? 'step' : null }, h('span', String(n + 1)), t)));

/** Rows while a list loads: the list's shape, so nothing jumps when it arrives. */
export const skeletonRows = (n = 3) => h('div.rows', { 'aria-busy': 'true', 'aria-label': 'Loading' },
  Array.from({ length: n }, () => h('div.row.static.skel-row', h('span.row-icon'), h('span.row-main', h('i'), h('i')))));

// ---------- the parts of a page ----------

/**
 * Tabs for the parts of a page, one look everywhere: `items` [{ id, label, href, icon?, count? }], `current` the id
 * shown. Each part has its own address (href). With `onPick(id)` a press shows the part in place (the address is
 * updated without drawing the page again); without it the address opens the part. `bar.update(items, current)`
 * draws it again (new counts).
 */
export function tabBar(label, items, current, onPick = null) {
  const bar = h('nav.tabs', { 'aria-label': label });
  let now = current;
  let list = items;
  const paint = () => fill(bar, list.map((it) => h('a.tabs-item', {
    href: it.href,
    'aria-current': it.id === now ? 'page' : null,
    onclick: onPick ? (e) => {
      e.preventDefault();
      history.replaceState(null, '', it.href);
      now = it.id;
      paint();
      onPick(it.id);
    } : null,
  }, it.icon ? icon(it.icon, { size: 16 }) : null, h('span', it.label), Number.isFinite(it.count) ? h('span.tabs-count', String(it.count)) : null)));
  bar.update = (next = list, cur = now) => {
    list = next;
    now = cur;
    paint();
  };
  paint();
  return bar;
}
