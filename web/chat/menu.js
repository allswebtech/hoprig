// The composer's menus (the + menu, the mode, the model with its effort), as the desktop app's: a small menu that
// opens at its control, above it (below where the top of the window leaves no room). The keyboard: 1-9 pick an item,
// one number per item through the whole menu (a menu of more than nine: the numbers are those of the section the
// keyboard is in, and only that section shows them, so no two items carry the same number), Up and Down move, Home and End, Enter picks, Escape closes and does nothing else
// (it never stops Claude), Tab closes. After a pick or Escape the keyboard is back where it was when the menu opened
// (the control that was pressed, or the message box a key opened it from). A press outside closes it. On a narrow
// touch screen the same menu is a sheet from the bottom, with its sections and the same words.
import { icon } from '../icons.js';
import { add, fill, h, openSheet } from '../lib.js';
import { touchScreen } from './words.js';

let open = null; // { el, done(value, back) }

/** A sheet instead of a menu: a touch screen under 600 px, where a small menu would be too small for a finger. */
export const asSheet = () => touchScreen() && typeof innerWidth === 'number' && innerWidth < 600;

/** Close the open menu, if one is: as Escape does when `back` (the keyboard goes back), else as a press outside. */
export function closeMenu(back = false) {
  if (open) open.done(null, back);
}

/** Whether one of these menus is open now. */
export const menuOpen = () => !!open;

/**
 * Where the menu goes: above the control, inside the window (moved left where it would leave it); below the control
 * where there is no room above; its height cut to the room there is, with its own scrolling. → { left, top, maxHeight }
 */
export function placeMenu(ctl, size, view) {
  const pad = 8;
  const left = Math.max(pad, Math.min(ctl.left, view.width - size.width - pad));
  const above = ctl.top - 6 - pad;
  const below = view.height - ctl.bottom - 6 - pad;
  if (size.height <= above || above >= below) {
    const h0 = Math.min(size.height, above);
    return { left, top: ctl.top - 6 - h0, maxHeight: h0 };
  }
  return { left, top: ctl.bottom + 6, maxHeight: Math.min(size.height, below) };
}

/**
 * Open a menu at control `from`. sections: [{ label?, items: [{ value, label, sub?, current?, danger?, disabled?, icon? }] }]
 * (an item with `current` set in its section is a choice: the one chosen is marked). label: the menu's name for a screen
 * reader; at: the section the keyboard starts in; key: a key opened it (then a key for another section of the same
 * menu, open already, moves the keyboard there instead of closing it); title, subtitle: the sheet's on a narrow touch screen;
 * sheet: as a sheet whatever the screen (the settings sheet's own pickers).
 * → a Promise of the picked item's value, or null (closed without a pick)
 */
export function openMenu({ from, label, sections, at = 0, title = label, subtitle = '', key = false, sheet = false }) {
  if (open && open.from === from) {
    // A key for another section of the menu that is open (Ctrl+Shift+E in the model menu): the keyboard goes there.
    // A second press of its control, or of the same key, closes it, as a drop-down does.
    if (key && at !== open.at && open.goTo(at)) return Promise.resolve(null);
    closeMenu(true);
    return Promise.resolve(null);
  }
  closeMenu();
  if (sheet || asSheet()) return sheetOf({ title, subtitle, sections }); // `sheet`: opened from a sheet (the settings of a phone)
  const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : from;
  const sec = sections.filter((s) => s && s.items.length);
  const groups = []; // per section: its buttons (the ones that can be picked)
  const all = [];
  const valueOf = new Map(); // button → its item's value
  const el = h('div.chat-menu', { role: 'menu', 'aria-label': label });
  sec.forEach((s, si) => {
    const choice = s.items.some((it) => it.current !== undefined);
    const buttons = [];
    const g = h('div.chat-menu-group', { role: 'group', 'aria-label': s.label || label },
      s.label ? h('p.chat-menu-head', { 'aria-hidden': 'true' }, s.label) : null,
      s.items.map((it) => {
        const b = h(`button.chat-menu-item${it.danger ? '.chat-is-danger' : ''}${it.current ? '.chat-is-current' : ''}`, {
          type: 'button', tabindex: '-1', disabled: !!it.disabled,
          role: choice ? 'menuitemradio' : 'menuitem',
          ...(choice ? { 'aria-checked': String(!!it.current) } : {}),
          onclick: () => done(it.value, true),
        },
        h('span.chat-menu-mark', { 'aria-hidden': 'true' }, it.current ? icon('check', { size: 15 }) : it.icon ? icon(it.icon, { size: 15 }) : null),
        h('span.chat-menu-main', h('span.chat-menu-label', it.label), it.sub ? h('span.chat-menu-sub', it.sub) : null),
        h('kbd.chat-menu-num', { 'aria-hidden': 'true' }));
        if (!it.disabled) {
          valueOf.set(b, it.value);
          buttons.push(b);
          all.push(b);
        }
        return b;
      }));
    groups[si] = buttons;
    add(el, g);
  });
  add(document.body, el);
  const vv = typeof window !== 'undefined' && window.visualViewport;
  const size = el.getBoundingClientRect(); // its whole height, measured once (later its height is cut to the room)
  const place = () => {
    const p = placeMenu(from.getBoundingClientRect(), { width: size.width, height: size.height }, { width: innerWidth, height: vv ? vv.height : innerHeight });
    Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
  };
  place();
  from.setAttribute('aria-expanded', 'true');

  let resolve;
  const answer = new Promise((r2) => (resolve = r2));
  const sectionOf = (b) => groups.findIndex((g) => g.includes(b));
  // The items the number keys pick now: the whole menu when it has nine or fewer, else the section the keyboard is in.
  const numbered = () => (all.length <= 9 ? all : groups[Math.max(0, sectionOf(document.activeElement))] || []);
  let shown = null;
  function number() {
    const list = numbered();
    if (list === shown) return;
    shown = list;
    for (const b of all) {
      const n = list.indexOf(b);
      const kbd = b.querySelector('.chat-menu-num');
      if (n >= 0 && n < 9) {
        b.setAttribute('aria-keyshortcuts', String(n + 1));
        if (kbd) fill(kbd, String(n + 1));
      } else {
        b.removeAttribute('aria-keyshortcuts');
        if (kbd) fill(kbd);
      }
      kbd?.classList.toggle('hidden', !(n >= 0 && n < 9));
    }
  }
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // the page's and the browser's own keys go on
    const i = all.indexOf(document.activeElement);
    const k = e.key;
    let handled = true;
    if (k === 'Escape' || k === 'Tab') done(null, true);
    else if (k === 'ArrowDown' || k === 'ArrowUp') {
      const n = all.length;
      if (n) all[(i < 0 ? (k === 'ArrowDown' ? 0 : n - 1) : (i + (k === 'ArrowDown' ? 1 : n - 1)) % n)].focus();
    } else if (k === 'Home') all[0]?.focus();
    else if (k === 'End') all[all.length - 1]?.focus();
    else if (/^[1-9]$/.test(k) && !e.isComposing) {
      const b = numbered()[Number(k) - 1];
      if (b) done(valueOf.get(b), true);
    } else if (k === 'Enter' || k === ' ') {
      handled = false; // the button's own click
    }
    // Every plain key stays in the menu: "?" or a number never reaches the page's keys while it is open.
    e.stopPropagation();
    if (handled) e.preventDefault();
    if (open && open.el === el) number(); // the keyboard may have moved to another section
  }
  const onDown = (e) => {
    if (!el.contains(e.target) && !from.contains(e.target)) done(null, false);
  };
  const onAway = () => done(null, false);
  // Only a change of the width closes it: a touch screen's keyboard going away (the focus left the box for the menu)
  // changes the height alone, and the menu must not close as it opens. The control moved with the height: the menu
  // is placed at it again (the window's resize, and the visible part's own, which a phone's keyboard changes).
  const width = innerWidth;
  const onResize = () => (innerWidth !== width ? done(null, false) : place());
  function done(value, back) {
    if (!open || open.el !== el) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('blur', onAway);
    window.removeEventListener('resize', onResize);
    vv?.removeEventListener?.('resize', onResize);
    el.remove();
    from.setAttribute('aria-expanded', 'false');
    if (back && opener && opener.isConnected) opener.focus({ preventScroll: true });
    resolve(value);
  }
  const goTo = (n) => {
    const g = groups[n];
    if (!g || !g.length) return false;
    open.at = n;
    (g.find((b) => b.classList.contains('chat-is-current')) || g[0]).focus({ preventScroll: true });
    number();
    return true;
  };
  open = { el, from, done, at, goTo };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('blur', onAway);
  window.addEventListener('resize', onResize);
  vv?.addEventListener?.('resize', onResize);
  const start = groups[Math.min(at, groups.length - 1)] || [];
  (start.find((b) => b.classList.contains('chat-is-current')) || start[0] || all[0])?.focus({ preventScroll: true });
  number();
  el.addEventListener('focusin', () => number()); // a pointer or a screen reader moved the focus
  return answer;
}

/** The same menu as a sheet from the bottom (a narrow touch screen). */
function sheetOf({ title, subtitle, sections }) {
  return openSheet({ title, subtitle }, (close) => sections.filter((s) => s && s.items.length).map((s) => [
    s.label ? h('h3.chat-help-h', s.label) : null,
    h('div.choice-list', s.items.map((it) => h(`button.choice${it.current ? '.current' : ''}${it.danger ? '.danger' : ''}`, { type: 'button', disabled: !!it.disabled, onclick: () => close(it.value) },
      it.icon ? h('span.choice-icon', icon(it.icon)) : null,
      h('span.choice-main', h('span.choice-label', it.label), it.sub ? h('span.choice-sub', it.sub) : null),
      h('span.choice-end', it.current ? icon('check') : null)))),
  ])).then((x) => (x === undefined ? null : x));
}
